/**
 * `dsh_sign_cookie` —— 用本机 `.credentials.yaml` 里的持久签名密钥**自签** browser-session cookie。
 *
 * 对应 SKILL §3.4 与 SHAPE §1「派生类」。它是本仓**唯一会经手秘密**的工具，因此：
 *
 * 1. **独立成工具，绝不并进 `dsh_check_auth`**（SHAPE §1）：判据是「有没有秘密要经手」。
 *    并进去会让一个**判定型**输出带上凭证 —— 它的 `audit` 会被 spill 落盘。
 * 2. **cookie 本体不进返回值**。契约要求 `data` 是可无损落 JSON 的值，而 `audit` 会被
 *    spill 写到磁盘；凭证进 `audit` = 凭证落盘。所以本工具只报**签发成功与否**、
 *    **绑在哪个 authority**、**cookie 叫什么名** —— 值算完即弃，**只活在签名那一侧**。
 *    因此模型**拿不到可用的 cookie 值**：谁要用它，谁就得直接调签名器（`lib/cookie-sign.ts`
 *    导出的 `signCookie` / `cookieHeader`），这条通道读不回来。
 * 3. **只读**（B10）：读一个文件 + 在内存里算 HMAC，**不写**任何东西、不发任何请求。
 *    它不联网 —— 「签出来」与「用上去」是分开的动作，后者由人或浏览器做。
 *
 * ## 一条被真机钉住的反直觉点（`lib/cookie-sign.ts` 有完整出处）
 *
 * cookie 绑定 authority（`host:port`）**逐字匹配**。而宿主算 audience 读的是 `Host`
 * 请求头 —— `fetch`（undici）**静默忽略显式设置的 `Host`**，所以实际 authority 由
 * **连接地址**决定。实测（2026-10-13，本机 `0.2.1-alpha.2`）：显式发
 * `Host: localhost:3080` 仍按 `127.0.0.1:3080` 算，得到 **401**。
 * ⇒ `host` 参数必须填**你真正要连的那个地址**，不是「浏览器地址栏里看着像的那个」。
 *
 * ## 为什么它不是「绕过认证」
 *
 * 它用**本机自己的**密钥、在**本机自己的** `DSH_HOME` 里签 —— 没有第二个宿主、没有
 * 网络往返、没有提权。它做的事与浏览器登录后拿到的 cookie 完全同构，只是省掉了那次交互。
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import { fail, ok, toToolError, type JsonValue } from '../lib/errors.js'
import { toolBudgetMs, type Workload } from '../lib/timeouts.js'
import { readTextIfExists } from '../lib/profile.js'
import { credentialsPath } from '../lib/profile.js'
import {
  cookieHeader,
  DEFAULT_COOKIE_MAX_AGE_DAYS,
  extractBrowserSessionSecret,
  signCookie,
} from '../lib/cookie-sign.js'
import type { RenderTable } from '../lib/render.js'
import { composeDescription, type ToolDescription } from './describe.js'
import {
  assertResolvedDshHome,
  CANCELLED_WHY,
  effectiveConfig,
  guardFallbackLine,
  resolvePort,
  resolvedLine as sharedResolvedLine,
  toOutput,
  toolOutput,
  withCallHome,
  type EffectiveConfigBlock,
  type ToolDeps,
} from './shared.js'

/** 工具名。 */
export const SIGN_COOKIE_TOOL = 'dsh_sign_cookie'

/** 本工具的工作量档：读一个文件 + 一次纯计算，**快档**。 */
const WORKLOAD: Workload = 'quick'

/** 401 那条路上「拿 cookie 去重试」的工具名。 */
const CHECK_AUTH_TOOL = 'dsh_check_auth'

/** 参数。 */
interface SignCookieArgs {
  port?: number
  host?: string
  /** cookie 寿命（天）。省略 = 30（宿主默认）。 */
  maxAgeDays?: number
  /**
   * 另一个实例的 `DSH_HOME`（跨实例观察，SHAPE §1.2 的 D′）。
   *
   * 它决定**读哪个 `.credentials.yaml`** —— 也就是「用谁的密钥签」。独立 `DSH_HOME`
   * 意味着独立 credentials ⇒ 独立 cookie secret（SKILL §3.4 的边界），所以这个参数
   * 真正能换出一个「另一个实例认的 cookie」。
   */
  dshHome?: string
}

/**
 * 签发结果在 `key` 里的投影。
 *
 * **`cookieValue` 刻意不在这里**：见文件头第 2 条。它也不在 `audit` 里。
 *
 * ⚠️ **四个签发字段都是可选的**，这不是偷懒：失败路径上**没有「签发」这回事**。
 * 最直接的一条 —— 端口定不出来时 `authority` 连拼都拼不出来（它就是 `host:port`），
 * 而硬造一个占位值（`:0`、`epoch 0`）会让模型以为「签了，只是没写出来」——
 * 那比缺字段坏得多。**缺字段 = 没说谎**；占位值 = 说了谎。
 */
interface SignCookieKey {
  /**
   * cookie 绑定的 authority（`host:port`）。宿主**逐字**匹配它。
   *
   * 端口定不出来时整条不出现 —— 那时连 authority 都不存在。
   */
  authority?: string
  /** cookie 名（`dsh-auth-<base64url(sha256(authority))>`）—— **不是秘密**，可以公开。 */
  cookieName?: string
  /** 绑定的到期时刻（epoch ms）。 */
  expiresAt?: number
  /** 生效起点（epoch ms）。 */
  issuedAt?: number
  /**
   * 这次调用实际用的是哪份配置。
   *
   * 与 `check_auth` 同理：**authority 由端口来源决定**，而 authority 又直接决定
   * 这个 cookie 有没有用，所以来源必须可见。**它在每条路径上都有** —— 它是「读了
   * 哪份配置」这个事实，与签没签成无关。
   */
  resolved: EffectiveConfigBlock
}

/**
 * 本工具的描述（SHAPE §2.1 四段骨架）。
 *
 * - `what`：动词 + 对象，并明说它**产出凭证**。
 * - `useWhen`：路由信号 —— `check_auth` 刚报 401，且要让脚本 / 命令行客户端带上 cookie。
 * - `boundary`：**这一类才有代价段**（SHAPE §3.1）：① 它读密钥，这是本仓唯一经手秘密的
 *   工具；② cookie 值**不会**出现在输出里。这两句是承重的 —— 不写，模型会以为返回值里
 *   就有可直接用的 cookie，而那时它会去找一个不存在的东西。
 */
export const SIGN_COOKIE_DESCRIPTION: ToolDescription = {
  what: 'Signs a browser-session cookie this host accepts.',
  useWhen: 'Use after a 401, when a script or CLI client needs to authenticate.',
  boundary:
    'Reads the local signing secret; the cookie value is not returned.\nCookies are bound to one exact host:port.',
}

/** 输出表：L1 就是 `data.verdict` 逐字，L2 由 `key` 投影成行。 */
const TABLE: RenderTable<SignCookieKey> = { key: (data) => keyText(data.key) }

/**
 * 造工具。
 *
 * @param deps 运行期依赖。
 */
export function createSignCookieTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: SIGN_COOKIE_TOOL,
    description: composeDescription(SIGN_COOKIE_DESCRIPTION),
    parameters: {
      port: {
        type: 'integer',
        description: 'Host port; omit for the configured one.',
      },
      host: {
        type: 'string',
        description: 'Authority host to bind to; default 127.0.0.1, matched literally.',
      },
      maxAgeDays: {
        type: 'integer',
        description: 'Cookie lifetime in days; must be positive (omit for the host default of 30).',
      },
      dshHome: {
        type: 'string',
        description:
          "Another instance's DSH_HOME, whose signing key is used. Omit for the configured one.",
      },
    },
    output: toolOutput(SIGN_COOKIE_TOOL, TABLE),

    timeoutMs: toolBudgetMs(WORKLOAD, deps.config),
    isConcurrencySafe: () => true,

    async execute(rawArgs, exec) {
      try {
        return await issueCookie(rawArgs as SignCookieArgs, exec.signal, deps)
      } catch (error) {
        // 顶层兜底：**`execute` 绝不 throw` 是契约的承载条件（SHAPE §4，红线 B24）。
        return toOutput(
          fail(toToolError(error, 'signing a browser-session cookie'), {
            verdict:
              'nothing was signed: this tool threw before reaching the credential file, so no cookie was produced — this is a failure of this plugin rather than a verdict about authentication',
            key: {},
            audit: {},
          }),
        )
      }
    },
  })
}

/**
 * 主流程（`execute` 的可抛内核；外层统一兜住异常）。
 *
 * @param args 调用参数。
 * @param signal 调用方信号。
 * @param deps 运行期依赖。
 */
async function issueCookie(
  args: SignCookieArgs,
  signal: AbortSignal,
  deps: ToolDeps,
): Promise<JsonValue> {
  // 本次调用认的实例（参数优先）。下面每一处 `deps.config` 都换成 `call.config` ——
  // 唯一要保证的是**读密钥那条路径**跟着换，否则签出来的 cookie 属于另一个实例。
  const call = withCallHome(deps, args.dshHome)

  const missing = assertResolvedDshHome(call.config)
  if (missing !== undefined) return toOutput(missing)

  const resolvedPort = resolvePort(args.port, call.config.port, call.env)
  if (resolvedPort === undefined) {
    return toOutput(
      fail(
        {
          kind: 'not-configured',
          message: 'cannot determine a port, so there is no authority to bind a cookie to',
        },
        {
          verdict:
            'no cookie was signed: no port could be determined, and a cookie is bound to one exact host:port — pass a port, set it in the plugin config, or run where DSH_WEB_URL is set',
          // ⚠️ 只有 `resolved` —— authority 连拼都拼不出来（它就是 host:port）。
          key: { resolved: { ...effectiveConfig(call.config), port: null, portSource: 'none' } },
          audit: {},
        },
        {
          // 同 `check_auth`：此刻没有任何**已观测到的**端口，套工具名会让模型逐字重调
          // 本工具、拿到同一个 `not-configured` —— 那是个不动点（死路）。
          manual: true,
          why: 'run this again with an explicit port once you know which one the host listens on',
        },
      ),
    )
  }

  const host = args.host ?? '127.0.0.1'
  const authority = `${host}:${String(resolvedPort.port)}`
  const resolved = effectiveConfig(call.config, resolvedPort)
  const file = credentialsPath(call.config.dshHome)

  const maxAgeDays = normalizeMaxAgeDays(args.maxAgeDays)
  if (maxAgeDays === undefined) {
    return toOutput(
      fail(
        // ⚠️ **不是 `internal`**：`internal` 的定义是「本插件自己的意外 / bug」
        // （`src/lib/errors.ts`），而这里明明是**调用方给的输入无效** —— 用 `internal`
        // 会让首行印成 `failed (internal)`、正文却说「输入不是正整数」，头行与正文自相矛盾。
        // 与 `dsh_restart` 对「reason 缺失」的处置同一档（那是本仓既有的先例）。
        { kind: 'not-configured', message: 'maxAgeDays must be a positive safe integer' },
        {
          verdict: `no cookie was signed: maxAgeDays must be a positive whole number of days, and the value passed is not one, so there is no valid expiry to bind`,
          key: unsignedKey(resolved),
          audit: {},
        },
        {
          manual: true,
          why: 'call this again with maxAgeDays as a positive whole number of days',
        },
      ),
    )
  }

  if (signal.aborted) {
    return toOutput(
      fail(
        { kind: 'cancelled', message: 'the caller cancelled before the credential file was read' },
        {
          verdict:
            'no cookie was signed: the caller cancelled this call before the credential file was read, so no verdict about authentication was reached',
          key: unsignedKey(resolved),
          audit: {},
        },
        {
          manual: true,
          why: CANCELLED_WHY,
        },
      ),
    )
  }

  const text = await readTextIfExists(file)
  if (text === undefined) {
    return toOutput(
      fail(
        {
          kind: 'not-found',
          message: `no credential file at ${file}`,
        },
        {
          verdict: `no cookie was signed: there is no credential file at ${file}, so this DSH_HOME has never stored a browser-session key — run the host and sign in once in the browser at this exact authority`,
          key: unsignedKey(resolved),
          audit: { file },
        },
        {
          tool: CHECK_AUTH_TOOL,
          args: { port: resolvedPort.port, host },
          why: 'confirm the host is up and reachable at this authority before deciding the credential file is the problem',
        },
      ),
    )
  }

  const extracted = extractBrowserSessionSecret(text)
  if (!extracted.ok) {
    return toOutput(
      fail(
        {
          kind: extracted.problem === 'missing' ? 'not-found' : 'internal',
          message:
            extracted.problem === 'missing'
              ? `no client-connection/browser-session grant in ${file}`
              : `the client-connection/browser-session grant in ${file} has an unusable secret`,
        },
        {
          verdict:
            extracted.problem === 'missing'
              ? `no cookie was signed: ${file} exists but holds no client-connection/browser-session grant, so there is no signing key for this DSH_HOME — sign in once in the browser at this exact authority to create one`
              : `no cookie was signed: ${file} holds a client-connection/browser-session grant whose secret is not 32 base64url bytes, so it cannot sign anything — treat this credential file as damaged rather than retrying`,
          key: unsignedKey(resolved),
          audit: { file },
        },
        {
          manual: true,
          why:
            extracted.problem === 'missing'
              ? 'sign in once in the browser at this exact authority, then run this again'
              : 'inspect that credential file before retrying; the stored secret is not in the format this host version writes',
        },
      ),
    )
  }

  // 从这里起就**持有凭证**了。它只在局部变量里活到本函数返回，不进 `data`、不进 `audit`。
  const signed = signCookie(extracted.value.secret, authority, deps.now(), maxAgeDays)

  const key: SignCookieKey = {
    authority,
    cookieName: signed.name,
    issuedAt: signed.payload.issuedAt,
    expiresAt: signed.payload.expiresAt,
    resolved,
  }

  return toOutput(
    ok(
      {
        verdict: `a cookie bound to ${authority} was signed with this host's own browser-session key, valid until ${new Date(signed.payload.expiresAt).toISOString()}; its value is deliberately not returned to this channel — a human or a local script must call the signer directly, because nothing here can read it back`,
        key,
        // ⚠️ 这里**必须**是空的：`audit` 会被 spill 写到磁盘，凭证进去 = 凭证落盘。
        audit: { file, maxAgeDays },
      },
      {
        // ⚠️ 原话是「把这个 authority 当 Cookie 头值发出去、再跑 auth 检查确认签名 cookie 被接受」
        // —— 三处都不成立：① authority（`host:port`）不是 cookie 值（cookie 头是 `name=value`）；
        // ② `dsh_check_auth` 的探测**不发任何凭据**（`lib/http.ts`），它没有能力确认 cookie 被接受；
        // ③ 本工具**不返回 cookie 值**，模型手上根本没有可发的东西。
        // ⇒ 唯一真实的下一步是人的动作，所以这里是 `manual`。
        manual: true,
        why: 'the cookie value never leaves the signing side: a human or a local script must call the signer directly and use the Cookie header it produces — this credential-free auth probe cannot verify it',
      },
    ),
  )
}

/**
 * 寿命参数规整。
 *
 * @param raw 调用方给的值。
 * @returns 正安全整数；给错时返回 `undefined`。
 */
function normalizeMaxAgeDays(raw: number | undefined): number | undefined {
  if (raw === undefined) return DEFAULT_COOKIE_MAX_AGE_DAYS
  return Number.isSafeInteger(raw) && raw > 0 ? raw : undefined
}

/**
 * 失败分支的 `key`：只有**能确定**的那一样（读了哪份配置）。
 *
 * 签发字段一个都不填 —— 没签出来就没有，填占位值等于谎称签过（见 `SignCookieKey`）。
 *
 * @param resolved 生效配置块。
 */
function unsignedKey(resolved: EffectiveConfigBlock): SignCookieKey {
  return { resolved }
}

/** 导给测试与真机脚本用：本工具算出的 `Cookie:` 头那一段。 */
export { cookieHeader }

/**
 * 把 `key` 投影成 L2 的逐行文本。
 *
 * 顺序即输出顺序：先框架（读了哪份配置、绑哪个 authority），再签发事实。
 * **不印 cookie 值** —— 它压根不在返回值里。
 *
 * @param key 本次的 `key`。
 */
function keyText(key: SignCookieKey): string[] {
  // 渲染层绝不抛（红线 B25）：守卫合成的兜底里 `data.key` 可能是 `{}`。
  if (!key || typeof key !== 'object') return [GUARD_FALLBACK_LINE]
  const lines: string[] = [resolvedLine(key.resolved)]
  if (key.authority !== undefined) lines.push(`authority: ${key.authority}`)
  if (key.cookieName !== undefined) lines.push(`cookie name: ${key.cookieName}`)
  // 到期时刻**只在真签出来时印**。没签出来就不印这一行 —— 印「valid until: not signed」
  // 会让一条「压根没走到签发」的失败路径看起来像「签了但没写出来」。
  if (key.expiresAt !== undefined) {
    lines.push(`valid until: ${new Date(key.expiresAt).toISOString()}`)
  }
  return lines
}

/**
 * 兜底行：`ensureToolResult` 合成的结果里 `key` 是 `{}`。
 *
 * 逐字常量现住在 `shared.ts`（此前各工具各抄一份，靠 `@see` 手工同步）。
 */
const GUARD_FALLBACK_LINE = guardFallbackLine()

/**
 * 生效配置那一行（与其它工具逐字一致，避免同一种事印出两种说法）。
 *
 * @param resolved 生效配置块。
 */
function resolvedLine(resolved: EffectiveConfigBlock | undefined): string {
  // 格式、字段顺序与兜底由 `shared.ts` 的唯一渲染点定；本工具涉及端口。
  return sharedResolvedLine(resolved, {
    port: resolved?.port ?? null,
    source: resolved?.portSource ?? 'none',
  })
}
