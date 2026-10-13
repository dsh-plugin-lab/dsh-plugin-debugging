/**
 * `dsh_diagnose_plugin_load` —— 「插件到底加载了吗」的外部三处 + 启动日志。
 *
 * 对应 SKILL §3.1 / §3.2 / §3.8。工具的输出里必须带上一句**否定性**的说明：
 * Fiber 级状态**没有查询入口**，`Config.listConfigs` 的 `inactive` 混合了
 * 「禁用 / 未导入 / 已销毁」三义、**从不报 FAILED**。所以下面查到的三处
 * （bundles 列表、安装形态、entry 在不在）**都只证前置条件，不证加载成功**。
 * 不说这句话，模型就会把「三处都在」读成「插件活着」。
 *
 * 真正的硬证据只有一条：**启动失败**时才会生成的
 * `$DSH_HOME/logs/startup-<ISO>-<uuid>.log`。所以「一条都没有」= 好消息。
 *
 * 进程一律**按端口**查（SKILL §3.5）：命令行子串会误匹配派生 shell。
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import { fail, ok } from '../lib/errors.js'
import { budgetFor, createDeadline } from '../lib/timeouts.js'
import { indexByIdentifier, projectFiberPhase, worstOf, type FiberPhase } from '../lib/fiber.js'
import type { LoaderEntrySnapshot } from '../lib/fiber.js'
import { lookupPort, type PortLookupResult } from '../lib/ports.js'
import {
  checkInstalledEntry,
  listStartupLogs,
  profileDir,
  readInstallShape,
  readProfileManifest,
  type EntryCheck,
  type InstallShape,
  type StartupLog,
} from '../lib/profile.js'
import {
  assertResolvedDshHome,
  effectiveConfig,
  resolvePort,
  toOutput,
  toolOutput,
  type ToolDeps,
} from './shared.js'

/** 工具名。 */
export const DIAGNOSE_PLUGIN_LOAD_TOOL = 'dsh_diagnose_plugin_load'

/** 参数。 */
interface DiagnoseArgs {
  package?: string
  port?: number
}

/** 一个包的诊断条目。 */
interface PackageDiagnosis {
  packageName: string
  /** 是否在 profile 的 `dsh.profile.bundles` 里。 */
  inBundles: boolean
  install: InstallShape
  entry: EntryCheck
  /**
   * 产物是否比监听进程**新**。
   *
   * `true` = 宿主端跑的是**旧产物**（改完代码没重启）—— SKILL §四 那条判据。
   * 读不到进程启动时间时为 `null`（**不是** `false`：unknown ≠ 没这回事）。
   */
  artifactNewerThanProcess: boolean | null
  /**
   * **观测**到的相位（只有 `observation.mode === 'observed'` 时才有值）。
   *
   * 与上面那些字段的关系是「观测 vs 推断」，两者**不混**：
   * `install` / `entry` / `inBundles` 只证前置条件，这一项才回答「崩没崩」。
   */
  observed?: {
    /** 命中Loader 树里的哪几行（可能 0 行 = 装了但树里没有这一行）。 */
    matchedEntryIds: string[]
    phase: FiberPhase
    error?: string
    missingInject?: string[]
    fiberState?: number
    basis: string
  }
}

/** 观测的整体状态。 */
interface ObservationBlock {
  /** `observed` = 读到了宿主 Loader 树；`inferred` = 读不到，以下全是推断。 */
  mode: 'observed' | 'inferred'
  /** `inferred` 时的原因（原样展示，让人知道为什么没能观测）。 */
  reason?: string
  /** 一句话说明这次输出属于哪一类。 */
  note: string
  /** 读到的 entry 总数（`observed` 时）。 */
  entryCount?: number
  /**
   * 相位直方图 —— `{"active":162,"failed":2,"null":29}` 形态。
   *
   * 为什么要它：单个包的相位可能因为「还没轮到挂载」而看起来正常或异常，
   * 一眼看到整棵树的分布，才能判断这次快照是不是**稳定态**。
   */
  phaseHistogram?: Record<string, number>
}

/**
 * 造工具。
 *
 * @param deps 运行期依赖。
 */
export function createDiagnosePluginLoadTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: DIAGNOSE_PLUGIN_LOAD_TOOL,
    description:
      'Checks whether a plugin actually loaded. ' +
      'Use it when a plugin is installed but seems absent — its tools, page, or skill do not show up. ' +
      'Read-only — and it keeps observed evidence (the host loader tree) separate from inferred ' +
      'evidence (bundles membership, install form, entry files), which only prove the plugin could ' +
      'load; treat output marked `mode=inferred` accordingly.',
    parameters: {
      package: {
        type: 'string',
        description:
          'Package to check, e.g. `dsh-zhihu-search` or `@scope/name`; omit to check every bundle.',
      },
      port: {
        type: 'integer',
        description:
          "Host port to probe; omit to use the plugin's configured port, falling back to `DSH_WEB_URL`.",
      },
    },
    output: toolOutput(DIAGNOSE_PLUGIN_LOAD_TOOL),

    timeoutMs: deps.config.timeoutMs,
    isConcurrencySafe: () => true,

    async execute(rawArgs, exec) {
      const args = rawArgs as DiagnoseArgs
      const deadline = createDeadline(deps.config.timeoutMs, deps.now)

      const missing = assertResolvedDshHome(deps.config)
      if (missing !== undefined) return toOutput(missing)

      // 预算在真正开工前就耗尽：文件层诊断虽然便宜，也不该在「已超时」的前提下继续跑 ——
      // 那会让宿主先掐掉我们，模型拿到的是裸 TimeoutError 而不是结构化 timeout。
      if (deadline.expired()) {
        return toOutput(
          fail(
            {
              kind: 'timeout',
              message: 'the tool budget ran out before any work started',
              hint: 'raise timeoutMs and retry; the port lookup is the slowest step here',
            },
            {
              tool: DIAGNOSE_PLUGIN_LOAD_TOOL,
              args: { package: args.package ?? '' },
              why: 'retry once as-is',
            },
          ),
        )
      }

      const { dshHome, profile } = deps.config
      const dir = profileDir(dshHome, profile)
      const manifest = await readProfileManifest(dir)

      if (manifest === undefined) {
        return toOutput(
          fail(
            {
              kind: 'not-found',
              message: `cannot read the profile package.json: ${dir}`,
              hint: 'check that dshHome and the profile name are correct; this profile may not exist yet',
            },
            {
              tool: DIAGNOSE_PLUGIN_LOAD_TOOL,
              args: { port: args.port ?? 0 },
              why: 'try another profile name',
            },
          ),
        )
      }

      const names = args.package === undefined ? manifest.bundles : [args.package]
      const resolvedPort = resolvePort(args.port, deps.config.port, deps.env)
      const portLookup: PortLookupResult | undefined =
        resolvedPort === undefined
          ? undefined
          : await lookupPort(resolvedPort.port, {
              spawn: deps.spawn,
              timeoutMs: budgetFor(deps.config.timeoutMs, deadline),
              signal: exec.signal,
            })

      // 端口查询只是**加分项**：它失败（超时 / 查不了）不该让整份文件层诊断作废。
      // 但**调用方取消**是另一回事 —— 那是我们主动放弃，不能拿半份结果当结论。
      if (exec.signal.aborted) {
        return toOutput(
          fail(
            {
              kind: 'cancelled',
              message: 'the caller cancelled this execution',
              hint: 'do not retry automatically; the caller gave up on purpose',
            },
            { why: 'cancellation is up to the caller; retrying the same call is pointless' },
          ),
        )
      }

      // ── 观测：试着直接读宿主 Loader 树（`fiber.state`） ──────────────────────
      // 读不到就降级成推断；**降级不是错误** —— 那是宿主内部 primitive，见 lib/fiber.ts 文件头。
      const loader = deps.loader()
      const index = loader.ok ? indexByIdentifier(loader.entries) : undefined

      const packages: PackageDiagnosis[] = []
      for (const packageName of names) {
        const install = await readInstallShape(dir, packageName)
        const entry = await checkInstalledEntry(dir, packageName)
        const startedAt = portLookup?.listeners[0]?.startedAt
        const diagnosed: PackageDiagnosis = {
          packageName,
          inBundles: manifest.bundles.includes(packageName),
          install,
          entry,
          artifactNewerThanProcess: compareArtifactWithProcess(entry, startedAt),
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
            note: 'the phases below were **directly observed** from the host Loader tree (the same primitive the host startup audit uses)',
            entryCount: loader.entries.length,
            phaseHistogram: histogram(loader.entries),
          }
        : {
            mode: 'inferred',
            ...(loader.reason === undefined ? {} : { reason: loader.reason }),
            note:
              '**Could not observe directly; the following is inferred**: the host Loader tree could not be read, so whether a plugin crashed can only be inferred from' +
              ' preconditions — bundles list / install shape / entry presence — and none of those prove that loading succeeded.',
          }

      const startupLogs: StartupLog[] = await listStartupLogs(dshHome)

      const data = {
        profile,
        profileDir: dir,
        /**
         * 生效配置：这份诊断的**全部结论都建立在「读的是哪个目录」之上**，
         * 所以 DSH_HOME 的来源（配置 / env / 宿主默认值）必须摊开 —— 读默认目录
         * 而用户以为读的是另一个，正是这类工具最坏的一种失败。
         */
        resolved: effectiveConfig(deps.config, resolvedPort),
        /**
         * **本次输出是观测还是推断** —— 这个字段必须放在最显眼处。
         * 观测与推断的置信度完全不同：前者能说「它 import 期就崩了」，
         * 后者只能说「三处前置条件都在」。混在一起看会让人高估后者。
         */
        observation,
        bundles: manifest.bundles,
        bundleCount: manifest.bundles.length,
        packages,
        /** 端口查询的明细（端口值本身在 `resolved.port`，不在这里重复）。 */
        port: { lookup: portLookup ?? null },
        startupLogs,
        startupLogsNote:
          startupLogs.length === 0
            ? 'no startup-*.log — that is good news: these are only written when **startup fails**, they are not a rolling log'
            : `${String(startupLogs.length)} startup-failure log(s), newest first; the newest one is worth reading in full`,
        loadProofCaveat: loader.ok
          ? 'Phases are observed directly from the host Loader tree (`entry.fiber.state`, the same primitive the host startup audit uses). ' +
            'It is **not a public API** and only holds once the tree has settled: rows from hot reload or a fresh patch may still be mounting, and ' +
            'then `fiber` does not exist yet and is read as an import failure. Use phaseHistogram to judge whether the snapshot has settled.'
          : 'The bundles list / install shape / entry presence only prove **preconditions**, not that loading succeeded: ' +
            'The inactive state in Config mixes up "disabled / not imported / disposed" and never reports FAILED. ' +
            'For hard evidence read startup-*.log, or check whether the registration surface this plugin should have (tools / slots / services) is present.',
      }

      const missingEntries = packages.filter((item) => !item.entry.entryExists)
      if (missingEntries.length > 0) {
        return toOutput(
          fail(
            {
              kind: 'not-found',
              message: `entry file missing for ${String(missingEntries.length)} package(s): ${missingEntries
                .map((item) => item.packageName)
                .join(', ')}`,
              hint: 'an entry that points to no file means the composition layer drops this plugin entirely; rebuild the artifacts first, or check whether the install shape is link or a copy snapshot',
            },
            {
              tool: DIAGNOSE_PLUGIN_LOAD_TOOL,
              args: { package: missingEntries[0]?.packageName },
              why: 'look at this package alone',
            },
          ),
        )
      }

      const stale = packages.filter((item) => item.artifactNewerThanProcess === true)

      // 观测到的结论分成三类。**注意这里仍然返回 `ok: true`**：
      // 工具**诊断成功**了 —— 否则按失败分支返回会把 observation / packages 这些
      // 证据一起丢掉（失败分支没有 data 槽）。结论放进 verdict，并让 nextStep 领走。
      const failed = observedWith(packages, 'failed').filter(
        (item) => item.observed?.matchedEntryIds.length !== 0,
      )
      const absent = packages.filter((item) => item.observed?.matchedEntryIds.length === 0)
      const pending = observedWith(packages, 'pending')

      const verdict = buildVerdict({ loader, failed, absent, pending, stale })

      return toOutput(ok({ ...data, verdict }, { why: verdict }))
    },
  })
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
 * 拼一句结论（也是 nextStep 的 why）。
 *
 * 优先级按「用户下一步要做什么」排：崩了最重要，其次没进树，再次 pending，
 * 最后才是「三处前置条件都在」这种弱结论。
 *
 * @param input 各档命中的包。
 */
function buildVerdict(input: {
  loader: { ok: boolean }
  failed: readonly PackageDiagnosis[]
  absent: readonly PackageDiagnosis[]
  pending: readonly PackageDiagnosis[]
  stale: readonly PackageDiagnosis[]
}): string {
  if (!input.loader.ok) {
    return (
      'Could not observe the Loader tree directly; the following is **inferred**: ' +
      'the three preconditions (bundles / install shape / entry file) only prove that loading is possible, not that it succeeded'
    )
  }
  const parts: string[] = []
  if (input.failed.length > 0) {
    const detail = input.failed
      .map((item) => `${item.packageName} (${item.observed?.error ?? 'reason unavailable'})`)
      .join('; ')
    parts.push(`**Observed load failure**: ${detail}`)
  }
  if (input.absent.length > 0) {
    parts.push(
      `**Installed but absent from the Loader tree**: ${input.absent.map((item) => item.packageName).join(', ')}` +
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
    parts.push(`**Still pending**: ${detail}`)
  }
  if (input.stale.length > 0 && parts.length === 0) {
    parts.push(
      `artifacts are newer than the process: ${input.stale.map((item) => item.packageName).join(', ')} — the host is running stale artifacts, so code changed without a restart`,
    )
  }
  if (parts.length === 0) {
    return 'all observed rows are active: the plugin really did load, so the problem is not at the "did it load" layer'
  }
  return parts.join('. ')
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
 * 比「产物 mtime」与「进程启动时间」。
 *
 * @param entry 入口检查结果。
 * @param startedAt 进程启动时间（ISO 8601）。
 */
function compareArtifactWithProcess(
  entry: EntryCheck,
  startedAt: string | undefined,
): boolean | null {
  if (entry.entryMtimeMs === undefined || startedAt === undefined) return null
  const startedMs = Date.parse(startedAt)
  if (!Number.isFinite(startedMs)) return null
  return entry.entryMtimeMs > startedMs
}
