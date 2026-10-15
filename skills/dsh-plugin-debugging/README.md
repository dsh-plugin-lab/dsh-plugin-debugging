# dsh-plugin-debugging/ — 排障知识本体

- 职责：随包分发的技能正文，是插件对外的**知识层**。宿主技能服务加载它，模型据此排障；工具只是其中可机械判定那部分的加速器。
- 结构：frontmatter（路由信号）+ 正文。正文分节按「生效机制三档」与「三类症状」组织，**分节以正文自身的标题为准**，本文不复制目录。
- 谁依赖它：[../../src/skills/register.ts](../../src/skills/register.ts) 在运行时读它并注册进宿主；宿主渲染技能内容时交给模型。
- 与工具的关系：工具对应正文里的判据段落；正文写「怎么判断」，工具给「判断结果」。两者不一致时以正文为准，工具的契约见 [../../docs/SHAPE.md](../../docs/SHAPE.md)。
- 变更影响路由：改正文 → 同步 [../../src/skills/README.md](../../src/skills/README.md) 与 [../../docs/SHAPE.md](../../docs/SHAPE.md) 的推进排期；改 frontmatter → 同步 [../../test/redlines.test.ts](../../test/redlines.test.ts) 的 frontmatter 与随包断言；必跑 `pnpm run test` 与 `pnpm run check:release`。
- 使用约束与工作偏好 → 见 [AGENTS.md](AGENTS.md)。
