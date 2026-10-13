/**
 * 工具半边 —— 注册 v1 的四个**只读**诊断工具。
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
 * **v1 工具清单**（决策 D4；命名取 03 那套，副作用工具留 v1.1 —— 决策 D5）
 * | 工具 | 对应 SKILL.md |
 * |---|---|
 * | `dsh_check_effect_mode` | §一 生效三档 |
 * | `dsh_diagnose_plugin_load` | §3.1 / §3.2 / §3.8 |
 * | `dsh_check_auth` | §3.3 / §3.4 |
 * | `dsh_dump_config` | §3.8 |
 *
 * **只读纪律（v1）**：不杀进程、不改 profile、不写 `$DSH_HOME`。
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
  ]
  for (const create of factories) {
    ctx.tools.register(create(deps))
  }

  // 写侧工具（v1.1）：**唯一**一个会改运行中树的工具。
  // 它比只读工具多要一个宿主端口（`reload`），所以单独构造 —— `deps` 那份
  // 是四个只读工具共享的冻结形状，不为写侧破例。
  ctx.tools.register(createHotReloadTool({ ...deps, reload: reloadHostFrom(ctx) }))
}
