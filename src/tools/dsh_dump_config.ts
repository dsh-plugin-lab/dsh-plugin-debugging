/**
 * `dsh_dump_config` —— 跑两种 dump 并把 `x-cordis.diagnostics` 读成人话。
 *
 * 对应 SKILL §3.8。两种 dump 的**退出码语义不同**，这是本工具存在的主要理由：
 * - `--dump-config`：**退出码恒 0**，不做 schema 校验 → **不能当门禁**
 *   （但组合期错仍写在 **stderr**，实测会看到 `patch: name mismatch … skipping`）；
 * - `--dump-config-schema`：**退出码 1 = 有 error**，诊断在 **stdout** 的 `diagnostics` 里。
 *
 * 而 error **可能是误报**：官方 `preset-*` 行的 `unrecognized Loader tree carrier`
 * 就是已知的那条。判它必须把 `path`（形如 `/181`）解析成组合树里的 entry id ——
 * 实测本机 `/181`→`agent-preset-registry`、`/182..184`→`preset-standard|ptc|minimal`，
 * 正是误报那几行。所以「有 error」与「有**该管的** error」不是一回事，本工具分两类报。
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import { fail, ok } from '../lib/errors.js'
import { budgetFor, createDeadline } from '../lib/timeouts.js'
import {
  classifyDiagnostic,
  parseComposedEntries,
  parseDiagnosticsFromSchemaText,
  parseDiagnosticsFromStderr,
  resolveDshLaunch,
  runDump,
  type ClassifiedDiagnostic,
  type DumpInvocation,
  type DiagnosticClass,
} from '../lib/dump.js'
import { probeHmr } from '../lib/effect.js'
import {
  assertResolvedDshHome,
  effectiveConfig,
  toOutput,
  toolOutput,
  type ToolDeps,
} from './shared.js'

/** 工具名。 */
export const DUMP_CONFIG_TOOL = 'dsh_dump_config'

/** 参数。 */
interface DumpConfigArgs {
  profile?: string
}

/**
 * 造工具。
 *
 * @param deps 运行期依赖。
 */
export function createDumpConfigTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: DUMP_CONFIG_TOOL,
    description:
      'Shows the config a profile actually resolves to, plus the composition diagnostics. ' +
      'Use it when you need what the composition really produced, rather than what a patch file says. ' +
      'Read-only — and the plain dump always exits 0, so a zero exit proves nothing: the exit code ' +
      'that signals errors comes from the schema dump, and known false positives are listed ' +
      'separately from errors that point at a row you changed.',
    parameters: {
      profile: {
        type: 'string',
        description: "Profile name; omit to use the plugin's configured profile.",
      },
    },
    output: toolOutput(DUMP_CONFIG_TOOL),

    timeoutMs: deps.config.timeoutMs,
    isConcurrencySafe: () => true,

    async execute(rawArgs, exec) {
      const args = rawArgs as DumpConfigArgs
      const deadline = createDeadline(deps.config.timeoutMs, deps.now)

      const missing = assertResolvedDshHome(deps.config)
      if (missing !== undefined) return toOutput(missing)

      const profile = args.profile ?? deps.config.profile
      const launch = resolveDshLaunch()

      const configDump = await runDump(launch, profile, '--dump-config', {
        spawn: deps.spawn,
        timeoutMs: budgetFor(deps.config.timeoutMs, deadline),
        signal: exec.signal,
      })
      const configFailure = invocationFailure(configDump, profile)
      if (configFailure !== undefined) return toOutput(configFailure)

      const schemaDump = await runDump(launch, profile, '--dump-config-schema', {
        spawn: deps.spawn,
        timeoutMs: budgetFor(deps.config.timeoutMs, deadline),
        signal: exec.signal,
      })
      const schemaFailure = invocationFailure(schemaDump, profile)
      if (schemaFailure !== undefined) return toOutput(schemaFailure)

      const entries = parseComposedEntries(configDump.stdout)
      // 两条来源都要：schema 的 diagnostics 在 stdout，而组合期错只在各自的 stderr。
      const raw = [
        ...parseDiagnosticsFromSchemaText(schemaDump.stdout),
        ...parseDiagnosticsFromStderr(configDump.stderr),
        ...parseDiagnosticsFromStderr(schemaDump.stderr),
      ]
      const diagnostics = dedupe(raw.map((item) => classifyDiagnostic(item, entries)))

      const counts = countByClass(diagnostics)
      const actionable = diagnostics.filter(
        (item) => item.classification === 'error' || item.classification === 'composition-error',
      )
      const hasSchemaErrors = schemaDump.exitCode === 1
      const hmr = probeHmr(configDump.stdout)

      const data = {
        /**
         * 生效配置：`profile` 可能来自工具参数（覆盖配置），而「我到底 dump 了哪个
         * profile」是这份输出的**前提** —— 摊开它，用户才能判断结论适不适用于自己。
         * 因此这里**不再另设顶层 `profile` 字段**：一处一事实，避免两处漂移。
         */
        resolved: effectiveConfig(deps.config, 'not-used', profile),
        exitCodeSemantics: {
          configDump: '--dump-config 退出码恒 0，不做 schema 校验 —— 不能当门禁',
          schemaDump: '--dump-config-schema 退出码 1 = 有 error',
        },
        configDump: {
          exitCode: configDump.exitCode,
          entryCount: entries.length,
          stderr: configDump.stderr.trim(),
        },
        schemaDump: {
          exitCode: schemaDump.exitCode,
          hasErrors: hasSchemaErrors,
        },
        diagnostics,
        counts,
        actionable,
        knownFalsePositives: diagnostics.filter(
          (item) => item.classification === 'known-false-positive',
        ),
        hmr,
      }

      if (actionable.length > 0) {
        // **不能**用 `hasSchemaErrors` 当这个分支的门：组合期错出现在
        // `--dump-config` 的 **stderr**，而那条命令的退出码恒 0、也不做 schema 校验
        // （SKILL §3.8）。用退出码当门 = 把「插件被整条丢弃」这一类静默故障漏掉。
        const composition = actionable.filter((item) => item.classification === 'composition-error')
        return toOutput(
          fail(
            {
              kind: 'command-failed',
              message:
                composition.length > 0
                  ? `组合期错 ${String(composition.length)} 条：有 patch 行被 skipping 整条丢弃（退出码仍是 0）`
                  : `--dump-config-schema 报了 ${String(actionable.length)} 条该管的 error`,
              hint:
                '先看 actionable 里每条 error 的 entryId / path：指向你改过的行就是真问题；' +
                '组合期错那几条会让该行**整条消失**，插件表现为「装了没启用」',
            },
            {
              tool: DUMP_CONFIG_TOOL,
              args: { profile },
              why: '改完配置后再跑一次，确认 actionable 归零',
            },
          ),
        )
      }

      return toOutput(
        ok(data, {
          why:
            actionable.length === 0 && hasSchemaErrors
              ? '退出码 1 但 error 全部落在 preset 行上（已知误报）—— 你改的行没问题'
              : actionable.length === 0
                ? '两种 dump 都没有指向你改动的 error；配置组合层可以排除'
                : '有该管的 error，看 actionable 的 entryId 定位到具体那一行',
        }),
      )
    },
  })
}

/**
 * 把一次 dump 调用的失败（超时 / 取消 / 起不来）转成结构化失败。
 *
 * @param invocation dump 结果。
 * @param profile 本次用的 profile（拼重试建议用）。
 */
function invocationFailure(
  invocation: DumpInvocation,
  profile: string,
): ReturnType<typeof fail> | undefined {
  if (invocation.aborted) {
    return fail(
      {
        kind: 'cancelled',
        message: '调用方取消了这次执行',
        hint: '不要自动重试；这是调用方主动放弃',
      },
      { why: '取消是调用方的决定，重试同一个调用没有意义' },
    )
  }
  if (invocation.timedOut) {
    return fail(
      {
        kind: 'timeout',
        message: `${invocation.flag} 超时（传输层先于工具预算超时）`,
        hint: '调大 timeoutMs 后重试；dump-config-schema 在本机有 3 万余行输出，慢是正常的',
      },
      { tool: DUMP_CONFIG_TOOL, args: { profile }, why: '原样重试一次' },
    )
  }
  if (invocation.spawnError !== undefined) {
    const notFound = invocation.spawnError.includes('ENOENT')
    return fail(
      {
        kind: notFound ? 'not-configured' : 'internal',
        message: `起不了 dsh：${invocation.spawnError}`,
        hint: notFound
          ? '确认宿主进程可用（PATH 上有 dsh，或本插件与宿主同一个 node）'
          : '把 message 原文带回；这是本插件的意外路径',
      },
      { why: '拿不到 dump 输出，后面的判断都没有依据' },
    )
  }
  if (invocation.flag === '--dump-config' && invocation.exitCode !== 0) {
    // 契约上恒 0；非 0 说明是没见过的形态，值得单独报出来。
    return fail(
      {
        kind: 'command-failed',
        message: `--dump-config 意外地以退出码 ${String(invocation.exitCode)} 结束（契约是恒 0）`,
        hint: '看 stderr 原文；这不是本工具能解释的形态',
      },
      { why: '退出码语义与契约不符，先弄清这个再谈配置' },
    )
  }
  if (
    invocation.flag === '--dump-config-schema' &&
    invocation.exitCode !== 0 &&
    invocation.exitCode !== 1
  ) {
    return fail(
      {
        kind: 'command-failed',
        message: `--dump-config-schema 以退出码 ${String(invocation.exitCode)} 结束（契约只有 0 与 1）`,
        hint: '看 stderr 原文；这不是本工具能解释的形态',
      },
      { why: '退出码语义与契约不符，先弄清这个再谈配置' },
    )
  }
  return undefined
}

/**
 * 按分类计数。
 *
 * @param diagnostics 已分类的诊断。
 */
function countByClass(
  diagnostics: readonly ClassifiedDiagnostic[],
): Record<DiagnosticClass, number> {
  const counts: Record<DiagnosticClass, number> = {
    error: 0,
    'known-false-positive': 0,
    'composition-error': 0,
    'projection-warning': 0,
  }
  for (const item of diagnostics) counts[item.classification] += 1
  return counts
}

/**
 * 去重：同一句 message 可能同时出现在 stdout 的 diagnostics 与 stderr 的文本行里。
 *
 * @param items 诊断列表。
 */
function dedupe<T extends { level: string; message: string; path?: string }>(
  items: readonly T[],
): T[] {
  const seen = new Set<string>()
  const result: T[] = []
  for (const item of items) {
    const key = `${item.level}\u0000${item.path ?? ''}\u0000${item.message}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result
}
