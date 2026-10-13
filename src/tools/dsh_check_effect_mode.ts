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
 *    ⚠️ `mode=restart-required` 走 **`manual`**，不是「调重启工具」：重启工具
 *    **尚未实现**（SHAPE §6.1 排最后），建议模型去调一个不存在的工具比不报更坏。
 * 4. `execute` **绝不 throw**：意外异常在顶层收敛成 `internal` 失败（B24 的承载条件）。
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import type { ResolvedConfig } from '../contracts.js'
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
  decideEffectMode,
  probeHmr,
  type EffectChangeKind,
  type EffectDecision,
  type EffectMode,
  type HmrProbe,
} from '../lib/effect.js'
import { budgetFor, createDeadline } from '../lib/timeouts.js'
import { detectHmrFromProfileFiles, profileDir } from '../lib/profile.js'
import { resolveDshLaunch, runDump } from '../lib/dump.js'
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
export const EFFECT_MODE_TOOL = 'dsh_check_effect_mode'

/** 参数。 */
interface EffectModeArgs {
  change: EffectChangeKind
  alreadyInDependencies?: boolean
}

/** 这个 profile 有没有**可用的** hmr（也就是有没有人在 watch patch 文件）。 */
export type HmrAvailability = 'present' | 'absent'

/**
 * 这次调用走到了哪一步。
 *
 * **成功与失败共用一个 `key` 形状**，所以「没答出来」也必须能说清是**卡在哪一步** ——
 * 否则模型只能从 `error.message` 猜，而那个字段不进模型文本（SHAPE §4.1）。
 */
export type EffectModeStage =
  /** 有判定（成功路径）。 */
  | 'answered'
  /** 预算在复核 hmr 之前耗尽：文件层没看到 hmr，谁也没确认过。 */
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
    },
    output: toolOutput(EFFECT_MODE_TOOL, TABLE),

    timeoutMs: deps.config.timeoutMs,
    isConcurrencySafe: () => true,

    async execute(rawArgs, exec) {
      try {
        return await classify(rawArgs as EffectModeArgs, exec.signal, deps)
      } catch (error) {
        // 「绝不 throw」是契约的承载条件：一旦抛出去，宿主会把它包成 toolErrorResult，
        // 模型看到的是一句裸 `Error: …`，`verdict` / `key` / `audit` 全部失效（SHAPE §4）。
        return toOutput(unexpectedFailure(error, deps.config))
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
  const deadline = createDeadline(deps.config.timeoutMs, deps.now)

  const missing = assertResolvedDshHome(deps.config)
  if (missing !== undefined) return toOutput(missing)

  const dir = profileDir(deps.config.dshHome, deps.config.profile)
  const probe = await probeHmrFor(deps, dir, deadline, signal, args.change)
  if (probe.kind === 'fail') return toOutput(probe.failure)

  const usable = probe.hmrProbe.present && probe.hmrProbe.disabled !== 'yes'
  const decision = decideEffectMode({
    change: args.change,
    ...(args.alreadyInDependencies === undefined
      ? {}
      : { alreadyInDependencies: args.alreadyInDependencies }),
    hmrUsable: usable,
  })

  const resolved = effectiveConfig(deps.config)
  const key: EffectModeKey = {
    stage: 'answered',
    mode: decision.mode,
    baseline: decision.baseline,
    downgraded: decision.downgraded,
    // 探测本来就在做（否则做不了降级判定）—— 这里只是把它从内部状态提升成契约字段。
    hmr: usable ? 'present' : 'absent',
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
      hmrUsable: decision.hmrUsable,
      why: decision.why,
    },
    // hmr 探测的原文证据（谁参与了判定、组合树里那几行长什么样）。
    hmrProbe: {
      present: probe.hmrProbe.present,
      disabled: probe.hmrProbe.disabled,
      note: probe.hmrProbe.note,
      evidence: [...probe.hmrProbe.evidence],
    },
    hmrSources: [...probe.sources],
  })

  return toOutput(
    ok(
      { verdict: verdictFor(args.change, decision), key, audit },
      nextStepFor(decision.mode, deps.config.profile),
    ),
  )
}

/** hmr 探测的合一结果：要么有结论，要么带一个可直接返回的失败。 */
type HmrProbeOutcome =
  { kind: 'probe'; hmrProbe: HmrProbe; sources: string[] } | { kind: 'fail'; failure: ToolFail }

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
          why: 'read the composed tree to check for the hmr row directly, then re-run this tool with a larger timeoutMs',
        },
      }),
    }
  }

  const dump = await runDump(resolveDshLaunch(), deps.config.profile, '--dump-config', {
    spawn: deps.spawn,
    timeoutMs: budgetFor(deps.config.timeoutMs, deadline),
    signal,
  })

  if (dump.aborted) {
    return {
      kind: 'fail',
      failure: failureFor(deps.config, {
        kind: 'cancelled',
        message: 'the caller cancelled this execution',
        verdict: `no verdict for this ${change} change: the caller cancelled this execution while hmr was being verified, so the effect mode was never decided`,
        stage: 'dump-cancelled',
        dir,
        evidence: fromFiles.evidence,
        nextStep: {
          manual: true,
          why: 'cancellation is up to the caller; retrying the same call is pointless',
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
          why: 'read the composed tree to confirm whether an hmr row exists; it may time out too, in which case raise timeoutMs',
        },
      }),
    }
  }

  if (dump.spawnError !== undefined) {
    const notFound = dump.spawnError.includes('ENOENT')
    return {
      kind: 'fail',
      failure: failureFor(deps.config, {
        kind: notFound ? 'not-configured' : 'internal',
        message: `cannot start dsh: ${dump.spawnError}`,
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
    key: { stage: input.stage, resolved, profileDir: input.dir } satisfies EffectModeKey,
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
      key: { stage: 'unexpected', resolved: effectiveConfig(config) },
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
 * @param change 改动种类。
 * @param decision 纯函数判定结果。
 */
function verdictFor(change: EffectChangeKind, decision: EffectDecision): string {
  const label = CHANGE_LABEL[change]
  switch (decision.mode) {
    case 'hot':
      return `${label} takes effect live here: hmr is mounted in this profile and it is what watches the patch files, so the loader re-reads the changed rows — if it still had no effect, the config is wrong or a later layer replaced the whole row`
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
 * ⚠️ `restart-required` 走 `manual`：SHAPE §6.1 那条协作纪律写的是「走重启工具」，
 * 但那个工具**尚未实现**。让模型去调一个不存在的工具，比不给动作更坏 ——
 * 所以这里只说明「要重启」以及「为什么工具这边做不到」。
 *
 * @param mode 生效方式。
 * @param profile 本次的 profile 名（它会出现在 L2 的 `resolved:` 行里，B17 因此成立）。
 */
function nextStepFor(mode: EffectMode, profile: string): NextStep {
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
      return {
        manual: true,
        why: 'restart the host process: this change is only picked up at startup, and no tool on this side can restart it yet',
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
  if (key.hmr !== undefined) lines.push(`hmr: ${key.hmr}`)
  lines.push(resolvedLine(key.resolved, key.profileDir))
  return lines
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
  // 同上：字段缺失也要印得出来（兜底合成的失败里 `key` 就是 `{}`）。
  const profile = typeof resolved?.profile === 'string' ? resolved.profile : 'unknown'
  const dshHome = typeof resolved?.dshHome === 'string' ? resolved.dshHome : 'unknown'
  const source = resolved?.dshHomeSource ?? 'unknown'
  const at = typeof dir === 'string' && dir !== '' ? ` dir=${dir}` : ''
  return `resolved: profile=${profile} dshHome=${dshHome} (${String(source)})${at}`
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
