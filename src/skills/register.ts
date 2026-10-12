/**
 * 技能半边 —— 把随包分发的 `skills/dsh-plugin-debugging/SKILL.md` 注册进宿主技能注册表。
 *
 * **契约（G2 冻结，改它要同时改 `src/contracts.ts` 与工具半边）**
 * - 只导出 `registerSkills(ctx, skills)`，输入是宿主上下文与**可能缺席**的 `ctx.skills`，
 *   返回 `SkillReport`；
 * - **绝不抛**：任何失败都收敛成 `SkillReport.error`；
 * - 注册必须挂在 fiber 上：用 `ctx.effect(function* () { yield skills.register({...}) })`，
 *   这样热重载/卸载时注册自己会被撤掉（模块顶层不许持有可变状态）；
 * - 本文件**不许** import 工具半边，也不许碰 `ctx.tools`。
 *
 * **为什么是 runtime 注册而不是 filesystem provider**（决策 D1/D2，已回源码核）：
 * `ctx.skills.register()` 的 rank 是模块常量 **250**，且**无参数可改**
 * （`…\dsh-skill\lib\index.js:21` 常量、`:446` 写入、`:519-521` 升序比较 → **数值小者胜**）。
 * 六根 rank 里的 `custom`(300) / `user-dsh`(400) / `user-agents`(500) 都 > 250，
 * 所以本插件的技能盖过用户级同名技能；而 `project-dsh`(100) / `project-agents`(200) 仍会赢，
 * 这是预期的（项目级就该赢）。
 *
 * **rank 只在同一层内比较**：宿主行与 repository 插件落**全局层**，preset 挂载的插件落该
 * preset 的层；最近层的同名条目**直接胜出**、不比 rank（官方 `docs/subsystems/skills.md:13,270,286-295`）。
 *
 * TODO(G3-B)：实现 frontmatter 解析 + `register()` 调用。三个必须 fail-closed 的点：
 * 1. `content` 宿主**不校验**（`…\dsh-skill\lib\index.js:465-469` 只查 name/description/invocation），
 *    漏了要到渲染 `<skill_content>` 时才是空 —— 所以正文为空必须自己判成失败；
 * 2. `parseSkillFile` **不是公开 API**（`…\dsh-skill-filesystem\lib\index.js:891` 的导出表里没有它，
 *    且它的签名依赖 `ctx.fs` 与真实路径）→ 自己解析 frontmatter；
 * 3. 技能根路径要按**产物位置**解析：`import.meta.url` 指向 `lib/`，故 `join(MODULE_DIR, '..', 'skills')`。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SkillRegistry } from '@deepseek-ai/dsh-skill'

import type { SkillReport } from '../contracts.js'

/** 缺注册表时的报告：不是错误路径的意外，而是「这个宿主没装技能服务」的正常降级。 */
export function registerSkills(ctx: Context, skills: SkillRegistry | undefined): SkillReport {
  // TODO(G3-B)：实现时用它开 effect —— `ctx.effect(function* () { yield skills.register({...}) })`，
  // 让注册挂在 fiber 上、热重载/卸载时自动撤。当前是 stub，故先显式消费掉参数。
  void ctx
  if (skills === undefined) {
    return {
      ok: false,
      error: {
        kind: 'no-registry',
        message: '这个宿主没有 skills 服务，技能未注册（工具半边不受影响）',
        hint: '确认 profile 里挂了 @deepseek-ai/dsh-skill；或直接读 skills/dsh-plugin-debugging/SKILL.md',
      },
    }
  }
  return {
    ok: false,
    error: {
      kind: 'internal',
      message: '技能半边尚未实现（G3-B 的活）',
      hint: '见本文件顶部的契约与三个 fail-closed 点',
    },
  }
}
