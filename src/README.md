# src/ — 宿主半边入口与共享契约

- 职责：插件的挂载点，以及两个半边唯一共享的类型。
- `index.ts` 导出 Cordis 生命周期三件（`name` / `inject` / `apply`）与配置、契约类型；宿主直接引用它，改动要同步核对 [cordis.patch.yml](../cordis.patch.yml) 的挂载假设。
- `config.ts` 是配置 schema，默认值即文档；改配置项要同步 [../docs/SHAPE.md](../docs/SHAPE.md)。
- `contracts.ts` 只放类型、不放逻辑，是工具半边与技能半边并行开发的唯一共享面。
- 子树：`lib/`（纯函数与 IO 层）· `tools/`（工具半边）· `skills/`（技能半边）。
- 变更影响路由：改这里 → 同步根 [AGENTS.md](../AGENTS.md)；改配置项或输出契约 → 同步 [../docs/SHAPE.md](../docs/SHAPE.md) 与 [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)；必跑 `npm run check`。
- 使用约束与工作偏好 → 见 [AGENTS.md](AGENTS.md)。
