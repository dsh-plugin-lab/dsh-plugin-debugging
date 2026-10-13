# 宿主契约台账（已核事实）

**本文职责**：把「我们在宿主上**核过什么、怎么核的**」集中在这里 —— 每条事实都带真源（宿主源码 `文件:行`）或实测证据（进程 / 端口 / 日志 / 时间）。
**不负责**：我们自己的分层与设计取舍 → [ARCHITECTURE.md](ARCHITECTURE.md)；**插件最终形态与未做工具的方案** → [SHAPE.md](SHAPE.md)；在这里怎么干活 → [AGENTS.md](../AGENTS.md)。

**读者**：任何要调宿主 API 的人、任何要判断「这条结论还能不能信」的人。**改代码前先来这里查，不要凭推断。**

## 怎么读本文

| 标记 | 含义 |
|---|---|
| `[已核]` | 在**本机运行时**（`…\@deepseek-ai\dsh`，`0.2.1-alpha.2`）里 grep 到实证 —— **不是**参考实现的自述 |
| `[已实测]` | 真机跑出来的（隔离实例 / 真进程 / 真端口） |
| 无标记 | **不许当结论用**：要么是推断，要么已过期 |

**时效**：宿主换版本必须重核；**行号只对上面那个版本成立**。本机「在跑的宿主」与「源码检出」常常不是同一个版本 —— 引用前先确认哪一份。

---

## 1. 热重载依赖的契约

已实现并真机验证（`dsh_hot_reload`）；下面这几条是它**承重**的部分。

| # | 事实 | 证据 | 影响 |
|---|---|---|---|
| C1 | **`loader.internal` 在本机默认拿得到，不需要任何开关** | `cordis-plugin-loader/src/index.ts:85` 是公开字段；`internal.ts:108-118` 是「`--expose-internals` **或** `require('node-addon-require-builtin').requireBuiltin(id)`」；本机该 addon（`0.1.9`）与平台原生件都装着；宿主命令行**不含** `--expose-internals` 却正常运行 `[已实测]` | 清模块缓存**无前置门** |
| C2 | ⚠️ **`internal.loadCache` 是 Map 形状但 `instanceof Map === false`** | `[object Map]`、`constructor.name = LoadCache`、`isMap: false`（Node 内部 loader 在**另一个 realm**）`[已实测]` | 判据用鸭子类型，**别用 `instanceof`** |
| C3 | ⚠️ **别用 Node 版本或 arity 判 v1/v2 形状** | 源码 `internal.ts:87-97` 明确警告：`24.0–24.11.1` 会被大版本判据错标，且 `resolveSync` 两种形状 arity **都是 2**；**v2 的 `resolveSync(parentURL, request)` 参数顺序与 v1 相反** `[已核]` | 按 API 形状判，别按版本 |

**真机实验：热重载的三条判据全过**（同一实例、全程未重启；观察面是 bench 插件注册的工具，用 `entry.fiber.state` 与 `apply-log` 交叉作证）`[已实测]`：

| 判据 | 结果 | 关键证据 |
|---|---|---|
| **成功（基准）** | 过 | `control-changed` → 新 `apply-start` → 约 6 秒后读到 `v1 → v2`；步骤 `cache-get(found) → cache-delete → reimport(ok) → snapshot-old(state=2) → dispose-old(1) → created-new(1) → await-new` |
| **import 期失败** | 过 | `reimport ok=false` → `rollback-caches restored=1`；**步骤里根本没有 `dispose-old`**；此后 `fiberState=2`、工具仍返回 `v2` ⇒ **「先 import、后 dispose」正是旧 fiber 没被碰过的原因** |
| **apply 期失败**（async + sync 各一次） | 过 | 两次都 `dispose-old → created-new → swap-failed → rollback-remove-new(removed=true) → rollback-replugin(1) → rollback-caches(1)`；`fiberState=2`、工具仍返回 `v2` |

**最强证据**：`apply-log` 里坏版本之后**紧跟着旧版本的一整轮 `apply-start` + `tool-registered`** —— 坏版本在注册前就抛了，工具却照旧可用，只有「旧版本被**真的**重新实例化」解释得通。

### 1.1 写实现会踩的四条

| # | 事实 | 影响 |
|---|---|---|
| T1 | `loader.internal` 拿得到，但 **`loadCache` 的 ctor 是 `LoadCache`、`instanceof Map === false`**（原型链 `[LoadCache, SafeMap]`，有 `get/set/has/delete`，size≈807）`[已实测]` | **别假设它是 Map**：参考实现那手 `Map.prototype.delete.call` 在本机未必成立；用**对象自己的 `delete`** |
| T2 | `internal.resolveSync(name, baseUrl)` 对 **URL 形式的 name** 失败（报 `Cannot find package 'undefined'`）`[已实测]` | 回落 `new URL(name, baseUrl)` |
| T3 | **`ctx.get('tools')` 在 `apply` 期是 `undefined`**，必须走 `inject`；且回调约 **419ms** 后才到 `[已实测]` | 观察面在 apply 返回之后才可用 —— 测时序必须留这段（探针第一版就因此读不到工具） |
| T4 | **`tools.register` 的 `output` 是两层**：`{type:'json'}` → 「must declare output {schema, render}」；`{schema:{type:'json'}}` → 「schema.type must be one of object/array/…」；**要 `{schema:{type:'object'}}`** `[已实测]` | `{type:'json'}` 是 `defineTool` 的**作者层**字面量；直接调运行期 `register` 时不是这个形状（本仓走 `defineTool` 不受影响，但极易误导） |

**entry 匹配的两条**（`dsh_hot_reload` 的定位键）`[已实测]`：`entry.id` 实际是 **`include:<id>`**（`overlay.yml` 里声明的 `reloadable-bench` 只是后缀）；`entry.options.name` 是 **`file://` URL**。
→ **两个字段都要试 + URL 归一**：探针第一版只比 `entry.id`，`entryFound` **永远是 false**（**假阴性**，看着像「树里没有这个 entry」）。
另：**`runtimeFibers` 是 `DisposableList` 不是数组**；换 fiber 前后形状与长度都没变（2 秒采样看不到中间态，故「中间态时长」答不了）。

**`loader.entries()` 在真机上的形状是「可迭代对象」**（`Array.isArray()=false`、`hasIterator=true`、188 条）`[已实测]` → **按 `Symbol.iterator` 取**才对两种形状都成立（见 [AGENTS.md](../AGENTS.md) 活跃坑 20）。

**未做（如实记）**：回滚**本身**失败的分支；并发重载；group / MCP entry；中间态时长。

---

## 2. 拉起与恢复的契约（`dsh_restart` 尚未实现，这些是它的前提）

### 2.1 detached 拉起（真机实验B + 补测）

| # | 结论 | 证据 | 对设计的影响 |
|---|---|---|---|
| B1 | **detached helper 活过父进程退出** | 父 pid 35748 于 `05:34:00.492` exit，helper(38172) `05:34:06.52` 写出标记，标记里 `ppid=35748` 是**已死的父** `[已实测]` | 「父自己退」这条路成立 |
| B2 | **对照组（去掉 `detached`）3/3 都没写出标记** | 其余完全相同 `[已实测]` | 证明 B1 不是必然成功 |
| B3 | **`node -e` 的引号问题是误解，真正的杀手是 shell** | A `spawn(exe,['-e',code])` 无 shell → exit 0、标记有、三种引号**全活**；B 命令串+`shell:true` → exit 0、**标记无**、stderr 空（**静默假成功**）；C `spawn(...,{shell:true})` → exit 1 `DEP0190`；D 临时 `.cjs` → 与 A 逐字相同 `[已实测]` | 保留 `.cjs`，但**理由写成「避免过 shell」**；B 那种「exit 0 + 空 stderr」是新坑候选 |
| B4 | **等端口释放可行** | 端口 18411：`waitedMs=2032`、`tries=10`；父 `close` 后 **64ms** 写出标记，**未撞 TIME_WAIT** `[已实测]` | 「等端口释放」这一环照抄即可 |
| B5 | **helper 再拉新进程那一环通了** | helper 的 `grandSpawnedPid=35376`，**孙进程标记出现**，其 `ppid` 正是 helper `[已实测]` | 完整链（父退 → helper → 新进程）实测可通 |
| B6 | **父被 `/F` 强杀（不带 `/T`）时 detached helper 仍存活** | 父存活中被 `taskkill /PID /F` → helper 完成工作；非 detached 的没有 `[已实测]` | helper **不依赖旧进程善终** |
| B7 | ⚠️ **`taskkill /PID <A> /T /F` 会连 detached helper 一起杀** | `taskkill` 原文点名「PID 37480 (child process of PID 4916) has been terminated」，helper **未写出标记**；对照基准（A 自己 exit）写出了 `[已实测]` | **单级 detached 覆盖不了外部树杀** |
| B8 | **两级 detached 逃得掉 `/T`** | `A --detached--> H --detached--> G`，H 派完 G **立刻退出** → G 写出标记，`taskkill` 这次只提到 A `[已实测]` | 若自建 helper，**必须两级**；机制是「`/T` 按**当时的活链**枚举，不是历史血缘」 |
| B9 | ❌ **未测**：job object / Windows 服务 / `KILL_ON_JOB_CLOSE`；按名杀（`taskkill /IM`）；G 的长期存活 | — | **服务化部署可能两级也无效** → 优先交给外部管理器 |

### 2.2 忙判定与唤醒通道

| # | 事实 | 证据 | 影响 |
|---|---|---|---|
| C4 | **`sessionController.resolveAgent(sessionId)` = resolve **或** resume、并发去重、按会话原预设、不抛** | `dsh-api-session-controller`（`super(ctx,'sessionController',{namespace:'session'})`）；返回 `{agent} \| {error}`，不存在 → `session/not-found` `[已核]` | 恢复通道成立；**要按 `{error}` 分支判失败**，不要靠 try/catch |
| C5 | **`agents.get(id)` 只查 live、不 resume；`followup(message)` 不返回 Promise** | `dsh-agent/lib/index.js:594`、`dsh-agent-loop/lib/index.js:806` `[已核]` | 顺序不能反：**先 `resolveAgent` 再 `get`** |
| C6 | ⚠️ **`jobs` 服务在，但 `dsh-jobs` 只是抽象 seam** | `dsh-jobs/lib/index.js:117` 原文 `throw new Error("…is the abstract job registry seam; load an implementation such as @deepseek-ai/dsh-jobs-local instead")`；本机实现是 `dsh-jobs-local`；`list(caller)` 收 **owner id** `[已核]` | 忙判定可照抄，但**必须确认实现包在场**、并过滤 `status ∈ {running, stopping}` |
| C7 | **`workspace/session-activity` 是 waterfall；`dsh-schedule` 用的正是 `kind:'schedule'`** | `dsh-schedule/lib/index.js:2044,2049` `[已核]` | 「已武装定时提醒」判据成立；⚠️ **必须 `await next()` 并把自己那段拼回**，否则短路后续应答者 |
| C8 | **`appendPluginRecord(session, type, data)` 存在；前缀正则与强制 `ignorable: true` 逐字命中** | `dsh-session` 导出表 `lib/types/index.d.ts:117`；正则 `lib/index.js:1246`；`ignorable` 落值 `:1555` `[已核]` | 与活跃坑 4 一致：真要写会话记录就走它 |

**忙判定的语义**（借自参考实现，语义层）：**只把「调用方自己那个会话」从 running / 排队里排除；后台任务与定时提醒照旧全算**（含调用方自己的）。且它 **fail-closed**：服务不可用 → `{known:false, idle:false}` = 拒绝。

**会话 id 归一化**：运行期键是 `session-<uuid>`，调用方常传裸 uuid → 统一补前缀；非法则空串（据此判失败）。

**唤醒要延迟 + 重试**：参考实现注释自述「启动后 3 秒去唤醒，`agents.get()` 还取不到 agent（会话尚未就绪）」，配置 `wakeDelayMs` 默认 3000 —— **这是踩出来的，不是理论要求**。

**未核实（勿当结论）**：`UserMessage` 字段逐个；`job.status` 完整枚举；B9 那一整行；「按会话原有预设」的语义（参考实现自述如此，未在本机验）。

---

## 3. 生态约定：`package.json` 的 `dsh.hotReload`

- **约定真实存在，且被第三方读取**：`dsh-hot-reload` 的 `lib/index.js:15` 注释与 `:442-443` 的判断（`rec.json?.dsh?.hotReload === false` → 报 `stale` 并提示「restart dsh」）`[已读源码]`。
- ⚠️ **但本机运行时不读它**：在本机运行时（`0.2.1-alpha.2`）里 grep `hotReload` **零命中** `[已核]`。
- → 它是**生态约定、不是宿主特性**：**「谁来读」必须由插件自己实现**，否则写了没人读 = 静默无效。

---

## 4. 这条台账从哪来
- **源码核实**：6 个参考仓 clone 到工作区的 `.local/refs/`（`git check-ignore` 确认 `/.local/` 被忽略 → **不在任何项目里**，用完可删），只读源码；再逐条回到本机运行时 grep 核对 API 是否存在。
  → 按维护者 2026-10-13 的指定：参考源码**可以拉取，但不得进入任何项目仓**。
- **真机实测**：隔离实例（`test/integration/` 的 bench 配方）上跑出来的进程 / 端口 / 日志记录。
  原始报告是**中转站的传递物**（按中转站自己的规则，传递物**不许被文档链接**）：结论已全部归位到本文与 [ARCHITECTURE.md](ARCHITECTURE.md)，原文打包归档在工作区里（git 忽略，不进历史）。
- **仍缺源码阅读**：`dsh-smart-restart`（`src/canary.ts` 107KB / `src/index.ts` 75KB，含 canary 预检与 systemd 识别，与重启闸门相关）与 `dsh-hotswap` 托管区块的实现细节。

---

## 5. 还没核过的（写在这里，别当成已知）

- 插件技能在**真实 catalog** 里的合并结果与 `source` 显示值 —— 源码只给恒定 250 与分层规则，**必须起实例看**。
- `ctx.skills.register()` 的注册时机与 catalog 缓存失效是否正确配对（源码有实现，耦合读不出来）。
- 审批门在真实 UI/策略下的表现（`danger-full-access` 档下 `ask` 会被确定性拒绝）。
- `schemastery` 两个版本间的行为差异（运行时比检出新一个预发布号）。
- 「重启后启动即唤醒」的时序（参考实现实测「启动后 3 秒 `agents.get()` 还取不到」）—— 见 [SHAPE.md](SHAPE.md) §6.1。

