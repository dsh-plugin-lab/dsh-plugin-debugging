/**
 * `dsh_check_auth` —— 分开「连接被拒（没启动）」与「401（服务在、认证没过）」。
 *
 * 对应 SKILL §3.3 / §3.4。这是本工具**唯一**要回答的问题，因为两者的下一步完全相反：
 * 前者去启动，后者去换 authority / 凭证（cookie 绑定 `host:port`，**换端口才 401**，
 * 同端口重启旧 cookie 照常可用、30 天不滑动）。
 *
 * v1 的边界（决策 D4/D5）：**只报** `.credentials.yaml` 里
 * `client-connection/browser-session` 条目**在不在**，
 * **不提取密钥、不读值、不自签 cookie** —— 那是 v1.1。返回值里没有任何秘密。
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import { fail, ok } from '../lib/errors.js'
import { budgetFor, createDeadline } from '../lib/timeouts.js'
import { readCredentialsPresence, type CredentialsPresence } from '../lib/credentials.js'
import { probeHttp, type HttpProbeResult } from '../lib/http.js'
import { credentialsPath } from '../lib/profile.js'
import {
  assertResolvedDshHome,
  effectiveConfig,
  resolvePort,
  toOutput,
  toolOutput,
  type EffectiveConfigBlock,
  type ToolDeps,
} from './shared.js'

/** 工具名。 */
export const CHECK_AUTH_TOOL = 'dsh_check_auth'

/** 参数。 */
interface CheckAuthArgs {
  port?: number
  host?: string
}

/** 返回的 `data`（只在成功时有）。 */
interface CheckAuthData {
  authority: string
  url: string
  probe: HttpProbeResult
  /** 本次调用实际用的配置（含端口来源）。 */
  resolved: EffectiveConfigBlock
  credentials: {
    file: string
    exists: boolean
    clientConnectionPresent: boolean
    browserSessionPresent: boolean
    line?: number
    note: string
  }
  verdict: string
}

/**
 * 造工具。
 *
 * @param deps 运行期依赖。
 */
export function createCheckAuthTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: CHECK_AUTH_TOOL,
    description:
      'Separates "not running" from "not authenticated": connection refused versus 401, with the ' +
      'authority and port in use. ' +
      'Use it when the page returns 401, or when you cannot tell whether the host is up at all. ' +
      'Read-only, it extracts no keys and signs no cookies — and a 401 often means the port changed ' +
      'rather than that credentials are wrong, because the authority is matched literally as `host:port`.',
    parameters: {
      port: {
        type: 'integer',
        description:
          "Host port to probe; omit to use the plugin's configured port, falling back to `DSH_WEB_URL`.",
      },
      host: {
        type: 'string',
        description:
          'Hostname, default `127.0.0.1`; the authority is matched literally as `host:port`, so ' +
          '`localhost` and `127.0.0.1` are not interchangeable.',
      },
    },
    output: toolOutput(CHECK_AUTH_TOOL),

    timeoutMs: deps.config.timeoutMs,
    isConcurrencySafe: () => true,

    async execute(rawArgs, exec) {
      const args = rawArgs as CheckAuthArgs
      const deadline = createDeadline(deps.config.timeoutMs, deps.now)

      const missing = assertResolvedDshHome(deps.config)
      if (missing !== undefined) return toOutput(missing)

      const resolvedPort = resolvePort(args.port, deps.config.port, deps.env)
      if (resolvedPort === undefined) {
        return toOutput(
          fail(
            {
              kind: 'not-configured',
              message: 'cannot determine a port, so authentication cannot be probed',
              hint: 'Pass the port argument, set port in the plugin config, or rely on DSH_WEB_URL from the environment',
            },
            {
              tool: CHECK_AUTH_TOOL,
              args: { port: 3080 },
              why: 'the web profile on this machine listens on 3080 by default',
            },
          ),
        )
      }

      const host = args.host ?? '127.0.0.1'
      const authority = `${host}:${String(resolvedPort.port)}`
      const url = `http://${authority}/`

      const probe = await probeHttp(url, budgetFor(deps.config.timeoutMs, deadline), {
        fetch: deps.fetch,
        signal: exec.signal,
      })

      const credentials: CredentialsPresence = await readCredentialsPresence(
        credentialsPath(deps.config.dshHome),
      )

      const data: CheckAuthData = {
        authority,
        url,
        probe,
        /**
         * 生效配置：认证判定强依赖「探测的是哪个 authority」，而 authority 又来自
         * 端口来源（参数 / 配置 / env）—— 三者给出不同结论，所以来源必须可见。
         */
        resolved: effectiveConfig(deps.config, resolvedPort),
        credentials: {
          file: credentials.file,
          exists: credentials.exists,
          clientConnectionPresent: credentials.clientConnectionPresent,
          browserSessionPresent: credentials.browserSessionPresent,
          ...(credentials.line === undefined ? {} : { line: credentials.line }),
          note: 'v1 only checks whether the entry exists; it does not read values or sign cookies',
        },
        verdict: verdictOf(probe),
      }

      // 超时与取消是「没结论」，用 fail；没启动与 401 是**有结论**的失败，用 fail 但 kind 不同。
      if (probe.kind === 'timeout') {
        return toOutput(
          fail(
            {
              kind: 'timeout',
              message: probe.detail,
              hint: 'retry as-is; raise timeoutMs if it keeps timing out',
            },
            {
              tool: CHECK_AUTH_TOOL,
              args: { port: resolvedPort.port, host },
              why: 'retry once as-is',
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
              hint: 'the host is not listening. Check the process by port, and check the port number (a changed port is a common cause of 401)',
            },
            {
              tool: 'dsh_diagnose_plugin_load',
              args: { port: resolvedPort.port },
              why: 'look up the listener by port and read the startup logs to confirm whether the host is up',
            },
          ),
        )
      }
      if (probe.kind === 'cancelled') {
        return toOutput(
          fail(
            {
              kind: 'cancelled',
              message: probe.detail,
              hint: 'do not retry automatically; the caller gave up on purpose',
            },
            { why: 'cancellation is up to the caller; retrying the same call is pointless' },
          ),
        )
      }
      if (probe.kind === 'unauthorized') {
        return toOutput(
          fail(
            {
              kind: 'auth',
              message: `${authority} returned 401 — the service is up but authentication failed (not "not running")`,
              hint: 'cookies are bound to host:port: changing the port always yields 401, while a restart on the same port keeps old cookies valid (30 days, non-sliding).',
            },
            {
              tool: CHECK_AUTH_TOOL,
              args: { port: resolvedPort.port, host },
              why: 'make authority match the browser address bar exactly, then retry; if it still returns 401, fall back to v1.1 cookie signing',
            },
            // 证据：凭据文件那一块。此前只把 `browserSessionPresent` 内联进 hint ——
            // 「文件在不在、哪一行、client-connection 有没有」全丢了，而 401 的排查恰恰要这些。
            // 事实现在有唯一的家（evidence），hint 只留 cookie/authority 那段解释。
            { credentials: data.credentials },
          ),
        )
      }

      return toOutput(
        ok(data, {
          why:
            probe.kind === 'http-error'
              ? 'the service is up (it answered) but the status is not 200/3xx — the important part is that "not running" is ruled out'
              : 'the service is up and this request was accepted; authentication is not the cause here',
        }),
      )
    },
  })
}

/**
 * 一句话结论。
 *
 * @param probe 探测结果。
 */
function verdictOf(probe: HttpProbeResult): string {
  switch (probe.kind) {
    case 'ok':
      return 'service is up; authentication passed'
    case 'unauthorized':
      return 'service is up; authentication failed (401) — not "not running"'
    case 'not-running':
      return 'cannot connect: the host is not listening on this port'
    case 'timeout':
      return 'probe timed out: no verdict'
    case 'cancelled':
      return 'the caller cancelled the probe: no verdict'
    case 'http-error':
      return 'service is up but returned an unexpected status code'
  }
}
