# 门面图不进 npm 包：4 MB 动画横幅让市场的每轮构建慢在了一个包上

**日期**：2026-10-20 ｜ **状态**：生效

## 现象

市场每小时从 npm 抓四个插件包，只为读包里的 `locale/` 与图标。实测那一轮：

| 包 | `dist.unpackedSize` | 单次下载 |
|---|---|---|
| `dsh-zhihu-search` | 263,096 B（257 KB） | 1–2 秒 |
| `dsh-ds-balance` | 530,509 B（518 KB） | 1–2 秒 |
| `dsh-workbuddy-bridge` | 502,196 B（490 KB） | 1–2 秒 |
| **`dsh-plugin-debugging`** | **5,304,492 B（5.18 MB）** | **16 秒（占整轮下载 91%）** |

## 事实（2026-10-20 本机实测，不采信转述）

`package.json` 的 `files` 里写着 `"assets"`，**整目录进包**。`assets/` 一共 4,094.6 KB，其中：

| 文件 | 字节 | 引用位置 |
|---|---|---|
| `banner.gif` | 4,125,387 | **只有** `README.md:8` / `README_zh.md:8`（门面横幅） |
| `invoke-skill.png` | 32,471 | **只有** `README.md:51` / `README_zh.md:51`（一张截图） |
| `launcher.js` / `.d.ts` / `.vbs` / `show-window.vbs` / `stop-window.ps1` | 共 35,032 | `src/lib/restart.ts`、`src/tools/dsh_restart.ts`、`test/assets.test.ts`、`test/launcher.test.ts` —— **代码在运行期按包内路径找它们** |

`banner.gif` 是 **GIF89a 动画：113 帧、480×206**。它是 2026-09 那次「门面横幅由 PNG 换成动图 GIF」（`decc052`）刻意换成动画的。

结论：**整包 78.4% 的体积是给 README 看的两张图**，而 README 的显示不需要它们出现在 npm 包里。

## 决策

1. `files` 保留 `"assets"`（运行期资产照旧自动随包），**追加两条排除**：
   `"!assets/banner.gif"`、`"!assets/invoke-skill.png"`。
2. 两份门面改用**绝对 raw URL** 引用这两张图。
3. 新增红线 **B31**（`test/redlines.test.ts`）：两条排除在、两个绝对 URL 在、文件在仓里、**运行期资产仍在包里**。

## 为什么不选另一条路，或为什么不顺手做别的事

- **只加排除、README 保持相对路径**：npm 页面上的图会怎样，取决于 npm 如何改写 README 里的相对 `src`
  —— 这一点在编写时**无法核实**（npmjs.com 对无浏览器的请求返 Cloudflare 挑战）。改绝对 URL 在
  GitHub 与 npm 两边都成立，**不依赖**那个行为。用一条不确定的机制去换 32 KB 的改动量，不划算。
- **改成把 `files` 收窄成显式白名单**（列出 5 个运行期资产）：会引入一种更坏的失败 ——
  将来新增运行期资产时它**静默不进包**，而 `test/assets.test.ts` 从磁盘读文件、照样绿，
  只有真机上才炸。整目录 + 两条排除的方向相反：新增运行期资产自动进包，新增门面图最多让体积长回去（B31 会红）。
- **把 4 MB 动画 GIF 换成 WebP**：这属于**门面改动**，与「包里不该有它」是两件事。实测两个候选：
  - 动画 WebP（`-c:v libwebp_anim -q:v 70`）：**2,192,996 B** —— 只减 47%，动画还在，但仍是 2 MB；
  - 静态 WebP（首帧）：**41,774 B** —— 减 99%，但**动画没了**，而动画是 2026-09 特意换的。
  两者都不是「顺手」能定的：前者收益不够、后者是刻意回退作者的视觉选择。**建议另开一次门面改动**讨论，
  本轮不动。

## 结果（`npm pack --dry-run`，同一棵树、同一 npm 12.0.1）

| | 文件数 | unpacked | tarball |
|---|---|---|---|
| 改前 | 89 | 5,300,676 B（5.06 MB） | 4,498,980 B（4.29 MB） |
| 改后 | 87 | 1,143,176 B（1.09 MB） | 399,821 B（0.38 MB） |
| 差 | −2 | **−4,157,500 B（−78.4%）** | **−4,099,159 B（−91.1%）** |

## 连带发现

- 四个包里只有本仓有这个问题；另外三个的 `files` 都不含大图（`dsh-zhihu-search` 的门面横幅是
  `assets/banner.svg`，随包但它本身只有十几 KB，且 `<img>` 用的是相对路径 —— 未复核它在 npm 页面的显示）。
- 本仓 `files` 里没有别的「其实不该进包」的东西：`README*.md`、`LICENSE`、`cordis.patch.yml`、
  `skills/.../SKILL.md`、`locale/*.json`、`icon.svg` 都是发布态需要的，`lib/**/*.map`
  早已排除（打包结果里 0 个 `.map`，说明取反条目这条机制在本仓是有效的）。
