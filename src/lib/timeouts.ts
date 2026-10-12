/**
 * 超时纪律 —— 传输层必须**先于**工具层超时。
 *
 * 为什么：宿主按 `timeoutMs` 给工具调用设死线（`@deepseek-ai/dsh-tool-call-timeout-policy`
 * 的 `tools/execute` 包装器）。如果传输层不先超时，宿主会先把它掐掉，
 * 模型拿到的是一枚**裸 TimeoutError**、没有 `kind`、没法判断能不能重试；
 * 反过来，传输层先超时就能返回结构化的 `{ ok:false, error:{ kind:'timeout' } }`。
 *
 * 所以每个外部 IO 的预算 = 工具预算 − 余量，且**余量必须为正**。
 */

/** 工具预算与传输预算之间的余量（毫秒）：留给本插件把结果结构化再返回。 */
export const TRANSPORT_MARGIN_MS = 2_000

/** 传输预算的下限：预算被配得极小时，至少给 IO 一个可用的窗口。 */
export const MIN_TRANSPORT_TIMEOUT_MS = 250

/**
 * 由工具预算推出单次传输预算。
 *
 * @param toolTimeoutMs 工具声明的总预算（`ResolvedConfig.timeoutMs`）。
 */
export function transportTimeoutMs(toolTimeoutMs: number): number {
  return Math.max(MIN_TRANSPORT_TIMEOUT_MS, toolTimeoutMs - TRANSPORT_MARGIN_MS)
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
 * @param toolTimeoutMs 工具声明的总预算。
 * @param deadline 本次调用的共享截止时间。
 */
export function budgetFor(toolTimeoutMs: number, deadline: Deadline): number {
  return Math.min(transportTimeoutMs(toolTimeoutMs), deadline.remainingMs())
}
