# test/skills/ — 技能注册半边的覆盖

- 职责：技能注册的自动化判据，含三个 fail-closed 分支与动态 scope 注册。
- 夹具在本目录的夹具子目录，一个夹具对应一种坏法（命名即判据）；**夹具清单以目录树为准**，本文不复制。该目录是纯数据，不建双件。
- 用注入口把技能根指到夹具，覆盖面按分支走：缺文件、frontmatter 不合规、正文为空、注册表缺席。
- 变更影响路由：改 [../../src/skills/](../../src/skills/README.md) → 同步本目录的夹具与覆盖映射；改技能正文 → 同步 [../../skills/dsh-plugin-debugging/SKILL.md](../../skills/dsh-plugin-debugging/SKILL.md) 的相关红线；必跑 `npm test`。
- 使用约束与工作偏好 → 见 [AGENTS.md](AGENTS.md)。
