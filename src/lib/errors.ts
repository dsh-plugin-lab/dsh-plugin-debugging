/**
 * 工具结果的错误契约（`src/tools/**` 与 `test/tools/**` 共享，不含 IO）。
 *
 * 形状（SHAPE §4.1 冻结，改它要同时改 `docs/SHAPE.md` 与五个工具）：
 * - 成功：`{ ok: true, data: { verdict, key, audit }, nextStep? }`
 * - 预期内失败：`{ ok: false, error: { kind, message }, data: { verdict, key, audit }, nextStep? }`
 *
 * 与旧契约的三处差别（2026-10-13 拍板，一次改干净、不留兼容层）：
 * 1. **`error.hint` 删了**：它的内容只有两种归宿，两种都已经有家 ——
 *    恒定知识 → 描述层边界段（写一次）；具体动作 → `nextStep`。留着就是给模型两个权威去分辨。
 * 2. **`error.evidence` 并进 `data`**：失败分支的 `data` 就是原来的 evidence
 *    —— 「这次看到了什么」只该有一个槽，两分支同形。
 * 3. **`nextStep` 必须带动作**：`{ tool, args?, why }` 或 `{ manual: true, why }`。
 *    「裸结论伪装成下一步」（旧形状 `nextStep: — <why>`）从此在类型上写不出来。
 *
 * 为什么 `kind` 必须是**闭枚举**：它是模型唯一可靠的判据 ——
 * 「重试同一个调用」对 `timeout` 成立、对 `not-running` 是白费、对 `cancelled` 是错的。
 * `message` 给人看，会随版本变；`kind` 给机器判，必须是稳定集合。
 */

/** 闭枚举：每个 kind 对应一种「模型该采取不同动作」的失败。 */
export const TOOL_ERROR_KINDS = [
  /** 目标服务没在监听（连接被拒）。原样重试无用：先启动，或确认端口没变。 */
  'not-running',
  /** 服务在，但认证没过（401）。换 authority / 凭证重试才有意义。 */
  'auth',
  /** 要找的文件 / profile / 条目不存在。改参数重试。 */
  'not-found',
  /** 配置不足以执行（例如既没配 `dshHome`、环境里也读不到 `DSH_HOME`）。先补配置。 */
  'not-configured',
  /** 传输层超时。可原样重试。 */
  'timeout',
  /** 子进程跑完了但非零退出。先看 stderr，别盲目重试。 */
  'command-failed',
  /** 调用方取消了这次执行（`exec.signal`）。**不要**自动重试。 */
  'cancelled',
  /**
   * 写侧工具：这次**替换没成功**（新代码 import 期或 apply 期抛了）。
   *
   * 为什么必须与 `internal` 分开：这两档都**不是**本插件的 bug，而模型要做的事
   * 也不同 —— 要去改**被重载的那份插件代码**再重试。归到 `internal` 会让模型
   * 去报一个不存在的 bug；归到 `command-failed` 会误导成「看子进程 stderr」。
   * 至于「旧 fiber 有没有被碰过、有没有回滚」，那是 `message` 与 `data` 的活。
   */
  'reload-failed',
  /** 兜底：本插件自己的意外。 */
  'internal',
] as const

/** 闭枚举的成员类型。 */
export type ToolErrorKind = (typeof TOOL_ERROR_KINDS)[number]

/** 可无损落 JSON 的值（工具返回值必须在这个集合内）。 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/**
 * 下一步建议（决策 T19：不靠模型背历史）。
 *
 * **必须带动作**，两支恰有其一（B18a 就是断言这条）。为什么要有 `manual` 支：
 * 「必须带动作」只有在动作**可分派**时才可机械断言，而「重建客户端后刷新页面」这类
 * 没有工具可调 —— 它需要一个显式出口。代价是多一个字段，收益是「裸结论伪装成下一步」
 * 在类型上写不出来。
 */
export type NextStep =
  | {
      /** 建议调用的工具名（本插件的或宿主自己的都行）。非空字符串。 */
      tool: string
      /** 建议传入的参数。 */
      args?: JsonValue
      /** 为什么建议这一步 —— 模型真正读的是这句。 */
      why: string
    }
  | {
      /** 这一步没有工具可调，要用户自己做一个工具做不到的动作。 */
      manual: true
      /** 为什么建议这一步 —— 模型真正读的是这句。 */
      why: string
    }

/**
 * 结构化错误：机器码决定要不要重试；`message` 只写**事实一句话**（不写建议）。
 *
 * ## `message` 与 `data.verdict` 的分工（不是同一句的两个副本，也不许互抄）
 *
 * - `message` = **这次操作**为什么没做成（操作视角），由守卫或 {@link toToolError} 产生；
 * - `data.verdict` = **结论**（世界视角），就是模型读到的 L1。
 *
 * 冻结的渲染格式（SHAPE §3.1）里**没有** `message:` 行，这是有意的：模型要的是结论，
 * 操作层面的失败措辞留在结构化值里（会话日志）给人复核。**所以留着它不是漏渲染。**
 */
export interface ToolError {
  kind: ToolErrorKind
  message: string
}

/**
 * 工具 `data` 的外层形状（**三层输出的唯一记录**，所有工具共享）。
 *
 * - `verdict`：一句话结论（L1），**必填非空**。成功失败都有 —— 失败分支因此也有判定行。
 * - `key`：下一个决定可能要用到的投影（L2）。判据见 SHAPE §5：
 *   **模型看不到它，会不会做出不同的下一步？**
 * - `audit`：给人复核的部分（不进模型文本）。**可以为 `{}`**。
 *
 * 顶层**恰好这三个键**（B21 断言这条；`ensureToolResult` 与它同意同一套规则）。
 * 工具特有的字段一律塞进 `key` 或 `audit`，不许加第四个顶层键。
 */
export interface ToolData<T> {
  verdict: string
  key: T
  audit: JsonValue
}

/** 成功结果。 */
export interface ToolOk<T> {
  ok: true
  data: ToolData<T>
  nextStep?: NextStep
}

/**
 * 失败结果（**预期内**失败；意外由兜底分支转成 `internal`）。
 *
 * `data` 与成功分支**同形且必填**：它装的就是「失败时观测到的事实」（旧契约的 `evidence`）。
 * 代价是连「还没开工就失败」也要给一句 `verdict`；收益是失败分支从此也有 L1。
 *
 * 什么时候用它有一条规则：**`ok` 只描述「工具这次操作有没有完成」，不描述系统健不健康**。
 * 「诊断成功、只是结论是坏消息」应当走 `ok: true` + `data`（`verdict` 承载结论）；
 * 只有「操作没完成、但看到了值得留下的事实」才走 `ok: false`。
 */
export interface ToolFail<T = unknown> {
  ok: false
  error: ToolError
  data: ToolData<T>
  nextStep?: NextStep
}

/** 工具的统一返回形状。 */
export type ToolResult<T> = ToolOk<T> | ToolFail<T>

/**
 * 校验一个候选返回值是否符合 §4.1 的形状表。
 *
 * 返回 `undefined` = 合规；返回一句话 = 违规原因（用于合成 `internal` 失败的 `verdict`）。
 *
 * 为什么要单独一个函数：**渲染层与守卫层必须同意同一套规则**（SHAPE §4.1 的
 * 「红线的一致性要求」）。一处放宽、另一处收紧就会出现「红线绿但模型收到坏形状」。
 * 形状判据因此只写在这里一份：`ensureToolResult` 用它决定要不要换掉返回值，
 * `render` 用它决定要不要退化成一行原始 JSON。
 *
 * @param value 工具的候选返回值。
 */
export function toolResultProblem(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return `the result must be an object (got ${describe(value)})`
  }
  const record = value as Record<string, unknown>
  const okFlag = record['ok']
  if (okFlag !== true && okFlag !== false) {
    return `"ok" must be a boolean (got ${describe(okFlag)})`
  }
  const dataProblem = toolDataProblem(record['data'])
  if (dataProblem !== undefined) return dataProblem
  if (okFlag === false) {
    const errorProblem = toolErrorProblem(record['error'])
    if (errorProblem !== undefined) return errorProblem
  }
  const nextStep = record['nextStep']
  if (nextStep !== undefined) {
    const nextStepProblemText = nextStepProblem(nextStep)
    if (nextStepProblemText !== undefined) return nextStepProblemText
  }
  return undefined
}

/**
 * 校验 `data`：顶层恰好 `verdict` / `key` / `audit` 三个键。
 *
 * @param value 候选 `data`。
 */
function toolDataProblem(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return `"data" must be an object (got ${describe(value)})`
  }
  const data = value as Record<string, unknown>
  const keys = Object.keys(data)
  if (keys.length !== 3 || !('verdict' in data) || !('key' in data) || !('audit' in data)) {
    return `"data" must have exactly the three keys verdict/key/audit (got ${keys.join(', ') || 'none'})`
  }
  const verdict = data['verdict']
  if (typeof verdict !== 'string' || verdict === '') {
    return '"data.verdict" must be a non-empty string'
  }
  const key = data['key']
  // 「是对象」按字面读：非 null 的对象即可（数组也是一种投影目标，不在这一层禁掉）。
  if (typeof key !== 'object' || key === null) {
    return `"data.key" must be an object (got ${describe(key)})`
  }
  // `audit` 只要求**存在**（值域是任意 JSON，形状由各工具自己定）。
  return undefined
}

/**
 * 校验 `error`：闭枚举的 kind + 非空 message。
 *
 * @param value 候选 `error`。
 */
function toolErrorProblem(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return `"error" must be an object (got ${describe(value)})`
  }
  const error = value as Record<string, unknown>
  const kind = error['kind']
  if (typeof kind !== 'string' || !isToolErrorKind(kind)) {
    return `"error.kind" must be one of the closed set of error kinds (got ${describe(kind)})`
  }
  const message = error['message']
  if (typeof message !== 'string' || message === '') {
    return '"error.message" must be a non-empty string'
  }
  return undefined
}

/**
 * 校验 `nextStep`：两支恰有其一，且 `why` 非空。
 *
 * @param value 候选 `nextStep`。
 */
function nextStepProblem(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return `"nextStep" must be an object (got ${describe(value)})`
  }
  const step = value as Record<string, unknown>
  const why = step['why']
  if (typeof why !== 'string' || why === '') return '"nextStep.why" must be a non-empty string'
  const hasTool = step['tool'] !== undefined
  const hasManual = step['manual'] !== undefined
  if (hasTool && hasManual) {
    return '"nextStep" must be either { tool, why } or { manual: true, why } — not both'
  }
  if (!hasTool && !hasManual) {
    return '"nextStep" must carry an action: { tool, why } or { manual: true, why }'
  }
  if (hasManual && step['manual'] !== true) return '"nextStep.manual" must be true when present'
  if (hasTool && (typeof step['tool'] !== 'string' || step['tool'] === '')) {
    return '"nextStep.tool" must be a non-empty string'
  }
  return undefined
}

/**
 * 把任意值收敛成合法的工具结果，**绝不抛**。
 *
 * 为什么需要它：输出 schema 用的是 `{ type: 'json' }`（无损 JSON，不做结构强制），
 * 因为宿主的 `defineTool` 需要输出 schema 是**字面量**才能推断类型，而把
 * 「成功/失败」两分支写成 `oneOf` 会让推断出的 `data` 类型与工具自己的返回类型对不上
 * （`Promise<never>`）。于是结构强制从**声明期**挪到**返回前**在这里做 ——
 * 「形状不合法的对象永远不会交给模型」这条保证仍然成立，只是位置换了。
 *
 * @param value 工具的候选返回值。
 */
export function ensureToolResult(value: unknown): ToolResult<unknown> {
  const problem = toolResultProblem(value)
  if (problem !== undefined) return malformedResult(value, problem)
  return value as ToolResult<unknown>
}

/**
 * 把一个形状不对的返回值转成 `internal` 失败。
 *
 * 合成的 `data` 必须是**合规形状**（否则守卫自己产出的东西也要被自己拒掉）：
 * `verdict` 说清形状错在哪，`key` 为空对象，`audit` 只记一句收到的形状摘要。
 *
 * @param value 原始值（只用于描述，不原样回显大对象）。
 * @param problem 形状问题（来自 {@link toolResultProblem}）。
 */
function malformedResult(value: unknown, problem: string): ToolFail {
  return fail(
    { kind: 'internal', message: `Tool result has an invalid shape: ${problem}` },
    {
      verdict: `this call produced a result whose shape is invalid (${problem}), so nothing in it can be trusted`,
      key: {},
      audit: { received: describe(value) },
    },
  )
}

/**
 * 一句话描述一个值（不 dump 大对象）。
 *
 * @param value 任意值。
 */
function describe(value: unknown): string {
  if (Array.isArray(value)) return `array(${String(value.length)})`
  if (typeof value === 'object' && value !== null) return `object{${Object.keys(value).join(',')}}`
  return typeof value
}

/**
 * 是不是闭枚举里的 kind。
 *
 * @param value 候选字符串。
 */
export function isToolErrorKind(value: string): value is ToolErrorKind {
  return (TOOL_ERROR_KINDS as readonly string[]).includes(value)
}

/**
 * 造一个成功结果。
 *
 * @param data 三层记录（`verdict` / `key` / `audit`）。
 * @param nextStep 可选的下一步建议；没有动作就**不传**。
 */
export function ok<T>(data: ToolData<T>, nextStep?: NextStep): ToolOk<T> {
  return nextStep === undefined ? { ok: true, data } : { ok: true, data, nextStep }
}

/**
 * 造一个失败结果。
 *
 * 参数顺序与 `ok(data, nextStep?)` **同构**：必填在前、可选在最后。
 * 于是常见形状就是 `fail(error, data)`，需要下一步时 `fail(error, data, nextStep)` ——
 * 不给没有下一步的调用留 `undefined` 占位符（那是 31 个调用点上白写的噪声）。
 *
 * @param error 结构化错误（`kind` + 一句事实）。
 * @param data 这次观测到的记录（**必填**：失败分支也有 L1，见 SHAPE §4.1 约定 1）。
 * @param nextStep 可选的下一步建议；没有动作就**不传**。
 */
export function fail<T = unknown>(
  error: ToolError,
  data: ToolData<T>,
  nextStep?: NextStep,
): ToolFail<T> {
  return nextStep === undefined ? { ok: false, error, data } : { ok: false, error, data, nextStep }
}

/**
 * 判断一个异常是不是「调用方取消」。
 *
 * `AbortSignal` 的取消在两条路径上形状不同：`fetch` 抛 `AbortError`，
 * 子进程通常只是被 kill（看退出码）。这里只负责前者。
 *
 * @param error 捕获到的异常。
 */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/**
 * 把任意异常收敛成结构化错误（兜底分支用）。
 *
 * 有 `code` 的异常（Node 的 `SystemError`）单独识别两种最常见的网络失败：
 * 连接被拒 = 没启动；`ENOTFOUND` = 主机名写错。把它们映射到 `not-running`，
 * 是为了让模型不必去读 message 猜。
 *
 * `message` 只写**事实一句话**（建议的去处是描述层边界段或 `nextStep`，不是这里）。
 *
 * @param error 捕获到的异常。
 * @param context 出错的动作，用于拼 message（例如 `读取 profile manifest`）。
 */
export function toToolError(error: unknown, context: string): ToolError {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return { kind: 'timeout', message: `${context} timed out` }
  }
  const code = systemErrorCode(error)
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ENOTFOUND') {
    return { kind: 'not-running', message: `${context}: cannot reach the target (${code})` }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { kind: 'internal', message: `${context} failed: ${message}` }
}

/**
 * 把文本里的家目录替换成 `~`（诊断输出会进会话日志，家目录名不必留在那里）。
 *
 * @param text 原始文本。
 * @param home 家目录绝对路径；空串表示不做替换。
 */
export function redactHome(text: string, home: string): string {
  if (home === '') return text
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return text.replace(new RegExp(escaped, 'giu'), '~')
}

/**
 * 取异常的 `code` 字段（Node 的 `SystemError` 有，普通 `Error` 没有）。
 *
 * `cause` 也要看：`fetch` 把底层 `ECONNREFUSED` 包在 `TypeError` 的 `cause` 上，
 * 只读顶层会把它当成普通错误，于是「没启动」被误报成 `internal`。
 *
 * @param error 任意异常。
 */
export function systemErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string') return code
  const cause = (error as { cause?: unknown }).cause
  if (typeof cause === 'object' && cause !== null) {
    const causeCode = (cause as { code?: unknown }).code
    if (typeof causeCode === 'string') return causeCode
  }
  return undefined
}
