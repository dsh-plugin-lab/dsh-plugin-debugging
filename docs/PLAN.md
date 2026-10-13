# PLAN —— v1.1：`dsh_hot_reload` 与 `dsh_restart`

> **本文件是计划，不是实测结论。所有未标注「已实测」的表述均为推断。是否实现、如何实现，待后续单独指令，本轮不执行。**

标记约定：`[已实测]` = 本仓有实测证据（给出出处）；**不带标记的一律是推断**。
本文件只写「做什么 / 怎么做 / 做完怎么验」，不写「什么时候做」。

---

## 1. 背景与定位

v1 的能力面已经封版：**1 个技能 + 4 个只读工具** `[已实测：README 的 Tools 表；CI 187 个测试]`。
四个工具的共同边界是**只能说、不能做** —— 不改 profile、不写 `$DSH_HOME`、不杀进程 `[已实测：AGENTS 全局规则]`。

`dsh_hot_reload` 与 `dsh_restart` 是 v1.1 的**两个写侧工具** `[已实测：AGENTS「待办」首条]`。它们把「说」变成「做」，风险性质随之改变：

| | v1（只读） | v1.1（写侧） |
|---|---|---|
| 失败形态 | 结论说错，用户看着办 | **进程没了、插件半死、会话回不来** |
| 可恢复性 | 重新调用即可 | 需要回滚或重启 |
| 最难的部分 | 判据（已解决） | **闸门与恢复**，不是动作本身 |

因此本计划的重心不是「怎么重启」，而是**四道闸**（§3.2）与**恢复逻辑**（§3.3），以及**热重载失败时旧 fiber 有没有被碰过**（§2.2）。

**与既有工具的关系**：这两个工具都必须建立在 `dsh_check_effect_mode` 的判定之上 —— 它已经能回答「这次改动属于哪一档、这个 profile 的 `hmr` 是否真的在 watch patch 文件」`[已实测：task-15/16 的真机实验 + 契约字段 `data.hmr`]`。§4 把这条写成纪律。

**`§2` 只描述热重载，`§3` 只描述重启**，两者**不共享实现**（不合并的理由见 §4 末条）。

---

## 2. `dsh_hot_reload` 设计

### 2.1 算法（阶段化，顺序是判据）

推断来源：参考实现 `dsh-plugin-reload` 自述的 in-process 分支（"bust module caches → re-import from disk → swap fibers onto the fresh module"，并称与 `cordis-plugin-hmr` 的 partial reload 同技术）与 `dsh-hot-reload` 自述的失败处理（见 §6）。

1. **定位 entry** —— 由调用方给出三种定位方式之一：`entryId` / 模块名 / MCP `serverName`。定位不到 → 失败返回，**不动任何东西**。
2. **提取本地模块闭包** —— 从 entry 的入口出发，收集**本仓/本地路径**的模块（`node_modules` 下的依赖不算，除非它就是被 reload 的对象）。
   *推断*：内置 HMR 故意不追踪 `node_modules`（`dsh-hot-reload` 自述），所以「改依赖包版本」这条路必须自己清缓存。
3. **备份 `loadCache`** —— 把第 2 步涉及的模块在 Node 模块缓存里的原引用**整份留存**。这是回滚的唯一依据。
4. **清缓存** —— 只清第 2 步那批，**不清整棵树**。清多了会把无关插件一起拖进来。
5. **先 `import` 新代码** —— 新代码 **import 成功之前，绝不碰旧 fiber**。
6. **再 dispose 旧 fiber** —— 只在第 5 步成功之后。
7. **挂载新的** —— 把新模块安装成 entry 的实现。
8. **失败分支**：
   - 第 5 步失败（import 期错）→ 旧 fiber **从未被碰过**，把第 3 步的备份放回缓存，报失败。`[推断：参考实现自述「caught before the running plugin is touched」]`
   - 第 7 步失败（apply 期错）→ 从备份**回滚**：恢复模块缓存，重新实例化旧版本。`[推断：参考实现自述「rolled back — the old version is re-instantiated in place」]`
   - **失败过的版本不自动重试** `[推断：`dsh-hot-reload` 自述 —— 每次 lockfile 写入都重试会把本来能跑的插件反复拆掉]`。

### 2.2 边界

- **插件在 cordis 之外拿的裸资源检测不到**：`setInterval`、裸 socket、`process.on`、外部文件句柄、worker —— 这些东西不归 cordis 的 effect 管，dispose 旧 fiber 时不会释放，于是**静默泄漏**。
  *对策（部分已核对，见 §6.4）*：插件在 `package.json` 里声明 `"dsh": { "hotReload": false }`，本工具遇到这种包**直接拒绝热重载、改走重启**。
  `[已读源码]` 这条约定**真实存在且有人在读**：`dsh-hot-reload` 的 `lib/index.js:15` 注释与 `:442-443` 的判断（`rec.json?.dsh?.hotReload === false` → 报 `stale` 并提示「restart dsh」）。
  ⚠️ **但运行时本身不读它**：在本机运行时（`0.2.1-alpha.2`）里 grep `hotReload` **零命中** `[已核对：本机 node_modules 只读 grep]`。
  → 它是**生态约定**、不是宿主特性：**「谁来读」必须由本仓自己实现**（否则写了没人读＝静默无效，正是 §5 第 7 条）。
- **内置 HMR 不追踪 `node_modules`** `[推断：`dsh-hot-reload` 自述；与本仓已实测的「watch 触发者住在 hmr 里」一致但不等于同一件事]`，所以「升级依赖后要不要重启」的答案是**要**，除非本工具自己清缓存。
- **热重载不是「更安全的重启」**：它只覆盖原位替换得了的东西；拿不准时应当**拒绝并建议重启**，而不是尽力而为。

### 2.3 工具定义草稿

```ts
// 名字与参数名是草稿；description 按本仓既定四要素结构写。
{
  name: 'dsh_hot_reload',
  description:
    'Swaps one mounted loader entry to the code currently on disk, in place, without restarting the host. ' +
    'Use it after changing host-side code of a plugin when a restart would be worse than the change. ' +
    'It is write-side: it mutates the running tree. If the new code fails to import the old entry is never touched, ' +
    'and if it fails to apply the previous code is put back — but anything the plugin opened outside cordis is not tracked and will leak silently.',
  parameters: {
    entryId: 'Loader entry id to replace, e.g. from dsh_diagnose_plugin_load.',
    module: 'Module or package name to match instead of entryId.',
    serverName: 'MCP serverName to match instead of entryId.',
    dryRun: 'Check the closure and report what would be replaced, without touching the tree.',
  },
}
```

*推断*：三种定位方式取自 `dsh-plugin-reload` 的 `reload_plugin`；`dryRun` 是本仓新增（只读优先的延续）。

### 2.4 返回草稿

```
[dsh_hot_reload] ok
verdict: entry=<id> · swapped=<n> modules · rolledBack=false
why: <一句话：新代码来自哪个路径、旧 fiber 是否被碰过、哪些模块被清了>
nextStep: dsh_diagnose_plugin_load(<package>) — 确认新 fiber 到了 active
```

失败时（形状沿用本仓既有结构：`kind` + `message` + `hint` + `nextStep`）：

```
[dsh_hot_reload] failed (import-failed)
the new code failed to import; the running entry was never touched
hint: fix the import error and call again — nothing to undo
nextStep: dsh_diagnose_plugin_load(<package>) — 旧 fiber 应仍是 active
```

### 2.5 做完怎么验

- 三条分支各一条真机用例：**import 期失败**（旧 fiber 必须仍是 active）、**apply 期失败**（旧版本必须被放回且可用）、**成功**（新代码可见）。
- 断言方式沿用本仓既有的「观测 vs 推断」分离：`loader.entries()` → `entry.fiber.state` `[已实测：坑 19，2/3/0 三档；import 期失败时 fiber === undefined]`。

---

## 3. `dsh_restart` 设计

### 3.1 定位

重启是**不可逆**动作：它杀掉当前进程、连同发起这次调用的那个回合。所以设计目标不是「能重启」，而是**只在四道闸全过时才重启，并且重启后能把会话接回来**。

### 3.2 四道闸（任一不过即拒绝，且**不提供绕过参数**）

| 闸 | 判据（推断） | 拒绝时的返回 |
|---|---|---|
| **① 重启循环熔断** | 短窗口内重启次数超过阈值 → 拒绝（例如上次重启在 N 秒内，或本轮已重启 ≥N 次） | `restart-loop` + 说明 |
| **② 其他会话在跑** | 除调用方自己以外的活跃会话仍在执行回合 → 拒绝；**调用方自己的会话不算忙** `[推断：`dsh-desktop-auto-restart` 自述「宿主繁忙时直接拒绝…调用方自己那个会话不算繁忙」]` | `busy` + 列出阻塞者 + `nextStep` 建议等待 |
| **③ bundle 表解析不了** | profile 的 `bundles` / patch 解析失败 → 拒绝（重启后起不来就再也回不来） | `bad-composition` + 指路 `dsh_dump_config` |
| **④ 拿不到启动命令** | 无法确定「怎么把宿主重新拉起来」 → 拒绝（**不猜**） | `no-launch-command` + 请用户给命令/走外部管理器 |

*推断*：闸①③④ 是本仓新增；闸② 的语义借自参考实现。
*待定*：闸②「活跃会话」的可读性 —— 本仓已实测 `ctx.get('agents')` 免 inject 可见、`agent/created` 是 serial `[已实测：坑 26 与动态注入的实现]`，但**「某会话是否正在跑回合」有没有读法**是推断（见 §5）。

### 3.3 流程（顺序是判据）

```
闸门检查（§3.2 四道）
  → 写 marker（重启前，落盘）
  → spawn detached（新进程）
  → 本进程退出
  ── 新进程启动 ──
  → 读 marker
  → 恢复会话
  → 注入 notice
  → 删 marker
```

- **marker 必须落盘、必须在 spawn 之前** `[推断：`dsh-desktop-auto-restart` 自述「先写『待唤醒清单』，再调重启脚本（`delaySeconds` 默认 10 秒，留给回执落盘）」]`。
- **拉起新进程必须用 detached 的 Node 进程** —— `[推断，未验]` PowerShell detached 会**静默退出**。参考实现里这条被反复加固过（`dsh-restart` 有 `legacyRestart` 旧 PowerShell/WMI 路径且**默认关闭**；`dsh-desktop-auto-restart` 记录到「执行策略 `Restricted` 时脚本根本不执行，而 WMI 照样返回 rc=0 ⇒ 工具报『已拉起』却什么都没发生」）。
- **绝不按进程名批量杀** —— 按**监听端口 + 精确 PID** 定位 `[推断：两条参考实现都自述如此；与本仓已实测的「按端口找进程，不按命令行子串」一致 —— 见 `dsh_check_auth` / `dsh_diagnose_plugin_load` 的边界]`。
- **不拥有 watchdog** `[推断]`：`dsh-restart` 自述在 `0.1.3-alpha.4` **移除**了内置 detached watchdog，理由是把进程生命周期交给 systemd / Windows 服务等外部管理器。→ 本仓若做自动拉起，需先决定「自己做看门狗还是交给外部」，且**默认应当是后者**。

### 3.4 恢复逻辑

- **恢复标记绝不能写进会话日志** `[已实测：坑 4]`：自定义 `SessionEventMap` 成员 + `session.append()` 会**写坏会话日志** —— 写入当次可用，但下次加载时持久层会因「未知且未标 `ignorable` 的事件」拒绝解释整份日志。仓外插件的正确通道是 `appendPluginRecord()`（`plugin:` 前缀、强制 `ignorable: true`）。
  → **marker 必须是独立文件**，不是会话事件。`[这条与任务书的措辞略有差别，以坑 4 为准：不是「`Session.append()` 不支持 `ignorable`」，而是「不该用 `append`、应走 `appendPluginRecord`」。]`
- **注入的是信息性 notice，不是强制「继续」**：让 agent 自己决定要不要接着干 `[推断：`dsh-smart-restart` 自述「wakes the main agent with a short notice… so the agent decides whether to resume」；`dsh-desktop-auto-restart` 则注入「已重启完成，请继续」—— 两者不同，本仓取前者]`。
- **恢复要走官方通道、按会话原有预设** `[推断：`dsh-desktop-auto-restart` 自述]`；唤醒失败**保留 marker**，下次启动继续重试。
- **记录调用方会话**，把 notice 送回**发起重启的那个会话** `[推断：`dsh-smart-restart` 自述「records the calling session and returns the notice to that exact session」]`。

### 3.5 工具定义草稿

```ts
{
  name: 'dsh_restart',
  description:
    'Restarts the DSH host process after four gates pass, and hands the calling session a notice when it comes back. ' +
    'Use it only after dsh_check_effect_mode says the change is restart-required — it kills the running turn, including yours. ' +
    'It is the most destructive tool in this plugin: it refuses unless the gates pass, and it has no force option — ' +
    'a refusal means restarting now would lose work or leave nothing to come back to.',
  parameters: {
    reason: 'Short human-readable reason; recorded in the marker and the notice.',
    delayMs: 'Delay before exiting, so the receipt can reach disk. Defaults to 10s; 0 restarts immediately.',
    dryRun: 'Run all four gates and report the verdict without restarting.',
  },
}
```

*推断*：`{reason, delaySeconds}` 的形状取自 `dsh-desktop-auto-restart`；`dryRun` 是本仓新增（四道闸必须能单独演练）。
*待定*：工具**是否默认注册**。参考实现 `dsh-desktop-auto-restart` 的同类工具**默认不注册**（设置里默认关）`[推断：其 README 自述]` —— 本仓要不要跟，见 §5。

### 3.6 返回草稿

```
[dsh_restart] ok
verdict: gates=4/4 passed · marker=<path> · newPid=<pid>
why: <一句话：哪些会话会被唤醒、marker 什么时候删>
nextStep: （无 —— 本进程即将退出）
```

被闸门拒绝时：

```
[dsh_restart] failed (busy)
2 other sessions are mid-turn; restarting now would kill them
hint: wait for them to finish, or restart from outside the host
nextStep: dsh_check_effect_mode({"change":"config"}) — 先确认这次改动是否真的必须重启
```

### 3.7 做完怎么验

- 四道闸**各一条拒绝用例**（构造条件 → 断言不重启且返回正确 `kind`）。
- 真机一条「重启 → 会话被唤醒 → notice 到达发起者」的闭环。
- 反向用例：**marker 存在但新进程没起来**（kill 掉）→ 下次启动必须仍能恢复或明确报「上次重启未完成」。

---

## 4. 协作纪律

**判断驱动行动：模型不应该跳过 `dsh_check_effect_mode` 直接调写侧工具。**

- 顺序是**契约**而不是建议：先 `dsh_check_effect_mode` 拿到 `mode` 与 `hmr`，再决定调不调 `dsh_hot_reload` / `dsh_restart`。
  - `mode=hot` 且 `hmr=present` → 通常**不需要**这两个工具（改动会被重读）`[已实测：task-16，有 hmr 时改 config 文件 3.6 秒生效]`。
  - `mode=hot` 但 `hmr=absent` → 改 config **必须重启** `[已实测：task-15，无 hmr 时 70 秒 / 21 采样点零反应]` → 走 `dsh_restart`。
  - `mode=restart-required` → `dsh_restart`；`mode=hmr` → 两个都不需要。
- **能只读解决的不动手**：两个写侧工具都提供 `dryRun`，且**默认建议先 dryRun**。
- **拒绝不是失败**：闸门拒绝是设计的一部分；模型应当把拒绝原样报给用户，而不是想办法绕过（**没有 `force` 参数，这是判据**）。
- **不把两个工具合并成一个**：热重载与重启的失败代价不同（前者可回滚，后者不可逆），闸门也不同。合成一个「修复它」工具会让模型倾向于选更重的那条路。

---

## 5. 待实测清单

每条都标：**推断来源 / 待验证什么 / 影响什么决策**。全部**未做**（本轮不执行）。

| # | 待验证 | 推断来源 | 影响什么决策 |
|---|---|---|---|
| 1 | `session.append()` 到底拒到什么程度：自定义事件是否必然让日志加载失败；`appendPluginRecord()` 的可用性与前缀约束 | 本仓坑 4（**已实测**写坏日志）＋ 参考实现用独立 marker 文件的既成事实 | marker 的**存储形态**（独立文件 vs 会话事件）——决定 §3.4 整节 |
| 2 | `ctx.agents` 上有没有「resume 某会话」的契约（方法名、是否按原预设、失败语义） | 参考实现自述「走官方通道、按原有预设唤醒」 | 恢复逻辑能否实现；不能则 `dsh_restart` 只能做到「重启 + 留 marker」 |
| 3 | 「某会话是否正在跑回合」有没有读法 | 闸② 的直接前提 | 闸② 是否可判；不可判则「繁忙」只能降级为粗判（如「有活跃会话」）或干脆去掉 |
| 4 | detached Node 拉起是否可靠；PowerShell detached 是否真的静默退出 | 参考实现的三处加固（`legacyRestart` 默认关、执行策略 `Restricted` 静默失败、WMI rc=0 假成功） | §3.3 的 spawn 形态；以及要不要自己拉起（vs 交给外部管理器） |
| 5 | 热重载回滚是否**真的**不碰旧 fiber（import 期失败时旧 fiber 必须仍 active） | 参考实现自述（未在本仓复现） | §2.1 第 5/8 步的顺序是否为唯一正确解 |
| 6 | 「静默泄漏」的检测是否可行（裸 `setInterval` / socket / `process.on` 能否被枚举） | 本仓 §2.2 的分析 | `"dsh": { "hotReload": false }` 这条声明**是否必要**，以及能否自动检测而不是靠插件自觉 |
| 7 | `package.json` 里声明 `"dsh": { "hotReload": false }` 有没有读取方、读取时机 | 本仓新增提议 | 该声明的语义先定，否则写了没人读＝静默无效 |
| 8 | 写侧工具与 `dsh_check_effect_mode` 的衔接点：`change` 枚举是否要扩（如 `host-code` 热重载成功后的新档） | 本仓契约现状 | 两个工具的参数面；是否要新增 `change` 取值 |
| 9 | 工具是否默认注册（参考实现的同类工具默认关） | `dsh-desktop-auto-restart` 自述 | 装完即生效 vs 需显式开启；影响 README 的安装分档 |
| 10 | 重启后 notice 的投递通道（能否送到「发起者那个会话」，而非全体） | `dsh-smart-restart` 自述 | §3.4 的恢复语义与 §3.6 的返回文案 |

### 5.1 2026-10-13 更新：哪些条目已被「读源码 + 本机运行时核对」推进

上面那张表**保留原样**（它是当时的推断状态，不改写历史）。本轮的推进如下（依据全在 §6.4）：

| # | 现状 | 说明 |
|---|---|---|
| 1 | **部分推进** | notice 的**投递**不需要自定义会话事件：参考实现走 `agent.followup(普通 user 消息 + source 描述符)`，本机运行时同形 `[已核 §6.4]`。**仍待实测**：`appendPluginRecord()` 的可用性与前缀约束（若我们要写自己的 `plugin:` 记录） |
| 2 | **大幅推进** | 通道找到了：`sessionController.resolveAgent(SessionId(id))` + `agents.get(SessionId(id))` + `agent.followup(...)`，三者在**本机运行时都存在** `[已核 §6.4]`。**仍待实测**：「按会话原有预设」这一语义（参考实现自述如此，未在本机验） |
| 3 | **部分推进** | 判据有了：`agents.list()` 的 `status`/`inbox`、`jobs.list()`、`workspace/session-activity` 的 `schedule` `[已读源码 §6.4]`；`agents.list` 在本机存在。**仍待核**：`jobs` 服务名在本机是否同名、`workspace/session-activity` 这条 waterfall 是否在本机存在 |
| 4 | **部分推进** | 形态有了**可照抄的样本**（临时 `.cjs` helper + `detached`/`stdio:'ignore'`/`windowsHide` + 等端口释放 + 同 argv/cwd）`[已读源码 §6.4]`。**仍待实测**：在本机（Windows）是否可靠 —— 参考实现的加固记录恰恰说明它踩过坑 |
| 5 | **未推进** | 仍只有参考实现自述；**必须真机复现**（这是 `dsh_hot_reload` 的核心承诺） |
| 6 | **未推进** | 仍待验证；不过 §6.4 已确认 `dsh.hotReload` 是生态约定 → 即便检测不了，靠声明的路仍是必要的 |
| 7 | **推进** | 结论明确：**运行时零命中** → 声明有效的前提是**本仓自己实现读取方** `[已核 §6.4]` |
| 8 | 未推进 | 仍待定 |
| 9 | 未推进 | 参考实现默认关；本仓待定 |
| 10 | **推进** | 通道与形状都已确认（`resolveAgent` + `followup` + notice 形状）`[已核 §6.4]`；**仍待实测**：重启后「启动即唤醒」的时序（参考实现实测「3 秒时 `agents.get()` 还取不到」） |

**一句话**：`dsh_restart` 的三块拼图（忙判定 / 恢复通道 / detached 拉起）**都已有可照抄的实现与已核对的 API**；`dsh_hot_reload` 的算法与回滚**有完整参考**，但它的**核心承诺（失败不碰旧 fiber）仍必须在本仓真机复现一次**。

---

## 6. 参考实现索引

调研方式：**只读**（npm registry 元数据 + GitHub API 读 README/文件清单）。**没有 clone、没有 install、没有运行**。
下表「核心做法 / 可借鉴点」= **各项目 README 的自述**，不是我们的实测。

| 包名（版本） | 仓 | 核心做法（自述） | 可借鉴点 | 与我们的差异 |
|---|---|---|---|---|
| `dsh-plugin-reload` 0.2.1 | reina4xa/dsh-plugin-reload | 工具 `reload_plugin`，**按 entry id / 模块名 / MCP `serverName` 重启单个 entry**，兄弟 entry 不动。两条策略：`mcp-client` 条目 respawn 子进程并重注册工具；**进程内插件条目做 hard reload**（bust 模块缓存 → 从磁盘重新 import → 把 fiber 换到新模块上），失败**回滚到上一份代码** | **三种定位方式**；**「先 import 成功再换 fiber」的顺序**；指出该技术与 `cordis-plugin-hmr` 的 partial reload 同源 | 它是**工具调用触发**且以「重启单个 entry」为目标；我们还要处理「改动属于哪一档」的前置判定（用它先问 `dsh_check_effect_mode`） |
| `dsh-hot-reload` 0.2.4 | stuarthu/dsh-hot-reload | **watch profile 的 `pnpm-lock.yaml`**，当已加载插件的版本变化时原位替换：失效模块缓存 → 重新 import → 原位重建 fiber。失败处理分两种：**import 期失败在碰运行中插件之前就被抓住**；**apply 期失败则回滚**（旧版本原位重建）。**失败过的版本不自动重试**。停用的行静默跳过 | 「不自动重试失败版本」这条**我们原本没有**；「import 期失败不碰旧 fiber」的顺序判据；停用行静默跳过 | 它是**事件驱动（lockfile）**、面向「升级已装插件」；我们是**工具调用驱动**、面向「刚改完源码」。它的触发点在依赖版本，我们的在本地闭包 |
| `dsh-hotswap` 0.1.1 | HongzhongL/dsh-hotswap | Web 侧「插件管理」页：**运行时热启用/停用/重启**（`entry.update({disabled:true/false})`）；**watch profile 的 `package.json`**，`dsh.profile.bundles` 增删时经 Include 根分组热挂载/卸载；把开关状态写进 profile `cordis.patch.yml` 的**托管区块**（`# === dsh-hotswap managed block ===`）；**保护名单**（`webserver` / `connection` / `api-gateway` / `modules` / `typert*` / `web*` / `hmr` 及自身）不可停用；`!!js` 控制或父分组停用的条目不可切换；识别手写 `disabled: true` 行并在启用时移除 | **保护名单**（哪些 entry 永远不许动）；**`entry.update({disabled})` 是 Loader 级开关的正解**；「手写行」与「托管区块」的一致性问题 | 它允许写 profile；**本仓 v1 明确不写 profile** —— 若 v1.1 要持久化开关状态，必须先落一条决策（这是对既定边界的突破） |
| `dsh-smart-restart` 0.5.1 | edusrez/dsh-smart-restart | 宿主插件：**每次启动检测到新进程接管**就用一条 notice **唤醒主 agent**（启动时间、上次启动、停机时长）。`smart_restart` 工具**记录调用方会话并把 notice 送回那个会话**。追踪最后活跃会话，在 `SIGTERM`/`SIGINT` 时落 `shutdown-notice.json`，下次启动钉回该会话（`shutdownGraceMs` 内活跃过）。**canary 预检**：先用一次「临时启动」验证能不能起来，失败就**中止重启**。从 `/proc/self/cgroup` 自动识别 systemd unit | **canary 预检**（我们四道闸里没有这一道）；**记录调用方会话、notice 送回原会话**；**停机信号落盘**（比「重启前写 marker」多覆盖了非本工具发起的重启） | 它是 **systemd/Linux 导向**（`/proc/self/cgroup`）；本仓验收主机是 Windows，需要在闸④ 里显式处理「拿不到启动命令」 |
| `dsh-restart` 0.1.2 | anweat/dsh-restart | 工具 `restart_harness`（可选 `delayMs`）+ `/restart` 斜杠命令 + 设置卡片（写入 `settings.yaml`）。`legacyRestart`＝旧 PowerShell/WMI/taskkill 路径（**默认关闭**，默认用 Node 原生）。`continuePrompt`＝重启后注入的提示词。重启 POST 只接受**环回地址 + 同源**（反代下 403）。**自 0.1.3-alpha.4 起停用并移除内置 detached watchdog**，理由是生命周期应交由 systemd / Windows 服务等外部管理器；保留 `$DSH_HOME/dsh-stop.flag` 让旧 watchdog 自退 | **「不自建看门狗」的判例**（他们做了又撤）；**`delayMs`**；环回 + 同源的限制；`continuePrompt` 说明了「恢复时注入什么」是可配置面 | 我们的 §3.3 原本写「spawn detached」 —— 与它撤掉 watchdog 的决定**方向相反**，需要先决定「谁拥有进程生命周期」 |
| `dsh-desktop-auto-restart` 0.1.0 | comer2031/dsh-desktop-auto-restart | Windows 桌面端：工具 `dsh_restart` `{reason, sessionIds, delaySeconds?}` + 侧边栏按钮。**工具默认不注册**（设置里默认关）。先写「待唤醒清单」再调脚本（`delaySeconds` 默认 10 秒留给回执落盘）。**宿主繁忙时直接拒绝**，且**调用方自己那个会话不算繁忙**；无 `force` 绕过。重启后按**会话原有预设**走官方通道唤醒并注入 notice，**唤醒失败就保留清单**、下次启动重试。**只用「监听端口 + 精确 PID」定位进程**，绝不按进程名批量杀 | 与我们 §3.2/§3.3 最接近的一份：**闸② 的语义**、**先落盘再重启**、**失败保留清单下次重试**、**端口+PID**、**工具默认关**。另有三条硬信息：执行策略 `Restricted` 时脚本静默不执行而 WMI 仍返回 rc=0（**假成功**）；WMI 建进程会被安全软件记一条敏感动作；非桌面/非 Windows 形态直接拒绝 | 它靠 PowerShell + WMI + user32 伪造会话结束，**只支持 Windows 桌面端**；本仓要覆盖浏览器版与跨平台，因此不能照搬它的拉起方式 |

### 6.1 未找到的参考包

下列名字在 **npm registry 上不存在**（`npm view` 报 404，2026-10-13）：`dsh-reload`、`dsh-host-restart`、`dsh-safety-restart`、`dsh-resume-on-restart`、`dsh-keep-going`。
→ 记为「未找到」，不推断其存在；若后续拿到具体来源（GitHub 仓、压缩包），补进本表。

### 6.2 一处只作为「技术出处」的引用

`cordis-plugin-hmr` —— **npm 上不存在**（404）。它只出现在 `dsh-plugin-reload` 的自述里，作为 hard reload 技术的出处。
另：本机 DSH 安装里与本仓相关的 hmr 包是 `@deepseek-ai/dsh-hmr` 与 `@deepseek-ai/dsh-client-hmr` `[已实测：本地 node_modules 只读列举]`；本仓已实测「watch patch 文件的正是 `dsh-hmr`」`[已实测：坑 34，`dsh-hmr\lib\index.js:718`]`。

### 6.3 调研边界（如实记）

- 上表的「核心做法」源自各项目 README 的自述；**热重载与重启的核心路径已在 2026-10-13 补读实现源码**（见 §6.4），未补读的部分仍按「自述」对待。
- 参考实现面向的**不是**本机运行时版本（本机 `0.2.1-alpha.2`；`dsh-restart` 自述其 `latest` 基线是 `dsh-v0.1.1-rc.2`）→ 涉及 API 形状的结论**必须回到本机运行时核对**，不能照抄。
- 表里每一条与「我们已经实测过的东西」冲突的可能，都以本仓实测为准。

### 6.4 已读源码（2026-10-13 补）+ **本机运行时核对**

调研方式：6 个参考仓 clone 到**枢纽仓的 `.local/refs/`**（`git check-ignore` 已确认 `/.local/` 被忽略 → **不在任何项目里**，用完可删），只读源码；再逐条回到本机运行时（`…\@deepseek-ai\dsh`，`0.2.1-alpha.2`）grep 核对 API 是否存在。
「本机存在」＝ 在本机运行时里 grep 到实证，**不是**参考实现的自述。

| 事实 | 参考实现出处 | 本机运行时 | 对我们的意义 |
|---|---|---|---|
| 清模块缓存走 **`loader.internal.loadCache`**（ESM，且需 `Map.prototype.delete.call` 绕过 Node 24 的 slot-only delete）+ `require.cache`（CJS） | `dsh-plugin-reload/src/index.ts:337-354`；`dsh-hot-reload/lib/index.js:278-330` | ✅ 存在 —— `…\dsh-hmr\lib\index.js:472-473` **自己也在用** `internal.loadCache` | §2.1 第 4 步成立；**官方自己就是这么清缓存的** |
| 重新加载 = **`loader.import(url)` 再 `loader.unwrapExports(...)`** | `dsh-plugin-reload/src/index.ts:364` | ✅ `unwrapExports` 命中 7 处（`…\dsh-loader\lib\index.js:460,667`） | §2.1 第 5 步的调用面确认 |
| 换 fiber 要经 **`entry.fiber` → `fiber.runtime` → `runtime.fibers` / `runtime.callback`**，**先 dispose 旧 fiber 再起新的**，最后把 `entry.fiber` 指回新 fiber；fiber 从未启动时走 `entry.refresh()` | `dsh-plugin-reload/src/index.ts:371-400`；`dsh-hot-reload/lib/index.js:343,390,427` | ✅ `entry.refresh()` 存在；`fiber._refresh()` 见 `…\dsh-loader\lib\index.js:843` | §2.1 第 6/7 步确认；**「先 import、后 dispose」被两个独立实现同时采用** |
| 回滚 = 把备份的缓存条目**放回**（ESM `cacheSet` + CJS `require.cache[fp] = module`）；import 期失败紧随其后抛出 | `dsh-plugin-reload/src/index.ts:356-368`（`rollbackCaches`） | ✅ 纯 Node 侧机制，不依赖宿主 API | §2.1 第 8 步**不必自己发明** |
| **忙判定**：`agents.list()` 排除调用方 → `status === 'running'`；`inbox.nextTurn/nextStep` 排队；`jobs.list(agent?.id)` 的 `running`/`stopping`；`ctx.waterfall('workspace/session-activity', …)` 里的 `kind === 'schedule'` | `dsh-desktop-auto-restart/lib/index.js:123-160` | ✅ `agents.list` ✓（`…\dsh-agents\lib\index.js:984`）；`jobs` 服务名**未核**（→ §5 第 3 条） | §3.2 **闸②** 有了具体判据；注意它 **fail-closed**：服务不可用 → `{known:false, idle:false}` = 拒绝 |
| 忙判定的精确语义：**只把「调用方自己那个会话」从 running/排队里排除；后台任务与定时提醒照旧全算（含调用方自己的）** | 同上 `:120-122`（其注释自述为 2026-10-07 用户实测反馈） | —（语义层） | §3.2 闸② 的语义细化：「调用方不算忙」**不是全豁免** |
| **唤醒/通知**：先 `ctx.get('sessionController').resolveAgent(SessionId(id))`（官方通道），再 `ctx.get('agents').get(SessionId(id))` → **`agent.followup(notice)`** | 同上 `:218-238` | ✅ `resolveAgent` ✓（`…\dsh-agents\lib\index.js:190`）、`sessionController` 服务名 ✓、`.followup` ✓ | §3.4 的恢复通道确认 |
| notice 形状：`{ role:'user', id, content:[{type:'text',text}], source:{ kind, form:'notice', summary } }` | 同上 `:186-193` | ✅ 同形（`followup(createUserMessage({…}))`，`…\dsh-agents\lib\index.js:100`） | §3.4 照此即可，**正好绕开坑 4**（不写自定义 SessionEvent） |
| **恢复清单是独立 JSON 文件**（`readPending`/`writePending`/`clearPending`），完成时写 `{sessions:[], done:true, doneAt}` 而非删文件 | 同上 `:194-207` | — | §3.4「marker 用独立文件」**参考实现已如此**，与坑 4 结论一致 |
| **会话 id 归一化**：运行期键是 `session-<uuid>`，调用方常传裸 uuid → 统一补前缀；非法则空串（据此判失败） | 同上 `:208-217` | — | §3.4/§3.6 的入参校验 |
| **唤醒要延迟+重试**：其注释自述「启动后 3 秒去唤醒，`agents.get()` 还取不到 agent（会话尚未就绪）」；配置 `wakeDelayMs` 默认 3000 | 同上 `:496`、`:31-32` | — | §3.4「唤醒失败保留清单、下次重试」**是踩出来的，不是理论要求** |
| 配置读取坑：`wakeOnStart: vol(Schema.boolean().default(true))` 若整包 unvolatile，字段仍是对象 → `=== true` 永不成立 → 功能静默失效 | 同上 `:31-32,56-57` | — | 与坑 1 同族：**开关类配置必须自己校验形状** |
| **detached 拉起**：helper 写成临时 `.cjs`（**不能 `node -e`** —— 引号活不过内联参数），`spawn(process.execPath, [helperPath], { detached:true, stdio:'ignore', env:process.env, windowsHide:true })`；helper 内 `setTimeout(delay)` → **等旧进程释放监听端口** → 用**同一份 argv + cwd** 起新 DSH → 自删 → `exit(0)` | `dsh-restart/src/index.ts:252-312`（`delayMs + 800`） | — | §3.3 的 spawn 形态有了**可照抄的样本**（含「等端口释放」这一细节） |
| `package.json` 的 `dsh.hotReload: false` 约定**真实且被第三方读取** | `dsh-hot-reload/lib/index.js:15,442-443` | ❌ **运行时零命中** | §2.2/§5-7：**本仓必须自己实现读取方**，否则该声明无效 |

**仍缺源码阅读**：`dsh-smart-restart`（`src/canary.ts` 107KB / `src/index.ts` 75KB，含 canary 预检与 systemd 识别，与闸④ 相关但优先级低于上表）、`dsh-hotswap` 托管区块的实现细节。

**参考源码的位置与去向**：`D:\ProjectSomething\dsh-plugins\.local\refs\<包名>\`（枢纽仓 `.local/`，已被 `.gitignore` 忽略）。
→ **按维护者 2026-10-13 的指定：可以拉取，但不得进入任何项目仓**；`.local/` 既不在插件仓、也不在枢纽仓的版本控制里。用完可整目录删除。
