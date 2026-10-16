/**
 * `dsh_check_effect_mode` —— 「改了什么 → 要做什么才生效」。
 *
 * 对应 SKILL §一「生效机制三档」。这个工具的价值全在**第二步**：
 * 光按原表回答会把「配置改动 → 热生效」当成无条件成立，而 `reload()` 在没有 `hmr`
 * 的 profile 上是**空操作** —— 那些 profile（`headless` / `sdk` / `acp` 默认没挂 hmr）
 * 上，工具会**假装热生效**，用户按它做完发现没变化。所以必须先探 hmr，再决定降级。
 *
 * 探测分两层（否定的代价大于肯定）：
 * 1. 文件层：profile 的 `bundles` / `dependencies` / `node_modules` —— 便宜；
 * 2. 组合层：`dsh --profile <p> --dump-config` 里真有 `- id: hmr` 行 —— 权威。
 *
 * 只有文件层**没找到**时才补跑 dump 复核，仍找不到才判 `hmr: 'absent'`。
 *
 * ## 保留 profile（`desktop`）：那次复核**不可用**，于是 hmr **不可核实**
 *
 * `dsh --profile desktop --dump-config` 被 CLI **无条件**拒绝（真机实测：npm CLI 与
 * 桌面内置 CLI 都回 `error: profile "desktop" is managed exclusively by the Electron
 * application`、exit 1）⇒ 这条 profile 上的 hmr 状态**拿不到证据**。
 *
 * ⚠️ 而「桌面 profile 里没有 hmr」是**假的**：`- id: hmr` 那一行由
 * `@deepseek-ai/dsh-base` 的 `cordis.patch.yml` 插入，而桌面 profile 的第一个 bundle
 * 就是 `dsh-base`（Lead 从桌面 asar 里逐字核过），`@deepseek-ai/dsh-hmr` 也从 install
 * anchor 解析得到。所以「文件层没看到」**不是**「组合层没有」。
 *
 * ⇒ **不许**把不可核实压成 `absent`（那是把「不知道」印成「没有」，而且方向最坏：
 * 桌面端根本重启不了 —— 闸④拒绝 —— 于是用户会被指向一个走不通的动作）。
 * 分岔判据是**这次改动的答案是否依赖 hmr**（唯一真源是 `effect.ts` 的 `baselineMode`）：
 * - 原表本来就要求重启的那两档（`host-code` / 已在 dependencies 里的 `bundle-added`）
 *   **不依赖** hmr ⇒ 照常回答，只把「复核不可用」写进 `note` / `evidence`；
 * - 其余（`config` / `client-code` / 全新型 `bundle-added`）⇒ 走 `stage: 'hmr-unverified'`
 *   的诚实失败（同时否认「热生效」与「必须重启」两个断言）。
 *
 * ## 新契约的形状（W2-A，见 docs/SHAPE.md §2 / §3 / §5）
 *
 * 1. **描述四段骨架**：`CHECK_EFFECT_MODE_DESCRIPTION` 里逐段声明，
 *    由 `composeDescription` 合成。恒定知识（「没有热重载时，原表说 live 的改动要重启」）
 *    只在边界段**写一次**，不再每次调用都印。
 * 2. **`data` 恰好三键** `{ verdict, key, audit }`：
 *    - `verdict`：一句话判定 + 「所以呢」（成功失败都有，**失败分支不许只写 failed**）；
 *    - `key`：模型做下一个决定要用的（走的哪一步、`mode` / `baseline` / `downgraded` /
 *      `hmr`、生效配置块、失败时的 profile 目录）；
 *    - `audit`：给人复核的 —— hmr 探测的原文证据、`effect.ts` 那句机制解释、全字段配置块。
 * 3. **`nextStep` 必须带动作**：`{ tool, args?, why }` 或 `{ manual: true, why }`。
 *    ⚠️ `mode=restart-required` 走 **`manual`**，但 why 里**必须点出 `dsh_restart`**：
 *    那个工具**已实现并注册**（SHAPE §6.1 的协作纪律正是「走 `dsh_restart`」），
 *    只是它**不可逆** ⇒ 这一步留给用户拍板，所以不写成工具支；而写「本侧没有工具能重启」
 *    是假话 —— 模型读到它就不会去调那个真实存在的工具。
 * 4. `execute` **绝不 throw**：意外异常在顶层收敛成 `internal` 失败（B24 的承载条件）。
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import type { ResolvedConfig } from '../contracts.js'
import {
  carrierAuditOf,
  isReservedDesktopProfile,
  relaunchRefusalFor,
  relaunchRouteFor,
  type CarrierObservation,
} from '../lib/carrier.js'
import {
  fail,
  ok,
  type JsonValue,
  type NextStep,
  type ToolError,
  type ToolErrorKind,
  type ToolFail,
} from '../lib/errors.js'
import {
  baselineMode,
  decideEffectMode,
  probeHmr,
  type EffectChangeKind,
  type EffectDecision,
  type EffectMode,
  type HmrProbe,
} from '../lib/effect.js'
import { budgetFor, createDeadline, toolBudgetMs, type Workload } from '../lib/timeouts.js'
import { detectHmrFromProfileFiles, profileDir } from '../lib/profile.js'
import { resolveDshLaunch, runDump } from '../lib/dump.js'
import type { RenderTable } from '../lib/render.js'
import { composeDescription, type ToolDescription } from './describe.js'
import {
  asAudit,
  assertResolvedDshHome,
  CANCELLED_MESSAGE,
  CANCELLED_WHY,
  effectiveConfig,
  resolvedLine as sharedResolvedLine,
  spawnFailureMessage,
  spawnFailureOf,
  toOutput,
  toolOutput,
  withCallHome,
  type EffectiveConfigBlock,
  type ToolDeps,
} from './shared.js'

/** 工具名。 */
export const EFFECT_MODE_TOOL = 'dsh_check_effect_mode'

/**
 * 本工具的工作量档：**快档**。
 *
 * 它确实会跑一次 `--dump-config`（复核 hmr 那条路），但那条命令实测 **0.4 s**
 * （慢的是 `--dump-config-schema`，本工具不跑它）。
 */
const WORKLOAD: Workload = 'quick'

/** 参数。 */
interface EffectModeArgs {
  change: EffectChangeKind
  alreadyInDependencies?: boolean
  /**
   * 另**一个**实例的 `DSH_HOME`（跨实例观察，SHAPE §1.2 的 D′）。
   *
   * 它有两层作用：读 profile 文件层（`bundles` / `node_modules`）时用它当根，
   * 以及**注入复核那次 `--dump-config` 的子进程环境** —— 只做前者的话，
   * 文件层看的是 A、组合层问的是 B，两者的结论拼在一起是**两个实例的混合**。
   */
  dshHome?: string
}

/**
 * 这个 profile 有没有**可用的** hmr（也就是有没有人在 watch patch 文件）。
 *
 * ⚠️ **三值，不是两值**。`disabled:` 是一个 `!!js` 表达式时（本机 web profile 实测正是
 * `!!js '!ctx.get(''profileContext'')'`），静态看既不能判确定可用、也不能判确定不可用 ——
 * `src/lib/effect.ts` 的 `HmrProbe.disabled` 第三值就是它，那句 note 的原文承诺是
 * 「treated as usable, but the verdict carries that condition」。
 * 压成 `present` 就等于把「按上下文决定」印成「确定可用」，而条件只留在 `audit` 里
 * （`audit` 模型看不到）⇒ 承诺落空。所以第三值必须原样进 `key`（L2 由它投影）。
 *
 * ⚠️ **第四值 `unverified`**（2026-10-16 加）：两个真源里只剩文件层可用时（保留 profile 的
 * `--dump-config` 被 CLI 无条件拒绝），「有没有 hmr」这件事**拿不到证据**。
 * 它**不许**并进 `absent` —— `absent` 的含义是「没人 watch patch 文件，必须降级」，
 * 而那正是**没有证据**时不能下的结论（详因见文件头「保留 profile」那一节）。
 */
export type HmrAvailability = 'present' | 'present-conditional' | 'unverified' | 'absent'

/**
 * 这次调用走到了哪一步。
 *
 * **成功与失败共用一个 `key` 形状**，所以「没答出来」也必须能说清是**卡在哪一步** ——
 * 否则模型只能从 `error.message` 猜，而那个字段不进模型文本（SHAPE §4.1）。
 */
export type EffectModeStage =
  /** 有判定（成功路径）。 */
  | 'answered'
  /**
   * hmr 没能被核实：**文件层没看到**，而复核要么没轮到（预算耗尽）、要么在这个 profile
   * 上不可用（保留 profile 的 dump 被 CLI 无条件拒绝）。两种成因都导向同一件事 ——
   * 谁也没确认过，所以两个断言都不许下。
   */
  | 'hmr-unverified'
  /** 复核用的 dump 在传输层超时。 */
  | 'dump-timeout'
  /** 调用方在复核期间取消。 */
  | 'dump-cancelled'
  /** 起不了 `dsh`（ENOENT / 其它 spawn 错）。 */
  | 'launch-failed'
  /** 意外异常被顶层兜住（本插件的 bug，不是被测系统的状态）。 */
  | 'unexpected'

/** `key`：模型做下一个决定要用的原料（成功与失败同形）。 */
interface EffectModeKey {
  stage: EffectModeStage
  /** 判定方式；`answered` 之外不出现。 */
  mode?: EffectMode
  /** 只看原表的答案；`answered` 之外不出现。 */
  baseline?: EffectMode
  /** 有没有因为 hmr 缺席而降级；`answered` 之外不出现。 */
  downgraded?: boolean
  /** hmr 可用性的**结论**（不是探测原文 —— 原文在 `audit`）。 */
  hmr?: HmrAvailability
  /**
   * `dsh_restart` 总闸的当前档位（配置字段 `enableRestart`，**默认关**）。
   *
   * ## 为什么报在这个工具上
   *
   * 「一处一事实」：模型不必靠「调它、被拒了」去反推这个开关是关的 ——
   * 而**靠拒绝去猜**恰恰不可行：拒绝是那个工具**明说自己被挡住**的设计前提
   * （见 `dsh_restart.ts` 的 {@link RESTART_CONFIG_FIELD} 注释）。
   *
   * ⚠️ **只作独立字段报出，绝不参与 `change` 的分类判定**（`decideEffectMode`）：
   * 「这个改动归哪一档」与「重启工具开没开」是两件事。混进 `mode` 会让 `config`
   * 改动在开关关着时凭空变成另一种结论 —— 那是一个**不存在**的因果。
   */
  restartEnabled: boolean
  /**
   * 这次用的是哪份配置（含 `DSH_HOME` 的来源）。
   *
   * 整份判定都建立在「我在看哪个 profile 目录」之上，且下一步要用的 `profile`
   * 就在这一块里（`nextStep.args` 的那个值必须模型看得见，B17）。
   */
  resolved: EffectiveConfigBlock
  /** profile 目录的绝对路径；**只在失败路径上出现**（那时它是唯一可判的标识符）。 */
  profileDir?: string
}

/**
 * 本工具的描述（SHAPE §2.1 四段骨架）。
 *
 * 逐段理由：
 * - `what`：动词 + 对象。
 * - `useWhen`：模型的路由信号 —— 「改完没生效」正是本工具的入口。
 * - `boundary`：**两行**。① 反直觉点：没有热重载时，原表说「热生效」的改动
 *   **要重启**（这句话过去每次调用都印一遍，现在只写在这里）；
 *   ② 答不了什么：它只说**什么能让改动生效**，**不验证**改动生效了没有。
 *   观察类工具没有「代价段」，所以两行边界 + 两行前置 = 合成后仍是四行。
 */
export const CHECK_EFFECT_MODE_DESCRIPTION: ToolDescription = {
  what: 'Classifies what a change needs to take effect: live, restart, or HMR.',
  useWhen: 'Use when a change had no effect and you must say why.',
  boundary:
    'Without hot reload a "live" change needs a restart.\n' +
    'Read-only: it does not verify the change applied.',
}

/** 本工具的输出表：L1 就是 `data.verdict` 逐字，L2 由 `key` 投影成行。 */
const TABLE: RenderTable<EffectModeKey> = {
  key: (data) => keyText(data.key),
}

/**
 * 造工具。
 *
 * @param deps 运行期依赖。
 */
export function createEffectModeTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: EFFECT_MODE_TOOL,
    description: composeDescription(CHECK_EFFECT_MODE_DESCRIPTION),
    parameters: {
      change: {
        type: 'string',
        required: true,
        enum: ['config', 'bundle-added', 'host-code', 'client-code'],
        description: 'config | bundle-added | host-code | client-code.',
      },
      alreadyInDependencies: {
        type: 'boolean',
        description: 'bundle-added only: already a dependency?',
      },
      dshHome: {
        type: 'string',
        description:
          'Read another instance instead: its DSH_HOME path. Omit to use the configured one.',
      },
    },
    output: toolOutput(EFFECT_MODE_TOOL, TABLE),

    timeoutMs: toolBudgetMs(WORKLOAD, deps.config),
    isConcurrencySafe: () => true,

    async execute(rawArgs, exec) {
      const args = rawArgs as EffectModeArgs
      try {
        return await classify(args, exec.signal, deps)
      } catch (error) {
        // 「绝不 throw」是契约的承载条件：一旦抛出去，宿主会把它包成 toolErrorResult，
        // 模型看到的是一句裸 `Error: …`，`verdict` / `key` / `audit` 全部失效（SHAPE §4）。
        // 兜底里也要写着**这次看的是哪个实例** —— 意外失败时那一格是唯一可判的定位信息。
        return toOutput(unexpectedFailure(error, withCallHome(deps, args.dshHome).config))
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
async function classify(
  args: EffectModeArgs,
  signal: AbortSignal,
  deps: ToolDeps,
): Promise<JsonValue> {
  const deadline = createDeadline(toolBudgetMs(WORKLOAD, deps.config), deps.now)

  // 本次调用认的实例：路径解析与**子进程环境**一起换（见 `withCallHome` 的注释）。
  // 预算不受影响（只换 home 与其来源），所以 deadline 用的仍是 `deps.config`。
  const call = withCallHome(deps, args.dshHome)

  const missing = assertResolvedDshHome(call.config)
  if (missing !== undefined) return toOutput(missing)

  const dir = profileDir(call.config.dshHome, call.config.profile)
  const probe = await probeHmrFor(call, dir, deadline, signal, args.change)
  if (probe.kind === 'fail') return toOutput(probe.failure)

  // hmr **不可核实**（文件层没看到 + 唯一那条复核路在这个 profile 上不可用）时，
  // 分岔的唯一判据是「**这次的答案是否依赖 hmr**」—— 它由原表（`baselineMode`）给出：
  // 原表本来就要求重启的那两档不看 hmr，答案照样成立；其余档位的答案就建立在 hmr 之上，
  // 只能诚实地说「核实不了」（猜错的方向是把人指向死胡同，见文件头）。
  if (probe.kind === 'unverified' && baselineFor(args) !== 'restart-required') {
    return toOutput(unverifiedFailure(call.config, dir, args.change, probe.evidence, deps.carrier))
  }

  // 三值判定：`conditional` 既不是确定可用、也不是确定不可用 —— 它必须**原样**进 `key`
  // （L2 从 `key` 投影），否则「按上下文决定」会被印成「确定可用」（见 `HmrAvailability`）。
  // 不可核实那一支进第四值；走到那里时 `baseline` 已是 `restart-required`（其余档位上面已返回）。
  const hmr: HmrAvailability =
    probe.kind === 'unverified' ? 'unverified' : hmrAvailabilityOf(probe.hmrProbe)
  const decision: EffectDecision =
    probe.kind === 'unverified'
      ? unverifiedRestartDecision(args.change)
      : decideEffectMode({
          change: args.change,
          ...(args.alreadyInDependencies === undefined
            ? {}
            : { alreadyInDependencies: args.alreadyInDependencies }),
          hmrUsable: hmr !== 'absent',
        })

  const resolved = effectiveConfig(call.config)
  const key: EffectModeKey = {
    stage: 'answered',
    mode: decision.mode,
    baseline: decision.baseline,
    downgraded: decision.downgraded,
    // 探测本来就在做（否则做不了降级判定）—— 这里只是把它从内部状态提升成契约字段。
    hmr,
    // 总闸档位与 `change` 的分类**互不相干**（两条独立事实，见 EffectModeKey 的注释）。
    restartEnabled: deps.config.enableRestart.get() === true,
    resolved,
  }
  const audit = asAudit({
    change: args.change,
    alreadyInDependencies: args.alreadyInDependencies ?? null,
    profileDir: dir,
    resolved,
    // `effect.ts` 那句机制解释的原文：给人复核用。
    // L1 是另一个产物（为什么不能直接用它，见 verdictFor 的注释）。
    decision: {
      baseline: decision.baseline,
      mode: decision.mode,
      downgraded: decision.downgraded,
      // 不可核实那一支报 `null`（**不是** `false`）：`false` 会被读成「确认没有 hmr」，
      // 而这里的事实是「拿不到证据」（`false` 只是 `EffectDecision` 那个布尔字段的
      // fail-closed 取值，见 `unverifiedRestartDecision`）。
      hmrUsable: probe.kind === 'unverified' ? null : decision.hmrUsable,
      why: decision.why,
    },
    // hmr 探测的原文证据（谁参与了判定、组合树里那几行长什么样）。
    hmrProbe: hmrProbeAuditOf(probe),
    hmrSources: hmrSourcesOf(probe),
    // 载体观测：`restart-required` 那一支的 `nextStep` 是**按载体分岔**的（桌面端的回归
    // 路线不存在），所以「当时认出来的是什么载体」就是复核那句 why 的唯一线索。
    carrier: carrierAuditOf(deps.carrier),
  })

  return toOutput(
    ok(
      { verdict: verdictFor(args.change, decision, hmr), key, audit },
      nextStepFor(decision.mode, call.config.profile, deps.carrier),
    ),
  )
}

/** hmr 探测的合一结果：有结论、有「复核不可用」、或带一个可直接返回的失败。 */
type HmrProbeOutcome =
  | { kind: 'probe'; hmrProbe: HmrProbe; sources: string[] }
  /**
   * 文件层是否定的，而**唯一那条复核路在这个 profile 上不可用**（保留 profile 的 dump
   * 在任何载体上都被 CLI 拒绝）⇒ hmr **不可核实**。
   *
   * ⚠️ 它与「没有 hmr」不是一回事，而这两者**必须**在类型上分开：合并成一个
   * `present: false` 就是这次复议推翻的那个错（把「不知道」压成「没有」，于是
   * hmr 依赖型的答案被凭空改成 `restart-required`）。
   */
  | { kind: 'unverified'; evidence: readonly string[] }
  | { kind: 'fail'; failure: ToolFail }

/** 探测**有结果**的那两半（不含可直接返回的失败）。 */
type HmrProbeResult = Extract<HmrProbeOutcome, { kind: 'probe' | 'unverified' }>

/** 「保留 profile 上组合树复核不可用」那**一句话**（note / evidence 都引它，不各写一份）。 */
const RESERVED_RECHECK_UNAVAILABLE =
  'the composed-tree re-check is unavailable for a reserved profile name (the dsh command line refuses it on every platform)'

/**
 * `audit.hmrProbe` —— 探测原文。不可核实那一支**只有文件层那一半**，所以 `note` / `evidence`
 * 必须说清「组合树那次复核在这里不可用」：少了它，文件层的否定会被读成权威否定。
 *
 * ⚠️ 走到这里时**答案已经确定不依赖 hmr**（依赖型的那几档在 `classify` 里就返回失败支了），
 * 所以 note 里那句 "this answer does not depend on it" 成立 —— 这一格是调用方的**前置条件**，
 * 不是本函数自己推出来的。
 *
 * @param probe 探测结果（走到这里时只可能是 `probe` 或 `unverified`）。
 */
function hmrProbeAuditOf(probe: HmrProbeResult): {
  present: boolean
  disabled: HmrProbe['disabled']
  note: string
  evidence: string[]
} {
  if (probe.kind === 'unverified') {
    return {
      // 文件层确实没看到（这一格是真的）；组合层只是**没被问过**。
      present: false,
      disabled: 'no',
      note: `${RESERVED_RECHECK_UNAVAILABLE}, so hmr was not verified; this answer does not depend on it`,
      evidence: [...probe.evidence, RESERVED_RECHECK_UNAVAILABLE],
    }
  }
  return {
    present: probe.hmrProbe.present,
    disabled: probe.hmrProbe.disabled,
    note: probe.hmrProbe.note,
    evidence: [...probe.hmrProbe.evidence],
  }
}

/**
 * 这次判定读了哪几个来源（`audit.hmrSources`）。
 *
 * @param probe 探测结果（有结论的那两半）。
 */
function hmrSourcesOf(probe: HmrProbeResult): string[] {
  return probe.kind === 'probe' ? [...probe.sources] : ['profile-files']
}

/**
 * 这次改动的**原表答案**（不看 hmr）—— 它就是「答案是否依赖 hmr」那条分岔判据。
 *
 * `baselineMode` 的输入里带 `hmrUsable`，但它**不读**那一格（那是 `downgrade` 的输入）；
 * 这里显式喂 `false`：写成 `true` 会让下一个读者以为「这台机器上 hmr 可用」。
 *
 * @param args 调用参数。
 */
function baselineFor(args: EffectModeArgs): EffectMode {
  return baselineMode({
    change: args.change,
    ...(args.alreadyInDependencies === undefined
      ? {}
      : { alreadyInDependencies: args.alreadyInDependencies }),
    hmrUsable: false,
  })
}

/**
 * 保留 profile 上「答案不依赖 hmr」那一档的判定：原表本来就要求重启。
 *
 * 为什么不走 `decideEffectMode`：它内部按 `hmrUsable` 拼那句机制解释，而这里 hmr
 * **不可核实** —— 喂 `false` 会让那句解释说「这个 profile 里没有可用的 hmr」，
 * 那正是这次复议要消灭的「把不知道说成没有」。判定的三个字段与
 * `decideEffectMode({ …, hmrUsable: false })` **同值**：原表本来就要求重启时，
 * hmr 在不在都不改变答案。
 *
 * @param change 改动种类。
 */
function unverifiedRestartDecision(change: EffectChangeKind): EffectDecision {
  return {
    change,
    baseline: 'restart-required',
    mode: 'restart-required',
    downgraded: false,
    // `EffectDecision` 要一个布尔；取 fail-closed 的那一端（`false` = 没被确认为可用）。
    // 真正的结论在 `key.hmr === 'unverified'` 与审计的 `hmrUsable: null` 上。
    hmrUsable: false,
    why:
      'this kind of change is not applied live in this profile regardless of hmr, and hmr itself could not be ' +
      `verified here (${RESERVED_RECHECK_UNAVAILABLE}) — so the answer does not depend on it`,
  }
}

/**
 * 保留 profile 上「答案依赖 hmr」那一档：走**既有那条诚实失败路径**（`hmr-unverified`）。
 *
 * 为什么不给结论：两个真源里只剩文件层可用（活跃坑 34），而文件层的否定不是权威否定。
 * 此时「热生效」与「必须重启」都拿不出证据，而蒙一个的代价不对称 —— 桌面端根本重启不了
 * （闸④拒绝），蒙成 `restart-required` 就是把用户指向一个走不通的动作。
 *
 * `nextStep` 走 `manual` 且**不指 `dsh_dump_config`**：那个工具在保留 profile 上自己
 * 也会早拒（`dsh_dump_config.ts` 的 `reservedProfileFailure`），指过去只是一次空转。
 *
 * @param config 生效配置。
 * @param dir profile 目录。
 * @param change 改动种类（只用于让 `verdict` 说清「这是哪种改动的判定」）。
 * @param evidence 文件层的证据（它解释了「为什么文件层判不了」）。
 * @param carrier 载体观测（决定这一步该派给谁）。
 */
function unverifiedFailure(
  config: ResolvedConfig,
  dir: string,
  change: EffectChangeKind,
  evidence: readonly string[],
  carrier: CarrierObservation,
): ToolFail {
  return failureFor(config, {
    kind: 'not-configured',
    message: `hmr cannot be verified on the reserved profile "${config.profile}"`,
    verdict:
      `no verdict for this ${change} change: hmr could not be verified — the composed tree cannot be dumped for ` +
      `the reserved profile "${config.profile}" (the dsh command line refuses it on every platform), and the ` +
      'profile files alone did not show hmr, so neither "live" nor "restart required" can be claimed',
    stage: 'hmr-unverified',
    dir,
    evidence: [...evidence, RESERVED_RECHECK_UNAVAILABLE],
    nextStep: unverifiedNextStepFor(carrier),
  })
}

/**
 * 不可核实那一支的下一步 —— **没有工具可派**。
 *
 * 载体没有已实测的回归路线时（桌面端最典型），`why` 用
 * `relaunchRefusalFor(carrier).remedy`：那两句话在载体层按载体分岔，是「人能做什么」的
 * 唯一落点（桌面端点名「从托盘退出 App」）。
 *
 * @param carrier 载体观测。
 */
function unverifiedNextStepFor(carrier: CarrierObservation): NextStep {
  if (relaunchRouteFor(carrier) === 'none') {
    return { manual: true, why: relaunchRefusalFor(carrier).remedy }
  }
  return {
    manual: true,
    why:
      'settle this by hand: whether this change applies live could not be verified on this profile; watch it ' +
      'after the change and restart the host with dsh_restart only if it did not take effect',
  }
}

/**
 * 把探测结果压成契约里的 hmr 可用性（**三值**）。
 *
 * 与 `src/lib/effect.ts` 的 `HmrProbe.disabled` 一一对应，**不许合并**：
 * - 没有那一行、或它被静态禁用 → `absent`（没人 watch patch 文件，必须降级）；
 * - `disabled:` 是运行时表达式 → `present-conditional`（**不能**当成确定可用）；
 * - 其余 → `present`。
 *
 * @param probe 组合树 / profile 文件的探测结果。
 */
function hmrAvailabilityOf(probe: HmrProbe): HmrAvailability {
  if (!probe.present) return 'absent'
  if (probe.disabled === 'yes') return 'absent'
  return probe.disabled === 'conditional' ? 'present-conditional' : 'present'
}

/**
 * 探 hmr：先文件、后组合层复核。
 *
 * @param deps 运行期依赖。
 * @param dir profile 目录。
 * @param deadline 本次调用的共享截止时间。
 * @param signal 调用方信号。
 * @param change 改动种类（只用于让失败的 `verdict` 说清「这是哪种改动的判定」）。
 */
async function probeHmrFor(
  deps: ToolDeps,
  dir: string,
  deadline: ReturnType<typeof createDeadline>,
  signal: AbortSignal,
  change: EffectChangeKind,
): Promise<HmrProbeOutcome> {
  const fromFiles = await detectHmrFromProfileFiles(dir)
  if (fromFiles.present) {
    return {
      kind: 'probe',
      hmrProbe: {
        present: true,
        disabled: 'no',
        evidence: fromFiles.evidence,
        note: 'found hmr in the profile files (skipped the dump re-check)',
      },
      sources: ['profile-files'],
    }
  }

  // **保留 profile**：组合树那次复核在这个 profile 上**不可用**。
  //
  // `dsh --profile desktop --dump-config` 被 CLI 无条件拒绝（`rejectElectronProfile`；
  // 真机实测，npm CLI 与桌面内置 CLI 都拒、exit 1）⇒ 那条路必然失败，跑了也只是
  // 白起一个子进程，换不来任何证据。
  //
  // ⚠️ 返回的是「**不可核实**」，**不是**「没有 hmr」：两者在类型上就是两格
  // （见 `HmrProbeOutcome`）。而且必须先于 `deadline.expired()` 判 —— 那条失败支的
  // `nextStep` 指向 `dsh_dump_config`，而它在保留 profile 上自己也会早拒，指过去是死路。
  if (isReservedDesktopProfile(deps.config.profile)) {
    return { kind: 'unverified', evidence: fromFiles.evidence }
  }

  // 文件层看不到：否定的代价大（一切降级），值得花一次 dump 复核。
  if (deadline.expired()) {
    return {
      kind: 'fail',
      failure: failureFor(deps.config, {
        kind: 'timeout',
        message: 'the budget ran out while probing hmr, so it could not be verified',
        verdict: `no verdict for this ${change} change: the budget ran out before hmr could be verified, and the profile files alone did not show hmr — neither "live" nor "restart required" can be claimed, so nothing may be told to the user yet`,
        stage: 'hmr-unverified',
        dir,
        evidence: fromFiles.evidence,
        nextStep: {
          tool: 'dsh_dump_config',
          args: { profile: deps.config.profile },
          // ⚠️ 原话是「再跑一次这个工具、把 timeoutMs 调大」—— 两处都不成立：① `timeoutMs`
          // 是**插件配置**（`src/config.ts`），不是工具参数，`defineTool` 的预算在注册期
          // 就定死了，模型改不动；② 「this tool」指代不明（这一支刚建议调 `dsh_dump_config`，
          // 模型会读成它）。所以点名工具，并把「调预算」明确归给用户。
          why: 'read the composed tree to check for the hmr row directly; a larger timeoutMs for dsh_check_effect_mode is a plugin config change only the user can make',
        },
      }),
    }
  }

  const dump = await runDump(resolveDshLaunch(), deps.config.profile, '--dump-config', {
    spawn: deps.spawn,
    timeoutMs: budgetFor(toolBudgetMs(WORKLOAD, deps.config), deadline),
    signal,
  })

  if (dump.aborted) {
    return {
      kind: 'fail',
      failure: failureFor(deps.config, {
        kind: 'cancelled',
        message: CANCELLED_MESSAGE,
        verdict: `no verdict for this ${change} change: the caller cancelled this execution while hmr was being verified, so the effect mode was never decided`,
        stage: 'dump-cancelled',
        dir,
        evidence: fromFiles.evidence,
        nextStep: {
          manual: true,
          why: CANCELLED_WHY,
        },
      }),
    }
  }
  if (dump.timedOut) {
    return {
      kind: 'fail',
      failure: failureFor(deps.config, {
        kind: 'timeout',
        message:
          'dump-config timed out while verifying hmr (the transport layer timed out first, before the tool budget)',
        verdict: `no verdict for this ${change} change: hmr could not be verified because the composed-config dump timed out, and the profile files alone did not show hmr — the answer stays unknown until the hmr row is confirmed`,
        stage: 'dump-timeout',
        dir,
        evidence: fromFiles.evidence,
        nextStep: {
          tool: 'dsh_dump_config',
          args: { profile: deps.config.profile },
          // 同上：`schemaDumpTimeoutMs`（`dsh_dump_config` 走**慢档**，不是 `timeoutMs`）
          // 也是插件配置，模型改不动 ⇒ 只说明「那件事归用户做」，不写成模型的动作。
          why: 'read the composed tree to confirm whether an hmr row exists; if that dump times out too, raising its budget is a plugin config change (schemaDumpTimeoutMs) only the user can make',
        },
      }),
    }
  }

  if (dump.spawnError !== undefined) {
    const { kind, notFound } = spawnFailureOf(dump.spawnError)
    return {
      kind: 'fail',
      failure: failureFor(deps.config, {
        kind,
        message: spawnFailureMessage(dump.spawnError),
        verdict: notFound
          ? `no verdict for this ${change} change: dsh itself could not be started (${dump.spawnError}), so the composed tree could not be read and hmr stays unverified`
          : `no verdict for this ${change} change: starting dsh failed in an unexpected way (${dump.spawnError}), so the composed tree could not be read and hmr stays unverified`,
        stage: 'launch-failed',
        dir,
        evidence: fromFiles.evidence,
        ...(notFound
          ? {
              nextStep: {
                manual: true,
                why: 'make sure dsh is on PATH, then run this check again; no tool on this side can fix the launch command',
              } satisfies NextStep,
            }
          : {}),
      }),
    }
  }

  // 只看 stdout：`- id:` 的反向引用在 stderr 里以 `[path]` 形态出现，
  // 混进来会污染行起点匹配（`- id: hmr` 要求行首）。
  const fromDump = probeHmr(dump.stdout)
  return { kind: 'probe', hmrProbe: fromDump, sources: ['profile-files', 'dump-config'] }
}

/** 造一条 hmr 探测失败。 */
function failureFor(
  config: ResolvedConfig,
  input: {
    kind: ToolErrorKind
    message: string
    verdict: string
    stage: EffectModeStage
    dir: string
    evidence: readonly string[]
    nextStep?: NextStep
  },
): ToolFail {
  const error: ToolError = { kind: input.kind, message: input.message }
  const resolved = effectiveConfig(config)
  const data = {
    verdict: input.verdict,
    key: {
      stage: input.stage,
      // 失败分支也带（成功与失败**同形**是本工具的既有纪律，见 EffectModeStage）：
      // 探测失败不该让「重启工具开没开」这一格也一并失明。
      restartEnabled: config.enableRestart.get() === true,
      resolved,
      profileDir: input.dir,
    } satisfies EffectModeKey,
    audit: asAudit({
      profileDir: input.dir,
      resolved,
      // 文件层看到的那点证据也要留下：它是「为什么文件层判不了」的唯一线索。
      hmrFileEvidence: [...input.evidence],
    }),
  }
  return input.nextStep === undefined ? fail(error, data) : fail(error, data, input.nextStep)
}

/**
 * 顶层兜底：把意外异常收敛成结构合法的 `internal` 失败（`execute` 绝不 throw）。
 *
 * 为什么 `verdict` 要写明「这是本插件的意外」：模型据此**不该**去改配置或重试，
 * 而该把它当 bug 报出来。只写 `failed` 等于让模型猜。
 *
 * @param error 捕获到的异常。
 * @param config 生效配置（能给出 profile 与目录来源）。
 */
function unexpectedFailure(error: unknown, config: ResolvedConfig): ToolFail {
  const message = error instanceof Error ? error.message : String(error)
  return fail(
    { kind: 'internal', message: `dsh_check_effect_mode failed unexpectedly: ${message}` },
    {
      verdict: `no verdict: this check itself failed unexpectedly (${message}), so nothing about the effect mode is known — this is a bug in this plugin, not a finding about the change`,
      key: {
        stage: 'unexpected',
        restartEnabled: config.enableRestart.get() === true,
        resolved: effectiveConfig(config),
      },
      audit: asAudit({ error: message }),
    },
  )
}

/**
 * 拼 L1（一句话判定，**含「所以呢」**）。
 *
 * ## 为什么不直接用 `effect.ts` 的 `decision.why`（2026-10-13 重写，W2-A3）
 *
 * `decision.why` **是对的、可以直接读**（它按 `mode` + `downgraded` 分流：`restart-required`
 * 档说明的是「hmr 换不了宿主模块图与 bundle 选择」）。那段修复的始末记在 `effect.ts` 的
 * `buildWhy()` 里，**本文件不复述**。
 *
 * L1 仍然留在这里，是因为 **L1 与 `why` 是两个产物，不是同一事实的两次落点**：
 * 1. L1 以**这次改动的种类**开头（`CHANGE_LABEL[change]`）；`why` 只有机制，不含这个前缀。
 * 2. L1 以**可执行动作**收尾，且与 `nextStepFor` 同源（同一个 `mode` switch）—— `why` 不含动作。
 *
 * 实测（2026-10-13）：把 L1 换成 `` `${label}: ${decision.why}` ``，**3 条既有断言变红**
 * （`not applied live` / `a host restart would not help` / `refresh the page`）—— 红的正是
 * 「L1 带判定、带动作」这个契约。所以这不是洁癖式的重复；想合并这两者，先看那三条断言。
 *
 * `decision.why` 的原文仍然原样进 `audit`（人复核通道）。
 *
 * ⚠️ `hmr` 的第四值 `unverified` **不可能**走到 `hot` / `hmr` 这两支：hmr 不可核实时，
 * 答案依赖 hmr 的档位在 `classify` 里就走了 `hmr-unverified` 失败支，能到达这里的只有
 * 原表本来就要求重启的那两档（`restart-required`）。所以下面 `hot` 那一支的条件判断
 * 不必再为它分一个岔 —— 真要分，先看那条不变量还在不在。
 *
 * @param change 改动种类。
 * @param decision 纯函数判定结果。
 * @param hmr hmr 可用性的**三值**结论 —— `hot` 那一支要靠它把「条件可用」与「确定可用」
 *   分开说；两值化会让这句变成「按上下文决定也算确定可用」。
 */
function verdictFor(
  change: EffectChangeKind,
  decision: EffectDecision,
  hmr: HmrAvailability,
): string {
  const label = CHANGE_LABEL[change]
  switch (decision.mode) {
    case 'hot':
      // `present-conditional` 必须**在 L1 里带条件**：这一支的结论建立在「hmr 可用」之上，
      // 而那个可用性本身是按运行时表达式决定的 ⇒ 只印「takes effect live here」是把条件丢掉。
      return hmr === 'present-conditional'
        ? `${label} takes effect live here only if hmr's disabled expression evaluates to enabled: hmr is mounted in this profile and it is what watches the patch files, so the loader re-reads the changed rows — but that row's disabled flag is a runtime expression, so this is not certain; if it still had no effect, check that expression before blaming the config`
        : `${label} takes effect live here: hmr is mounted in this profile and it is what watches the patch files, so the loader re-reads the changed rows — if it still had no effect, the config is wrong or a later layer replaced the whole row`
    case 'hmr':
      return `${label} is swapped in by hmr: refresh the page to pick it up`
    case 'client-rebuild':
      return `${label} needs a client rebuild and a page refresh: this profile has no usable hmr, so nothing swaps the asset in, and a host restart would not help`
    case 'restart-required':
      return decision.downgraded
        ? `${label} needs a host restart: the plain rule calls it live, but this profile has no usable hmr — nothing watches the patch files, so the loader never re-reads them`
        : `${label} needs a host restart: this kind of change is not applied live in this profile`
  }
}

/** 「改了什么」在 L1 里的说法。 */
const CHANGE_LABEL: Record<EffectChangeKind, string> = {
  config: 'a config change',
  'bundle-added': 'a newly added bundle',
  'host-code': 'a host-side code change',
  'client-code': 'a client-side code change',
}

/**
 * 挑下一步 —— **必须带动作**，没有动作就返回 `undefined`（不出现）。
 *
 * ⚠️ `restart-required` 的**默认**支走 `manual`，**但 why 里必须点出 `dsh_restart`**：
 * SHAPE §6.1 的协作纪律就是「走重启工具」，而它**已实现并注册**。原先那句「no tool on
 * this side can restart it yet」是假话 —— 模型读到它就不会去调那个真实存在的工具。
 * 仍用 `manual` 的理由只有一条：重启**不可逆**，这一步该由用户拍板；而工具支要带
 * `reason`（必填），那个值又必须出现在 L1/L2 里（B17）—— 这里给不出。
 *
 * ## 载体那一维（2026-10-16 加）：`relaunchRouteFor` 说 `none` 时改走另一句话
 *
 * 「重启」这件事**不是**所有载体上都做得到：桌面宿主的回归路线**不存在**（插件没有
 * 重启 Electron 的通道，壳对页面暴露的 ipc 里也没有），而 `dsh_restart` 在那种载体上
 * 会在动手前拒绝（闸④）。所以这一支必须改口 —— 否则就是把模型指向一个在那儿**不存在**
 * 的工具动作，而它读到的 why 与「cli × win32」逐字相同、看不出区别。
 *
 * `why` 直接用 `relaunchRefusalFor(carrier).remedy`：那两句话在载体层**按载体分岔**
 * （桌面端点名「从托盘退出 App」、非 Windows 说只能手动起、认不出来时不许猜），
 * 与 `reason` 一样是「人能做什么」的唯一落点 —— 本文件不复述、不改写。
 *
 * **其余分支逐字保持现状**（它们与载体无关，改了只会让既有断言失真）。
 *
 * @param mode 生效方式。
 * @param profile 本次的 profile 名（它会出现在 L2 的 `resolved:` 行里，B17 因此成立）。
 * @param carrier 这个宿主的载体观测（决定「重启」这一步该派给工具还是派给人）。
 */
function nextStepFor(mode: EffectMode, profile: string, carrier: CarrierObservation): NextStep {
  switch (mode) {
    case 'hot':
      return {
        tool: 'dsh_dump_config',
        args: { profile },
        why: 'check that the changed row is really in the composed tree: a live change that still had no effect usually means the config is wrong or a later layer replaced the whole row',
      }
    case 'hmr':
      return {
        manual: true,
        why: 'refresh the page to pick up the client asset; no tool on this side can refresh it for you',
      }
    case 'client-rebuild':
      return {
        manual: true,
        why: 'rebuild the client, then refresh the page; no tool on this side can rebuild it for you',
      }
    case 'restart-required':
      // 没有已实测的回归路线 ⇒ 只留下人的动作（桌面端必须点名「退出 App」）。
      if (relaunchRouteFor(carrier) === 'none') {
        return { manual: true, why: relaunchRefusalFor(carrier).remedy }
      }
      return {
        manual: true,
        why: 'restart the host process: this change is only picked up at startup; dsh_restart does that, and it is irreversible — use its dryRun first',
      }
  }
}

/**
 * 把 `key` 投影成 L2 的逐行文本。
 *
 * 排序即输出顺序：**先判定（模式、降级、hmr），再「这次读的是哪份配置」**。
 * 每一步只印**本次非默认**的东西：`stage` 在成功路径上恒为 `answered`，不印。
 *
 * @param key 本次的 `key`。
 */
function keyText(key: EffectModeKey): string[] {
  // 渲染层**绝不抛**（`render.ts` 的纪律）：形状守卫只看「`key` 是对象」，
  // 所以 `{}` 这种合法但空的对象也会走到这里 —— 不能假定字段都在。
  if (key === null || typeof key !== 'object') return []
  const lines: string[] = []
  if (key.stage !== undefined && key.stage !== 'answered') lines.push(`stage: ${key.stage}`)
  if (key.mode !== undefined) lines.push(`mode: ${key.mode}`)
  if (key.downgraded === true && key.baseline !== undefined && key.mode !== undefined) {
    lines.push(`downgraded: ${key.baseline} -> ${key.mode} (no usable hmr)`)
  }
  if (key.hmr !== undefined) lines.push(hmrLine(key.hmr))
  // 总闸档位：两档**都印**（开与关同样是「现在是什么」，而本仓最重的就是
  // 「靠失败去猜」）。字段缺失（守卫合成的兜底 `key` 就是 `{}`）时不印。
  //
  // ⚠️ **刻意短**：这一行在同一个环境下恒定，而本仓的 B16 判「两份输入不同的
  // fixture 之间不许有 ≥40 字符的共有行」（恒定块 = 模型每次都白读一遍）。
  // 所以这里只给档位，**字段名留给 `dsh_restart` 那句拒绝**（一处一事实）：
  // 「怎么打开」由那一格权威地说，模型不必靠这里的重复推断。
  if (typeof key.restartEnabled === 'boolean') {
    lines.push(`restart: ${key.restartEnabled ? 'enabled' : 'disabled'}`)
  }
  lines.push(resolvedLine(key.resolved, key.profileDir))
  return lines
}

/**
 * L2 里那行 hmr 结论 —— **四个值各有各的说法**，一个都不许并进另一个。
 *
 * - `present-conditional`：**必须把条件本身印出来**，只印记号，模型读不出「它按上下文
 *   决定、可能在这里是禁用的」；
 * - `unverified`：同理 —— 不可核实**不许**印成 `absent`（「不知道」不等于「没有」），
 *   而且这一行是模型唯一能看出「这次没核实过」的地方（成因在 `audit` 里，模型看不到）。
 *
 * @param hmr `key.hmr`。
 */
function hmrLine(hmr: HmrAvailability): string {
  switch (hmr) {
    case 'present':
      return 'hmr: present'
    case 'present-conditional':
      return 'hmr: present (conditionally disabled: its disabled flag is a runtime expression)'
    case 'unverified':
      return 'hmr: unverified (the composed tree cannot be read on a reserved profile name, so it could not be checked)'
    case 'absent':
      return 'hmr: absent'
  }
}

/**
 * `resolved:` 那一行。
 *
 * 端口**不印**：这个工具压根不涉及端口，`not-used` 是恒定的，按 L2 规则不进输出。
 *
 * @param resolved 生效配置块。
 * @param dir profile 目录（失败路径上才有）。
 */
function resolvedLine(resolved: EffectiveConfigBlock | undefined, dir: string | undefined): string {
  // 格式、字段顺序与兜底由 `shared.ts` 的唯一渲染点定；本工具不涉及端口、读 profile 目录。
  return sharedResolvedLine(resolved, 'omit', dir)
}
