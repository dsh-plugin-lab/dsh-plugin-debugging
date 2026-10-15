# 决策：restart 的持久化结构与 helper 机制（2026-10-13）

状态：生效

## 问题

`dsh_restart` 要在杀宿主**之前**把「怎么起、恢复到哪」落到磁盘。
落点三问：**写在哪** · **marker 记什么** · **helper 怎么活过宿主死亡**。

## 参考实现（本轮核对的两份最有价值）

| | `dsh-restart` | `dsh-smart-restart` |
|---|---|---|
| 落点 | `$DSH_HOME/` **顶层平铺** `dsh-resume.json` | `$DSH_HOME/.smart-restart/` **子目录** |
| helper | 现场生成 `.cjs` → 临时目录 → `unref` → 立即 `unlink` | 不用 helper（自举 canary） |
| 等待端口 | helper 里 `setTimeout(delayMs + 800)` | canary 编排 |
| 退出把关 | `helper.once('spawn', …)` 才 schedule exit | — |

两份都验过同一件事：**在 `/F` 之下，所有关键写入必须是同步的**。
`dsh-smart-restart/src/index.ts:822` 的注释原文：「`writeFileSync` + `mkdirSync` are synchronous so they complete under the signal」。

## 替代方案

- **落点**：顶层平铺 · `<包名>/` 子目录 · 隐藏点目录 `.smart-restart` 形状 · 宿主 `ctx.storageDomain`。
- **helper**：ship 随包发布 · copy 到状态目录带版本戳 · generate 现场生成。
- **端口等待**：固定 sleep · 轮询直到端口可 bind。
- **恢复判据**：pid 变没变 · pid + 启动时刻 · 仅 marker 存在。

---

## 一、B10 / B15 都要改（前置，不是顺手）

⚠️ **本节曾写「B10 的措辞『插件不许写 `$DSH_HOME`』要先改」，定位是错的**（2026-10-14 核正）。核对 `test/redlines.test.ts` 后发现拦路的是**两条不同的红线**，而且「不许写 `$DSH_HOME`」今天**根本不在任何判据里**：

| 红线 | 真实判据（逐行核过） | 对 `restart` 意味着什么 |
|---|---|---|
| **B10**（`:942`，describe 标题「诊断半边只读」） | `FORBIDDEN_PROCESS_VIOLATIONS`（`:796-807`，六条：`process.kill` / `taskkill` / `Stop-Process` / `SIGKILL` / `SIGTERM` / 装面命令形态）**＋ `judgeFsWriteUsage`（`:899-925`）** | ❌ **`restart` 必红**：它必须**同步写 marker**，而 B10 禁一切 `node:fs` 写入 API。**里面一条路径判据都没有，更没有 `$DSH_HOME`。** |
| **B15**（`:1578`，写侧只许碰进程内树） | `WRITE_SIDE_FORBIDDEN`，含 `:1586` `{ label: 'DSH_HOME（写侧不碰宿主主目录）', pattern: /\bDSH_HOME\b/ }` | ⚠️ 作用域是 `WRITE_SIDE_FILES`（`:1576`，**只有 `dsh_hot_reload.ts` 与 `lib/hot-reload.ts` 两个文件**）⇒ 新增写侧 restart 文件**必须同批加进 `WRITE_SIDE_FILES`**，否则写侧边界对它不生效；加进去后 `:1586` 这条**必然拦住**写 `$DSH_HOME` 的代码 |

**两个必须知道的事实**：

1. **B10 的注释与实现不一致**：块注释 `:775` 写「它管的是诊断半边，**不是**『整个 `src/**` 只读』」，但 `:944` 的实现是 `readSourcesUnder('src')` —— **扫的是全部 `src/**`**。这正是「`restart` 为什么不可能存在」的真缝，但缝在**实现**上，不在措辞上。
2. **「不许写 `$DSH_HOME`」今天只是散文**，共 4 处、无机械判据：
   [AGENTS.md](../../AGENTS.md):30 · [src/tools/AGENTS.md](../../src/tools/AGENTS.md):15 · [docs/SHAPE.md](../../docs/SHAPE.md):379 · [README.md](../../README.md):78（+ [README_zh.md](../../README_zh.md):78）。
   ⇒ **把它做成红线是「新增」，不是「修改现有断言」。**

**改成分层**，三段各有机械判据（对 `restart` 新文件生效）：

| 不许 | 判据形状 |
|---|---|
| 不许改 **profile**（`profiles/<p>/` 全部内容） | 路径前缀闭集 |
| 不许改**宿主数据**（`sessions/` `storages/` `logs/` `cache/` `attachments/` `.credentials.yaml` `settings*.yaml`） | 逐条前缀，**禁用通配**（`*/logs/*` 会漏 `profiles/web/logs`） |
| **可以**写**自己命名空间下**的状态 | 反向正则：`^<包名>/` 或 `^<包名>[-_.]` |

**为什么可断言**：禁列是闭集前缀，允许形状是正则，两者都落在「路径字符串」这一层，不需要理解语义。

**代价照实记**：红线从「不许写 `$DSH_HOME$`」放宽成「不许写它的**大部分**」。这是有意的 —— 原措辞下 `restart` 不可能存在。但放宽**必须配兜底**：每个禁列一条判据，且禁列里出现新目录时要同批补。

⚠️ **与 `docs/SHAPE.md:382` 的待拍板措辞要合并成一个版本**：SHAPE 记的是「不许**本仓自己**写 profile / `$DSH_HOME`；**经宿主服务（spill）落盘不在此列**」—— 它只给 spill 开口，**没给「自己命名空间」开口**。两份别并存。

## 二、目录结构

### 核实：宿主有既有形状，但不是 `plugins/`

| 观察 | 是不是约定 |
|---|---|
| `$DSH_HOME/storages/<名>.json` 平铺（`cpa-panel-*.json` / `usage_history.json`） | ✅ 宿主 `dsh-storage-json` + `ctx.storageDomain` 的真产物 |
| `$DSH_HOME/cpa-panel/runtime/…`（含 `.exe`、`.bak-*`） | ❌ 那个插件自己手搓的 |
| `$DSH_HOME/.workbuddy-*.json` | ❌ 另一个插件的，命名规则私有 |

**`ctx.storageDomain` 走不通**：它要求在组合里挂 `dsh-storage` + backend + `dsh-storage-domain` 三行，而这三个包**都没有 `cordis.patch.yml`**（是库不是插件行），插件自己插不进 profile 组合。⇒ **走文件系统。**

### 推荐：`$DSH_HOME/<包名>/restart/`

- 顶层平铺（`dsh-restart` 的做法）→ ❌ 与 `dsh-auto-continue.json` / `.workbuddy-*.json` 混在一处，别人清理自己的文件时可能顺手删掉；且**没有任何机制能防止下一个人也选平铺**。
- 隐藏点目录 `.smart-restart` 形状 → ⭕ 可行，但那是**别人的**命名习惯，我们沿用等于假装自己是它。
- **`<包名>/restart/`** → ✅ 子目录名 = 包名，天然落在 B10 新措辞那个正则里；`restart/` 再分层，将来这个插件有别的持久需求也不会挤在一起。

**谁创建**：插件自己，`mkdirSync(dir, { recursive: true })`（同步 —— 见第五节）。
**权限**：跟随进程 umask，不显式 chmod（读者是同一用户下的自己）。

**fsync**：**不做**，但**必须同步写**。理由：`writeFileSync` 保证调用返回时数据已在 OS 缓冲区，进程被 `TerminateProcess` 杀掉**不会丢已写完的字节** —— 这是两份参考实现共同的选择，也是在 `/F` 下能做到的最强保证。
⚠️ **`fsync` 的代价要说清**：它会把「写 marker」从亚毫秒拖到毫秒级，而且在 Windows 上对目录 fsync 直接失败要吞掉。**先不做，等真机测出丢数据再加**（加法容易，删不掉一次误判的复杂度）。

## 三、marker 内容

| 字段 | 必需 | 判据 | 备注 |
|---|---|---|---|
| `version` | ✅ | 不在支持集 ⇒ **响亮拒绝**，说清格式版本 | 只能**加**字段不能改语义（第五节） |
| `pluginVersion` | ✅ | 与 `version` **分开** —— 格式同但策略变了，`version` 判不出 | 容易漏 |
| `sessionIds[]` | ✅ | **数组**，不是单个 —— 多会话在飞是真实场景 | 参考实现已从单值演进成数组 |
| `dshHome` + `profile` | ✅ | 防「marker 来自另一个实例」 | `DSH_HOME` 可由 env 变 |
| `pid` + `processStartedAt` | ✅ | **反 pid 复用**：同 pid 但启动时刻不同 ⇒ 新进程 | `dsh-smart-restart` 只用了 pid，那是它的简化 |
| `launchCommand[]` + `cwd` | ✅ | 怎么起 | 从 `process.argv` 取，不用 `dsh web` 拼 |
| `port` | ✅ | 等哪个端口释放 | |
| `logOut` + `logErr` | ✅ | helper 的 stdout/stderr 落哪 | **容易漏**：缺了它「重启没起来」无处可查 |
| `restartAt` | ✅ | 配 `graceMs` 窗口，避免把「半小时前关的」当「刚刚重启的」 | **机制**取自 `dsh-smart-restart/src/boot.ts:320-328` 的 `shutdownTarget()`（它对 `lastActiveAt` 做 `graceMs` 比较）；**字段名**来自 `dsh-restart/src/index.ts:117`。两份实现别缝成一条引用 |
| `graceMs` | ⭕ | 由**工具参数**决定，不写进 marker | 决策随调用变，不随记录变 |

**`lastTurnSeq` / 恢复到第几条：建议不做。**
会话日志（`session/log/*.jsonl`）本就逐事件落盘，恢复是**读日志重放**，不是从某 seq 续写 —— 两份参考实现都没有这个字段。
⚠️ 但要区分两件事：marker 说「恢复**哪些会话**」，恢复时读日志决定「重放到**哪一条**」。

## 四、helper：generate（不是 ship，也不是 copy）

`dsh-restart/lib/relaunch-helper.js` 整个文件只有一个函数，返回**一段 JS 源码字符串**，运行时拼上 `require` 头与路径常量写成 `.cjs`。

| 路线 | 判据 | 结论 |
|---|---|---|
| **ship**（随包发布 `helper.cjs`） | 要进 `files`、过 `check:release`、被 `scaffold check` 逐字比对 | ❌ 多一份身份件；版本漂移时旧 helper **静默用旧策略** |
| **copy**（发布 → 复制到状态目录 + 版本戳） | 「helper 要活过宿主死亡」 | ❌ **前提不成立**，见下 |
| **generate**（现场生成到临时目录） | 生成物每次都是最新版；不落持久目录 ⇒ **无版本漂移面** | ✅ |

**为什么 copy 的价值不成立**：helper 是 `detached: true` + `unref()` 起的**独立进程**，它活不活**不依赖文件** ——
文件只需要在它 `require` 完成前存在，那只有几毫秒。放进持久目录换来的不是「存活」，是版本漂移。

**形态**：Node `.cjs`。宿主本身就是 Node（`process.execPath` 现成）、跨平台一份逻辑、不必为 Windows/Linux 各写一版。

**Windows 特有的坑**（`relaunch-helper.js:53-87`，值得原样抄）：
直接 `spawn` 会**闪一个可见控制台**，而后续被沙箱的 PowerShell 子进程会继承它 ⇒ 走
`Start-Process -WindowStyle Hidden`，参数用 **base64 JSON 载荷**跨 JS→PowerShell 边界
（空格 / 引号 / 空参数 / Unicode 才不丢），临时 `.ps1` **带 BOM**（本仓坑 32 同族）并 `finally` 里删。

## 五、版本漂移：单向门

| 侧 | 判据 | 动作 |
|---|---|---|
| 新插件读**旧** marker | `version ∉ SUPPORTED_MARKER_VERSIONS` | **拒绝启动**，verdict 说清「来自哪个格式版本」，`nextStep` 指向「删 marker 或手工重启」 |
| 旧插件读**新** marker | 找不到 `sessionIds` ⇒ 返回 `[]` | ⚠️ **静默降级成不恢复** |

**这天然是不对称的，而不对称本身就是设计**：新读旧**可以**响亮失败，旧读新不行。
⇒ **`version` 只能加字段、不能改语义**。这条必须写进代码注释 ——
否则下一个人为了「顺便清理一下」改字段语义，就把这道门推倒了。

**缓解旧读新**：把 `version` 放在对象**第一个键**，并在文件末尾追加哨兵行，让「读到了但没懂」留下痕迹。

⚠️ **这套版本门是本仓的新设计，不是从参考实现抄来的**（2026-10-14 核）：两份参考实现的 marker
**都没有 `version` / `pluginVersion` 字段**（`dsh-restart` 的 marker 就是 `{sessionIds, restartAt, pid}`，
见 `src/index.ts:115-119`）。`dsh-restart/src/index.ts:137-143` 那段「找不到 `sessionIds` 就 `return []`」
只是「读不懂就空」的**防御**，**不是版本门**。
⇒ 上表两个字段与「新读旧响亮拒绝」都要**自己实现、自己测**，没有现成参照。

## 六、清理

| 物 | 时机 | 判据 |
|---|---|---|
| **marker** | **校验通过后**才删 | ⚠️ 不是「读到就删」—— 半消费的 marker 删掉就永远恢复不了 |
| **helper** | `spawn` 事件到 + `unref()` 后立即 `unlink` | 已 `require` 进内存，删文件不影响它跑（**`dsh-restart/lib/index.js:236`** 的 `finally`；源是 `src/index.ts:281-282`，`.ps1` 侧是 `src/relaunch-helper.ts:84-86`）。⚠️ 引这两个数字**必须带文件名** —— `src/index.ts:236` 落在 `interface RestartInfo` 里，不是它 |
| **log** | **不自动删** | 重启失败时它是唯一线索；自动删 = 出问题后证据自己没了 |
| **停用插件** | 启动时清残留 marker | 参考实现 `disableLegacyWatchdog()` 的形状 |

## 七、原方案漏掉的三件事（读参考实现才发现）

1. **helper spawn 成功之前不许退出**（`dsh-restart/lib/restart-helper-lifecycle.js`，**编译产物 7 行** —— 源 `src/restart-helper-lifecycle.ts` 是 23 行。这是整个设计里最关键的 7 行）：
   ```js
   helper.once('spawn', () => { schedule(exit, delayMs) })
   helper.once('error', onError)
   helper.unref()
   ```
   ⇒ **Node 确认 helper 起来了，才 schedule 自己退出**。
   没有这条，spawn 失败时宿主已经退出 ⇒ **没人拉起新进程，而旧进程也没了 —— 彻底没了**。
   ⚠️ 这是**不可逆**失败（对话、进程、端口全丢），所以它必须是最先被测的一条。

2. **端口等待不能用固定 sleep 当唯一手段**：`delayMs + 800` 是「先睡够，大概率够了」。
   端口释放时间随机器而变 ⇒ 固定 sleep 在慢机上不够。**真因是宿主根本不重试**：
   `dsh-host-webserver/lib/index.js:438-448`（`0.2.1-alpha.2`）先 `this.server.once('error', reject)` 再 `listen(...)`
   —— 任何 bind 失败（`EADDRINUSE`）⇒ **boot 直接失败**，不是「晚一点就好」。
   推荐：**轮询直到端口可 bind，超时判失败**（失败要有 log 与 marker，不静默）。见台账 C11。

3. **别的会话在飞时拒绝重启**（维护者 2026-10-14 拍板）。判据与它踩过的坑见第八节。

## 八、`activeAgentGuard`：结论与判据（原「本机 `status` 不成立」已撤）

### 结论（维护者拍板）

**拒绝。** 别的会话在飞时不重启 —— 打断在飞的任务**不可逆**，而拒绝的代价只是等。
**不可逆的那个该由用户显式决定，不该让工具静默决定。**

⇒ 提供 `force: true` 逃生口，但**覆盖必须留痕**（写日志 + 记进 marker），让「这次是覆盖过的」在事后可查。

### 参考实现的判据（本机 `0.2.1-alpha.2` 上**成立**，形状可照抄）

`dsh-smart-restart/src/boot.ts:362-371`，一行过滤：

```js
const inFlight = agents
  .filter((a) => a.status === 'running' && String(a.id) !== callingSessionId)
  .map((a) => String(a.id))
return { allowed: inFlight.length === 0 || force, inFlight }
```

它还带 `callingSessionId` 排除 —— **调用方自己不在受害者名单里**（它主动重启、且已被 pin 去恢复）。

⚠️ **本段曾写「本机 `status` 不存在」，那是错的（2026-10-14 核正）。**
错因：只读了基接口 `dsh-agent/lib/types/types.d.ts:11-14`（那里确实只有 `readonly id`），
**漏了同包 augmentation**。`status` 读得到：

- `dsh-agent/lib/types/runtime-types.d.ts:138-147`：`declare module './types.ts' { interface Agent { … readonly status: AgentStatus … } }`
- `AgentStatus = 'idle' | 'running'`（同文件 `:90`）
- 运行期真身：`dsh-agent-loop/lib/index.js:790-792` 的 getter
  （`phase.kind === 'idle' || phase.kind === 'maintenance' ? 'idle' : 'running'`）
- **宿主自己就这么读**：`dsh-agent/lib/index.js:28` `lookup(sessionId)?.status === "running"`、`:35` `agent?.status === "running"`
- `list()`（`:612-613`）返回的正是这些原始对象 ⇒ **`.status` 可以直接从 `list()` 的结果上读到**

⇒ `docs/SHAPE.md:459` 写的「闸②判据已可落地（`agents.list` 的 `status`）」**是对的**，本节原先把结论判反了。

### ghost 仍然是真的，但**不构成「不能用 status」的理由**

`agents.list()` 会返回**已 RETIRE 却从未注销**的 agent。成因本机核过：

- `dsh-agent-loop/lib/index.js:1713-1715` 先 `machine.cancel({kind:'disposed'})` 再 `await machine.whenIdle()`；
- `:1731` 的 `detachAgent?.()` 落在那个 `await` **之后**；
- `whenIdle()`（`:870-875`）是个 `do/while` 等 `activityDone` 的循环 ⇒ **turn 永不收敛时它永不 settle，整个 teardown 不 settle**，于是一直留在注册表里。
- 参考实现的 `ghost-guard.test.js`（`.local/refs/dsh-smart-restart/test/ghost-guard.test.js:1-57`，结论行 `:41-42`）记的就是它。
  ⚠️ **它引的宿主行号（`:1140`/`:1145`）与本机这次核到的（`:1715`/`:1731`）不是同一版** —— 凡引宿主行号**必须带版本**（本仓活跃坑 24 那一族）。

**`lastActiveAt` 确实读不到**（`dsh-agent` 的 types 与 `lib/index.js` 全文 0 命中）⇒ 「用 `lastActiveAt` 把 ghost 挑出去」这条路**真的走不通**。
但 **`.length` 与 `status` 不是同一件事**：真正会误报的是 **`.length`**（把 ghost 也算一个），而不是 `status`。

### 判据（推荐）

**用 `agents.list()` 的 `status === 'running'`**（与 `SHAPE.md:459` 一致），并接受一个已知偏差：

- ghost 的 `phase.kind` 不是 `idle`（它卡在 running 的 turn 上）⇒ **ghost 会被读成 `running`**，于是闸②会比「真实在飞」更保守地拒绝。
- **这个偏差方向是对的**：维护者已拍板取「拒绝」，**宁可错拒**（拒绝的代价只是等，见拍板记录）。
  所以不必为了精确而绕开注册表。

**若将来真要区分**，不要自己读日志尾部重造投影：宿主已有现成的
`TurnBoundaryProjection.openTurnStartSeq`（`dsh-agent/lib/types/types.d.ts:66-68`，null = 两个 turn 之间）。
⚠️ 两条硬事实：
1. 别指望用 `turn/end` 的 `reason: interrupted` 当证据 —— `dsh-session/lib/types/types.d.ts:190-198` 明说
   「**The loop never emits this marker live**」，它是 agent-loop resume / session-query 冷读时**事后补**的；
   本机 40 份会话日志实测 342 次 `turn/end` 里 `interrupted` **0 次**，用户中断的真实形状是
   `{"kind":"aborted","reason":{"kind":"user"}}`。
2. 该字段来自 `TurnBoundaryProjection`，**不是** `readSessionEvents`（后者在宿主里不存在）；真源是
   `ctx.sessionQuery.listEvents(sessionId)` / `readSession()`。

## 九、job object：宿主**在** job 里；子进程在不在，**取决于走哪条 spawn 路径**（2026-10-14 补测；同日被独立复现改正**三次**）

⚠️ **本节被 `gate-verifier` 的独立复现改正过三次**。真源 `0.2.1-alpha.2`、宿主 pid 612。
**第一次（task-14）**：原结论写「宿主的孩子不在那个 job 里 ⇒ helper 不会被收掉」—— **那是错的**，错法是**样本偏差**（只查了「启动器 pwsh + 两个终端」，这三个**恰好**不在 job 里，却被推广成「宿主的子进程都不在」）。
**第二次（task-18）**：**`task-8` 把 `err=5` 归因于「宿主 job 缺 `0x800`」—— 归因对象搞错**。宿主 job 其实**有** `0x800`。
**第三次（task-21，性质不同：不是结论错，是读数本身无效）**：`task-17` 的「runner job」读数**已撤回**（`NULL` 句柄语义，见下表第一行）；**WMI 改判「不能判定」**；**代起三路线新增为可用**。⚠️ **宿主 job 那一侧的句柄是验证过的（`0x3C00`、对照 `explorer→0`/`host→1`）⇒ 关于宿主 job 的结论不撤。**

| 事实 | 证据 | 对设计的含义 |
|---|---|---|
| ⚠️ **`NULL` 句柄语义（可复用的宿主语义）** | **`QueryInformationJobObject(NULL,…)` 问的是「调用者自己的 job」**；**`IsProcessInJob(x, NULL)` 问的是「任意 job」**。复现者自纠：`FindJob(pid)` 在**该 pid 不持有 job 句柄**时返回 `IntPtr.Zero`，于是把 `IsProcessInJob(x, NULL)` 当成了「x 在那个 job 里」，**静默降级成 `inAnyJob`**；**是它自己的对照组抓到的** —— `explorer` 也读出 `inRunnerJob=1`，不可能 `[task-19 自纠]` | ⚠️ **拿 `NULL` 当「目标进程的 job」会静默读成「任意 job」**。报 job 成员身份**必须持有那个 job 的句柄**，否则只能报 `inAnyJob` 并**标明它不是 job 专属** |
| **宿主在 job object 里**（✅ 保留） | `IsProcessInJob(host, NULL)=1` + **复制宿主持有的句柄**读到 flags `[已实测]` | 前提成立，不能忽略 |
| **那个 job 是 `0x00003C00`**（✅ 保留，句柄已验证） | `KILL_ON_JOB_CLOSE`/`SILENT_BREAKAWAY_OK`/`BREAKAWAY_OK`/`DIE_ON_UNHANDLED_EXCEPTION` **四位全开** `[已实测]` | 看着很危险 |
| ⚠️ **改正：「孩子不在其中」不成立**（原写「宿主的孩子不在那个 job 里」，**已删**） | 按 `ParentProcessId=612` 取**真子进程**逐个查该 job：`20124`(imagegen-mcp) / `19960`(cli-proxy-api) / `21812`(runner.js) **全部 = 1（在）**；= 0 的是**启动器 pwsh（它是父）**与持久终端 `[已实测：task-14]` | **在不在 job 里是按进程 / 按 spawn 路径的** ⇒ **不许推广** |
| ⚠️ **撤回：「持有者是沙箱 runner、`0x2000`」读数无效**（原 task-18 写的断言，**降级**） | 能站住的只有：**探针自己「在某个 job 里」、该 job `Flags=0x2000`**。**持有者身份**与**「哪些进程在那个 job 里」都没验证** —— 原判据用了 `NULL` 句柄（见本表第一行），而 `0x2000` 那个值也来自 `QueryInformationJobObject(NULL,…)`（= **调用者自己的 job**）`[读数无效 / 已撤回：task-19]` | **`task-8` 的 `err=5` 成因（调用者 job 缺 `0x800`）不受影响**（那是受控复现）；但**「谁持有那个 job」不许再当结论** |
| **`CREATE_BREAKAWAY_FROM_JOB` 成因（受控复现夹死）**：调用者 job **缺 `0x800` ⇒ `err=5`；有 `0x800` ⇒ 成功** | 自建**与宿主逐位相同**的 job（`0x3C00`）、把 helper `AssignProcessToJobObject` 进去（先验 `InJob=1`）：`0x2000` 内不带 flag → OK（对照有效）；`0x2000` 内带 `0x01000000` → **err=5**（与 task-8 一致）；`0x3C00` 内不带 flag → OK 且不在 job；`0x3C00` 内带 `0x01000000` → **OK（无 err）** `[受控复现：task-17]` | ⚠️ 有信息量的是「**没有 err=5**」，不是成员判定。⚠️ **受控复现 + 规则一致，不是宿主上下文直接实测** |
| **本插件自己的 spawn 也逃不出** | `src/lib/exec.ts` 的 spawn 产出：`--dump-config`(pid 12952) → `InJob(child, 宿主job)=1`；`--dump-config-schema`(pid 11016) → **1**；对照 `explorer=0`，宿主句柄表只有一个 job 句柄 `[已实测：task-16]` | ⇒ **`{detached:true}` 不能当逃生手段**；helper 若走 `exec.ts` 那条路，**它会落在宿主 job 里** |
| ⚠️ **WMI `Win32_Process.Create` —— 改判「不能判定」**（原写「没脱离 ⇒ 不能当逃生依据」，**已撤**） | 有效读数只有 `inHostJob=**0**`、`inAnyJob=1` ⇒ **子进程不在宿主 job 里**；**它在哪个 job 未知** `[实测：task-19 改判]` | **既不能说它是逃生手段，也不能说它不是**。边界保留：`rc=0` 假成功**本次未复现**；只在**受限令牌**上下文测过 |
| ✅ **降级路径三条「代起」路线实测能用**（task-21 新增） | **[A] 计划任务 `schtasks`**：`/create` `/run` `/delete` 全 `exit=0`；**受限令牌下不需提权**；被起进程 parent = **`svchost.exe`（Task Scheduler）**，`inHostJob=0`，其 `PING.EXE` 子进程同为 0 ⇒ **逃出宿主 job ✓**。**[B] `explorer.exe` 代起**：真起了（查了进程，非只看 rc），`inHostJob=0` ✓。**[C] 在-job 的 PowerShell 中间进程 + `Add-Type` + `CreateProcess(0x01000000)`**：`Add-Type` **346 ms**、受限令牌下可用；带 flag → **`OK`、无 `err=5`** `[实测：task-19]` | **三条都能用现成的 `src/lib/exec.ts` spawn 实现，不需要原生绑定**。⚠️ **边界不许省**：三条**都只对「宿主 job」验到 0**；**是否也在另一个 job 里未知**（`inAnyJob=1`）—— **若那个 job 也带 `KILL_ON_JOB_CLOSE` 且持有者会死，风险仍在（复现者明确说没测出来）**。⚠️ 没能在**宿主进程内发起**任何一条 ⇒「从宿主 job 内发起会怎样」仍是**受控复现 + 语义**；[C] 用的也是**自建同 flags job** |
| **宿主 runner 的守卫行为**（顺带记） | 复现者触发过一次：`subprocess-local: Windows Job runner exited … before proving its managed range empty`；原因是**调用结束时还有子进程留在 runner 的 job 里** `[实测：task-19]` | **runner 退出前要求其 job 范围被证明为空；留下成员会触发该守卫** |
| ⚠️ **一条未解释的冲突**（照实记，**不编机制**） | `task-16` 实测 `exec.ts` 的孩子**进了** `0x3C00` 宿主 job，而受控复现说「`0x3C00` 成员不带 flag 创建的**应当脱离**」—— 冲突，**复现者明确表示无法解释** `[无法判定]` | **待插件内实测钉死**；在此之前不许拿任一边当结论 |
| **`detached` 逃不出 job；`Start-Process -WindowStyle Hidden` 也不是逃逸手段**（✅ 保留） | `DETACHED_PROCESS`(0x8) → 仍 `inJob=1`；`dsh-restart/src/relaunch-helper.ts:53-87` 全程无 breakaway 标志 `[已实测+源码]` | **`Start-Process` 只解决「不闪控制台」** |
| ⚠️ **「在 job 里」推不出「会被收掉」**（✅ 保留） | detached 孙进程在持有 KILL job 的 runner 与我的 pwsh **都退出后仍存活并 LISTEN**；`dsh-subprocess-local/lib/runner.js:298-302` 只在 job **空**时关句柄，非空**不** `terminateJob` `[已实测+源码]` | 判据是「**谁持有句柄**」+「**那个具体进程在不在 job 里**」 |

**删掉的两处**：
- ❌ **`ActiveProcesses=3`** —— 复现者连续读到 **6→5→4**，且**每次都与全系统枚举当时的值一致**（⇒ API 可信，是我的单点采样不可用）。**任何「job 里有几个进程」都要同刻与枚举对照。**
- ❌ **「必须用持久终端才能读 job」** —— 复现者从**工具调用的沙箱 runner** 里 `OpenProcess` 打宿主**成功**、整套探针跑通；我当初读到的 `err=87` **不可复现**。**两条路都能读。**

**判据要求随之改（第三次补正）**：原来写「**两个 job 都 0** 才算逃出去」—— **现在只能是「宿主 job 必须 0」**；另一个 job **拿不到有效句柄 ⇒ 只能报 `inAnyJob` 并标明它不是 job 专属**。

**保留的落地结论**：① **不用改插件就能读**（两条路都行）⇒ 没有「依赖解析不到 ⇒ 六把工具整个消失」的代价；② **插件侧读不到** `@deepseek-ai/dsh-win32-process` 与 `koffi`（都 `ERR_MODULE_NOT_FOUND`）—— **这条未被推翻**。

**影响段（2026-10-14 第三次改写）**：
**`CREATE_BREAKAWAY_FROM_JOB` 机械上成立（宿主 job 有 `0x800`），但 Node 的 `child_process.spawn` 无法传创建标志**（`detached:true` 只加 `DETACHED_PROCESS`；本仓 `src/lib/exec.ts:60` 就是原生 `spawn`），原生绑定（`dsh-win32-process` / `koffi`）**从本仓解析上下文都 `ERR_MODULE_NOT_FOUND`**；宿主树里也**没有** `child_process` 补丁。
⇒ **降级路径的可行方案已实测出三条**：**计划任务（首选** —— 无需提权、parent 是 svchost、`inHostJob=0）与 **explorer 代起**；另有 **PowerShell 中间进程 + `Add-Type` 代发 breakaway**（机制成立但成本更高，`Add-Type` 约 **346 ms**）。三条都**能用现成的 `src/lib/exec.ts` spawn 实现，不需要原生绑定**。
⚠️ **但「是否也在另一个 job 里」未测**（`inAnyJob=1`）⇒ **helper 的长期存活仍需在插件内真机实测钉死**，**不许把本条当已排除风险**。
⇒ **helper 的存活路径不能靠「孩子会脱离」（已实测它在宿主 job 里），也不能直接靠 breakaway 标志（spawn 传不了）；必须单独实测钉死。**

**仍测不了 / 待实测**：Windows **服务化**部署下 job 的归属与服务侧 `KILL_ON_JOB_CLOSE` 行为；按名杀 `taskkill /IM`（两者都会误伤维护者在用的进程 ⇒ 本机不做）；**helper 的长期存活（「是否也在另一个 job 里」未测）**。
（**已不再待测**：代起三条路线 —— `task-19` 已实测能用，见上表。）

## 十、恢复与投递：两条被推翻的前提（2026-10-14 补测）

1. ⚠️ **Web profile 没有 `--resume`**：`dsh-web-app` / `dsh-web` 的 `lib/index.js` 里 `resume` **0 命中**，`dsh/lib/bin.js` 只在帮助里写 `dsh tui --resume <session>`。
   ⇒ **「把 `sessionIds` 拼进 `launchCommand`」是死路**（原方案的隐含前提不成立）。进程内入口只有 `ctx.agents.resume({resumeSessionId})`；**真触发者是客户端重开会话**。
2. ⚠️ **`agent/session-start` 在本机不存在**（全 `@deepseek-ai/*` grep 0 命中）⇒ **参考 README 的投递通道不可照抄**。本机可用的是 `agent.followup(UserMessage)` + source `form:'notice'`，宿主自己就这么投。
3. **`sessionIds[]` 的角色要写准**：它是「**等哪些会话**」的名单，**不是**「怎么把它们拉起来」。等不到是**正常分支** ⇒ 必须留 log；`dsh-restart` 那种「60s 超时后清 marker」会把证据一起删掉。
4. **重启耗时只有下界**：13:04:00 启动器创建 → 13:04:06 新宿主创建 ≈ **6.0 s**；「端口可服务」那一刻没抓到 ⇒ **别把 6 s 当 helper 该等的时间**（见台账 C14）。

## 十一、marker 的落盘通道：会话日志**够用**，§6.1 那条理由已消解（2026-10-14 核）

⚠️ **本节纠正第二节（目录结构）与 `SHAPE §6.1` 的一个前提**。原文说「marker **必须是独立文件**，不能写进会话日志」，理由是坑 4（自定义 `SessionEventMap` 成员 + `session.append()` 会写坏日志）。**核下来：坑 4 自己给的补救办法 `appendPluginRecord()` 是官方的、且读取侧真的放行。**

| 环节 | 事实 | 源码 |
|---|---|---|
| 写入 | `appendPluginRecord(session, type, data)`，`dsh-session` **公开导出**；`type` 必须合 `plugin:` 文法；`data` 必须无损 JSON | `dsh-session/lib/index.js:1293-1295`、文法 `:1246`、`data` 校验 `:1547-1548` |
| **强制 `ignorable`** | 记录里**硬写** `ignorable: true` | 同文件 `:1555` |
| **读取侧放行**（这是关键） | `if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true) throw unsupported("… not marked ignorable; refusing to interpret the log …")` ⇒ **未知类型 + `ignorable===true` 被保留并跳过，不拒绝整份日志** | `dsh-session-persistence/lib/index.js:184` |
| 读回 | `pluginRecordOf(event)` → `{type, seq, time, data}`（要求 `ignorable===true` 且类型合文法） | `dsh-session/lib/index.js:1304-1313` |
| 重启后找得到 | 宿主有列会话服务：`sessionQuery.listSessions()` | `dsh-session-query/lib/index.js:1043/1048/1072`；底层 `:107`/`:287` |
| **`spillStore` 不行** | 每进程 `mkdtempSync(tmpdir()/dsh-spill-)`，且**启动时清扫**（"Startup cleanup mechanics"）⇒ **重启后不保证还在** | `dsh-spill-local/lib/index.js:35`、`:107-124`、`:311` |
| `presentationMeta` ≠ 它 | 那是 `defineTool` 的**输出呈现回调**，**不写会话日志** | `dsh-tools/lib/index.js:843`、`:860-862` |

**⇒ marker 有合法落点，且不必放宽任何东西**：通道 `appendPluginRecord(session, 'plugin:<包名>/restart-marker', data)` → 落在**会话日志**里（由 `dsh-session-persistence-jsonl` 持久化）→ 重启后 `sessionQuery.listSessions()` + `pluginRecordOf` 读回。**不写文件、不碰 `$DSH_HOME` ⇒ 不触发 B10。**

⚠️ **两个还没定的设计点（别当成已解决）**：
1. **没有找到「按类型索引」的读入口** ⇒ 可能要**逐会话读日志**找 marker，代价随会话数增长（未核）。
2. **marker 记的是「等哪些会话」，而记录本身住在某个会话里** —— 「谁持有 marker」这一步**未定**（写进调用方会话？还是每个在飞会话各写一条？）。

⇒ 给维护者的建议（**`docs/SHAPE.md` 是 Lead 独占，我没动**）：**§6.1 的「必须独立文件」前提可以撤**，改写成「marker 落**会话日志**（`appendPluginRecord`），读回走 `pluginRecordOf`」；第二节「目录结构」里那套 `$DSH_HOME/<包名>/restart/` 方案**随之不必**（也就不必放宽 B10）。

## 影响

- B10 措辞 + 判据是**前置**（第一节），不是顺手。
- 实现顺序：marker 读写与校验（纯函数，好测）→ helper 生成（纯函数，返回源码字符串）→ **spawn 确认后再退出**（第七节第 1 条）→ 端口轮询 → 在飞判据（第八节）→ 恢复。
- 可直接借鉴：`relaunchHelperSource` 的 base64 跨 PowerShell 边界 · `superviseRestartHelper` 的 spawn 前置 · **「同 pid 不同启动时刻 ⇒ 是新进程」这个语义**（⇒ 可区分 HMR）。
  ⚠️ 出处要分清（2026-10-14 核正）：它**不在** `detectRestart` 里 —— `dsh-smart-restart/src/boot.ts:33-44` 的 `detectRestart` 只用 `marker.pid === pid` + `Date.parse(marker.lastBootAt)`，**全仓无 `processStartedAt`**。
  真身在 **dsh-restart**：`src/index.ts:84` 的 `PROCESS_STARTED_AT = new Date(performance.timeOrigin).toISOString()`，经 `GET /plugins/dsh-restart/restart` 暴露（`:474`），客户端 `src/client/restart-monitor.ts:96` 以 `before.pid !== after.pid || before.startedAt !== after.startedAt` 判定。
  本仓自己早就这么做了：`dsh_check_effect_mode` 的「产物 mtime vs 进程启动时刻」是同一族。
- **不可照抄**：`delayMs + 800` 固定 sleep（端口释放时间随机器而变）。
  ~~`activeAgentGuard` 的 `status === 'running'`~~ —— **这条已撤**：`status` 本机读得到，那段判据可以照抄（见第八节）。
  **新增两条（2026-10-14）**：① **别把 `Start-Process -WindowStyle Hidden` 当 job 逃逸** —— 它只解决「不闪控制台」（第九节）；
  ② **别照抄参考 README 的 `agent/session-start` 投递通道** —— 本机没有这个事件名（第十节）。
- ⚠️ **job 那条推理不能承重（2026-10-14 三轮独立复现改正后新增）**：原先想用「宿主的孩子不在 job 里」推出「helper 不会被 `KILL_ON_JOB_CLOSE` 收掉」——
  **那条前提已被证伪**；而且**本插件 `src/lib/exec.ts` 的 spawn 已实测其孩子就在宿主 job 里**（task-16）。⇒ **helper 的存活判据必须落到「helper 实际那条 spawn 路径」上单独实测**，不许从「它是个子进程」推。
  另外**别指望 `CREATE_BREAKAWAY_FROM_JOB` 救场**：它机械上成立（宿主 job 有 `0x800`），但 `child_process.spawn` **传不了创建标志**；
  ⇒ **降级路径已有三条实测可用的代起方案**（计划任务首选 / explorer / PowerShell 中间进程 + `Add-Type`），**都能用现成的 `exec.ts` 实现**；
  ⚠️ **但它们「是否也在另一个 job 里」未测** ⇒ **长期存活仍要插件内真机实测**。（全部读数见第九节。）

## 拍板记录（维护者，2026-10-14）

- 落点取 **`$DSH_HOME/<包名>/restart/`**（否掉顶层平铺）。
- `activeAgentGuard` 取**「拒绝」**：别的会话在飞时不重启。
  理由：**打断在飞的任务不可逆，而拒绝的代价只是等。不可逆的那个该由用户显式决定，不该让工具静默决定。**
  `force: true` 作为显式出口保留，且**覆盖必须留痕**（日志 + marker），事后可查。

## 拍板记录（维护者，2026-10-15）

- **notice 里的 `reason` 只发回发起者**；被这次重启顺手打断的**其它会话**收到同样的事实（什么时候请求的、隔了多久、marker 的下场），**但不含 `reason`**。
  - 理由（维护者原话）：**「`reason` 是用户给自己留的便条，不是公告。广播给别人 = 串话。」**
  - 被否的选项是**原来的行为**（一条 notice 群发给名单里所有人）—— 它把「谁在向谁说话」这件事抹掉了。
  - 代价：marker 必须**显式记发起者**（`initiator`）。不能从 `sessions[0]` 推 —— 那个数组**排过序**（定序不许随遍历顺序漂），先后关系在那里已经被抹掉。
  - ⚠️ **缺席的语义是「不知道谁发起的」，不是「谁都可以」**：本字段之前写的 marker 里它不存在，此时**谁都不发**。方向是保守的：这条规则守的是「不串话」，取不到时宁可少说。