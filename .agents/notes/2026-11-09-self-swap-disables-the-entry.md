# 决策：撤旧的顺序决定 entry 死不死 —— 热重载之后工具消失的根因

**日期**：2026-11-09 ｜ 状态：生效

## 症状（真机，三次复现）

`dsh_hot_reload` 返回成功：

```
verdict: the swap completed: 34 module(s) were cleared and the old fiber was disposed, so nothing needs undoing
reload: cleared=34 oldFiberTouched=true rolledBack=false newFiberState=2
```

紧接着**所有 8 个工具都 `unknown tool`**，`dsh_diagnose_plugin_load` 报 entry `inactive`，改文件 mtime 也不恢复，只有手动重启插件才回来。
后来发现**换任何插件都这样**，不只换本插件 —— 所以「自己换自己」不是必要条件。

## 根因：不是「自己换自己」，是撤旧的方式

`RegistryService` 里每个 plugin 有一份 runtime 记录（`{ callback, fibers, Config }`），
`Fiber.dispose` 的 disposer 里有这段：

```js
// cordis 4.1.0 lib/index.js（Fiber 构造里的 dispose）
emitPluginDisposed(this.context, this)          // ← 这一刻 runtime 记录**还在**
if (this.ctx.registry.has(runtime.callback)) {
  remove()
  if (!runtime.fibers.length) this.ctx.registry.delete(runtime.callback)
}
```

而 loader 有一个监听器接住这个事件（cordis-plugin-loader 1.1.0 `internal/plugin`）：

```js
ctx.on("internal/plugin", (fiber) => {
  if (fiber.uid) return                    // 活着的 fiber 不关我的事
  if (!fiber.entry) return
  ...
  entry.options.disabled = true            // ← 判定：这个插件把自己卸载了 ⇒ 关掉这一行
  entry.parent.tree.commit({...})
})
```

于是：

| 做法 | 撤旧的那一刻 runtime 记录 | loader 的判定 | 结果 |
|---|---|---|---|
| 逐个 `fiber.dispose()`（**旧实现**） | **还在** | 命中 ⇒ `entry.options.disabled = true` | entry 被关掉 |
| 先 `registry.delete(callback)`（**宿主 hmr 的做法**） | **已抹掉** | `registry.has()` 为假 ⇒ 早退 | entry 活着 |

被关掉之后，这个 entry 下个 reconcile 就把它撤了 —— 它注册的工具**随 fiber 的 effect 一起消失**
（`ctx.tools.register` 就是 `layers.effect(this.ctx, …)`）。`entry.options.disabled` 是**内存树**上的字段，
本机的 loader `commit()` 只 emit `loader/config-update`（不落盘），所以重启才回来、动 mtime 没用。

## 复现台（不碰真宿主）

`.local/repro-blast-radius.mjs`（本机留存，不进仓）：用**宿主自己的** cordis 4.1.0 + cordis-plugin-loader 1.1.0
建一棵两个 entry 的小树，各注册一个工具（假 `tools` 服务复刻唯一要紧的语义：注册走 `ctx.effect`），
只换其中一个，两种撤旧方式各跑一遍：

```
A · 本仓现状（逐个 fiber.dispose） / 换之后   alpha(disabled=true,  state=2)
B · 宿主 hmr（先 registry.delete） / 换之后   alpha(disabled=false, state=2)
```

同一棵树、同一段挂载代码，**只改撤旧的顺序**，entry 的死活就翻面。这就是「变异自证」——
不是推断，是跑出来的。

## 第二个缺陷：`newFiberState` 是旧 fiber 的值

成功分支读的是 `entry.fiberState`，而那是 `bindEntry()` 在**换之前**拍下的快照，
`mountFresh()` 之后**没有任何地方回写**。所以 `newFiberState=2` 恒等于旧 fiber 的相位 ——
工具报「新 fiber 到 active 了」时，它**一次都没看过新 fiber**（坑 37 的原样形状）。
修法是把「现读」做成端口上的独立方法（`liveFiberState()`），快照只留给 `oldFiberState`。

## 决策

1. **撤旧走「整个 runtime」**：`ReloadEntryPort.disposeOld` → `disposeRuntime`，实现里先
   `registry.delete(callback)`、再 await 那些 fiber。缺 `registry.delete` 的宿主回退到逐个 dispose，
   但那条路会被下面的护栏拦住，不会静默报成功。
2. **成功判据必须现读**：`newFiberState` 走 `liveFiberState()`；`entryDisabled()` 为真时先尝试
   `undoSpuriousDisable()`（把 `options.disabled` 放回换之前的值 + `commit`），救不回来才判失败
   （新失败原因 `entry-disabled`，`kind` 仍归 `reload-failed`）。
   只在**换之前没关**时才去撤销 —— 用户自己关掉的 entry 不该被一次热重载顺手打开。
3. **判据**（`test/tools/hot-reload.test.ts`）：
   - 「撤旧走 `registry.delete`」——假古树复刻 loader 的判定，fiber 被 dispose 时若 runtime 记录还在
     就记一条 violation；**否证用例**拿掉 `registry.delete`，violation 必须出现（证明它会红）。
   - 「`newFiberState` 取现读值不取快照」——把快照与现读设成不同值，报告必须取现读那个。
   - disabled 三态（救得回来 / 救不回来 / 本来就没关）各一条。

## 替代方案（被否掉的）

| 方案 | 为什么没选 |
|---|---|
| **换完只报「无法确认」，不碰宿主记账** | 用户的插件会一直关着，唯一出路是重启 —— 而那个 disabled 是本仓那次 dispose 引出来的，不收拾等于留残局 |
| **判 disabled 就判失败、不尝试撤销** | 同上；而且失败后模型会重试同一个动作，越试越糟（entry 每轮被再关一次） |
| **改成 `entry.refresh()` 走 loader 自己的 init 通路** | 需要先把 `entry.fiber` 置空，而 `refresh()` 在 `fiber` 存在时直接早退；且回滚要「重挂旧插件值」，那条路 loader 没给 |
| **直接拒绝给自己提供工具的插件做热重载** | 症状推不出这条限制：真机上是**换任何插件都掉工具**，拒绝自换救不了 |

## 已知残余

- **`dsh_restart` 那四处重复**仍不在 B34 的可见面内（见 SHAPE 的 B34 已知限度），与本条无关。
- loader `internal/plugin` 那条判定是**宿主行为**，不是本仓可改的；我们能做的只是不去踩它，
  并在踩到时自愈 + 如实报。宿主侧若要「插件自我卸载 ⇒ 关掉这一行」之外的语义，需上游决策。
- **换别的插件为什么也掉工具**：真机上观察到的波及面比本条根因更宽（换任何插件都掉），
  但本地复现台里换 alpha 时 beta 的工具**没掉**。所以还有一个未钉住的因 —— 要么是本机
  `commit()` 那条 `loader/config-update` 触发的重新组合（复现台里 `commit` 是 no-op），
  要么是别的东西。**本条不声称已经解释它**，只钉住了「被换的那个 entry 会被判 disabled」。
