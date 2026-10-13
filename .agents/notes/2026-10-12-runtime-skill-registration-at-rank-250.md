# 技能走 runtime 注册（rank 250）：为什么不用 filesystem provider

状态：**部分被修正**（见下方指针）

**类型**：决策。

> **⚠️ 被修正的一步**：本文第「250 压过用户级」那一步推论**只在同一层内成立**，按发布形态**不成立** ——
> 用户级技能落 preset 层（更近），会跨层遮蔽本文这条注册。修正与后续实现见
> [2026-10-13-skill-registers-twice-dynamic-scope.md](2026-10-13-skill-registers-twice-dynamic-scope.md)。
> **本文的其余部分（为什么走 runtime、rank 的语义与方向、fail-closed）仍然生效**，
> 而且 250 依然是「同层内赢 400/500」的那个数。

## 背景

本插件的技能是**随包分发的一份排障知识本体**，同时本机**已经存在一份同名技能**：
`~/.agents/skills/dsh-plugin-debugging/SKILL.md` 与参考件 SHA256 相同，落在 user-agents 根，
rank **500**（recon-A「既成事实 F1」）。也就是说「同名竞争」不是假想，**第一天就发生**。

宿主对同名技能只按一个数裁决：`compareIndexedCandidates` = `rank差 || providerOrder差 || localOrder差`，
**升序、数值小者胜**（recon-C 命题 1 与文首「rank 方向」：`[RTp]\dsh-skill\lib\index.js:519-521`）。
各根的常量（recon-C 命题 1、recon-A F4）：filesystem 六根 = 100 / 200 / **300(custom)** / 400 / 500
（`[RTp]\dsh-skill-filesystem\lib\index.js:20-24`），**600(bundled)**
（`[RTp]\dsh-skill\lib\index.js:23`）；runtime 注入恒为 **250**（同文件 `:21`，写入处 `:446`）。

**250 的语义是「插件直接向注册表注入技能」，300 的语义是「用户配置的额外扫描目录」** ——
我们要的是前者。而且方向必须是「插件盖过用户级」；600 会把方向反过来
（用户级 500 < 600，反而被用户级盖住）。

## 决定

`ctx.skills.register()`，**不手动指定 rank**（它没有这个参数），不写任何 provider 配置。
签名 `register(skill: SkillRegistration): () => void`，返回 Cordis disposer
（recon-C 命题 2：`[RTp]\dsh-skill\lib\types\index.d.ts:257`）。

## 替代方案与被否的理由

- **A′ · `bundledSkillDir` + `@deepseek-ai/dsh-skill-filesystem`（rank 600）** —— 被否。
  字段确实存在（recon-A 二·4：`[HOST]\dsh-skill-filesystem\lib\index.js:42`），
  但 600 **比用户级 500 更低**，方向与目标相反。这就是「能不能配」与「该不该配」是两件事的样本：
  调研里 `02` 与 `06` 一份说可用、一份说禁用，其实不冲突 —— **字段存在但禁用**。
- **B · 自己写一个 provider 并标 250** —— 被否。filesystem provider 的两个 rank 是**模块级常量**，
  `Config` schema 里**没有 rank 字段**（recon-C 命题 1：`[RTp]\dsh-skill-filesystem\lib\index.js:30-43`），
  所以「自写一个 provider 标 250」要复刻一整套扫描/解析/校验，换来的只是把 300 改成 250 ——
  而 300 与 250 的差别**只在一个 custom(300) 根也存在时才显形**（recon-A 二·2）。
- **C · `customSkillDirs`（rank 300）** —— 被否，理由是语义错：300 表达的是「用户自己加的目录」，
  不是「插件自带的能力」；且它仍要经过 provider 的路径发现，等于把「我们的知识在哪儿」交给配置。
- **走文件系统的整套实现（`06` 那份）** —— **不能与本方案同时照抄**：
  recon-A 二·2 明确 `02`（runtime 路径 A）与 `06`（provider 路径）是**互斥的两套实现**，
  `06` 里「SKILL.md 路径解析」那段只在 provider 路径下成立。

## 代价与重开条件

**代价（三条，都是自己担）**：
1. 放弃 provider 的自动解析与 watch —— 技能文件的变化要靠重新 apply。
2. frontmatter 必须自己解析，因为 `parseSkillFile` **不是公开 API**（见「证据出处」第 4 条）。
3. fail-closed 自己担：`register()` 的运行时校验**不查 `content`**
   （recon-C 命题 2：`[RTp]\dsh-skill\lib\index.js:465-469`；`content` 只在 provider 路径的
   `validateDefinition` 里查，同文件 `:488`）→ 漏正文字段**当场不报错**，
   要到渲染 `<skill_content>` 才是空。所以本仓自己判三种失败（见 `docs/ARCHITECTURE.md` 第 4 节）。

**重开条件（任一成立就重新评估）**：
- 宿主给 provider 的 rank 加了配置旋钮（那 B 的代价就降到可接受）；
- 需要在 **agent preset 层**挂载本技能 —— rank 只在**同一层内**比较，
  最近层的同名条目直接胜出，而 preset 层比全局层更近（recon-A 二·2 与 `docs/ARCHITECTURE.md` 第 3 节）。

**已知边界（不要当成 bug）**：250 压得住 custom(300) 与 user(400/500)，
**压不住** project-dsh(100) / project-agents(200)；被 shadow 是**完全静默**的，没有 API 能列出被遮蔽者。

## 证据出处

1. rank 常量与方向：recon-C 文首「rank 方向」与命题 1、命题 2（源为运行时内联包 **RTp**
   0.2.1-alpha.2；行号只对该版本成立）。
2. 同名竞争已存在：recon-A「既成事实 F1」。
3. 两套实现互斥、provider rank 无旋钮、`bundledSkillDir` 字段存在但禁用：recon-A 二·2 与二·4。
4. `parseSkillFile` 非公开：那轮中转件里的「勘误」第 1 条（运行时导出只有
   `Config / FileSystemSkillProvider / apply / inject / name`，`exports` 只有 `.` / `./src/*` / `./package.json`）。
5. 决策冻结条款 D1 / D2 / D3（那一轮的中转件已按中转站的约定清理，条款已落在本文与 [AGENTS.md](../../AGENTS.md)）。
