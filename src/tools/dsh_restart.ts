/**
 * `dsh_restart` —— 本仓唯一**不可逆**的工具：它杀掉正在被排障的那个宿主。
 *
 * ## 它只做前半条链
 *
 * 四道确定性闸门 → 审批门 → 写 marker → 拉起新进程 → 本进程退出。
 * 「新进程起来之后」那半条（读 marker → 唤醒会话 → 投 notice → 把 marker 标为已消费）
 * 是**启动期**逻辑，不在这条调用路径上（由另一张卡承担）。所以本工具的 `verdict`
 * 只说「这次重启已经交出去了」，**不报新 pid** —— 那个进程不是本层起的。
 *
 * ## 顺序本身就是判据（SHAPE §6.1）
 *
 * 0. **两条「纯取值」的先决条件也在动手之前判**：`ctx.get('appExit')` 的**可达性**与
 *    拉起的**命令行长度**都不落盘、不拉起，所以它们与四道闸同属「动手前先拒」。
 *    ⚠️ 反面教材（2026-10-14 独立复核抓到的真缺陷，已修）：先 `schtasks /run`、后取
 *    `appExit`，取不到时返回的 `verdict` 却说「the restart was not started」——
 *    而拉起**已经发生**（延迟只写在命令行的 `ping` 里），盘上留着 marker、老宿主又不退出
 *    ⇒ **双宿主**（新宿主多半 `EADDRINUSE` boot 失败，C11）。**verdict 说假话比拒绝坏得多。**
 * 1. **先过四道确定性闸门，再走审批门** —— 反了就是「先弹窗让用户同意、再告诉他闸③不过」。
 *    但 `planRestart` 把「四道闸」与「写 marker」收在**同一个入口**里，所以实现是**两段式**：
 *    先 `dryRun: true` 探一遍（**不落盘**），过了才走审批，再 `dryRun: false` 真正落盘。
 * 2. **marker 必须在拉起之前 `await` 完成**：`planRestart` 返回时 `markerWritten === true`
 *    才允许拉起。`dryRun` 那次 `markerWritten === false`，那时既不许拉起、也不许退出。
 * 3. **先 `await` 完写、再调 `appExit`** —— `AppExit` 的语义是「等树 dispose 完再退」。
 *
 * ## 两道互相独立的门（描述与输出都要说清）
 *
 * - **审批档**（`ask` / `never`）：`ask` ⇒ 调官方审批门，**只有 `allowed-once` 算允许**
 *   （`rejected` / `cancelled` / `unavailable` 一律当拒绝）；`never` ⇒ **不问、直接执行** ——
 *   它的含义是「提示已关闭」，在那一档主动去问**必然被拒**（宿主 `decide()` 里
 *   `policy === 'never'` 直接返回 `rejected`）；档位读不出来 ⇒ fail-closed。
 * - **文件沙箱档**：写 `$DSH_HOME` 不在默认 `workspace-write` 的 writableRoots 里，
 *   所以本工具**显式**给 `danger-full-access`（实测见 `src/lib/restart-fs.ts` 文件头）。
 *   两道门互不替代：审批放行不等于写文件不会被沙箱拒。
 *
 * ⚠️ 这一档的**字面量只有一处**：`src/lib/restart-recovery.ts` 的
 * {@link RESTART_SANDBOX_MODE} —— 恢复半也要显式传它，两份字面量迟早会分叉。
 *
 * ## 为什么没有 `process.exit`
 *
 * 退出走 `ctx.get('appExit')`（`AppExit = (code: number) => void`）—— 宿主源码点名
 * `process.exit` 那条路 bypassing `ctx.appExit`。取不到 ⇒ **结构化失败**，不猜（B24）。
 *
 * ## 拉起走计划任务 —— 而「能不能回来」是**另一维**
 *
 * `{detached: true}` 实测**不能**逃出宿主的 job（宿主退出时被 `KILL_ON_JOB_CLOSE` 一起收掉），
 * 而计划任务（`schtasks`）实测无需提权、父进程是 `svchost.exe`、被起进程 `inHostJob=0`
 * （见 `docs/HOST-CONTRACTS.md` §2.2.2 的 [A] 行）。⇒ 本层在 Windows 上走它。
 *
 * ⚠️ **但「拼得出一条命令」不等于「有人能把它拉回来」**（2026-10-15 真机缺陷）：
 * 桌面宿主上命令拼得出来（拼的还是另一个 profile），闸④ 于是放行、宿主退出、**没人回来**。
 * 所以闸④ 的**第一问是载体**（`lib/carrier.ts` 的路线表）：
 * - 桌面宿主 ⇒ `no-relaunch-route`（插件侧没有通道，只有 Electron 壳能 `app.relaunch()`）；
 * - 非 win32 的命令行 ⇒ `no-relaunch-route`（没有已实测路线）；
 * - 认不出来 ⇒ `no-relaunch-route`（不猜）；
 * - 只有 `cli × win32` 才轮到第二问「命令定得出来吗」⇒ 定不出来是 `no-launch-command`。
 *
 * 两种拒绝都在**动任何东西之前**（零写 marker、零拉起、零退出）。
 */
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'

import {
  fail,
  messageOf,
  ok,
  type NextStep,
  type ToolFail,
  type ToolResult,
} from '../lib/errors.js'
import { budgetFor, createDeadline, toolBudgetMs, type Workload } from '../lib/timeouts.js'
import {
  carrierAuditOf,
  relaunchRefusalFor,
  unverifiedRelaunchReason,
  type CarrierKind,
  type CarrierObservation,
} from '../lib/carrier.js'
import { resolveDshLaunch } from '../lib/dump.js'
import type { SpawnImpl } from '../lib/exec.js'
import { profileDir, readProfileManifest } from '../lib/profile.js'
import { createRestartFsPort } from '../lib/restart-fs.js'
import { RESTART_SANDBOX_MODE } from '../lib/restart-recovery.js'
import {
  decideRecovery,
  hiddenLauncherAvailable,
  launcherScriptPath,
  launcherShimPath,
  planRestart,
  powershellPath,
  readRestartMarker,
  restartLauncherJobPath,
  restartLauncherLogPath,
  restartMarkerPath,
  restartStopWindowLogPath,
  restartStopWindowPidPath,
  serializeLauncherJob,
  showWindowShimPath,
  stopWindowScriptPath,
  wscriptPath,
  type BusySource,
  type GateId,
  type LaunchCommand,
  type Observed,
  type RefusalCode,
  type RestartFsPort,
  type RestartMarker,
  type RestartPlan,
  type RestartPlanFailed,
  type RestartPlanRefused,
  type RestartPorts,
  type RestartRequest,
} from '../lib/restart.js'
import type { RenderTable } from '../lib/render.js'
import type { ResolvedConfig } from '../contracts.js'
import { composeDescription, type ToolDescription } from './describe.js'
import {
  assertResolvedDshHome,
  effectiveConfig,
  resolvePort,
  resolvedLine,
  toOutput,
  toolOutput,
  type EffectiveConfigBlock,
  type ToolDeps,
} from './shared.js'

/** 工具名。 */
export const RESTART_TOOL = 'dsh_restart'

/**
 * 总闸那个配置字段名（**逐字**取自 `src/config.ts` 的那个 `Config` 字段）。
 *
 * 它的字面量**只有这一处** —— 它要逐字进模型可见文本，而抄第二遍就意味着
 * 「改了字段名、模型还在教用户改一个不存在的东西」（本仓「一处一事实」那一族）。
 */
export const RESTART_CONFIG_FIELD = 'enableRestart'

/**
 * 本工具的工作量档：**快档**。
 *
 * 它读两个小文件（profile 清单 + marker）、问一次宿主服务、跑两条 `schtasks` ——
 * 与「读文件的工具」同一量级。慢档留给真正跑 `--dump-config-schema` 的那个工具。
 */
const WORKLOAD: Workload = 'quick'

/** 组合解析不了时指路的那个工具（与闸③的 `suggestedTool` 同源）。 */
const DUMP_CONFIG_TOOL = 'dsh_dump_config'

/**
 * `delayMs` 的默认值（毫秒）：**给回执落盘留的窗口**，不是工具预算。
 *
 * 它不是 `timeouts.ts` 那套预算（那套管的是「这次调用能等多久」，唯一出处是
 * `toolBudgetMs`）；它是「新进程什么时候起来」。两者混起来会让「预算」这个词有两个含义。
 *
 * 3 秒的依据（2026-10-17 真机）：marker 在闸④之后、排程之前就已落盘（`markerWritten: true`
 * 先于排程打印），旧进程在排程后只做「退出」这一件事 —— 维护者 2026-10-17 拍板收窄到 3s；
 * 若真机出现「旧进程未死透」的竞态（新宿主抢文件失败），这里的第一嫌疑就是本值。
 */
const DEFAULT_DELAY_MS = 3_000

/**
 * 写 marker 时显式传给宿主 `fs.writeText` 的沙箱档位。
 *
 * **必须显式给**：默认档 `workspace-write` 下 `$DSH_HOME` 不在 writableRoots 里 ⇒ 必被
 * `FS_SANDBOX_DENIED` 拒掉（`task-31` 真机实测）。这一档只影响**文件沙箱**，与审批档无关。
 *
 * ⚠️ 它**不是**本文件定义的：字面量住在 `src/lib/restart-recovery.ts`，因为恢复半也要
 * 显式传同一个档位（两份字面量会分叉）。这里只是给本层一个短名字。
 */
const SANDBOX_MODE = RESTART_SANDBOX_MODE

/** 计划任务的固定名字（`/f` 覆盖同名任务，所以它可重入）。 */
const TASK_NAME = 'dsh-plugin-debugging-restart'

/**
 * `schtasks /tr` 取值的长度上限（**文档值，未在本机复现**）。
 *
 * **出处**：Microsoft Learn 的 `schtasks create` 页面对 `/TR` 的说明 —— 任务运行命令的
 * 字符数上限为 **261**。⚠️ 本机**没有**真建过一条超长任务去撞这条线（那要写计划任务，
 * 属真机动作），所以它是**文档值**、不是实测值；方向仍然是安全的：撞上它时 `schtasks`
 * 只给一句参数错，比我们提前拒绝难诊断得多。
 *
 * **为什么本仓真的会撞上**：本机按真实形状生成的那条命令行（`set "DSH_HOME=…"` +
 * `cd /d …` + `ping -n …` + 完整 argv）**复核实测已达 269 字符** —— 已经在这条线之上。
 */
export const SCHTASKS_TR_MAX_CHARS = 261

/**
 * 「这个会话上还有什么在跑」的那个 waterfall 事件名（C7）。
 *
 * 宿主侧的三个提供方（`dsh-agent` 的 `turn`、`dsh-jobs-local` 的 `job`、`dsh-subagent`
 * 的 `subagent`、`dsh-schedule` 的 `schedule`）都挂在它上面。
 */
const ACTIVITY_EVENT = 'workspace/session-activity'

/** 走到哪一步了（机器码，进 `key`）。 */
export type RestartStage = 'gates' | 'approval' | 'dry-run' | 'marker' | 'relaunch' | 'exit'

/** 审批档位（宿主 `ApprovalPolicy` 的闭集，本层不猜第三值）。 */
export type RestartApprovalPolicy = 'ask' | 'never'

/** 审批结论（宿主 `ApprovalOutcome` 的闭集）。 */
export type RestartApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/**
 * 审批门的注入面。
 *
 * `policyOf` 是**同步**的：宿主 `effectivePolicy(session)` 就是同步读一次会话日志的折叠值。
 * 它返回 `undefined` 表示**读不出来**（服务缺席 / 形状不认识 / 没有 agent）——
 * 那是 fail-closed 的那一格，**不是**「没有档位 = 随便做」。
 */
export interface RestartApprovalPort {
  /** 读这次调用所在会话的审批档位；读不出来 ⇒ `undefined`（fail-closed）。 */
  policyOf(agent: unknown): RestartApprovalPolicy | undefined
  /** 走官方审批门。**不抛**：任何异常收敛成 `'unavailable'`。 */
  request(
    agent: unknown,
    reason: string,
    signal?: AbortSignal | undefined,
  ): Promise<RestartApprovalOutcome>
}

/** 一次拉起请求（命令、延迟、预算、取消信号）。 */
export interface RelaunchRequest {
  /** 可执行文件。 */
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  /**
   * **模型可复核的完整命令行**（逐字进 `key.relaunch`）。
   *
   * 它比 `command` / `args` 更能说明「到底会跑什么」—— 计划任务那条路上还要先设
   * `DSH_HOME`、先睡 `delayMs`，那些都在这一行里。
   */
  readonly commandLine: string
  /** 回执窗口（毫秒）：新进程延后这么久才起来。 */
  readonly delayMs: number
  /** 本次传输预算（毫秒），由调用方经 `budgetFor` 取。 */
  readonly budgetMs: number
  readonly signal?: AbortSignal | undefined
}

/** 拉起的结果（**不抛**，失败收敛成 `ok: false`）。 */
export type RelaunchResult = { ok: true; detail: string } | { ok: false; reason: string }

/** 拉起端口。 */
export interface RelaunchPort {
  /** 真拉起新进程；**不抛**。 */
  relaunch(request: RelaunchRequest): Promise<RelaunchResult>
}

/** 退出端口。 */
export interface RestartExitPort {
  /** 取宿主退出通道；取不到 ⇒ `undefined`（结构化失败，**不**退回 `process.exit`）。 */
  exit(): ((code: number) => void) | undefined
}

/** 本工具要的宿主面（在 `src/tools/index.ts` 一处装配）。 */
export interface RestartHost {
  /** 四道闸 + marker 的取数面（`restart.ts` 的注入形状）。 */
  readonly ports: RestartPorts
  readonly approval: RestartApprovalPort
  readonly launch: RelaunchPort
  readonly exit: RestartExitPort
  /**
   * 探一个路径存不存在（用来判 `wscript.exe` 在不在）。
   *
   * **为什么是注入面而不是直接 `existsSync`**：这是**平台相关判据** —— CI 是 ubuntu、
   * 本机是 Windows，直接判真机平台会让两条分支里总有一条在某个环境上永远跑不到
   * （本仓纪律：平台相关判据要能显式钉住分支，见 `test/AGENTS.md`）。注入之后，
   * 「隐藏启动器在」与「回退到 cmd」两条分支在**任意**平台上都能被真跑到。
   */
  readonly pathExists: (path: string) => boolean
}

/**
 * 本工具的运行期依赖。
 *
 * 与 `dsh_hot_reload` 同一个范式：写侧/行动类工具**在自己的文件里**扩 `ToolDeps`，
 * 而不是往 `shared.ts` 那份冻结形状里塞 —— 只读工具们的依赖面因此一点没变。
 */
export interface RestartToolDeps extends ToolDeps {
  readonly restart: RestartHost
}

/**
 * 本工具的描述（SHAPE §2.1 四段骨架，段序不许换）。
 *
 * 逐段理由：
 * - `what`：动词 + 对象，并点明它**跨不到另一个实例**（那是它与「文件型工具」的分界，
 *   也是唯一会让人事后吃亏的地方：重启只作用于本进程所在的宿主）。措辞从
 *   `cannot reach another instance` 压成 `not another instance`（2026-10-16）—— 事实没变，
 *   只是为了给边界段的第四件事实腾字符（B20a 的 240 字符上限）。
 * - `useWhen`：路由信号 —— 「某个改动需要重启」。协作纪律（先问 `dsh_check_effect_mode`）
 *   写在 SKILL 正文里，描述层不复述。
 * - `boundary`：**四件执行前必须知道、且调用结果里学不到的事**：① `ask` 档会弹窗、
 *   `never` 档不问（读档位再决定问不问）；② **只有 Windows 上有已实测的拉起路线** ——
 *   非 win32 上 `launchCommandFrom` 与 `relaunchViaTaskScheduler` 两处都会拒绝；③ **桌面宿主
 *   一律被拒**（2026-10-15 真机缺陷之后新增的那一档）—— 这里写的**不是**「暂时不支持」，
 *   而是结构事实：插件侧没有重启通道，只有 Electron 壳自己 `app.relaunch()`，而且
 *   `dsh --profile desktop` 被命令行**无条件拒绝**。所以模型该在**调用之前**就知道这条路
 *   走不通（真机那次事故正是「先拼出一条命令、宿主退出、没人回来」）；
 *   ④ 写状态还要过**文件沙箱档**（与审批档互相独立）。四条都是事实，不是承诺。
 * - `cost`：行动类的三件事 —— **不可逆**、有 `dryRun` 可预览、`force` 只覆盖闸②。
 */
export const RESTART_DESCRIPTION: ToolDescription = {
  what: 'Restarts this host, not another instance.',
  useWhen: 'Use when a change needs a restart.',
  // 四件事实的顺序即「模型最可能撞上的顺序」：审批窗 → 平台 → 载体 → 沙箱。
  // ⚠️ 「Windows only」这句现在与下一句**成对读**：**已实测的路线**只在 Windows 上、
  // 且只在**命令行载体**上；桌面宿主在任何平台都被拒（下一句）。
  boundary:
    'ask prompts, never auto-runs; Windows only; Desktop hosts are refused; the write needs the file sandbox.',
  cost: 'Irreversible; dryRun previews; force: busy gate only.',
}

/**
 * 参数描述（B20a：只判**下界** —— 每个非空、合计 > 0）。
 *
 * 「`force` 只覆盖闸②」这条**在参数上**说一次（它是这个参数的语义本身），
 * 工具描述里也说一次（它是执行前必须知道的约束）—— 两处措辞不同，不是复述输出。
 */
const PARAMETERS = {
  reason: {
    type: 'string',
    required: true,
    description: 'Why the host must restart; recorded verbatim in the marker',
  },
  delayMs: {
    type: 'number',
    description: 'Grace before the new process starts, in ms (default 10000)',
  },
  dryRun: {
    type: 'boolean',
    description: 'Check the gates and stop: write, relaunch and exit nothing',
  },
  force: {
    type: 'boolean',
    description: 'Override the busy gate only; the other three still refuse',
  },
} as const

/**
 * `key`：下一个决定可能要用到的原料（SHAPE §5 的判据 —— 模型看不到它，会不会换下一步）。
 *
 * 全部字段**可选**，缺省就不印：`key` 是「这次知道了什么」，不是一张填满的表。
 * 失败分支也一样 —— 没走到那一步就不许拿默认值冒充（`markerWritten: false` 与
 * 「压根没到写 marker 那一步」是两件事）。
 */
export interface RestartKey {
  /** 走到哪一步了。 */
  stage: RestartStage
  /** 被哪道闸拒（只有拒绝时出现）。 */
  gate?: GateId
  /** 拒绝码（闭集，与闸一一对应）。 */
  code?: RefusalCode
  /** 拒绝之前已经过了的闸（「走到了哪一步」比「四道闸」更准）。 */
  gatesPassed?: readonly GateId[]
  /** 审批档与结论（例如 `not-required (policy=never)`）。 */
  approval?: string
  /** 会跑的那条**目标**命令行（模型可复核：新宿主以什么参数起来）。 */
  relaunch?: string
  /**
   * 隐藏启动器脚本的落点（只有走 `wscript` 形态时出现）。
   *
   * 印出来是为了**可拦**：脚本写坏就静默不启动，所以「它到底跑了没有」得有个可查的文件。
   * 回退形态（`wscript.exe` 不在）下没有这一格 —— 那种形态会创建一个可见控制台。
   */
  launcher?: string
  /** 启动器自己的日志落点（与 `launcher` 同进同出）：失败与「还没到点」靠它分开。 */
  launcherLog?: string
  /**
   * 拉起形态：**只在回退形态下出现**。
   *
   * 缺省 = 走 `wscript` 隐藏 shim（零窗口活动）。出现 `console-fallback` = 这台机器上
   * `wscript.exe` 不在（VBScript 是 Windows 11 24H2 起可按需移除的功能），于是计划任务
   * 直接跑 `node`，会**闪一个可见控制台**。这一格存在的唯一理由是让模型/人知道这次会闪。
   */
  launcherMode?: 'console-fallback'
  /**
   * 可见停止窗口脚本的落点（只有走 `wscript` 形态时出现）。
   *
   * 这个窗口是新宿主的**停止入口**：新宿主没有控制台（隐藏启动器把控制台省掉了），
   * 而控制台原本就是用户唯一能停掉它的地方。窗口按端口绑宿主，关掉窗口或按 Ctrl+C
   * 都由 Windows Job Object 的 `KILL_ON_JOB_CLOSE` 终结宿主 —— 见 docs/SHAPE.md。
   */
  stopWindow?: string
  /** 停止窗口自己的日志（与 `stopWindow` 同进同出）：绑不上 / 建不出 job 时唯一留痕。 */
  stopWindowLog?: string
  /**
   * 交给 `schtasks /tr` 的那条调用 —— **只在它超限被拒时出现**。
   *
   * 为什么不是常驻字段：平时它对模型没有信息量（模型要复核的是**目标命令**，走 `relaunch`），
   * 而超限时它是唯一能据以判断「该缩短哪个路径」的东西。
   */
  launcherCommand?: string
  /** marker 的落点。 */
  marker?: string
  /** marker 真的落盘了吗（只有走到那一步才印）。 */
  markerWritten?: boolean
  /** 这次是演练。 */
  dryRun?: true
  /**
   * 这次调用是在什么载体上跑的（`cli` / `desktop-host` / `unknown`）。
   *
   * **L2 里只在不是 `cli` 时印**（照 `restartEnabled` 只在为假时印的先例）：
   * `cli` 是默认路径、没有信息量，而 `desktop-host` / `unknown` 正是「为什么被拒」那一格
   * —— 模型要对上闸④的 `no-relaunch-route` 就得看得见它。
   */
  carrier?: CarrierKind
  /** 这次覆盖了闸②（留痕）。 */
  forced?: true
  /** 写 marker 用的文件沙箱档位。 */
  sandbox?: string
  /**
   * 这次调用看到的总闸档位（**只在被拒的那一格出现**）。
   *
   * 为什么必须单列而不是并进 `stage`：被配置禁用与被四道闸拒**都**是
   * `stage: 'gates'`，而两者的下一步完全不同（一个要改配置、一个等冷却）。
   * 只报 `stage` 就是让模型从「不知道」里猜 —— 而 L2 是它唯一能读的那一层。
   */
  restartEnabled?: boolean
  /** 这次调用实际用的是哪份配置。 */
  resolved?: EffectiveConfigBlock
}

/** 输出表：L1 就是 `data.verdict` 逐字，L2 由 `key` 投影成行。 */
const TABLE: RenderTable<RestartKey> = { key: (data) => keyText(data.key) }

/**
 * 造工具。
 *
 * @param deps 运行期依赖。
 */
export function createRestartTool(deps: RestartToolDeps): ToolDefinition {
  return defineTool({
    name: RESTART_TOOL,
    description: composeDescription(RESTART_DESCRIPTION),
    parameters: PARAMETERS,
    output: toolOutput(RESTART_TOOL, TABLE),

    timeoutMs: toolBudgetMs(WORKLOAD, deps.config),
    // 两次并发重启会把 marker 与闸①的历史交叉在一起 —— 不安全。
    isConcurrencySafe: () => false,

    async execute(rawArgs, exec) {
      // 走到哪一步了 —— 兜底分支要按**最近到达**的那一步报，而不是恒报 'gates'（复核抓到）。
      let stage: RestartStage = 'gates'
      try {
        const config = deps.config
        // 载体是 `apply()` 探过**一次**的进程级事实（`ToolDeps.carrier`）。它有两处消费者：
        // 闸④的路线判据，以及 `audit` 里给人复核的投影 —— 两处必须读**同一份**。
        const carrier = deps.carrier
        // 可无损落 JSON 的审计投影（`profile` 取不到时整个键不印，见 `carrierAuditOf`）。
        const carrierAudit = carrierAuditOf(carrier)

        // ── ⓪ 总闸（插件配置 `enableRestart`，**默认关**）──────────────────────
        // 刻意放在**一切之前**，连参数解析与四道闸都不碰：这一格要能说清
        // 「零写 marker、零拉起、零调退出」，而那三个计数**只可能**由
        // 「一行都没往下走」保证 —— 任何「先做一点再拒绝」都会让其中之一非零。
        //
        // ⚠️ **不许改成「关着就不注册」**（维护者 2026-10-15 拍板）：模型看到
        // 「这个插件不提供 `dsh_restart`」会去另想办法重启、甚至直接让用户手动重启
        // ⇒ 风险不降反升且不可控；而「工具静默消失」正是本仓
        // 「别把不知道印成结论」那一族。所以它**必须明说自己被挡住了**。
        if (deps.config.enableRestart.get() !== true)
          return toOutput(disabledByConfig(config, carrier))

        const emptyHome = assertResolvedDshHome(config)
        if (emptyHome !== undefined) return toOutput(emptyHome)

        const parsed = parseRestartArgs(rawArgs, carrier)
        if (!parsed.ok) return toOutput(parsed.failure)

        const session = callingSessionOf(exec)
        if (session === '') {
          return toOutput(
            fail(
              {
                kind: 'not-configured',
                message: 'the calling session id is unavailable',
              },
              {
                verdict:
                  'nothing was restarted: this call carries no session id, so the tool cannot tell the caller apart from the sessions a restart would interrupt',
                key: { stage: 'gates', carrier: carrier.kind, resolved: effectiveConfig(config) },
                audit: { carrier: carrierAudit },
              },
              {
                // ⚠️ 原话是「换一个带 session id 的会话再调」—— **模型无法选择自己在哪个会话**
                // ⇒ 重试必然同样失败。改成**人**的动作（O3）。
                manual: true,
                why: 'ask the user to retry from a session that has a session id, so the busy gate can exempt that session; this tool cannot choose the session it runs in',
              },
            ),
          )
        }

        const budget = toolBudgetMs(WORKLOAD, config)
        const deadline = createDeadline(budget, deps.now)
        const request: RestartRequest = {
          dshHome: config.dshHome,
          reason: parsed.reason,
          callingSession: session,
          force: parsed.force,
          // 第一段永远是演练：闸门与 marker 收在同一个入口里，先探再落盘。
          dryRun: true,
          // 闸④的第一问就是它 —— 桌面宿主在这一步**动手前**被拒（真机缺陷的根因）。
          carrier,
        }

        // ── ① 四道确定性闸门（dryRun，不落盘）────────────────────────────────
        const probe = await planRestart(request, deps.restart.ports)
        if (probe.kind === 'refused') return toOutput(refusalResult(probe, config, carrier))
        if (probe.kind === 'failed') {
          return toOutput(planFailureResult(probe, config, 'gates', carrier))
        }

        const planned = relaunchPlanOf(
          probe.launch,
          config,
          parsed.delayMs,
          process.pid,
          deps.restart.pathExists,
          // 端口的环境线索走**注入面**（与另外三个工具一致）。直接用 `process.env`
          // 会让这条判据在本机与 CI 上说两种话（本机有 DSH_WEB_URL、CI 没有）。
          deps.env,
        )
        const base = {
          gatesPassed: gatesPassedOf(probe),
          marker: probe.markerPath,
          // `relaunch` 印**真正会跑的目标命令**（不是 `/tr` 那条启动器调用）：
          // 模型要复核的是「新宿主会以什么参数起来」，而启动器路径另有 `launcher` 一行。
          relaunch: planned.target,
          launcher: planned.jobPath,
          launcherLog: planned.logPath,
          ...(planned.hidden ? {} : { launcherMode: 'console-fallback' as const }),
          stopWindow: planned.stopWindowPidPath,
          stopWindowLog: planned.stopWindowLogPath,
          sandbox: SANDBOX_MODE,
          resolved: effectiveConfig(config),
          carrier: carrier.kind,
          ...(probe.marker.force === true ? { forced: true as const } : {}),
        }

        // ── ② 两条「纯取值」的先决条件：都在**动手之前**判（零写、零拉起）────────
        // 顺序是判据（文件头第 0 条）：这两条不落盘、不拉起，所以它们与四道闸同属
        // 「动手前先拒」。反了就是「拉起已经发生、verdict 却说没开始」⇒ 双宿主。
        const lineProblem = commandLineLengthProblem(planned.commandLine)
        if (lineProblem !== undefined) {
          return toOutput(
            fail(
              { kind: 'not-configured', message: lineProblem },
              {
                verdict: `nothing was written and nothing was relaunched: ${lineProblem}, and this tool refuses before touching the disk because the task scheduler would only fail later with an opaque argument error`,
                key: {
                  ...base,
                  stage: 'gates',
                  // 超的是**这一条**（`/tr` 的值）——它平时不进 `key`（冗长且对模型无用），
                  // 但拒绝时它是模型唯一能据以缩短路径的东西。
                  launcherCommand: planned.commandLine,
                },
                audit: {
                  commandLine: planned.commandLine,
                  commandLineChars: planned.commandLine.length,
                  limit: SCHTASKS_TR_MAX_CHARS,
                  carrier: carrierAudit,
                },
              },
              {
                manual: true,
                why: 'shorten the path this host runs from (or the $DSH_HOME) so the relaunch command line fits the task scheduler limit, then call again',
              },
            ),
          )
        }

        // `exit()` 是**纯取值、无副作用** ⇒ 它的可达性也必须在这里判完（见文件头第 0 条）。
        const exit = deps.restart.exit.exit()
        if (exit === undefined) {
          return toOutput(
            fail(
              {
                kind: 'not-configured',
                message: 'the launcher provides no appExit channel',
              },
              {
                verdict:
                  'nothing was written and nothing was relaunched: the launcher provides no appExit channel, so this process could not exit cleanly after the relaunch, and this tool never calls process.exit',
                key: { ...base, stage: 'gates' },
                audit: { appExit: 'unavailable', carrier: carrierAudit },
              },
              {
                manual: true,
                why: 'restart the host yourself; nothing was written, so there is no armed marker to explain afterwards',
              },
            ),
          )
        }

        // ── ③ 演练：到这里就结束（不问审批、不落盘、不拉起、不退出）──────────
        if (parsed.dryRun) {
          return toOutput(
            ok(
              {
                verdict:
                  'dry run: all four gates passed, and nothing was written, relaunched or exited',
                key: {
                  ...base,
                  stage: 'dry-run',
                  dryRun: true,
                  markerWritten: false,
                  approval: 'not-asked (dry run)',
                },
                audit: { reason: parsed.reason, delayMs: parsed.delayMs, carrier: carrierAudit },
              },
              {
                // ⚠️ 这一支**不指向工具**（B1）：原话给的是 `dsh_check_effect_mode({change:'config'})`，
                // 而那个工具 (a) 参数里**没有** `dryRun`、(b) 是只读分类工具、**不会停任何宿主**；
                // 而且 `change: 'config'` 是**硬编码**的 —— 本工具根本没有 `change` 参数，
                // 演练时它**不知道**这次改动是哪一类，那是「把不知道印成结论」。
                // 正确的下一步是**再调一次本工具**（去掉 dryRun），而那要带 `reason`，
                // 它此刻只在 `audit` 里 ⇒ 指工具支会被 B17 判红 ⇒ 用 `manual` 支。
                manual: true,
                why: 'call dsh_restart again without dryRun once you accept the restart; it will stop this host',
              },
            ),
          )
        }

        // ── ④ 审批门（**只在这时才问**：闸门全过 = 真的会执行）──────────────
        stage = 'approval'
        const approval = await resolveApproval(deps, exec, parsed.reason)
        if (!approval.granted) return toOutput(approval.failure)

        // ── ⑤ 真正落盘（marker 必须在拉起之前写完）────────────────────────────
        stage = 'marker'
        const plan = await planRestart({ ...request, dryRun: false }, deps.restart.ports)
        if (plan.kind === 'refused') {
          // 刚探过、同一个入口，闸门不会在这里翻面；翻了说明两层不同意同一套规则。
          return toOutput(
            internalFailure(
              new Error(`the gates refused on the second pass: ${plan.gate}`),
              'the restart was not started: the gate check disagreed with itself between the probe and the real pass',
              config,
              'gates',
              carrier,
            ),
          )
        }
        if (plan.kind === 'failed') {
          return toOutput(planFailureResult(plan, config, 'marker', carrier))
        }
        if (!plan.markerWritten) {
          return toOutput(
            internalFailure(
              new Error('planRestart returned ready without writing the marker'),
              'the restart was not started: the marker was not written, and nothing may be relaunched before it is',
              config,
              'marker',
              carrier,
            ),
          )
        }

        const markerKey = {
          ...base,
          stage: 'marker' as const,
          marker: plan.markerPath,
          markerWritten: true,
          approval: approval.label,
        }

        // ── ⑥ 拉起新进程（计划任务；失败 ⇒ 可诊断的结构化失败）────────────────
        stage = 'relaunch'
        // 作业文件必须在拉起**之前**落盘：`/tr` 只指向它，文件不在就是「任务跑了、什么都
        // 没起」。写失败按「拉起没发生」收敛（marker 仍在盘上，可解释）。
        //
        // 为什么不再先写两个脚本：脚本现在是仓里的**静态资产**（`assets/`，可进 CI 校验），
        // 这里只写「这次拉起的动态值」—— 一个 `key=value` 的作业文件。
        try {
          await deps.restart.ports.fs.write(planned.jobPath, planned.jobText)
        } catch (error) {
          return toOutput(
            fail(
              {
                kind: 'command-failed',
                message: `the launcher job file could not be written (${messageOf(error)})`,
              },
              {
                verdict: `nothing was relaunched: the launcher job file at ${planned.jobPath} could not be written (${messageOf(error)}), so the scheduled task would have had nothing to run; this host keeps running and the marker is left armed`,
                key: markerKey,
                audit: {
                  launcher: planned.jobPath,
                  launcherLog: planned.logPath,
                  stopWindowLog: planned.stopWindowLogPath,
                  markerPath: plan.markerPath,
                  reason: parsed.reason,
                  carrier: carrierAudit,
                },
              },
              {
                manual: true,
                why: 'restart the host yourself when convenient (it is still running); the marker is left armed so the next startup can report that this restart never completed',
              },
            ),
          )
        }
        const relaunched = await deps.restart.launch.relaunch({
          command: planned.command,
          args: planned.args,
          cwd: planned.cwd,
          commandLine: planned.commandLine,
          delayMs: parsed.delayMs,
          budgetMs: budgetFor(budget, deadline),
          signal: exec.signal,
        })
        if (!relaunched.ok) {
          return toOutput(
            fail(
              { kind: 'command-failed', message: `the relaunch failed: ${relaunched.reason}` },
              {
                // 「marker 在、新进程没起来」必须说清：下次启动仍能看到这份 marker。
                verdict: `nothing was relaunched: the marker is on disk, so this host keeps running and the next startup will still see an unconsumed restart marker (${relaunched.reason})`,
                key: markerKey,
                audit: {
                  relaunch: relaunched.reason,
                  markerPath: plan.markerPath,
                  reason: parsed.reason,
                  carrier: carrierAudit,
                },
              },
              {
                // ⚠️ 原话是「start the host again yourself」—— 与上面那句 verdict 的
                // 「this host keeps running」**打架**，模型很可能转述成「宿主已经没在跑了」（S3）。
                manual: true,
                why: 'restart the host yourself when convenient (it is still running); the marker is left armed so the next startup can report that this restart never completed',
              },
            ),
          )
        }

        // ── ⑦ 本进程退出（**在 marker 写完之后**，且不经过 `process.exit`）──────
        // 通道在 ② 就取好了（取不到时什么都没发生）—— 这里只负责调它。
        //
        // ⚠️ **退出必须排在本工具的结论之后**（2026-10-14 真机闭环实测的真缺陷）：
        // 原先这里直接 `exit(0)`、下面才 `return` 结果 —— 于是那句 verdict **永远落不了盘**，
        // 会话日志里只剩一条「结果未持久化」的合成行（`interrupted-tool-result-…`），
        // 模型对一次**不可逆**动作拿到的是 `outcome unknown`：既不知道四道闸过没过、
        // 也不知道 marker 在不在、更不知道新宿主会不会起来。而它正是本工具 dry-run 的
        // `nextStep` 明确指引模型来做的那一步。
        //
        // 改成排到**下一个宏任务**：交付结果走的是 Promise 链（微任务），微任务先于宏任务
        // 排空 ⇒ 结论先到、退出后到。这不削弱台账 §2.6 的顺序保证：marker 早已 `await`
        // 写完（上一步），而 `appExit` 的语义是「等树 dispose 完再退」，`beforeExit` 还要等
        // 事件循环排空（E11 实测：调用 → disposer +102/112/114 ms → beforeExit +19/21/25 ms；
        // E12 的 5 s 是硬上限，足够一次日志写入落地）。
        stage = 'exit'
        setImmediate(() => {
          exit(0)
        })

        return toOutput(
          ok({
            verdict: `the restart is under way: 4/4 gates passed, approval ${approval.label}, the marker is on disk, the relaunch is scheduled (${String(parsed.delayMs)} ms), and this process is exiting`,
            key: { ...markerKey, stage: 'exit' },
            audit: {
              relaunch: relaunched.detail,
              markerPath: plan.markerPath,
              reason: parsed.reason,
              taskName: TASK_NAME,
              carrier: carrierAudit,
            },
          }),
        )
      } catch (error) {
        return toOutput(
          internalFailure(
            error,
            'the restart was not started: an unexpected error stopped the restart before it completed',
            deps.config,
            stage,
            // `carrier` 那个局部量声明在 `try` 里，catch 作用域看不到它 ——
            // 读的是**同一个** `deps.carrier`（本工具从不改它），不是第二份观测。
            deps.carrier,
          ),
        )
      }
    },
  })
}

// ── 参数 ───────────────────────────────────────────────────────────────────

/** 解析后的参数。 */
type ParsedArgs =
  | { ok: true; reason: string; delayMs: number; dryRun: boolean; force: boolean }
  | { ok: false; failure: ToolFail }

/**
 * 解析参数（**不抛**；不合法就返回结构化失败）。
 *
 * 三条纪律：
 * - `reason` 是**必填**且逐字进 marker —— 空串等于「没写为什么」，那是事后审计唯一读不到的东西；
 * - `delayMs` 只接受**有限非负**数，其余（NaN / 负 / 非数字）退回默认值 —— 它不改变
 *   「做不做」，只改变「多快」；
 * - `dryRun` / `force` 只认**字面 `true`**（`'yes'` 那种字符串不当真）。
 *
 * @param rawArgs 宿主给的原始参数。
 * @param carrier 载体观测（只进 `audit` 的投影 —— 这一格与载体无关，但审计要同形）。
 */
function parseRestartArgs(rawArgs: unknown, carrier: CarrierObservation): ParsedArgs {
  const args = (typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : {}) as Record<
    string,
    unknown
  >
  const reason = typeof args['reason'] === 'string' ? args['reason'].trim() : ''
  if (reason === '') {
    return {
      ok: false,
      failure: fail(
        { kind: 'not-configured', message: 'the "reason" argument is missing or empty' },
        {
          verdict:
            'nothing was restarted: no reason was given, and the reason is what the next startup reports back to the user',
          // ⚠️ `audit` 要**可无损落 JSON**（B26）：`typeof` 的结果是字符串，可以直接落；
          // 而 `args['reason']` 本身可能就是函数 / 活对象 —— 印它等于把一次硬失败交给宿主。
          key: { stage: 'gates' },
          audit: { receivedReason: typeof args['reason'], carrier: carrierAuditOf(carrier) },
        },
        { manual: true, why: 'call again with a short reason for the restart' },
      ),
    }
  }
  const rawDelay = args['delayMs']
  const delayMs =
    typeof rawDelay === 'number' && Number.isFinite(rawDelay) && rawDelay >= 0
      ? Math.floor(rawDelay)
      : DEFAULT_DELAY_MS
  return {
    ok: true,
    reason,
    delayMs,
    dryRun: args['dryRun'] === true,
    force: args['force'] === true,
  }
}

/**
 * 取这次调用所在的会话 id（取不到返回空串，由调用方判失败）。
 *
 * `Agent.id` 与 `Session.id` 是同一个运行期键（`agents.get(sessionId)` 就是按它取），
 * 所以两个都试；`normalizeSessionId` 在闸②里补 `session-` 前缀，本层**照实回报**。
 *
 * @param exec 工具运行上下文。
 */
function callingSessionOf(exec: ToolRunContext): string {
  const agent = exec.agent as unknown as { id?: unknown; session?: { id?: unknown } } | undefined
  if (agent === null || agent === undefined) return ''
  const id = agent.id ?? agent.session?.id
  return typeof id === 'string' ? id : ''
}

// ── 审批 ───────────────────────────────────────────────────────────────────

/** 审批门的结果。 */
type ApprovalDecision = { granted: true; label: string } | { granted: false; failure: ToolFail }

/**
 * 审批门：**先读档位，再决定问不问**。
 *
 * 三格（与 SHAPE §6.1 的表一一对应）：
 * - `ask` ⇒ 调官方审批门，**只有 `allowed-once` 算允许**；
 * - `never` ⇒ **不问、直接执行**（在那一档主动去问**必然被拒**，那会把「你什么都授权了」
 *   变成「什么都不许做」）；
 * - 读不出来 ⇒ **fail-closed**，且说清「无法确定审批档位」。
 *
 * @param deps 运行期依赖。
 * @param exec 工具运行上下文（要 `agent`）。
 * @param reason 给审批弹窗看的那句话。
 */
async function resolveApproval(
  deps: RestartToolDeps,
  exec: ToolRunContext,
  reason: string,
): Promise<ApprovalDecision> {
  const policy = deps.restart.approval.policyOf(exec.agent)
  if (policy === undefined) {
    return {
      granted: false,
      failure: fail(
        {
          kind: 'not-configured',
          message: 'the approval policy could not be read',
        },
        {
          verdict:
            'nothing was restarted: the approval policy could not be determined, and this tool does not treat an unknown policy as authorization',
          key: { stage: 'approval', approval: 'unreadable' },
          // 载体只管闸④，但审计块所有分支同形（复核时不必猜「这一格为什么没有它」）。
          audit: { carrier: carrierAuditOf(deps.carrier) },
        },
        {
          manual: true,
          why: 'confirm the approval service is loaded in this profile, then call again; an unknown policy is a refusal by design',
        },
      ),
    }
  }
  if (policy === 'never') {
    return { granted: true, label: 'not-required (policy=never)' }
  }

  let outcome: RestartApprovalOutcome
  try {
    outcome = await deps.restart.approval.request(exec.agent, reason, exec.signal)
  } catch (error) {
    // 宿主在「没有打开的回合」上会抛 —— 那同样是「没拿到许可」，不是「可以做了」。
    outcome = 'unavailable'
    void error
  }
  if (outcome === 'allowed-once') {
    return { granted: true, label: 'allowed-once' }
  }
  // ⚠️ `unavailable` 有**四种**来源：服务缺席 / `request` 抛异常 / 返回非闭集值 /
  // 宿主真的答了 `unavailable`。前三种**没有 resolve 出任何值** ⇒ 说「the approval request
  // resolved "unavailable"」比事实肯定（S4 的附带项）。改成一个把两种都盖住的措辞。
  const answered =
    outcome === 'unavailable'
      ? 'the approval gate answered "unavailable" (or could not be reached)'
      : `the approval request resolved "${outcome}"`
  return {
    granted: false,
    failure: fail(
      {
        kind: outcome === 'unavailable' ? 'not-configured' : 'cancelled',
        message: answered,
      },
      {
        verdict: `nothing was restarted: ${answered}, and only "allowed-once" counts as permission`,
        key: { stage: 'approval', approval: outcome },
        audit: { carrier: carrierAuditOf(deps.carrier) },
      },
      approvalRemedy(outcome),
    ),
  }
}

/**
 * 审批没通过时给模型的下一步 —— **按 `outcome` 分岔**（S4）。
 *
 * ⚠️ `cancelled` 与 `rejected` 原先是**同一句**「ask the user to approve the restart, then
 * call again」—— 而 `cancelled` 是用户在弹窗上**取消**了（没有说「不」）⇒ 同一句会让模型
 * 立刻再弹一次。`rejected` 是明确的拒绝，`cancelled` 是没回答，两者必须分开。
 *
 * @param outcome 审批门的结论（`allowed-once` 不走这里：调用方在那之前就返回了）。
 */
function approvalRemedy(outcome: Exclude<RestartApprovalOutcome, 'allowed-once'>): NextStep {
  switch (outcome) {
    case 'unavailable':
      return {
        manual: true,
        why: 'no approval answerer is reachable in this profile; the restart needs a policy that can actually grant it',
      }
    case 'cancelled':
      return {
        manual: true,
        why: 'the user dismissed the approval prompt without answering; ask again only if the restart is still wanted, then call again',
      }
    case 'rejected':
      return { manual: true, why: 'ask the user to approve the restart, then call again' }
  }
}

// ── 总闸（配置开关） ───────────────────────────────────────────────────────

/**
 * 被配置禁用时的结构化拒绝（维护者 2026-10-15 拍板的默认关那一支）。
 *
 * ## 为什么走 `fail(...)` 而不是 `ok(...)`
 *
 * SHAPE §6.1 写「**闸门拒绝不是失败**」，而这一格**不是闸门**：
 * 闸门是「这套规则下这次不该做」，而这一格是「这个动作现在根本不由本工具提供」——
 * 模型该做的是**改配置**，不是把坏消息转述给用户。所以用既有的 `fail` 那一族，
 * `kind: 'not-configured'`（闭枚举里已有的：配置不足以执行 ⇒ 先补配置）。
 * ⇒ **不是第四种结果形状**：`{ verdict, key, audit }` 顶层仍恰好三键，与既有失败路径同形。
 *
 * ## 文本的三条纪律
 *
 * 1. **明确**：说清「现在被配置挡住了」，并把字段名**逐字**带出去（用户照着改得动）；
 * 2. **简洁**：两句，不铺陈；
 * 3. **不解释原因**（维护者原话：「明确简洁告知怎么打开，不用写什么原因」）——
 *    所以 L1 与 `nextStep.why` 都**不写**为什么默认关。
 *
 * ⚠️ **不许出现「配置页 / settings card」**：本仓**没有**设置卡片（README 两语的门面
 * 都写着「这几个字段属于插件在 profile 组合里的配置」）。指向一个不存在的 UI
 * 就是本仓最重的那一类缺陷（说了但不可兑现）。
 *
 * @param config 生效配置（已解析；`enableRestart` 必填，默认关）。
 * @param carrier 载体观测（进 `audit`；**不猜**：它由 `apply()` 探过一次）。
 */
function disabledByConfig(
  config: ResolvedConfig,
  carrier: CarrierObservation,
): ToolFail<RestartKey> {
  return fail(
    {
      kind: 'not-configured',
      message: `dsh_restart is disabled by the plugin config field ${RESTART_CONFIG_FIELD}`,
    },
    {
      verdict: `nothing was restarted: ${RESTART_TOOL} is switched off (${RESTART_CONFIG_FIELD}), and it stays registered so it can say so`,
      key: { stage: 'gates', restartEnabled: false, resolved: effectiveConfig(config) },
      audit: {
        configField: RESTART_CONFIG_FIELD,
        default: false,
        carrier: carrierAuditOf(carrier),
      },
    },
    {
      // `manual` 支：**只有人**能改插件配置（模型改不动 —— 与 `timeoutMs` 那一族同一条
      // 纪律，`dsh_check_effect_mode.ts` 里已有先例），所以这一格必须走人动作。
      //
      // ⚠️ 措辞要求（维护者 2026-10-15 指出旧版有歧义后改写）：
      // - **指到真实存在的地方**：本插件在 Plugins 页有一张设置卡片（`dsh.client` 已落地，
      //   槽 `plugins.bundle.config` 里注册过、真机验过），所以「去那张卡片打开」是**可兑现**的；
      // - **不许再写「then restart the host」**：那张卡片写下去立刻生效（字段是 `.volatile()`，
      //   **真机验过**：拨开之后同一个工具立刻从拒绝变成四道闸全过、没有重启）。旧版这句
      //   与卡片自己的「改动立即生效，不需要重启」直接打架 —— 两处事实互相矛盾。
      manual: true,
      why: `ask the user to turn on ${RESTART_CONFIG_FIELD} for this plugin on the Plugins page, then call this tool again`,
    },
  )
}

// ── 结果映射 ───────────────────────────────────────────────────────────────

/**
 * 闸门拒绝 → 工具结果。
 *
 * **`ok: true`**：SHAPE §6.1 写死「**拒绝不是失败**：闸门拒绝是设计的一部分，模型应原样
 * 报给用户」。工具这次的操作**完成了**（它正确地判了「不该做」），只是结论是坏消息 ——
 * 契约里 `ok` 只描述操作有没有完成，不描述系统健不健康。
 *
 * `carrier` **必须从调用点传进来**（不从 `deps` 里现读一份）：闸④的结论就是它给的，
 * 「判据用的那份」与「印给模型看的这份」必须是同一个观测 —— 两处各读一次就会出现
 * 「拒绝理由说 desktop、`key.carrier` 印 cli」这种事后无法复核的自相矛盾。
 *
 * @param refusal 计划层的拒绝。
 * @param config 生效配置。
 * @param carrier 载体观测（进 `key` 与 `audit`）。
 */
function refusalResult(
  refusal: RestartPlanRefused,
  config: ResolvedConfig,
  carrier: CarrierObservation,
): ToolResult<RestartKey> {
  const nextStep: NextStep =
    refusal.suggestedTool === undefined
      ? { manual: true, why: refusal.remedy }
      : refusal.suggestedTool === DUMP_CONFIG_TOOL
        ? {
            tool: DUMP_CONFIG_TOOL,
            args: { profile: config.profile },
            why: refusal.remedy,
          }
        : { tool: refusal.suggestedTool, why: refusal.remedy }
  return ok(
    {
      verdict: refusal.verdict,
      key: {
        stage: 'gates',
        gate: refusal.gate,
        code: refusal.code,
        gatesPassed: refusal.gatesPassed,
        resolved: effectiveConfig(config),
        carrier: carrier.kind,
      },
      audit: {
        evidence: [...refusal.evidence],
        remedy: refusal.remedy,
        carrier: carrierAuditOf(carrier),
      },
    },
    nextStep,
  )
}

/**
 * 计划层自己的意外 → 工具结果（`internal`）。
 *
 * 两种**可诊断**的意外单独说清，其余走通用措辞：
 * - `FS_SANDBOX_DENIED`：写 `$DSH_HOME` 被**文件沙箱**拒了 —— 与审批档无关的第二道门；
 * - 其余：把计划层给的原话带出来（它已经写明「什么都没写」）。
 *
 * @param failure 计划层的失败。
 * @param config 生效配置。
 * @param stage 走到哪一步了。
 * @param carrier 载体观测（进 `audit`；所有失败分支同形）。
 */
function planFailureResult(
  failure: RestartPlanFailed,
  config: ResolvedConfig,
  stage: RestartStage,
  carrier: CarrierObservation,
): ToolFail {
  const sandboxDenied = failure.detail.includes('FS_SANDBOX_DENIED')
  if (sandboxDenied) {
    return fail(
      {
        kind: 'not-configured',
        message: `the marker write was refused by the file sandbox: ${failure.detail}`,
      },
      {
        verdict:
          'nothing was written and nothing was restarted: the file sandbox refused the marker write (FS_SANDBOX_DENIED), and the marker must be on disk before anything may be relaunched',
        key: { stage, sandbox: SANDBOX_MODE, resolved: effectiveConfig(config) },
        audit: { detail: failure.detail, carrier: carrierAuditOf(carrier) },
      },
      {
        manual: true,
        why: "the write to this plugin's own namespace needs the danger-full-access file sandbox; grant it (or run the host with it) and call again",
      },
    )
  }
  return fail(
    { kind: 'internal', message: failure.detail },
    {
      verdict: failure.verdict,
      key: { stage, resolved: effectiveConfig(config) },
      audit: { detail: failure.detail, carrier: carrierAuditOf(carrier) },
    },
  )
}

/**
 * 兜底：`execute` 里任何意外 → 结构化失败（**绝不抛**，B24 的承载条件）。
 *
 * `stage` **由调用点给**：以前这里恒写 `'gates'`，于是「marker 已经写完之后才炸」与
 * 「还没动手就炸」在 `key` 里长得一模一样 —— 而这两件事的下一步完全不同
 * （前者盘上留着 armed marker，后者什么都没发生）。
 *
 * ## ⚠️ 结论也**必须**跟着 `stage` 分岔（B2：这里曾是 stage-blind 的假话）
 *
 * 光让 `key.stage` 报准是不够的：`stage === 'relaunch'` 时**marker 已在盘上、拉起请求已发出**，
 * `stage === 'exit'` 时连 `exit(0)` 都调过了 —— 这时再印一句「the restart was not started」
 * 就是与盘上事实**相反**的假话（L1 说没开始、L2 连 `markerWritten` 都不给 ⇒ 两层一起失明）。
 * 这一族与文件头第 0 条那个「报没开始、其实已拉起」的缺陷同源，是它在兜底分支的漏改落点。
 *
 * @param error 捕获到的异常。
 * @param verdict 给模型看的那句结论（**动手之前**那几格用它）。
 * @param config 生效配置。
 * @param stage 出错时已经走到哪一步。
 * @param carrier 载体观测（进 `audit`；所有失败分支同形）。
 */
function internalFailure(
  error: unknown,
  verdict: string,
  config: ResolvedConfig,
  stage: RestartStage,
  carrier: CarrierObservation,
): ToolFail {
  const message = messageOf(error)
  const startedVerdict = startedButUnreportedVerdict(stage)
  return fail(
    { kind: 'internal', message },
    {
      verdict: `${startedVerdict ?? verdict} (${message})`,
      key: {
        stage,
        resolved: effectiveConfig(config),
        // marker 已经落盘这一格必须进 L2：否则「L1 说没开始」与「盘上有 marker」
        // 这对矛盾从 `key` 里也看不出来。
        ...(startedVerdict === undefined ? {} : { markerWritten: true as const }),
      },
      audit: { error: message, carrier: carrierAuditOf(carrier) },
    },
  )
}

/**
 * 「已经动手之后才炸」那一格的事实句；**动手之前**那几格返回 `undefined`（由调用方用原话）。
 *
 * - `relaunch`：marker 已写完、拉起请求已发出（计划任务可能已经排上）；
 * - `exit`：在那之上，`exit(0)` 也已经调过。
 *
 * ⚠️ 两句都**只陈述已发生的事**，不预测新宿主会不会起来 —— 那是这一层看不到的。
 *
 * @param stage 出错时已经走到哪一步。
 */
function startedButUnreportedVerdict(stage: RestartStage): string | undefined {
  switch (stage) {
    case 'relaunch':
      return 'the restart was started but this call could not report it: the marker is on disk and the relaunch may already be scheduled, so a new host may come up while this one keeps running'
    case 'exit':
      return 'the restart was started but this call could not report it: the marker is on disk, the relaunch was scheduled, and this process has already been asked to exit'
    default:
      return undefined
  }
}

/**
 * 从放行的计划里取「过了哪几道闸」。
 *
 * 计划层放行时**只有** `verdict` 那一句写着 `gates=4/4` —— 不从这里回读文本，
 * 而是用四道闸的**常量**：放行意味着四道全过（`planRestart` 的顺序是判据）。
 *
 * @param plan 放行的计划。
 */
function gatesPassedOf(plan: RestartPlan): readonly GateId[] {
  return plan.kind === 'ready'
    ? ['restart-loop', 'busy-session', 'composition', 'launch-command']
    : []
}

// ── 拉起 ───────────────────────────────────────────────────────────────────

/** 一次拉起的计划（`/tr` 的值 + 作业文件 + 给人看的目标命令）。 */
interface RelaunchPlan {
  command: string
  args: readonly string[]
  cwd: string
  /** 交给 `schtasks /tr` 的**那一条**（隐藏 shim；回退形态下是 node 直跑 launcher.js）。 */
  commandLine: string
  /** 真正会跑的目标命令行（进 `key`，模型可复核）。 */
  target: string
  /** 作业文件的落点（每次拉起都写，内容随实例不同）。 */
  jobPath: string
  /** 作业文件内容（`key=value`，见 `lib/restart.ts` 的 `serializeLauncherJob`）。 */
  jobText: string
  /** 启动器日志的落点。 */
  logPath: string
  /** 走的是隐藏 shim（`wscript`）还是回退形态（`node` 直跑，会闪一个可见控制台）。 */
  hidden: boolean
  /** 停止窗口的 pidfile（单例判据，启动器读它）。 */
  stopWindowPidPath: string
  /** 停止窗口的日志落点。 */
  stopWindowLogPath: string
}

/**
 * 拼出「启动可见停止窗口」的那一条完整命令行。
 *
 * 它最终的消费者是 **VBScript 的 `Shell.Run`**（经 `show-window.vbs`），所以这里用的是
 * 「给 shell 看的」引号规则 —— 与 `quoteArg` 的 cmd 规则不是一回事，两个不能混用。
 *
 * ⚠️ **它只能经作业文件传递，不能当 argv 传给 VBS**：`node` 的 `spawn` 会把参数里的
 * 双引号转义成反斜杠加引号，而 `wscript` 的参数解析器不还原 ⇒ `Shell.Run` 收到一条
 * 带反斜杠的坏命令、静默失败，症状只是「没有窗口」（2026-10-17 真机实测）。
 *
 * @param input 五个落点与端口。
 */
function stopWindowCommandLine(input: {
  powershell: string
  script: string
  port: number
  pidPath: string
  logPath: string
  markerPath: string
}): string {
  const parts = [
    `"${input.powershell}"`,
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    `"${input.script}"`,
    '-Port',
    String(input.port),
    '-PidFile',
    `"${input.pidPath}"`,
    '-LogPath',
    `"${input.logPath}"`,
    '-MarkerPath',
    `"${input.markerPath}"`,
  ]
  return parts.join(' ')
}

/**
 * 把计划层的启动命令变成一个**目录文件 + 一条 `/tr`**，两者都由静态资产承担。
 *
 * ## 为什么不再在运行期拼脚本（2026-10-17 重构）
 *
 * 这一层原来在 TS 里拼出 `relaunch.vbs` 与 `stop-window.ps1` 两个脚本的全文。那两个
 * 字符串**没有任何编译期检查**：写坏了在生成侧完全看不见，症状是「任务跑了、什么都没
 * 起」——本仓最怕的静默坏。现在两个脚本都是仓里的静态资产（`assets/`），能进 CI 校验；
 * 这里只负责写一个 `key=value` 的**目录文件**，把动态值交给它们。
 *
 * ## 分工
 *
 * | 文件 | 谁写 | 职责 |
 * |---|---|---|
 * | `assets/launcher.vbs` | 仓库（静态） | 只当 GUI 子系统那一跳：`wscript` 无控制台 |
 * | `assets/launcher.js` | 仓库（静态） | 全部决策：等旧 pid、起新宿主、确保停止窗口 |
 * | `assets/stop-window.ps1` | 仓库（静态） | 可见停止窗口：持 job 句柄 |
 * | `restart/launch-<port>.job` | 本层 | 上面三个要的动态值 |
 *
 * ## 为什么 `DSH_HOME` 与工作目录不再进命令行
 *
 * 它们变成目录文件里的两个键，由 `launcher.js` 用 `env` / `cwd` 传给新宿主。于是
 * `cmd /c set "DSH_HOME=…" && cd /d … & …` 这一整条（连同它的引号规则）**整体消失**。
 *
 * ## 目标命令仍不经 `/tr`
 *
 * `/tr` 只有 `wscript.exe "<静态 shim>" "<job 文件>"` 三段。原已知限度③（`schtasks`
 * 存储→重放之间的引号保真度未实测）依旧不适用：真正会跑的那条命令不在 `/tr` 里。
 *
 * ## 回退形态（`wscript.exe` 不在时）
 *
 * 计划任务直接跑 `node "<launcher.js>" "<job 文件>"`。`node.exe` 是控制台程序 ⇒
 * **会闪一个可见控制台**，但拉起本身照常成立（等待、无窗口宿主、停止窗口都在 JS 里）。
 * 这一格如实体现在 `key` 的 `launcher` 字段里。
 *
 * @param launch 计划层定出的启动命令。
 * @param config 生效配置。
 * @param delayMs 等待上限（毫秒）—— 不是固定睡眠（见 `assets/launcher.js` 的 `waitForExit`）。
 * @param pid 本进程号：启动器等的就是它消失。
 * @param pathExists 探路径存不存在的谓词（装配处注入 `existsSync`）—— 用来判隐藏启动器在不在。
 */
function relaunchPlanOf(
  launch: LaunchCommand,
  config: ResolvedConfig,
  delayMs: number,
  pid: number,
  pathExists: (path: string) => boolean,
  env: NodeJS.ProcessEnv,
): RelaunchPlan {
  // ⚠️ **不能用 `config.port`**：那个字段默认是 `0`，语义是「自己推断」
  // （`src/config.ts` 的 `port: z.number().default(0)`）。2026-10-17 真机 dry-run 抓到
  // 过这个错 —— 它产出了 `launch-0.job` / `stop-window-0.pid`，窗口会去绑 0 号端口、
  // 永远找不到宿主。真正的端口要经 `resolvePort` 解析（配置 > `DSH_WEB_URL`）。
  //
  // `env` 是**注入**的而不是 `process.env`：本机有 `DSH_WEB_URL`、CI 没有，
  // 直接读进程环境会让行为随机器变（本仓坑 24/25）。
  const resolvedPort = resolvePort(undefined, config.port, env)
  const port = resolvedPort?.port ?? 0

  const logPath = restartLauncherLogPath(config.dshHome)
  const jobPath = restartLauncherJobPath(config.dshHome, port)
  // 停止窗口的三个落点都带端口：两个实例（3080 / 3081）各管各的窗口，互不影响。
  const stopWindowPidPath = restartStopWindowPidPath(config.dshHome, port)
  const stopWindowLogPath = restartStopWindowLogPath(config.dshHome, port)
  const hidden = hiddenLauncherAvailable(pathExists)

  const target = [launch.command, ...launch.args].map(quoteArg).join(' ')
  const jobText = serializeLauncherJob({
    node: process.execPath,
    launcher: launcherScriptPath(),
    log: logPath,
    capMs: delayMs,
    oldPid: pid,
    command: launch.command,
    args: launch.args,
    cwd: launch.cwd,
    dshHome: config.dshHome,
    powershell: powershellPath(),
    wscript: wscriptPath(),
    showWindow: showWindowShimPath(),
    job: jobPath,
    stopWindowCommand: stopWindowCommandLine({
      powershell: powershellPath(),
      script: stopWindowScriptPath(),
      port,
      pidPath: stopWindowPidPath,
      logPath: stopWindowLogPath,
      markerPath: restartMarkerPath(config.dshHome),
    }),
    stopWindow: stopWindowScriptPath(),
    stopWindowPid: stopWindowPidPath,
    stopWindowLog: stopWindowLogPath,
    stopWindowPort: port,
    markerPath: restartMarkerPath(config.dshHome),
  })

  return {
    command: launch.command,
    args: launch.args,
    cwd: launch.cwd,
    target,
    jobPath,
    jobText,
    logPath,
    hidden,
    stopWindowPidPath,
    stopWindowLogPath,
    commandLine: hidden
      ? `${quoteArg(wscriptPath())} ${quoteArg(launcherShimPath())} ${quoteArg(jobPath)}`
      : `${quoteArg(process.execPath)} ${quoteArg(launcherScriptPath())} ${quoteArg(jobPath)}`,
  }
}

/**
 * 命令行里**必须加引号**的 cmd 元字符。
 *
 * 是一个数组而不是正则：正则字面量里那个引号会踩 B14 的 CJK 扫描器（理由见 {@link quoteArg}）。
 */
const CMD_METACHARACTERS = ['&', '|', '^', '<', '>', '(', ')', '"'] as const

/**
 * 命令行参数加引号。
 *
 * 判据是「**含 cmd 元字符或空白就加**」，不只是「含空格」：值里没有空格但有 `&`
 * （例如 `C:\R&D\node.exe`）时，不加引号会让 `cmd` 在 `&` 那里**断开** —— 实测报
 * `'C:\a' is not recognized` / `The system cannot find the path specified.`，
 * 也就是**错起了一条命令**，不是「参数拆错」。`|` `^` `<` `>` `(` `)` 同理。
 *
 * ⚠️ **这里不许用含引号的正则字面量**（例如 `/[\s"]/`）：B14 的 CJK 扫描器逐字符走，
 * 正则里那个引号会让它把后面一大段源码当成字符串字面量，于是**满屏假红**。
 * 判断改用 `includes`，替换改用 `split` + `join`。
 *
 * @param value 一个参数。
 */
function quoteArg(value: string): string {
  if (!needsQuotes(value)) return value
  return `"${value.split('"').join('\\"')}"`
}

/**
 * 一个参数需不需要加引号（含 cmd 元字符或空白）。
 *
 * @param value 一个参数。
 */
function needsQuotes(value: string): boolean {
  for (const metacharacter of CMD_METACHARACTERS) {
    if (value.includes(metacharacter)) return true
  }
  for (const character of value) {
    if (character === ' ' || character === '\t') return true
  }
  return false
}

/**
 * 命令行是不是超过了 `schtasks /tr` 的长度上限（{@link SCHTASKS_TR_MAX_CHARS}）。
 *
 * 为什么在**动手之前**判而不是等 `schtasks` 报错：那一边只会给一句参数错，
 * 而这时 marker 已经落盘、拉起却做不成 —— 又一种「盘上留着 marker 的半成品」。
 *
 * @param commandLine 要逐字交给 `/tr` 的那条命令行。
 */
function commandLineLengthProblem(commandLine: string): string | undefined {
  if (commandLine.length <= SCHTASKS_TR_MAX_CHARS) return undefined
  return `the relaunch command line is ${String(commandLine.length)} characters, over the ${String(SCHTASKS_TR_MAX_CHARS)}-character limit of the task scheduler's /tr value`
}

// ── 宿主接线 ───────────────────────────────────────────────────────────────

/** 宿主 `fs` 服务的最小结构面（与 `restart-fs.ts` 的 `ContextLike` 同形，本层不 import cordis）。 */
interface HostContextLike {
  get?: (name: string) => unknown
  waterfall?: unknown
}

/** `workspace/session-activity` 的一条回答：只声明本层读到的两个字段。 */
type SessionActivityLike = { kind?: unknown; items?: unknown }

/**
 * `workspace/session-activity` 的询问面（**答空 ≠ 没人答**，理由见 {@link waterfallOf}）。
 *
 * `listeners` 与 `ask` 放在一起，是为了让调用方**不可能**只看答案就判「没有活动」——
 * 那正是这个文件里要修的那个缺口。
 */
interface ActivityPort {
  /** 组合里注册了几个该事件的监听者；`undefined` = 监听者表读不出来（**不猜**）。 */
  readonly listeners: number | undefined
  /** 问一次（形状不认识按空数组读；异常由调用方兜）。 */
  ask(request: unknown): Promise<readonly SessionActivityLike[]>
}

/**
 * 把宿主上下文接成 {@link RestartHost}（**唯一的装配点**，`src/tools/index.ts` 调它）。
 *
 * 三条纪律：
 * 1. **`ctx.get('fs')` 每次现取**：`createRestartFsPort` 的 `read` / `write` 内部各自
 *    调一次 `ctx.get`（apply 期拿不到它，+1s 才有 —— `task-31` 实测），本层**不缓存实例**。
 * 2. **`process.platform` 在调用时读**（不在模块顶层读）：平台相关的分支因此可以被
 *    判据用 `withPlatform` 显式钉住（活跃坑 25）。
 * 3. **忙闲三个来源一个都不许漏**：会话回合（`agents.list()` 的 `status`）、
 *    后台作业与定时提醒（`workspace/session-activity` 的 `job` / `schedule` 家族）、
 *    以及无属主的作业（`jobs.list()`）。契约原话见 `docs/HOST-CONTRACTS.md` §2.3：
 *    **后台任务与定时提醒照旧全算（含调用方自己的）**。
 *    ⚠️ **`subagent` 族不单独枚举**：它已被 `agents.list()` 覆盖（证伪过程与依据写在
 *    {@link busySourcesFrom} 的文件注释里）。
 *
 * @param ctx 宿主上下文（结构面，本层不 import cordis）。
 * @param config 生效配置。
 * @param carrier 载体观测（**显式传入**：闸④的结论全靠它，见 `src/tools/index.ts` 的装配注释）。
 * @param spawn 子进程实现（跑 `schtasks` 用）。
 * @param pathExists 探路径存不存在的谓词（**平台相关**：判隐藏启动器在不在）。
 */
export function restartHostFrom(
  ctx: unknown,
  config: ResolvedConfig,
  carrier: CarrierObservation,
  spawn: SpawnImpl,
  pathExists: (path: string) => boolean,
): RestartHost {
  const fs = createRestartFsPort(ctx as HostContextLike, {
    // 显式给档位：默认档写 $DSH_HOME 必被拒（实测见 restart-fs.ts 文件头）。
    sandboxPolicy: { mode: SANDBOX_MODE, workspaceRoot: process.cwd() },
  })

  return {
    // 平台相关的那一格：由装配处注入（本层与库层都不碰 `node:fs`）。
    pathExists,
    ports: {
      fs,
      restartHistory: async () => await restartHistoryFrom(fs, config.dshHome),
      busySessions: async () => await busySourcesFrom(ctx),
      bundles: async () => await bundlesFrom(config),
      // 载体进闸④的**取值面**（纵深防御的第二道）：桌面端连命令都不给，
      // 于是「命令拼得出来 ⇒ 放行」这条真机路径在两层上都不成立。
      launchCommand: async () => launchCommandFrom(config, carrier),
      now: () => Date.now(),
    },
    approval: {
      policyOf: (agent) => approvalPolicyOf(ctx, agent),
      request: async (agent, reason, signal) => await approvalRequestOf(ctx, agent, reason, signal),
    },
    launch: {
      relaunch: async (request) => await relaunchViaTaskScheduler(spawn, request),
    },
    exit: {
      exit: () => appExitOf(ctx),
    },
  }
}

/**
 * 闸①的历史：**marker 就是重启历史**（它记着上次重启发生在什么时候）。
 *
 * ## 两个 `action: 'none'` 必须分开（`task-32` 的 M1 变异正是这条）
 *
 * `decideRecovery` 有两个 `none` 分支：`reason: 'absent'`（根本没有 marker）与
 * `reason: 'consumed'`（有、但已经处理过了）。**合并它们就是静默丢掉一次冷却**：
 * 一份已消费的 marker 仍然带着 `at`，那是一条真实的重启记录；把它读成「没有重启过」
 * 会让 60 秒冷却窗口形同虚设 —— 也就是熔断闸①对**唯一它要防的那种循环**失效。
 *
 * ## 三值纪律
 *
 * `unsupported-version` / `malformed` / `unreadable` ⇒ `{known: false}`（**不是**空历史）：
 * 读不出历史时判「从没重启过」是**危险的那一边**（本仓三值纪律：取不到 ≠ 没有问题）。
 *
 * ## `at` 解析不出来也走 `{known: false}`（复核抓到的静默绕过）
 *
 * `parseMarker` 只要求 `at` 是**字符串**，不要求它是 ISO 时间。于是
 * `[Date.parse(...)].filter(Number.isFinite)` 会把一份 `at` 坏掉的 marker 压成 `[]` ——
 * 那正好是「读过、没有重启过」，**闸①的 60 秒冷却被静默绕过**（而 marker 明明在盘上）。
 * 现在：读不出时间 ⇒ 历史不可信 ⇒ 闸① fail-closed（拒绝的代价只是等）。
 *
 * @param fs marker 的 IO 端口。
 * @param dshHome 宿主数据目录。
 */
export async function restartHistoryFrom(
  fs: RestartFsPort,
  dshHome: string,
): Promise<Observed<readonly number[]>> {
  const read = await readRestartMarker(fs, dshHome)
  const decision = decideRecovery(read)
  switch (decision.action) {
    case 'none':
      if (decision.reason === 'absent') return { known: true, value: [] }
      // 'consumed'：marker 在、只是处理过了 —— **它仍是一条重启历史**。
      return historyOfMarker(decision.marker)
    case 'recover':
      return historyOfMarker(decision.marker)
    case 'refuse':
      return { known: false, reason: `${decision.code}: ${decision.verdict}` }
  }
}

/**
 * 把一份 marker 读成重启历史（**一个时刻**）。
 *
 * `at` 解析不出来 ⇒ `{known: false}`、**不是**空历史（理由见 {@link restartHistoryFrom}）。
 *
 * @param marker 读到的 marker。
 */
function historyOfMarker(marker: RestartMarker): Observed<readonly number[]> {
  const at = Date.parse(marker.at)
  if (!Number.isFinite(at)) {
    return {
      known: false,
      reason: `the marker timestamp is not a parseable date (${marker.at}), so the restart history cannot be trusted`,
    }
  }
  return { known: true, value: [at] }
}

/**
 * 闸②的忙闲来源（会话回合 / 后台作业 / 定时提醒）。
 *
 * **取不到任何一格 ⇒ `{known: false}`**（fail-closed）：判成「不忙」会去打断别人的回合，
 * 而那不可逆。所以三个服务面（`agents` / `waterfall` / `jobs`）缺一个就拒绝 ——
 * 拒绝的代价只是等，而少算一个阻塞者的代价是打断一件没人知道在跑的事。
 *
 * ## 第三源是三值的（复核抓到的第二个缺口）
 *
 * `workspace/session-activity` 的兜底 `async () => []` 让「**没组合那个提供方**」与
 * 「**确实没有活动**」不可分 —— 于是「三源缺一即 known:false」这条纪律对第三源事实上
 * 不成立。现在先看**监听者表**（{@link waterfallOf} 的 `listeners`），分三格：
 * 没有监听者 / 监听者表读不出来 ⇒ `{known: false}`；有监听者 ⇒ 答空也算答了。
 *
 * ## subagent 族**不单独枚举**（复核那条「对闸②不可见」已证伪，`[已核]`）
 *
 * 复核当时是**推断**。按宿主源码读下来它**不成立**：subagent 后代本身就是 `agents`
 * 注册表里的 live agent，而下面那圈 `agents.list()` 已经把它们逐个读到了 ——
 * - `dsh-agent` 的注册表服务名就是 `agents`（`super(ctx, "agents")`），`list()` 返回
 *   **全部** `store.values()`（不按 owner 过滤，也没有作用域副本）；
 * - `dsh-subagent` 建后代走的正是 `ctx.agents.create({ parentAgent })`，所以后代在
 *   **同一个** store 里；
 * - 后代的 `status` 在回合内就是 `'running'`（`dsh-agent-loop` 的 `get status()`：
 *   phase 不是 idle/maintenance 即 running）—— 与 `dsh-subagent` 自己算
 *   `runningDescendants` 用的是**同一个判据**（`child.status === 'running'`）。
 * ⇒ 正在跑的 subagent 后代**已经被计成 `turn` 阻塞者**；再单独枚举一遍 `subagent` 族
 * 只是重复计数（对闸保守无害，但会让人以为多了一层覆盖，而且 evidence 里会出现同一个
 * 会话的两个标签）。这条结论留在这里，免得下一个人照着复核那句话再推一遍。
 *
 * 同理，waterfall 的 `turn` 族（类型原话：它**没有** per-item identity）说的是「被问的
 * 那个会话在跑回合」，与 `status === 'running'` 是同一件事的两次读 —— 两者都留着是
 * **刻意的**（互为独立来源；标签相同，`Set` 去重后阻塞者集合不因此变大）。
 *
 * @param ctx 宿主上下文。
 */
export async function busySourcesFrom(ctx: unknown): Promise<Observed<readonly BusySource[]>> {
  const agents = serviceOf(ctx, 'agents')
  if (agents === undefined || typeof agents['list'] !== 'function') {
    return { known: false, reason: 'the agents service is not readable in this composition' }
  }
  const jobs = serviceOf(ctx, 'jobs')
  if (jobs === undefined || typeof jobs['list'] !== 'function') {
    return { known: false, reason: 'the jobs service is not readable in this composition' }
  }
  const activity = waterfallOf(ctx)
  if (activity === undefined) {
    return {
      known: false,
      reason: 'this context exposes no event waterfall, so background work cannot be enumerated',
    }
  }
  // 第三源的两格「读不到」：监听者表读不出来 / 组合里确实没人答 —— **都不能**当成
  // 「没有活动」（把「取不到」印成「不忙」正是闸②唯一要防的那种反向结论）。
  if (activity.listeners === undefined) {
    return {
      known: false,
      reason:
        'the event listener table could not be read, so it cannot be told whether any provider answers workspace/session-activity',
    }
  }
  if (activity.listeners === 0) {
    return {
      known: false,
      reason:
        'no provider answers workspace/session-activity in this composition, so background work cannot be enumerated',
    }
  }

  const sources: BusySource[] = []
  let live: readonly { id: string; status: string }[]
  try {
    live = listOf(agents['list'], agents).map((item) => ({
      id: stringOf(item['id']),
      status: stringOf(item['status']),
    }))
  } catch (error) {
    return { known: false, reason: `the agents service failed: ${messageOf(error)}` }
  }

  try {
    for (const agent of live) {
      if (agent.id === '') continue
      // 会话回合：`status` 是最直接的一格（它与 `workspace/session-activity` 的 turn 家族同源）。
      if (agent.status === 'running') sources.push({ kind: 'turn', sessionId: agent.id })
      const activityEntries = await activity.ask({ sessionId: agent.id })
      for (const entry of activityEntries) {
        const kind = stringOf(entry['kind'])
        const items = iterableOf(entry['items'])
        // `turn` 族没有 per-item identity ⇒ 它说的是**被问的这个会话**在跑回合。
        if (kind === 'turn') sources.push({ kind: 'turn', sessionId: agent.id })
        if (kind === 'job') {
          for (const item of items) {
            sources.push({ kind: 'job', jobId: stringOf(item['id']), ownerSession: agent.id })
          }
        }
        if (kind === 'schedule') {
          for (const item of items) {
            sources.push({
              kind: 'schedule',
              scheduleId: stringOf(item['id']),
              ownerSession: agent.id,
            })
          }
        }
      }
    }
    // 无属主的作业：`list()` 不给 caller 时只回无属主的那批（属主自己的已由上面那圈覆盖）。
    // ⚠️ **必须过滤 `status`**（C6 原话：`status ∈ {running, stopping}`）：`list()` 返回
    // **全部**记录，而删除只发生在 `remove` / `disposeOwned` / `disposeAll` —— 跑完的作业
    // 会**一直留着**，不过滤就会把合法重启永久拒到用户手填 `force`（而同一次调用里
    // `agents.list()` 那条**有** status 过滤 ⇒ 两个来源自相矛盾）。
    for (const job of listOf(jobs['list'], jobs)) {
      if (!isActiveJobStatus(stringOf(job['status']))) continue
      sources.push({ kind: 'job', jobId: stringOf(job['id']) })
    }
  } catch (error) {
    return { known: false, reason: `the activity enumeration failed: ${messageOf(error)}` }
  }

  return { known: true, value: sources.filter((source) => busyIdOf(source) !== '') }
}

/**
 * C6 的活跃档：`dsh-jobs-local` 的 `list()` 会返回已跑完的记录，只有这两档算「还在跑」。
 *
 * @param status 作业记录里的 `status`。
 */
function isActiveJobStatus(status: string): boolean {
  return status === 'running' || status === 'stopping'
}

/** 取一个忙来源的标识（空串表示这条读不出来，由调用方滤掉）。 */
function busyIdOf(source: BusySource): string {
  switch (source.kind) {
    case 'turn':
      return source.sessionId
    case 'job':
      return source.jobId
    case 'schedule':
      return source.scheduleId
  }
}

/**
 * 闸③：profile 的 bundle 表。
 *
 * 读不到清单（文件不在 / 不是 JSON）⇒ `{known: false}`：一个载入不了组合的宿主比现在这个更糟。
 *
 * @param config 生效配置。
 */
export async function bundlesFrom(config: ResolvedConfig): Promise<Observed<readonly string[]>> {
  const dir = profileDir(config.dshHome, config.profile)
  try {
    const manifest = await readProfileManifest(dir)
    if (manifest === undefined) {
      return { known: false, reason: `no readable profile manifest under ${dir}` }
    }
    return { known: true, value: manifest.bundles }
  } catch (error) {
    return { known: false, reason: messageOf(error) }
  }
}

/**
 * 闸④的**取值面**：启动命令 —— **不猜**。
 *
 * 三条分支，顺序是判据：
 * 1. **桌面宿主** ⇒ `{known: false}`，理由逐字用 `relaunchRefusalFor` 的那一句
 *    （**纵深防御**：判据层已经先拒过一次，这里再拒一次 —— 「命令拼得出来 ⇒ 放行」
 *    正是 2026-10-15 真机缺陷的成因，所以两层都必须不成立）；
 * 2. **非 win32** ⇒ `{known: false}`（别的平台没有已实测的路线）；
 * 3. win32 ⇒ 按 `argv` 拼命令。
 *
 * `process.platform` **在这里读**（调用时，不在模块顶层）：平台分支因此可被判据钉住。
 *
 * @param config 生效配置。
 * @param carrier 载体观测（只为第 1 条分支；判定表在 `lib/carrier.ts` 一处）。
 */
export function launchCommandFrom(
  config: ResolvedConfig,
  carrier: CarrierObservation,
): Observed<LaunchCommand> {
  if (carrier.kind === 'desktop-host') {
    return { known: false, reason: relaunchRefusalFor(carrier).reason }
  }
  if (process.platform !== 'win32') {
    return {
      known: false,
      reason: unverifiedRelaunchReason(process.platform),
    }
  }
  const launch = resolveDshLaunch()
  return {
    known: true,
    value: {
      command: launch.command,
      args: [...launch.prefix, '--profile', config.profile],
      cwd: process.cwd(),
    },
  }
}

/**
 * 真拉起：Windows 计划任务（`schtasks`）。
 *
 * 顺序是 `/create`（`/f` 覆盖同名任务）→ `/run`（立刻跑，延迟由命令行里的等待表达）。
 * **不 `/delete`**：删除会连带掐掉正在跑的实例；同名任务用 `/f` 覆盖即可，代价是
 * 机器上留一条任务定义（写进 `audit`，让用户知道有它、也知道怎么删）。
 *
 * 失败一律收敛成 `{ok: false, reason}`（**不抛**）：拉起失败要**可诊断**，
 * 而「哪一步、退出码多少、stderr 是什么」就是诊断要的全部。
 *
 * @param spawn 子进程实现。
 * @param request 拉起请求。
 */
export async function relaunchViaTaskScheduler(
  spawn: SpawnImpl,
  request: RelaunchRequest,
): Promise<RelaunchResult> {
  if (process.platform !== 'win32') {
    return { ok: false, reason: unverifiedRelaunchReason(process.platform) }
  }
  if (request.budgetMs <= 0) {
    return { ok: false, reason: 'the tool budget was exhausted before the relaunch' }
  }
  if (request.signal?.aborted === true) {
    return { ok: false, reason: 'the call was cancelled before the relaunch' }
  }
  // 边界自己也拦一道（与 `budgetMs` / `signal` 同一种防御性）：工具壳在**动手之前**
  // 已经拒过一次，但那一次拒是为了「零写」；这里是「绝不把一条明知超限的 `/tr` 交出去」。
  const lineProblem = commandLineLengthProblem(request.commandLine)
  if (lineProblem !== undefined) return { ok: false, reason: lineProblem }

  const create = await runSchtasks(spawn, request, [
    '/create',
    '/tn',
    TASK_NAME,
    '/tr',
    request.commandLine,
    '/sc',
    'once',
    '/st',
    '00:00',
    '/f',
  ])
  if (!create.ok) return create
  const run = await runSchtasks(spawn, request, ['/run', '/tn', TASK_NAME])
  if (!run.ok) return run
  return { ok: true, detail: `${create.detail}; ${run.detail}` }
}

/**
 * 跑一条 `schtasks` 子命令。
 *
 * @param spawn 子进程实现。
 * @param request 拉起请求（预算与取消信号）。
 * @param args `schtasks` 的参数。
 */
async function runSchtasks(
  spawn: SpawnImpl,
  request: RelaunchRequest,
  args: readonly string[],
): Promise<RelaunchResult> {
  const command = `schtasks ${args.join(' ')}`
  try {
    const result = await spawn({
      command: 'schtasks',
      args,
      timeoutMs: request.budgetMs,
      signal: request.signal,
      cwd: request.cwd,
    })
    if (result.spawnError !== undefined) {
      return { ok: false, reason: `${command} could not start (${result.spawnError})` }
    }
    if (result.timedOut) return { ok: false, reason: `${command} timed out` }
    if (result.aborted) return { ok: false, reason: `${command} was cancelled` }
    if (result.code !== 0) {
      const stderr = result.stderr.trim()
      return {
        ok: false,
        reason: `${command} exited with code ${String(result.code)}${stderr === '' ? '' : `: ${stderr}`}`,
      }
    }
    return { ok: true, detail: `${command} exited 0` }
  } catch (error) {
    return { ok: false, reason: `${command} failed: ${messageOf(error)}` }
  }
}

/**
 * 取宿主退出通道（`ctx.get('appExit')`）。
 *
 * **不猜、不退回 `process.exit`**：宿主源码点名那条路 bypassing `ctx.appExit`。
 * 取不到就返回 `undefined`，由调用方转成结构化失败（B24）。
 *
 * @param ctx 宿主上下文。
 */
export function appExitOf(ctx: unknown): ((code: number) => void) | undefined {
  const exit = serviceOf(ctx, 'appExit')
  if (exit === undefined) return undefined
  return typeof exit === 'function' ? (exit as (code: number) => void) : undefined
}

/**
 * 读这次调用所在会话的审批档位。
 *
 * `effectivePolicy(session)` 在宿主 `d.ts` 里标着 `private`，但运行时是个普通方法
 * （`overrideOf(session) ?? config.policy ?? 'ask'`）—— 所以这里按**结构**取，
 * 拿不到就返回 `undefined`（fail-closed），而不是猜一个 `ask`。
 *
 * @param ctx 宿主上下文。
 * @param agent 这次调用所属的 agent。
 */
export function approvalPolicyOf(ctx: unknown, agent: unknown): RestartApprovalPolicy | undefined {
  const service = serviceOf(ctx, 'approval')
  if (service === undefined) return undefined
  const effective = service['effectivePolicy']
  if (typeof effective !== 'function') return undefined
  const session = sessionOf(agent)
  if (session === undefined) return undefined
  try {
    const policy = (effective as (s: unknown) => unknown).call(service, session)
    return policy === 'ask' || policy === 'never' ? policy : undefined
  } catch {
    return undefined
  }
}

/**
 * 走官方审批门（`approval.request`）。
 *
 * **不抛**：`request()` 在没有打开的回合上会抛，那同样是「没拿到许可」⇒ 收敛成
 * `'unavailable'`（闭枚举里的一格，fail-closed）。返回非闭集值时也归一成 `'unavailable'`。
 *
 * @param ctx 宿主上下文。
 * @param agent 这次调用所属的 agent。
 * @param reason 给弹窗看的那句话。
 * @param signal 调用方取消信号。
 */
export async function approvalRequestOf(
  ctx: unknown,
  agent: unknown,
  reason: string,
  signal?: AbortSignal | undefined,
): Promise<RestartApprovalOutcome> {
  const service = serviceOf(ctx, 'approval')
  if (service === undefined) return 'unavailable'
  const request = service['request']
  if (typeof request !== 'function') return 'unavailable'
  try {
    const outcome = await (request as (req: unknown) => Promise<unknown>).call(service, {
      agent,
      toolName: RESTART_TOOL,
      reason,
      ...(signal === undefined ? {} : { signal }),
    })
    return outcome === 'allowed-once' ||
      outcome === 'rejected' ||
      outcome === 'cancelled' ||
      outcome === 'unavailable'
      ? outcome
      : 'unavailable'
  } catch {
    return 'unavailable'
  }
}

/** 取 agent 的 session（两个字段都试；形状不认识就返回 `undefined`）。 */
function sessionOf(agent: unknown): unknown {
  if (typeof agent !== 'object' || agent === null) return undefined
  const session = (agent as { session?: unknown }).session
  return typeof session === 'object' && session !== null ? session : undefined
}

/** 取一个宿主服务（形状不认识时返回 `undefined`，不抛）。 */ function serviceOf(
  ctx: unknown,
  name: string,
): Record<string, unknown> | undefined {
  if (typeof ctx !== 'object' || ctx === null) return undefined
  const get = (ctx as HostContextLike).get
  if (typeof get !== 'function') return undefined
  try {
    const service = get.call(ctx, name)
    if (service === null || service === undefined) return undefined
    if (typeof service === 'function') return service as unknown as Record<string, unknown>
    return typeof service === 'object' ? (service as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/**
 * `workspace/session-activity` 的询问面：**答空 ≠ 没人答**。
 *
 * `ctx.waterfall(name, request, fallback)` 的 fallback **总会**被走到 —— 每个监听者答完
 * 都会 `await next()`（宿主自己的三个提供方就是这么写的），所以「fallback 被调用」与
 * 「没有监听者」不是一回事；而且**答案的值也分不开**这两种情况（不活动的监听者原样返回
 * `next()` 的结果，也就是同一个 `[]`）。⇒ 只能去看**监听者表本身**。
 *
 * 取法（`[已核]`：本机 `@deepseek-ai/cordis` 的 `EventsService`）：
 * `ctx.events._hooks[<事件名>]` 是一个数组，且**同一棵树的任意 ctx 共享同一个 `_hooks`
 * 对象**（实测：在子 ctx 上注册、在根 ctx 上读得到，且 `===` 为真）—— 所以在本插件这一层
 * 读到的就是全树的监听者表。形状不认识 ⇒ `listeners: undefined`（**不猜**，由调用方
 * 判 fail-closed）。
 *
 * @param ctx 宿主上下文。
 */
function waterfallOf(ctx: unknown): ActivityPort | undefined {
  if (typeof ctx !== 'object' || ctx === null) return undefined
  const waterfall = (ctx as HostContextLike).waterfall
  if (typeof waterfall !== 'function') return undefined
  return {
    listeners: activityListenerCountOf(ctx),
    ask: async (request) =>
      (await (
        waterfall as (
          n: string,
          r: unknown,
          fallback: () => Promise<readonly SessionActivityLike[]>,
        ) => Promise<readonly SessionActivityLike[]>
      ).call(ctx, ACTIVITY_EVENT, request, async () => [])) ?? [],
  }
}

/**
 * 数一数 {@link ACTIVITY_EVENT} 有几个监听者。
 *
 * `undefined` = **读不出来**（`ctx.events` / `_hooks` 的形状不认识）—— 调用方按
 * fail-closed 处理，**不**把「不知道」印成「有提供方」；`0` = 组合里确实没有那个提供方。
 *
 * @param ctx 宿主上下文。
 */
function activityListenerCountOf(ctx: unknown): number | undefined {
  const events = (ctx as { events?: unknown }).events
  if (typeof events !== 'object' || events === null) return undefined
  const hooks = (events as { _hooks?: unknown })._hooks
  if (typeof hooks !== 'object' || hooks === null) return undefined
  const listeners = (hooks as Record<string, unknown>)[ACTIVITY_EVENT]
  if (listeners === undefined) return 0
  if (Array.isArray(listeners)) return listeners.length
  const length = (listeners as { length?: unknown }).length
  return typeof length === 'number' ? length : undefined
}

/**
 * 调一个宿主列表方法并把它读成数组。
 *
 * 不假定 `.length` / `.find()`：同一台机器上宿主列表**两种形状都出现过**（数组与
 * 可迭代对象，见活跃坑 20），所以一律按 `Symbol.iterator` 取，两边通吃。
 *
 * @param fn 宿主方法。
 * @param thisArg 它的 this。
 */
function listOf(fn: unknown, thisArg: unknown): readonly Record<string, unknown>[] {
  const value = (fn as () => unknown).call(thisArg)
  const out: Record<string, unknown>[] = []
  for (const item of iterableOf(value)) out.push(item)
  return out
}

/** 把一个「数组或可迭代对象」读成一串记录（两种形状通吃）。 */
function iterableOf(value: unknown): Record<string, unknown>[] {
  if (value === null || value === undefined) return []
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
    )
  }
  if (typeof value !== 'object') return []
  const iterator = (value as { [Symbol.iterator]?: unknown })[Symbol.iterator]
  if (typeof iterator !== 'function') return []
  const out: Record<string, unknown>[] = []
  for (const item of value as Iterable<unknown>) {
    if (typeof item === 'object' && item !== null) out.push(item as Record<string, unknown>)
  }
  return out
}

/** 取一个值的字符串视图（不是字符串就返回空串）。 */
function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

// `messageOf` 的唯一实现在 lib/errors.ts（2026-10-16 审计 A1 收敛，本文件原有一份已删）。

// ── L2 ─────────────────────────────────────────────────────────────────────

/**
 * `key` → L2 的逐行文本。
 *
 * 顺序即输出顺序：**先「走到哪一步」，再「拒绝/审批的机器码」，最后是落点与命令**。
 * 三条纪律与 `dsh_hot_reload` 的同名函数一致：
 * - **不给默认值**：字段缺省就整项不印；
 * - **只在为真时印**（`dryRun` / `forced` / `markerWritten`）；
 * - **标识符必须出现**：`relaunch` 是模型复核「到底会跑什么」的唯一一行。
 *
 * ⚠️ 必须能喂 `{}`（B25：守卫合成的兜底 `key` 就是空对象）—— 全程可选链 + 类型守卫。
 *
 * @param key 本次的 `key`。
 */
export function keyText(key: RestartKey): string[] {
  const lines: string[] = []
  if (typeof key?.stage === 'string') lines.push(`stage: ${key.stage}`)
  if (typeof key?.gate === 'string') lines.push(`gate: ${key.gate}`)
  if (typeof key?.code === 'string') lines.push(`code: ${key.code}`)
  if (Array.isArray(key?.gatesPassed) && key.gatesPassed.length > 0) {
    lines.push(`gatesPassed: ${key.gatesPassed.join(', ')}`)
  }
  if (typeof key?.approval === 'string' && key.approval !== '') {
    lines.push(`approval: ${key.approval}`)
  }
  if (key?.dryRun === true) lines.push('dryRun: true')
  if (key?.forced === true) lines.push('forced: true')
  if (typeof key?.sandbox === 'string' && key.sandbox !== '') {
    lines.push(`sandbox: ${key.sandbox}`)
  }
  if (typeof key?.marker === 'string' && key.marker !== '') lines.push(`marker: ${key.marker}`)
  if (key?.markerWritten === true) lines.push('markerWritten: true')
  if (typeof key?.relaunch === 'string' && key.relaunch !== '') {
    lines.push(`relaunch: ${key.relaunch}`)
  }
  if (typeof key?.launcher === 'string' && key.launcher !== '') {
    lines.push(`launcher: ${key.launcher}`)
  }
  if (typeof key?.launcherLog === 'string' && key.launcherLog !== '') {
    lines.push(`launcherLog: ${key.launcherLog}`)
  }
  if (key?.launcherMode === 'console-fallback') {
    lines.push('launcherMode: console-fallback (a console window will flash)')
  }
  if (typeof key?.stopWindow === 'string' && key.stopWindow !== '') {
    lines.push(`stopWindow: ${key.stopWindow}`)
  }
  if (typeof key?.stopWindowLog === 'string' && key.stopWindowLog !== '') {
    lines.push(`stopWindowLog: ${key.stopWindowLog}`)
  }
  // 总闸档位**只在为假时印**（开着是默认路径、没有信息量；关着才是模型必须看见的那一格）。
  if (key?.restartEnabled === false) {
    lines.push(`restartEnabled: false (${RESTART_CONFIG_FIELD})`)
  }
  // 载体**只在不是 `cli` 时印**（同一条先例）：`cli` 是默认路径，而 `desktop-host` / `unknown`
  // 正是闸④那条 `no-relaunch-route` 的成因 —— 模型要对上拒绝码就得看得见它。
  if (typeof key?.carrier === 'string' && key.carrier !== 'cli') {
    lines.push(`carrier: ${key.carrier}`)
  }
  const resolved = key?.resolved
  // 字段顺序、端口取舍与逐字段兜底由 `shared.ts` 的唯一渲染点定
  // （此前这里是 `dshHome` 在前、且无兜底 —— 兜底路径上会印出 `undefined` 逐字）。
  if (resolved !== undefined && resolved !== null) {
    lines.push(resolvedLine(resolved as EffectiveConfigBlock))
  }
  return lines
}
