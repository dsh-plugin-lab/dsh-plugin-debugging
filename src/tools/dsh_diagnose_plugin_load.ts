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
              message: '工具预算在开工前已耗尽',
              hint: '调大 timeoutMs 后重试；端口查询是这里最慢的一步',
            },
            {
              tool: DIAGNOSE_PLUGIN_LOAD_TOOL,
              args: { package: args.package ?? '' },
              why: '原样重试一次',
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
              message: `读不到 profile 的 package.json：${dir}`,
              hint: '确认 dshHome 与 profile 名对不对；这个 profile 可能还没被创建过',
            },
            {
              tool: DIAGNOSE_PLUGIN_LOAD_TOOL,
              args: { port: args.port ?? 0 },
              why: '换个 profile 名再试',
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
              message: '调用方取消了这次执行',
              hint: '不要自动重试；这是调用方主动放弃',
            },
            { why: '取消是调用方的决定，重试同一个调用没有意义' },
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
            error: '包在 Loader 树里没有任何一行',
            basis: 'Loader 树读到了，但这个包名/模块名一行都没匹配上 —— 组合层没有它',
          }
        }
        packages.push(diagnosed)
      }

      const observation: ObservationBlock = loader.ok
        ? {
            mode: 'observed',
            note: '以下相位是从宿主 Loader 树**直接观测**到的（同一个 primitive 宿主启动审计在用）',
            entryCount: loader.entries.length,
            phaseHistogram: histogram(loader.entries),
          }
        : {
            mode: 'inferred',
            ...(loader.reason === undefined ? {} : { reason: loader.reason }),
            note:
              '**未能直接观测，以下为推断**：读不到宿主 Loader 树，所以「插件崩没崩」只能靠' +
              ' bundles 列表 / 安装形态 / entry 存在 这些**前置条件**反推 —— 它们都不能证明加载成功。',
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
            ? '没有 startup-*.log —— 这是好消息：它们只在**启动失败**时生成，不是常驻日志'
            : `有 ${String(startupLogs.length)} 份启动失败日志（按时间倒序），最新一份值得整篇读`,
        loadProofCaveat: loader.ok
          ? '相位是从宿主 Loader 树直接观测的（`entry.fiber.state`，宿主启动审计用的同一个 primitive）。' +
            '但它**不是公开 API**、且只在树稳定后成立：热重载/刚 patch 进来的行可能仍在挂载中，' +
            '那时 `fiber` 尚不存在、会被读成 import 失败。看 phaseHistogram 判断快照是否已稳定。'
          : 'bundles 列表 / 安装形态 / entry 存在 都只证**前置条件**，不证加载成功：' +
            'Config 的 inactive 混合了「禁用/未导入/已销毁」且从不报 FAILED。' +
            '要硬证据就看 startup-*.log，或查该插件应有的注册面（工具 / slot / 服务）在不在。',
      }

      const missingEntries = packages.filter((item) => !item.entry.entryExists)
      if (missingEntries.length > 0) {
        return toOutput(
          fail(
            {
              kind: 'not-found',
              message: `${String(missingEntries.length)} 个包的 entry 文件不存在：${missingEntries
                .map((item) => item.packageName)
                .join(', ')}`,
              hint: 'entry 指不到文件 = 组合层会整条丢弃这个插件；先重新构建产物，或确认安装形态是 link 还是 copy 快照',
            },
            {
              tool: DIAGNOSE_PLUGIN_LOAD_TOOL,
              args: { package: missingEntries[0]?.packageName },
              why: '单独看这一个包',
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
      '未能直接观测 Loader 树，以下为**推断**：' +
      '三处前置条件（bundles / 安装形态 / entry 文件）只证「有可能加载」，不证加载成功'
    )
  }
  const parts: string[] = []
  if (input.failed.length > 0) {
    const detail = input.failed
      .map((item) => `${item.packageName}（${item.observed?.error ?? '原因未取到'}）`)
      .join('；')
    parts.push(`**观测到加载失败**：${detail}`)
  }
  if (input.absent.length > 0) {
    parts.push(
      `**装了但 Loader 树里没有这一行**：${input.absent.map((item) => item.packageName).join('、')}` +
        '（组合层没它 —— 查 bundles 有没有进、patch 有没有被后层整行替换）',
    )
  }
  if (input.pending.length > 0) {
    const detail = input.pending
      .map((item) => {
        const missing = item.observed?.missingInject ?? []
        return `${item.packageName}（等 ${missing.length === 0 ? '挂载' : missing.join(', ')}）`
      })
      .join('；')
    parts.push(`**仍在 pending**：${detail}`)
  }
  if (input.stale.length > 0 && parts.length === 0) {
    parts.push(
      `产物比进程新：${input.stale.map((item) => item.packageName).join('、')} —— 宿主端跑的是旧产物，改完代码没重启`,
    )
  }
  if (parts.length === 0) {
    return '观测到这些行都是 active：插件确实加载成功了，问题不在「有没有加载」这一层'
  }
  return parts.join('。')
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
