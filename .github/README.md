# .github/ — 托管侧配置

- 职责：仓库在 GitHub 上的自动化配置 —— 工作流与依赖升级。
- 目录：`workflows/`（工作流）· `dependabot.yml`（依赖升级节奏）。
- 门禁与发布态：工作流跑的命令与本仓 [../package.json](../package.json) 的脚本同名，跑法见根 [../AGENTS.md](../AGENTS.md) 的常用命令。
- 本地钩子与 CI 分工：本地自动修、CI 只读；两者用同一工具同一版本（判据见 [../.pre-commit-config.yaml](../.pre-commit-config.yaml)）。
- 变更影响路由：改这里 → 同步根 [../AGENTS.md](../AGENTS.md) 的 CI 指针与待办；改要跑的脚本 → 同步 [../package.json](../package.json)；本机门禁照旧在开 PR 前跑完。
- 使用约束与工作偏好 → 见 [AGENTS.md](AGENTS.md)。
