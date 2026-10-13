# 骨架只播种、不同步：本仓偏离模板的部分是本仓自己的形状

状态：生效

**类型**：决策。

## 背景

本仓的骨架来自工作区里另一份检出的播种器：`scripts/scaffold.mjs` + `templates/plugin/`
（配方 **npm-tsc** + **--host-only**）。播种器的定位是 **seeds, not syncs** ——
给空目录铺一次骨架，**永不回写任何已存在的仓**
（工作区里另一份检出 `.agents/notes/2026-10-12-scaffold-seeds-not-syncs.md:14-24`；
判据侧在 `docs/plugin-conventions.md:51-54`）。

那条决策要解的真实张力：组织 §2 定「workflow 副本靠**逐字相同**约束、**不靠模板生成**」
（`docs/plugin-conventions.md:44-49`），而新开一个仓要手抄几十个文件。
播种器的辩解是：§2 禁的是「一处改动同时改变所有仓」，而播种器**一次只写一个新目录**，
改它不影响任何已存在的仓 ——**冲突是表面的，不是实质的**（同上 note `:18`）。

**规模感**：三仓共有路径 41 个，其中**逐字相同只有 5 个**（同上 note `:9`）。

## 决定

1. **骨架以播种那一刻的产物为起点，之后按本仓需要生长。**
   偏离模板的地方**是本仓自己的形状**，由本仓红线与 `docs/` 承担。
2. **不回写模板。** 不为「让模板更像本仓」去改 `templates/plugin/**`。
   只有变化是**判据级**的（跨仓都该成立）时才走「**先改判据、再改模板**」的顺序。
3. **5 个身份件不许动**：`.gitattributes`、`.node-version`、
   `.github/workflows/release-drafter.yml`、`.pre-commit-config.yaml`、`.prettierignore`
   —— 它们是 `scaffold check` 的比对对象（`scripts/scaffold.mjs:86-92`）。
   要加就是**有意的分歧**，必须记一句（本仓记在 `AGENTS.md` 的「活跃坑」）。
4. **模板会陈腐，唯一的守卫是在真实仓上跑 `check`**（同上 note `:41-42`）：
   `node <脚手架检出>/scripts/scaffold.mjs check dsh-plugin-debugging`

## 本仓已知的偏离（都是有意为之，不是漏铺）

| 偏离 | 为什么 | 谁承担 |
|---|---|---|
| 补 `scripts/check-release.mjs` + `package.json` 的 `check:release` | 组织判据把「发布态不变量」定为 **Must agree** 且由各仓 `check:release` 承担，而播种器 **v0 不生成**守卫脚本（同上 note `:43-47`） | 本仓脚本 + 红线 |
| 补 `scripts/release-guard.mjs` + `.github/workflows/release.yml` | 同上：v0 不生成 `release.yml`，而它的守卫步依赖守卫脚本 | 本仓 `docs/PUBLISHING.md` |
| 把 `check:release` 接进 `ci.yml` 的 `verify` job | 让「发布前才发现」提前成「每次推送就发现」 | `ci.yml` + 收口 job 三条规矩 |
| `files` 加 `skills`、`exports` 加 `./skills/*` | 技能随包分发是本仓第一个（组织现有三仓都不带技能） | `scripts/check-release.mjs` 的两条断言 |
| 补 `docs/PUBLISHING.md` | 组织判据要求「发布前确认要发的提交已在远端」落在**各仓 `docs/PUBLISHING.md`**（`docs/plugin-conventions.md:178`），而 v0 只铺 `docs/.gitkeep` | 本仓 |

**注意**：播种器**不生成**继承层的社区健康文件（`CONTRIBUTING.md` / `SECURITY.md` /
`SUPPORT.md` / `CODE_OF_CONDUCT.md` / `PULL_REQUEST_TEMPLATE.md` / `.github/ISSUE_TEMPLATE/`）
—— 这是**有意**的，它们由工作区里另一份检出回退提供，本仓**不该**自带（`docs/plugin-conventions.md:22-31`）。
「本仓没有这些文件」不是缺件。

## 替代方案与被否的理由

- **做成同步器（`scaffold sync` 刷进已存在的仓）** —— 被否：那正是 §2 要防的事 ——
  已存在的仓会因为一次模板编辑而变，**且那个变不在它们的 diff 里**
  （同上 note `:30-31`，重开条件也写在那里）。
- **手工复制三仓的文件** —— 被否：成本不在「一份文件」，而在「哪些必须一样、哪些允许不同」
  这个判断每次都要重做一遍，而判断错是**静默**的（少一个 `AGENTS.md`、徽章形状漂了）
  （同上 note `:28-29`）。
- **只做清单、不做程序** —— 被否：它已经是判据文档的第三节，再加一份就是同一事实的第二处，
  而且**没有执行体**（同上 note `:32-33`）。
- **改模板来「对齐本仓」** —— 被否，见「决定」第 2 条：方向反了。
  模板是判据的副本，不是本仓的副本。

## 代价与重开条件

**代价**：模板与判据**都**会陈腐，而本仓只会偶尔跑一次 `check` ——
「模板漂了但没人发现」因此是可能的，唯一缓解就是那条 check 真的跑起来。
另一个代价是**偏离本身需要记录**：偏离一处不记，下一个人会以为那是漏铺（上表为此存在）。

**重开条件**（写在组织侧，任一条成立时重新评估要不要变成同步器）：
**插件仓达到 6 个以上**，或出现**第二个「跨配方都成立」的骨架要求**（同上 note `:48`）。

## 证据出处

1. 播种器的定位、边界、被否方案、重开条件：工作区里另一份检出
   `.agents/notes/2026-10-12-scaffold-seeds-not-syncs.md`（`:9`、`:14-24`、`:26-35`、`:41-48`）。
2. 身份件清单与比对实现：工作区里另一份检出 `scripts/scaffold.mjs:86-92`（`IDENTITY_FILES`）、
   `:333-380`（`check`）；判据侧 `docs/plugin-conventions.md:205-208`。
3. 回退层不该自带哪些文件：工作区里另一份检出 `docs/plugin-conventions.md:22-31`；
   「发布前确认远端」的落点要求：同文件 `:178`。
4. 决策冻结条款 D10 / D12 与本仓的 G7 备件（那一轮的中转件已按中转站的约定清理，条款已落在本文与 [AGENTS.md](../../AGENTS.md)）。
