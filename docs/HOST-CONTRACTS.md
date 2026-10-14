# 宿主契约台账（已核事实）

**本文职责**：把「我们在宿主上**核过什么、怎么核的**」集中在这里 —— 每条事实都带真源（宿主源码的文件 + 检索串，或实测证据：进程 / 端口 / 日志 / 时间）。
**不负责**：我们自己的分层与设计取舍 → [ARCHITECTURE.md](ARCHITECTURE.md)；**插件最终形态与未做工具的方案** → [SHAPE.md](SHAPE.md)；在这里怎么干活 → [AGENTS.md](../AGENTS.md)。

**读者**：任何要调宿主 API 的人、任何要判断「这条结论还能不能信」的人。**改代码前先来这里查，不要凭推断。**

## 怎么读本文

### 证据分级（正文逐条标，只此四种）

| 标记 | 含义 | 能撑起什么 |
|---|---|---|
| `[已实测]` | 在**目标上下文**里真机跑出来的（真进程 / 真端口 / 真日志 / 真句柄） | 可以当结论用 |
| `[已核]` | 在**安装树里发布的产物 JS** 里逐字 grep / 读到的源码事实（**不是**参考实现的自述，也不是推断） | 可以当结论用；但「源码这么写」≠「运行期一定这样」 |
| `[受控复现]` | 用与目标**逐位相同**的参数在**自建对象**上复现出的行为 | ⚠️ **不等于目标上下文直接实测**。它撑起「规则一致」，**撑不起「目标上已经这样」** |
| `[无法判定]` | 本轮**没测出来**，或读数本身无效 | **不许当结论用**；必须同时写清「试过哪几条路、卡在哪」 |

**没有标记的句子不许当结论用**（要么是推断，要么已过期）。**「推断」不是分级** —— 它是缺证据时的临时说法，必须点明。

### 证据怎么写

- **文件 + 检索串**，**不抄行号、不抄计数**：行号与用例数会漂，换宿主版本必然失效（根 [AGENTS.md](../AGENTS.md) 全局规则「不抄会漂的值」）。
  例：`dsh-session/lib/index.js` 的 `ignorable: true` 那行。
- **版本锚点只写一次**（见下）；正文里不再重复版本号。
- 只认**代码实际做的事**：读的是构建产物，源码级注释与设计意图不在场。

### 版本锚点与时效

本文的 `[已核]` / `[受控复现]` / `[已实测]` 全部锚在**本机安装树的那一份 `@deepseek-ai/dsh`**（`0.2.1-alpha.2`）。
**宿主换版本必须重核**；本机「在跑的宿主」与「源码检出」常常不是同一个版本 —— 引用前先确认哪一份。**要写就现查，别抄本文的版本号。**

---

## 0. 输出边界的契约（tool 返回值必须是无损 JSON）

⚠️ **先读这条的后果，再读条件**：失败时**不是「少一个字段」，是整个工具不可用** ——
宿主在构造结果那一步就抛，模型拿不到任何 `verdict` / `key` / `audit`。**静默的形状是「工具根本没被调用」**。
**编号用 0 是有意的**：它不属于任何一个工具，是全部工具的共同前提；插在中间会把后面所有节号顶掉一位，
而那些节号已经被 [SHAPE.md](SHAPE.md) 与 [ARCHITECTURE.md](ARCHITECTURE.md) 引着了。

| # | 事实 | 证据（文件 + 检索串） | 分级 | 影响 |
|---|---|---|---|---|
| V1 | ⚠️ **入口 = `snapshotToolValue` → `snapshotJsonValue`；失败抛 `ToolOutputError(toolName, ['value is not lossless JSON'])`** | `dsh-tools/lib/index.js`：`createSuccessResult` 的第一行就是 `snapshotToolValue(tool.name, candidate)`，**在 `validateJsonSchemaValue` 与 `render` 之前**；`ToolOutputError` 亦在同文件 | `[已核]` | 顺序决定了后果：**渲染没跑、schema 也没校验，整个结果直接作废** |
| V2 | **成功与失败走同一条路** | 失败结果同样由 `createSuccessResult` 落地 —— 即 `{ok:false}` **也必须**是无损 JSON | `[已核]` | 「失败分支反正没人看」是错的：失败分支一样被宿主逐值判 |
| V3 | ⚠️ **被拒的取值**：`undefined` / function / symbol / bigint；非有限数（`NaN` / `±Infinity`）；**`-0`**；循环引用；**symbol 键 / 不可枚举自有属性**；**非 plain 原型的对象与数组**（class 实例、子类数组）；**稀疏数组**；**数组带 `length` 以外的 own key**。<br>**注意「null 原型对象」是被接受的**（`hasPlainObjectPrototype` 显式放行 `prototype === null`）—— 别把它也归进被拒那类 | `dsh-util-values/lib/index.js`：`walkJsonValue`（含 `-0` 与非有限数、非 object 的一律拒、循环、`enumerableStringKeys`、数组原型与 `ownKeys` 计数、对象原型几处分支）、`hasPlainObjectPrototype`、`snapshotJsonValue`、`isJsonValue`。**逐条跑过宿主自己的 `isJsonValue`**，上表每一类都是实跑结果，不是读代码推的 | `[已核]` + `[已实测]` | 逐值判，不是形状判 ⇒ **一个值为 `undefined` 的自有可枚举属性就足以让整个工具被拒收** |
| V4 | **同一条规则也管工具入参**，只是错误类不同 | `dsh-tools/lib/index.js`，失败报 `tool arguments must be lossless JSON` | `[已核]` | 同一份「无损」的纪律，两头都要守 |
| V5 | **本机已被它咬过**（2026-10-13 真机回归） | `data.audit.startupLogs.reports[0].report.messages[2].text` 是个**值为 `undefined` 的自有可枚举属性**（`src/lib/startup-log.ts` 的 `firstArgText` 只认单引号，双引号 args 返回 `undefined`）⇒ 宿主抛 `ToolOutputError('dsh_diagnose_plugin_load', ['value is not lossless JSON'])`，**该工具完全不可用** | `[已实测]` | 防线是**投影边界重投影 + 返回前守卫**；本仓的红线是 **B26**（见 [SHAPE.md](SHAPE.md) §10） |
| V6 | **B26 已对齐本表**（对齐过程本身留下了记录） | 用同一批样本分别跑 `isJsonValue` 与 B26 的往返判据（`redlines.test.ts` 的 `judgeLosslessRoundTrip`），**逐条一致**：含不可枚举自有属性、`-0`、`NaN`/`±Infinity`、循环、稀疏数组、子类数组、数组带额外 own key。<br>**对齐前有两处差，方向相反**，都已修：① **假绿** —— 不可枚举自有属性**宿主拒、B26 绿**（`isDeepStrictEqual` 不比不可枚举键）→ 现在先单独走一遍 `getOwnPropertyNames` + `enumerable`（数组的 `length` 与下标豁免）；② **假红** —— **null 原型对象宿主接受**、B26 判红（往返后原型不再是 `null`）→ 现在比之前先把两侧原型归一。**两条各自有下界断言钉住**（拆掉任一条判据，B26 立刻红） | `[已实测]` | 「B26 绿」现在**可以**当「宿主会收」用，但只对**本表列出的类别**成立 —— 表外的新类别仍要先把样本喂给 `isJsonValue` 实测，别读源码推 |

**未做（如实记）**：宿主对 **getter 抛错**走的是另一条路（`dsh-tools/lib/index.js` 的 `safelyIsJsonValue` / `losslessValueViolation`）—— 我们的红线没覆盖这一类。

**本节 V3 / V6 是逐条跑出来的**：探针直接 import 宿主自己的 `isJsonValue`，对本节列出的每一类各喂一个样本。
**第一版草稿是靠读源码推的，被这次实跑证伪了两处** ——「null 原型对象被拒」与「子类数组 / 稀疏数组是 B26 的盲区」两条都不成立，已按实测改写。
（这两处如果留着，会让下一个人照着一条**错的**边界去收紧投影面。）

---

## 1. 热重载依赖的契约

已实现并真机验证（`dsh_hot_reload`）；下面这几条是它**承重**的部分。

| # | 事实 | 证据（文件 + 检索串） | 分级 | 影响 |
|---|---|---|---|---|
| C1 | **`loader.internal` 在本机默认拿得到，不需要任何开关** | `cordis-plugin-loader` 的 `src/index.ts`（`internal` 是公开字段）；`internal.ts` 里「`--expose-internals` **或** `require('node-addon-require-builtin').requireBuiltin(id)`」；本机该 addon（`0.1.9`）与平台原生件都装着；宿主命令行**不含** `--expose-internals` 却正常运行 | `[已实测]` | 清模块缓存**无前置门** |
| C2 | ⚠️ **`internal.loadCache` 是 Map 形状但 `instanceof Map === false`** | `[object Map]`、`constructor.name = LoadCache`、`isMap: false`（Node 内部 loader 在**另一个 realm**） | `[已实测]` | 判据用鸭子类型，**别用 `instanceof`** |
| C3 | ⚠️ **别用 Node 版本或 arity 判 v1/v2 形状** | `internal.ts` 的源码注释明确警告：`24.0–24.11.1` 会被大版本判据错标，且 `resolveSync` 两种形状 arity **都是 2**；**v2 的 `resolveSync(parentURL, request)` 参数顺序与 v1 相反** | `[已核]` | 按 API 形状判，别按版本 |

**真机实验：热重载的三条判据全过**（同一实例、全程未重启；观察面是 bench 插件注册的工具，用 `entry.fiber.state` 与 `apply-log` 交叉作证）：

| 判据 | 结果 | 分级 | 关键证据 |
|---|---|---|---|
| **成功（基准）** | 过 | `[已实测]` | `control-changed` → 新 `apply-start` → 约 6 秒后读到 `v1 → v2`；步骤 `cache-get(found) → cache-delete → reimport(ok) → snapshot-old(state=2) → dispose-old(1) → created-new(1) → await-new` |
| **import 期失败** | 过 | `[已实测]` | `reimport ok=false` → `rollback-caches restored=1`；**步骤里根本没有 `dispose-old`**；此后 `fiberState=2`、工具仍返回 `v2` ⇒ **「先 import、后 dispose」正是旧 fiber 没被碰过的原因** |
| **apply 期失败**（async + sync 各一次） | 过 | `[已实测]` | 两次都 `dispose-old → created-new → swap-failed → rollback-remove-new(removed=true) → rollback-replugin(1) → rollback-caches(1)`；`fiberState=2`、工具仍返回 `v2` |

**最强证据**：`apply-log` 里坏版本之后**紧跟着旧版本的一整轮 `apply-start` + `tool-registered`** —— 坏版本在注册前就抛了，工具却照旧可用，只有「旧版本被**真的**重新实例化」解释得通。

### 1.1 写实现会踩的四条

| # | 事实 | 分级 | 影响 |
|---|---|---|---|
| T1 | `loader.internal` 拿得到，但 **`loadCache` 的 ctor 是 `LoadCache`、`instanceof Map === false`**（原型链 `[LoadCache, SafeMap]`，有 `get/set/has/delete`） | `[已实测]` | **别假设它是 Map**：参考实现那手 `Map.prototype.delete.call` 在本机未必成立；用**对象自己的 `delete`** |
| T2 | `internal.resolveSync(name, baseUrl)` 对 **URL 形式的 name** 失败（报 `Cannot find package 'undefined'`） | `[已实测]` | 回落 `new URL(name, baseUrl)` |
| T3 | **`ctx.get('tools')` 在 `apply` 期是 `undefined`**，必须走 `inject`；且回调约 **419ms** 后才到 | `[已实测]` | 观察面在 apply 返回之后才可用 —— 测时序必须留这段（探针第一版就因此读不到工具） |
| T4 | **`tools.register` 的 `output` 是两层**：`{type:'json'}` → 「must declare output {schema, render}」；`{schema:{type:'json'}}` → 「schema.type must be one of object/array/…」；**要 `{schema:{type:'object'}}`** | `[已实测]` | `{type:'json'}` 是 `defineTool` 的**作者层**字面量；直接调运行期 `register` 时不是这个形状（本仓走 `defineTool` 不受影响，但极易误导） |

**entry 匹配的两条**（`dsh_hot_reload` 的定位键）`[已实测]`：`entry.id` 实际是 **`include:<id>`**（`overlay.yml` 里声明的 `reloadable-bench` 只是后缀）；`entry.options.name` 是 **`file://` URL**。
→ **两个字段都要试 + URL 归一**：探针第一版只比 `entry.id`，`entryFound` **永远是 false**（**假阴性**，看着像「树里没有这个 entry」）。
另：**`runtimeFibers` 是 `DisposableList` 不是数组**；换 fiber 前后形状与长度都没变（2 秒采样看不到中间态，故「中间态时长」答不了）。

**`loader.entries()` 在真机上的形状是「可迭代对象」**（`Array.isArray()=false`、`hasIterator=true`）`[已实测]` → **按 `Symbol.iterator` 取**才对两种形状都成立（见 [AGENTS.md](../AGENTS.md) 活跃坑 20）。

**未做（如实记）**：回滚**本身**失败的分支；并发重载；group / MCP entry；中间态时长。

---

## 2. 拉起与恢复的契约

### 2.1 detached 拉起与树杀（真机实验B + 补测）

| # | 结论 | 证据 | 分级 | 对设计的影响 |
|---|---|---|---|---|
| B1 | **detached helper 活过父进程退出** | 父 pid 35748 于 `05:34:00.492` exit，helper(38172) `05:34:06.52` 写出标记，标记里 `ppid=35748` 是**已死的父** | `[已实测]` | 「父自己退」这条路成立 |
| B2 | **对照组（去掉 `detached`）3/3 都没写出标记** | 其余完全相同 | `[已实测]` | 证明 B1 不是必然成功 |
| B3 | **`node -e` 的引号问题是误解，真正的杀手是 shell** | A `spawn(exe,['-e',code])` 无 shell → exit 0、标记有、三种引号**全活**；B 命令串+`shell:true` → exit 0、**标记无**、stderr 空（**静默假成功**）；C `spawn(...,{shell:true})` → exit 1 `DEP0190`；D 临时 `.cjs` → 与 A 逐字相同 | `[已实测]` | 保留 `.cjs`，但**理由写成「避免过 shell」**；B 那种「exit 0 + 空 stderr」是新坑候选 |
| B4 | **等端口释放可行** | 端口 18411：`waitedMs=2032`、`tries=10`；父 `close` 后 **64ms** 写出标记，**未撞 TIME_WAIT** | `[已实测]` | 「等端口释放」这一环照抄即可 |
| B5 | **helper 再拉新进程那一环通了** | helper 的 `grandSpawnedPid=35376`，**孙进程标记出现**，其 `ppid` 正是 helper | `[已实测]` | 完整链（父退 → helper → 新进程）实测可通 |
| B6 | **父被 `/F` 强杀（不带 `/T`）时 detached helper 仍存活** | 父存活中被 `taskkill /PID /F` → helper 完成工作；非 detached 的没有 | `[已实测]` | helper **不依赖旧进程善终** |
| B7 | ⚠️ **`taskkill /PID <A> /T /F` 会连 detached helper 一起杀** | `taskkill` 原文点名「PID 37480 (child process of PID 4916) has been terminated」，helper **未写出标记**；对照基准（A 自己 exit）写出了 | `[已实测]` | **单级 detached 覆盖不了外部树杀** |
| B8 | **两级 detached 逃得掉 `/T`** | `A --detached--> H --detached--> G`，H 派完 G **立刻退出** → G 写出标记，`taskkill` 这次只提到 A | `[已实测]` | 若自建 helper，**必须两级**；机制是「`/T` 按**当时的活链**枚举，不是历史血缘」 |

### 2.2 Windows job object（按问题重排）

这一族本轮被独立复现改正过**三次**（见 2.2.6 的更正史）。**下面按问题分小节，不按修改顺序。**

#### 2.2.1 宿主在哪个 job（这一侧的句柄是验证过的）

| # | 事实 | 证据（文件 + 检索串 / 读数） | 分级 |
|---|---|---|---|
| J1 | ✅ **宿主确在 job object 里**，且那个 job 是 `KILL_ON_JOB_CLOSE` | `IsProcessInJob(host, NULL)=1`；**复制宿主持有的那个 job 句柄**读到 `LimitFlags=0x00003C00` —— `KILL_ON_JOB_CLOSE` / `SILENT_BREAKAWAY_OK` / `BREAKAWAY_OK` / `DIE_ON_UNHANDLED_EXCEPTION` **四位全开** | `[已实测]` |
| J2 | ✅ **对照有效**：`IsProcessInJob(explorer, 宿主job)=0`、`host=1`；宿主句柄表里**只有一个** job 句柄 | 同一轮的对照读数 | `[已实测]` |
| J3 | ⚠️ **「宿主的孩子不在那个 job 里」是错的**（原文曾这么写） | 按 `ParentProcessId=宿主` 取**真子进程**逐个查该 job：`node.exe`(imagegen-mcp) / `cli-proxy-api.exe` / `node.exe`(`dsh-subprocess-local/lib/runner.js`) **全部 = 1（在）**；= 0 的是**启动器 pwsh（它是父，不是子）**与持久终端 | `[已实测]` |
| J4 | ⚠️ **`ActiveProcesses` 会漂，不许当事实** | 连续读到 **6→5→4**，且**每次都与全系统枚举当时的值一致** ⇒ API 可信，单点采样不可用 | `[已实测]` |
| J5 | ⚠️ **「在 job 里」推不出「会被收掉」** | detached 孙进程在持有 `KILL_ON_JOB_CLOSE` job 的 runner 与当时那条 pwsh **都退出后仍存活并 LISTEN**；`dsh-subprocess-local/lib/runner.js` 的 `isJobEmpty` 分支只在 job **空**时关句柄，非空**不** `terminateJob` | `[已实测]` + `[已核]` |

**含义**：**在不在 job 里是按进程 / 按 spawn 路径的，不是「子进程」这个属性** ⇒ **不许推广**；判据必须落到具体那个进程。

#### 2.2.2 各类拉起方式的落点（同一张表回答「这条 spawn 路径会落在哪」）

| 拉起方式 | 落点读数 | 分级 | 备注 |
|---|---|---|---|
| `{detached:true}`（`DETACHED_PROCESS`） | **在** job 里（子进程 `inJob=1`） | `[已实测]` | 它只解决「不闪控制台」，**不是逃逸手段** |
| **本插件自己的 `src/lib/exec.ts` spawn** | **在宿主 job 里**：`--dump-config` 与 `--dump-config-schema` 两个子进程查宿主 job **都 = 1**（同轮对照 `explorer=0`） | `[已实测]` | ⇒ **`{detached:true}` 不能当逃生手段** |
| `Start-Process -WindowStyle Hidden`（参考实现的 Windows 路径） | 全程**无** breakaway 标志 | `[已核]` | 同样只解决「不闪控制台」 |
| **WMI `Win32_Process.Create`** | ⚠️ **不能判定** —— 有效读数只有 `inHostJob=0`、`inAnyJob=1`；**它在哪个 job 未知** | `[无法判定]` | **既不能说它是逃生手段，也不能说它不是**。边界：`rc=0` 假成功**本次未复现**；只在**受限令牌**上下文测过 |
| **[A] 计划任务 `schtasks`** | `/create` `/run` `/delete` 全 `exit=0`；**受限令牌下不需要提权**；被起进程 parent = **`svchost.exe`（Task Scheduler）**，`inHostJob=0`，其 `PING.EXE` 子进程同为 0 | `[已实测]` | **逃出宿主 job ✓**（首选） |
| **[B] `explorer.exe` 代起** | 真起了（查了进程，非只看 rc），`inHostJob=0` | `[已实测]` | ✓ |
| **[C] 在-job 的 PowerShell 中间进程 + `Add-Type` + `CreateProcess(0x01000000)`** | `Add-Type` 编译约 **346 ms**、**受限令牌下可用**；带 flag → **`OK`、无 `err=5`** | `[已实测]`（机制）/ `[受控复现]`（同 flags 自建 job） | 机制成立，成本高于 A/B |

⚠️ **边界（不许省）**：三条代起路线**都只对「宿主 job」验到 0**；**是否也在另一个 job 里未知**（`inAnyJob=1`，job 身份未知）—— **若那个 job 也带 `KILL_ON_JOB_CLOSE` 且持有者会死，风险仍在**，复现者明确说这条没测出来。
⚠️ **不许推广**：没能在**宿主进程内发起**任何一条（不能碰活宿主）⇒「从宿主 job 内发起会怎样」仍是**受控复现 + 语义**，不是直接实测；[C] 的复现用的也是**自建同 flags job**。

#### 2.2.3 `CREATE_BREAKAWAY_FROM_JOB` 的成因

| # | 事实 | 证据 | 分级 |
|---|---|---|---|
| J6 | **规则：调用者所在 job 缺 `0x800` ⇒ `err=5`；有 `0x800` ⇒ 成功** | 自建**与宿主逐位相同**的 job（`flags=0x00003C00`）、把 helper `AssignProcessToJobObject` 进去（**先验 `InJob=1`**），在 helper 内建子进程：`0x2000` 内不带 flag → OK（对照有效，孩子在 job）；`0x2000` 内带 `0x01000000` → **FAILED `err=5`**；自建 `0x3C00` 内不带 flag → OK 且**不在** job；自建 `0x3C00` 内带 `0x01000000` → **OK（无 err）** | `[受控复现]` |
| J7 | ⚠️ **该复现里有信息量的是「没有 `err=5`」**，不是成员判定（那两个孩子都在 job 外） | 同上 | `[受控复现]` |
| J8 | ⚠️ **Node 的 `child_process.spawn` 无法传创建标志**（`detached:true` 只加 `DETACHED_PROCESS`；本仓 `src/lib/exec.ts` 就是原生 `spawn`）；宿主树里**没有** `child_process` 补丁 | 源码 + 本仓 `src/lib/exec.ts` | `[已核]` |
| J9 | ⚠️ **原生绑定从本仓解析不到**：`@deepseek-ai/dsh-win32-process` 与 `koffi` **都 `ERR_MODULE_NOT_FOUND`**（只存在于宿主安装树；profile 与插件自己的 `node_modules` 都没有） | 从本仓解析上下文实测 import | `[已实测]` |

#### 2.2.4 通用语义：`NULL` 句柄（可复用，不只是一次事故）

| # | 事实 | 证据 | 分级 |
|---|---|---|---|
| J10 | ⚠️ **`QueryInformationJobObject(NULL, …)` 问的是「调用者自己的 job」**；**`IsProcessInJob(x, NULL)` 问的是「任意 job」** | 复现者自纠：`FindJob(pid)` 在**该 pid 不持有 job 句柄**时返回 `IntPtr.Zero`，于是 `IsProcessInJob(x, NULL)` 被当成了「x 在那个 job 里」，**静默降级成 `inAnyJob`** | `[已实测]` |
| J11 | ⚠️ **是它自己的对照组抓到的**：`explorer` 也读出 `inRunnerJob=1`，而那不可能 | 同上 | `[已实测]` |
| J12 | ⇒ **拿 `NULL` 当「目标进程的 job」会静默读成「任意 job」** | 由上两条直接得出 | `[已实测]` |
| J13 | ⚠️ **因此原「持有者是沙箱 runner、`0x2000`」这一断言已撤回 / 降级** | **站得住的部分**：工具调用那条 pwsh `inHostJob=0` 而 `inAnyJob=1` ⇒ **「宿主 job 之外还有一个 job」这件事成立**（`task-8` 的 `err=5` 也正由它解释）。**撤回的部分**：那个 job **是谁、谁持有、哪些进程在里面**都没验证 —— 原判据用了 `NULL` 句柄（J10），且 `0x2000` 那个值本身也来自 `QueryInformationJobObject(NULL,…)`（= 调用者自己的 job） | `[无法判定]`（持有者身份与原读数无效）；**「另有一个 job」本身** `[已实测]` |
| J14 | ⚠️ **判据要求**：报 job 成员身份**必须持有那个 job 的句柄**，否则只能报 `inAnyJob` 并**标明它不是 job 专属** | 由 J10–J12 得出 | `[已实测]` |

#### 2.2.5 仍无法解释的冲突（照实记，**不编机制**）

| # | 事实 | 分级 |
|---|---|---|
| J15 | ⚠️ **`exec.ts` 的孩子进了 `0x3C00` 宿主 job**（J3/2.2.2 实测），而 J6 的受控复现说「`0x3C00` 成员**不带 flag** 创建的孩子**应当脱离**」—— 两者冲突，**复现者明确表示无法解释** | `[无法判定]` |

**⇒ 待插件内实测钉死；在此之前不许拿任一边当结论。**

#### 2.2.6 宿主 runner 的守卫 + 本节更正史

- **宿主 runner 的守卫行为**：复现者触发过一次 `subprocess-local: Windows Job runner exited … before proving its managed range empty`，原因是**调用结束时还有子进程留在 runner 的 job 里** ⇒ **runner 退出前要求其 job 范围被证明为空；留下成员会触发该守卫** `[已实测]`（与 `dsh-subprocess-local/lib/runner.js` 的 `isJobEmpty` 分支同族）。

**本节被独立复现改正过三次（保留可追溯）**：

1. **第一次（task-14）**：原文把「宿主的孩子不在 job 里」写成结论 —— 错因是**样本偏差**（只查了「启动器 pwsh + 两个终端」，它们**恰好**不在 job 里）。**删掉的**：`ActiveProcesses=3` · 「必须用持久终端才能读 job」（后者已由复现者证伪：沙箱 runner 里整套探针也能跑通，我当初读到的 `err=87` **不可复现**，**两条路都能读**）。
2. **第二次（task-18）**：**把 `err=5` 归因于「宿主 job 缺 `0x800`」—— 归因对象搞错**（当时站的是一个 `0x2000` 的 job）。宿主 job 其实**有** `0x800`。
3. **第三次（task-21，性质不同：不是结论错，是读数本身无效）**：**「runner job」读数已撤回**（J10–J13）；**WMI 从「没脱离」改判为「不能判定」**（2.2.2）；**宿主 job 那一侧的句柄是验证过的（J1/J2）⇒ 关于宿主 job 的结论不撤**。

**探针怎么读（供复验用）**：上面两条路（沙箱 runner 内 / 持久终端内）**都不需要**改 `src/` + `hot_reload`；但**插件侧 `import` 那两个原生包不行**（J9）。

#### 2.2.7 仍测不了 / 待实测

- Windows **服务化**部署下 job 的归属与服务侧 `KILL_ON_JOB_CLOSE` 行为 —— 会误伤维护者在用的进程 ⇒ **本机不做**。
- 按名杀（`taskkill /IM`）—— 同上。
- **helper 的长期存活**：三条代起路线**是否也在另一个 job 里未测**（`inAnyJob=1`）⇒ **仍需在插件内真机实测钉死**。

### 2.3 忙判定与唤醒通道

| # | 事实 | 证据（文件 + 检索串） | 分级 | 影响 |
|---|---|---|---|---|
| C4 | **`sessionController.resolveAgent(sessionId)` = resolve **或** resume、并发去重、按会话原预设、不抛** | `dsh-api-session-controller`（`super(ctx,'sessionController',{namespace:'session'})`）；返回 `{agent} \| {error}`，不存在 → `session/not-found` | `[已核]` | 恢复通道成立；**要按 `{error}` 分支判失败**，不要靠 try/catch |
| C5 | **`agents.get(id)` 只查 live、不 resume；`followup(message)` 不返回 Promise** | `dsh-agent/lib/index.js`、`dsh-agent-loop/lib/index.js` | `[已核]` | 顺序不能反：**先 `resolveAgent` 再 `get`** |
| C6 | ⚠️ **`jobs` 服务在，但 `dsh-jobs` 只是抽象 seam** | `dsh-jobs/lib/index.js` 原文 `throw new Error("…is the abstract job registry seam; load an implementation such as @deepseek-ai/dsh-jobs-local instead")`；本机实现是 `dsh-jobs-local`；`list(caller)` 收 **owner id** | `[已核]` | 忙判定可照抄，但**必须确认实现包在场**、并过滤 `status ∈ {running, stopping}` |
| C7 | **`workspace/session-activity` 是 waterfall；`dsh-schedule` 用的正是 `kind:'schedule'`** | `dsh-schedule/lib/index.js` | `[已核]` | 「已武装定时提醒」判据成立；⚠️ **必须 `await next()` 并把自己那段拼回**，否则短路后续应答者 |
| C8 | **`appendPluginRecord(session, type, data)` 存在；前缀正则与强制 `ignorable: true` 逐字命中** | `dsh-session` 导出表、`PLUGIN_RECORD_TYPE` 正则、`ignorable` 落值处 | `[已核]` | 与活跃坑 4 一致：真要写会话记录就走它（详见 2.5） |

**忙判定的语义**（借自参考实现，语义层）：**只把「调用方自己那个会话」从 running / 排队里排除；后台任务与定时提醒照旧全算**（含调用方自己的）。且它 **fail-closed**：服务不可用 → `{known:false, idle:false}` = 拒绝。

**会话 id 归一化**：运行期键是 `session-<uuid>`，调用方常传裸 uuid → 统一补前缀；非法则空串（据此判失败）。

**唤醒要延迟 + 重试**：参考实现注释自述「启动后 3 秒去唤醒，`agents.get()` 还取不到 agent（会话尚未就绪）」，配置 `wakeDelayMs` 默认 3000 —— **这是踩出来的，不是理论要求**。

### 2.4 恢复与投递的前提

| # | 事实 | 证据（文件 + 检索串） | 分级 | 影响 |
|---|---|---|---|---|
| C9 | ⚠️ **Web profile 没有 `--resume`**：`dsh-web-app` / `dsh-web` 的 `lib/index.js` 里 `resume` **0 命中**；`dsh/lib/bin.js` 只在帮助里写 `dsh tui --resume <session>` | 逐包 grep `resume` | `[已核]` | **「把 sessionIds 拼进 launchCommand」是死路** —— 重启后没有任何 CLI 入口告诉新进程「恢复哪些会话」 |
| C10 | **resume 的真触发者是客户端**：进程内入口是 `ctx.agents.resume({resumeSessionId})`（`dsh-agent` 的 types、`dsh-headless` 在用）；但两份参考实现**都只轮询** `ctx.agents.get(sessionId)` 等客户端重开（`dsh-restart` 500ms×120=60s；`dsh-smart-restart` 750ms/~15s） | 源码 + 参考实现源码 | `[已核]` | **marker 是「等哪些会话」的名单，不是「怎么把它们拉起来」**；「等不到」是**正常分支**，必须留 log，不能超时静默清 marker |
| C11 | ⚠️ **端口这环没有重试**：`this.server.once('error', reject)` 之后才 `listen(...)` —— 任何 bind 失败（`EADDRINUSE`）⇒ **boot 直接失败** | `dsh-host-webserver/lib/index.js` 的 `webServer.listen` 那段 | `[已核]` | **固定 sleep 必不够**：要**轮询到端口可 bind**，超时判失败并留 log。这条理由比「慢机」强 —— 它是宿主不重试，不是时间不够 |
| C12 | ⚠️ **`agent/session-start` 在本机不存在** | 全 `node_modules/@deepseek-ai/*` grep 该事件名 **0 命中** | `[已核]` | **不可照抄参考 README 的投递通道**；本机可用的是 `agent.followup(UserMessage)`（`dsh-agent` 的 runtime types），source `form:'notice'`（`dsh-llm` 的 message types），宿主自己就这么投（`dsh-agent/lib/index.js` 的 `modelSwitchNotice`） |
| C13 | **notice「太早投不到」**：`agents.get()` 只查 live（C5），客户端没重开就没有 agent | C5 + `dsh-agent/lib/index.js` | `[已核]` | 投递必须**轮询等待**；`dsh-restart` 的 60s 超时后**清 marker** ⇒ 清了就永久不恢复 |
| C14 | ⚠️ **重启耗时只有下界，别当等待时长用**：启动器 pwsh 创建 → 新宿主 node 创建 ≈ **6.0 s**（`Win32_Process.CreationDate`）；**「端口可服务」那一刻没抓到** | 真机观察一次真实重启 | `[已实测]` | 6 s 是「启动器 → node 进程存在」的下界，**不是** helper 该等的时间；冷/热区间仍未测（要新起实例采样） |

#### 2.4.1 冷会话的「自动激活」：`resolveAgent` 在没有客户端时**真的会 resume**（实测）

**结论：会。** 在一个**新起的宿主进程**里、**没有任何客户端**（没开浏览器、没有任何 HTTP 调用）的情况下，`ctx.sessionController.resolveAgent(sessionId)` 会把一个**只有持久化日志、本进程尚未 attach** 的会话**真正拉起来**并返回 `{agent}`；紧接着 `agent.followup(...)` 能**立刻**投出 notice 并唤醒一个真实 turn。
⇒ **这就是 `dsh_restart` 恢复半的「自动激活」通道**：新进程读 marker → 对名单里的每个会话调 `resolveAgent` → 成功就 `followup` 投 notice。**不需要人重开浏览器。**
⚠️ **但不会自己回来**（C24）：没有任何东西在启动时自动激活会话 —— **不显式调 `resolveAgent`，会话就一直是冷的**。

**实测环境**：隔离台（独立 `DSH_HOME` + 空闲端口 + junction，配方见 [test/integration/README.md](../test/integration/README.md) §0）；宿主 = 本机安装树那一份（见本文开头的版本锚点），`node v24.18.0`。探针是一个插进隔离 profile 的**插件**（走 `--patch`），因此它调用 `resolveAgent` 的上下文与 `dsh_restart` 恢复半**同一层**。会话由探针走 `sessionController.create` 造出（**那是 Web 客户端走的同一个宿主 API**，不是真浏览器 —— 见本节末尾的限度）。

| # | 事实 | 证据（文件 + 检索串 / 实测读数） | 分级 | 影响 |
|---|---|---|---|---|
| C15 | **`resolveAgent` 对冷会话真的 resume**（不是只查 live） | 新进程 B 里：`before` 读数 `targetLive=false`、`otherLive=false`、`attachedSession=false`，而 `sessionPersistence.stat` 得 `found=true` / `formatStatus="current"`；随后 `resolveAgent(<真 id>)` → `hasError=false`、`hasAgent=true`、`agentId===target`、`status="idle"`，耗时 **62–85 ms** | `[已实测]` | 「无客户端时能不能拉起来」= **能** |
| C16 | ⚠️ **负对照有效**：不存在的 id ⇒ `session/not-found`，从不「成功」 | 同一进程、同一调用面：`resolveAgent('session-<random-uuid>')` → `{error}`、`name=RemoteError`、`code=session/not-found`、`hasAgent=false`，耗时 **3–4 ms** | `[已实测]` | 判据不恒真；失败要按 `{error}` 分支判（同 C4） |
| C17 | **不碰别的会话**（逐个唤醒是安全的） | 同一 `DSH_HOME` 下两个冷会话：只 resolve 其中一个后，另一个 `ctx.agents.get(...)` 仍是 `undefined`；两次单独 resolve 各自成功 | `[已实测]` | 按 marker 名单逐个 `resolveAgent` 不会把别的会话一起带起来 |
| C18 | **会话按自己的原预设恢复** | 会话 A 建时 `agentPreset='standard'`、会话 B 建时 `agentPreset='ptc'`；重启后各自 resolve，`sessionProjections.snapshot(...).values.agentPreset` 分别读回 `"standard"` / `"ptc"` | `[已实测]` | 与 C4「按会话原预设」一致；恢复**不会**把预设换成当前默认 |
| C19 | **权限 / 沙箱 / 审批档也来自会话日志，不是新进程的默认** | 恢复后会话日志里 `permission/preset={preset:"workspace-write"}`、`sandbox/mode={mode:"workspace-write"}`、`approval/policy={policy:"ask"}`；`projections.values.permissions.currentValue="workspace-write"` | `[已实测]` | `dsh_restart` 的两道门（审批档 / 文件沙箱档）在恢复后的会话上**仍是它原来那一档** |
| C20 | **返回的 `{agent}` 可以立刻 `followup`**（无需等就绪窗口） | resolve 返回时 `status="idle"`；`agent.followup(notice)` **不抛**（29–33 ms），调用后立刻 `status="running"`；随后日志出现 `turn/start → step/start → user/message → request/header → assistant/attempt → step/end → turn/end`，`inbox.hasPending=false` | `[已实测]` | 「先 resolve 再 followup」这一串可以紧挨着做 |
| C21 | **notice 落成一条持久的 user-role 消息；`form:'notice'` 与插件自定义 `source.kind` 都被接受** | 逐帧解压 `$DSH_HOME/sessions/<projectKey>/<sessionId>/session.v4.jsonl.zstd`：`agent/inbox/spliced` 的 `inserted[0]` 与随后的 `user/message` 都带 `source={kind:"dsh-plugin-debugging", form:"notice", summary:"…"}` | `[已实测]` | 投递通道（C12）在**冷恢复**这条路上同样成立 |
| C22 | ⚠️ **`form:'notice'` 人看不看得见，取决于 `summary`**：客户端把 `summary` 放在**折叠行**上；`summary` 缺失或为空 ⇒ 退回 opaque | `dsh-client-ui-chat/lib/client.js` 的 `contextBody` 的 `case "notice"`（`noticeSummary` 为 null ⇒ opaque）与 `NoticeBody`；`CONTEXT_SUMMARY_MAX_CHARS = 120` | `[已核]` | notice **必须**带**非空** `summary`（≤120 字符），否则人看不见它是一行 notice |
| C23 | ⚠️ **`followup` 是「唤醒」，不是「显示」**：它会真的开一个 turn | 同 C20 的事件序列；隔离台没有 API key，该 turn 以 `turn/end.reason={kind:"error", error:{code:"MISSING_CREDENTIAL"}}` 结束 | `[已实测]` | 自动激活的代价 = 每个被唤醒的会话**跑一个真实 turn**（模型会被调用） |
| C24 | ⚠️ **不会自己回来**：启动后没有任何东西自动激活会话 | 进程起来后**等 5 秒**再观察：`targetLive=false`、`otherLive=false`、`attachedSession=false` —— 即使期间已经调过一次 `sessionController.list()`（客户端会调的那个面） | `[已实测]` | **恢复必须由我们显式调 `resolveAgent`**；不调就一直是冷的 |
| C25 | **对 `resolveAgent` 没有「就绪窗口」**：服务一可用就能 resolve | 探针在 `ctx.get('sessionController')` 第一次返回非 `undefined` 的那一刻就调 `resolveAgent`（apply 后 **151–157 ms**），多次运行**全部成功**、**没有一次需要重试** | `[已实测]` | 与 C13 的「3 秒取不到 agent」**不是一回事**：那是对 `agents.get`；`resolveAgent` 按需 resolve |
| C26 | ⚠️ **但 `sessionController` 在插件 `apply` 的第一刻取不到** | 同一探针在 apply 后的第一次 `ctx.get('sessionController')` 得到 `undefined`，要等到 **138–157 ms** 后才有（`-DelayMs 1500` 时读到 138 / 143 ms，服务那时早已在） | `[已实测]` | 启动期恢复**不能假设**服务已就绪：要**轮询等待**（或 inject），但**不需要** C13 那种秒级等待 |
| C27 | **副作用（小、幂等）：resume 会给日志追加一条 `session/end-seed`，且仅当末条不是它** | 实测：末条为 `turn/end` 时 **53→54 行**；末条已是 `session/end-seed` 时 **65→65 行**（进程**存活中**隔 8 秒两次计数相同 ⇒ 不是收尾期写的）。机制见 `dsh-session/lib/index.js` 的 `session/end-seed` 追加分支（条件含 `this.log.at(-1)?.type !== "session/end-seed"`） | `[已实测]` + `[已核]` | 反复重启**不会**让日志无限增长；只有「上次结束在 turn 之后」的恢复会 +1 行 |
| C28 | ✅ **闭环成立（端到端）**：新进程 + 旧会话日志 + 一份 `armed` 的 marker ⇒ 恢复半读 marker → `resolveAgent` → `followup` ⇒ **notice 真的落进那个会话的日志**，并且真的跑了一个 turn | 隔离实例：apply 时 marker `state="armed"`；**+3.0 s 采样（apply 后 3004 ms）仍读到 `armed`**，而 `trace` 里写下的 `consumed at` 是 apply 后 **2990 ms** ⇒ **判定已做出、那次写还没可见**；**+5.0 s 采样（5008 ms）已是 `consumed`**。逐帧解压该会话日志（**6 帧 / 20 行，只解第一帧得 1 行**）得 1 条 `user/message`，`source={kind:"dsh-plugin-debugging", form:"notice", summary:"host restarted at … - marker consumed"}`，正文含 `call dsh_check_effect_mode`；随后 `turn/start → … → turn/end` | `[已实测]` |
| C29 | ✅ **幂等：已消费的 marker 不会再投一次**（否则每次开机都给发起者重投 notice、白跑一个 turn） | 再起一个进程：marker 从 apply 起就是 `consumed`、全程不变；同一会话日志里 notice 条数**不变**（3 → 3），按本次 marker 的 `at` 精确匹配仍是 **1** 条 | `[已实测]` |
| C30 | ⚠️ **负对照有效：名单里有一个不存在的会话 ⇒ 整份 marker 保留 `armed`**（`trace` 里没有 `consumed` 行，+16 s 采样仍是 `armed`），**但已成功唤醒的那个会话照样收到 notice** ⇒ 「部分失败 ⇒ 整份保留、下次重投」在真机上成立 | marker 的 `sessions` = [真 id, `session-00000000-0000-4000-8000-000000000000`]：+1.5 / +3.0 / +5.0 / +8.0 / +12 / +16 s 六个采样点**全部** `armed`；同一会话日志里 notice 由 1 条增到 **2** 条 | `[已实测]` |
| C31 | ⚠️ **但那一次 notice 的 `summary` 与盘上状态不符**：marker 留在 `armed` 的同时，投出去的 notice `summary` 仍是 `host restarted at <at> - marker consumed` | C30 那一次的两个读数并列：marker 文件 `state:"armed"`（无 `consumed` trace 行）↔ 会话日志里那条 `user/message` 的 `source.summary` 以 `- marker consumed` 结尾 | `[已实测]` |
| C32 | ⚠️ **服务可用窗口与 C26 对不上（组合 / 行序相关，别混用）**：同一组合里 `fs` 在探针 apply 后 **2.2–2.5 s** 才可用、`sessionController` **2.4–2.8 s**；而 C26 记的是 **138–157 ms**。`include:dsh-plugin-debugging` 那一行的 `fiber.state` 变 `2`（active）也落在 **+2.5 s** 附近 —— 恢复半的 1 s 延迟是**从那一行 apply 起算**的，所以这两个数不能混着用 | 同一组合 3 次 observe 运行（探针每 25 ms 轮询 `ctx.get(...)`，并按 `Symbol.iterator` 读 `loader.entries()` 的 `fiber.state`） | `[已实测]`（读数）· **`[无法判定]`**（差异成因：C26 那次是另一套探针 / 另一个采样点，未插桩宿主的 apply 时刻） |

⚠️ **本节取代 §5「还没核过的」里那两条**（「重启后启动即唤醒」的时序、「按会话原有预设」的语义）—— 它们现在都已实测，见 C15–C32。

**未做 / 无法判定（如实记）**：

- **闭环是把「退出之后的状态」与恢复半串起来跑的，不是 `dsh_restart` 整条链**：marker 由探针**手工复现**（内容用本仓自己的 `buildRestartMarker` / `serializeMarker` / `restartMarkerPath`，落盘由探针写），**没有**经过工具壳的「四道闸 → 审批门 → 写 marker → 计划任务拉起 → `appExit`」那一段。⇒ 「真工具触发 → 恢复」**仍未串起来跑**；被复现的只是「新进程 + 旧会话日志 + armed marker」这个**恢复半的输入状态**（marker 的写入路径本身由 §2.6 / `restart-fs.ts` 单独实测）。
- **会话是探针用 `sessionController.create` 造的**（Web 客户端走的同一个宿主 API），**不是真浏览器建的** ⇒ 「真实客户端建的会话能否同样冷恢复」**没有单独实测**。但冷恢复读的只有持久化日志（`found=true` / `formatStatus="current"`），路径同一条；本次 C28 的 notice 也确实落进了它。
- **Web UI 里的确切样子**：没有开浏览器 ⇒ 只能给 `[已核]`（客户端源码把 `notice` 渲染成带 `summary` 的 context 行），**不是** `[已实测]`。
- **有 API key 时那个被唤醒的 turn 会怎样**（notice 被模型消费后还留不留痕）：隔离台没有凭据 ⇒ **`[无法判定]`**。
- **日志读法本身踩过一个坑**（供复验者用）：`session.v4.jsonl.zstd` 是**多帧 zstd**（C15–C27 那轮实测 `magicCount=14`），而 `zlib.zstdDecompressSync` **只解第一帧**、`createZstdDecompress` 流式读在这里**也只吐出第一帧** ⇒ 会得出「日志里只有一个 session 头、没有事件」的**错结论**。正解是**自己按魔数 `28 b5 2f fd` 切帧逐帧解**（C15–C27 那轮 14 帧全解出、42 行事件；本轮闭环复验再测一次：同一份日志**只解第一帧得 1 行、逐帧解得 6 行 / 10 行**，见 C28 / C29）。**切帧要校验每一帧都解得开**（切错会抛，不会静默变短）。
  ⚠️ **同一族的第二个坑**：事件里的消息字段在 `event.data` 下（`user/message` 的 `dataKeys` = `id` / `role` / `content` / `source`），**不在 `event.message` 下**；只读后者会把 `noticeCount` 读成 **0**（本轮第一版提取器就是这样，**差点据此得出「notice 没落地」的反结论** —— 与坑 18 同族）。

### 2.5 marker 的落盘通道（两条并列记；**落点选择不是本文的事**）

#### 通道①：会话日志（`appendPluginRecord`）是**合法的持久通道**

`SHAPE §6.1` 曾以坑 4（自定义事件写坏日志）为由拒绝会话日志。**核下来那条理由已有官方解法**：

| # | 事实 | 证据（文件 + 检索串） | 分级 |
|---|---|---|---|
| D1 | **写入侧 `appendPluginRecord(session, type, data)` 是 `dsh-session` 的公开导出** | `dsh-session/lib/index.js` 文末导出表含 `appendPluginRecord`、`pluginRecordOf` | `[已核]` |
| D2 | ⚠️ **它强制 `ignorable: true`，且这是读取侧放行的唯一条件** | 写入侧 `dsh-session/lib/index.js` 里 `ignorable: true`（**硬写**）；**读取侧** `dsh-session-persistence/lib/index.js`：`if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true) throw unsupported("… unknown to this harness and not marked ignorable; refusing to interpret the log …")` | `[已核]` |
| D3 | ⇒ **坑 4 的「整份日志被拒绝解释」对 `appendPluginRecord` 写出的记录不成立** —— 未知类型只要 `ignorable===true` 就被**保留并跳过** | 由 D2 直接得出 | `[已核]` |
| D4 | **有读回接口**：`pluginRecordOf(event)` → `{type, seq, time, data}`（要求 `ignorable===true` 且类型合文法） | `dsh-session/lib/index.js` 的 `pluginRecordOf`、`isPluginRecordType`、`PLUGIN_RECORD_TYPE` | `[已核]` |
| D5 | ⚠️ **约束**：`type` 必须合文法（`plugin:` 前缀 + 小写分段）；`data` 必须**无损 JSON**（否则抛）；**要拿到 session 对象** | `dsh-session/lib/index.js` 的 `#appendRecord` / `snapshotJsonValue` | `[已核]` |
| D6 | **重启后能找到它**：宿主有**列会话**的服务 | `dsh-session-query/lib/index.js` 的 `super(ctx, "sessionQuery")` / `listSessions`；底层 `sessions.list()` / `persistence.list(...)` | `[已核]` |
| D7 | ❌ **`spillStore` 不能当 marker 的住处**：它是**每进程的临时目录**，启动时还会被清理 | `dsh-spill-local/lib/index.js`：`mkdtempSync(join(tmpdir(), "dsh-spill-"))`（**进程私有**）+ 注释「**Startup cleanup mechanics**」+ 启动时清扫过期文件 | `[已核]` |
| D8 | ⚠️ **`presentationMeta` 与 `appendPluginRecord` 不是一回事** | `presentationMeta` 是 `defineTool` 的**输出呈现回调**（`dsh-tools/lib/index.js` 的 `options.output.presentationMeta`） | `[已核]` |

**通道①结论**：**有** —— 通道 = `appendPluginRecord(session, 'plugin:<包名>/restart-marker', data)`（落点：该会话的会话日志，由 `dsh-session-persistence-jsonl` 持久化）；**读回** = 启动后 `ctx.sessionQuery.listSessions()` 拿会话清单 → 读日志 → `pluginRecordOf(event)` 按类型取；**不写文件、不碰 `$DSH_HOME` ⇒ 不触发 B10**（写入走宿主服务）。

#### 通道②：独立文件

维护者已拍板 marker 落 **`$DSH_HOME/<包名>/restart/marker.json`** —— 那属于**我们的取舍**，**本文不重述**，见 [SHAPE.md](SHAPE.md) §6.1。

### 2.6 宿主退出通道：`appExit`（**存在，且 web 启动器真的提供它**）

**结论：有正式通道 —— `ctx.get('appExit')`。**

| # | 事实 | 证据（文件 + 检索串） | 分级 |
|---|---|---|---|
| E1 | **`AppExit` 是 `dsh-cmdline` 导出的文档化 Context 扩展**：`declare module '@deepseek-ai/cordis' { interface Context { appExit?: AppExit } }` —— 与 `cmdlineArgs` / `appReady` 并列，注释写明「provided by a launcher **before the tree mounts**」 | `dsh-cmdline/lib/types/index.d.ts` 的 `interface AppExit` / `declare module '@deepseek-ai/cordis'` | `[已核]` |
| E2 | **签名与语义**：`AppExit = (code: number) => void`，原话 **"Request exit once the tree has been disposed"** ⇒ **先 dispose 插件树、再退出**（这就是「优雅退出」，不是硬杀） | 同文件 `:33-39` | `[已核]` |
| E3 | **提供方是启动器**：`provideCmdline(ctx, host)` 里三行 —— `ctx.provide("cmdlineArgs", …)` / **`ctx.provide("appExit", host.exit)`** / `ctx.provide("appReady", …)` | `dsh-cmdline/lib/index.js` 的 `provideCmdline` | `[已核]` |
| E4 | **`dsh web` 这条路径真的提供它**（决定性）：profile 启动器在 boot 回调里调 `provideCmdline(hostCtx, { args, **exit: (code) => void shutdown.shutdown(code)**, ready })` | `dsh/lib/profile-boot-*.js` 的 `provideCmdline(` 调用点；`dsh/lib/bin.js` 的 `dsh web` / `runProfile` | `[已核]` |
| E5 | ⇒ **`exit` 不是空壳**：它接到启动器的 shutdown 控制器（`shutdown.shutdown(code)`） | 同上 | `[已核]` |
| E6 | **消费方范例 = `dsh-headless`**：`const exit = ctx.get("appExit")`；取不到就 **throw**「the launcher must provide ctx.appExit before the tree mounts」 | `dsh-headless/lib/index.js` 的 `ctx.get("appExit")` | `[已核]` |
| E7 | ⚠️ **我们不能照抄那个 throw**：本仓 `execute` 全路径不抛（B24）⇒ 取不到要**转成结构化失败** | 由 E6 + B24 得出 | `[已核]` |
| E8 | ⚠️ **另有一条 `exitOnStdinEnd(ctx, label)`**：把 stdio app 的寿命绑到 stdin EOF —— **不是我们的场景**（我们是 web） | `dsh-cmdline/lib/index.js` 的 `exitOnStdinEnd` | `[已核]` |
| E9 | ⚠️ **别直接 `process.exit`**：源码注释明确点出那条路「bypassing `ctx.appExit`」 | 同文件注释 | `[已核]` |
| E10 | ✅ **可达性已实测：本插件这一层在 `apply` 的**第一刻**就取得到** —— 与 `fs` / `sessionController` **相反**（那两个在 apply 期是 `undefined`，要等宿主把那一行挂上才有）。探针插件（`--patch` 插进隔离 profile，因此与 `dsh_restart` 的壳**同一层**）在 `apply` 内第一次采样（apply 后 **1–2 ms**）即得 `ctx.get('appExit')` → `typeof "function"`；`apply` / +200 / +500 / +1000 / +2000 / +3000 ms 六个采样点读数不变 | 隔离实例 4 次运行；读数见下方「§2.6 实测读数」 | `[已实测]` |
| E11 | ✅ **调用它真的干净退出，且顺序就是 E2 说的那条**：`exit(0)` → 探针自己的 `ctx.effect` disposer 被调用（树开始 dispose）→ Node `beforeExit`（事件循环**自然排空**）→ `process.exit` 事件，**退出码 0**、端口释放 | 三次仪器化运行：调用 → disposer **+102 / +112 / +114 ms**；disposer → `beforeExit` **+19 / +21 / +25 ms**；`beforeExit` → `process.exit` **0–1 ms** | `[已实测]` |
| E12 | ⚠️ **宿主给树 dispose 的上限是 5000 ms，超时就 `process.exit(code)`** —— 所以「等树 dispose 完再退」**有上限**，不是无条件 | `dsh/lib/profile-boot-*.js` 的 `PROCESS_SHUTDOWN_TIMEOUT_MS = 5e3` 与 `createProcessShutdown`（`timeout = setTimeout(() => forceExitOnce(code), timeoutMs)`；`forceExit` 默认就是 `process.exit`） | `[已核]` |
| E13 | ⚠️ **实测撞到过那道上限一次**：4 次运行里 **1 次**「调用 → 进程退出」= **5005 ms**（恰等于 E12 的上限），另外 3 次是 **122 / 134 / 139 ms**。那一次**没挂 `beforeExit` 探针** ⇒ 它走的是自然 drain 还是超时强制退出 **`[无法判定]`**（时序吻合，但**推断不是等级**，故不写成结论） | 同 E10 的探针日志（4 次运行） | `[已实测]`（读数）· **`[无法判定]`**（那一次的路径） |
| E14 | **负对照（同一次运行内，证明判据不恒真）**：① `ctx.get('e10-no-such-service')` → `undefined`（`ctx.get` 不是「问什么都给」）；② `ctx.appExit` **直接属性**同样可读，且 `ctx.get('appExit') === ctx.appExit`（`sameAsProperty=true`）—— 这正是 E1 那句「provided by a launcher **before the tree mounts**」的可观测后果 | ① ② 都是本轮探针读数；**与 `fs` 的分界**（`ctx.fs` 直取抛 `cannot get property "fs" without inject`）**是 `task-31` 的实测**（见 `src/lib/restart-fs.ts` 文件头），**本卡未复测** | `[已实测]`（① ②）· `[已实测]`（他轮，转引） |

**§2.6 实测读数（供复验用）**

- **哪一份宿主**：本机安装树那一份 `@deepseek-ai/dsh`（版本见本文开头的版本锚点，**现查**），`node v24.18.0`。
- **环境**：隔离实例（独立 `DSH_HOME` + 空闲端口 + junction，配方见 [test/integration/README.md](../test/integration/README.md) §0）。探针是一个**插件**（`--patch` 插入，`insert.name` 用绝对路径 ⇒ loader 转成 file URL），所以它的上下文与 `dsh_restart` **同一层**。**活宿主（3080）全程只查 pid、未发任何信号。**
- **可达性（E10）**：4 次运行 × 6 个采样点，`getType` **全部** `"function"`、`getDefined` **全部** `true`、`sameAsProperty` **全部** `true`。同一批采样里 `fs` 与 `sessionController` 在 apply 期都是 `undefined`（这就是对照面：`appExit` 不是「宿主服务晚到」那一类）。
- **干净退出（E11 / E13）**：4 次运行**全部** `exit code 0` + 端口已释放；其中 3 次「调用 → 进程退出」= **122 / 134 / 139 ms**（依次经过 disposer → `beforeExit` → `process.exit`），1 次 = **5005 ms**。
- **怎么读这些数**：`beforeExit` 只在事件循环**自然排空**时触发 ⇒ 「它出现过」= 走的是 E2 那条路；`5005 ms` 那一次**没有**这个探针，所以**不**把它写成结论。

**顺序保证（由 E2 直接得出，不是推断）**：`appExit` 的语义是「**等树 dispose 完**再退」⇒ **marker 的写必须在调用它之前 `await` 完成**；`ctx.fs.writeText` 返回 Promise，所以「写完了才退」= **先 await 写、再调 `appExit`**。**不许**先调 `appExit` 再写（树都拆了，写还在飞）。E11 实测的顺序与之一致（disposer 先跑、`beforeExit` 在后）。⚠️ **但别把它当「保证跑完所有异步收尾」**：E12 那 5 秒是硬上限，超了就强制退出。

---

## 3. 生态约定：`package.json` 的 `dsh.hotReload`

- **约定真实存在，且被第三方读取**：`dsh-hot-reload` 的 `lib/index.js`（注释 + `rec.json?.dsh?.hotReload === false` → 报 `stale` 并提示「restart dsh」）`[已核]`。
- ⚠️ **但本机运行时不读它**：在本机安装树里 grep `hotReload` **零命中** `[已核]`。
- → 它是**生态约定、不是宿主特性**：**「谁来读」必须由插件自己实现**，否则写了没人读 = 静默无效。

---

## 4. 这条台账从哪来

- **源码核实**：6 个参考仓 clone 到工作区的 `.local/refs/`（`git check-ignore` 确认 `/.local/` 被忽略 → **不在任何项目里**，用完可删），只读源码；再逐条回到本机安装树 grep 核对 API 是否存在。
  → 按维护者 2026-10-13 的指定：参考源码**可以拉取，但不得进入任何项目仓**。
- **真机实测**：隔离实例（`test/integration/` 的 bench 配方）与活宿主上跑出来的进程 / 端口 / 日志 / 句柄记录。
  原始报告是**中转站的传递物**（按中转站自己的规则，传递物**不许被文档链接**）：结论已全部归位到本文与 [ARCHITECTURE.md](ARCHITECTURE.md)，原文打包归档在工作区里（git 忽略，不进历史）。
- **仍缺源码阅读**：`dsh-smart-restart`（`src/canary.ts` 与 `src/index.ts` 体量很大，含 canary 预检与 systemd 识别，与重启闸门相关）与 `dsh-hotswap` 托管区块的实现细节。
- **§0 那一批的证据形态不同（如实标注）**：核的是**安装树里发布的产物 JS**，不是参考仓的 `.ts` 源码 ——
  `…\@deepseek-ai\dsh\node_modules\@deepseek-ai\{dsh-tools,dsh-util-values}\lib\index.js`。
  后果：**行号只对锚点那一份安装成立**，换宿主版本必须重核。

---

## 5. 还没核过的（写在这里，别当成已知）

**本轮新产生的**：

- **「另一个 job」的身份**：三条代起路线都只对「宿主 job」验到 0，而 `inAnyJob=1` ⇒ 那个 job 是谁、有没有 `KILL_ON_JOB_CLOSE`、持有者会不会死，**全未测**（2.2.2 / 2.2.7）。
- **`plugin:` 记录的长度 / 频次限制**：`appendPluginRecord` 的读取侧放行已核（D2/D3），但**有没有长度或频次上限未核**。
- **按类型索引的读入口**：`sessionQuery.listSessions()` 能列会话，但**能不能按事件类型直接取**未核 ⇒ 若不能，就要逐会话读日志，代价随会话数增长。
- **`exec.ts` 孩子进 `0x3C00` job 与受控复现的冲突**（J15）—— **未解释**，待插件内实测钉死。
- **`dsh_restart` 的整条链仍未串起来跑**：恢复半的**输入状态**（新进程 + 旧会话日志 + 一份 `armed` marker）已实测闭环（C28–C32），但「工具壳：四道闸 → 审批门 → 写 marker → 计划任务拉起 → `appExit`」那一段与恢复半**没有在同一次真机上串过** —— 本轮 marker 是探针**手工复现**的。⇒ 「真工具触发 → 重启 → 恢复」**仍待实测**。
- **`appExit` 的 5 秒上限在真实重启里够不够**：E12/E13 只测到「调用后进程确实退出」；**dispose 慢过 5 s 时**那一次到底是谁收的尾、有没有丢收尾工作，**未测**（本轮 4 次里只有 1 次逼近该上限，且没有可分类的探针）。

**此前就留着的**：

- 插件技能在**真实 catalog** 里的合并结果与 `source` 显示值 —— 源码只给恒定 250 与分层规则，**必须起实例看**。
- `ctx.skills.register()` 的注册时机与 catalog 缓存失效是否正确配对（源码有实现，耦合读不出来）。
- 审批门在真实 UI/策略下的表现：⚠️ **`never` 档（= `danger-full-access`）下主动 `request()` 会被确定性拒绝**（`decide()` 的 `never` 分支），而 `ask` 档会弹窗 —— **「先读策略再决定问不问」这条在真机 UI 上还没跑过**。
- `schemastery` 两个版本间的行为差异（运行时比检出新一个预发布号）。
- **`UserMessage` 字段逐个**；**`job.status` 完整枚举**（「按会话原有预设」的语义已在 §2.4.1 C18 实测，不再列在此处）。
- **会话日志里 resume 的痕迹**：✅ **已解决** —— 原先「两种读法都只解出单个无换行 JSON、读不到事件流」是**读法错**：该文件是**多帧 zstd**，那两种读法都只解第一帧。按魔数切帧逐帧解即可读到完整事件流（方法与实测见 §2.4.1 末尾；冷恢复的事件序列见 C20/C21）。
