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
 * 只有文件层**没找到**时才补跑 dump 复核，仍找不到才判 `hmrUsable: false`。
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import { fail, ok, type ToolFail } from '../lib/errors.js'
import { decideEffectMode, probeHmr, type EffectChangeKind, type HmrProbe } from '../lib/effect.js'
import { budgetFor, createDeadline } from '../lib/timeouts.js'
import { detectHmrFromProfileFiles, profileDir } from '../lib/profile.js'
import { resolveDshLaunch, runDump } from '../lib/dump.js'
import {
  assertResolvedDshHome,
  effectiveConfig,
  toolOutput,
  toOutput,
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

/** 返回的 `data`。 */
interface EffectModeData {
  change: EffectChangeKind
  /** 只看 SKILL §一 原表的答案。 */
  baseline: string
  /** 结合 hmr 探测后的最终答案。 */
  mode: string
  downgraded: boolean
  why: string
  hmr: {
    usable: boolean
    /** 哪些证据参与了判定。 */
    sources: string[]
    probe: HmrProbe
  }
  profile: string
  /**
   * 这次调用实际用的是哪份配置（含 DSH_HOME 的来源）。
   *
   * 关于 hmr 的判定尤其要紧：结论建立在「我在看哪个 profile 目录」之上，
   * 而这份目录可能是按宿主默认值推出来的 —— 不摊开就没法复核。
   */
  resolved: EffectiveConfigBlock
}

/**
 * 造工具。
 *
 * @param deps 运行期依赖。
 */
export function createEffectModeTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: EFFECT_MODE_TOOL,
    description:
      '判断一次改动需要什么才能生效：热生效 / 重启 / HMR。' +
      '用于「改完没反应」的第一次分诊 —— 先分类改的是配置、宿主端代码还是客户端代码，再回答。' +
      '会先探测当前 profile 是否挂了 hmr：没有 hmr 时 reload() 是空操作，' +
      '任何「热生效」都会降级成必须重启。只读，不重启任何东西。',
    parameters: {
      change: {
        type: 'string',
        required: true,
        enum: ['config', 'bundle-added', 'host-code', 'client-code'],
        description:
          '改了什么。config=配置/patch/启用状态/卸载；bundle-added=新装 bundle；' +
          'host-code=已装插件的宿主端代码或插件依赖；client-code=客户端代码/界面。',
      },
      alreadyInDependencies: {
        type: 'boolean',
        description: '仅 change=bundle-added 时有意义：该包是否已经在 profile 的 dependencies 里。',
      },
    },
    output: toolOutput(EFFECT_MODE_TOOL),

    timeoutMs: deps.config.timeoutMs,
    isConcurrencySafe: () => true,

    async execute(rawArgs, exec) {
      const args = rawArgs as EffectModeArgs
      const deadline = createDeadline(deps.config.timeoutMs, deps.now)

      const missing = assertResolvedDshHome(deps.config)
      if (missing !== undefined) return toOutput(missing)

      const dir = profileDir(deps.config.dshHome, deps.config.profile)
      const probe = await probeHmrFor(deps, dir, deadline, exec.signal)
      if (probe.kind === 'fail') return toOutput(probe.failure)

      const usable = probe.hmrProbe.present && probe.hmrProbe.disabled !== 'yes'
      const decision = decideEffectMode({
        change: args.change,
        ...(args.alreadyInDependencies === undefined
          ? {}
          : { alreadyInDependencies: args.alreadyInDependencies }),
        hmrUsable: usable,
      })

      const data: EffectModeData = {
        change: decision.change,
        baseline: decision.baseline,
        mode: decision.mode,
        downgraded: decision.downgraded,
        why: decision.why,
        hmr: { usable, sources: probe.sources, probe: probe.hmrProbe },
        profile: deps.config.profile,
        // 本工具不涉及端口 —— 报 `not-used` 而不是把配置里那个「由工具推断」的 0 当结论。
        resolved: effectiveConfig(deps.config),
      }
      return toOutput(ok(data, { why: nextStepWhy(decision.mode) }))
    },
  })
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
 */
async function probeHmrFor(
  deps: ToolDeps,
  dir: string,
  deadline: ReturnType<typeof createDeadline>,
  signal: AbortSignal,
): Promise<HmrProbeOutcome> {
  const fromFiles = await detectHmrFromProfileFiles(dir)
  if (fromFiles.present) {
    return {
      kind: 'probe',
      hmrProbe: {
        present: true,
        disabled: 'no',
        evidence: fromFiles.evidence,
        note: 'profile 文件里发现 hmr（未跑 dump 复核）',
      },
      sources: ['profile-files'],
    }
  }

  // 文件层看不到：否定的代价大（一切降级），值得花一次 dump 复核。
  if (deadline.expired()) {
    return {
      kind: 'fail',
      failure: fail(
        {
          kind: 'timeout',
          message: '探测 hmr 时预算已耗尽，未能复核',
          hint: '调大 timeoutMs 后重试；或先调 dsh_dump_config 看 id: hmr 在不在',
        },
        {
          tool: 'dsh_dump_config',
          args: { profile: deps.config.profile },
          why: '用它一次拿到组合树，确认 hmr 行',
        },
      ),
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
      failure: fail(
        {
          kind: 'cancelled',
          message: '调用方取消了这次执行',
          hint: '不要自动重试；这是调用方主动放弃',
        },
        { why: '取消是调用方的决定，重试同一个调用没有意义' },
      ),
    }
  }
  if (dump.timedOut) {
    return {
      kind: 'fail',
      failure: fail(
        {
          kind: 'timeout',
          message: '复核 hmr 时 dump-config 超时（传输层先于工具预算超时）',
          hint: '先跑 dsh_dump_config 把组合树拿到手，再手工确认有没有 id: hmr',
        },
        {
          tool: 'dsh_dump_config',
          args: { profile: deps.config.profile },
          why: '拿到组合树后自己看 hmr 行',
        },
      ),
    }
  }

  if (dump.spawnError !== undefined) {
    const notFound = dump.spawnError.includes('ENOENT')
    return {
      kind: 'fail',
      failure: fail(
        {
          kind: notFound ? 'not-configured' : 'internal',
          message: `起不了 dsh：${dump.spawnError}`,
          hint: notFound
            ? '确认 PATH 上有 dsh，或本插件与宿主跑在同一个 node 上'
            : '把 message 原文带回；这是本插件的意外路径',
        },
        { tool: 'dsh_dump_config', args: { profile: deps.config.profile }, why: '用它复核组合树' },
      ),
    }
  }

  // 只看 stdout：`- id:` 的反向引用在 stderr 里以 `[path]` 形态出现，
  // 混进来会污染行起点匹配（`- id: hmr` 要求行首）。
  const fromDump = probeHmr(dump.stdout)
  return { kind: 'probe', hmrProbe: fromDump, sources: ['profile-files', 'dump-config'] }
}

/**
 * 挑一句合适的下一步建议。
 *
 * @param mode 生效方式。
 */
function nextStepWhy(mode: string): string {
  switch (mode) {
    case 'restart-required':
      return '这一步需要重启宿主；v1 只提供只读判断，重启助手在 v1.1'
    case 'client-rebuild':
      return '没有 hmr：客户端要重新构建后刷新页面（不用重启宿主）'
    case 'hot':
      return '配置类改动本该热生效；若没生效，多半是配置写错或被更高层整行覆盖'
    default:
      return '客户端改动由 HMR 自动换入，刷新页面即可'
  }
}
