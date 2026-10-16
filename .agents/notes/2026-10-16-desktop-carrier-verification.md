# 复核：桌面载体的真机判据（独立重跑，2026-10-16）

状态：生效

## 这一篇是什么

`fix/desktop-carrier` 那一批改动把「载体（carrier）」立成了一维观测，结论是**桌面宿主上插件侧没有回归路线**，
所以 `dsh_restart` 在那里必须**动手前**拒绝。写者不自己验自己 —— 本篇是**独立复核者**在真机上重跑那批评据的
逐条记录：**命令 + 逐字输出 + 结论**。全部只读：没改 `src/**`、`test/**`、`docs/**`、门面、`AGENTS.md`；
没写 `$DSH_HOME`（只读 marker）；没杀任何进程；没 `git add`/`commit`/`push`。本文件是本次唯一的写入。

第二段（整套门禁 + 对抗性变异）等 Lead 信号后另记 —— 那一段属于「改完能不能交付」，不属于本篇。

## 支撑的决策

- 载体这一维的建模与被否掉的替代方案 → [2026-10-16-desktop-carrier-decision.md](2026-10-16-desktop-carrier-decision.md)
- 宿主契约台账（桌面载体那一节）→ [../../docs/HOST-CONTRACTS.md](../../docs/HOST-CONTRACTS.md)

## 复核环境（会漂的读数都在这里，别抄到别处）

| 项 | 当时的形状 |
|---|---|
| 桌面应用 | `E:\DSH`（卸载项显示 `DeepSeek Harness 0.2.0-rc.2`），`resources\app.asar` 121,348,951 字节，LastWriteTime `2026/9/29 18:34:26` |
| 桌面内置 CLI | `E:\DSH\resources\runtime\cli\bin\dsh.cmd`（全文 4 行，见判据 1） |
| npm CLI | `C:\Users\speak\AppData\Roaming\npm\dsh.cmd`（`@deepseek-ai/dsh` 全局安装） |
| `$DSH_HOME` | `C:\Users\speak\.dsh` |
| 桌面 profile | `profiles\desktop`（bundle 列表第一项 `@deepseek-ai/dsh-base`） |
| 对照 profile | `profiles\web` |
| asar 取法 | 头部 16 字节：`offset 4 = headerSize`、`offset 12 = jsonSize`；JSON 在 `offset 16`；**文件数据基准 = 8 + headerSize**；某文件数据偏移 = 基准 + `entry.offset`。本次实测 `sizeField0=4 · headerSize=3392056 · jsonSize=3392048 · base=3392064 · 文件条目 12967` —— 用这套公式解出的 12,967 条路径全部可用（`ROOT = ["dsh","node_modules","lib","package.json","renderer"]`），所以它不只是照抄任务书 |

---

## 判据 1：保留 profile 被 CLI 拒绝 —— **成立**

三条命令都是**本机实跑**，`$LASTEXITCODE` 现取：

```text
> dsh --profile desktop --dump-config
error: profile "desktop" is managed exclusively by the Electron application
EXITCODE=1

> & 'E:\DSH\resources\runtime\cli\bin\dsh.cmd' --profile desktop --dump-config
error: profile "desktop" is managed exclusively by the Electron application
EXITCODE_A=1

> & 'E:\DSH\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop --version
11.7.0
EXITCODE_B=0
```

**逐字相同的错句来自哪**：asar 里 `dsh/node_modules/@deepseek-ai/dsh/lib/bin.js` 的

```js
function rejectElectronProfile(program, profile) {
	if (profile.toLowerCase() === "desktop") program.error("error: profile \"desktop\" is managed exclusively by the Electron application");
}
```

调用点两处、**分工不同**（这是「对照组为什么能过」的机制，不是凑的）：

| 行 | 位置 | 行为 |
|---|---|---|
| `bin.js:112` | 顶层 `--profile` | **无条件** `rejectElectronProfile` |
| `bin.js:119` | `plugin` 子命令 | `if (!manageDesktopProfile) rejectElectronProfile(plugin, options.profile)` |

`manageDesktopProfile: true` 只由桌面内置 CLI 传（asar `dsh-desktop-host/lib/cli.js` 的 `runCli({ manageDesktopProfile: true, … })`），
而 `E:\DSH\resources\runtime\cli\bin\dsh.cmd` 全文就是：

```bat
@echo off
setlocal DisableDelayedExpansion
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\..\..\..\DeepSeek Harness.exe" --expose-internals "%~dp0..\..\..\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" %*
exit /b %errorlevel%
```

⇒ **`desktop` 这个 profile 名在任何载体上都 dump 不到**（npm CLI 与桌面内置 CLI 都拒、`exit 1`），
而 `plugin` 子命令是唯一放行的路 —— 这两件事都由**同一份源码**解释，不是两条互不相干的观察。

**这条为什么重要**：`dsh_dump_config` / `dsh_check_effect_mode` 的「保留 profile 早拒」建在它上面，
而它是**按 profile 名**拒、不是按载体拒 —— 所以「从 web 会话里去 dump desktop」同样做不到。

## 判据 2：桌面宿主入口的形状 —— **成立**

从 `app.asar` 里现取 `dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js`（13,773 字节），
入口函数的 `runProfile` 调用逐字为：

```js
const application = runProfile({
	environment: loadLayeredEnv("dsh"),
	profile: "desktop",
	resolvedProfile: { profile, installAnchor },
	patchFiles: [],
	args: ["--no-open", "--port", "19387"],
	…
});
```

同目录 `package.json` 的 `version` 是 `0.2.0-rc.2`（与卸载项一致）。

**壳侧怎么起它**（`app.asar` 的 `lib/main.js`，`DesktopHostProcess.start()`）：

```js
const entry = join(this.runtimeDir, "node_modules", "@deepseek-ai", "dsh-desktop-host", "lib", "index.js");
const child = spawn(this.node, ["--expose-internals", …(inspect), entry, this.runtimeDir, this.projectDir,
  this.primaryRuntime ?? join(this.runtimeDir, "..", "runtime", "primary-runtime"), …(packageManager)], {
	cwd: this.projectDir,
	env: desktopNodeEnvironment(this.node, void 0, this.environment),
	stdio: ["ignore", "pipe", "pipe", "ipc"],
});
```

而 `this.projectDir` 就是 `$DSH_HOME/profiles/desktop`（同文件里 `profile: join(dshHome, "profiles", "desktop")`）。
⇒ **桌面宿主的 `process.cwd()` 恒等于 desktop profile 目录** —— 这条在判据 5 里承重。

## 判据 3：IPC 是闭集、且没有 restart/relaunch 通道 —— **成立**

**（a）Host → 壳的消息类型闭集**（`lib/main.js` 的 `isDesktopHostEvent`）：只有六个 `case`
`shutdown-complete` / `ready` / `platform-session` / `fatal` / `update-tasks` / `quit-inspection`，
末尾 `default: return false`。校验失败的处理逐字是：

```js
child.on("message", (message) => {
	if (!isDesktopHostEvent(message)) {
		this.fail(new Error("dsh desktop host sent an invalid IPC event"));
		child.kill("SIGTERM");
		return;
	}
```

⇒ 「未知类型会被 SIGTERM」**成立**（原文 `invalid IPC event` 与 `SIGTERM` 都在）。

**（b）壳对页面暴露的通道全表**：把 `lib/main.js` 里五张 `*IPC` 常量表全部解出（按行锚定，
不靠贪婪正则 —— 第一版贪婪写法把 `PLATFORM_IPC` 整表吞掉，解出 `UNRESOLVED`，是**复核自己抓到的假读数**）：

| 表 | 条目数 |
|---|---|
| `PLATFORM_IPC` | 5（`dsh-platform:*`） |
| `DESKTOP_IPC` | 25（`dsh-desktop:*`） |
| `WELCOME_IPC` | 9（`dsh-welcome:*`） |
| `MANDATORY_IPC` | 3（`dsh-desktop:mandatory-*`） |
| `UPDATE_DIALOG_IPC` | 3（`dsh-update-dialog:*`） |
| **合计** | **45** |

含 `ipcMain` 的行共 42 条 = **1 条 import（`main.js:5`）+ 41 个调用点**；脚本按
`ipcMain.(handle|on|once|removeHandler|removeAllListeners)(` 枚举到 **41** 条，两者对得上
（其中 2 条是 `removeHandler(channel)` 在循环里）。对这 45 个通道名加调用点做
`restart|relaunch|quit|exit` 过滤：**命中 0**。

**（c）壳自己的 `app.relaunch()`** 只有两处（`main.js:10984` 的崩溃恢复退出、`main.js:11909` 的
「Restart App and Host」菜单项），**都不是 IPC handler** ⇒ 「插件侧没有重启通道」成立。

**（d）Host 侧的闭集**（`dsh-desktop-host/lib/index.js` 的 `process.on("message")`）只认
`shutdown` / `quit-inspection` / `update-tasks`，其余 `return` —— 两侧都是闭集。

## 判据 4：hmr —— **与 Lead 的初始口径不符；复核后 Lead 已改判**

任务书原始问法是「本机桌面 profile 的 `node_modules` 有没有 `dsh-hmr`；web 的组合树里有没有 `- id: hmr`」。
两条字面答案：

- 桌面 `profiles\desktop\node_modules`（含 `@deepseek-ai/` 子目录）：**没有** `dsh-hmr`。
- 对照组的 `dsh --profile web --dump-config`（exit 0 / 1392 行）里：**有**，逐字是

```yaml
- id: hmr
  name: '@deepseek-ai/dsh-hmr'
  disabled: !!js '!ctx.get(''profileContext'')'
  config:
    root: []
```

**但这两条字面答案不承重，而且会推出一个错误结论。** 复核挖到的机制：

1. `- id: hmr` **不是 web 特有行** —— 它是 **`@deepseek-ai/dsh-base` 的 `cordis.patch.yml` 里 `insert:` 的共享核心行**。
   而桌面 profile 的 `package.json` 的 `dsh.profile.bundles` **第一项就是 `@deepseek-ai/dsh-base`**。
2. **「桌面 profile 的 node_modules 里没有」这条判据本身是选错了对象**：`profiles\web\node_modules` 里**同样没有**
   `dsh-hmr`，而 web 的树照样有那一行 —— 插件是从 **install anchor** 解析的，不是从 profile 的 `node_modules`。
   两边的 anchor 都有这个包：asar 侧 `dsh/node_modules/@deepseek-ai/dsh-hmr/`（6 个文件：LICENSE / README×3 /
   `lib/index.js` / `package.json`）与 npm 侧
   `…\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-hmr\`。
3. 把所有**会作用到桌面的层**逐个 grep `hmr`：asar 内 `dsh-base` / `dsh-web-app` / `dsh-experimental-schedule-bundle` /
   `dsh-experimental-agent-team-profile` / `dsh-experimental-voice-input-bundle`，加 `profiles\desktop\node_modules` 下
   五个 bundle 的 patch，加 `profiles\desktop\cordis.patch.yml` —— **没有任何一层提到 hmr**
   （`dsh-web-app` 只提 `client-hmr`，那是另一行）。⇒ 静态组合下桌面树**同样有** `- id: hmr`。
4. **那一格的 `disabled` 表达式**：`!!js "!ctx.get('profileContext')"`。它求值成启用还是禁用**没有真机读数**
   （CLI 拒绝 dump 保留 profile，见判据 1）。但 `dsh-base` **自己**的另一行给了强指向：
   `- id: deepseek-account` 的 `config.desktopPlatform: !!js "ctx.get('profileContext')?.name === 'desktop' && …"` ——
   这行只可能在「桌面宿主里 `profileContext.name === 'desktop'`」的前提下有意义。⇒ 按本仓自己的前提，
   桌面宿主的 `profileContext` **在**，那行的 `disabled` 应为 **false（启用）**。

**结论**：桌面侧「没有 hmr」**不成立**；正确说法是「**本机没有从桌面侧 dump 到那一行**（CLI 拒绝），
而按静态组合它应当有、且应为启用」。⚠️ 这条是**推断**（`disabled` 的真机求值**推不出来**），
不是实测 —— 别把第 4 点读成真机读数。

**这条的代价为什么必须记下**：把 hmr 判成 absent 会让 `dsh_check_effect_mode` 在桌面端把结论压成
`restart-required`，**再把用户指向一个桌面端根本做不到的重启**（判据 5 那条路）。症状「看起来更保守、更安全」，
实际是**方向相反**的谎：桌面端唯一的出路是退出 App，而 hmr 在的时候绝大多数配置改动**根本不用重启**。
（Lead 收到本条后已重开 T2/T3 改判 —— 写进本篇，因为「当时为什么改」比「改成了什么」更容易丢。）

## 判据 5：那次真机事故的盘上根证据 —— **成立（且拿到了比 `/tr` 更硬的独立来源）**

### 5.1 marker（只读，未改动）

`$DSH_HOME\dsh-plugin-debugging\restart\marker.json`（514 字节，LastWriteTime `2026/10/16 0:21:45`）：

```json
{
  "version": 1,
  "reason": "User explicitly requested an actual restart after reviewing the dry-run gates.",
  "at": "2026-10-15T16:20:08.477Z",
  "sessions": ["session-15ab7ce9-1c01-4112-98c5-bfbe504c3e7b"],
  "initiator": "session-15ab7ce9-1c01-4112-98c5-bfbe504c3e7b",
  "state": "consumed",
  "trace": [
    "restart-loop=pass", "busy-session=pass", "composition=pass", "launch-command=pass",
    "waiting for 1 session(s) to come back",
    "consumed at 2026-10-15T16:21:45.188Z"
  ]
}
```

同目录 `last-attempt.json`（恢复半的回执）：

```json
{
  "version": 1,
  "startedAt": "2026-10-15T16:21:41.437Z",
  "finishedAt": "2026-10-15T16:21:45.245Z",
  "outcome": "recovered",
  "markerReadAttempts": 1,
  "markerStateAtRead": "armed",
  "markerConsumed": true,
  "detail": "the restart notice was delivered to 1 session(s) and the marker was marked consumed"
}
```

### 5.2 计划任务的 `/tr` —— **逐字起的是 `--profile web`**

```text
> schtasks /query /tn dsh-plugin-debugging-restart /v /fo LIST
TaskName:      \dsh-plugin-debugging-restart
Last Run Time: 2026/10/16 0:20:08
Last Result:   -1073741510
Task To Run:   cmd /c set "DSH_HOME=C:\Users\speak\.dsh" && cd /d C:\Users\speak\.dsh\profiles\desktop && ping -n 16 127.0.0.1 & dsh --profile web
EXITCODE=0
```

**三个时刻对得上**：`at` = `16:20:08.477Z` ↔ 任务 `Last Run Time` = 本地 `0:20:08`（= `16:20:08Z`，UTC+8）
⇒ 这条任务就是那次重启的拉起者；`consumed at` = `16:21:45.188Z`（本地 `0:21:45`）↔ marker 的 LastWriteTime `0:21:45`。

那条 `/tr` 的形状也与代码一致（`relaunchPlanOf`：`cmd /c set "DSH_HOME=…"` + ` && cd /d <cwd>` +
` && ping -n <ceil(delayMs/1000)+1> 127.0.0.1` + ` & <argv>`；`delayMs=15000` ⇒ `ping -n 16`）。

### 5.3 事故那一刻的会话日志原文（**证事故发生在桌面载体上**）

会话日志 `…\sessions\--D-ProjectSomething-dsh-plugins-dsh-plugin-debugging--\session-15ab7ce9-…\session.v4.jsonl.zstd`
（多帧 zstd，按 magic 切帧后可逐帧解压；**只读**）。原文（时间已换算成 UTC，与 marker 同轴）：

```text
[369] tool/call   @16:20:02.539Z  dsh_restart {"dryRun":true,…}
[370] tool/result @16:20:02.563Z  relaunch: cmd /c set "DSH_HOME=C:\Users\speak\.dsh" && cd /d C:\Users\speak\.dsh\profiles\desktop && ping -n 11 127.0.0.1 & dsh --profile web
                                  resolved: dshHome=C:\Users\speak\.dsh profile=web (default)
[374] tool/call   @16:20:08.472Z  dsh_restart {"delayMs":15000,"reason":"User explicitly requested …"}
[375] tool/result @16:20:08.661Z  relaunch: … cd /d C:\Users\speak\.dsh\profiles\desktop && ping -n 16 127.0.0.1 & dsh --profile web
                                  markerWritten: true  ·  verdict: … this process is exiting
[377] turn/end    @16:20:08.661Z  {"reason":{"kind":"interrupted"}}
[379] agent/inbox/spliced @16:21:45.177Z  [dsh-plugin-debugging] restart recovery: … arrived about 93s after that request …
[386] user/message @16:21:47.853Z  (运行时上下文) … Web GUI URL: "http://127.0.0.1:3080"
```

**「消费者是 web 宿主」的两条独立证据**：

1. **工具注册表增量（决定性）**：Computer Use 的 `cua_driver_native__*` 工具**只存在于桌面 profile**
   —— `dsh --profile web --dump-config` 里 `computer-use|cua` **0 命中**，`profiles\web\package.json` 也没有这两个依赖；
   而 `profiles\desktop\cordis.patch.yml:159-163` 逐字有 `- insert: [- id: computer-use, - id: computer-use-cua-driver-native]`，
   `profiles\desktop\package.json:21-22` 钉着这两个包。会话日志里的 `tool-addition` 事件：

   | seq | 时刻 | 增量条数 | 其中 `cua_driver_native__*` |
   |---|---|---|---|
   | 204 | 2026-10-14T13:34:40.052Z | 1（`dsh_restart`） | **0** |
   | **366** | **2026-10-15T16:19:53.403Z** | **57** | **56** |
   | **388** | **2026-10-15T16:21:47.857Z** | 13 | **0** |

   ⇒ 真跑重启那一轮（seq 366 之后 15 秒就是 16:20:08 的 `dsh_restart`）宿主**有** Computer Use ⇒ **桌面 profile**；
   恢复之后那一轮（seq 388）**没有** ⇒ **web profile**。

   时间线也自洽：turn 13 是隔了 `1h 43m 8s` 之后的第一次请求（seq 363 逐字记着这个间隔），
   而 `cua` 工具正是**在那一轮**才被加进注册表 —— 也就是「会话在那一刻被装进了桌面宿主」。
   另有一条同向的小信号：同一会话的 `resolved` 行在 turn 11/12（seq 299 / 338）是
   `dshHome=… (env)`，到 turn 13（seq 370）变成 `(default)` ⇒ **两轮的宿主 env 不同**，宿主换过。
2. **`/tr` 里的 `cd /d …\profiles\desktop`**：那是 `process.cwd()`（`launchCommandFrom` 用 `cwd: process.cwd()`），
   而桌面宿主的 cwd 恒为 `projectDir`（判据 2）；用户桌面上的启动脚本 `start‑dsh.ps1` 全文只有
   `Write-Host …` + `dsh web`，**没有任何 `cd`** ⇒ 那条 cwd 不可能是 `dsh web` 宿主来的。

**「谁消费的」与「那个进程的启动时刻」**：`agent/inbox/spliced @16:21:45.177Z`（notice 投递）
与 `consumed at 16:21:45.188Z`（marker 消费）**相差 11 ms** —— 是恢复半同一步里「先投递、后消费」，
`last-attempt.json` 的 `startedAt=16:21:41.437Z` 是那一步的开始（notice 文本里那句
「arrived about 93s」= `16:21:41.437 − 16:20:08.477` 的整秒，**同一份记录自洽**）。

## 推不出来的格子（照实记，不许凑）

| 想确认的 | 为什么推不出来 |
|---|---|
| 消费 marker 的**那个进程的启动时刻** | 该进程已不在：当前 3080 上的 web 宿主是**今天**另一个实例（pid 7700，CreationDate `2026/10/16 11:20:01`）。盘上没有那次进程的创建时刻。只能给**下界**：任务 `Last Run Time` `0:20:08` + `ping -n 16` ≈ 15 s ⇒ 不早于本地 `0:20:23` |
| 桌面宿主里 `- id: hmr` 的 `disabled` 表达式**真机求值** | CLI 拒绝 dump 保留 profile（判据 1）；进程内的树没有对外读数。第 4 点的「应为启用」是**推断** |
| 事故那一刻 `profile=web` **从哪来**（继承的 `DSH_PROFILE`，还是本仓默认值 `DEFAULT_PROFILE`） | `DSH_PROFILE` **不是**用户/机器级持久环境变量（`HKCU:\Environment` 与 Machine 都没有；只有当前进程里是 `web`）；而 `src/config.ts` 的链是「用户显式配置 → `profileContext.name` → `env.DSH_PROFILE` → `'web'`」。**两者后果相同**（拿一个与宿主无关的名字去拼命令行），但**成因描述不同**，而那一刻的宿主 env 没有留档 |
| 桌面宿主 Web GUI 的实际端口 | 桌面入口逐字传 `args: ["--no-open","--port","19387"]`，但**没有真机读数**（桌面 App 当时没在跑，事后也没法回放）。⇒ 不能拿 19387 当「消费者是 web」的判据，所以本条的结论只建在 5.3 的 Computer Use 与 cwd 上 |

⚠️ **一条给下游的措辞警告**：`src/config.ts` 的注释与 `AGENTS.md` 坑 41 现在写的是
「`DSH_PROFILE` 是**从启动 Electron 的那个 shell 继承下来的** `web`」。**继承只是两种可能之一**，
本机查不到持久环境变量支持它 —— 那句应当写成「它记的不是这个宿主的身份（可能来自继承，也可能来自本仓默认值）」。
缺陷与修法都不受影响（按 `profileContext.name` 取真源是对的），**只有成因那一句是过度断言**。

## 一条方法论（本次真实救回来的东西）

判据 4 的第一版我按任务书的字面问法跑，两条都会「通过」；救回来的是**问「这条判据的对照组成立吗」**：
`profiles/web/node_modules` 同样没有 `dsh-hmr`，却照样有那一行 —— 一个在对照组上**同样为真**的判据，
量不出它想量的东西（坑 24 「判据要写清在哪个上下文里成立」的同族）。同理判据 5：
`/tr` 只证明「那一刻拼出的命令是 `--profile web`」，**不**证明「宿主是桌面」；后者要另找证据（Computer Use 增量）。
