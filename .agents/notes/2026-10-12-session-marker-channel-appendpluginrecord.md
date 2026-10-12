# 会话标记走 `appendPluginRecord()`：**待用**决策，当前无执行体

状态：生效

**类型**：决策（**待用** —— 触发条件未到）。

> **当前无执行体。** 全仓搜 `appendPluginRecord` / `session.append` / `SessionEventMap` 只命中两处
> **说明性**文字：`docs/ARCHITECTURE.md:134` 与 `AGENTS.md:68-70`。`src/**` 里**零命中**
> —— v1 不往会话里写任何标记；本文记的是**将来一旦要写**时的既定通道与理由。

## 背景

v1 的工具是只读的，排障结论只活在当次工具结果里；而排障天然**跨会话**
（重启宿主、换 profile、再进来）。将来若要把「这一轮排过什么」落进会话日志，就面临通道选择。

陷阱在于：宿主允许**类型层 declaration merging**，所以「自己造一个 `SessionEventMap` 成员、
再 `session.append()`」在类型检查下**完全合法** ——
`SessionEventMap` 可合并（recon-C 命题 4：`[RTp]\dsh-session\lib\types\types.d.ts:255`，
`keyof` 用法在 `:435`），宿主自己就这么干（`[RTp]\dsh-user-approval\lib\types\index.js:50`
的 `session.append('approval/policy', …)`）。

**但仓外插件走这条路会写坏会话日志。** 三件事叠出来的：

1. 持久层要求信封带 `ignorable: true`，否则**拒绝解释整份日志**
   （recon-C 命题 4：`[RTp]\dsh-session-persistence\lib\index.js:184`；
   信封字段声明在 `[RTp]\dsh-session\lib\types\types.d.ts:507`）。
2. **`append()` 没有能力写 `ignorable`**（recon-C 命题 4：签名
   `[RTp]\dsh-session\lib\types\index.d.ts:277`；事件字面量构造处 `lib\types\index.js:638-663` 无此键）。
3. 「已知事件类型」集合是**构建期从宿主本仓声明生成**的
   （recon-C 命题 4：`[RTp]\dsh-session\lib\types\known-event-types.js:1-21`，生成物），
   所以**仓外插件 merge 进来的成员天然不在其中**。

失败形态最恶劣的一点是**延迟**：写入**完全成功**、当次会话可用，坏在**下一次加载/恢复** ——
那时持久层抛 `SessionFormatUnsupportedError`，**整份日志读不出来**。
代价不是丢一个标记，是丢整段会话。

## 决定

**（待用）** 一旦需要往会话里写标记，只走 **`appendPluginRecord()`**：`plugin:` 前缀、
声明在独立的 `PluginRecordMap`（显式「不进 `SessionEventMap`」，recon-C 命题 4：
`[RTp]\dsh-session\lib\types\types.d.ts:519-527`）、**强制 `ignorable: true`**
（同命题：`[RTp]\dsh-session\lib\types\index.js:673-689`，强制点 `:684`）。

**禁止**：自定义 `SessionEventMap` 成员 + `session.append()`。

## 触发条件（做到哪一步才需要它）

- 真机验证阶梯的 **S6「会话标记闭环（写 → 重启 → 读回）」** 被排上日程（`docs/ARCHITECTURE.md:134`）；
- 或出现任何「需要把插件侧状态跨会话/跨重启保留」的需求。

触发之前**不引入这条通道** —— 加一条没有消费者的写入路径，等于留一个能写坏日志的口子。

## 替代方案与被否的理由

- **自定义 `SessionEventMap` 成员 + `session.append()`** —— 被否，理由见上三条机制。
  它最迷惑人的地方是**类型检查全绿、写入也成功**；只有知道「已知类型集是构建期生成物」
  这一层，才能判断它其实不成立。
- **完全不持久化，把状态放回工具结果** —— 这是 v1 的现状，**不是被否的方案**，
  而是「触发条件未到时的默认」。代价是 compaction 会丢历史，
  所以排障进度靠**每个工具返回 `nextStep`** 续（`docs/ARCHITECTURE.md` 第 5 节）。

## 代价与重开条件

**代价**：`appendPluginRecord()` 能写进去，但「带了 `ignorable` 之后 viewer / trajectory
是否显示」属**实测项**（recon-C「②」第 4 条：源码只断言 fork/resume 会携带、
且不进 model-visible surface）。即：**写不坏日志已核过，看得见看不见没核过**。

**重开条件**：
- 真机实测出「`appendPluginRecord` 的记录在目标界面上看不到」而该信息又必须可见 ——
  那时另找通道（按同一条纪律：先确认它不写坏日志）；
- 宿主把 `append()` 改成能写 `ignorable`，或把仓外 merge 的成员纳入已知集合 ——
  那会削弱本决定的前提（但**不**构成「改用 `append()`」的理由，需重新评估）。

## 证据出处

1. 合并合法、真持久化、拒读条件、`append()` 无 `ignorable`、已知类型集为生成物、
   `appendPluginRecord` 强制 `ignorable`：recon-C 命题 4（源为运行时内联包 **RTp** 0.2.1-alpha.2）。
2. 跨重启闭环与 viewer 显示**待实测**：recon-C「②」第 4 条。
3. 本仓当前无落点：`src/**` 零命中（仅 `docs/ARCHITECTURE.md:134`、`AGENTS.md:68-70`）。
4. 决策冻结条款 D13：`.coord/decisions.md` 表格。
