# 宿主兼容性的门是 `peerDependencies`，不是 `engines.dsh`

状态：生效

**类型**：决策（实测）。

## 背景

调研资料按「`engines` 是兼容性声明」的常规心智推荐了 peer 范围 `>=0.1.7 <0.2.0`
（recon-A 二·6：`01:349`）。本条是**回源码核过之后推翻它**的记录 ——
它是「文档写的机制与实际执行的机制不一致」的样本。两件事在源码上同时成立：

1. **`engines.dsh` 没有任何读取者。** 类型注释自陈它是 *declarative until a reader enforces it*
   （recon-C 命题 8：`[RTp]\dsh-package-manifest\lib\types\types.d.ts:22`、`:54-57`）。
   recon-C「①」第 3 条的做法是对运行时全树递归 grep `"engines"`：7 个命中**全部**是别的包自己的
   engines，**无一处读 `package.json.engines.dsh`**。这是**肯定性缺失** —— 靠 0 命中得出。
2. **真正生效的门读 `peerDependencies`，且带 `includePrerelease: true`**（recon-C 命题 8：
   `[RTp]\dsh-app-boot\lib\index.js:294-300`，bundle 路径强制在 `:1011-1012`；
   安装前 preflight 在 `[RTp]\dsh-plugin-manager\lib\index.js:533-541`）。

**差别的量级**（recon-C 命题 8 与文末「semver 实测输出」，用运行时自带的 semver **7.8.5**）：
对在跑的宿主 `0.2.1-alpha.2`，`^0.1.7-rc.1 || ^0.2.0-rc.1` 裸推演 **false**、
加 `includePrerelease` **true**；而 `>=0.1.7 <0.2.0` **两种情况都是 false**。
即：**答案取决于是否带 `includePrerelease`，而宿主用的正是带的那个。**

## 决定

- **兼容性只由 `peerDependencies` 承担**：`engines.dsh` 保留，但当**声明**（写出来给人看），**不当门**。
- 每个 `@deepseek-ai/dsh-*` 的 peer 与 dev 区间、以及 `engines.dsh`，**三处同值**
  （peer↔dev 同值是组织判据的 Must agree）。本仓现状：`package.json` 里这三处逐字相同。
- **改一处就得改另一处**：范围是一个事实的多处落点，漏改不会有任何提示。

## 替代方案与被否的理由

- **只写 `engines.dsh`，不写 peer** —— 被否，且这是**最坏的一种错**：
  它看起来声明了兼容性，实际**完全不生效**。
- **照调研写 `>=0.1.7 <0.2.0`** —— 被否：对当前运行时**两种情况都不匹配**，后果见「代价」（静默）。
- **把「`dsh plugin add` 会硬失败」当成足够的安全网** —— 被否：它挡的是「安装」，不挡「profile 加载」。

## 代价与重开条件

**代价：失败是静默的，而且以「插件像没装一样」的样子出现。** profile 加载路径把兼容性错误
**`catch` 进 `skippedBundles`**（recon-C 命题 8：`[RTp]\dsh-app-boot\lib\index.js:1006-1026`）→
**进程照常启动、插件消失、没有任何报错**。所以「peer 范围写错」在排障时第一眼像「根本没装」。

**执行体（已落，不是散文）**：`test/redlines.test.ts` 两组红线 —— **A1**「peer 与 dev 逐条相等」
（`judgePeerDevAgreement`，含两条**反向控制**：dev 改一个字符、只有 peer 缺 dev，都必须红）；
**A2**「`engines.dsh` 与每个 `@deepseek-ai/dsh-*` 区间逐字相同」（`judgeEngineRangeAgreement`，
并断言承诺的族不只一族）。组织判据把这两条定为 **Must agree** 并写明「has to become a check」。

**重开条件**：宿主给 `engines.dsh` 加了读取者（那时两套声明都可能生效，要重新决定谁是门）；
或 `peerDependencies` 的判定语义改了（例如去掉 `includePrerelease`）——
那会**改变区间形状的正确答案**，而形状错了同样是静默的。

## 判据的能力边界（A1/A2 守什么、守不住什么）

**它们守的是「内部一致」，不是「值正确」。** A1 只比 peer 与 dev 是否同值；A2 只比
`engines.dsh` 与各 `dsh-*` 是否同值。**两者都不看区间本身对不对。**

**反例（必须知道）**：把 `engines.dsh` 与全部 `dsh-*` **一起**改成那套被否的 `>=0.1.7 <0.2.0`
—— **A1 全绿、A2 也全绿**（三处仍同值），CI 静默通过，而后果正是「代价」里那条「插件像没装一样」。
**同值 ≠ 正确。**

**那什么测试才真能拦住改错区间？单测原理上拦不住** —— 区间的正确性依赖**外部事实**
（宿主当前那条线指向哪个版本、`includePrerelease` 的语义），宿主一升级，昨天正确的值今天就错，
而测试跑在仓里、读不到这个事实。要挡住它，判据必须引入**仓外真源**：拿 registry 上的实际版本
去匹配区间（姊妹仓 zhihu / balance 的 `check:declaration.mjs` 走的就是这条路；
**本仓当前没有这一层**）。所以现阶段区间正确性只能靠三件**人的动作**：
① 现查宿主线（`npm view @deepseek-ai/dsh dist-tags`）；② 发布前复核
（`docs/PUBLISHING.md` 的「发版前确认」）；③ 真机装一次（装载失败是静默的，只有真装能证）。

**一句话：A1/A2 能防「漂」，不能防「错」。**

## 证据出处

1. 门是 peer + `includePrerelease`、`engines.dsh` 无读取者、失败进 `skippedBundles`：
   recon-C 命题 8 与「①」第 3 条（源为运行时内联包 **RTp** 0.2.1-alpha.2，行号只对该版本成立）；
   semver 实测输出（7.8.5）见 recon-C「附」。
2. 被否的调研范围 `>=0.1.7 <0.2.0` 及其后果：recon-A 二·6、recon-A 一·16。
3. 本仓声明现状与执行体：`package.json` 三处同值；`test/redlines.test.ts` 的 A1/A2。
   设计侧叙述（不在本文件重复）：`docs/ARCHITECTURE.md` 第 7 节。
