# 技能要注册**两次**：动态 scope 注入让它在 preset 层赢

状态：生效

**类型**：决策（**修正** [2026-10-12-runtime-skill-registration-at-rank-250.md](2026-10-12-runtime-skill-registration-at-rank-250.md)
里「250 天然压过用户级」这一步推论；runtime 注册这个决定本身不变）

## 背景

那份记录定的「走 `ctx.skills.register()`（rank 250）、不走 filesystem provider」是对的，但它隐含了一个
**当时没验证的前提**：*250 会压过用户级 500*。实测（`.coord/verify-s2.md`）证明这只在**同一层内**成立：

- 注册表**先比层、再比 rank**：`collectFresh` 把 global 层与 scope 链合并，
  **最近层的同名条目直接胜出**，rank 只在同一层内裁决（`verify-s2.md` §1.2 源码直读）。
- 而标准部署里，**根上的 `skill-filesystem` 被 `dsh-web-app` 关掉了**，唯一开着的那份在
  **`preset-standard` 的 `plugins:` 里** → 项目级/用户级技能全落 **preset 层**。
- 本插件挂在 profile 根 → 它的 runtime 注册落**全局层** → **被 preset 层的用户级同名技能跨层遮蔽**，
  rank 根本没参与。

后果是真的：本机 `~/.agents/skills/dsh-plugin-debugging/`（rank 500）在标准 preset 会话里
**遮蔽本插件的技能**。两份内容相同时看不出来；**插件一更新 SKILL.md、那份副本没更新，模型看到的就是旧副本**。

## 决定

**注册两次**：

1. **全局层**：`ctx.skills.register(def)`（原路径，不变）；
2. **每个活跃 agent 的 preset 作用域**：`agent.ctx.get('skills').register(def)` ——
   与 `skill-filesystem` **同层**，于是 rank 250 在同层仲裁里**真的赢** 400/500。

已有 agent 在 `apply` 时遍历 `agents.list()`；之后的由 `ctx.on('agent/created', …)` **同步**处理器接管。
动态注入失败**不推翻**全局那次的 `ok`（只记 `scoped.failed`）。

## 被否的替代方案

**A. 把插件行静态写进 `preset-standard` 的 `config.plugins`**（官方 `editing-cordis-compositions`
说的「Change a shipped preset：override by row id，restate 整个 config」）。
实测**它确实能赢**（`verify-preset-layer.md`：同层 250 胜 400/500，`source=runtime` + `path=null`），
但代价不可接受，**两条**：

- **包不可解析时默认会话直接建不起来**：`agentPresets[standard].broken = "…never started"`，
  且 `session/create` 返回 `agent-preset/invalid`。**standard 是默认 preset** → 插件一坏，默认体验全哑。
  这与本插件「只读、不打扰宿主」的定位直接冲突。
- **四个工具被一起限进 preset 层**：全局层 `schemas()` 只剩 `working_directory` →
  `ptc`/`minimal`/`cordis` 会话拿不到这四个工具。
- 附带维护债：restate 等于把上游 preset **冻结在抄下来的那一刻**，上游升级后被静默盖回。

**B. 不碰机制，只撤掉个人副本**：成本最低，但**不能防未来** —— 用户以后在任何用户级根放一份同名技能，
遮蔽会重新发生，而且**完全静默**（没有 API 能列出被遮蔽者）。所以它降级为「步骤 2」，不是方案。

## 代价与重开条件

**代价**：

- 依赖宿主**内部 primitive**（`ctx.agents` / `agent.ctx` / `agent/created`），**不是公开契约** ——
  换版本必须重测。为此本仓用**结构型**声明而不是 import 具体类型：失效会表现为「读不到」，
  而不是编译不过或运行期炸。
- **每个 agent 注册一次**（事件驱动）；`agent/created` 是 **serial 派发，处理器里不许 `await`**
  （实测 await 会让 `agents.create()` 卡死）。
- **只在真的开了 agent 的会话里赢**：纯冷会话用临时层，覆盖不到。
- 个人副本仍在（步骤 2 未做）——**顺序不能换**：先证明插件那份在同层赢，再撤旧的，
  否则会留下「两份都不生效」且不报错的窗口。

**重开条件**：

- 宿主给 filesystem provider 加上 rank 旋钮，或允许把插件行挂进 preset 层**而不承担**
  「坏包挡会话」的后果 → 可以退回静态方案（少一次注册、少一处内部依赖）。
- 宿主把 `agent/created` 改成非 serial、或作用域注册表不再能经 `agent.ctx.get('skills')` 取得
  → 动态注入失效，本决定要重做。

**证据**：本轮的真机验证报告（住工作区的中转站，**不随本仓发布**，故此处不写路径）——
四份分别覆盖「层与 rank 的实证」「静态方案能赢及其代价」「动态注入五问与三条纪律」「真实包复核（含抓到的泄漏）」。
可复查的**耐久**落点有三处，都在本仓内：本文上面对宿主源码的逐条引用、
[AGENTS.md](../../AGENTS.md) 活跃坑第 6 / 19 / 26 / 28 条、以及
[test/integration/](../../test/integration/) 下两条**可复跑**的本机红线
（`bench-s1.ps1` 组合层、`leak-fix.ps1`「停用即解开」）。
