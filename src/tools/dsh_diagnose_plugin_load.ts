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
      '查一个插件是不是真的加载了：profile 的 bundles 列表、安装形态（link/copy）、' +
      'entry 与 patch 文件在不在、启动失败日志。' +
      '注意：这些都只证前置条件，不证加载成功 —— Fiber 状态没有查询入口，' +
      'inactive 从不报 FAILED。硬证据只有启动失败时才生成的 startup-*.log。' +
      '进程按端口查，不用命令行子串。只读。',
    parameters: {
      package: {
        type: 'string',
        description:
          '要查的包名（如 dsh-zhihu-search 或 @scope/name）；省略则逐个列 bundles 里的包。',
      },
      port: {
        type: 'integer',
        description: '宿主监听端口；省略则用插件配置的 port，再退回环境里的 DSH_WEB_URL。',
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

      const packages: PackageDiagnosis[] = []
      for (const packageName of names) {
        const install = await readInstallShape(dir, packageName)
        const entry = await checkInstalledEntry(dir, packageName)
        const startedAt = portLookup?.listeners[0]?.startedAt
        packages.push({
          packageName,
          inBundles: manifest.bundles.includes(packageName),
          install,
          entry,
          artifactNewerThanProcess: compareArtifactWithProcess(entry, startedAt),
        })
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
        loadProofCaveat:
          'bundles 列表 / 安装形态 / entry 存在 都只证**前置条件**，不证加载成功：' +
          'Fiber 状态没有查询入口，Config 的 inactive 混合了「禁用/未导入/已销毁」且从不报 FAILED。' +
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
      return toOutput(
        ok(data, {
          why:
            stale.length > 0
              ? `产物比进程新：${stale.map((item) => item.packageName).join(', ')} —— 宿主端跑的是旧产物，改完代码没重启`
              : '三处前置条件都满足；若行为仍不对，读 startup 日志或查注册面',
        }),
      )
    },
  })
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
