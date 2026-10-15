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
 * 而这扇门有一个前提：**「筛过了、是空的」与「根本没读到」不是一回事**。所以
 * `key.notScreened` 记下「工具打算读、但这次没读到」的来源，渲染层据此出三值：
 * 读到且为空 = `actionable: none`／读到且有 = 逐条列出／**没读到 = 绝不许印 `none`**。
 * 归集只有一处（`screen()`），**成功与失败分支共用它** —— 一次 dump 失败不该让
 * 已经跑成的那一次变得不可读（那正是本工具曾有过的缺陷）。
 *
 * 而 error **可能是误报**：官方 `preset-*` 行的 `unrecognized Loader tree carrier`
 * 就是已知的那条，判它必须把 `path`（形如 `/182`）解析成组合树里的 entry id ——
 * 所以「有 error」与「有**该管的** error」不是一回事，本工具分两类报。
 *
 * ## 输出形状（SHAPE §3 / §4.1 / §5）
 *
 * `data` 顶层**恰好三键**：`verdict`（L1，成功失败都有）/ `key`（L2 的原料）/
 * `audit`（给人复核，不进模型文本）。`key` 里放**模型下一步要读的**：
 * `actionable`（正因如此它属于 `key`，不是 `audit`）、`notScreened`（覆盖完整性：
 * 「不知道」不许印成「没有」）、两次 dump 的退出码与失败时的 stderr、以及 hmr 是否可用。
 * 原始全量 `diagnostics` 与 `counts` 放 `audit`。
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
  type NextStep,
  type ToolData,
  type ToolError,
} from '../lib/errors.js'
import { budgetFor, createDeadline, toolBudgetMs, type Workload } from '../lib/timeouts.js'
import {
  classifyDiagnostic,
  parseComposedEntries,
  parseDiagnosticsFromSchemaText,
  parseDiagnosticsFromStderr,
  resolveDshLaunch,
  runDump,
  type ClassifiedDiagnostic,
  type ComposedEntry,
  type DumpDiagnostic,
  type DumpInvocation,
  type DiagnosticClass,
} from '../lib/dump.js'
import { probeHmr, type HmrProbe } from '../lib/effect.js'
import type { RenderTable } from '../lib/render.js'
import { composeDescription, type ToolDescription } from './describe.js'
import {
  assertResolvedDshHome,
  childEnvFor,
  effectiveConfig,
  spawnWithHome,
  toOutput,
  toolOutput,
  withHomeOverride,
  type EffectiveConfigBlock,
  type ToolDeps,
} from './shared.js'

/** 工具名。 */
export const DUMP_CONFIG_TOOL = 'dsh_dump_config'

/**
 * 本工具的工作量档：**慢档**。
 *
 * 它跑的 `--dump-config-schema` 是 CPU 密集且随 profile 规模增长的活（实测见
 * `lib/timeouts.ts` 里那张表），与本仓其余工具的活差一个数量级 —— 所以它必须走慢档，
 * 而不是跟大家一起分快档那个兜底数。
 */
const WORKLOAD: Workload = 'schemaDump'

/** 参数。 */
interface DumpConfigArgs {
  profile?: string
  /**
   * 另**一个**实例的 `DSH_HOME`（跨实例观察，SHAPE §1.2 的 D′）。
   *
   * 它同时改两处：本工具用来拼路径的 home，以及**子进程**的 `DSH_HOME`
   * （`--dump-config` 是起一个 `dsh` 去问的 —— 只改前者会让子进程读回本进程的 home，
   * 那正是「看着成功、其实读的是另一个目录」）。
   */
  dshHome?: string
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
  /**
   * **没读到的诊断来源**（空数组 = 覆盖完整）。
   *
   * 为什么它是一等值、而不是让人从 `invocations` 反推：`actionable: []` 只在
   * 「该读的都读到了」时才等于 `none`；少了这份记录，渲染层只能把「不知道」
   * 印成「没有」（三值纪律，见本文件头那扇门）。
   */
  notScreened: DumpInvocation['flag'][]
  /** 这次跑过哪几次 dump（早失败时可能只有一次，或者一次都没有）。 */
  invocations: InvocationKey[]
  /** hmr 探测结果；没走到探测那一步时整个字段不出现（「没查」≠「没有」）。 */
  hmr?: HmrKey
}

/**
 * 失败分支的「头」：只回答「为什么停」。
 *
 * 它与归集结果**刻意分开**：结论与下一步来自那次没读成的 dump，
 * 而 `key` / `audit` 来自**所有**跑过的 dump —— 两半拼起来才是结果。
 */
interface FailureHead {
  error: ToolError
  verdict: string
  nextStep?: NextStep
}

/** 一次 dump 的观测：调用结果 + 「这一次读没读到」。 */
interface DumpRun {
  invocation: DumpInvocation
  /** 读不出来的原因；`undefined` = 这一次真的读到了。 */
  failure?: FailureHead
}

/**
 * 「这次读到了什么」—— **成功与失败分支共用的唯一归集点**。
 *
 * 它存在的理由就是本工具曾有过的缺陷：失败分支各自硬编码 `actionable: []`，
 * 于是第二次 dump 一失败（真机实测是 `--dump-config-schema` 传输层超时），
 * 第一次已经跑成、组合期错已经写在 stderr 上的事实就整个消失了。
 */
interface Screening {
  /** 已经读到的全部诊断（含已知误报，`audit` 用）。 */
  diagnostics: ClassifiedDiagnostic[]
  /** 其中**该管的**那些（`key.actionable` 用）。 */
  actionable: ClassifiedDiagnostic[]
  /** 已知误报（`audit` 用，也是 clean 结论那一档的原料）。 */
  knownFalsePositives: ClassifiedDiagnostic[]
  /** 按分类计数（`audit` 用）。 */
  counts: Record<DiagnosticClass, number>
  /** 没读到的来源；**空数组**才允许 `actionable` 为空这一个事实叫 `none`。 */
  notScreened: DumpInvocation['flag'][]
  /** 组合树顶层条目数。 */
  entryCount: number
}

/** 装配输入：成功与失败分支同构（差别只在 `verdict` 从哪来）。 */
interface AssemblyInput {
  resolvedBlock: EffectiveConfigBlock
  resolved: ResolvedKey
  /** 跑过的每一次 dump（含「读没读到」）。 */
  runs: readonly DumpRun[]
  screening: Screening
  /** hmr 探测结果；**没探测过就不要传**（「没查」≠「没有」）。 */
  hmr?: HmrProbe
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
      dshHome: {
        type: 'string',
        // 参数规则住在参数上（SHAPE §2）：工具描述里不复述，也就不占那 4 行的预算。
        // ⚠️ 措辞不承诺任何「自动配对」—— 发现出来的 authority 推不出 home（SHAPE §1.2 硬边界 2）。
        description:
          'Read another instance instead: its DSH_HOME path. Omit to use the configured one.',
      },
    },
    output: toolOutput(DUMP_CONFIG_TOOL, TABLE),

    timeoutMs: toolBudgetMs(WORKLOAD, deps.config),
    isConcurrencySafe: () => true,

    async execute(rawArgs, exec) {
      const args = rawArgs as DumpConfigArgs
      // 两条命令**共享**这一份 deadline（`lib/timeouts.ts` 的纪律：传输必须先于工具）。
      const deadline = createDeadline(toolBudgetMs(WORKLOAD, deps.config), deps.now)

      // 本次调用认的 home（参数优先）。**预算仍取 `deps.config`**：预算是插件配置的事，
      // 与「看哪个实例」无关。
      const home = withHomeOverride(deps.config, args.dshHome)
      const missing = assertResolvedDshHome(home)
      if (missing !== undefined) return toOutput(missing)

      const profile = args.profile ?? home.profile
      const resolvedBlock = effectiveConfig(home, 'not-used', profile)
      const resolved = toResolvedKey(resolvedBlock)
      // 子进程必须看到**同一个** home：只加参数不注环境的话，`dsh` 会读回本进程的 home，
      // 而 `resolved.dshHome` 印的是参数值 —— 那正是最坏的那种「看着成功读错目录」。
      const spawn = spawnWithHome(deps.spawn, childEnvFor(deps.env, home.dshHome))

      // **execute 绝不 throw**（SHAPE §4）：宿主只把抛出去的异常当失败，一旦抛出去，
      // 我们的 `verdict` / `key` / `audit` 全部失效、而且没有任何红线会报警。
      try {
        const launch = resolveDshLaunch()

        const configRun = judgeDump(
          await runDump(launch, profile, '--dump-config', {
            spawn,
            timeoutMs: budgetFor(toolBudgetMs(WORKLOAD, deps.config), deadline),
            signal: exec.signal,
          }),
          resolved,
        )
        if (configRun.failure !== undefined) {
          // 读不出组合树就不再跑第二次：schema 诊断的 `path` 要靠这棵树才解析得成 entry id，
          // 没有它，`preset-*` 那条已知误报会被当成真问题报出来 —— 所以「第一次读不出来」
          // 不是少一份材料，而是**判不了**。
          const head = configRun.failure
          return toOutput(
            fail(
              head.error,
              stopped(head, bareRun(configRun, resolvedBlock, resolved)),
              head.nextStep,
            ),
          )
        }

        const entries = parseComposedEntries(configRun.invocation.stdout)
        const schemaRun = judgeDump(
          await runDump(launch, profile, '--dump-config-schema', {
            spawn,
            timeoutMs: budgetFor(toolBudgetMs(WORKLOAD, deps.config), deadline),
            signal: exec.signal,
          }),
          resolved,
        )
        const runs = [configRun, schemaRun]
        // 归集**只做这一次**：成功与失败两条分支读的是同一份结果（这正是解耦点）。
        const screening = screen(runs, entries)
        const hmr = probeHmr(configRun.invocation.stdout)
        const assembly: AssemblyInput = { resolvedBlock, resolved, runs, screening, hmr }

        if (schemaRun.failure !== undefined) {
          const head = schemaRun.failure
          return toOutput(fail(head.error, stopped(head, assembly), head.nextStep))
        }

        const hasSchemaErrors = schemaRun.invocation.exitCode === 1
        if (screening.actionable.length > 0) {
          // **不能**用 `hasSchemaErrors` 当这个分支的门：组合期错出现在 `--dump-config`
          // 的 **stderr** 上，而那条命令的退出码恒 0、也不做 schema 校验。
          // 用退出码当门 = 把「插件被整条丢弃」这一类静默故障整条漏掉。
          const composition = screening.actionable.filter(
            (item) => item.classification === 'composition-error',
          )
          return toOutput(
            fail(
              {
                kind: 'command-failed',
                message:
                  composition.length > 0
                    ? `${String(composition.length)} composition error(s): patch rows were dropped by skipping (the exit code is still 0)`
                    : `--dump-config-schema reported ${String(screening.actionable.length)} error(s) that need attention`,
              },
              assembled({ ...assembly, verdict: actionableVerdict(screening.actionable) }),
              {
                tool: DUMP_CONFIG_TOOL,
                args: retryArgs(resolved),
                why: 'after fixing the rows named in actionable, run it again and confirm actionable is empty',
              },
            ),
          )
        }

        return toOutput(
          ok(
            assembled({
              ...assembly,
              verdict: cleanVerdict({
                hasSchemaErrors,
                knownFalsePositiveCount: screening.knownFalsePositives.length,
              }),
            }),
          ),
        )
      } catch (error) {
        // 兜底分支（B24 的判据是「返回的是过守卫的合法结果」，不是「没报错」）。
        // 这里**一次 dump 都没跑成**：`actionable` 为空是事实，覆盖为空也是事实 ——
        // 两个来源都得记成「没读到」，否则渲染层会把「不知道」印成 `actionable: none`。
        const screening = screen([], [])
        const verdict =
          'nothing could be judged: the dump threw before it produced a result, ' +
          'so this is a failure of this plugin rather than a verdict about the config'
        return toOutput(
          fail(
            toToolError(error, 'dumping the profile config'),
            assembled({
              verdict: `${verdict}${coverageSentence(screening)}`,
              resolvedBlock,
              resolved,
              runs: [],
              screening,
            }),
          ),
        )
      }
    },
  })
}

/**
 * 判一次 dump：**读到了**还是**读不到**。
 *
 * 同一个判定有两个用处，所以它返回「观测」而不是整份结果：
 * ① `screen()` 用它决定这个来源算不算「筛过了」；② 执行路径用它决定报什么失败。
 *
 * @param invocation dump 结果。
 * @param resolved 这次用的配置（`nextStep.args.profile` 的取值来源）。
 */
function judgeDump(invocation: DumpInvocation, resolved: ResolvedKey): DumpRun {
  const failure = failureOf(invocation, resolved)
  return failure === undefined ? { invocation } : { invocation, failure }
}

/**
 * 一次 dump 的失败头（读得到时返回 `undefined`）。
 *
 * 每一条都带**实质 `verdict`**（模型只能从 L1 知道「所以呢」）与已经在手的事实
 * （`key.invocations`：跑了哪个 flag、退出码、stderr）。
 *
 * @param invocation dump 结果。
 * @param resolved 这次用的配置（`nextStep.args.profile` 的取值来源）。
 */
function failureOf(invocation: DumpInvocation, resolved: ResolvedKey): FailureHead | undefined {
  if (invocation.aborted) {
    return {
      error: {
        kind: 'cancelled',
        message: 'the caller cancelled this execution',
      },
      verdict: `nothing could be judged: ${invocation.flag} was cancelled by the caller, so no dump was completed`,
      nextStep: {
        manual: true,
        why: 'cancellation is up to the caller; retrying the same call is pointless',
      },
    }
  }
  if (invocation.timedOut) {
    return {
      error: {
        kind: 'timeout',
        message: `${invocation.flag} timed out (the transport layer timed out first, before the tool budget)`,
      },
      verdict: `nothing could be judged: ${invocation.flag} hit the transport timeout before the tool budget, so there is no dump output to read`,
      nextStep: {
        tool: DUMP_CONFIG_TOOL,
        args: retryArgs(resolved),
        // 这里曾经是唯一不指向已捕获证据的失败分支：stderr 就在 `key.invocations` 里，
        // 而超时的原因常常已经写在上面了（输出太大、宿主要现装依赖 …）。
        // 点名 `schemaDumpTimeoutMs`（不是 `timeoutMs`）：本工具走的是**慢档**，
        // 让模型去调另一个字段只会让人白改一次配置。
        // ⚠️ 但**不能让模型去调它**：`schemaDumpTimeoutMs` 是**插件配置字段**，不是本工具的
        // 参数（`defineTool` 的 `timeoutMs` 注册期定死，工具 schema 送到模型前只保留
        // name/description/parameters）⇒ 能做这件事的只有**改配置的人**，动作必须指给人。
        why:
          'read the stderr captured in invocations first, then retry once as-is; ' +
          'if it keeps timing out, a human must raise the plugin config schemaDumpTimeoutMs — ' +
          'a call cannot raise it, since dump-config-schema is slow by nature',
      },
    }
  }
  if (invocation.spawnError !== undefined) {
    const notFound = invocation.spawnError.includes('ENOENT')
    const head: FailureHead = {
      error: {
        kind: notFound ? 'not-configured' : 'internal',
        message: `cannot start dsh: ${invocation.spawnError}`,
      },
      verdict: notFound
        ? 'nothing could be dumped: dsh could not be started at all, so this plugin has no way to see what the profile composes to'
        : 'nothing could be dumped: starting dsh failed with an unexpected error, which is a problem on this side rather than a verdict about the config',
    }
    return notFound
      ? {
          ...head,
          nextStep: {
            manual: true,
            why: 'make dsh runnable — put it on PATH, or run this plugin on the same node as the host — then call this tool again',
          },
        }
      : head
  }
  if (invocation.flag === '--dump-config' && invocation.exitCode !== 0) {
    // 契约上恒 0；非 0 说明是没见过的形态，值得单独报出来（恒定知识在描述层）。
    return {
      error: {
        kind: 'command-failed',
        message: `--dump-config unexpectedly exited with code ${String(invocation.exitCode)} (the contract is always 0)`,
      },
      verdict: `--dump-config exited with code ${String(invocation.exitCode)}, which contradicts its always-0 contract: the composition may not have been produced at all, so nothing here can be trusted`,
      nextStep: {
        manual: true,
        why: 'read the stderr captured in invocations and settle why the exit code is not 0 before looking at the config',
      },
    }
  }
  if (
    invocation.flag === '--dump-config-schema' &&
    invocation.exitCode !== 0 &&
    invocation.exitCode !== 1
  ) {
    return {
      error: {
        kind: 'command-failed',
        message: `--dump-config-schema exited with code ${String(invocation.exitCode)} (the contract only allows 0 and 1)`,
      },
      verdict: `--dump-config-schema exited with code ${String(invocation.exitCode)}, which is outside the contract: the schema dump did not run to a known state, so its diagnostics cannot be read as a verdict`,
      nextStep: {
        manual: true,
        why: 'read the stderr captured in invocations and settle why the exit code is outside {0,1} before looking at the config',
      },
    }
  }
  return undefined
}

/**
 * 每一个诊断来源**怎么读** —— 「工具打算读哪些东西」的唯一声明。
 *
 * 顺序即 `notScreened` 的输出顺序（先组合树那份、再 schema 那份）。
 * 目前一次 dump 恰好等于一个来源，所以它是按 flag 声明的；将来某个 dump
 * 若多出一条读法，加在这里即可，`screen()` 不必改。
 */
const DIAGNOSTIC_SOURCES: ReadonlyArray<{
  flag: DumpInvocation['flag']
  read(invocation: DumpInvocation): DumpDiagnostic[]
}> = [
  {
    flag: '--dump-config',
    // 组合期错只写在它的 stderr 上：那条命令的退出码恒 0、也不做 schema 校验（活跃坑 14）。
    read: (invocation) => parseDiagnosticsFromStderr(invocation.stderr),
  },
  {
    flag: '--dump-config-schema',
    // schema 的 diagnostics 在 **stdout**；它自己的 stderr 另有一份带严重级的文本。
    read: (invocation) => [
      ...parseDiagnosticsFromSchemaText(invocation.stdout),
      ...parseDiagnosticsFromStderr(invocation.stderr),
    ],
  },
]

/**
 * 归集：把「跑过的 dump」读成诊断，并记下**哪几个来源根本没读到**。
 *
 * **成功与失败分支共用它**。两条纪律都落在这里：
 * ① 已经跑成的那次 dump 的诊断**不因后一次失败而消失**（本工具曾有过的缺陷）；
 * ② 「没读到」与「读到了、是空的」分开走：前者进 `notScreened`，只有后者才允许
 * 渲染成 `actionable: none`（三值纪律）。
 *
 * @param runs 跑过的每一次 dump（含「读没读到」）。
 * @param entries 组合树条目（解析 `path` 用）。
 */
function screen(runs: readonly DumpRun[], entries: readonly ComposedEntry[]): Screening {
  const raw: DumpDiagnostic[] = []
  const notScreened: DumpInvocation['flag'][] = []
  for (const source of DIAGNOSTIC_SOURCES) {
    const run = runs.find((item) => item.invocation.flag === source.flag)
    if (run === undefined || run.failure !== undefined) {
      // 没跑 / 没读成 ⇒ 这个来源「没筛」：既不抹掉别处读到的东西，也不假装筛过。
      notScreened.push(source.flag)
      continue
    }
    raw.push(...source.read(run.invocation))
  }
  const diagnostics = dedupe(raw.map((item) => classifyDiagnostic(item, entries)))
  return {
    diagnostics,
    actionable: diagnostics.filter(isActionable),
    knownFalsePositives: diagnostics.filter(
      (item) => item.classification === 'known-false-positive',
    ),
    counts: countByClass(diagnostics),
    notScreened,
    entryCount: entries.length,
  }
}

/**
 * 只跑了第一次 dump 时的装配输入（**没有** hmr 探测 —— 「没查」≠「没有」）。
 *
 * @param run 那一次 dump 的观测。
 * @param resolvedBlock 生效配置块。
 * @param resolved `key` 里的配置投影。
 */
function bareRun(
  run: DumpRun,
  resolvedBlock: EffectiveConfigBlock,
  resolved: ResolvedKey,
): AssemblyInput {
  return { resolvedBlock, resolved, runs: [run], screening: screen([run], []) }
}

/**
 * 三层记录的**唯一装配点**：`key` / `audit` 的形状只在这里定义一次。
 *
 * 它同时服务成功与失败分支 —— 这就是「跑了什么」与「读到了什么」解耦的落地：
 * 结论（`verdict`）由各分支自己给，而**观测**永远来自同一份 `Screening`。
 *
 * @param input 装配输入（含这一分支的 `verdict`）。
 */
function assembled(input: AssemblyInput & { verdict: string }): ToolData<DumpConfigKey> {
  const { verdict, resolvedBlock, resolved, runs, screening, hmr } = input
  return {
    verdict,
    key: {
      resolved,
      actionable: screening.actionable,
      notScreened: screening.notScreened,
      invocations: runs.map((run) => invocationKey(run.invocation)),
      ...(hmr === undefined ? {} : { hmr: { present: hmr.present, disabled: hmr.disabled } }),
    },
    audit: asAudit({
      resolved: resolvedBlock,
      counts: screening.counts,
      diagnostics: screening.diagnostics,
      knownFalsePositives: screening.knownFalsePositives,
      notScreened: screening.notScreened,
      entryCount: screening.entryCount,
      // 每一次 dump 的复核材料。`read=false` 就是「这一次没读到」，原因一并带上 ——
      // 复核者先看这一格，再看 `stoppedBecause`。
      invocations: runs.map((run) => ({
        flag: run.invocation.flag,
        exitCode: run.invocation.exitCode,
        timedOut: run.invocation.timedOut,
        aborted: run.invocation.aborted,
        spawnError: run.invocation.spawnError ?? null,
        stderr: run.invocation.stderr.trim(),
        read: run.failure === undefined,
        stoppedBecause: run.failure?.error.message ?? null,
      })),
      hmr: hmr ?? null,
    }),
  }
}

/**
 * 失败分支的 `data`：`verdict` = 「为什么停」＋「覆盖到哪」。
 *
 * 为什么两句都要在 L1：`error.message` **不进模型文本**（SHAPE §4.1 的字段角色表），
 * 所以「这次 dump 超时了」与「这份筛选不完整」都只能由 `verdict` 承载。
 *
 * @param head 失败头（来自那次没读成的 dump）。
 * @param input 装配输入（观测来自**所有**跑过的 dump）。
 */
function stopped(head: FailureHead, input: AssemblyInput): ToolData<DumpConfigKey> {
  return assembled({
    ...input,
    verdict: `${head.verdict}${coverageSentence(input.screening)}`,
  })
}

/**
 * 覆盖不全时补进 L1 的那一句；**全覆盖时返回空串**（那时 `actionable: none` 才合法）。
 *
 * 两种情形分开写：观测到真错时先报错（覆盖不全只是附注），什么都没观测到时
 * 必须说清「这不是 none，是没读到」。
 *
 * @param screening 本次归集结果。
 */
function coverageSentence(screening: Screening): string {
  if (screening.notScreened.length === 0) return ''
  const missing = flagList(screening.notScreened)
  if (screening.actionable.length === 0) {
    return `; the screening is incomplete (not read: ${missing}), so this is not a "none"`
  }
  return (
    `; the screening is incomplete (not read: ${missing}), but ` +
    `${String(screening.actionable.length)} actionable diagnostic(s) still came out of the dumps that did complete`
  )
}

/**
 * 把来源列表拼成一句话：`a` / `a and b` / `a, b and c`。
 *
 * @param flags 来源名。
 */
function flagList(flags: readonly string[]): string {
  if (flags.length <= 1) return flags[0] ?? ''
  return `${flags.slice(0, -1).join(', ')} and ${flags[flags.length - 1] ?? ''}`
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
 * 「再跑一次本工具」用的参数。
 *
 * 为什么把 `dshHome` 一起带上：这次的结论是关于**那个实例**的，重试若丢掉 home，
 * 模型会拿到另一个实例的答案 —— 而两次调用的输出长得一模一样（同一个 schema），
 * 这种错**看起来像成功**。只在**参数覆盖过**时才带：没覆盖时再调一次本来就是对的，
 * 多印一个配置里的值只会变成噪声（L2 规则：只放本次非默认的）。
 *
 * 值必须在模型看得见的地方（B17）：`key.resolved` 会渲染成 L2 的 `resolved: … dshHome=…` 行。
 *
 * @param resolved `key` 里的配置投影。
 */
function retryArgs(resolved: ResolvedKey): Record<string, string> {
  return resolved.dshHomeSource === 'tool-argument'
    ? { profile: resolved.profile, dshHome: resolved.dshHome }
    : { profile: resolved.profile }
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
  // 渲染层**绝不抛**（`render.ts` §3.1）：`ensureToolResult` 合成的兜底里 `data.key` 是 `{}`
  // （`lib/errors.ts` 的 `malformedResult`），数组字段可能整块缺席 —— `for…of undefined`
  // 会当场抛。`key` 本身不是对象时也要有输出，**不许静默返回空数组**。
  if (!key || typeof key !== 'object') return [GUARD_FALLBACK_LINE]
  const lines: string[] = [resolvedLine(key.resolved)]
  // 「缺席」与「空数组」不是一回事：兜底路径上不许把「不知道」印成「没有」
  // （活跃坑 18 的三值纪律，`listStartupLogs` 那边同样处理）。
  if (!Array.isArray(key.invocations)) {
    lines.push('dump: unknown (the guard synthesized this result)')
  } else {
    for (const invocation of key.invocations) lines.push(invocationLine(invocation))
  }
  if (key.hmr) {
    lines.push(
      key.hmr.present === true
        ? `hmr: present=yes disabled=${String(key.hmr.disabled)}`
        : 'hmr: present=no',
    )
  }
  if (!Array.isArray(key.actionable)) {
    lines.push('actionable: unknown (the guard synthesized this result)')
  } else if (key.actionable.length > 0) {
    for (const item of key.actionable) lines.push(actionableLine(item))
    // 真错要报，覆盖不全也要说：有内容时读者最容易以为「该看的都看了」，
    // 而这次其实还有来源没读 —— 剩下半张图没照。
    if (Array.isArray(key.notScreened) && key.notScreened.length > 0) {
      lines.push(coverageLine(key.notScreened))
    }
  } else {
    lines.push(actionableNoneLine(key.notScreened))
  }
  return lines
}

/**
 * `actionable` 为空时那一行 —— **三值**，不是两值。
 *
 * - 该读的都读到了、且是空的 → `actionable: none`；
 * - 有来源没读到 → `unknown`（**绝不许**印 `none`：那会把「不知道」说成「没有」）；
 * - 这份结果根本没记覆盖（旧形状 / 别处合成的 `key`）→ 同样 `unknown`，并说清原因。
 *
 * @param notScreened `key.notScreened`（形状不可信时按 `unknown` 处理）。
 */
function actionableNoneLine(notScreened: unknown): string {
  if (!Array.isArray(notScreened)) {
    return 'actionable: unknown (this result does not record which sources were read, so a "none" cannot be claimed)'
  }
  if (notScreened.length === 0) return 'actionable: none'
  const flags = notScreened.filter((flag): flag is string => typeof flag === 'string')
  return `actionable: unknown (${flagList(flags)} ${flags.length === 1 ? 'was' : 'were'} not read, so this is not a "none")`
}

/**
 * 覆盖不全、但**已经观测到真错**时另起的那一行。
 *
 * @param flags 没读到的来源。
 */
function coverageLine(flags: readonly string[]): string {
  return `screening: incomplete (not read: ${flagList(flags)})`
}

/**
 * 兜底行：`ensureToolResult` 合成的结果里 `key` 是 `{}`。
 *
 * 为什么**必须**印出来而不是省略整行：这条路径只在「工具自己返回了坏形状」时才走到 ——
 * 那一刻模型最该知道的事实正是「这个结果是守卫合成的，里面的字段都不可信」。
 * 省略这一行会让兜底**静默**（看起来像一次正常的空结果）。
 */
const GUARD_FALLBACK_LINE = 'resolved: unknown (the guard synthesized this result)'

/**
 * `resolved:` 那一行 —— 整份结论的前提，也是 `nextStep.args.profile` 的取值来源。
 *
 * 字段按 `typeof` 防御取值：兜底合成的 `key` 里整块 `resolved` 都不在，
 * 直接取字段会当场抛（这正是本工具过去在兜底路径上崩掉的原因）。
 *
 * @param resolved `key.resolved`（可能是兜底合成的 `undefined`）。
 */
function resolvedLine(resolved: ResolvedKey | undefined): string {
  if (!resolved || typeof resolved !== 'object') return GUARD_FALLBACK_LINE
  const profile = typeof resolved.profile === 'string' ? resolved.profile : 'unknown'
  const dshHome = typeof resolved.dshHome === 'string' ? resolved.dshHome : 'unknown'
  const source = typeof resolved.dshHomeSource === 'string' ? resolved.dshHomeSource : 'unknown'
  return `resolved: profile=${profile} dshHome=${dshHome} (${source})`
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
