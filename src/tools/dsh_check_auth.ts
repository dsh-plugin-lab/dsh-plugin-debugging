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
              message: '定不出端口，没法探测认证',
              hint: '传 port 参数，或在插件配置里填 port；环境里的 DSH_WEB_URL 也能提供端口',
            },
            {
              tool: CHECK_AUTH_TOOL,
              args: { port: 3080 },
              why: '本机 web profile 的默认监听端口是 3080',
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
          note: 'v1 只判条目在不在，不读值、不自签 cookie',
        },
        verdict: verdictOf(probe),
      }

      // 超时与取消是「没结论」，用 fail；没启动与 401 是**有结论**的失败，用 fail 但 kind 不同。
      if (probe.kind === 'timeout') {
        return toOutput(
          fail(
            { kind: 'timeout', message: probe.detail, hint: '原样重试；持续超时调大 timeoutMs' },
            { tool: CHECK_AUTH_TOOL, args: { port: resolvedPort.port, host }, why: '原样重试一次' },
          ),
        )
      }
      if (probe.kind === 'not-running') {
        return toOutput(
          fail(
            {
              kind: 'not-running',
              message: `${authority} 连不上：${probe.detail}`,
              hint: '宿主没在监听。按端口确认进程，或确认端口号（端口变了也是 401 的常见成因）',
            },
            {
              tool: 'dsh_diagnose_plugin_load',
              args: { port: resolvedPort.port },
              why: '按端口查监听者与 startup 日志，确认宿主到底起没起',
            },
          ),
        )
      }
      if (probe.kind === 'cancelled') {
        return toOutput(
          fail(
            { kind: 'cancelled', message: probe.detail, hint: '不要自动重试；这是调用方主动放弃' },
            { why: '取消是调用方的决定，重试同一个调用没有意义' },
          ),
        )
      }
      if (probe.kind === 'unauthorized') {
        return toOutput(
          fail(
            {
              kind: 'auth',
              message: `${authority} 返回 401 —— 服务在，是认证没过（不是没启动）`,
              hint:
                'cookie 绑定 host:port：换端口必然 401，同端口重启旧 cookie 仍可用（30 天不滑动）。' +
                `凭证文件里 browser-session 条目${credentials.browserSessionPresent ? '在' : '不在'}`,
            },
            {
              tool: CHECK_AUTH_TOOL,
              args: { port: resolvedPort.port, host },
              why: '确认 authority 与浏览器地址栏逐字一致后重试；仍 401 就走 v1.1 的自签 cookie',
            },
          ),
        )
      }

      return toOutput(
        ok(data, {
          why:
            probe.kind === 'http-error'
              ? '服务在（能应答），只是这个状态码不是 200/3xx —— 重点是「没启动」已被排除'
              : '服务在且这次请求被接受；认证不是当前问题的成因',
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
      return '服务在、认证通过'
    case 'unauthorized':
      return '服务在、认证没过（401）—— 不是没启动'
    case 'not-running':
      return '连不上：宿主没在监听这个端口'
    case 'timeout':
      return '探测超时：没有结论'
    case 'cancelled':
      return '调用方取消了探测：没有结论'
    case 'http-error':
      return '服务在，但返回了非预期状态码'
  }
}
