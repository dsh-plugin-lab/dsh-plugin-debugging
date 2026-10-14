/**
 * 超时纪律 —— 传输层必须**先于**工具层超时，且**预算只在这里定**。
 *
 * 为什么：宿主按 `timeoutMs` 给工具调用设死线（`@deepseek-ai/dsh-tool-call-timeout-policy`
 * 的 `tools/execute` 包装器）。如果传输层不先超时，宿主会先把它掐掉，
 * 模型拿到的是一枚**裸 TimeoutError**、没有 `kind`、没法判断能不能重试；
 * 反过来，传输层先超时就能返回结构化的 `{ ok:false, error:{ kind:'timeout' } }`。
 *
 * 所以每个外部 IO 的预算 = 工具预算 − 余量，且**余量必须为正**。
 *
 * 本文件的第二件职责是**预算本身**：工具只声明 {@link Workload}，
 * `{@link toolBudgetMs}` 是「工作量 + 配置 → 工具预算」的**唯一**映射点。
 * 工具侧不再碰配置里的毫秒数 —— 那是六个工具各抄一份全局数的老写法。
 */

/** 工具预算与传输预算之间的余量（毫秒）：留给本插件把结果结构化再返回。 */
export const TRANSPORT_MARGIN_MS = 2_000

/**
 * 传输预算的下限：预算被配得极小时，至少给 IO 一个可用的窗口。
 *
 * ⚠️ **它能生效的前提是「工具预算 ≥ 251」**（推导见 {@link MIN_TOOL_BUDGET_MS}）：
 * 这个下限是**往上抬**传输预算的，抬过头就会让传输预算**跑到工具预算之上**，
 * 于是「传输先于工具」被反过来。所以 `transportTimeoutMs` 里另有一道封顶。
 */
export const MIN_TRANSPORT_TIMEOUT_MS = 250

/**
 * 「完整余量」所需的最小工具预算（毫秒）—— **推导值，不是魔法数**。
 *
 * 传输预算 = 工具预算 − {@link TRANSPORT_MARGIN_MS}，而它另有下限
 * {@link MIN_TRANSPORT_TIMEOUT_MS}；两者相遇的位置就是这个数：
 * 工具预算低于它 ⇒ 传输预算被下限抬着，**余量不足** `TRANSPORT_MARGIN_MS`
 * （留给「把结果结构化再返回」的时间变薄，虽然「传输仍先于工具」还成立）。
 *
 * **它不是一个会被强加给用户的下限**：本仓不静默夹取用户的数（那样会让显式配置
 * 变成一句谎话，判据见 `test/tools/timeout-budgets.test.ts`）。它有两处用途：
 * ① 判据拿它钉边界；② 若将来要在配置面加 `.min()`，这就是那个数的**来源**
 * （届时必须先确认宿主对 config schema 拒绝的呈现方式，见 `src/config.ts` 的注释）。
 *
 * 「传输 < 工具」这条不变量本身的门槛更低（`MIN_TRANSPORT_TIMEOUT_MS + 1`），
 * 而它现在对**任何正预算**都成立 —— 那是 `transportTimeoutMs` 封顶的保证。
 */
export const MIN_TOOL_BUDGET_MS = MIN_TRANSPORT_TIMEOUT_MS + TRANSPORT_MARGIN_MS

/**
 * **单次回环探测的独立上限**（`dsh_list_instances` 用）。
 *
 * 为什么它必须**独立**、而不是像别的 IO 那样拿「剩余总预算」：本机实测（2026-10-14）
 * 37 个回环监听端口里有 **9 个「接受连接但永不回话」**（1042 / 8588 / 8590 / 9012 /
 * 14013 / 14016 / 14019 / 14022 / 14023）。给剩余总预算的话，**第一个这样的端口就把
 * 整次调用吃光** —— 真机上观察到的就是 `dsh_list_instances` 整体超时 15 s。
 *
 * 取值理由（**不卡着点**）：正常答话的回环服务在毫秒级（实测 18 个端口并行探完 833 ms），
 * 所以 2 s 对「活着但慢」的服务足够宽；而它同时是**每条**的上限，最坏情况仍可估
 * （扫描 ~2.5 s + 2 波 × 2 s ≈ 6.5 s，落在快档预算内）。别往下调来「省时间」——
 * 这个数是**正确性**的一部分，不是性能旋钮。
 */
export const PROBE_TIMEOUT_MS = 2_000

/**
 * 工具的工作量档 —— 工具**只声明自己是哪一类**，预算由 {@link toolBudgetMs} 一处推出来。
 *
 * 为什么必须分档（而不是一个全局数）：六个工具干的活差 30 倍。
 * `--dump-config-schema` 是 CPU 密集、随 profile 规模增长的活（本机实测 3.3 万行 JSON），
 * 其余几个只是读文件、跑一条 0.4 s 的命令、发一次 HTTP。用一个数兜住两者，
 * 结果只能是「快的那个白等、慢的那个在赌」—— 那正是加这一档之前的实测故障。
 */
export type Workload =
  /** 快档：读文件、跑一条 `--dump-config` 量级的命令、一次 HTTP 探测。 */
  | 'quick'
  /** 慢档：会跑 `--dump-config-schema` 的工具。 */
  | 'schemaDump'

/**
 * 每一档的**默认**工具预算（毫秒）—— **全仓唯一的一组预算数字**。
 *
 * ## 慢档为什么是 60_000
 *
 * 本机实测（2026-10-14，`dsh --profile web --dump-config-schema`）：
 *
 * | 场景 | 耗时 |
 * |---|---|
 * | 空载（5 次） | 10.23 / 10.40 / 10.50 / 10.75 / 10.84 s |
 * | 3 个 dump 并发 | 12.1 s |
 * | 4 个 dump 并发 + `npm run check` | 15.43 / 15.59 / 15.63 / 15.66 s |
 * | 用户某次（并发跑 check 时） | 32 s |
 *
 * 旧的单一预算 15_000 减掉 {@link TRANSPORT_MARGIN_MS} 之后只剩 **13 s** ——
 * 恰好卡在 10.5 s 与 15.6 s **中间**：空载能过、机器一忙必挂。而这条路径上的失败是
 * **间歇性**的（负载一撤就恢复），最容易被当成「偶发」——本仓已在同一负载窗口里
 * 用工具调用复现过它。60_000 是**典型实测值的约 4 倍、最坏实测值的约 2 倍**：
 * 不卡着点，也不至于让真挂住的调用把宿主的等待拖满。
 *
 * ## 有一条更慢的**降级路径**，这个默认值对它可能不够（如实记着，未下结论）
 *
 * 上面那张表测的是 `node bin.js …` 那条路（工具真实的启动方式是
 * `resolveDshLaunch()`：`argv[1]` 是 `bin.js` 就用同一个 node 跑它）。
 * 而它有一个**退回分支**：`argv[1]` 不是 `bin.js` 时退回 **PATH 上的 `dsh`** ——
 * 那条会走 npm 的 shim（多一层进程/解释器）。复验者实测过一次该路径的
 * **79.18 s**（`dsh.ps1` shim，首跑，**不可复现**；同一台机器上 `node bin.js`
 * 是 10.8–13.4 s）。
 *
 * ⇒ **形状**：降级路径可能显著慢于本表，60_000 对它没有余量保证。
 * **未知**：79.18 s 是离群值还是那条路的常态，没有重复测量，不据此调默认值。
 * 已知的应对是工具在超时分支里让模型去调大 `schemaDumpTimeoutMs`（`nextStep.why`）。
 *
 * ## 快档为什么是 60_000（2026-10-14 维护者拍板）
 *
 * 原先 15_000。**改成 60 s 是维护者直接指定的下限**（「那么多工具，超时至少得设为 1min」），
 * 理由不是某一档慢了，而是**这条死线是工具能用的上限，不是性能目标**：
 *
 * - 它是一道**兜底**，不是预算分配 —— 工具正常都在几百毫秒到几秒内返回（快档最慢一步 0.4 s），
 *   把兜底调宽**不会**让任何一次调用变慢，只会让「慢机器 / 冷启动 / 降级路径」不至于直接失败；
 * - 15 s 太贴：本仓真机端到端实测过一个反例 —— `dsh_list_instances` 在 15 s 下**整次超时、
 *   什么都返回不了**（见 `PROBE_TIMEOUT_MS` 的注释）；
 * - 宿主对工具超时的处置是**硬死线**（`dsh-tool-call-timeout-policy`），撞上它模型拿到的是
 *   裸超时、不是结构化输出 —— 那正好废掉本仓 `{verdict,key,audit}` 契约的意义。
 *
 * **慢档必须保持「≥ 快档 × 4」**（`test/tools/timeout-budgets.test.ts` 有一条判据钉着
 * `schemaDumpTimeoutMs >= QUICK × 4`，另有 `!==`）：这条比的不是「谁更宽松」，而是**两者的活
 * 差 30 倍**（0.4 s vs 10–32 s）—— 所以快档抬到 60 s 时慢档一并抬到 **240 s**，比例不变。
 * 若只抬快档，两档就会挤到一起、分档变成空话。慢档那条 79.18 s 的降级路径实测见上一段。
 *
 * ## 这两个数字不许被别处再抄一遍
 *
 * `src/config.ts` 的 schema 默认值**引用这里的字段**，工具侧一律走 {@link toolBudgetMs}；
 * `src/tools/` 里出现任何毫秒字面量都会被 `test/tools/timeout-budgets.test.ts` 判红。
 *
 * 它的形状就是**配置面本身的形状**（{@link WorkloadBudgetConfig}），不是另造一套按档编号的表：
 * 于是 `toolBudgetMs('schemaDump', WORKLOAD_DEFAULT_BUDGET_MS)` 直接可算，
 * 「默认预算」与「配置写出来的预算」永远是同一套字段名。
 */
export const WORKLOAD_DEFAULT_BUDGET_MS: WorkloadBudgetConfig = {
  timeoutMs: 60_000,
  schemaDumpTimeoutMs: 240_000,
}

/**
 * 「工作量 → 工具预算」的配置面：用户能调的那两个数。
 *
 * 写成**结构化形参**而不是直接要 `ResolvedConfig`：映射只需要两个数，测试因此不必造
 * 一整份配置。`ResolvedConfig` 正是 **extends 本接口**（见 `contracts.ts`），
 * 所以生产调用点可以直接传 `deps.config`，而且改字段名时两边一起编译不过。
 */
export interface WorkloadBudgetConfig {
  /** 快档工具的工具预算（毫秒）。 */
  readonly timeoutMs: number
  /** 慢档工具的工具预算（毫秒）。 */
  readonly schemaDumpTimeoutMs: number
}

/**
 * 取某一档的工具预算 —— **全仓唯一一处决定预算数字的地方**。
 *
 * 工具侧只声明 `const WORKLOAD: Workload = '…'`，之后每一个预算位置
 * （`defineTool` 的 `timeoutMs`、`createDeadline` 的总量、每次 IO 的 `budgetFor`）
 * 都从这里取。于是「谁该等多久」只有一个答案，而不是六份抄写。
 *
 * `switch` **故意穷尽且不写 `default`**：将来加一档时，忘了在配置面补字段会**编译不过**，
 * 而不是在运行期拿到 `undefined` —— 后者会让 `defineTool` 当场拒绝
 * （活跃坑 15：非正 / 非有限预算直接拒），而那条路径发生在**注册期**，
 * 症状是「这个工具整个不见了」，比报错难查得多。
 *
 * @param workload 工作量档。
 * @param config 预算配置面。
 */
export function toolBudgetMs(workload: Workload, config: WorkloadBudgetConfig): number {
  switch (workload) {
    case 'quick':
      return config.timeoutMs
    case 'schemaDump':
      return config.schemaDumpTimeoutMs
  }
}

/**
 * 由工具预算推出单次传输预算。
 *
 * ## 两条纪律的优先级是**写死的**：先「传输 < 工具」，再谈下限
 *
 * ① `toolTimeoutMs − TRANSPORT_MARGIN_MS`：正常路径，余量留给本插件把结果结构化再返回；
 * ② 预算小到 `TRANSPORT_MARGIN_MS` 都不够时，退到 {@link MIN_TRANSPORT_TIMEOUT_MS}
 *    （至少给 IO 一个可用窗口）；
 * ③ **封顶在 `toolTimeoutMs − 1`**：② 的上限是「抬」，而抬过头就会 >= 工具预算 ——
 *    那一瞬间本文件存在的理由（传输先于工具）就被自己推翻了。
 *
 * 为什么必须有 ③：`defineTool` **只拒非正 / 非有限**，`timeoutMs: 1` 照收
 * （实测，见 `test/tools/timeout-budgets.test.ts` 的边界用例），config schema 也只是
 * `z.number()`。没有 ③ 时用户配 `timeoutMs: 1` ⇒ 传输预算 250 > 工具预算 1 ⇒
 * 宿主按 1 ms 掐死，模型拿到**裸 TimeoutError**（没有 `kind`、没法判断重试）——
 * 正是本文件第 1-9 行说的那种失败，而且是**静默**的。
 *
 * ③ 只在 `toolTimeoutMs <= MIN_TRANSPORT_TIMEOUT_MS` 时才咬合（`>= 251` 时
 * `max(250, b − 2000) <= b − 1` 恒成立），所以对任何正常预算**零行为改变**。
 * 它的代价是极小的预算会得到 `0`：那是**有意**的 —— `budgetFor` 的文档写明
 * 「剩余预算耗尽 ⇒ 返回 0 ⇒ 调用方不再发起 IO，直接返回结构化超时」。
 *
 * @param toolTimeoutMs 工具声明的总预算（来自 {@link toolBudgetMs}）。
 */
export function transportTimeoutMs(toolTimeoutMs: number): number {
  const withFloor = Math.max(MIN_TRANSPORT_TIMEOUT_MS, toolTimeoutMs - TRANSPORT_MARGIN_MS)
  // ③：不变量优先 —— 传输预算**永远**小于工具预算（零/负预算时给 0 = 不发起 IO）。
  return Math.min(withFloor, Math.max(0, toolTimeoutMs - 1))
}

/**
 * 一次工具调用共享的截止时间。
 *
 * 为什么需要它：有的工具要跑**多条**外部命令（`dsh_dump_config` 跑两次 dump）。
 * 给每条命令各发一份完整预算，总耗时就会是预算的两倍 —— 宿主先超时，
 * 传输层根本没机会先超时。共享一个 deadline 才能守住「传输先于工具」。
 */
export interface Deadline {
  /** 总预算（毫秒），用于诊断输出。 */
  readonly totalMs: number
  /** 剩余预算（毫秒）；已耗尽时返回 0，**不返回负数**。 */
  remainingMs(): number
  /** 预算是否已耗尽。 */
  expired(): boolean
}

/**
 * 造一个从「现在」起算的截止时间。
 *
 * @param totalMs 总预算（毫秒）。
 * @param now 取当前时间的函数，只为测试注入。
 */
export function createDeadline(totalMs: number, now: () => number = Date.now): Deadline {
  const startedAt = now()
  const elapsed = (): number => Math.max(0, now() - startedAt)
  return {
    totalMs,
    remainingMs: () => Math.max(0, totalMs - elapsed()),
    expired: () => elapsed() >= totalMs,
  }
}

/**
 * 取「本次传输该用多少预算」：传输上限与剩余预算的较小者。
 *
 * 剩余预算已耗尽时返回 `0`，调用方据此**不再发起 IO**，直接返回结构化超时 ——
 * 这是「先超时的那一层是传输层」在**多条命令**场景下的落地。
 *
 * @param toolTimeoutMs 工具声明的总预算（来自 {@link toolBudgetMs}）。
 * @param deadline 本次调用的共享截止时间。
 */
export function budgetFor(toolTimeoutMs: number, deadline: Deadline): number {
  return Math.min(transportTimeoutMs(toolTimeoutMs), deadline.remainingMs())
}
