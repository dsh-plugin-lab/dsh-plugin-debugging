/**
 * `dsh_dump_config` —— 跑两种 dump 并把 `x-cordis.diagnostics` 读成人话。
 *
 * 对应 SKILL §3.8。两种 dump 的**退出码语义不同**，但那是**恒定知识** ——
 * 它现在只写在描述层的边界段（`DUMP_CONFIG_DESCRIPTION.boundary`）**一次**，
 * 不再每次调用复述一遍（SHAPE §2「移」的规则，B16 会抓恒定块）。同一处搬走的
 * 还有已知误报的判据（`preset-*` 行的 `unrecognized Loader tree carrier`）。
 *
 * **本工具的门是「已筛出的 `actionable` 列表是否非空」，不是退出码**（这是它最容易
 * 写错的地方）：
 * - `--dump-config`：**退出码恒 0**、不做 schema 校验 → **不能当门禁**，
 *   而组合期错仍写在它的 **stderr** 上（实测 `patch: name mismatch … skipping`）；
 * - `--dump-config-schema`：**退出码 1 = 有 error**，诊断在 stdout 的 `diagnostics` 里。
 *
 * 而 error **可能是误报**：官方 `preset-*` 行的 `unrecognized Loader tree carrier`
 * 就是已知的那条，判它必须把 `path`（形如 `/182`）解析成组合树里的 entry id ——
 * 所以「有 error」与「有**该管的** error」不是一回事，本工具分两类报。
 *
 * ## 输出形状（SHAPE §3 / §4.1 / §5）
 *
 * `data` 顶层**恰好三键**：`verdict`（L1，成功失败都有）/ `key`（L2 的原料）/
 * `audit`（给人复核，不进模型文本）。`key` 里放**模型下一步要读的**：
 * `actionable`（正因如此它属于 `key`，不是 `audit`）、两次 dump 的退出码与失败时的
 * stderr、以及 hmr 是否可用。原始全量 `diagnostics` 与 `counts` 放 `audit`。
 *
 * 失败分支也走同一个形状（`ok:false` 只表示「这次操作没完成」），且**必须有实质
 * `verdict`**：新契约下 `error.message` 不进模型文本（SHAPE §4.1 字段角色表），
 * 失败的「所以呢」只能由 `verdict` 承载。
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import {
  fail,
  ok,
  toToolError,
  type JsonValue,
  type ToolData,
  type ToolFail,
} from '../lib/errors.js'
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
import { probeHmr, type HmrProbe } from '../lib/effect.js'
import type { RenderTable } from '../lib/render.js'
import { composeDescription, type ToolDescription } from './describe.js'
import {
  assertResolvedDshHome,
  effectiveConfig,
  toOutput,
  toolOutput,
  type EffectiveConfigBlock,
  type ToolDeps,
} from './shared.js'

/** 工具名。 */
export const DUMP_CONFIG_TOOL = 'dsh_dump_config'

/** 参数。 */
interface DumpConfigArgs {
  profile?: string
}

/** 这次调用实际用的是哪份配置（`key` 的投影：只留要模型决策的）。 */
interface ResolvedKey {
  dshHome: string
  dshHomeSource: EffectiveConfigBlock['dshHomeSource']
  /**
   * 实际 dump 的 profile（工具参数可以覆盖配置）。
   *
   * 它同时是 `nextStep.args.profile` 的**取值来源** —— B17 要求标识符出现在
   * L1/L2 里，而 L2 的 `resolved:` 行就是它出现的地方。
   */
  profile: string
}

/** 一次已经跑过的 dump 在 `key` 里的投影。 */
interface InvocationKey {
  flag: DumpInvocation['flag']
  /** 进程未正常退出（spawn 失败 / 被杀）时为 `null`。 */
  exitCode: number | null
  /**
   * 非空时原样带上（压成一行）。
   *
   * **失败分支上这是唯一的证据**：组合期错只写在 `--dump-config` 的 stderr 里，
   * 而那条命令退出码恒 0 —— 不把它带出来，模型看到的就只是一句「失败了」。
   */
  stderr?: string
}

/** hmr 是否可用（细节与恒定解释在 `audit` / 描述层，不进 L2）。 */
interface HmrKey {
  present: boolean
  disabled: HmrProbe['disabled']
}

/**
 * `key`：下一个决定可能要用到的原料。
 *
 * 注意这里**没有** `counts` / 全量 `diagnostics` / `knownFalsePositives` ——
 * 那些是复核材料（`audit`）。判定要用的只有「有没有该管的 error」与「哪一条」。
 */
interface DumpConfigKey {
  resolved: ResolvedKey
  /** 已筛出的可执行错误（`error` / `composition-error`）—— 模型下一步要读的。 */
  actionable: ClassifiedDiagnostic[]
  /** 这次跑过哪几次 dump（早失败时可能只有一次，或者一次都没有）。 */
  invocations: InvocationKey[]
  /** hmr 探测结果；没走到探测那一步时整个字段不出现（「没查」≠「没有」）。 */
  hmr?: HmrKey
}

/**
 * 本工具的描述（SHAPE §2.1 四段骨架，观察类没有「代价段」）。
 *
 * 逐段理由：
 * - `what`：动词 + 对象。
 * - `useWhen`：模型的路由信号 —— 它回答的是「组合到底产出了什么」，而不是
 *   「补丁文件里写了什么」。
 * - `boundary`：**一行**，承载从输出里搬出来的全部恒定知识：① 两种 dump 的退出码
 *   语义（`--dump-config` 恒 0、不能当门禁）；② 已知误报与判它的方法（看 `path`）。
 *   这两条都是「执行前必须知道、且从本次输出里学不到」的 —— 正是描述层该住的东西。
 */
export const DUMP_CONFIG_DESCRIPTION: ToolDescription = {
  what: 'Shows what a profile resolves to.',
  useWhen: 'Use when the composed result matters, not a patch file.',
  boundary:
    '--dump-config always exits 0 (no gate); --dump-config-schema exits 1 on errors. ' +
    'A preset-* carrier error is a known false positive; judge by path.',
}

/** 本工具的输出表：L1 就是 `data.verdict` 逐字，L2 由 `key` 投影成行。 */
const TABLE: RenderTable<DumpConfigKey> = {
  key: (data) => keyText(data.key),
  // 用默认的 15 行上限：本工具一次最多落几条 actionable，撞上限时渲染层会明说还剩几条。
}

/**
 * 造工具。
 *
 * @param deps 运行期依赖。
 */
export function createDumpConfigTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: DUMP_CONFIG_TOOL,
    description: composeDescription(DUMP_CONFIG_DESCRIPTION),
    parameters: {
      profile: {
        type: 'string',
        description: "Profile name; omit for the plugin's configured profile.",
      },
    },
    output: toolOutput(DUMP_CONFIG_TOOL, TABLE),

    timeoutMs: deps.config.timeoutMs,
    isConcurrencySafe: () => true,

    async execute(rawArgs, exec) {
      const args = rawArgs as DumpConfigArgs
      const deadline = createDeadline(deps.config.timeoutMs, deps.now)

      const missing = assertResolvedDshHome(deps.config)
      if (missing !== undefined) return toOutput(missing)

      const profile = args.profile ?? deps.config.profile
      const resolvedBlock = effectiveConfig(deps.config, 'not-used', profile)
      const resolved = toResolvedKey(resolvedBlock)

      // **execute 绝不 throw**（SHAPE §4）：宿主只把抛出去的异常当失败，一旦抛出去，
      // 我们的 `verdict` / `key` / `audit` 全部失效、而且没有任何红线会报警。
      try {
        const launch = resolveDshLaunch()

        const configDump = await runDump(launch, profile, '--dump-config', {
          spawn: deps.spawn,
          timeoutMs: budgetFor(deps.config.timeoutMs, deadline),
          signal: exec.signal,
        })
        const configFailure = invocationFailure(configDump, resolved, [])
        if (configFailure !== undefined) return toOutput(configFailure)
        const configInvocation = invocationKey(configDump)

        const schemaDump = await runDump(launch, profile, '--dump-config-schema', {
          spawn: deps.spawn,
          timeoutMs: budgetFor(deps.config.timeoutMs, deadline),
          signal: exec.signal,
        })
        const schemaFailure = invocationFailure(schemaDump, resolved, [configInvocation])
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
        const actionable = diagnostics.filter(isActionable)
        const knownFalsePositives = diagnostics.filter(
          (item) => item.classification === 'known-false-positive',
        )
        const hasSchemaErrors = schemaDump.exitCode === 1
        const hmr = probeHmr(configDump.stdout)

        const invocations = [configInvocation, invocationKey(schemaDump)]
        const hmrKey: HmrKey = { present: hmr.present, disabled: hmr.disabled }
        const audit = asAudit({
          resolved: resolvedBlock,
          counts,
          diagnostics,
          knownFalsePositives,
          configDump: {
            exitCode: configDump.exitCode,
            entryCount: entries.length,
            stderr: configDump.stderr.trim(),
          },
          schemaDump: { exitCode: schemaDump.exitCode, hasErrors: hasSchemaErrors },
          hmr,
        })

        if (actionable.length > 0) {
          // **不能**用 `hasSchemaErrors` 当这个分支的门：组合期错出现在 `--dump-config`
          // 的 **stderr** 上，而那条命令的退出码恒 0、也不做 schema 校验。
          // 用退出码当门 = 把「插件被整条丢弃」这一类静默故障整条漏掉。
          const composition = actionable.filter(
            (item) => item.classification === 'composition-error',
          )
          return toOutput(
            fail(
              {
                kind: 'command-failed',
                message:
                  composition.length > 0
                    ? `${String(composition.length)} composition error(s): patch rows were dropped by skipping (the exit code is still 0)`
                    : `--dump-config-schema reported ${String(actionable.length)} error(s) that need attention`,
              },
              {
                verdict: actionableVerdict(actionable),
                key: { resolved, actionable, invocations, hmr: hmrKey },
                audit,
              },
              {
                tool: DUMP_CONFIG_TOOL,
                args: { profile },
                why: 'after fixing the rows named in actionable, run it again and confirm actionable is empty',
              },
            ),
          )
        }

        return toOutput(
          ok({
            verdict: cleanVerdict({
              hasSchemaErrors,
              knownFalsePositiveCount: knownFalsePositives.length,
            }),
            key: { resolved, actionable, invocations, hmr: hmrKey },
            audit,
          }),
        )
      } catch (error) {
        // 兜底分支（B24 的判据是「返回的是过守卫的合法结果」，不是「没报错」）。
        return toOutput(
          fail(toToolError(error, 'dumping the profile config'), {
            verdict:
              'nothing could be judged: the dump threw before it produced a result, so this is a failure of this plugin rather than a verdict about the config',
            key: { resolved, actionable: [], invocations: [] },
            audit: asAudit({ resolved: resolvedBlock }),
          }),
        )
      }
    },
  })
}

/**
 * 把一次 dump 调用的失败（超时 / 取消 / 起不来 / 退出码不合契约）转成结构化失败。
 *
 * 每一条都带**实质 `verdict`**（模型只能从 L1 知道「所以呢」）与已经在手的事实
 * （`key.invocations`：跑了哪个 flag、退出码、stderr）。
 *
 * @param invocation dump 结果。
 * @param resolved 这次用的配置（`nextStep.args.profile` 的取值来源）。
 * @param prior 这次失败之前**已经跑成**的 dump 投影。
 */
function invocationFailure(
  invocation: DumpInvocation,
  resolved: ResolvedKey,
  prior: readonly InvocationKey[],
): ToolFail | undefined {
  const invocations = [...prior, invocationKey(invocation)]
  const audit = asAudit({
    resolved,
    invocations,
    raw: {
      flag: invocation.flag,
      exitCode: invocation.exitCode,
      stderr: invocation.stderr,
    },
  })
  /** 失败分支的 `data`：形状与成功分支同构，只是这次什么都没看到。 */
  const data = (verdict: string): ToolData<DumpConfigKey> => ({
    verdict,
    key: { resolved, actionable: [], invocations },
    audit,
  })

  if (invocation.aborted) {
    return fail(
      {
        kind: 'cancelled',
        message: 'the caller cancelled this execution',
      },
      data(
        `nothing could be judged: ${invocation.flag} was cancelled by the caller, so no dump was completed`,
      ),
      {
        manual: true,
        why: 'cancellation is up to the caller; retrying the same call is pointless',
      },
    )
  }
  if (invocation.timedOut) {
    return fail(
      {
        kind: 'timeout',
        message: `${invocation.flag} timed out (the transport layer timed out first, before the tool budget)`,
      },
      data(
        `nothing could be judged: ${invocation.flag} hit the transport timeout before the tool budget, so there is no dump output to read`,
      ),
      {
        tool: DUMP_CONFIG_TOOL,
        args: { profile: resolved.profile },
        why: 'retry once as-is; raise timeoutMs if it keeps timing out, since dump-config-schema is slow by nature',
      },
    )
  }
  if (invocation.spawnError !== undefined) {
    const notFound = invocation.spawnError.includes('ENOENT')
    return fail(
      {
        kind: notFound ? 'not-configured' : 'internal',
        message: `cannot start dsh: ${invocation.spawnError}`,
      },
      data(
        notFound
          ? 'nothing could be dumped: dsh could not be started at all, so this plugin has no way to see what the profile composes to'
          : 'nothing could be dumped: starting dsh failed with an unexpected error, which is a problem on this side rather than a verdict about the config',
      ),
      notFound
        ? {
            manual: true,
            why: 'make dsh runnable — put it on PATH, or run this plugin on the same node as the host — then call this tool again',
          }
        : undefined,
    )
  }
  if (invocation.flag === '--dump-config' && invocation.exitCode !== 0) {
    // 契约上恒 0；非 0 说明是没见过的形态，值得单独报出来（恒定知识在描述层）。
    return fail(
      {
        kind: 'command-failed',
        message: `--dump-config unexpectedly exited with code ${String(invocation.exitCode)} (the contract is always 0)`,
      },
      data(
        `--dump-config exited with code ${String(invocation.exitCode)}, which contradicts its always-0 contract: the composition may not have been produced at all, so nothing here can be trusted`,
      ),
      {
        manual: true,
        why: 'read the stderr captured in invocations and settle why the exit code is not 0 before looking at the config',
      },
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
        message: `--dump-config-schema exited with code ${String(invocation.exitCode)} (the contract only allows 0 and 1)`,
      },
      data(
        `--dump-config-schema exited with code ${String(invocation.exitCode)}, which is outside the contract: the schema dump did not run to a known state, so its diagnostics cannot be read as a verdict`,
      ),
      {
        manual: true,
        why: 'read the stderr captured in invocations and settle why the exit code is outside {0,1} before looking at the config',
      },
    )
  }
  return undefined
}

/**
 * 拼「有该管的 error」那句结论（L1）。
 *
 * 两类分开数：组合期错会让**整条 patch 行消失**（看起来像「装了没启用」），
 * schema error 只是指向某一行 —— 模型要做的事不同。
 *
 * @param actionable 已筛出的可执行错误。
 */
function actionableVerdict(actionable: readonly ClassifiedDiagnostic[]): string {
  const composition = actionable.filter(
    (item) => item.classification === 'composition-error',
  ).length
  const schema = actionable.length - composition
  const parts: string[] = []
  if (composition > 0) {
    parts.push(
      `${String(composition)} patch row(s) were dropped by skipping while the exit code stayed 0`,
    )
  }
  if (schema > 0) parts.push(`${String(schema)} error(s) point at rows in this profile`)
  return `${parts.join('; ')}: these need attention and they are not the preset-* false positive`
}

/**
 * 拼「没有该管的 error」那句结论（L1）。
 *
 * 三档分开写，因为它们对下一步的决定不同：
 * - 什么都没报：组合层可以排除；
 * - 退出码 1 但全是已知误报：**这一档正是本工具存在的理由**；
 * - 退出码 1 却读不到任何诊断：**不许说成 clean**（形状漂了，报成干净是静默坏）。
 *
 * @param input 判定用的两件事实。
 */
function cleanVerdict(input: {
  hasSchemaErrors: boolean
  knownFalsePositiveCount: number
}): string {
  if (!input.hasSchemaErrors) {
    return 'neither dump reported an error, so the composition layer can be ruled out as the cause'
  }
  if (input.knownFalsePositiveCount === 0) {
    return 'the schema dump exited 1, but no diagnostic could be read out of either dump: the exit code is unexplained, so do not treat this config as clean'
  }
  return (
    `the schema dump exited 1, but all ${String(input.knownFalsePositiveCount)} error(s) land on ` +
    'preset-* rows (a known false positive) — nothing points at a row you changed'
  )
}

/**
 * 是不是「该管的」error。
 *
 * 已知误报（`known-false-positive`）与投影期 warning 都不算 —— 前者是官方那一行，
 * 后者不影响这次运行。
 *
 * @param item 已分类的诊断。
 */
function isActionable(item: ClassifiedDiagnostic): boolean {
  return item.classification === 'error' || item.classification === 'composition-error'
}

/**
 * 一次 dump 在 `key` 里的投影。
 *
 * @param invocation dump 结果。
 */
function invocationKey(invocation: DumpInvocation): InvocationKey {
  const stderr = invocation.stderr.trim()
  return {
    flag: invocation.flag,
    exitCode: invocation.exitCode,
    ...(stderr === '' ? {} : { stderr }),
  }
}

/**
 * 把生效配置块投影成 `key.resolved`。
 *
 * 端口三件套不进来：本工具不碰端口（`effectiveConfig` 这次传的是 `'not-used'`）。
 *
 * @param resolved 生效配置块。
 */
function toResolvedKey(resolved: EffectiveConfigBlock): ResolvedKey {
  return {
    dshHome: resolved.dshHome,
    dshHomeSource: resolved.dshHomeSource,
    profile: resolved.profile,
  }
}

/**
 * 按分类计数（进 `audit`：复核材料，不是判定依据）。
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
 * 把 `key` 投影成 L2 的逐行文本。
 *
 * 排序即输出顺序：**先「我 dump 的是哪份配置」，再「跑了什么、退出码多少」，
 * 最后才是这一次真正要读的 `actionable`**。
 *
 * 恒定知识**不在这里**：退出码语义与已知误报的判据都住在描述层边界段（写一次）。
 *
 * @param key 本次的 `key`。
 */
function keyText(key: DumpConfigKey): string[] {
  const lines: string[] = [resolvedLine(key.resolved)]
  for (const invocation of key.invocations) lines.push(invocationLine(invocation))
  if (key.hmr !== undefined) {
    lines.push(
      key.hmr.present ? `hmr: present=yes disabled=${key.hmr.disabled}` : 'hmr: present=no',
    )
  }
  if (key.actionable.length === 0) {
    lines.push('actionable: none')
  } else {
    for (const item of key.actionable) lines.push(actionableLine(item))
  }
  return lines
}

/**
 * `resolved:` 那一行 —— 整份结论的前提，也是 `nextStep.args.profile` 的取值来源。
 *
 * @param resolved `key.resolved`。
 */
function resolvedLine(resolved: ResolvedKey): string {
  return `resolved: profile=${resolved.profile} dshHome=${resolved.dshHome} (${resolved.dshHomeSource})`
}

/**
 * 一次 dump 一行。
 *
 * @param invocation `key.invocations` 里的一项。
 */
function invocationLine(invocation: InvocationKey): string {
  const exit = invocation.exitCode === null ? 'none' : String(invocation.exitCode)
  const base = `dump: ${invocation.flag} exit=${exit}`
  return invocation.stderr === undefined ? base : `${base} stderr=${oneLine(invocation.stderr)}`
}

/**
 * 一条 actionable 一行：**`path` 与解析出的 `entryId` 必须在**（模型下一步就是拿它去定位那一行）。
 *
 * @param item 已分类的诊断。
 */
function actionableLine(item: ClassifiedDiagnostic): string {
  const where = item.path === undefined ? '' : ` path=${item.path}`
  const entryId = item.entryId === undefined ? '' : ` entryId=${item.entryId}`
  return `actionable: [${item.classification}]${where}${entryId} ${oneLine(item.message)}`
}

/**
 * 压成一行（stderr 与 message 都可能带换行，进 L2 会把「一行一条」破坏掉）。
 *
 * @param text 原始文本。
 */
function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/**
 * 把一个只读记录转成 `audit` 的契约类型 `JsonValue`。
 *
 * 为什么要这个函数：`JsonValue` 是**带索引签名**的递归联合，而本仓的记录是 `interface`
 * —— interface **不带隐式索引签名**，结构上合法的对象也通不过赋值检查（同一条 TS 规则，
 * 见 `shared.ts` 的 `toOutput`）。与其为一个 TS 规则把冻结的契约层改成类型别名，
 * 不如在**唯一一处**边界上显式转型；`audit` 必须是无损 JSON 这条要求由契约本身承担。
 *
 * @param value 任一可无损落 JSON 的只读记录。
 */
function asAudit(value: unknown): JsonValue {
  return value as JsonValue
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
