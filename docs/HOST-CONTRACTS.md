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
| E10 | ⚠️ **可达性未实测**：E4 证明启动器**提供了**，但**本插件（挂在 profile bundle 里）这一层能不能 `ctx.get` 到、以及在哪个生命周期点取得到**（apply 期？之后？）**未实测** | —— | **`[无法判定]`** |

**顺序保证（由 E2 直接得出，不是推断）**：`appExit` 的语义是「**等树 dispose 完**再退」⇒ **marker 的写必须在调用它之前 `await` 完成**；`ctx.fs.writeText` 返回 Promise，所以「写完了才退」= **先 await 写、再调 `appExit`**。**不许**先调 `appExit` 再写（树都拆了，写还在飞）。

⚠️ **E10 是 `task-30` 落壳前必须先钉的一条**（照 `task-31` 的做法：隔离实例 + 负对照），**别把它当已成立**。

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

**此前就留着的**：

- 插件技能在**真实 catalog** 里的合并结果与 `source` 显示值 —— 源码只给恒定 250 与分层规则，**必须起实例看**。
- `ctx.skills.register()` 的注册时机与 catalog 缓存失效是否正确配对（源码有实现，耦合读不出来）。
- 审批门在真实 UI/策略下的表现：⚠️ **`never` 档（= `danger-full-access`）下主动 `request()` 会被确定性拒绝**（`decide()` 的 `never` 分支），而 `ask` 档会弹窗 —— **「先读策略再决定问不问」这条在真机 UI 上还没跑过**。
- `schemastery` 两个版本间的行为差异（运行时比检出新一个预发布号）。
- 「重启后启动即唤醒」的时序（参考实现实测「启动后 3 秒 `agents.get()` 还取不到」）—— 见 [SHAPE.md](SHAPE.md) §6.1。
- **`UserMessage` 字段逐个**；**`job.status` 完整枚举**；**「按会话原有预设」的语义**（参考实现自述如此，未在本机验）。
- **会话日志里 resume 的痕迹**：`sessions/**/session.v4.jsonl.zstd` 用 `zlib.zstdDecompressSync` 与 `createZstdDecompress` 两种读法都只解出**单个无换行 JSON**，读不到事件流 ⇒ **无法判定**，未试第二形态。
