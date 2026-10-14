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
import { RECOVERY_STARTUP_DELAY_MS, runStartupRecovery } from './lib/restart-recovery.js'
import type { ContextLike as RecoveryContextLike } from './lib/restart-fs.js'
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
  const state: PluginState = { config: resolveConfig(config), skill: null }

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
}
