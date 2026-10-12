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

/** `data.hmr` 的取值：这个 profile 有没有**可用的** hmr（也就是有没有人在 watch patch 文件）。 */
export type HmrAvailability = 'present' | 'absent'

/** 返回的 `data`。 */
interface EffectModeData {
  change: EffectChangeKind
  /** 只看 SKILL §一 原表的答案。 */
  baseline: string
  /** 结合 hmr 探测后的最终答案。 */
  mode: string
  downgraded: boolean
  why: string
  /**
   * **一眼可读的 hmr 结论** —— 让模型不必从 `why` 里推理、也不必知道 `loader` 的内部机制。
   *
   * - `'present'`：该 profile 挂着**可用的** hmr，**而 watch patch 文件的正是它** ——
   *   所以 patch/config 改动会被重读；
   * - `'absent'`：没有可用的 hmr（行不存在，或被静态禁用）—— **没有任何东西在 watch patch 文件**，
   *   所以改 config **必须重启**才生效。
   *
   * 实测依据（2026-10-13，无 hmr 的隔离实例）：改 patch 文件后 70 秒 / 21 个采样点读到的一直是旧值、
   * stderr 为空；重启后立刻读到新值。见 `AGENTS.md` 活跃坑里那条「触发者在 hmr」。
   */
  hmr: HmrAvailability
  /** 原始探测细节（谁参与了判定、probe 原文）—— 要复核 `hmr` 结论时看这里。 */
  hmrDetail: {
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
      'Classifies what a change needs before it takes effect: live, a restart, or HMR. ' +
      'Use it when a change had no effect and you are about to tell the user whether a reload or a restart is required. ' +
      'Read-only — and it stays useful without hot reload: a client-code change then falls back to ' +
      'rebuild-and-refresh instead of a restart, while a config change is reported as restart-required.',
    parameters: {
      change: {
        type: 'string',
        required: true,
        enum: ['config', 'bundle-added', 'host-code', 'client-code'],
        description:
          'What you changed: `config` (config, patch, enablement, or uninstall), `bundle-added` ' +
          '(a newly installed bundle), `host-code` (host-side code or dependencies of an installed ' +
          'plugin), or `client-code` (client code or UI).',
      },
      alreadyInDependencies: {
        type: 'boolean',
        description:
          'Only meaningful with `change: bundle-added` — whether that package is already in the ' +
          "profile's dependencies.",
      },
    },
    output: toolOutput(EFFECT_MODE_TOOL, summarizeEffectMode),

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
        // 探测本来就在做（否则做不了降级判定）—— 这里只是把它从内部状态提升成契约字段。
        hmr: usable ? 'present' : 'absent',
        hmrDetail: { usable, sources: probe.sources, probe: probe.hmrProbe },
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
        note: 'found hmr in the profile files (skipped the dump re-check)',
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
          message: 'the budget ran out while probing hmr, so it could not be verified',
          hint: 'raise timeoutMs and retry, or call dsh_dump_config first to check whether the id: hmr row exists',
        },
        {
          tool: 'dsh_dump_config',
          args: { profile: deps.config.profile },
          why: 'use it to get the composed tree in one call and confirm the hmr row',
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
          message: 'the caller cancelled this execution',
          hint: 'do not retry automatically; the caller gave up on purpose',
        },
        { why: 'cancellation is up to the caller; retrying the same call is pointless' },
      ),
    }
  }
  if (dump.timedOut) {
    return {
      kind: 'fail',
      failure: fail(
        {
          kind: 'timeout',
          message:
            'dump-config timed out while verifying hmr (the transport layer timed out first, before the tool budget)',
          hint: 'run dsh_dump_config to get the composed tree, then confirm manually whether an id: hmr row exists',
        },
        {
          tool: 'dsh_dump_config',
          args: { profile: deps.config.profile },
          why: 'read the hmr row from the composed tree',
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
          message: `cannot start dsh: ${dump.spawnError}`,
          hint: notFound
            ? 'make sure dsh is on PATH, or that this plugin runs on the same node as the host'
            : 'report the message verbatim; this is an unexpected path in this plugin',
        },
        {
          tool: 'dsh_dump_config',
          args: { profile: deps.config.profile },
          why: 'use it to verify the composed tree',
        },
      ),
    }
  }

  // 只看 stdout：`- id:` 的反向引用在 stderr 里以 `[path]` 形态出现，
  // 混进来会污染行起点匹配（`- id: hmr` 要求行首）。
  const fromDump = probeHmr(dump.stdout)
  return { kind: 'probe', hmrProbe: fromDump, sources: ['profile-files', 'dump-config'] }
}

/**
 * 渲染首行的**一句话结论**。
 *
 * 为什么需要它：`data` 里带着 hmr 探测的证据行（patch 文件里的原文），整块 JSON 很长；
 * 而模型唯一必须看到的是**判定本身，以及它与 hmr 的关系** ——
 * 尤其是无 hmr 时那句「没人 watch patch 文件，所以改 config 不会生效」。
 *
 * @param data 工具的 `data`；形状不对时返回 `undefined`，让渲染退回纯 JSON。
 */
export function summarizeEffectMode(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const record = data as Partial<EffectModeData>
  if (typeof record.mode !== 'string' || typeof record.hmr !== 'string') return undefined
  const verdict = `verdict: mode=${record.mode} · hmr=${record.hmr}`
  const downgrade = record.downgraded === true ? ' · downgraded (no usable hmr)' : ''
  const why = typeof record.why === 'string' && record.why !== '' ? ` — ${record.why}` : ''
  return `${verdict}${downgrade}${why}`
}

/**
 * 挑一句合适的下一步建议。
 *
 * @param mode 生效方式。
 */
function nextStepWhy(mode: string): string {
  switch (mode) {
    case 'restart-required':
      return 'this step needs a host restart; v1 gives the read-only verdict only — the restart helper is v1.1'
    case 'client-rebuild':
      return 'no hmr: rebuild the client, then refresh the page (no host restart needed)'
    case 'hot':
      return 'a config change is supposed to take effect live; if it did not, the config is likely wrong or a later layer replaced the whole row'
    default:
      return 'hmr swaps the client change in; just refresh the page'
  }
}
