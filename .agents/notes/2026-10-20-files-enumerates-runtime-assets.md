# 决策：`files` 逐条列举运行期资产，不再列整个 `assets/` 目录（2026-10-20）

状态：生效

## 问题

组织仓的每周检查（`scripts/check-criteria.mjs` 的 `package-not-readme-images`）把本仓的 `files`
判成**真缺陷**，登记在 [dsh-plugin-lab/.github#8](https://github.com/dsh-plugin-lab/.github/issues/8)：

```json
"assets", "!assets/banner.gif", "!assets/invoke-skill.png"
```

这是「整目录 + 按名排除」—— **新增一张截图会静默进包**，而判据要的方向正好相反。裁决依据是
公约 [plugin-conventions.md §2](https://github.com/dsh-plugin-lab/.github/blob/main/docs/plugin-conventions.md)：

- `files` **不列** `assets/` 目录；
- 排除的是**具体文件**，不是整个目录 —— 这样「新加一张截图不会悄悄进包」；
- 但**运行期资产仍然要进包**，否则插件运行时会找不到文件。

注意这一篇**取代**[上一篇](2026-10-20-readme-images-out-of-tarball.md) 的 §6：那一节当时明确
否决过「收窄成白名单」，理由见下面的替代方案表 —— 那条理由**没被推翻**，所以这次把它一起堵掉了。

## 决策

`files` 从「整目录 + 两条排除」改成**逐条列举 5 个运行期资产**：

```json
"assets/launcher.js",
"assets/launcher.d.ts",
"assets/launcher.vbs",
"assets/show-window.vbs",
"assets/stop-window.ps1",
```

两张门面图（`banner.gif` 4.0 MB、`invoke-skill.png` 32 KB）从此**不在任何条目覆盖范围内**：
不是被排除，而是压根没被列举。

## 替代方案

| 方案 | 否决理由 |
|---|---|
| 保持「整目录 + 两条排除」（现状） | 方向反了：新截图默认进包。这是组织级 **Must agree** 档，长期靠 `known-findings.json` 豁免等于把判据降成建议 |
| 保留整目录，去改判据承认这种写法 | 判据是四个插件仓共用的；为一个仓不愿改两行 manifest 去松动判据，代价落在别人身上 |
| 整目录 + 给现存每个文件都写一条 `!` 排除 | 同样反方向：排除仍按名列举，新文件默认进包 |
| 逐条列举但**不加**兜底断言 | 这正是上一篇 §6 否决白名单的理由 —— 新增运行期资产会**静默缺席**（`test/assets.test.ts` 从磁盘读，照样绿，只有真机才炸）。理由成立，所以这次把兜底一起做（见下） |
| 把两张图从仓里删掉、README 不再放图 | 门面图是给人看的入口，删图是门面决策，不在「图不该进包」这件事里 |

## 代价与补偿

**代价**（如实记）：运行期资产变成白名单形态 —— 以后新增一个 `assets/` 下的运行期文件，
如果忘了写进 `files`，它会**静默不随包**。

**补偿**：红线 B31 新增一条兜底断言「`assets/` 里每个文件要么是门面图、要么被 `files` 列举」
（[test/redlines.test.ts](../../test/redlines.test.ts)）。新增任何一类文件都会当场红，红的时候
自然要求人决定它该不该随包 —— 把静默缺席变成红，这是上一篇 §6 那条否决理由要求的补救。

## 实测

`pnpm pack` 的实际包清单（2026-10-20，本机，`tar -tzf`）：

- `package/assets/` 下**只剩 5 个运行期文件**：`launcher.js` / `launcher.d.ts` / `launcher.vbs` /
  `show-window.vbs` / `stop-window.ps1`；
- `banner.gif` / `invoke-skill.png`：**0 命中**；
- `icon.svg`、`locale/en.json`、`locale/zh.json`、`skills/dsh-plugin-debugging/SKILL.md`、
  `cordis.patch.yml`、`lib/**`、两份门面、`LICENSE` 照旧在包里；
- 整包 **90 条 / 402,357 B**（tarball）。

**与改前逐条对比**：把同一棵树换回旧写法再 `pnpm pack`，两包的**文件清单逐条相同**
（90 条；402,338 B vs 402,357 B，差值只是 tarball 头部的 mtime）—— 这次改的是**方向**，
不是今天的清单，所以体积与内容一分没变。

## 影响

- `package.json` 的 `files`。
- `test/redlines.test.ts` 的 B31：判据从「四面」扩到「五面」（新增「写法本身」那一面）；
  新增两条断言（不出现整目录条目、`assets/` 里没有没被列举的文件）；**变异 2 改写** ——
  旧写法下的「删掉 `!assets/` 取反条目」已不存在，同一意图的新变异是「把逐条列举换回整目录」。
- 反向控制（两条都实测会红）：换回「整目录 + 按名排除」→ 「不出现整目录条目」那条红；
  往 `assets/` 放一个没被列举的文件 → 兜底断言红并点出文件名。
- 上一篇记录：[门面图不进 npm 包，README 一律用相对路径](2026-10-20-readme-images-out-of-tarball.md)
  （§2 结论仍成立：两张图确实不在包里；§6「不收窄成白名单」被本篇取代）。
