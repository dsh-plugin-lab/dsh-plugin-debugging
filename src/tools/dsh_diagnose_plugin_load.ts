/**
 * `dsh_diagnose_plugin_load` —— 「插件到底加载了吗」的外部三处 + 启动日志。
 *
 * 对应 SKILL §3.1 / §3.2 / §3.8。真正的硬证据只有一条：**启动失败**时才会生成的
 * `$DSH_HOME/logs/startup-<ISO>-<uuid>.log`。所以「一条都没有」= 好消息。
 *
 * ## 这一版（W1 样板）的三处形状改造 —— 见 docs/SHAPE.md §2 / §3 / §5
 *
 * 1. **恒定知识搬去描述层**：旧的 `loadProofCaveat`（365 字符）与 `observation.note`
 *    （156 字符）每次调用逐字重复，现在只在 `description` 的**边界段写一次**
 *    （本工具是观察类，没有「代价段」，所以边界段占两行、合成后仍是四行）。
 *    `startupLogsNote` 同理（它也是恒定的），它的知识压进了描述第 3 行。
 * 2. **`data` 三段划分**（判据是 §5 那句：**模型看不到它，会不会做出不同的下一步？**）：
 *    - `verdict`：`buildVerdict` 的结果（L1）。成功、失败两条路都有。
 *    - `key`：要模型决策的原料 —— 观测模式与原因、树里 entry 总数与相位直方图、
 *      每个包的名字/相位/命中的 entryId/错误、入口的三值判定、在不在 bundles、
 *      产物相对进程的**三值**判定（`changed-after-process-start` 明说「推不出」）、
 *      启动日志的**三值状态与路径**、以及实际用的目录/profile/端口。
 *    - `audit`：其余全部（bundles 全列表、安装形态与 patch 细节、`missingInject` /
 *      `fiberState` / `basis`、`port.lookup`、启动日志全字段）—— 给人复核，不进模型文本。
 *    - **三值不许压成两值**：入口是 `present|missing|unknown`、启动日志是
 *      `present|none|unknown`。把「没查到」印成「不在」/「没有」是静默坏
 *      （缺 A 的假红与活跃坑 18 各是一次教训）。
 * 3. **不再有「结论当下一步」**：旧代码是 `ok({ ...data, verdict }, { why: verdict })`
 *    （同一个 const 绑了两次）。现在 `nextStep` 要么带工具与参数、要么 `manual: true`、
 *    要么根本不出现。
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import { fail, ok, toToolError, type JsonValue } from '../lib/errors.js'
import { budgetFor, createDeadline, toolBudgetMs, type Workload } from '../lib/timeouts.js'
import { indexByIdentifier, projectFiberPhase, worstOf, type FiberPhase } from '../lib/fiber.js'
import type { LoaderEntrySnapshot } from '../lib/fiber.js'
import { lookupPort, type PortLookupResult } from '../lib/ports.js'
import {
  checkInstalledEntry,
  listStartupLogs,
  profileDir,
  readInstallShape,
  readProfileManifest,
  readTextIfExists,
  type EntryCheck,
  type InstallShape,
  type Presence,
  type ResolutionSource,
  type StartupLog,
  type StartupLogsResult,
} from '../lib/profile.js'
import type { RenderTable } from '../lib/render.js'
import {
  parseStartupLog,
  unreadableStartupLog,
  type StartupLogParse,
  type StartupLogReport,
  type StartupMessage,
} from '../lib/startup-log.js'
import { composeDescription, type ToolDescription } from './describe.js'
import {
  assertResolvedDshHome,
  effectiveConfig,
  resolvePort,
  toOutput,
  toolOutput,
  withCallHome,
  type EffectiveConfigBlock,
  type ToolDeps,
} from './shared.js'

/** 工具名。 */
export const DIAGNOSE_PLUGIN_LOAD_TOOL = 'dsh_diagnose_plugin_load'

/**
 * 本工具的工作量档：**快档**。
 *
 * 它读的是文件与加载器树，唯一的外部命令是端口查询（也走同一档预算）。
 */
const WORKLOAD: Workload = 'quick'

/** 参数。 */
interface DiagnoseArgs {
  package?: string
  port?: number
  /**
   * 另一个实例的 `DSH_HOME`（跨实例观察，SHAPE §1.2 的 D′）。
   *
   * ⚠️ 它只换得动**磁盘那一半**（日志、profile 清单、安装形态）；Loader 树那一半来自
   * 本进程内存。两者必须分开报 —— 见 `key.scope` 与 `crossInstanceScope`。
   */
  dshHome?: string
}

/**
 * 产物（入口文件）相对监听进程的**三值**判定 —— **闭集，不许压成布尔**。
 *
 * 参照系只有一个：**监听进程的启动时间**。宿主 `alpha.3` 的
 * `feat(hmr): replace plugins whose package files changed during profile recomposition`
 * 之后，HMR 重组合会**就地驱逐模块缓存并替换插件**：进程 `startedAt` 不变，磁盘上却已是新代码。
 * 于是「产物比进程新」**推不出**「宿主跑的是旧产物」—— 两个解释都成立：
 * ① 没人换过它，进程仍跑改动前的那份；② 刚被热替换过，跑的正是改动后的那份。
 *
 * 所以中间那一档**不是结论，是「这个比较不足以判定」**：
 * - `changed-after-process-start`：产物比进程启动时刻新。**推不出宿主跑的是旧产物**
 *   （可能在跑新产物 —— 热替换过）。这是本条修复前的缺陷所在：那时的取值是 `stale=true`，
 *   等于把「推不出来」印成「宿主跑的是历史遗留」。
 * - `unchanged-since-process-start`：产物不比进程启动时刻新（相等按这一档算）——
 *   也就是说启动那一刻盘上就是这份文件，没有「改完没重启」的信号。
 * - `undated`：**没有可比的参照**（没给端口 / 端口查不了 / 读不到启动时间 /
 *   读不到产物 mtime / 启动时间解析不出来）。它**既不是**「没这回事」，
 *   **也不允许**被读成「产物是新的」。
 *
 * ⚠️ 三档互不重叠，塌成两档就是**反向结论**（活跃坑 18 那一族）：
 * 把 `undated` 压成「没变」会漏掉真有一次热替换后的判断，
 * 把 `changed-after-process-start` 压成「跑的是旧产物」就是本条修复前的假阳性。
 */
export type ArtifactFreshness =
  'changed-after-process-start' | 'unchanged-since-process-start' | 'undated'

/**
 * 该三值的**闭集**（运行时形状，供调用方与判据枚举）。
 *
 * 为什么导出成值而不只是类型：类型在运行期**不存在**，而「三值不许塌成两值」
 * 这条纪律需要一个能被枚举、被数出来的真源 —— 判据断言「取到的三个值互不相同
 * 且都在闭集里」，少一档就红。
 */
export const ARTIFACT_FRESHNESS_VALUES: readonly ArtifactFreshness[] = [
  'changed-after-process-start',
  'unchanged-since-process-start',
  'undated',
]

/** 一个包的诊断条目（内部记录；`key` / `audit` 是它的两种投影）。 */
interface PackageDiagnosis {
  packageName: string
  /** 是否在 profile 的 `dsh.profile.bundles` 里。 */
  inBundles: boolean
  install: InstallShape
  entry: EntryCheck
  /**
   * 产物相对监听进程的三值判定（见 {@link ArtifactFreshness}）。
   *
   * ⚠️ 它**不回答**「宿主跑的是不是旧产物」—— 那个问题在本参照系下**推不出来**
   * （热替换会让「产物新」与「跑的就是新产物」同时成立）。
   */
  artifactFreshness: ArtifactFreshness
  /**
   * **观测**到的相位（只有 `observation.mode === 'observed'` 时才有值）。
   *
   * 与上面那些字段的关系是「观测 vs 推断」，两者**不混**：
   * `install` / `entry` / `inBundles` 只证前置条件，这一项才回答「崩没崩」。
   */
  observed?: {
    /** 命中 Loader 树里的哪几行（可能 0 行 = 装了但树里没有这一行）。 */
    matchedEntryIds: string[]
    phase: FiberPhase
    error?: string
    missingInject?: string[]
    fiberState?: number
    basis: string
  }
}

/** 观测的整体状态（**不含**任何恒定的解释文字 —— 那些在描述层边界段）。 */
interface ObservationBlock {
  /** `observed` = 读到了宿主 Loader 树；`inferred` = 读不到，以下全是推断。 */
  mode: 'observed' | 'inferred'
  /** `inferred` 时的原因（原样展示，让人知道为什么没能观测）。 */
  reason?: string
  /** 读到的 entry 总数（`observed` 时）。 */
  entryCount?: number
  /**
   * 相位直方图 —— `active=162 failed=2 null=29` 形态。
   *
   * 为什么要它：单个包的相位可能因为「还没轮到挂载」而看起来正常或异常，
   * 一眼看到整棵树的分布，才能判断这次快照是不是**稳定态**。
   */
  phaseHistogram?: Record<string, number>
}

/** 这次调用实际用的是哪份配置（L2 用的投影：只留要模型决策的部分）。 */
interface ResolvedKey {
  dshHome: string
  dshHomeSource: EffectiveConfigBlock['dshHomeSource']
  profile: string
  /** 实际探测的端口；`undefined` = 这次没用到端口。 */
  port?: number
  portSource?: EffectiveConfigBlock['portSource']
  /**
   * profile 目录的绝对路径。
   *
   * **只在「读不到 profile 的 package.json」那条失败路径上出现** —— 那时
   * 「我到底去哪个目录找了」就是模型唯一能拿去做下一步的标识符；成功路径上它
   * 由 `dshHome` + `profile` 完全决定，再印一次只是噪声（L2 规则：只放本次非默认的）。
   */
  profileDir?: string
}

/** 一个包在 `key` 里的投影（只留要模型决策的字段）。 */
interface PackageKey {
  packageName: string
  /**
   * 入口文件的三值判定。
   *
   * **不许压成布尔**：`unknown`（包解析不到 / 清单里没有可读的入口）与 `missing`
   * （入口声明了、文件真的不在）对下一步的决定完全不同 —— 后者会让组合层**整条丢弃**
   * 该插件，前者只是「这次没查到」。用 `entryExists === false` 冒充「不存在」正是
   * 缺 A 那条假红的来源。
   */
  entryState: Presence
  inBundles: boolean
  /** 产物相对进程的**三值**判定（见 {@link ArtifactFreshness}）。 */
  artifactFreshness: ArtifactFreshness
  /** `dsh.bundle` 的声明检查（B）。它解释「装了却没生效」的第三类原因。 */
  bundle: BundleKey
  /** 观测到的相位；`inferred` 时不出现。 */
  phase?: FiberPhase
  /** 命中的 entryId（可能为空数组 = 装了但树里没有这一行）。 */
  matchedEntryIds?: string[]
  error?: string
}

/**
 * `dsh.bundle` 声明的检查结果（**三值，不许压成两值**）。
 *
 * 为什么必须进 `key`：`declared === false` 改变的是**「去哪找原因」**这一层 ——
 * 这个包**根本不贡献组合层**，所以「查它有没有被后一层整行替换」这个方向是错的；
 * `patchIssue` 非空则相反：宿主把**整条层**丢掉了（连它插的行、它覆盖的 config 一起没了），
 * 而插件只是「好像没装」，正确动作是修那个文件而不是改配置。
 *
 * 三值的来源与 `EntryCheck` 一一对应：`undeclared` → `false`、`unknown` → `null`、
 * 其余 → `true`。**「读不到那份 package.json」不等于「没声明」**（B0 的假红正是
 * 从这里出去的：官方包只在安装锚点下存在，profile 本地没有目录）。
 */
interface BundleKey {
  /** `true` = 声明了（字符串与数组两种形态都算）；`false` = 没声明；`null` = 读不到（未知）。 */
  declared: boolean | null
  /** 读了哪条锚点的那份 `package.json`（`unresolved` = 两条都没解析到）。 */
  resolvedFrom: ResolutionSource
  /** 声明的 patch 文件（**包相对**路径，按宿主应用顺序）。 */
  patches: string[]
  /** `patches` 里不存在的那些（`missing` 时非空）。 */
  missing: string[]
  /**
   * 声明本身有问题时才有值（两种都会让宿主**丢掉整条层**）：
   * - `missing`：声明了、文件不在（数组形态下**任何一个**不在都算）；
   * - `malformed`：`dsh.bundle.patch` 既不是字符串也不是字符串数组。
   */
  patchIssue?: 'missing' | 'malformed'
}

/**
 * 启动日志在 `key` 里的投影（**三值**，与 `listStartupLogs` 的三值一一对应）。
 *
 * 为什么必须有 `unknown`：日志目录读不到与「目录里没有日志」表面上都是「一条都没有」，
 * 而只有后者是好消息。把「未知」说成「没有」是活跃坑 18 那种静默坏 —— 所以
 * `unknown` 是一个**本次观测**，必须出现在 L2，而不是被压成恒定措辞。
 */
interface StartupLogsKey {
  /** `present` = 真列到了；`none` = 确定没有；`unknown` = 目录读不到（**不等于没有**）。 */
  state: 'present' | 'none' | 'unknown'
  /** 日志路径（`state === 'present'` 时是全部）。 */
  paths: string[]
  /** `unknown` 时的原因。 */
  readError?: string
}

/** `key`：下一个决定可能要用到的原料。 */
interface DiagnoseKey {
  resolved: ResolvedKey
  /**
   * 这次调用是不是**跨实例**：给了 `dshHome` 参数时是 `'cross-instance'`，否则整个字段不出现。
   *
   * 它存在的唯一理由是让「**两半分开报**」成为**可判**的事实（而非散文）：磁盘证据来自
   * 参数指定的那个 home，而 Loader 树只来自本进程 —— 后者**任何参数都换不动**。
   * 不出现 ≠ 没这回事，而是「这次没有跨实例」。
   */
  scope?: 'cross-instance'
  observation?: ObservationBlock
  packages: PackageKey[]
  /**
   * 启动日志的**路径**与三值状态；**早期失败**（没走到这一步）时整个字段不出现 ——
   * 那时「没查」与「查了没有」必须可分开，所以不给一个 `none` 冒充。
   */
  startupLogs?: StartupLogsKey
  /**
   * 启动日志的**解析结论**（`startupLogs` 只回答「有几份、在哪」，这里回答
   * 「里面说了什么、有没有解出来」）。
   *
   * 为什么必须进 `key` 而不是只进 `audit`：**解析失败**与**真的没有失败条目**
   * 在 JSON 里必须可分（活跃坑 18），而 `audit` 模型根本读不到 —— 放进去等于没加。
   * 没有日志（`none`）/ 目录读不到（`unknown`）时整个字段不出现。
   */
  startupEvidence?: StartupEvidenceKey
}

/**
 * 一条「解析这件事本身出了问题」的记录。
 *
 * 三个地方共用这一个形状（解析失败 / 读不到 / 有缺口）—— 它们对下一步的决定不同，
 * 但都只需要「哪份日志 + 一句话」。
 */
interface StartupLogNote {
  /** 日志文件名。 */
  name: string
  /** 一句话（英文，可能进 L2）。 */
  detail: string
}

/**
 * 启动日志的解析结论（`key` 的投影）。
 *
 * 两个「不许压成两值」的地方：
 * - `parseState` 的 `unparsed` 与「日志里没有失败条目」是两件事；
 * - `parseState` 的 `unreadable`（读不到）是**未知**，同样不等于「没有失败」。
 */
interface StartupEvidenceKey {
  /** 参与解析的日志份数。 */
  logCount: number
  /**
   * 解析状态（四值，四件不同的事）：
   * - `parsed`：每份都解出来了，且没有缺口；
   * - `partial`：有的没解出来 / 有缺口 / 有的读不到 —— 证据不完整；
   * - `unparsed`：日志读到了，但**一份都没解出来**（判红）；
   * - `unreadable`：一份都**读不到**（未知，不是「没有失败」）。
   */
  parseState: 'parsed' | 'partial' | 'unparsed' | 'unreadable'
  /** 读到了内容、但段没认出来的那些。 */
  parseErrors?: StartupLogNote[]
  /** 读不到的那些（未知）。 */
  readErrors?: StartupLogNote[]
  /** 部分解析的缺口（每条都由标记推出）。 */
  gaps?: StartupLogNote[]
  /** 拿来投影下面那些事实的日志文件名（最新那份**解析成功**的）。 */
  from?: string
  /**
   * 这份日志相对**当前进程**的新鲜度（三值；只在有 `from` 时出现）。
   *
   * - `current`：它的 mtime 不早于当前进程的启动时间 ⇒ 属于这次进程；
   * - `stale`：**早于**当前进程 ⇒ 是**历史遗留**，不是「这次加载失败」的证据
   *   （真机实例：今天 11:03 起的宿主，`logs/` 里只有一份 09-29 写的日志）；
   * - `undated`：**没有可比对的进程启动时间**（没给端口 / 端口查不了 / 读不到启动时间）
   *   ⇒ 既不能说它属于当前进程，也不能说它属于历史 —— **不许暗示它是当前的**。
   *
   * 为什么必须三值：把 `undated` 压成 `current` 就会重现本条修复前的缺陷
   * （拿旧失败当今天的结论）；压成 `stale` 则会**反向**丢掉真实证据。
   */
  freshness?: 'current' | 'stale' | 'undated'
  /** 判 `freshness` 用的参照（ISO 8601）：监听进程的启动时间；`undated` 时不存在。 */
  processStartedAt?: string
  /** 那份日志自己的 profile 与本次是否一致（读不出 profile 时不出现）。 */
  profileMatches?: boolean
  /** 不一致时日志的 profile（模型要看到是哪个）。 */
  logProfile?: string
  /** headline 里的 required 未激活数（**不是**失败插件个数）。 */
  requiredNotActivated?: number
  /** 失败条目（有界：真机 1 条）。`error` 是唯一能导向「端口被占」那类根因的原料。 */
  failed?: { id: string; required: boolean; module?: string; error?: string }[]
  /** 那份日志看起来被截断（写盘中途被杀）。**不是**解析失败。 */
  truncated?: boolean
}

/** 一份启动日志在 `audit` 里的完整记录（列表字段 + 解析结论 + 解析出的事实）。 */
interface StartupLogRecord extends StartupLog {
  parse: StartupLogParse
  report: StartupLogReport
}

/** 读一份启动日志内容的上限（字节）；超限只解析前面这一段并标记截断。 */
const MAX_STARTUP_LOG_BYTES = 262_144

/**
 * 本工具的描述（SHAPE §2.1 四段骨架）。
 *
 * 逐段理由：
 * - `what`：动词 + 对象。
 * - `useWhen`：模型的路由信号 —— 它是四个观察入口里唯一回答「加载没有」的那个。
 * - `boundary`：**两行**，承载从输出里搬出来的恒定知识。它是本工具唯一的反直觉点所在：
 *   ① 「三处前置条件都在」**不等于**「加载成功」（旧 `observation.note` / `loadProofCaveat`
 *   的 inferred 分支）；② Loader 树的相位**不是公开 API**，而且没稳定时「还在挂载」的行
 *   会被读成 import 失败（同一个 caveat 的 observed 分支）—— 后半句是**必须写进模型文本**的
 *   那一条（`lib/fiber.ts` 文件头的边界段原文：调用方必须把这一条写进输出，别让「刚插进来」
 *   被读成「崩了」）；它原先只进了 `audit.basis`，而 `audit` 模型看不到，模型在 L2 只看到
 *   `error=failed to import`。观察类工具没有「代价段」，所以两行边界 + 两行前置 = 合成后仍是四行。
 */
export const DIAGNOSE_PLUGIN_LOAD_DESCRIPTION: ToolDescription = {
  what: 'Checks whether a plugin loaded.',
  useWhen: 'Use when an installed plugin never shows up.',
  boundary:
    'Preconditions only prove it could load; startup-*.log is failure-only and may be old.\n' +
    'Loader-tree phase is host-internal; mounting rows read like import failures.',
}

/** 本工具的输出表：L1 就是 `data.verdict` 逐字，L2 由 `key` 投影成行。 */
const TABLE: RenderTable<DiagnoseKey> = {
  key: (data) => keyText(data.key),
  // 默认 15 行不够：省略 `package` 参数时会一个包一行，本机 `web` profile 有 15 个 bundle，
  // 加上模式/直方图/日志/生效配置几行就超了 —— 那会把**最要紧的包行**截掉。
  maxKeyLines: 24,
}

/**
 * 造工具。
 *
 * @param deps 运行期依赖。
 */
export function createDiagnosePluginLoadTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: DIAGNOSE_PLUGIN_LOAD_TOOL,
    description: composeDescription(DIAGNOSE_PLUGIN_LOAD_DESCRIPTION),
    parameters: {
      package: {
        type: 'string',
        description: 'Package name, e.g. dsh-zhihu-search; omit for all bundles.',
      },
      port: {
        type: 'integer',
        description: 'Host port; omit for the configured one.',
      },
      dshHome: {
        type: 'string',
        description:
          "Read another instance's disk evidence instead: its DSH_HOME path. Omit to use the configured one.",
      },
    },
    output: toolOutput(DIAGNOSE_PLUGIN_LOAD_TOOL, TABLE),

    timeoutMs: toolBudgetMs(WORKLOAD, deps.config),
    isConcurrencySafe: () => true,

    async execute(rawArgs, exec) {
      // 「绝不 throw」是契约的承载条件：一旦抛出去，宿主会把它包成 `toolErrorResult`，
      // 模型看到的是一句裸 `Error: …`，`verdict` / `key` / `audit` 全部失效（SHAPE §4）。
      // 兜底分支的判据（B24）是「返回的是**过了守卫**的合法结果」，不是「没报错」。
      try {
        const args = rawArgs as DiagnoseArgs
        const deadline = createDeadline(toolBudgetMs(WORKLOAD, deps.config), deps.now)

        // 本次调用认的实例（参数优先）。**它只换得动「磁盘那一半」** ——
        // Loader 树来自 `deps.loader`（本进程内存），跨不了实例；那一半必须显式标注，
        // 见下面的 `crossInstance` / `key.scope`。
        const call = withCallHome(deps, args.dshHome)
        const crossInstance = call.config.dshHomeSource === 'tool-argument'

        const missing = assertResolvedDshHome(call.config)
        if (missing !== undefined) return toOutput(missing)

        const { dshHome, profile } = call.config
        const dir = profileDir(dshHome, profile)
        const resolvedPort = resolvePort(args.port, call.config.port, call.env)
        const resolved = effectiveConfig(call.config, resolvedPort)
        const keyResolved = toResolvedKey(resolved)

        // 预算在真正开工前就耗尽：文件层诊断虽然便宜，也不该在「已超时」的前提下继续跑 ——
        // 那会让宿主先掐掉我们，模型拿到的是裸 TimeoutError 而不是结构化 timeout。
        if (deadline.expired()) {
          return toOutput(
            fail(
              { kind: 'timeout', message: 'the tool budget ran out before any work started' },
              {
                verdict:
                  'no work started: the tool budget was already spent, so nothing was read at all',
                key: { resolved: keyResolved, packages: [] },
                audit: {},
              },
              {
                tool: DIAGNOSE_PLUGIN_LOAD_TOOL,
                // 参数原样带回去（跨实例时把 `dshHome` 一起带上，见 `retryArgs`）。
                // 空对象是**有意**的（B17 的例外：没有标识符可指），
                // 但不能传 `{ package: undefined }` —— 那不是 JSON。
                args: retryArgs(
                  keyResolved,
                  args.package === undefined ? {} : { package: args.package },
                ),
                // ⚠️ `timeoutMs` 是**插件配置字段**，不是本工具的参数（`defineTool` 的
                // `timeoutMs` 注册期定死，工具 schema 送到模型前只保留 name/description/
                // parameters）⇒ 能做这件事的只有**改配置的人**，所以动作必须指给人。
                why:
                  'retry once; the port lookup is the slowest step here, so if it keeps timing out ' +
                  'a human must raise the plugin config timeoutMs — a call cannot raise it',
              },
            ),
          )
        }

        const manifest = await readProfileManifest(dir)

        if (manifest === undefined) {
          return toOutput(
            fail(
              {
                kind: 'not-found',
                message: `cannot read the profile package.json at ${dir}`,
              },
              {
                verdict: `nothing could be checked: there is no readable profile package.json at ${dir}, so either the directory or the profile name is wrong`,
                // 这条路径上目录就是唯一可判的标识符 —— L2 必须把它印出来。
                key: {
                  resolved: { ...keyResolved, profileDir: dir },
                  packages: [],
                },
                audit: asAudit({ resolved, profileDir: dir }),
              },
              {
                tool: 'dsh_dump_config',
                args: retryArgs(keyResolved, { profile }),
                why: 'use it to check whether this profile composes at all; if it does, the directory above is the wrong one',
              },
            ),
          )
        }

        const names = args.package === undefined ? manifest.bundles : [args.package]
        const portLookup: PortLookupResult | undefined =
          resolvedPort === undefined
            ? undefined
            : await lookupPort(resolvedPort.port, {
                spawn: deps.spawn,
                timeoutMs: budgetFor(toolBudgetMs(WORKLOAD, deps.config), deadline),
                signal: exec.signal,
              })

        // 端口查询只是**加分项**：它失败（超时 / 查不了）不该让整份文件层诊断作废。
        // 但**调用方取消**是另一回事 —— 那是我们主动放弃，不能拿半份结果当结论。
        if (exec.signal.aborted) {
          return toOutput(
            fail(
              { kind: 'cancelled', message: 'the caller cancelled this execution' },
              {
                verdict: 'the diagnosis is incomplete: the caller cancelled this execution',
                key: { resolved: keyResolved, packages: [] },
                audit: asAudit({ resolved, profileDir: dir }),
              },
              {
                manual: true,
                why: 'cancellation is up to the caller; retrying the same call is pointless',
              },
            ),
          )
        }

        // ── 启动日志：先**解析**，再把它当证据用 ─────────────────────────────────
        // 读**全部**日志、不抽样（抽样 = 静默 skip，活跃坑 18）；每份按字节上限读。
        // 解析器是纯函数（`lib/startup-log.ts`），读盘与上限判定留在这里。
        const startup = await listStartupLogs(dshHome)
        const startupReports = await readStartupReports(startup)
        // 参照物与产物那条**同一个**：端口查询给出的监听进程启动时间（拿不到就是 `undefined`，
        // 于是新鲜度是「不知道」而不是猜 —— 见 `logFreshness`）。
        const processStartedAt = portLookup?.listeners[0]?.startedAt
        const startupEvidence = toStartupEvidence(startupReports, profile, processStartedAt)

        // ── 观测：试着直接读宿主 Loader 树（`fiber.state`） ──────────────────────
        // 读不到就降级成推断；**降级不是错误** —— 那是宿主内部 primitive，见 lib/fiber.ts 文件头。
        const loader = deps.loader()
        const index = loader.ok ? indexByIdentifier(loader.entries) : undefined

        const packages: PackageDiagnosis[] = []
        for (const packageName of names) {
          const install = await readInstallShape(dir, packageName)
          const entry = await checkInstalledEntry(dir, packageName)
          const diagnosed: PackageDiagnosis = {
            packageName,
            inBundles: manifest.bundles.includes(packageName),
            install,
            entry,
            // 参照物与启动日志那条**同一个**（上面那个 `processStartedAt`）——
            // 「一处一事实」：这里不再第二次从 `portLookup` 取。
            artifactFreshness: artifactFreshnessOf(entry, processStartedAt),
          }
          const matched = index?.get(packageName)
          // `worstOf` 返回 `undefined` 只对空数组 —— 上面的 `length > 0` 已经排除，
          // 但类型上仍要收窄；收窄失败时走「一行都没匹配上」那条路更安全。
          const worst = matched === undefined ? undefined : worstOf(matched)
          if (matched !== undefined && worst !== undefined) {
            // 一个包在树里可能不止一行（宿主自己有 `…/tools` 这种子路径行）。
            // 取「最坏的那一档」：只要有一行崩了，这个包就没在正常工作。
            // 严重级与 tie-break 都在 `lib/fiber.ts` 的 `worstOf` 里，这里不重排。
            diagnosed.observed = {
              matchedEntryIds: matched.map((row) => row.entry.entryId),
              phase: worst.observation.phase,
              ...(worst.observation.error === undefined ? {} : { error: worst.observation.error }),
              ...(worst.observation.missingInject === undefined
                ? {}
                : { missingInject: worst.observation.missingInject }),
              ...(worst.observation.fiberState === undefined
                ? {}
                : { fiberState: worst.observation.fiberState }),
              basis: worst.observation.basis,
            }
          } else if (index !== undefined) {
            // 读到了树、但这个包一行都没有 —— 本身就是硬证据：它没进树。
            diagnosed.observed = {
              matchedEntryIds: [],
              phase: 'failed',
              error: 'the package has no row in the Loader tree',
              basis:
                'the Loader tree was read, but no row matched this package or module name — the composition layer does not include it',
            }
          }
          packages.push(diagnosed)
        }

        const observation: ObservationBlock = loader.ok
          ? {
              mode: 'observed',
              entryCount: loader.entries.length,
              phaseHistogram: histogram(loader.entries),
            }
          : {
              mode: 'inferred',
              ...(loader.reason === undefined ? {} : { reason: loader.reason }),
            }

        const key: DiagnoseKey = {
          resolved: keyResolved,
          // 跨实例时**必须**在 `key` 里留一个可判的记号：渲染层据此把「两半分开报」印出来。
          // 不给这个字段的话，「磁盘那一半是目标的、树那一半只是本进程的」这件事就只能靠
          // 读者自己从 `dshHomeSource` 推 —— 而它恰恰是最容易被读成「整套结论都属于目标实例」的地方。
          ...(crossInstance ? { scope: 'cross-instance' as const } : {}),
          observation,
          packages: packages.map(toPackageKey),
          startupLogs: toStartupLogsKey(startup),
          ...(startupEvidence === undefined ? {} : { startupEvidence }),
        }
        const audit = toAudit({
          dir,
          resolved,
          manifest,
          packages,
          portLookup,
          startup,
          startupReports,
        })

        // **只看 `entryState === 'missing'`**：`unknown` 是「这次没查到」，把它算成缺失
        // 正是缺 A 那条假红的形状（默认参数时 7 个官方包只在安装锚点下存在）。
        const missingEntries = packages.filter((item) => item.entry.entryState === 'missing')
        if (missingEntries.length > 0) {
          const names = missingEntries.map((item) => item.packageName).join(', ')
          return toOutput(
            fail(
              {
                kind: 'not-found',
                message: `entry file missing for ${String(missingEntries.length)} package(s): ${names}`,
              },
              {
                verdict: `entry file missing for ${String(missingEntries.length)} package(s) (${names}) — the composition layer drops those plugins entirely`,
                key,
                audit,
              },
              {
                manual: true,
                why: `rebuild the artifacts for ${names}: an entry that points to no file makes the composition layer drop that plugin entirely`,
              },
            ),
          )
        }

        // 「产物在进程启动之后才变过」这一档：**不是**「宿主跑的是旧产物」的结论
        // （热替换之后产物新与跑的是新产物同时成立，见 `ArtifactFreshness`）。
        // 它只把「这一档需要有人去判一下」交给下一步。
        const changed = packages.filter(
          (item) => item.artifactFreshness === 'changed-after-process-start',
        )
        const failed = observedWith(packages, 'failed').filter(
          (item) => item.observed?.matchedEntryIds.length !== 0,
        )
        const absent = packages.filter((item) => item.observed?.matchedEntryIds.length === 0)
        const pending = observedWith(packages, 'pending')

        const verdict = buildVerdict({
          loaderOk: loader.ok,
          failed,
          absent,
          pending,
          changed,
          startup: startupEvidence,
          profile,
          ...(crossInstance ? { crossHome: dshHome } : {}),
        })

        return toOutput(
          ok(
            { verdict, key, audit },
            nextStepFor({
              profile,
              resolved: keyResolved,
              failed,
              absent,
              pending,
              changed,
              startup: startupEvidence,
            }),
          ),
        )
      } catch (error) {
        // 兜底分支（B24 的判据是「返回的是过守卫的合法结果」，不是「没报错」）。
        return toOutput(
          fail(toToolError(error, 'diagnosing whether the plugin loaded'), {
            verdict:
              'nothing was concluded: the diagnosis threw before it produced a result, so this says nothing about whether the plugin loaded',
            key: {},
            audit: {},
          }),
        )
      }
    },
  })
}

/**
 * 挑下一步。
 *
 * ## `args` 里只放两类值
 *
 * 红线 **B17** 要求 `nextStep.args` 的每个值都要出现在 **L1/L2 ∪ 目标工具自己的描述/参数文本**
 * 里（第二半是 2026-10-13 Lead 裁决时扩的取值面）。于是：
 * - **本次观测到的标识符**（包名、entryId、路径、端口）必须已经印在 L1/L2 里 —— 下面
 *   每一条工具建议都按这条设计（`package`/`profile` 都在 L2 出现过）；
 * - **目标工具自己的封闭枚举**（`change: 'host-code'`）不必出现在本次输出里：模型在
 *   **那个工具的参数描述**里就读得到它。
 *
 * 反过来的纪律同样重要：**不许为了过 B17 而把该给的工具建议改成 `manual`**，也不许
 * 把一个「本次观测到的标识符」塞进 args 去凑。`manual` 只留给**真的没有工具可派**的动作
 * （下面 failed / cancelled / entry-missing 三支才是）。
 *
 * @param input 各档命中的包。
 */
function nextStepFor(input: {
  profile: string
  /** 本次生效配置的 `key` 投影：`retryArgs` 靠它判「这次有没有用参数覆盖 home」。 */
  resolved: ResolvedKey
  failed: readonly PackageDiagnosis[]
  absent: readonly PackageDiagnosis[]
  pending: readonly PackageDiagnosis[]
  /** 产物比进程启动时刻新的那些（**推不出**宿主跑的是旧产物，见 `ArtifactFreshness`）。 */
  changed: readonly PackageDiagnosis[]
  /** 启动日志的解析结论：解析不了 / 读不到时，唯一能派的就是「自己去读那份文件」。 */
  startup: StartupEvidenceKey | undefined
}): { tool: string; args?: JsonValue; why: string } | { manual: true; why: string } | undefined {
  if (input.failed.length > 0) {
    const names = input.failed.map((item) => item.packageName).join(', ')
    // failed 这一支**确实没有工具可派**：要看日志、改被重载/被装的那份代码 —— 留 manual。
    return {
      manual: true,
      why: `read the newest startup log for the failure stack of ${names}, then fix that plugin; no tool on this side can do it`,
    }
  }
  // 解析不了 / 读不到的日志：本工具已经**明确说它没解出来**，但内容还在那个文件里。
  // 没有工具能替模型读一份格式不认识的日志 —— 这正是 `manual` 的定义。
  const blocked = startupBlockedLogs(input.startup)
  if (blocked.length > 0) {
    const one = blocked.length === 1
    return {
      manual: true,
      why: `open ${blocked.join(', ')} and read it yourself: this tool could not interpret ${one ? 'that file' : 'those files'}, so nothing in ${one ? 'it' : 'them'} was used as evidence`,
    }
  }
  const absentName = input.absent[0]?.packageName
  if (absentName !== undefined) {
    return {
      tool: 'dsh_dump_config',
      // `profile` 出现在 L2 的 `resolved:` 行里 —— B17 因此成立。
      // 跨实例时 `dshHome` 必须一起带上，否则这一步会去问**另一个实例**（见 `retryArgs`）。
      args: retryArgs(input.resolved, { profile: input.profile }),
      why: `check whether the composition layer really carries the row for ${absentName}, and whether a later layer replaced the whole patch`,
    }
  }
  if (input.pending.length > 0) {
    const pendingName = input.pending[0]?.packageName
    if (pendingName !== undefined) {
      return {
        tool: DIAGNOSE_PLUGIN_LOAD_TOOL,
        // 同上：重跑本工具若丢掉 `dshHome`，会拿到另一个实例的答案 —— 而两次输出长得一模一样。
        args: retryArgs(input.resolved, { package: pendingName }),
        why: `re-run once the injected services have mounted, to see whether ${pendingName} moves from pending to active`,
      }
    }
  }
  if (input.changed.length > 0 && input.failed.length === 0 && input.absent.length === 0) {
    const names = input.changed.map((item) => item.packageName).join(', ')
    return {
      tool: 'dsh_check_effect_mode',
      // `host-code` 是**目标工具自己的封闭枚举**：模型在它的 `change` 参数描述里读得到，
      // 所以它不需要出现在本次输出里（B17 扩后的取值面）。**没有为了过检查改写它。**
      // 跨实例时 `dshHome` 一起带上（`dsh_check_effect_mode` 同样有跨实例接缝）。
      args: retryArgs(input.resolved, { change: 'host-code' }),
      // ⚠️ 措辞不许断言「宿主跑的是旧产物」：那正是本条修复去掉的那个推断 ——
      // 派出去的动作是**分类**（重启 / 就地换入 / 无需动），不是「去重启」。
      why: `the artifacts for ${names} changed after this process started, so whether the running build is the older one or the current one is undetermined from that; classify what host code needs before restarting anything`,
    }
  }
  // 「全都 active」= 没有动作可做 → 不出现（「没有动作就不出现」是 §3.1 的规则）。
  return undefined
}

/**
 * 「再跑一次本工具 / 派给下一个工具」用的参数：**跨实例时把 `dshHome` 一起带上**。
 *
 * 为什么必须带（同 `dsh_dump_config.retryArgs` 的理由）：这次的结论是关于**那个实例**的，
 * 下一步若丢掉 home，模型会拿到另一个实例的答案 —— 而两次调用的输出长得一模一样
 * （同一张输出表），这种错**看起来像成功**。只在**参数覆盖过**时才带：没覆盖时再调一次
 * 本来就是对的，多印一个配置里的值只会变成噪声（L2 规则：只放本次非默认的）。
 *
 * 值必须在模型看得见的地方（B17）：`key.resolved` 会渲染成 L2 的 `resolved: … dshHome=…` 行。
 *
 * @param resolved `key` 里的配置投影。
 * @param extra 目标工具自己的参数。
 */
function retryArgs(
  resolved: ResolvedKey,
  extra: Record<string, JsonValue> = {},
): Record<string, JsonValue> {
  return resolved.dshHomeSource === 'tool-argument'
    ? { ...extra, dshHome: resolved.dshHome }
    : extra
}

/**
 * 挑出观测相位等于给定值、且**真命中了树里的行**的包。
 *
 * @param packages 全部诊断条目。
 * @param phase 目标相位。
 */
function observedWith(
  packages: readonly PackageDiagnosis[],
  phase: FiberPhase,
): PackageDiagnosis[] {
  return packages.filter((item) => item.observed?.phase === phase)
}

/**
 * 拼一句结论（L1）。
 *
 * 优先级按「用户下一步要做什么」排：崩了最重要，其次没进树，再次 pending，
 * 最后才是「三处前置条件都在」这种弱结论。**启动日志的证据排在活的树证据之后**：
 * 它是「上一次致命启动」的快照，而树是**现在**。
 *
 * @param input 各档命中的包 + 启动日志的解析结论。
 */
function buildVerdict(input: {
  loaderOk: boolean
  failed: readonly PackageDiagnosis[]
  absent: readonly PackageDiagnosis[]
  pending: readonly PackageDiagnosis[]
  /** 产物比进程启动时刻新的那些（**推不出**宿主跑的是旧产物，见 `ArtifactFreshness`）。 */
  changed: readonly PackageDiagnosis[]
  startup: StartupEvidenceKey | undefined
  profile: string
  /** 跨实例时才给：本次读的磁盘 home（见 `crossInstanceScope`）。 */
  crossHome?: string
}): string {
  // 启动日志里那些「**别把它读成好消息**」的部分，两条分支都要带上。
  const logParts = startupVerdictParts(input.startup, input.profile)
  const scope = crossInstanceScope(input.crossHome)
  const scopeParts = scope === undefined ? [] : [scope]
  if (!input.loaderOk) {
    return [
      'Could not read the Loader tree, so nothing here is observed: bundles / install shape / entry file only prove that loading was possible, not that it succeeded',
      ...logParts,
      ...scopeParts,
    ].join('. ')
  }
  const parts: string[] = []
  if (input.failed.length > 0) {
    const detail = input.failed
      .map((item) => `${item.packageName} (${item.observed?.error ?? 'reason unavailable'})`)
      .join('; ')
    parts.push(`Observed load failure: ${detail}`)
  }
  if (input.absent.length > 0) {
    parts.push(
      // ⚠️ **不许说「Installed」**：这一档的判据只是「树读到了、这个包一行都没匹配上」
      // （见 `absent` 的取法），**不含**任何「它装了」的观测 —— 模型显式传一个没装的包名时
      // 同一段代码照样走到这里，说「Installed」就是把没查到写成查到了。
      `Named but absent from the Loader tree: ${input.absent.map((item) => item.packageName).join(', ')}` +
        ' (the composition layer does not include it — check whether it made it into bundles, and whether a later layer replaced the whole patch row)',
    )
  }
  if (input.pending.length > 0) {
    const detail = input.pending
      .map((item) => {
        const missing = item.observed?.missingInject ?? []
        return `${item.packageName} (waiting for ${missing.length === 0 ? 'mounting' : missing.join(', ')})`
      })
      .join('; ')
    parts.push(`Still pending: ${detail}`)
  }
  if (parts.length === 0) {
    // 没有树上的发现时，才轮到这两句「弱结论」；它们必须**先于**日志证据出现，
    // 否则「全都 active」这句话会被日志证据挤掉（那是本次观测的结论，不能丢）。
    if (input.changed.length > 0) {
      parts.push(
        `artifacts changed after this process started: ${input.changed.map((item) => item.packageName).join(', ')} — that alone does not say the host runs older artifacts, because an in-place reload can have replaced them after the process started; whether the running build is the older or the newer one cannot be decided from the process start time`,
      )
    } else {
      parts.push(
        'all observed rows are active: the plugin really did load, so the problem is not at the "did it load" layer',
      )
    }
  }
  parts.push(...logParts)
  parts.push(...scopeParts)
  return parts.join('. ')
}

/**
 * 跨实例时那句「**两半分开报**」——磁盘证据属于目标实例，Loader 树只属于本进程。
 *
 * 为什么必须写出来（维护者的硬要求，SHAPE §1.2）：`dshHome` 让**磁盘**那一半指向另一个实例，
 * 但 `entry.fiber.state` 那一半来自**本进程内存**，任何参数都换不动它。不写明的话，
 * 模型会把整份结论读成「**那个**实例的树长这样」—— 而那是它看不到的东西。
 *
 * 措辞把**具体 home** 带进来（不只是「另一个实例」）：这句话因此随调用变化，
 * 不会被 B16（「同一个工具两份 fixture 里都不变的 ≥40 字符行」）当成恒定块。
 *
 * @param crossHome 跨实例时的 home；同实例（没给参数）时是 `undefined`。
 * @returns 那一句；同实例时返回 `undefined`（**不许**恒印一句免责）。
 */
function crossInstanceScope(crossHome: string | undefined): string | undefined {
  if (crossHome === undefined) return undefined
  return (
    `Disk evidence above is from ${crossHome} (the DSH_HOME you passed); ` +
    'the Loader-tree half is this process only, so it says nothing about that instance'
  )
}

/**
 * 把一份生效配置投影成 L2 用的 `key.resolved`。
 *
 * **非默认的部分**：`port` / `portSource` 只在这次真的用了端口时才有值
 * （`not-used` / `none` 是「没用上」，不是结论）；`dshHome` 与它的来源、
 * `profile` 则永远留着 —— 整份诊断的全部结论都建立在「读的是哪个目录、哪个 profile」上。
 *
 * @param resolved 生效配置块。
 */
function toResolvedKey(resolved: EffectiveConfigBlock): ResolvedKey {
  const base: ResolvedKey = {
    dshHome: resolved.dshHome,
    dshHomeSource: resolved.dshHomeSource,
    profile: resolved.profile,
  }
  if (resolved.port === null) return base
  return { ...base, port: resolved.port, portSource: resolved.portSource }
}

/**
 * 一个包在 `key` 里的投影。
 *
 * `basis` / `missingInject` / `fiberState` / 安装形态 / patch 细节**不进这里**：
 * 前三个是解释性文字（`verdict` 已经把该说的说了），后两个只有复核时才要看 → `audit`。
 *
 * @param item 诊断条目。
 */
function toPackageKey(item: PackageDiagnosis): PackageKey {
  const observed = item.observed
  return {
    packageName: item.packageName,
    entryState: item.entry.entryState,
    inBundles: item.inBundles,
    artifactFreshness: item.artifactFreshness,
    bundle: toBundleKey(item.entry),
    ...(observed === undefined
      ? {}
      : {
          phase: observed.phase,
          matchedEntryIds: [...observed.matchedEntryIds],
          ...(observed.error === undefined ? {} : { error: observed.error }),
        }),
  }
}

/**
 * 造 `audit`（给人复核；不进模型文本，所以它可以大、可以有恒定文字）。
 *
 * @param input 这次诊断的全部原始记录。
 */
function toAudit(input: {
  dir: string
  resolved: EffectiveConfigBlock
  manifest: { bundles: readonly string[] }
  packages: readonly PackageDiagnosis[]
  portLookup: PortLookupResult | undefined
  startup: StartupLogsResult
  startupReports: readonly StartupLogRecord[]
}): JsonValue {
  const audit = {
    profileDir: input.dir,
    resolved: input.resolved,
    bundles: [...input.manifest.bundles],
    bundleCount: input.manifest.bundles.length,
    packages: input.packages.map((item) => ({
      packageName: item.packageName,
      inBundles: item.inBundles,
      install: item.install,
      entry: item.entry,
      artifactFreshness: item.artifactFreshness,
      ...(item.observed === undefined ? {} : { observed: item.observed }),
    })),
    /** 端口查询的明细（端口值本身在 `resolved`，不在这里重复）。 */
    port: { lookup: input.portLookup ?? null },
    /**
     * 启动日志全字段 + 三值状态（`dirExisted` 与 `readError` 分开留痕），
     * 以及**每份日志的完整解析记录**（全部段、等待表、entries 表、组合期消息）。
     *
     * 为什么解析细节在 `audit` 而不是 `key`：真机那份的等待表有 11 条、entries 有 12 条，
     * 而其中与本插件无关的是绝大多数 —— 逐条问「模型看不到会不会换下一步」，答案是否；
     * `key` 只留**有界**且**直接改变下一步**的部分（headline 的 required 数、失败条目）。
     */
    startupLogs: {
      state: toStartupLogsKey(input.startup).state,
      dirExisted: input.startup.dirExisted ?? null,
      readError: input.startup.readError ?? null,
      logs: [...input.startup.logs],
      reports: input.startupReports.map((item) => ({
        name: item.name,
        path: item.path,
        sizeBytes: item.sizeBytes,
        mtimeMs: item.mtimeMs,
        parse: item.parse,
        // ⚠️ `report.messages` **必须重新投影**，不能直接带出去。
        report: { ...item.report, messages: item.report.messages.map(toMessageAudit) },
      })),
    },
  }
  return asAudit(audit)
}

/**
 * 一条启动日志消息在 `audit` 里的投影（**只带真有值的字段**）。
 *
 * ## 为什么这里必须多走一步（2026-10-13 真机回归的漏点）
 *
 * 宿主在工具返回值上跑逐值校验（`@deepseek-ai/dsh-util-values` 的 `walkJsonValue`），
 * 它拒绝 `undefined`。而 `lib/startup-log.ts` 的 `readStartupSection` 是这样写的：
 *
 * ```ts
 * current.text = firstArgText(inline[1] ?? '')
 * ```
 *
 * `firstArgText` 在认不出 `args` 的文本时返回 `undefined`，于是那条消息上就**真真切切**
 * 挂着一个值为 `undefined` 的自有可枚举属性 —— 与 `StartupMessage.text?: string`
 * 这个**类型**声明不符（声明是可选字段，运行期却是「存在但为 undefined」）。
 *
 * 实测（本机那份 `EADDRINUSE` 启动日志）：`messages[2]` 是
 * `{ name: 'workspace-registry', type: 'warn', text: undefined }`，
 * 于是整个工具返回 `Error: tool "dsh_diagnose_plugin_load" returned invalid output:
 * value is not lossless JSON` —— **带不带 `package` 参数都复现**，而模型拿不到任何
 * `verdict` / `key` / `audit`。
 *
 * 语义取法：**字段缺席，不是 `null`，更不是 `?? 'unknown'`**。这条消息的原文就是
 * 「认不出这条组合期消息的第一个参数」，`undefined` 在这里表示「没有」，不表示「未知」。
 * 与本仓其它地方的条件展开是同一条纪律。
 *
 * @param message 解析出来的一条组合期消息。
 */
function toMessageAudit(message: StartupMessage): JsonValue {
  return {
    ...(message.name === undefined ? {} : { name: message.name }),
    ...(message.type === undefined ? {} : { type: message.type }),
    ...(message.text === undefined ? {} : { text: message.text }),
  }
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
 * 把 `listStartupLogs` 的三值结果投影成 `key`。
 *
 * 顺序就是三值的判定顺序：**读不到 → `unknown`**（绝不等于「没有」）；
 * 列到了且有日志 → `present`；其余（目录不存在 / 目录里没有）→ `none`。
 *
 * @param startup `listStartupLogs` 的结果。
 */
function toStartupLogsKey(startup: StartupLogsResult): StartupLogsKey {
  const paths = startup.logs.map((log) => log.path)
  if (startup.readError !== undefined) {
    return { state: 'unknown', paths: [], readError: startup.readError }
  }
  return paths.length === 0 ? { state: 'none', paths: [] } : { state: 'present', paths }
}

/**
 * 把 `key` 投影成 L2 的逐行文本。
 *
 * 排序即输出顺序：**先框架（读了哪份配置），再结论的原料（模式 / 直方图 / 每包一行），
 * 最后是可继续读的路径（启动日志）**。
 *
 * @param key 本次的 `key`。
 */
function keyText(key: DiagnoseKey): string[] {
  // 渲染层**绝不抛**（`render.ts` §3.1）：`ensureToolResult` 合成的兜底里 `data.key` 是 `{}`
  // （`lib/errors.ts` 的 `malformedResult`），数组字段可能整块缺席 —— `for…of undefined`
  // 会当场抛。`key` 本身不是对象时也要有输出，**不许静默返回空数组**。
  if (!key || typeof key !== 'object') return [GUARD_FALLBACK_LINE]
  const lines: string[] = [resolvedLine(key.resolved)]
  // 跨实例：紧跟 `resolved:` 印一行「两半分开报」的**可判**记号。它与 L1 那句同一个事实，
  // 但落在不同的层 —— L1 给判定、L2 给模型做下一步时要瞄的那两格（谁是目标的、谁是本进程的）。
  if (key.scope === 'cross-instance') {
    lines.push(
      'scope: disk evidence is from the DSH_HOME you passed; the Loader tree is this process only',
    )
  }
  const observation = key.observation
  if (observation !== undefined) {
    lines.push(`mode: ${observation.mode}`)
    if (observation.reason !== undefined) lines.push(`reason: ${observation.reason}`)
    if (observation.entryCount !== undefined) {
      lines.push(`entries: ${String(observation.entryCount)}`)
    }
    if (observation.phaseHistogram !== undefined) {
      lines.push(`phases: ${histogramText(observation.phaseHistogram)}`)
    }
  }
  // 「缺席」与「空列表」不是一回事：兜底路径上不许把「不知道」印成「一个包都没有」。
  if (!Array.isArray(key.packages)) {
    lines.push('packages: unknown (the guard synthesized this result)')
  } else {
    for (const item of key.packages) lines.push(packageLine(item))
  }
  const startup = key.startupLogs
  if (startup !== undefined) {
    if (startup.state === 'unknown') {
      // 「读不到目录」必须**原样**说出来：把它印成 `none` 就是活跃坑 18 的静默坏。
      lines.push('startupLogs: unknown')
      if (startup.readError !== undefined) lines.push(`logDirError: ${oneLine(startup.readError)}`)
    } else if (startup.state === 'none') {
      lines.push('startupLogs: none')
    } else {
      lines.push(`startupLogs: ${String(startup.paths.length)}`)
      for (const path of startup.paths) lines.push(`log: ${path}`)
    }
  }
  // 解析结论**必须**印出来：模型看不到 `parseState=unparsed` 就会把「没解出来」
  // 读成「没有失败插件」（活跃坑 18 的头号形态）。
  if (key.startupEvidence !== undefined) lines.push(...startupEvidenceLines(key.startupEvidence))
  return lines
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
 * `resolved:` 那一行。
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
  const port =
    typeof resolved.port !== 'number'
      ? ''
      : ` port=${String(resolved.port)} (${typeof resolved.portSource === 'string' ? resolved.portSource : 'unknown'})`
  const dir = typeof resolved.profileDir === 'string' ? ` dir=${resolved.profileDir}` : ''
  return `resolved: profile=${profile} dshHome=${dshHome} (${source})${port}${dir}`
}

/**
 * 一个包一行。
 *
 * @param item 包的 `key` 投影。
 */
function packageLine(item: PackageKey): string {
  const parts = [`${item.packageName}:`]
  if (item.phase !== undefined) parts.push(`phase=${item.phase}`)
  if (item.matchedEntryIds !== undefined) {
    parts.push(`ids=${item.matchedEntryIds.length === 0 ? 'none' : item.matchedEntryIds.join(',')}`)
  }
  parts.push(`bundles=${item.inBundles ? 'yes' : 'no'}`)
  parts.push(`entry=${entryText(item)}`)
  const bundle = bundleText(item.bundle)
  if (bundle !== undefined) parts.push(`bundle=${bundle}`)
  parts.push(`artifact=${item.artifactFreshness}`)
  if (item.error !== undefined) parts.push(`error=${oneLine(item.error)}`)
  return parts.join(' ')
}

/**
 * `entry=` 的取值。
 *
 * **C：`present` 必须带方向性措辞。** 独立验证者实测：本机 15 个 bundle 里有 5 个是
 * `present` 但组合树里没有同名行 —— `present` 只回答「**能不能解析到 + 入口文件在**」，
 * **不回答「进树 / 生效」**。当读不到树时，这一行是模型唯一原料，会被读成
 * 「装了就是生效了」。
 *
 * 取法：**只在读不到树时**补方向 —— 树读到了的时候，同一行里的 `ids=`（含 `ids=none`）
 * 已经**明确**回答了「在不在组合树里」，再补一句就是噪声（L2 规则：只放本次非默认的）。
 * `present` 的语义**没有改**（它是对的），只是把误导面消掉。
 *
 * @param item 包的 `key` 投影。
 */
function entryText(item: PackageKey): string {
  if (item.entryState !== 'present') return item.entryState
  if (item.matchedEntryIds !== undefined) return 'present'
  return 'present (resolvable; not proof of composition)'
}

/**
 * 把 `EntryCheck` 的 patch 字段投影成 `key.bundle`（**B**）。
 *
 * 三值取法：`undeclared` → `false`、`unknown` → `null`、其余 → `true`。
 * `patchIssue` 只在**声明本身有问题**时才有值 —— `present`（声明了且文件都在）是默认情形，
 * 不在这里造一个 `'ok'` 出来。
 *
 * 导出它是为了让测试能直接钉住「字符串与数组两种形态都认」这条判据，
 * 而不必绕一整套临时目录（那种写法会让「两种形态」的差别淹没在 fixture 里）。
 *
 * @param entry `checkInstalledEntry` 的结果。
 */
export function toBundleKey(entry: EntryCheck): BundleKey {
  const missing = entry.patches.filter((item) => !item.exists).map((item) => item.file)
  return {
    declared:
      entry.patchState === 'undeclared' ? false : entry.patchState === 'unknown' ? null : true,
    resolvedFrom: entry.resolvedFrom,
    patches: entry.patches.map((item) => item.file),
    missing,
    ...(entry.patchState === 'missing' ? { patchIssue: 'missing' as const } : {}),
    ...(entry.patchState === 'malformed' ? { patchIssue: 'malformed' as const } : {}),
  }
}

/**
 * `bundle=` 的取值；**默认情形（声明了、文件都在）返回 `undefined`**。
 *
 * L2 的规则是「只放本次非默认、非恒定、且下一个决定可能要用到的」：
 * 「声明了一个存在的 patch 文件」是本仓 32 个可读声明里 31 个的常态，印出来只是噪声。
 * 反过来，「没声明」与「声明坏了 / 文件不在」各自对应**不同的修法**，必须印。
 *
 * @param bundle `key.bundle`。
 */
function bundleText(bundle: BundleKey): string | undefined {
  if (bundle.declared === false) return 'none (contributes no layer)'
  if (bundle.declared === null) return `unknown (resolvedFrom=${bundle.resolvedFrom})`
  if (bundle.patchIssue === 'malformed') {
    return 'malformed declaration (the host drops the whole layer)'
  }
  if (bundle.patchIssue === 'missing') {
    return `missing ${bundle.missing.join(',')} (the host drops the whole layer)`
  }
  return undefined
}

/**
 * 直方图文本。
 *
 * 键**排序**后输出：同一棵树两次读不许给出不同顺序的行（定序写死，避免看起来像随机故障）。
 *
 * @param histogram 相位计数。
 */
function histogramText(histogram: Record<string, number>): string {
  return Object.entries(histogram)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([phase, count]) => `${phase}=${String(count)}`)
    .join(' ')
}

/**
 * 压成一行（错误文本可能带换行，进 L2 会把「一行一条」破坏掉）。
 *
 * @param text 原始文本。
 */
function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/**
 * 算相位直方图。
 *
 * 用的是本仓的**判定结果**（`failed` / `pending` / `active` / `disabled` / `unknown`），
 * 不是宿主那张 `FIBER_PHASE` 表 —— 后者的 `fiber === undefined` 会得到 `null`，
 * 恰恰把「import 期就崩」这一类抹平成「看不出来」。这里宁可把它单独记成 `failed`，
 * 再配合 `entryCount` 让人判断快照是不是稳定态。
 *
 * @param entries entry 快照。
 */
function histogram(entries: readonly LoaderEntrySnapshot[]): Record<string, number> {
  const result: Record<string, number> = {}
  for (const entry of entries) {
    const key = projectFiberPhase(entry).phase
    result[key] = (result[key] ?? 0) + 1
  }
  return result
}

/**
 * 比「产物 mtime」与「进程启动时间」，给出**三值**判定（见 {@link ArtifactFreshness}）。
 *
 * ## 为什么中间那一档不是结论
 *
 * 这一族比较（与启动日志的 `logFreshness` 同参照、同 `Date.parse` 容错）能**观察**到
 * 「产物在进程启动之后才变过」，但**推不出**「宿主跑的是旧产物」：
 * HMR 就地替换插件时，进程 `startedAt` 不变而磁盘上已是新代码 —— 两个解释都成立。
 * ⇒ 这一档的职责是**说出「这里推不出来」**，而不是换一个同样不可靠的参照系
 * （本机拿不到任何「entry 何时被换入」的观测面：loader `Entry` 与 cordis `Fiber`
 * 都没有时间字段，详见 `ArtifactFreshness` 的说明）。
 *
 * @param entry 入口检查结果。
 * @param startedAt 进程启动时间（ISO 8601）；拿不到时 `undefined`。
 */
function artifactFreshnessOf(entry: EntryCheck, startedAt: string | undefined): ArtifactFreshness {
  if (entry.entryMtimeMs === undefined || startedAt === undefined) return 'undated'
  const startedMs = Date.parse(startedAt)
  if (!Number.isFinite(startedMs)) return 'undated'
  // 相等按「没变过」算：「晚于进程启动」才是那个需要有人说清推不出来的那一档，
  // 边界不许把它误判成「变过了」（同 `logFreshness` 的边界取向）。
  return entry.entryMtimeMs > startedMs
    ? 'changed-after-process-start'
    : 'unchanged-since-process-start'
}

/**
 * 判一份启动日志相对当前进程的新鲜度（三值）。
 *
 * 与 {@link artifactFreshnessOf} **同族**：同一个参照（监听进程的 `startedAt`）、
 * 同样的 `Date.parse` 容错、同样在**拿不到参照时返回「不知道」而不是猜**。
 * 差别在问法与结论的方向：
 * - 这边问「这份日志属于当前进程吗」，而「旧日志」的含义是**这份证据是历史遗留** ——
 *   那个方向**单向**：早于进程就不可能属于这次进程，所以「不知道」压成任一边都不致命，
 *   而压成 `current` 才是本条修复前的缺陷（拿 09-29 的失败当今天的结论）；
 * - 那边问「产物比进程新吗」，而那个方向**推不出**结论（热替换会让产物新与跑的是新产物
 *   同时成立）—— 所以它多留了一档「推不出来」，见 `ArtifactFreshness`。
 *
 * 用 mtime 而不是日志内部那个 `timestamp`：后者可能整段缺失（解析缺口 / 截断），
 * 而「有没有新日志」这件事本来就是按**文件**判的（文件名的 ISO 也是写入时刻）。
 *
 * @param logMtimeMs 日志文件的 mtime（毫秒）。
 * @param processStartedAt 监听进程的启动时间（ISO 8601）；拿不到时 `undefined`。
 */
function logFreshness(
  logMtimeMs: number,
  processStartedAt: string | undefined,
): 'current' | 'stale' | 'undated' {
  if (processStartedAt === undefined) return 'undated'
  const startedMs = Date.parse(processStartedAt)
  if (!Number.isFinite(startedMs)) return 'undated'
  // 相等按「属于当前进程」算：致命启动错误是在进程起来的那一瞬间写的，
  // 而「早于进程」才是那个要报出来的结论 —— 边界不许把它误判成 stale。
  return logMtimeMs >= startedMs ? 'current' : 'stale'
}

/**
 * 读并解析**每一份**启动日志（读全部，不抽样 —— 抽样就是静默 skip，活跃坑 18）。
 *
 * 两条边界：
 * - 读不到（`readTextIfExists` 返回 `undefined`，它**绝不抛**）→ `parse.readError`：
 *   那是**未知**，不是「这份日志里没有失败」；
 * - 超过字节上限 → 只解析前面这一段并标记 `truncated`：那是**内容不全**，
 *   不是「格式不认识」。
 *
 * @param startup `listStartupLogs` 的结果（已按 mtime 降序）。
 */
async function readStartupReports(startup: StartupLogsResult): Promise<StartupLogRecord[]> {
  const records: StartupLogRecord[] = []
  for (const log of startup.logs) {
    const text = await readTextIfExists(log.path)
    if (text === undefined) {
      records.push({ ...log, ...unreadableStartupLog(`could not read ${log.path}`) })
      continue
    }
    const overLimit = log.sizeBytes > MAX_STARTUP_LOG_BYTES
    const content = overLimit ? text.slice(0, MAX_STARTUP_LOG_BYTES) : text
    records.push({
      ...log,
      ...parseStartupLog(content, overLimit ? { truncatedBySize: true } : {}),
    })
  }
  return records
}

/**
 * 把每份日志的解析结果汇总成 `key` 的投影。
 *
 * **两个轴不许混**：
 * - 「解析失败」（读到了内容、段没认出来）与「读不到」（IO）是两件不同的事；
 * - 两者又都与「日志里真的没有失败条目」不同 —— 后者只有 `parseState === 'parsed'`
 *   且 `failed` 为空时才成立。
 *
 * 第三个轴是**新鲜度**（`freshness`）：日志内容说了什么，与它是不是**这次进程**写的，
 * 是两件事。旧日志里的失败条目是真的，但它证明的是**上一次**启动失败。
 *
 * @param reports 每份日志的解析记录。
 * @param profile 本次诊断的 profile（用来判日志是否属于它）。
 * @param processStartedAt 当前进程的启动时间（ISO 8601）；拿不到时 `undefined`。
 */
function toStartupEvidence(
  reports: readonly StartupLogRecord[],
  profile: string,
  processStartedAt: string | undefined,
): StartupEvidenceKey | undefined {
  if (reports.length === 0) return undefined
  const unreadable = reports.filter((item) => item.parse.readError !== undefined)
  const readable = reports.filter((item) => item.parse.readError === undefined)
  const parsed = readable.filter((item) => item.parse.ok)
  const parseErrors = readable
    .filter((item) => !item.parse.ok)
    .map((item) => ({ name: item.name, detail: item.parse.reason ?? 'could not be parsed' }))
  const readErrors = unreadable.map((item) => ({
    name: item.name,
    detail: item.parse.readError ?? 'could not be read',
  }))
  const gaps = parsed.flatMap((item) =>
    item.parse.gaps.map((gap) => ({ name: item.name, detail: gap })),
  )
  const parseState: StartupEvidenceKey['parseState'] =
    readable.length === 0
      ? 'unreadable'
      : parsed.length === 0
        ? 'unparsed'
        : parsed.length < readable.length || gaps.length > 0 || unreadable.length > 0
          ? 'partial'
          : 'parsed'

  const evidence: StartupEvidenceKey = { logCount: reports.length, parseState }
  if (parseErrors.length > 0) evidence.parseErrors = parseErrors
  if (readErrors.length > 0) evidence.readErrors = readErrors
  if (gaps.length > 0) evidence.gaps = gaps

  // 事实只从**最新那份解析成功**的日志投影（`reports` 已按 mtime 降序）。
  const newest = parsed[0]
  if (newest === undefined) return evidence
  evidence.from = newest.name
  // 新鲜度：与产物那条（`artifactFreshnessOf`）**同一个参照** ——
  // 端口查询给出的监听进程 `startedAt`。拿不到参照时是 `undated`（不知道），**不猜**。
  evidence.freshness = logFreshness(newest.mtimeMs, processStartedAt)
  if (evidence.freshness !== 'undated' && processStartedAt !== undefined) {
    evidence.processStartedAt = processStartedAt
  }
  const logProfile = newest.report.profile
  if (logProfile !== undefined) {
    evidence.profileMatches = logProfile === profile
    if (logProfile !== profile) evidence.logProfile = logProfile
  }
  if (newest.report.requiredNotActivated !== undefined) {
    evidence.requiredNotActivated = newest.report.requiredNotActivated
  }
  if (newest.report.failed.length > 0) {
    evidence.failed = newest.report.failed.map((item) => ({
      id: item.id,
      required: item.required,
      ...(item.module === undefined ? {} : { module: item.module }),
      ...(item.error === undefined ? {} : { error: item.error }),
    }))
  }
  if (newest.parse.truncated === true) evidence.truncated = true
  return evidence
}

/**
 * 哪些日志**本工具没能解读**（解析不了，或读不到）。
 *
 * 只在这两档下返回（`partial` 时已经有别的证据可用，不必把模型赶去读文件）。
 *
 * @param evidence 解析汇总。
 */
function startupBlockedLogs(evidence: StartupEvidenceKey | undefined): string[] {
  if (evidence === undefined) return []
  if (evidence.parseState === 'unparsed')
    return (evidence.parseErrors ?? []).map((item) => item.name)
  if (evidence.parseState === 'unreadable')
    return (evidence.readErrors ?? []).map((item) => item.name)
  return []
}

/**
 * 把解析汇总投影成 L2 的逐行文本。
 *
 * @param evidence 解析汇总。
 */
function startupEvidenceLines(evidence: StartupEvidenceKey): string[] {
  const parts = [`parseState=${evidence.parseState}`, `logs=${String(evidence.logCount)}`]
  if (evidence.from !== undefined) parts.push(`from=${evidence.from}`)
  if (evidence.truncated === true) parts.push('truncated=yes')
  if (evidence.profileMatches !== undefined) {
    parts.push(`profileMatches=${evidence.profileMatches ? 'yes' : 'no'}`)
  }
  if (evidence.logProfile !== undefined) parts.push(`logProfile=${evidence.logProfile}`)
  // 新鲜度进 L2：模型要能把「旧日志」与「这次失败」分开（L1 说了结论，这里给可复核的形状）。
  if (evidence.freshness !== undefined) parts.push(`freshness=${evidence.freshness}`)
  if (evidence.processStartedAt !== undefined) {
    parts.push(`processStartedAt=${evidence.processStartedAt}`)
  }
  if (evidence.requiredNotActivated !== undefined) {
    parts.push(`requiredNotActivated=${String(evidence.requiredNotActivated)}`)
  }
  const lines = [`startupEvidence: ${parts.join(' ')}`]
  for (const item of evidence.parseErrors ?? []) {
    lines.push(`logParseError: ${item.name}: ${oneLine(item.detail)}`)
  }
  for (const item of evidence.readErrors ?? []) {
    lines.push(`logReadError: ${item.name}: ${oneLine(item.detail)}`)
  }
  for (const item of evidence.gaps ?? []) {
    lines.push(`logGap: ${item.name}: ${oneLine(item.detail)}`)
  }
  for (const item of evidence.failed ?? []) {
    const module = item.module === undefined ? '' : ` ${item.module}`
    const error = item.error === undefined ? '' : ` — ${oneLine(item.error)}`
    lines.push(`logFailed: ${item.id}${item.required ? ' (required)' : ''}${module}${error}`)
  }
  return lines
}

/**
 * 启动日志里那些**会改变下一步**的句子（进 L1）。
 *
 * 三条最要紧的（都对应用户会做错的判断）：
 * 1. 「解析失败 / 读不到」必须说出来 —— 否则模型把「没解出来」读成「没有失败」；
 * 2. 失败条目的 `error`（真机那份是 `EADDRINUSE`）—— 没有它，模型只会建议「重启宿主」，
 *    而重启解决不了（占用者还在）；
 * 3. `profileMatches === false` —— 同一个 `$DSH_HOME` 下多 profile 是常态，拿别人的失败
 *    日志解释当前 profile 是**无据**的。
 *
 * @param evidence 解析汇总。
 * @param profile 本次诊断的 profile。
 */
function startupVerdictParts(evidence: StartupEvidenceKey | undefined, profile: string): string[] {
  if (evidence === undefined) return []
  const parts: string[] = []
  const unparsed = evidence.parseErrors ?? []
  const unreadable = evidence.readErrors ?? []
  const gaps = evidence.gaps ?? []
  if (unparsed.length > 0) {
    const names = unparsed.map((item) => item.name).join(', ')
    parts.push(
      `could not parse ${String(unparsed.length)} startup log(s) (${names}); a startup log exists but its sections were not recognised, so do not read that as "no plugin failed"`,
    )
  }
  if (unreadable.length > 0) {
    const names = unreadable.map((item) => item.name).join(', ')
    parts.push(
      `could not read ${String(unreadable.length)} startup log(s) (${names}); that is unknown, not "no plugin failed"`,
    )
  }
  if (gaps.length > 0) {
    parts.push(
      `the startup log was only partially parsed (${gaps.map((item) => item.detail).join('; ')}) — do not read the missing sections as "nothing there"`,
    )
  }
  if (evidence.truncated === true) {
    parts.push('the newest startup log looks truncated, so its later sections may be missing')
  }
  if (evidence.profileMatches === false) {
    parts.push(
      `that startup log is from profile ${evidence.logProfile ?? 'another profile'}, not ${profile}, so it does not explain the current profile`,
    )
  }
  // 新鲜度：**旧的失败不是今天的失败**。这一句是本次修复的核心 —— 没有它，L1 会拿
  // 「上一次启动失败」的条目不限时间地断言当前状态（真机实例：今天 11:03 起的宿主，
  // 报的是 09-29 那份日志里的 EADDRINUSE）。
  const failed = evidence.failed ?? []
  const projectsFailure = failed.length > 0 || evidence.requiredNotActivated !== undefined
  if (evidence.freshness === 'stale') {
    const when =
      evidence.processStartedAt === undefined
        ? ''
        : ` (the process started ${evidence.processStartedAt})`
    parts.push(
      `that startup log predates the current process${when}, so it is a leftover from an earlier run and not evidence about this one`,
    )
  } else if (evidence.freshness === 'undated' && projectsFailure) {
    // 「不知道它属不属于当前进程」必须说出来：把 `undated` 读成「今天的失败」正是本条修复前的形状。
    parts.push(
      'this startup log could not be dated against the current process (no process start time was available), so treat its failures as possibly from an earlier run',
    )
  }
  if (failed.length > 0) {
    const head =
      evidence.requiredNotActivated === undefined
        ? 'the startup log reports failed plugins'
        : `the startup log reports ${String(evidence.requiredNotActivated)} required plugin(s) did not activate`
    const detail = failed
      .map((item) => {
        const module = item.module === undefined ? '' : ` [${item.module}]`
        const error = item.error === undefined ? '' : `: ${item.error}`
        return `${item.id}${item.required ? ' (required)' : ''}${module}${error}`
      })
      .join('; ')
    parts.push(`${head}, failed: ${detail}`)
  }
  return parts
}
