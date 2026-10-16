# 桌面端载体：为什么把「能不能把宿主带回来」抽成一维

**日期**：2026-10-16 ｜ **状态**：生效

## 背景：一次真机事故，而不是一个猜想

在 **Desktop profile** 上调用 `dsh_restart`（该 profile 的 patch 里 `enableRestart: true`）之后，
用户看到的是「桌面端断线、桌面端没关、然后打开了网页版」。盘上与进程上的物证：

| # | 物证 | 读数 |
|---|---|---|
| ① | `$DSH_HOME/dsh-plugin-debugging/restart/marker.json` | `at=2026-10-15T16:20:08Z`，`initiator=session-15ab7ce9…` |
| ② | `schtasks /query /tn dsh-plugin-debugging-restart /v` 的 `/tr` | `cmd /c set "DSH_HOME=…" && cd /d …\profiles\desktop && ping -n 16 127.0.0.1 & dsh --profile web` |
| ③ | 该 web host 进程 | 启动于 `0:20:26`（任务 `0:20:08` + `ping` 的 15 秒之后），占 3080 |
| ④ | marker 的 `trace` | `consumed at 2026-10-15T16:21:45Z` —— 被**那个 web 实例**消费，会话也在 web 实例里被唤醒 |
| ⑤ | 终端里的那行 | `dsh web: opening the default browser; pass --no-open to disable`（桌面宿主自己起的时候是带 `--no-open` 的） |

⇒ 三件事同时成立：**旧宿主确实退了**（`appExit` 生效）、**新进程确实起来了**、**但起来的是另一个 profile**。
「重启成功」这句话只在「有新进程」这个意义上成立 —— 而**恢复半的成果落在了错的实例里**。

`--profile web` 的来源是 `resolveConfig` 的 `config?.profile || env.DSH_PROFILE || 'web'`。
⚠️ **那个 `web` 究竟从哪来，判「推不出来」**（2026-10-16 独立复核）：本机**没有**用户级 /
机器级持久 `DSH_PROFILE`（`HKCU:\Environment` 与 Machine 都查过），所以它可能来自**启动
Electron 的那个 shell 的继承**、也可能来自本仓 `DEFAULT_PROFILE`（`src/config.ts`）的兜底；
那一刻的宿主 env 已经取不到了。两种成因**后果相同** —— 拿一个与宿主身份无关的名字去拼命令行
—— 缺陷与修法都不受影响，所以这里只写形状、不断言成因。而**真源一直就在手边**：
`profileContext.name`（启动器在建树之前 `provide`，见 `apps/cli/src/profile-boot.ts`）。

## 被否决的前提：参考实现里那个「官方重启 API」不存在

外部资料建议改调 `ctx.desktopRuntime.requestRestart()`。**本机与源码双向核实：没有这个 API** ——
`desktopRuntime` / `requestRestart` / `desktopActions` 在整个 harness 检出与装好的 `app.asar` 里
**零命中**。宿主侧能核到的、与重启有关的通道只有这些：

| 已核事实 | 真源（包 / 文件） | 分级 |
|---|---|---|
| 桌面 Host 是 Electron 以 Node 模式起的子进程，入口 `…app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js`、`cwd = projectDir` | `apps/desktop/src/host-process.ts` | `[已核]` |
| Host ↔ 壳的 Node IPC 消息类型是**闭集**（`ready\|fatal\|platform-session\|shutdown-complete\|update-tasks\|quit-inspection`）；未知类型 ⇒ 壳记 `invalid IPC event` 并 **SIGTERM 掉 Host** | 同文件 `isDesktopHostEvent`；装好的 asar 同形 | `[已核]` |
| 壳对页面暴露的 `ipcMain` 通道全表里**没有** restart / relaunch | 装好的 `app.asar` 的 `lib/main.js` 全表 | `[已核]` |
| `app.relaunch()` 只出现在壳**自己**的路径：更新安装流程、致命恢复弹窗的 Restart、（development 才挂的）「重启应用与 Host」 | `apps/desktop/src/main.ts` | `[已核]` |
| DSH 命令行**无条件**拒绝保留 profile：`dsh --profile desktop`（boot）与 `--profile desktop --dump-config` 都回 `error: profile "desktop" is managed exclusively by the Electron application`、exit 1 | `apps/cli/src/bin.ts` 的 `rejectElectronProfile`；**本机实测**（npm 全局 CLI 与桌面内置 `resources/runtime/cli/bin/dsh.cmd` 都拒；`dsh.cmd plugin --profile desktop …` 放行） | `[已实测]` |
| 产品对「需要重启」给用户的原话是一句**提示**，没有按钮 | `packages/client/ui-plugin-manager/src/client/locales.ts`：`Restart DSH to apply the change.` | `[已核]` |

⇒ **桌面端能重启，但执行者只能是 Electron 壳；插件侧不存在那条通道。**
所以「插件自己把桌面端带回来」在当前宿主上**做不到**，而错误地以为它能做，正是那次事故。

## 决定

1. **把「载体」抽成一维**：新增 `src/lib/carrier.ts`（纯函数、零 IO、零 Cordis）——
   `observeCarrier()` 给出 `cli` / `desktop-host` / `unknown`，`relaunchRouteFor()`
   给出一张**只认已实测路线**的表（`cli × win32 ⇒ task-scheduler`，其余一律 `none`）。
2. **闸④的语义从「拿不到启动命令」改成「载体没有已实测的回归路线」**：四道闸的**数量不变**，
   变的是闸④的观测更准 —— 拒绝码新增 `no-relaunch-route`，与既有 `no-launch-command` 分工。
3. **profile 身份改用运行时真源**：`config.profile > profileContext.name > env.DSH_PROFILE > 'web'`。
4. **一处探、三处用**：`dsh_restart` 闸④、`dsh_dump_config`（保留 profile 的 CLI 在任何载体上都 dump 不了）、
   `dsh_check_effect_mode` 的 `nextStep`（桌面端那条路要交给人）。载体在 `apply()` 探一次、
   经 `PluginState` → `ToolDeps` 分发 —— 各读各的会出现「同一进程里两处判断不一致」，而没有判据照得到那种错。
5. **桌面端拒绝走「动手之前」**：与「非 win32 没有已实测路线」同一个形状，
   拒绝文案点名**人的动作**（托盘退出 App 再启动），不把人指向一个不存在的工具动作。

## 替代方案

1. **只修 profile 名（不做载体闸）** —— **否，这是最坏的一档。**
   修完之后拉起命令会变成 `dsh --profile desktop`，而那条命令被 CLI **无条件拒绝**（exit 1）：
   新宿主永远起不来，旧宿主却已经 `exit(0)` ⇒ 机器上**一个宿主都没有**。
   今天的「起了个 web」至少还留着一个活实例。
2. **靠「Host 干净退出 → 壳的致命恢复弹窗」半自动重启** —— **否。**
   那条路今天确实能走（弹窗带 Restart 按钮），但它是**崩溃语义**：会写 crash report、
   还会给用户一个「禁用第三方插件」的选项。把崩溃包装成「重启功能」是骗人；
   要它可用得先改壳的语义，那属于上游。
3. **等上游加 IPC 再动手（什么都不做）** —— **否，但上游那条要并行推。**
   桌面端用户会一直踩这个坑，而本仓能给的「不骗人」版本今天就能落地。
4. **让插件自己起 Electron 可执行文件** —— **否。**
   桌面应用有单实例锁（`apps/desktop/src/single-instance.ts`），再起一个只会把窗口聚焦，
   不会重启 Host；而杀进程属于本仓明令禁止的那一类（B10）。

## 代价与已知限度

- **桌面端等于没有这个工具**（拒绝）—— 这是如实的结果，不是缺陷。要真正「优雅」，
  必须上游在闭集 IPC 里加一条重启请求（壳收到后 `app.relaunch()` + 有序退出）；
  `relaunchRouteFor` 已经是一个枚举，上游落地后本仓只多一个值 + 一条实现。
- **两条未核**（已写进 `docs/HOST-CONTRACTS.md` §5）：① `profileContext` 在 **apply 期**
  是否可见（源码方向确定：`provide` 在建树回调开头、早于 `ProfilePackages` 挂载；真机未验）；
  ② 「桌面 profile 总是没有 hmr」只是本机观察，未推广。
- **红线 B16 不受影响**：它的 fixture 是合成的（`renderSynthetic` + `okFixture`），
  不走各工具的真实 verdict —— 这条核过，别重复怀疑。

## 支撑的决策

- 写侧与行动类的边界见 [2026-10-13-write-side-tool-boundaries.md](2026-10-13-write-side-tool-boundaries.md)。
- 重启的持久化与 marker 见 [2026-10-13-restart-persistence-and-helper.md](2026-10-13-restart-persistence-and-helper.md)
  （本文只改「能不能回来」这一维，不动 marker 与恢复半）。
- 现状（形态、闸表、拒绝码）以 [../../docs/SHAPE.md](../../docs/SHAPE.md) §6.1 与
  [../../docs/HOST-CONTRACTS.md](../../docs/HOST-CONTRACTS.md) 为准，本文不追改事实。
