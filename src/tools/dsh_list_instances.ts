/**
 * `dsh_list_instances` —— 列出本机**活着的** DSH 宿主（D′ 第①块，见 `docs/SHAPE.md` §1.2）。
 *
 * ## 它为什么存在
 *
 * 文件型工具能指向另一个实例（`dshHome` 参数），但**没有任何东西能先告诉你「本机有哪些实例」**。
 * 这个工具补的就是那一格：**发现**。
 *
 * ## 四条硬边界（每一条都是「不这么写就是骗模型」）
 *
 * 1. **只能给 authority（`host:port`），给不出 home**。宿主 HTTP 面上没有任何路由能问出
 *    「我是谁 / 读哪个 home」，`$DSH_HOME` 里也没有别的实例的登记文件 ⇒ 发现结果与 home
 *    之间**没有可推导的关系**。所以描述里绝不暗示它知道 home，输出里也只给 authority ——
 *    要把文件型工具指向另一个实例，**路径必须由调用方手填**。
 * 2. **认领 DSH 靠专有签名，不是「401 就算」**：未认证 `GET /` 的 401 且 body **逐字**
 *    等于 {@link DSH_UNAUTHORIZED_BODY} 才算。任何要认证的服务都会返 401，把 401 当签名
 *    会把本机所有「需要登录」的东西都报成 DSH 实例。
 * 3. **三值，不是两值**：`dsh` / `other` / `unknown`。连不上、超时、取消、非 HTTP 全归
 *    `unknown` —— 那是「**没探到**」，与「探到了、不是 DSH」是相反的两件事
 *    （本仓三值纪律：「缺席」≠「空」）。
 * 4. **「没扫」也单独报**：给了 `port` 就不去读 socket 表，`scan.status = 'skipped'` ——
 *    它不是「查不了」，也不是「没扫到」。
 *
 * ## 只探回环 + 有界
 *
 * 一律连 `127.0.0.1:<port>`：候选来自 socket 表，那些端口可能绑在局域网上，
 * 但我们**只从本机回环去敲**（不做网络扫描）。候选数与每次探测都受预算约束，
 * 一次调用绝不挂死。
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import { fail, ok, toToolError, type JsonValue, type NextStep } from '../lib/errors.js'
import {
  budgetFor,
  createDeadline,
  PROBE_TIMEOUT_MS,
  toolBudgetMs,
  transportTimeoutMs,
  type Workload,
} from '../lib/timeouts.js'
import { listListeners, type ListenerCandidate } from '../lib/ports.js'
import type { RenderTable } from '../lib/render.js'
import { composeDescription, type ToolDescription } from './describe.js'
import { toOutput, toolOutput, type ToolDeps } from './shared.js'

/** 工具名。加工具时同步改：注册处 / B9 闭集 / 两份 README 的工具清单。 */
export const LIST_INSTANCES_TOOL = 'dsh_list_instances'

/**
 * 本工具的工作量档：**快档**。
 *
 * 它只做两件事：跑一条 socket 表命令（本机实测 ~2.5 s）+ 对若干回环端口发一次很小的
 * 未认证请求。探测**有界并发**、**每条独立上限**（`PROBE_TIMEOUT_MS`）——
 * 最坏情况约 6.5 s，落在快档预算内。
 */
const WORKLOAD: Workload = 'quick'

/**
 * 同时最多探几个候选。
 *
 * **它就是本工具耗时的主变量** —— 不是算法，是并发数：耗时 ≈ `ceil(候选数 / 并发) × 单条上限`。
 *
 * 本机实测（2026-10-14，`elapsed` 为端到端真实读数）：
 *
 * | 并发 | 48 个候选 | 实测 elapsed |
 * |---|---|---|
 * | 串行 | 29.6 s（37 个端口 × 800 ms 下限） | 15 s 传输超时、**什么都返回不了** |
 * | 8 | 6 波 | **9.7 s**（其中扫描 ~2.5 s） |
 * | 48（全量） | 1 波 | **约 4.5 s** |
 *
 * 而**全并行探 37 个回环端口只要 833 ms** —— 说明它不怕端口多，只怕并发低。
 * 所以这里取「**一次问完**」而不是某个折中数：候选本身已被 `MAX_CANDIDATES` 截过，
 * 全量并发 = 1 波，最坏 = 单条上限（`PROBE_TIMEOUT_MS`），**与候选数无关**。
 * 对回环发几十个极小的未认证 GET 对机器没有可感压力（实测总耗时 833 ms 已经包含它）。
 */
const PROBE_CONCURRENCY = 48

/**
 * 候选上限：超过就不再往下探。
 *
 * 为什么要有它：socket 表可能有几百行，逐个发请求会让一次调用变成一次**端口扫描**。
 * 上限之外的那些**不静默丢掉** —— `key.scan.truncated` 会说出来，而 L1 **不许**在
 * 还有候选没探时说「没有 DSH」（见 {@link verdictFor}）。
 *
 * ⚠️ **为什么从 24 提到 48**（2026-10-14 真机端到端实测）：本机 socket 表有 **63 行 /
 * 52 个唯一端口**，而 24 个上限配合当时的取法（不排序、不去重）⇒ **真正在跑的那个
 * DSH（`127.0.0.1:3080`）排在下标 58，永远进不了候选** ⇒ 工具报「no DSH host was found」。
 * 48 是「8 并发 × 2 s 上限」在 13 s 传输窗口内能跑完的量级（约 6 波），再往上就该
 * 靠 deadline 兜底并**如实报告没探到多少**，而不是继续抬这个数。
 */
const MAX_CANDIDATES = 48

/**
 * DSH 未认证 `GET /` 的响应体 —— **逐字**这一段才是签名。
 *
 * 出处：`docs/SHAPE.md` §1.2 的「已核的识别签名」（真源在 HOST-CONTRACTS）。
 * 对照：`/api`、`/api/session.export` 的 body 只是通用 `unauthorized`；
 * `/health`、`/version` 是 404 —— **这些都不算签名**。
 */
export const DSH_UNAUTHORIZED_BODY =
  'dsh web authentication required; reopen the URL printed by dsh web.\n'

/**
 * 探签名的 HTTP 实现。
 *
 * 为什么不是 `lib/http.ts` 的 `FetchImpl`：那个形状只给 `{ status, headers }`，
 * **读不到 body** —— 而签名恰恰在 body 上。这里的类型比它多一个 `text()`；
 * 值仍然从注入点进（测试喂替身，不真发请求）。
 */
export type SignatureFetch = (
  url: string,
  init: { readonly signal: AbortSignal; readonly redirect: 'manual' },
) => Promise<{ readonly status: number; text(): Promise<string> }>

/**
 * 生产实现：包一层全局 `fetch`。
 *
 * 与 `lib/http.ts` 的 `defaultFetchImpl` 同源，只多读一次 body。
 * **放在本文件是刻意的**：`lib/http.ts` 不在本卡写域里，而为一个三行的适配器去扩写域外的
 * 文件代价更大。将来若要收进 `lib/http.ts`，改动就是把这一段搬过去。
 *
 * @param url 目标地址。
 * @param init 信号与重定向策略。
 */
export const defaultSignatureFetch: SignatureFetch = async (url, init) => {
  const response = await fetch(url, { signal: init.signal, redirect: init.redirect })
  return { status: response.status, text: () => response.text() }
}

/** 一个候选的认领结论。**三值**：`unknown` 与 `other` 不许压成一个。 */
export type InstanceVerdict =
  /** 401 且 body 逐字等于签名 —— 这是 DSH。 */
  | 'dsh'
  /** 探到了，但不是 DSH（含 body 不同的 401）。 */
  | 'other'
  /** **没探到**：连不上 / 超时 / 取消 / 非 HTTP。**不是**「不是 DSH」。 */
  | 'unknown'

/** 工具参数。 */
interface ListInstancesArgs {
  /**
   * 只探这一个端口（不读 socket 表）。
   *
   * 两个用处：① 你已知端口时省掉整轮扫描；② **socket 表读不出来时的逃生口** ——
   * 那种情况下「这个端口是不是 DSH」仍然答得出来。
   */
  port?: number
}

/** `key.scan` 的三态：`scanned` / `skipped`（给了 port，没扫）/ `unavailable`（扫不了）。 */
type ScanStatus = 'scanned' | 'skipped' | 'unavailable'

/** `key` 里一个候选的投影。 */
interface InstanceKey {
  /** `127.0.0.1:<port>` —— **只给 authority**，不给 home（本工具给不出）。 */
  authority: string
  verdict: InstanceVerdict
  /** 进程信息（读不到就没有 —— 那是如实结论，不是失败）。 */
  pid?: number
  processName?: string
  /** HTTP 状态码；没探到时没有。 */
  status?: number
  /** 一句可读原因（`unknown` 时是「为什么没探到」）。 */
  detail: string
}

/** `key`：模型做下一个决定要用的原料。 */
interface ListInstancesKey {
  /** 这一次「列全部」的结果（覆盖完整性都在这里）。 */
  scan: {
    /**
     * **三态**，不是一个布尔：
     * - `scanned`：读了 socket 表（结果见 `instances`）；
     * - `skipped`：**给了 `port`，没扫** —— 与「查不了」不是一回事；
     * - `unavailable`：**扫不了**（命令缺失 / 形状认不出）—— 与「一个都没有」不是一回事。
     */
    status: ScanStatus
    /** 有监听、但读不到 pid 的条数（第三态；不许与「没人听」混）。 */
    unidentified: number
    /** 候选超过上限、没有逐个探 —— **不静默**。 */
    truncated: boolean
    detail: string
  }
  /** 逐个候选的认领结论（**含** `other` / `unknown`：模型要能看见它们不是 DSH）。 */
  instances: InstanceKey[]
}

/**
 * 本工具的描述（SHAPE §2.1 四段骨架，观察类没有「代价段」）。
 *
 * 逐段理由：
 * - `what`：动词 + 对象。
 * - `useWhen`：路由信号 + **一句去路**（结果可以喂给 `dsh_check_auth`）。
 * - `boundary`：**两行**，承载两条「不说就是骗模型」的边界：
 *   ① 只能给 authority，**给不出 home**（SHAPE §1.2 硬边界 2）；
 *   ② 只探回环，且「没探到」≠「不是 DSH」。
 */
export const LIST_INSTANCES_DESCRIPTION: ToolDescription = {
  what: 'Lists live DSH hosts on this machine.',
  useWhen: 'Use to find instances; pass a result to dsh_check_auth.',
  boundary:
    'Returns an authority (host:port) only, never a DSH_HOME.\n' +
    'Loopback only; could not probe is not the same as not DSH.',
}

/** 输出表：L1 就是 `data.verdict` 逐字，L2 由 `key` 投影成行。 */
const TABLE: RenderTable<ListInstancesKey> = { key: (data) => keyText(data.key) }

/**
 * 造工具。
 *
 * @param deps 运行期依赖（`signatureFetch` 可注入；不给就用全局 `fetch`）。
 */
export function createListInstancesTool(
  deps: ToolDeps & { readonly signatureFetch?: SignatureFetch | undefined },
): ToolDefinition {
  const signatureFetch = deps.signatureFetch ?? defaultSignatureFetch
  return defineTool({
    name: LIST_INSTANCES_TOOL,
    description: composeDescription(LIST_INSTANCES_DESCRIPTION),
    parameters: {
      port: {
        type: 'integer',
        // 参数规则住在参数上（SHAPE §2）：工具描述里不复述。
        description: 'Probe this port only; omit to scan every listening port.',
      },
    },
    output: toolOutput(LIST_INSTANCES_TOOL, TABLE),

    timeoutMs: toolBudgetMs(WORKLOAD, deps.config),
    isConcurrencySafe: () => true,

    async execute(rawArgs, exec) {
      // 「绝不 throw」是契约的承载条件（B24）：意外异常收敛成 `internal` 失败。
      try {
        return await discover(rawArgs as ListInstancesArgs, exec.signal, deps, signatureFetch)
      } catch (error) {
        return toOutput(
          fail(toToolError(error, 'listing DSH hosts on this machine'), {
            verdict:
              'no instances were listed: this tool threw before it produced a result, so nothing is known about which hosts are up — this is a failure of this plugin rather than a finding',
            key: {},
            audit: {},
          }),
        )
      }
    },
  })
}

/** 主流程（`execute` 的可抛内核；外层统一兜住异常）。 */
async function discover(
  args: ListInstancesArgs,
  signal: AbortSignal,
  deps: ToolDeps,
  signatureFetch: SignatureFetch,
): Promise<JsonValue> {
  const budget = toolBudgetMs(WORKLOAD, deps.config)
  // ⚠️ **截止线画在「传输预算」上，不是工具预算上**（2026-10-14 端到端实测逼出来的）：
  // 传输层在 `budget − TRANSPORT_MARGIN_MS`（默认 60 s − 2 s = 58 s）就切了，而那 2 s 余量
  // 本来就是留给本插件**把结果结构化再返回**的。原先这里用 `budget` ⇒ 循环可以一直跑到
  // 工具预算，可传输会先断 ⇒ **模型拿到的是裸超时，不是结构化输出**。
  // 本工具的耗时是「扫描 + N 条探测」，正是最吃这条余量的形状。
  const deadline = createDeadline(transportTimeoutMs(budget), deps.now)

  const explicit = explicitPort(args.port)
  const scan = await gatherCandidates(explicit, signal, deps, deadline, budget)

  // 取消优先于一切：调用方放弃时不该继续发请求。
  if (signal.aborted) {
    return toOutput(
      fail(
        { kind: 'cancelled', message: 'the caller cancelled this execution' },
        {
          verdict:
            'nothing was listed: the caller cancelled this execution, so no candidate was probed',
          key: toKey(scan.status, scan.unidentified, scan.truncated, scan.detail, []),
          audit: asAudit({ scan }),
        },
        {
          manual: true,
          why: 'cancellation is up to the caller; retrying the same call is pointless',
        } satisfies NextStep,
      ),
    )
  }

  // 扫不了、又没给 port ⇒ 连候选都形不成：**不许**报成「没有实例」（三值纪律）。
  if (scan.status === 'unavailable') {
    return toOutput(
      fail(
        {
          kind: 'not-configured',
          message: `cannot list listening ports on this platform: ${scan.detail}`,
        },
        {
          verdict: `nothing was listed: this machine's listening ports could not be read (${scan.detail}), so whether any DSH host is up is unknown rather than empty — pass a port to check one directly`,
          key: toKey(scan.status, scan.unidentified, scan.truncated, scan.detail, []),
          audit: asAudit({ scan }),
        },
        {
          manual: true,
          why: 'listing listening ports needs a socket-table command on PATH; with a port argument this tool can still check that one port',
        },
      ),
    )
  }

  const instances: InstanceKey[] = []
  // **有界并发 + 每条探测独立上限**（`PROBE_TIMEOUT_MS` 里写着为什么必须独立）。
  //
  // 原写法是「串行 + 每条拿 `budgetFor(budget, deadline)`（剩余总预算）」：本机实测 37 个
  // 回环监听端口里 **9 个接受连接但永不回话** ⇒ 第一个这样的端口就把剩余总预算吃光，
  // 整次调用超时（真机上真观察到 15 s 全丢）。串行即使给了上限也要 29.6 s（37 × 800 ms），
  // 而并行只要 833 ms —— 所以两处一起改，而不是只调大预算。
  for (let index = 0; index < scan.candidates.length; index += PROBE_CONCURRENCY) {
    if (deadline.expired()) break
    const wave = scan.candidates.slice(index, index + PROBE_CONCURRENCY)
    const probed = await Promise.all(
      wave.map((candidate) =>
        probeCandidate(candidate, {
          fetch: signatureFetch,
          // 上限取「独立上限」与「剩余总预算」的较小者：前者保证一个挂住的候选不拖垮别人，
          // 后者保证整次调用不越过工具预算。
          timeoutMs: Math.min(PROBE_TIMEOUT_MS, budgetFor(budget, deadline)),
          signal,
        }),
      ),
    )
    // `Promise.all` 保序 ⇒ 输出顺序与候选顺序一致，与串行版逐字相同。
    instances.push(...probed)
  }
  if (signal.aborted) {
    return toOutput(
      fail(
        { kind: 'cancelled', message: 'the caller cancelled this execution' },
        {
          verdict: `nothing was concluded: the caller cancelled while ${String(instances.length)} of ${String(scan.candidates.length)} candidate(s) had been probed`,
          key: toKey(scan.status, scan.unidentified, scan.truncated, scan.detail, instances),
          audit: asAudit({ scan, instances }),
        },
        {
          manual: true,
          why: 'cancellation is up to the caller; retrying the same call is pointless',
        } satisfies NextStep,
      ),
    )
  }

  const key = toKey(scan.status, scan.unidentified, scan.truncated, scan.detail, instances)
  const dsh = instances.filter((item) => item.verdict === 'dsh')
  const step = nextStepFor(dsh, instances)
  const data = { verdict: verdictFor(key, dsh), key, audit: asAudit({ scan, instances }) }
  return toOutput(step === undefined ? ok(data) : ok(data, step))
}

/** 规整 `port` 参数：非正整数 / 越界 = 没给。 */
function explicitPort(raw: number | undefined): number | undefined {
  if (raw === undefined) return undefined
  return Number.isSafeInteger(raw) && raw > 0 && raw <= 65535 ? raw : undefined
}

/** 候选从哪来：给了 `port` 就只探它（**不扫**，状态是 `skipped`）。 */
async function gatherCandidates(
  explicit: number | undefined,
  signal: AbortSignal,
  deps: ToolDeps,
  deadline: ReturnType<typeof createDeadline>,
  budget: number,
): Promise<{
  status: ScanStatus
  candidates: ListenerCandidate[]
  unidentified: number
  truncated: boolean
  detail: string
}> {
  if (explicit !== undefined) {
    return {
      status: 'skipped',
      candidates: [{ port: explicit }],
      unidentified: 0,
      truncated: false,
      detail: 'not scanned: a port was given, so only that port is probed',
    }
  }
  const scan = await listListeners({
    spawn: deps.spawn,
    timeoutMs: budgetFor(budget, deadline),
    signal,
  })
  if (!scan.probed) {
    return {
      status: 'unavailable',
      candidates: [],
      unidentified: 0,
      truncated: false,
      detail: scan.detail,
    }
  }
  const ordered = orderCandidates(scan.candidates)
  return {
    status: 'scanned',
    candidates: ordered.slice(0, MAX_CANDIDATES),
    unidentified: scan.unidentified,
    truncated: ordered.length > MAX_CANDIDATES,
    detail: scan.detail,
  }
}

/**
 * 把 socket 表规整成候选：**按端口去重** + **按端口升序** + 截到上限。
 *
 * 两条都是真机端到端实测逼出来的（2026-10-14）：
 *
 * 1. **去重**：`Get-NetTCPConnection` 对双栈监听会**同一端口返回两行**（IPv4 + IPv6），
 *    本机实测 63 行只有 52 个唯一端口 ⇒ 不去重的话 24 个探测位里 **16 个浪费在 8 个
 *    端口上**（每个探两遍）。
 * 2. **定序**：原来的顺序就是 `Get-NetTCPConnection` 的返回顺序，而它是**降序**的
 *    （49724 → 135）⇒ **低端口排在最后**，于是默认端口 3080 被截断挡在外面。
 *    升序不是「更可能命中」的保证，而是**确定性的**：同一张表两次读出同一个候选序
 *    （本仓坑 22：定序必须写死，否则结论会随遍历顺序漂）。
 *
 * ⚠️ 它仍然**只是启发式**：真 DSH 若绑在一个排得很后的端口上，照样会被截断挡住 ——
 * 所以**截断时必须说出来**（{@link verdictFor} 不许在这种情况下说「没有 DSH」）。
 *
 * @param candidates 原始候选（可能重复、顺序不定）。
 */
function orderCandidates(candidates: readonly ListenerCandidate[]): ListenerCandidate[] {
  const byPort = new Map<number, ListenerCandidate>()
  for (const candidate of candidates) {
    if (!byPort.has(candidate.port)) byPort.set(candidate.port, candidate)
  }
  return [...byPort.values()].sort((left, right) => left.port - right.port)
}

/** 探一个候选：回环 + 未认证 `GET /` + 逐字签名。 */
async function probeCandidate(
  candidate: ListenerCandidate,
  deps: { fetch: SignatureFetch; timeoutMs: number; signal: AbortSignal | undefined },
): Promise<InstanceKey> {
  // **一律回环**：候选端口可能绑在局域网上，但我们只从本机敲。
  const authority = `127.0.0.1:${String(candidate.port)}`
  const probed = await probeSignature(`http://${authority}/`, deps)
  return {
    authority,
    verdict: probed.verdict,
    ...(candidate.pid === undefined ? {} : { pid: candidate.pid }),
    ...(candidate.processName === undefined ? {} : { processName: candidate.processName }),
    ...(probed.status === undefined ? {} : { status: probed.status }),
    detail: probed.detail,
  }
}

/**
 * 发一次未认证 `GET /` 并判签名。
 *
 * **不抛**：失败收敛成 `unknown`（与 `lib/http.ts` 同一条纪律，只是这里要多读 body）。
 */
async function probeSignature(
  url: string,
  deps: { fetch: SignatureFetch; timeoutMs: number; signal: AbortSignal | undefined },
): Promise<{ verdict: InstanceVerdict; status?: number; detail: string }> {
  if (deps.signal?.aborted === true) {
    return {
      verdict: 'unknown',
      detail: 'the caller cancelled this probe before any request was sent',
    }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new Error('transport-timeout'))
  }, deps.timeoutMs)
  const relay = (): void => {
    controller.abort(deps.signal?.reason)
  }
  deps.signal?.addEventListener('abort', relay, { once: true })
  try {
    const response = await deps.fetch(url, { signal: controller.signal, redirect: 'manual' })
    let body = ''
    try {
      body = await response.text()
    } catch {
      // body 读不出来 ⇒ 判据不完整 ⇒ **unknown**（不是 other：我们并不知道它是什么）。
      return {
        verdict: 'unknown',
        status: response.status,
        detail: 'the response body could not be read, so the DSH signature cannot be checked',
      }
    }
    if (response.status === 401 && body === DSH_UNAUTHORIZED_BODY) {
      return {
        verdict: 'dsh',
        status: 401,
        detail: 'unauthenticated GET / returned the DSH signature',
      }
    }
    return {
      verdict: 'other',
      status: response.status,
      detail:
        response.status === 401
          ? 'it answered 401, but the body is not the DSH signature'
          : `it answered ${String(response.status)}, which is not the DSH signature`,
    }
  } catch (error) {
    return { verdict: 'unknown', detail: `could not probe it (${describeThrown(error)})` }
  } finally {
    clearTimeout(timer)
    deps.signal?.removeEventListener('abort', relay)
  }
}

/** 把抛出的异常压成一句（模型可见，所以英文）。 */
function describeThrown(error: unknown): string {
  const code = systemErrorCodeOf(error)
  if (code !== undefined) return code
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('transport-timeout') ? 'transport timed out' : message
}

/** 从异常里取 `code`（`ECONNREFUSED` 这类）；取不到返回 `undefined`。 */
function systemErrorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/** 把扫描与结论投影进 `key`。 */
function toKey(
  status: ScanStatus,
  unidentified: number,
  truncated: boolean,
  detail: string,
  instances: readonly InstanceKey[],
): ListInstancesKey {
  return {
    scan: { status, unidentified, truncated, detail },
    instances: [...instances],
  }
}

/**
 * 拼 L1。
 *
 * 四档分开写，因为它们对下一步的决定不同：
 * - **有认领成功的** → 直接给出 authority，并说它可以喂给 `dsh_check_auth`；
 * - **一个都没认领到、且候选表被截断** → ⚠️ **不许**说「no DSH host was found」：
 *   还有候选**没查过**，所以只能说「探过的那批里没有」；
 * - **一个都没认领到、但都探过** → 才能说「探过了、都不是」；
 * - **全是没探到** → **不许**说成「没有 DSH」（三值纪律）。
 *
 * ⚠️ 第二档是**真机端到端实测逼出来的**（2026-10-14）：本机 socket 表 63 行 / 52 个唯一端口、
 * 上限 24 时，真正在跑的那个 DSH（`127.0.0.1:3080`）排在下标 58 ⇒ 它报
 * 「no DSH host was found」，而**那台宿主此刻就在服务**。把「没查完」印成「没有」
 * 正是本工具文件头警告的那条三值违规。
 *
 * @param key 本次的 `key`。
 * @param dsh 认领成功的那些。
 */
function verdictFor(key: ListInstancesKey, dsh: readonly InstanceKey[]): string {
  if (dsh.length > 0) {
    const more = key.scan.truncated
      ? ' (the candidate list was truncated, so there may be more)'
      : ''
    return (
      `found ${String(dsh.length)} DSH host(s) on this machine: ` +
      `${dsh.map((item) => item.authority).join(', ')} — pass one to dsh_check_auth as host:port; ` +
      `discovery gives an authority only, never a DSH_HOME${more}`
    )
  }
  const probed = key.instances.filter((item) => item.verdict !== 'unknown').length
  if (probed === 0) {
    const truncated = key.scan.truncated ? ' (the candidate list was truncated)' : ''
    return (
      `nothing could be probed: ${String(key.instances.length)} listening port(s) were found but every probe failed, ` +
      `so whether any of them is a DSH host is unknown rather than absent${truncated}`
    )
  }
  if (key.scan.truncated) {
    // ⚠️ 这一档**不能**说「no DSH host was found」—— 还有候选根本没探。
    return (
      `none of the ${String(probed)} probed listening port(s) returned the DSH signature, but the candidate list ` +
      `was truncated, so additional listening port(s) were never examined: this is "not found among those probed", ` +
      `not "there is none on this machine" — pass a port to check one directly`
    )
  }
  return (
    `no DSH host was found: ${String(probed)} listening port(s) answered and none returned the DSH signature — ` +
    `other services on this machine are not instances`
  )
}

/**
 * 挑下一步。
 *
 * 认领成功时指向 `dsh_check_auth`：那正是发现的**去路**（它的参数是 authority）。
 * `args` 里的每个值都必须在模型看得见的地方出现（B17）—— `port` 与 `host` 都在
 * L2 的 `instance:` 行的 authority 里。
 *
 * @param dsh 认领成功的那些。
 * @param instances 全部候选。
 */
function nextStepFor(
  dsh: readonly InstanceKey[],
  instances: readonly InstanceKey[],
): NextStep | undefined {
  const first = dsh[0]
  if (first !== undefined) {
    return {
      tool: 'dsh_check_auth',
      args: { host: '127.0.0.1', port: Number(first.authority.split(':')[1]) },
      why: 'confirm this authority is up and see whether it needs authentication before deciding anything else',
    }
  }
  if (instances.length === 0) return undefined
  return {
    manual: true,
    why: 'no DSH host answered the signature on a loopback port; if the instance you want runs elsewhere, point the file tools at its DSH_HOME instead',
  }
}

/**
 * 把 `key` 投影成 L2 的逐行文本。
 *
 * 排序即输出顺序：**先「扫到了什么」**（覆盖完整性），**再逐个候选的三值结论**。
 * 恒定知识不在这里：签名的形状与「只给 authority」都住在描述层边界段。
 *
 * @param key 本次的 `key`。
 */
function keyText(key: ListInstancesKey): string[] {
  // 渲染层**绝不抛**（`render.ts` 的纪律）：兜底里 `key` 是 `{}`。
  if (!key || typeof key !== 'object') return [GUARD_FALLBACK_LINE]
  const lines: string[] = [scanLine(key.scan)]
  if (!Array.isArray(key.instances)) {
    lines.push('instances: unknown (the guard synthesized this result)')
    return lines
  }
  for (const item of key.instances) lines.push(instanceLine(item))
  lines.push(`dsh: ${String(key.instances.filter((item) => item.verdict === 'dsh').length)}`)
  return lines
}

/**
 * `scan:` 那一行。
 *
 * 三态原样印出来：`skipped`（给了 port、没扫）与 `unavailable`（扫不了）都不是
 * 「一个都没有」—— 压成一句 `probed=no` 就是三值纪律里那个「把不知道印成没有」。
 *
 * @param scan `key.scan`（可能是兜底合成的 `undefined`）。
 */
function scanLine(scan: ListInstancesKey['scan'] | undefined): string {
  if (!scan || typeof scan !== 'object') {
    return 'scan: unknown (the guard synthesized this result)'
  }
  const extra = scan.truncated === true ? ' truncated=yes' : ''
  return `scan: ${scan.status} unidentified=${String(scan.unidentified)}${extra}`
}

/** 一个候选一行：authority + 三值结论 + 能读到的进程信息。 */
function instanceLine(item: InstanceKey): string {
  const pid = item.pid === undefined ? '' : ` pid=${String(item.pid)}`
  const name = item.processName === undefined ? '' : ` name=${item.processName}`
  const status = item.status === undefined ? '' : ` status=${String(item.status)}`
  return `instance: ${item.authority} ${item.verdict}${pid}${name}${status}`
}

/** 兜底行：`ensureToolResult` 合成的结果里 `key` 是 `{}`。 */
const GUARD_FALLBACK_LINE = 'scan: unknown (the guard synthesized this result)'

/** 把一个只读记录转成 `audit` 的契约类型 `JsonValue`（同 `shared.ts` 的 `toOutput` 理由）。 */
function asAudit(value: unknown): JsonValue {
  return value as JsonValue
}
