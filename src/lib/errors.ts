/**
 * 工具结果的错误契约（`src/tools/**` 与 `test/tools/**` 共享，不含 IO）。
 *
 * 形状（G2 冻结，改它要同时改 `docs/ARCHITECTURE.md` 与四个工具）：
 * - 成功：`{ ok: true, data, nextStep? }`
 * - 预期内失败：`{ ok: false, error: { kind, message, hint }, nextStep? }`
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
 * 它比 `hint` 更具体：`hint` 是「该往哪想」，`nextStep` 是「直接调哪个工具、传什么」。
 */
export interface NextStep {
  /** 建议调用的工具名（本插件的或宿主自己的都行）。 */
  tool?: string
  /** 建议传入的参数。 */
  args?: JsonValue
  /** 为什么建议这一步 —— 模型真正读的是这句。 */
  why: string
}

/** 结构化错误：机器码决定要不要重试，message 给人看，hint 是下一步的方向。 */
export interface ToolError {
  kind: ToolErrorKind
  message: string
  hint: string
}

/** 成功结果。 */
export interface ToolOk<T> {
  ok: true
  data: T
  nextStep?: NextStep
}

/** 失败结果（**预期内**失败；意外由兜底分支转成 `internal`）。 */
export interface ToolFail {
  ok: false
  error: ToolError
  nextStep?: NextStep
}

/** 工具的统一返回形状。 */
export type ToolResult<T> = ToolOk<T> | ToolFail

/**
 * 把任意值收敛成合法的工具结果，**绝不抛**。
 *
 * 为什么需要它：输出 schema 用的是 `{ type: 'json' }`（无损 JSON，不做结构强制），
 * 因为宿主的 `defineTool` 需要输出 schema 是**字面量**才能推断类型，而把
 * 「成功/失败」两分支写成 `oneOf` 会让推断出的 `data` 类型与工具自己的返回类型对不上
 * （`Promise<never>`）。于是结构强制从**声明期**挪到**返回前**在这里做 ——
 * 「缺 `error.hint` 的对象永远不会交给模型」这条保证仍然成立，只是位置换了。
 *
 * @param value 工具的候选返回值。
 */
export function ensureToolResult(value: unknown): ToolResult<unknown> {
  if (typeof value !== 'object' || value === null) return malformedResult(value)
  const record = value as Record<string, unknown>

  if (record['ok'] === true) {
    if (!('data' in record)) return malformedResult(value)
    return value as ToolOk<unknown>
  }
  if (record['ok'] === false) {
    const error = record['error']
    if (typeof error !== 'object' || error === null) return malformedResult(value)
    const candidate = error as Record<string, unknown>
    const kind = candidate['kind']
    if (typeof kind !== 'string' || !isToolErrorKind(kind)) return malformedResult(value)
    if (typeof candidate['message'] !== 'string' || typeof candidate['hint'] !== 'string') {
      return malformedResult(value)
    }
    return value as ToolFail
  }
  return malformedResult(value)
}

/**
 * 把一个形状不对的返回值转成 `internal` 失败。
 *
 * @param value 原始值（只用于描述，不原样回显大对象）。
 */
function malformedResult(value: unknown): ToolFail {
  return fail({
    kind: 'internal',
    message: `Tool result has an invalid shape: ${describe(value)}`,
    hint: 'This is a bug in this plugin; report this message verbatim',
  })
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
 * @param data 落 JSON 的载荷。
 * @param nextStep 可选的下一步建议。
 */
export function ok<T>(data: T, nextStep?: NextStep): ToolOk<T> {
  return nextStep === undefined ? { ok: true, data } : { ok: true, data, nextStep }
}

/**
 * 造一个失败结果。
 *
 * @param error 结构化错误。
 * @param nextStep 可选的下一步建议。
 */
export function fail(error: ToolError, nextStep?: NextStep): ToolFail {
  return nextStep === undefined ? { ok: false, error } : { ok: false, error, nextStep }
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
 * @param error 捕获到的异常。
 * @param context 出错的动作，用于拼 message（例如 `读取 profile manifest`）。
 */
export function toToolError(error: unknown, context: string): ToolError {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return {
      kind: 'timeout',
      message: `${context} timed out`,
      hint: 'The transport layer timed out first; retry as-is, or raise timeoutMs if it keeps timing out',
    }
  }
  const code = systemErrorCode(error)
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ENOTFOUND') {
    return {
      kind: 'not-running',
      message: `${context}: cannot reach the target (${code})`,
      hint: 'Check whether the host is listening on that port; if the port changed, use the new one',
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  return {
    kind: 'internal',
    message: `${context} failed: ${message}`,
    hint: 'This is an unexpected path in this plugin; report the message verbatim and check the startup logs if needed',
  }
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
