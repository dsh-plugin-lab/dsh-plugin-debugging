# skills/ — 技能载荷与它的开发者文档

## 两种东西，长得像但性质相反

| 文件 | 是什么 | 谁读它 | 随 npm 包发 |
|---|---|---|---|
| 子目录里的 `SKILL.md` | **运行时载荷**：实测得来的宿主知识 | 宿主技能服务 → 模型 | 必须发 |
| 本目录与子目录的 [AGENTS.md](AGENTS.md) / [README.md](README.md) | 开发者规则与手册 | 维护者 / agent | 在发，但是噪声 |

**`SKILL.md` 是产品，不是文档。** 它由 [../src/skills/register.ts](../src/skills/register.ts) 在启动时读走、解析 frontmatter、交给宿主技能服务，模型读到的就是它。

- 它**没有「源文件 vs 产物」的关系**：不跟 `src/` 同步，改了也不必重新编译。
- **删掉它不会让插件崩溃** —— 工具半边都是代码，照样工作；技能只是静默消失，[../scripts/check-release.mjs](../scripts/check-release.mjs) 才拦得住。
- 要改它的内容，改这里；要改它**被注册**的方式，改 `../src/skills/` —— 两边不互相生成。

「包里发维护者文档」是噪声但不是 bug（对使用者无害）；要收紧随包范围，改 [../package.json](../package.json) 的 `files` 字段。

## 目录约定

- 一个技能一个子目录，目录名与技能名同名且为 kebab-case；宿主按目录名找正文。
- 清单以本目录树为准，本文不复制。
- 正文该写什么 → 子目录 [README.md](dsh-plugin-debugging/README.md)。
- 在目录里工作要遵守什么 → [AGENTS.md](AGENTS.md)。
- 变更影响路由：改正文 → 同步 [../src/skills/](../src/skills/README.md) 与 [../docs/SHAPE.md](../docs/SHAPE.md)；改技能名或目录结构 → 同步 [../scripts/check-release.mjs](../scripts/check-release.mjs) 与 [../test/redlines.test.ts](../test/redlines.test.ts)；必跑 `npm test` 与 `npm run check:release`。
