/**
 * HTTP 探测层 —— `fetchImpl` 可注入，且把「连接被拒」与「401」分成两个 kind。
 *
 * 这一层存在的全部理由是 SKILL §3.3 的那个区分：
 * **连接被拒 = 服务没启动；401 = 服务活着、认证没过。** 两者的下一步完全相反
 * （一个去启动，一个去换 authority / 凭证），所以必须在 `kind` 上分开，
 * 不能让模型从一句 message 里猜。
 */
import { systemErrorCode } from './errors.js'

/** 探测结论。 */
export type HttpProbeKind =
  /** 服务在、认证也过了（200 或 3xx 重定向）。 */
  | 'ok'
  /** 服务在，但认证没过（401）。 */
  | 'unauthorized'
  /** 连不上：端口没在监听（`ECONNREFUSED` 等）。 */
  | 'not-running'
  /** 传输层预算耗尽。 */
  | 'timeout'
  /** 调用方取消了这次探测（`exec.signal`）。**不要**与 `not-running` 混为一谈。 */
  | 'cancelled'
  /** 连上了但返回了别的状态码。 */
  | 'http-error'

/** 探测结果：`kind` 给机器判，`detail` 给人看。 */
export interface HttpProbeResult {
  kind: HttpProbeKind
  /** HTTP 状态码；连不上/超时时为 `undefined`。 */
  status?: number
  /** `Location` 响应头；303 交换成功时它指向最终地址。 */
  location?: string
  /** 一句可读的原因。 */
  detail: string
}

/**
 * 探测所需的最小响应面。
 *
 * 故意**不**用全局 `fetch` 的类型：那样单测就得伪造整个 `Response`。
 * 只要 status 与 headers 就够 —— 401 与 303 的判定都只依赖这两个。
 */
export interface HttpResponseLike {
  readonly status: number
  readonly headers?: { get(name: string): string | null } | undefined
}

/** 可注入的 HTTP 实现。 */
export type FetchImpl = (
  url: string,
  init: { readonly signal: AbortSignal; readonly redirect: 'manual' },
) => Promise<HttpResponseLike>

/**
 * 生产实现：包一层全局 `fetch`。
 *
 * `redirect: 'manual'` 是必须的 —— SKILL §3.3 说有效 token 交换是 **303 + Set-Cookie**，
 * 跟着跳转会把 303 变成 200，那个「成功」就无法与「本来就 200」区分。
 *
 * @param url 目标地址。
 * @param init 信号与重定向策略。
 */
export const defaultFetchImpl: FetchImpl = async (url, init) => {
  const response = await fetch(url, { signal: init.signal, redirect: init.redirect })
  return { status: response.status, headers: response.headers }
}

/**
 * 探测一个 authority。
 *
 * **不抛**：所有失败都收敛成 `kind`。调用方据此决定重试与否。
 *
 * @param url 完整 URL（含 scheme、host、port）。
 * @param timeoutMs 本条请求的传输预算（调用方保证它小于工具预算）。
 * @param deps 可注入的实现。
 */
export async function probeHttp(
  url: string,
  timeoutMs: number,
  deps: { fetch: FetchImpl; signal?: AbortSignal | undefined },
): Promise<HttpProbeResult> {
  if (isAborted(deps.signal)) {
    // 已经取消：连请求都不发。发出去不但没意义，还会在「调用方已放弃」的前提下
    // 额外产生一次带副作用的 IO（401 那次请求会走认证链路）。
    //
    // 这一段**必须**在注册监听器之前判断：`addEventListener` 不会为「已经 abort 的信号」
    // 补发事件，只挂监听器的话，调用方若在进来之前就取消了（宿主取消与工具调用可能同拍
    // 发生），就会带着一个未取消的 controller 去发请求 —— 取消被静默吞掉、工具返回「成功」。
    return { kind: 'cancelled', detail: 'the caller cancelled this probe before any request was sent' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new Error('transport-timeout'))
  }, timeoutMs)
  const relayAbort = (): void => {
    controller.abort(deps.signal?.reason)
  }
  deps.signal?.addEventListener('abort', relayAbort, { once: true })

  try {
    const response = await deps.fetch(url, {
      signal: controller.signal,
      redirect: 'manual',
    })
    const location = response.headers?.get('location') ?? undefined
    return classify(response.status, location)
  } catch (error) {
    return classifyThrown(error, isAborted(deps.signal))
  } finally {
    clearTimeout(timer)
    deps.signal?.removeEventListener('abort', relayAbort)
  }
}

/**
 * 信号是否已取消。
 *
 * 抽成函数是为了**挡住 TS 的控制流收窄**：上面的提前返回会把
 * `deps.signal?.aborted` 收窄成 `false | undefined`，于是后面再比 `=== true`
 * 会被报成「不可能重叠的比较」（实测 TS2367）—— 而运行期它当然可能为真
 * （监听器是在提前返回**之后**才注册的）。
 *
 * @param signal 调用方信号。
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/**
 * 把状态码映射成结论。
 *
 * @param status HTTP 状态码。
 * @param location `Location` 头。
 */
function classify(status: number, location: string | undefined): HttpProbeResult {
  if (status === 401) {
    return {
      kind: 'unauthorized',
      status,
      detail: 'service is up but authentication failed (401) — this is not "not running"',
    }
  }
  if ((status >= 200 && status < 400) || status === 0) {
    return {
      kind: 'ok',
      status,
      ...(location === undefined ? {} : { location }),
      detail: 'service is up and this request was accepted',
    }
  }
  return {
    kind: 'http-error',
    status,
    ...(location === undefined ? {} : { location }),
    detail: `service is up but returned ${String(status)}`,
  }
}

/**
 * 把抛出的异常映射成结论。
 *
 * @param error 捕获到的异常。
 * @param callerAborted 调用方是否已取消（取消优先于超时：是我们自己放弃的，不是目标的错）。
 */
function classifyThrown(error: unknown, callerAborted: boolean): HttpProbeResult {
  if (callerAborted) {
    // 单独一个 kind：取消是**我们主动放弃**，而 `not-running` 是**目标没起来** ——
    // 两者的下一步相反（一个别重试，一个去启动），混在一起模型必然选错。
    return { kind: 'cancelled', detail: 'the caller cancelled this probe; no verdict' }
  }
  const code = systemErrorCode(error)
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNRESET' || code === 'EHOSTUNREACH') {
    return {
      kind: 'not-running',
      detail: `cannot connect (${code}) — no listener on that port`,
    }
  }
  // 我们自己的超时定时器 abort 的：reason 是我们塞的那个 Error。
  if (error instanceof Error && error.name === 'AbortError' && error.message.includes('transport-timeout')) {
    return { kind: 'timeout', detail: 'transport timed out first (the tool budget had not expired)' }
  }
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('transport-timeout')) {
    return { kind: 'timeout', detail: 'transport timed out first (the tool budget had not expired)' }
  }
  return { kind: 'not-running', detail: `probe failed: ${message}` }
}
