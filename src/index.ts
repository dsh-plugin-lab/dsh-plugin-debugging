/**
 * 宿主半边入口。
 *
 * 这是**唯一**接触 Cordis 的地方：生命周期、配置校验、注册点都落在这里。
 * 业务逻辑放在本文件之外，那样才能用普通对象直接单测。
 *
 * 生命周期纪律：状态、监听器、定时器一律在 `ctx.effect()` / `ctx.on()` 内创建并由
 * 返回的 disposer 释放。**模块顶层不持有任何可变状态** —— 否则热重载后会留下两代
 * 插件共用同一份状态的幽灵故障。
 */
import type { Context } from '@deepseek-ai/cordis'
// 类型导入即声明：少了这两行，`ctx.tools` / `ctx.skills` 在类型上不存在（组织既有范式）。
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-tools'

import { resolveConfig, type Config } from './config.js'
import type { PluginState } from './contracts.js'
import { observeCarrier } from './lib/carrier.js'
import { RECOVERY_STARTUP_DELAY_MS, runStartupRecovery } from './lib/restart-recovery.js'
import type { ContextLike as RecoveryContextLike } from './lib/restart-fs.js'
import { RESTART_SANDBOX_MODE } from './lib/restart-recovery.js'
import { createRestartFsPort } from './lib/restart-fs.js'
import { restartStopWindowUrlPath } from './lib/restart.js'
import {
  listeningPortOf,
  serializeStopWindowUrl,
  stopWindowUrlOf,
  type StopUrlContextLike,
} from './lib/stop-url.js'
import { registerSkills, type AgentsLike } from './skills/register.js'
import { registerTools } from './tools/index.js'

/** Cordis 插件名，用于 loader 诊断。 */
export const name = 'dsh-plugin-debugging'

/**
 * 本插件需要的服务。
 *
 * `tools` 是**硬依赖**：没有它，这个插件一行输出都没有。
 * `skills` **不写进来** —— 它是可选能力；写进去会让缺技能服务的宿主把整插件挂成
 * PENDING（静默无输出，且不算错误），而我们希望工具半边照常工作。
 */
export const inject = ['tools']

export { Config } from './config.js'
export type { PluginState, ResolvedConfig, SkillReport } from './contracts.js'

/**
 * 取一个**可选**服务。宿主上下文在真实运行时总有 `get`；单测里传进来的普通对象没有，
 * 所以这里显式容错，让「宿主不在场」也能走到技能半边的降级分支。
 *
 * @param ctx 宿主上下文（可能是单测替身）。
 * @param serviceName 服务名。
 */
function optionalService<T>(ctx: Context, serviceName: string): T | undefined {
  const getter = (ctx as { get?: (name: string) => unknown }).get
  if (typeof getter !== 'function') return undefined
  return getter.call(ctx, serviceName) as T | undefined
}

/**
 * 启动期恢复的 effect 标签（诊断树里能看出是谁挂的）。
 *
 * 用 `ctx.effect` 而不是裸 `setTimeout`：模块顶层不许持有可变状态，定时器必须挂在
 * fiber 上并由返回的 disposer 释放 —— 否则热重载后会留下两代插件共用一枚定时器的幽灵故障。
 */
const RECOVERY_EFFECT_LABEL = 'dsh-plugin-debugging:restart-recovery'

/**
 * 发布「停止窗口地址」的 effect 标签。
 *
 * 与恢复半同一个范式：`webServer.port` 在 apply 期还没绑定、`webApp` 的 announce 更晚，
 * 所以只能用**轮询**去等，不能在这里取一次存起来（`task-31` / `task-34` 的实测）。
 */
const STOP_URL_EFFECT_LABEL = 'dsh-plugin-debugging:stop-window-url'

/** 轮询间隔：`webServer` 的 `listen` 通常在 apply 后一两秒内完成。 */
const STOP_URL_POLL_MS = 500

/** 轮询上限（约 60 秒）：超过就放弃 —— 这个宿主大概根本没在服务 Web。 */
const STOP_URL_ATTEMPTS = 120

/**
 * 把**本进程**带 token 的 Web 地址发布给停止窗口。
 *
 * ## 它解决什么
 *
 * 重启后的宿主是隐藏拉起的（`stdio: 'ignore'`），`dsh web: <url>` 那行输出没人接 ——
 * 于是用户手上再没有任何可用地址，浏览器里留着的是上一代的 token（401）。停止窗口是唯一
 * 一直显示在桌面上的东西，把地址放它上面是唯一能「随时看得到」的落点。
 *
 * ## 为什么是轮询 + 一次性写
 *
 * `webServer.port` 与 `webApp.getAdvertisedUrl()` 都不是 apply 期就绪的事实；token 则是
 * **进程常量**（`processLaunchToken` 对同一个 owner 只生成一次）。所以「等到齐 → 写一次」
 * 就够了，不需要盯着地址变化。
 *
 * ## 回收
 *
 * disposer 里把内容改写成 `pid=0`：端口层没有删除能力（宿主 `ctx.fs` 没有
 * `delete`／`unlink`，`task-32` 实测），改写是唯一能让 token **当场离开磁盘**的手段。
 * 内核直接杀宿主（关窗那条路）时走不到这里，那份残留的 `pid` 是死进程 ⇒ 窗口不显示它。
 *
 * @param ctx 宿主上下文。
 * @param dshHome 宿主数据目录。
 */
function scheduleStopWindowUrl(ctx: Context, dshHome: string): void {
  const effect = (ctx as { effect?: unknown }).effect
  if (typeof effect !== 'function') return
  const registerEffect = effect as (execute: () => () => void, label: string) => unknown

  registerEffect.call(
    ctx,
    () => {
      const fs = createRestartFsPort(ctx as unknown as RecoveryContextLike, {
        sandboxPolicy: { mode: RESTART_SANDBOX_MODE, workspaceRoot: process.cwd() },
      })
      const service = ctx as unknown as StopUrlContextLike
      let attempt = 0
      let timer: NodeJS.Timeout | undefined
      let publishedPath: string | undefined

      const tick = (): void => {
        timer = undefined
        if (publishedPath !== undefined) return
        attempt += 1
        const port = listeningPortOf(service)
        const url = stopWindowUrlOf(service)
        if (port === undefined || url === undefined) {
          if (attempt < STOP_URL_ATTEMPTS) timer = setTimeout(tick, STOP_URL_POLL_MS)
          return
        }
        const path = restartStopWindowUrlPath(dshHome, port)
        publishedPath = path
        // 失败不重试也不抛：这条通道是**附加信息**，不是宿主能否工作的一部分。
        void fs.write(path, serializeStopWindowUrl(process.pid, url)).catch(() => {
          publishedPath = undefined
        })
      }

      timer = setTimeout(tick, STOP_URL_POLL_MS)

      return () => {
        if (timer !== undefined) clearTimeout(timer)
        if (publishedPath === undefined) return
        // 回收：token 当场离开磁盘（pid=0 让这份残留对任何窗口都不生效）。
        void fs.write(publishedPath, serializeStopWindowUrl(0, undefined)).catch(() => undefined)
      }
    },
    STOP_URL_EFFECT_LABEL,
  )
}

/**
 * 挂上 `dsh_restart` 的**恢复半**：新宿主起来之后读 marker → 唤醒会话 → 投 notice → 标已消费。
 *
 * ## 为什么是延迟 + 重试（而不是 apply 期直接做）
 *
 * `task-34` 实测：`sessionController` 在 apply 的第一刻是 `undefined`，**138–157 ms** 之后
 * 才有（HOST-CONTRACTS §2.4.1 的 C26）。所以延迟由 {@link RECOVERY_STARTUP_DELAY_MS}
 * 一处给出（`src/lib/restart-recovery.ts`），逐会话的重试也在那一层。
 *
 * ## ⚠️ 这里**不取任何服务**
 *
 * `ctx.get('fs')` 在 apply 期同样是 `undefined`（`task-31` 实测，+1s 才有），而
 * `sessionController` 更晚。所以本函数只绑 ctx 与 `dshHome`：真实的取服务发生在
 * `runStartupRecovery` 里、每次读写/唤醒时**现取**。
 *
 * ## 失败去哪
 *
 * `runStartupRecovery` **绝不 reject**（它是启动期逻辑，一个未处理的 rejection 会变成
 * 宿主启动期的幽灵错误）；它把结论与留痕写进宿主 logger。这里的 `.catch` 只是
 * 「构造上不会发生」的兜底，不是失败处理路径。
 *
 * @param ctx 宿主上下文。
 * @param dshHome 宿主数据目录。
 */
function scheduleRestartRecovery(ctx: Context, dshHome: string): void {
  const effect = (ctx as { effect?: unknown }).effect
  if (typeof effect !== 'function') {
    // 单测里 `ctx` 是普通对象（冒烟测试就是那样），真实 Cordis 上下文永远有 `effect`。
    // 这**不是**静默的失败：那种上下文里根本没有宿主进程，也就没有 marker 可恢复。
    return
  }
  const registerEffect = effect as (execute: () => () => void, label: string) => unknown
  registerEffect.call(
    ctx,
    () => {
      const timer = setTimeout(() => {
        void runStartupRecovery(ctx as unknown as RecoveryContextLike, dshHome).catch(
          () => undefined,
        )
      }, RECOVERY_STARTUP_DELAY_MS)
      return () => {
        clearTimeout(timer)
      }
    },
    RECOVERY_EFFECT_LABEL,
  )
}

/**
 * 挂载点。
 *
 * @param ctx 宿主上下文。
 * @param config 配置（缺省即全默认值）。
 */
export function apply(ctx: Context, config: Config = {}): void {
  // ── 载体：**整个插件只探这一次** ──────────────────────────────────────────
  //
  // 它是进程级事实，而三处消费者（`dsh_restart` 闸④ / `dsh_dump_config` /
  // `dsh_check_effect_mode` 的 `nextStep`）的结论都建在它上面。各探各的就会出现
  // 「同一个进程里两处对载体的判断不一致」，而那种错没有任何判据照得到。
  //
  // 取服务一律走**可选**路径（结构面 + 容错，见 `optionalService`）：`profileContext`
  // 由启动器在建树之前 provide（`apps/cli/src/profile-boot.ts`），缺席时降级成
  // 「取不到」而不是抛 —— 宿主换版本时表现为降级（`src/lib/AGENTS.md`）。
  const profileContext = optionalService<{ name?: unknown }>(ctx, 'profileContext')
  const carrier = observeCarrier({ profileContext })

  // profile 的**真源**就是那一次观测（`DSH_PROFILE` 是继承来的环境变量，不是身份）
  // —— 优先级与理由见 `resolveConfig` 的文件头。
  const state: PluginState = {
    config: resolveConfig(config, process.env, { profile: carrier.profile }),
    skill: null,
    carrier,
  }

  // 技能半边：可选，失败只记状态，不打断挂载。
  // 动态 scope 注入要 `ctx.agents`（活跃 agent 注册表）—— 同样走**可选服务**取，
  // 缺席时只做全局层注册（见 src/skills/register.ts 顶部：两次注册的理由）。
  const agents = optionalService<AgentsLike>(ctx, 'agents')
  state.skill = registerSkills(ctx, optionalService(ctx, 'skills'), {
    agents: () => agents,
  })

  // 工具半边：本插件的全部对外能力。
  registerTools(ctx, state)

  // 恢复半：**启动期**逻辑（不是工具调用期），所以它挂在这里、而不是挂在某个工具上。
  scheduleRestartRecovery(ctx, state.config.dshHome)

  // 发布带 token 的 Web 地址给停止窗口（唯一一直显示在桌面上的落点）。
  scheduleStopWindowUrl(ctx, state.config.dshHome)
}
