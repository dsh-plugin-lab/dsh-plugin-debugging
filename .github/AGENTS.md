# .github/ — 规则层

继承根规则，见 [../AGENTS.md](../AGENTS.md)。

.github/ 特有约束：

- CI 只读：跑检查、报结果，**不回写仓库**、不自动改分支。发布是手动触发的独立工作流。
- 安装一律冻结模式（按锁文件装），锁文件与 `package.json` 不同步时**直接失败** —— 这正是要在 CI 里拦下的情况，绝不联网解析新版本。
- 本机是 Windows、CI 是 ubuntu：任何写死平台行为的判据都会在 CI 上红。平台相关判据按 [../test/tools/AGENTS.md](../test/tools/AGENTS.md) 的做法显式声明测哪条分支。
- 依赖升级只开 actions 生态：npm 依赖大半是预发布版本，自动 PR 只是噪音。
- 不写「有哪些 workflow / 各自触发条件」，那是 [README.md](README.md) 的职责。
