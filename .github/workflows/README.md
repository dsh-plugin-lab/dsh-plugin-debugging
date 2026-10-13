# workflows/ — 工作流

- 职责：仓库的自动化定义 —— 日常门禁、发版、发布草稿维护。
- **清单以本目录为准**，本文不复制；每个文件的触发条件与跑法写在它自己的文件头。
- 日常门禁跑的类型检查、构建与全量测试，与本仓 [../../package.json](../../package.json) 的脚本同名；发版前还跑发布态检查，见 [../../scripts/README.md](../../scripts/README.md)。
- 发布流程、发之前要核什么、出错了怎么办 → [../../docs/PUBLISHING.md](../../docs/PUBLISHING.md)。
- 变更影响路由：改这里 → 同步根 [../../AGENTS.md](../../AGENTS.md) 的 CI 指针；改门禁范围 → 同步本机钩子配置；必跑本机全部门禁（跑法见根文档）。
- 使用约束与工作偏好 → 见 [AGENTS.md](AGENTS.md)。
