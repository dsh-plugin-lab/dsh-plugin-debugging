# skills/ — 规则层

继承根规则，见 [../AGENTS.md](../AGENTS.md)。

括号里的编号指 [../AGENTS.md](../AGENTS.md) 的活跃坑。

skills/ 特有约束：

- 本目录是**随包发布**的产物：清单与打包字段由 [../scripts/check-release.mjs](../scripts/check-release.mjs) 断言，改动必须让那条断言真的成立。
- **正文不是可再生的中间物**：它是技能半边唯一的载荷，改它不需要重新编译，也不跟 `src/` 同步。
  **删它不会让插件崩** —— 工具半边照常工作，技能只是静默消失。要删先看 [../scripts/check-release.mjs](../scripts/check-release.mjs) 拦不拦得住。
- 目录名与技能名同名，且技能名必须是 kebab-case；宿主按目录名找正文，目录改名等于换技能。
- 正文按**产物位置**被解析（从注册模块上溯两级到包根），所以技能名与目录结构都不能动。
- 写路径 glob 时不许用 `**/`：它在块注释里会提前终止注释（坑 17）。
- frontmatter 的值含 `: ` 时要按 YAML 惯例加引号，否则技能静默失效；`description` 必须是单行标量（坑 3 的成因在 [../src/skills/AGENTS.md](../src/skills/AGENTS.md)）。
- 不写「有什么文件 / 正文怎么组织」，那是 [README.md](README.md) 的职责。
