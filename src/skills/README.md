# skills/ — 技能半边

- 职责：把随包分发的技能正文注册进宿主技能注册表，并汇报注册结论。
- 出口是一个 `SkillReport`，类型在 [../contracts.ts](../contracts.ts)；**绝不抛** —— 注册失败不是插件的失败，工具半边照常工作。
- 同一份技能注册**两次**：全局层一次，另一次进每个活跃 agent 的作用域，让它在同层仲裁里真的赢过用户级同名技能。理由与被否决的方案见 [../../.agents/notes/](../../.agents/notes/) 里那条「技能注册两次」的记录。
- rank 是升序、数值小者胜，且只在**同一层内**比较；被遮蔽是完全静默的，没有 API 能列出被遮蔽者。
- 本目录不碰 `ctx.tools`，被 [../tools/](../tools/README.md) 反向依赖的只有 `contracts.ts` 的类型。
- 变更影响路由：改这里 → 同步技能正文（[../../skills/dsh-plugin-debugging/SKILL.md](../../skills/dsh-plugin-debugging/SKILL.md)）与 [../../docs/SHAPE.md](../../docs/SHAPE.md) 的形态；覆盖映射见 [../../test/skills/README.md](../../test/skills/README.md)；必跑 `pnpm run test`。
- 使用约束与工作偏好 → 见 [AGENTS.md](AGENTS.md)；根规则见 [../../AGENTS.md](../../AGENTS.md)。
