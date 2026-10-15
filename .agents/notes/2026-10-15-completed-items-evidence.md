# 已完成项的完整证据

状态：已归档 —— 它记的是「当时为什么」，**不追改**；根 [AGENTS.md](../../AGENTS.md) 的「待办」只留还开着的条目与指向本文件的指针。

**为什么有这一篇**：根 [AGENTS.md](../../AGENTS.md) 是**每个会话都自动注入**的规则层，而它当时把**已完成条目的完整证据链**
（时间戳、回执字段、pid、会话 id、逐帧日志结论）也放在里面。那些是「当时为什么」，不是「现在要遵守什么」
—— 按本仓规则 belong 在 notes，而且**不注入才不占上下文**。

---

## 1. `dsh_restart` 的 marker 被恢复半真消费

✅ **已闭合（2026-10-15）** —— 「工具壳写出的 `armed` marker 被恢复半真消费」**已在真宿主上发生**。

形态（四道闸 / 审批门 / marker / 恢复）见 [docs/SHAPE.md](../../docs/SHAPE.md) §6.1；宿主侧的拉起 / 恢复 / 退出契约见
[docs/HOST-CONTRACTS.md](../../docs/HOST-CONTRACTS.md) §2。

**证据（回执 `$DSH_HOME/dsh-plugin-debugging/restart/last-attempt.json`，逐字）**：
`outcome: recovered` · `markerStateAtRead: armed` · `markerConsumed: true` ·
`detail: the restart notice was delivered to 1 session(s) and the marker was marked consumed`；
盘上 `marker.json` 随即变 `consumed`。那份 marker 由**工具壳**写（四道闸 → 审批门 → 写 marker →
拉起 → `appExit`，2026-10-14 23:50），**不是探针手工复现** —— 原先欠的正是这一句。

✅ **「同一次运行里串起来」已验**（2026-10-15 真机）：请求 `10:38:05Z` → 新进程 **+11s**（与 `ping -n 11`
的 10s 宽限吻合）→ 恢复 `10:39:46–51` → notice `10:39:54` 落进**发起者**会话；回执 `outcome: recovered` ·
`markerStateAtRead: armed` · `markerConsumed: true` · `delivered to 1 session(s)`。

**时序从 `49401s`（13.7 小时）修成 `103s`** —— 上一版把「恢复很慢」当成了机制，实际那 90 秒在
**宿主启动 → 本插件 `apply`** 之间（`apply` 里只等一个 1 秒定时器，我们自己的延时上界 ≤5s）⇒ **不是我们的延时**；
但那 90 秒的归因**仍未定**（那次启动没留档）。

⚠️ **仍未被触发的**：回执里 `markerReadAttempts: 1` ⇒ 服务一次就绪，**「服务晚到则轮询」那条路这次又被绕开**
（apply 晚了 90 秒，早过了那个「宿主刚起 1–2 秒」的窗口）。

## 2. 重启成功路径的 verdict 曾从未落盘

✅ **已闭合（2026-10-15 真机复验）**：`exit(0)` 曾排在 `return` 之前 ⇒ 模型对一次不可逆动作拿到 `outcome unknown`。
已改为把退出排到下一个宏任务（记录走微任务链，先排空），台架判红 / 变异已验（挪回去 ⇒ 4 红）。

**真机判据已过**：逐帧解会话日志，同一个 `callId` 的 `tool/call` 后面跟着**配对的真 `tool/result`**（含那句 verdict）
—— **不是** `interrupted-tool-result-*`；对照之下 2026-10-14 那次真重启的同一位置**正是** `interrupted-tool-result-*`
（旧缺陷的形状）。⇒ 一条命令、一台宿主，只差代码版本的 A/B。

⚠️ 该修复有一个**刻意的语义后果**：退出通道抛异常时结果已交付，**结构化 `internal` 失败这条路不存在了**；
新的落点改成「结论照样到 + 异常不吞 + marker 留在 `armed` 供下次启动报未完成」。

## 3. 客户端半边（拍板反转）

✅ **已闭合（2026-10-15）**。

**这条的形态是「保留反转前的决策记录」**：`dsh.client` + `keyed tool.call.toolview` 曾于 2026-10-14 拍板**不做**，
2026-10-15 拍板**反转：做**。10-14 那条决策及其理由**保留在此**，记的是「当时为什么」；反转后的形态见下。

**反转的起因**：要给 `dsh_restart` 做一个配置开关（默认关 + 结构化拒绝），
而「配置改动能丝滑生效、不要求重启」需要客户端面来承载那个开关。

⚠️ **10-14 记的三项代价因此全部落地**，实现时逐条对照：
① 新构建产物**要进 `files`** 并过 `check:release`（发布态不变量）；
② keyed 条目要在 call / result **两侧可重放**；
③ **加 `dsh.client` 要重启宿主一次** —— 这是**装上客户端半边**那一次。

⚠️ **但「开关值改动」本身不需要重启**（靠 schema 的 `.volatile()`，宿主侧机制见活跃坑那一族）
—— 这两件事**别混**：前者是一次性的安装代价，后者是日常操作的性质。

[docs/SHAPE.md](../../docs/SHAPE.md) §8.5 / §9.2 的「已评估、不做」记录**已随本次反转作废**。

## 4. 非 Windows 的端口识别

✅ **已落地（2026-10-13）**（Windows / Linux / macOS 三平台；Linux 走 `ss` 两档、
macOS 走 `lsof` → `netstat`；方案表在 [src/lib/ports.ts](../../src/lib/ports.ts) 的 `portLookupPlan`，
**别在文档里抄命令名**）。

**这层能被 CI 真验**（CI 在 ubuntu 上），与「只能本机红线」的项不同。

⚠️ 三值互不重叠：`probed:false`（查不了）/ `listening:false`（没人听）/ `listening:true + unidentified`
（有人在听但读不到 pid）。**压成两值就是反向结论。**

## 5. 红线批 2b：六条已全部落地

✅ **已闭合（2026-10-13 核）**：`B17 / B20a / B20b / B18a / B21 / B24`。

真源是 [test/redlines.test.ts](../../test/redlines.test.ts) 里 `describe('B…')` 的闭集，
规则与逐条判据见 [docs/SHAPE.md](../../docs/SHAPE.md) §10。其中 **`B24`** 是 SHAPE §4 说的
「契约的承载条件」（`execute` 全路径不抛）。**B17 的取值面是** L1/L2 ∪ 目标工具自己的描述；
**空转口清单**见 SHAPE §10.0（不在这里抄条数）。

## 6. 收敛重复的测试助手

✅ **已闭合（2026-10-13 起，2026-10-15 收尾）**。

**第一轮**：`renderText` / `splitRender` / `sharedSubstrings` 三条各从 5/5/3 份合成 1 份，
[test/tools/helpers.ts](../../test/tools/helpers.ts) 只增不改既有导出。实测净减 **183 行**
（此前估的 350–500 与更早的 800–1000 都偏高：这三条助手本体只有 3–18 行，大头是各自的注释，
而接收方要一次性付掉定义成本）。**用例数前后未变**，即没有丢断言。

**收尾（2026-10-15）**：`test/redlines.test.ts` 里的 `withPlatformRedline` 与
[test/tools/helpers.ts](../../test/tools/helpers.ts) 的 `withPlatform` 语义同构但非逐字同构
（2026-10-14 实测三处差异：`fn` 的类型一个是 `() => Promise<T>`、另一个是 `() => Promise<T> | T`；
拿不到属性描述符时的错误文案一个英文一个中文；一个 `export` 一个不导出），
连同 `test/tools/timeout-budgets.test.ts` 里那份同源的 `stripComments` 一并收敛。
**用例数收敛前后未变**（没丢断言）。

⚠️ **合并时两边的实测证据都留住了**（一份是「整段删块注释导致后面行号整体前移」、
一份是「漏了 `-o` 会假红 / URL 里的 `//` 会吞掉同一行后面的真违规」）—— 压成一句空话等于把两个教训并成一个。
现口径与分工见 [test/tools/AGENTS.md](../../test/tools/AGENTS.md)。

**唯一仍内联的**是 `test/redlines.test.ts` 里那份 `stripComments` 的**判据语料**（红线要连注释一起剥）
—— **有意保留的例外**，不是漏网的债。

## 7. 两条独立复验留下的残余

✅ **已闭合**（两条都不影响模型决策，方向安全，故当时未阻塞发布）：

① `resolvedDir` 对 `link:` 包报 realpath，偏离宿主的 `packageDirFromAnchor`（只进 `audit`，不进 `key`）；
② 凭据存在性扫描对 `records` 段内**更深层**的同名键会判 true（需 `grant` + 同名键同时出现才触发）。
