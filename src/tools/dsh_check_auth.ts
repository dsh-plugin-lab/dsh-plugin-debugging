/**
 * `dsh_check_auth` —— 分开「连接被拒（没启动）」与「401（服务在、认证没过）」。
 *
 * 对应 SKILL §3.3 / §3.4。这是本工具**唯一**要回答的问题，因为两者的下一步完全相反：
 * 前者去启动宿主；后者只能**换一条真能区分的路**（在浏览器里打开同一个 authority 看是不是
 * 也 401）。**本工具的探测不带凭据**，所以它拿到的 401 是**匿名 401** —— 对「存的凭据还有没有效」
 * 零信息，**不许**由它推出「authority 不匹配」这类结论（旧文案正是这么编的，已删）。
 * cookie 绑定 `host:port`、30 天不滑动这些机制事实见 SKILL §3.3。
 *
 * ## 这一版（W2）的三处形状改造 —— 见 docs/SHAPE.md §2 / §3 / §4
 *
 * 1. **描述改四段并导出**（`CHECK_AUTH_DESCRIPTION`，红线 B20a 直接 import）。
 * 2. **`data` 顶层恰好 `{ verdict, key, audit }`**：失败分支的「所以呢」只能由
 *    `data.verdict` 承载 —— 新契约里 `error.message` **不进模型文本**（§4.1 字段角色表），
 *    所以每一条失败分支都写了实质判定句，而不是只写 `failed`。
 * 3. **旧 `error.hint` 与旧 `error.evidence` 都删了**，内容各有唯一的家：
 *    - 「browser-session 条目在不在」是**本次观测** → `key.credentials`（401 那条路上）；
 *    - 「v1 只判存在性、不读值、不自签 cookie」是**恒定知识** → 描述层的边界段，写一次。
 *    一处一事实：同一句话不再既藏在 hint 里又出现在输出里。
 * 4. **`execute` 绝不 throw**（B24）：意外异常在顶层收敛成 `internal` 失败。
 *    这是**契约的承载条件**，不是风格 —— 抛出去的异常会被宿主包成一句裸 `Error: <message>`，
 *    `verdict` / `key` / `audit` 全部失效，而且没有任何红线会报警（见 docs/SHAPE.md §4）。
 *    这条路径上真会抛的一环是 `resolvePort` 读 `env`（`fetch` 那条路由 `lib/http.ts` 自己收敛）。
 *
 * v1 的边界（决策 D4/D5）：**只报** `.credentials.yaml` 里
 * `client-connection/browser-session` 条目**在不在**，
 * **不提取密钥、不读值、不自签 cookie** —— 那是 v1.1。返回值里没有任何秘密。
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import { fail, ok, toToolError, type JsonValue } from '../lib/errors.js'
import { budgetFor, createDeadline, toolBudgetMs, type Workload } from '../lib/timeouts.js'
import { readCredentialsPresence, type CredentialsPresence } from '../lib/credentials.js'
import { probeHttp, type HttpProbeKind, type HttpProbeResult } from '../lib/http.js'
import { credentialsPath } from '../lib/profile.js'
import type { ResolvedConfig } from '../contracts.js'
import type { RenderTable } from '../lib/render.js'
import { composeDescription, type ToolDescription } from './describe.js'
import {
  authorityLine,
  guardKeyLines,
  asAudit,
  assertResolvedDshHome,
  CANCELLED_WHY,
  effectiveConfig,
  resolvePort,
  resolvedLine as sharedResolvedLine,
  toOutput,
  toolOutput,
  type EffectiveConfigBlock,
  type ToolDeps,
} from './shared.js'

/** 工具名。 */
export const CHECK_AUTH_TOOL = 'dsh_check_auth'

/** 本工具的工作量档：一次 HTTP 探测 + 读一个文件，**快档**。 */
const WORKLOAD: Workload = 'quick'

/** 让用户/模型去查宿主到底起没起、端口对不对的那一步。 */
const DIAGNOSE_TOOL = 'dsh_diagnose_plugin_load'

/** 参数。 */
interface CheckAuthArgs {
  port?: number
  host?: string
}

/**
 * 探测结果在 `key` 里的投影。
 *
 * `detail` **不进这里**（它进 `audit`）：那是给人读的一句解释，按 `kind` 恒定，
 * 模型要的是 `kind` 这个机器码；而恒定文本进 L2 会撞红线 B16（同一种 kind 的
 * 两份 fixture 会印出逐字相同的长行）。
 */
interface ProbeKey {
  kind: HttpProbeKind
  status?: number
  location?: string
}

/**
 * `key`：下一个决定可能要用到的原料。
 *
 * 判据（SHAPE §5）：**模型看不到它，会不会做出不同的下一步？**
 */
interface CheckAuthKey {
  /**
   * 这次探测的 authority（`host:port`，宿主**逐字匹配**的那个串）。
   *
   * 端口没定出来时整条不出现 —— 那时什么都没探测，给一个 `:0` 冒充会让人以为探过了。
   */
  authority?: string
  /** 探测的完整 URL。 */
  url?: string
  /** 探测结论的机器码（下一个决定的第一判据：没启动 vs 401 vs 超时）。 */
  probe?: ProbeKey
  /**
   * 这次调用实际用的是哪份配置。
   *
   * 端口来源（参数 / 配置 / env）会给出**不同的 authority**，而 authority 又直接决定
   * 「401」还是「连不上」，所以来源必须可见。
   */
  resolved: EffectiveConfigBlock
  /**
   * 凭证文件的**存在性**报告 —— 只在 **401** 那条路上出现。
   *
   * ⚠️ 它是一条**观测事实**，**不是**判定依据：本工具的探测不带凭据，条目在不在
   * **不改变** 401 的 verdict 与 nextStep（那两处因此都不按它分叉）。它进 `key` 是因为
   * 模型/人要拿它去**自己判断**下一步（有没有可用的登录态），而不是让本工具替它下结论。
   * 它在成功路径上是噪声（§5 的判据：模型看不到它也不会换下一步）。
   * `file` / `line` 都在里面 —— 「文件在不在、哪一行」是 401 排查的原料。
   */
  credentials?: CredentialsPresence
}

/**
 * 本工具的描述（SHAPE §2.1 四段骨架）。
 *
 * 逐段理由：
 * - `what`：动词 + 对象 —— 唯一的「分开两档」。
 * - `useWhen`：模型的路由信号（页面 401；或根本不知道宿主起没起）。这两句是旧的
 *   description 里唯一承重的部分，其余（输出结构复述）删掉。
 * - `boundary`：**两行**，承载从输出里搬出来的恒定知识：① v1 只判存在性、不读值、
 *   不自签 cookie，**也不发送任何凭据** —— 措辞是「不读秘密的**值**」而不是「不读秘密」：
 *   401 那条路上本工具**确实会读** `.credentials.yaml` 判条目在不在（只取布尔与行号），
 *   说「no secrets read」是**说过头**；② cookie 绑定 `host:port` 这个机制 —— 但**只对
 *   「带着 cookie 的浏览器页面」成立**：本工具的探测是匿名的，它那条 401 推不出
 *   「authority 变了」。旧文案写的是「A 401 usually means the authority changed」，
 *   那正是把不知道说成结论（与 L1 同批改掉）。
 *   观察类工具没有「代价段」，所以两行边界 + 两行前置 = 合成后仍是四行。
 */
export const CHECK_AUTH_DESCRIPTION: ToolDescription = {
  what: 'Separates "not running" from "not authenticated".',
  useWhen: 'Use when a page returns 401, or the host may be down.',
  boundary:
    'Read-only: no secret values read, no cookies signed or sent.\nA page 401 can mean a changed authority: cookies are bound to host:port.',
}

/** 输出表：L1 就是 `data.verdict` 逐字，L2 由 `key` 投影成行。 */
const TABLE: RenderTable<CheckAuthKey> = { key: (data) => keyText(data.key) }

/**
 * 造工具。
 *
 * @param deps 运行期依赖。
 */
export function createCheckAuthTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: CHECK_AUTH_TOOL,
    description: composeDescription(CHECK_AUTH_DESCRIPTION),
    parameters: {
      port: {
        type: 'integer',
        description: 'Host port; omit for the configured one.',
      },
      host: {
        type: 'string',
        description: 'Hostname; default 127.0.0.1, matched literally.',
      },
    },
    output: toolOutput(CHECK_AUTH_TOOL, TABLE),

    timeoutMs: toolBudgetMs(WORKLOAD, deps.config),
    isConcurrencySafe: () => true,

    async execute(rawArgs, exec) {
      try {
        return await probeAuthentication(rawArgs as CheckAuthArgs, exec.signal, deps)
      } catch (error) {
        // 顶层兜底：**`execute` 绝不 throw** 是契约的承载条件（SHAPE §4）。
        // 一旦抛出去，宿主把它包成一句裸 `Error: <message>` —— 模型拿到的结果里
        // `verdict` / `key` / `audit` 全部消失，失败形状当场失效，而且没有任何红线
        // 会报警（`toOutput()` 的形状守卫在**抛出**的那条路上根本走不到）。
        // 这条路径上真会抛的一环是 `resolvePort` 读 `env`（注入替身里唯一**没有**
        // 自己 catch 的 IO 口）；`fetch` 那条路由 `lib/http.ts` 自己收敛。
        return toOutput(
          fail(toToolError(error, 'probing whether the host is up and authenticated'), {
            verdict:
              'nothing was probed: this check threw before it could reach the host, so neither the listener nor authentication was judged — this is a failure of this plugin rather than a verdict about authentication',
            key: {},
            audit: {},
          }),
        )
      }
    },
  })
}

/**
 * 主流程（`execute` 的**可抛内核**；外层统一兜住异常）。
 *
 * 为什么把它拿出来：`execute` 只剩「跑一次 + 兜住意外」两件事，兜底那一层因此
 * 不可能被业务分支挤到后面去 —— B24 要的就是「这条路径最后永远有一个 catch」。
 *
 * @param args 调用参数。
 * @param signal 调用方信号（`exec.signal` 原样透传到 IO）。
 * @param deps 运行期依赖。
 */
async function probeAuthentication(
  args: CheckAuthArgs,
  signal: AbortSignal,
  deps: ToolDeps,
): Promise<JsonValue> {
  const deadline = createDeadline(toolBudgetMs(WORKLOAD, deps.config), deps.now)

  const missing = assertResolvedDshHome(deps.config)
  if (missing !== undefined) return toOutput(missing)

  const resolvedPort = resolvePort(args.port, deps.config.port, deps.env)
  if (resolvedPort === undefined) {
    return toOutput(
      fail(
        {
          kind: 'not-configured',
          message: 'cannot determine a port, so authentication cannot be probed',
        },
        {
          // 失败分支也有 L1：这句话是模型唯一能读到的「所以呢」。
          verdict:
            'no port could be determined, so nothing was probed — pass a port, set it in the plugin config, or run where DSH_WEB_URL is set',
          // 三条来源都没有：`port=null` + `portSource=none` 本身就是本次观测。
          // ⚠️ 不能直接写 `effectiveConfig(config, undefined)` —— 那个默认参数会把
          // `undefined` 当成「这次用不到端口」（`not-used`），而这里恰恰是**要用却都没有**
          // （`none`）。两者语义不同，所以在这条路上显式覆盖，不借默认值。
          key: { resolved: unresolvedPortConfig(deps.config) },
          audit: {},
        },
        {
          // **用户动作，不套工具名**：此刻没有任何**已观测到的**端口可指（B17 的例外正对准这种情形），
          // 而 `why` 的前提是「once you know which one」—— 模型此刻**不知道**端口。
          // 套上工具名会让模型逐字重调本工具、拿到**同一个** `not-configured`：
          // 那是个**不动点**（死路），正是 SHAPE §4.1 禁止的「带工具名却不产生新信息」。
          // 确定端口是**人的动作**（看监听端口 / 改插件配置 / 设 `DSH_WEB_URL`）。
          manual: true,
          why: 're-run this check with an explicit port once you know which one the host listens on',
        },
      ),
    )
  }

  const host = args.host ?? '127.0.0.1'
  const authority = `${host}:${String(resolvedPort.port)}`
  const url = `http://${authority}/`
  const resolved = effectiveConfig(deps.config, resolvedPort)

  const probe = await probeHttp(url, budgetFor(toolBudgetMs(WORKLOAD, deps.config), deadline), {
    fetch: deps.fetch,
    signal,
  })

  // 凭证文件**只在 401 那条路上读**：那是唯一「有没有登录态」会影响**人**下一步的场景。
  // ⚠️ 读它**只为陈述事实**（`key.credentials` 会渲染成 L2 的一行），**不参与判定** ——
  // 本工具没发凭据，条目在不在都不改变 401 的 verdict / nextStep。
  // 顺带的好处是「没启动 / 超时 / 取消」三条路一次多余的文件 IO 都不做。
  const credentials =
    probe.kind === 'unauthorized'
      ? await readCredentialsPresence(credentialsPath(deps.config.dshHome))
      : undefined

  const key: CheckAuthKey = {
    authority,
    url,
    probe: toProbeKey(probe),
    resolved,
    ...(credentials === undefined ? {} : { credentials }),
  }
  // `audit` 是给人复核的那一半（不进模型文本）：原始 detail、完整配置块、凭证原样。
  const audit = asAudit({
    authority,
    url,
    probe,
    resolved,
    ...(credentials === undefined ? {} : { credentials }),
  })
  const verdict = verdictOf(probe, authority)

  if (probe.kind === 'timeout') {
    return toOutput(
      fail(
        { kind: 'timeout', message: probe.detail },
        { verdict, key, audit },
        {
          tool: CHECK_AUTH_TOOL,
          // `authority` 出现在 L2，所以 B17 认得出这两个值。
          args: { port: resolvedPort.port, host },
          why: 'retry once as-is; if it keeps timing out, a human must raise the plugin config timeoutMs — a call cannot raise it',
        },
      ),
    )
  }
  if (probe.kind === 'not-running') {
    return toOutput(
      fail(
        {
          kind: 'not-running',
          message: `cannot connect to ${authority}: ${probe.detail}`,
        },
        { verdict, key, audit },
        {
          tool: DIAGNOSE_TOOL,
          args: { port: resolvedPort.port },
          why: 'look up the listener by port and read the startup logs to see whether the host is up at all',
        },
      ),
    )
  }
  if (probe.kind === 'cancelled') {
    return toOutput(
      fail(
        { kind: 'cancelled', message: probe.detail },
        { verdict, key, audit },
        {
          manual: true,
          why: CANCELLED_WHY,
        },
      ),
    )
  }
  if (probe.kind === 'unauthorized') {
    return toOutput(
      fail(
        {
          kind: 'auth',
          message: `${authority} returned 401 — the service is up and this request arrived unauthenticated (not "not running")`,
        },
        { verdict, key, audit },
        {
          // 出路只有一条，而且只能由**人**做：本工具没发凭据，区分不了「登录态过期」与
          // 「authority 不对」；在浏览器里打开同一个 authority 才区分得开。
          // （v1.1 会自签 cookie 自己试一次，那时这一步可以自动化 —— 现在不做。）
          // ⚠️ 这里**不许**按 `credentials` 分叉：条目在不在不改变本次探测观测到的事实。
          manual: true,
          why: 'open this exact authority in the browser and see whether it also returns 401: that separates a stale session from a changed authority, and this credential-free probe cannot',
        },
      ),
    )
  }

  return toOutput(
    ok(
      { verdict, key, audit },
      probe.kind === 'http-error'
        ? {
            tool: DIAGNOSE_TOOL,
            args: { port: resolvedPort.port },
            why: 'the host answered, so find out what process is on that port before concluding anything about authentication',
          }
        : undefined,
    ),
  )
}

/**
 * 一句话结论（L1）。
 *
 * **成功失败都必填**，而且每句都要能回答「所以呢」—— 新契约里 `error.message` 不进模型
 * 文本，所以这一行是失败分支唯一的判定行。
 *
 * ⚠️ **401 那一档故意不接收 `credentials`**：本工具的探测不带凭据，那条 401 是**匿名 401**
 * （服务在、要鉴权），对「存的凭据有没有效 / authority 对不对」**零信息**。旧文案按
 * 「有没有授权记录」分叉，等于**把不知道说成结论**；现在改成一句与凭据无关的判定，
 * 事实（条目在不在）只留在 `key.credentials` 里**陈述**，不参与推论。
 *
 * @param probe 探测结果。
 * @param authority 本次探测的 authority。
 */
function verdictOf(probe: HttpProbeResult, authority: string): string {
  switch (probe.kind) {
    case 'ok':
      return `the service at ${authority} is up and this request was accepted, so authentication is not what is failing here`
    case 'unauthorized':
      return `the service at ${authority} is up and requires authentication (401); this check sends no credentials, so it cannot tell whether any stored browser-session grant is valid`
    case 'not-running':
      return `nothing is listening on ${authority}, so no authentication verdict exists — the host is down, or it moved to another port`
    case 'timeout':
      return `the probe of ${authority} timed out, so whether the host is up is unknown — this is not evidence of a 401`
    case 'cancelled':
      return `the caller cancelled the probe of ${authority}, so no verdict was reached — this says nothing about the host or its credentials`
    case 'http-error':
      return `the service at ${authority} is up but answered with neither 2xx/3xx nor 401, so "not running" is ruled out while authentication is not the whole story`
  }
}

/**
 * 把探测结果投影成 `key.probe`（只留机器码与两个可选字段）。
 *
 * @param probe 探测结果。
 */
function toProbeKey(probe: HttpProbeResult): ProbeKey {
  return {
    kind: probe.kind,
    ...(probe.status === undefined ? {} : { status: probe.status }),
    ...(probe.location === undefined ? {} : { location: probe.location }),
  }
}

/**
 * 「要用端口、但三条来源都没有」那份生效配置块。
 *
 * 为什么不直接 `effectiveConfig(config, undefined)`：那个函数的默认参数会把 `undefined`
 * 落成 `'not-used'`（= 这次调用用不到端口），而这里的事实是 `'none'`（= 要用，但参数 /
 * 配置 / env 三条来源都空）。两个值语义相反，混用就是「看着成功、其实说的是另一回事」。
 *
 * @param config 已补齐默认值的配置。
 */
function unresolvedPortConfig(config: ResolvedConfig): EffectiveConfigBlock {
  return { ...effectiveConfig(config), port: null, portSource: 'none' }
}

/**
 * 把 `key` 投影成 L2 的逐行文本。
 *
 * 顺序即输出顺序：**先框架（读了哪份配置、探的是哪个 authority），再观测**。
 * 每一条都是「本次非默认」的：`authority` / `probe` 在没探测时不出现，`credentials`
 * 只在 401 那条路上出现。
 *
 * @param key 本次的 `key`。
 */
function keyText(key: CheckAuthKey): string[] {
  // 渲染层**绝不抛**（`render.ts` §3.1）：守卫合成的兜底里 `data.key` 是 `{}`。
  // 「key 不是对象时印什么」的唯一判定在 shared.ts 的 guardKeyLines —— **不许静默返回空数组**。
  const fallback = guardKeyLines(key)
  if (fallback !== undefined) return fallback
  const lines: string[] = [resolvedLine(key.resolved)]
  const authority = authorityLine(key.authority)
  if (authority !== undefined) lines.push(authority)
  if (key.probe !== undefined) lines.push(probeLine(key.probe))
  if (key.credentials !== undefined) lines.push(credentialsLine(key.credentials))
  return lines
}

/**
 * 兜底行：`ensureToolResult` 合成的结果里 `key` 是 `{}`。
 *
 * 为什么**必须**印出来而不是省略整行：这条路径只在「工具自己返回了坏形状」时才走到 ——
 * 那一刻模型最该知道的事实正是「这个结果是守卫合成的，里面的字段都不可信」。
 * 省略这一行会让兜底**静默**（看起来像一次正常的空结果）。
 *
 * 逐字常量现住在 `shared.ts`（此前是五个工具各抄一份，抄漏无判据照得出）。
 */

/**
 * `resolved:` 那一行（与 `dsh_diagnose_plugin_load` 同格式：模型在两个工具之间读的是同一张脸）。
 *
 * 字段一律按 `typeof` 防御取值：兜底合成的 `key` 里整块 `resolved` 都不在，
 * 直接取字段会当场抛（这正是本工具过去在兜底路径上崩掉的原因）。
 *
 * @param resolved 生效配置块（可能是兜底合成的 `undefined`）。
 */
function resolvedLine(resolved: EffectiveConfigBlock | undefined): string {
  // 格式、字段顺序与兜底由 `shared.ts` 的唯一渲染点定；本工具涉及端口。
  return sharedResolvedLine(resolved, {
    port: resolved?.port ?? null,
    source: resolved?.portSource ?? 'none',
  })
}

/**
 * `probe:` 那一行。
 *
 * **故意不带 `detail`**：它是按 `kind` 恒定的解释句，进 L2 会让同一种 kind 的两份
 * fixture 印出逐字相同的长行（红线 B16 的假红来源）。结论已经在 `verdict:` 行里。
 *
 * @param probe `key.probe`。
 */
function probeLine(probe: ProbeKey): string {
  const status = probe.status === undefined ? '' : ` status=${String(probe.status)}`
  const location = probe.location === undefined ? '' : ` location=${probe.location}`
  return `probe: ${probe.kind}${status}${location}`
}

/**
 * `credentials:` 那一行。
 *
 * 四个字段都是**布尔/行号**，`file` 是路径 —— 任何密钥值都不会出现在这里
 * （`lib/credentials.ts` 的返回值里就没有值可带）。
 *
 * @param credentials 凭证存在性报告。
 */
function credentialsLine(credentials: CredentialsPresence): string {
  const line = credentials.line === undefined ? '' : ` line=${String(credentials.line)}`
  return (
    `credentials: exists=${String(credentials.exists)}` +
    ` clientConnectionPresent=${String(credentials.clientConnectionPresent)}` +
    ` browserSessionPresent=${String(credentials.browserSessionPresent)}` +
    ` file=${credentials.file}${line}`
  )
}
