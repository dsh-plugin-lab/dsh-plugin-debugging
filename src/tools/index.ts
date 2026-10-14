/**
 * 工具半边 —— 注册**只读**诊断工具、一个写侧工具、一个派生工具、一个行动类工具。
 *
 * **契约（G2 冻结，改它要同时改 `src/contracts.ts` 与技能半边）**
 * - 只导出 `registerTools(ctx, state)`；
 * - 只碰 `ctx.tools`（`ctx.skills` 归技能半边）；不 import `src/skills/**`；
 * - **容忍缺失**：`ctx.tools` 不在时直接返回，不抛（宿主缺服务时插件不该炸）；
 * - 每个工具**一个文件**（组织既有范式，见 `dsh-zhihu-search/src/tools/`）；
 * - 每个工具的 `execute` **绝不 throw**：预期内失败一律返回结构化
 *   `{ ok: false, error: { kind, message, hint } }`，`kind` 是闭枚举（决定模型该不该重试）；
 * - `exec.signal` 必须透传给底层 fetch / spawn。
 *
 * **工具清单**（决策 D4/D5；命名取 03 那套）
 * | 工具 | 半边 | 对应 SKILL.md |
 * |---|---|---|
 * | `dsh_check_effect_mode` | 只读 | §一 生效三档 |
 * | `dsh_diagnose_plugin_load` | 只读 | §3.1 / §3.2 / §3.8 |
 * | `dsh_check_auth` | 只读 | §3.3 / §3.4 |
 * | `dsh_dump_config` | 只读 | §3.8 |
 * | `dsh_list_instances` | 只读 | 跨实例（D′）—— 发现本机活着的 DSH |
 * | `dsh_hot_reload` | **写侧** | 生效三档（换模块） |
 * | `dsh_sign_cookie` | **派生**（唯一经手秘密） | §3.4 |
 * | `dsh_restart` | **行动**（不可逆；唯一会退出宿主） | §一 生效三档（`restart-required` 那一路） |
 *
 * **只读纪律**：不杀进程、不改 profile、不写 `$DSH_HOME`。
 * 进程与端口一律**按端口**查（`lib/ports.ts`），不用命令行子串 —— 子串会误匹配派生 shell。
 */
import type { Context } from '@deepseek-ai/cordis'

import type { PluginState } from '../contracts.js'
import { readLoaderEntries, loaderFrom } from '../lib/loader.js'
import { reloadHostFrom } from '../lib/hot-reload.js'
import { createCheckAuthTool } from './dsh_check_auth.js'
import { createDiagnosePluginLoadTool } from './dsh_diagnose_plugin_load.js'
import { createDumpConfigTool } from './dsh_dump_config.js'
import { createEffectModeTool } from './dsh_check_effect_mode.js'
import { createHotReloadTool } from './dsh_hot_reload.js'
import { createListInstancesTool } from './dsh_list_instances.js'
import { createRestartTool, restartHostFrom } from './dsh_restart.js'
import { createSignCookieTool } from './dsh_sign_cookie.js'
import { createToolDeps } from './shared.js'

/**
 * 聚合注册入口。
 *
 * @param ctx 宿主上下文；`ctx.tools` 是唯一允许触碰的服务。
 * @param state 配置 + 技能半边的结果（工具可以据此在输出里提示技能没生效）。
 */
export function registerTools(ctx: Context, state: PluginState): void {
  if (ctx.tools === undefined) return

  // Loader 观测的**唯一一处**绑定：把活着的 `ctx` 收成一个只读闭包。
  // 闭包在每次调用时重新读树（宿主自己也是「每次调用直接读，不另建缓存」——
  // `dsh-host-plugin-inventory\lib\index.js:100-114` 的注释就是这个理由），
  // 所以热重载后的相位变化不会因为我们缓存而失真。
  const deps = createToolDeps(state.config, {
    loader: () => readLoaderEntries(loaderFrom(ctx)),
  })
  const factories = [
    createEffectModeTool,
    createDiagnosePluginLoadTool,
    createCheckAuthTool,
    createDumpConfigTool,
    // 发现工具（D′ 第①块）：列本机活着的 DSH。它也是只读的（读 socket 表 + 发一次
    // 未认证 `GET /`），与上面四个共用同一份 `deps`。
    createListInstancesTool,
  ]
  for (const create of factories) {
    ctx.tools.register(create(deps))
  }

  // 写侧工具（v1.1）：**唯一**一个会改运行中树的工具。
  // 它比只读工具多要一个宿主端口（`reload`），所以单独构造 —— `deps` 那份
  // 是四个只读工具共享的冻结形状，不为写侧破例。
  ctx.tools.register(createHotReloadTool({ ...deps, reload: reloadHostFrom(ctx) }))

  // 派生类工具（`dsh_sign_cookie`）：**唯一**一个会经手秘密的工具。
  //
  // 它仍然**不写**任何东西（只读一份文件 + 内存里算 HMAC），所以共用 `deps` 那份冻结形状；
  // 它与「派生」的区分不是「会不会改状态」，而是「返回值里有没有秘密」—— 见
  // `dsh_sign_cookie.ts` 文件头第 2 条：cookie 本体刻意不进 `data` 也不进 `audit`
  // （`audit` 会被 spill 落盘）。
  ctx.tools.register(createSignCookieTool(deps))

  // 行动类工具（`dsh_restart`）：**唯一会退出宿主**的那一个，也是本仓唯一的不可逆动作。
  //
  // 它比写侧多要四个宿主面（四道闸的取数、审批档、计划任务拉起、`appExit`），
  // 所以单独装配一处（`restartHostFrom`）—— `deps` 那份是只读工具共享的冻结形状，
  // 不为行动类破例（与 `dsh_hot_reload` 同一个范式）。
  //
  // ⚠️ 装配发生在 apply 期，但 `restartHostFrom` **不在这里取任何服务**：
  // `ctx.get('fs')` 在 apply 期是 `undefined`（`task-31` 实测，+1s 才有），
  // 所以那个适配器每次读写时各自现取一次，本处只绑 ctx 与配置。
  ctx.tools.register(
    createRestartTool({ ...deps, restart: restartHostFrom(ctx, state.config, deps.spawn) }),
  )
}
