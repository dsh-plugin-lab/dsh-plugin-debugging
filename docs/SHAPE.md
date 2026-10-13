# SHAPE — 插件形态：工具怎么分、JSON 怎么管、模型和人各看到什么

**本文职责**：这个插件**最终长什么样** —— 四类角色、工具清单、描述层骨架、输出层三层、契约、`data` 的三段划分、**双通道**（模型 / 人）、未做工具的归属、代码边界、推进顺序、以及能把上面这些**钉住的红线**。
**不负责**：宿主侧已核 / 未核的事实 → [HOST-CONTRACTS.md](HOST-CONTRACTS.md)；为什么这样分层、代价是什么 → [ARCHITECTURE.md](ARCHITECTURE.md)；发布流程 → [PUBLISHING.md](PUBLISHING.md)；在这个仓里怎么干活 → [AGENTS.md](../AGENTS.md)；决策快照 → [.agents/notes/](../.agents/notes/)。
**读者**：要动这个插件的形态（加工具、改描述、改输出、改契约）的人。**动之前先读本文，再读 HOST-CONTRACTS。**

> **本文是方案，不是已实现的现状。** 现状（5 个工具、旧契约、整块 JSON 进上下文）见 [ARCHITECTURE.md](ARCHITECTURE.md) §5。本文描述的是**目标形态**；已核的宿主事实标 `[已核]`，实测标 `[已实测]`，其余是**待定 / 待实测**。

---

## 1. 整体形态：四类角色

插件定位是**「Agent 和它身处的运行时」**。工具按**认知角色**分四类，不按个数分。

| 类 | 工具 | 粒度判据 |
|---|---|---|
| **观察** | `dsh_check_effect_mode` · `dsh_diagnose_plugin_load` · `dsh_check_auth` · `dsh_dump_config` | 这是四个**问题**，不是一个工具的四个参数：何时生效 / 加载没有 / 是 401 还是没起 / 组合成什么。**加工具不改这一层** |
| **派生** | `dsh_sign_cookie`（未做） | 唯一会**产出凭证**的工具：不同权限（要读密钥）、不同参数（authority / ttl）。**绝不能并进 `check_auth`** —— 那会把秘密带进一个判定型输出 |
| **行动** | `dsh_hot_reload`（有）· `dsh_restart`（未做） | 可逆与不可逆是两种权限面：前者失败放回旧版；后者不可逆。判据是**要不要审批闸门** |
| **实例** | 建 / 列 / 销毁 → **另起插件** | 它起长期进程、写另一个 `DSH_HOME`、分配端口 —— **越出本仓两条边界**（B10 诊断半边只读 / B15 写侧只碰进程内树），且它管的是**另一个**进程 |

**两条纪律**：

- **观察要宽，行动要窄**。观察工具一次调用给全该层证据；行动工具一次只做一个动作，有回滚、可审批。
- **判断与行动不合并**。模型必须先看到判断结果，再决定动不动手 —— 合并会剥夺它的决策点。

**「为什么行动要独立」的硬判据（`[已核]` 对照 §1.1 得出）**：**看「错一次能不能撤销」，不看「它算观察还是行动」。**

- 平台**能接受**把观察与行动合到一个工具里 —— `plugin_manager` 就是这么干的（一把工具 + 8 个 `action` 枚举，`list_*` 与 `set_*` 同住）。它之所以可以：那几个 `set_*`/`install` 改的是 **profile 配置**，改错了由 loader 按行重建、再改回来就撤销了。
- 本仓的行动工具改的是**运行中的树**（`hot_reload`，失败必须回滚）与**宿主进程**（`restart`，**不可逆**）→ 它们必须与判断**分开**：合起来会让「先判断再动手」这个决策点消失，而**错一次的代价不可撤销**。
- 这条同时解释了 `sign_cookie` 为什么独立 —— 它可重试、可撤销，**不同在可逆性**，而在**输出里带凭证**。判据是第二条：**有没有秘密要经手**。

**接缝**：观察层四个工具加一个 `dshHome` 参数（默认仍取配置）。隔离实例因此**本身可被观察**，不必给每个工具引入 `instance` 概念。

**工具名是冻结的模型可见 API**。加工具、改描述可以；改已有工具名不行。「描述层」因此是**唯一还能调路由的杠杆**。

**`dsh_restart` 只在自己那一类里排最后**（见 §6.1）。

### 1.1 与「创造模式」那批工具的设计对照（本轮核对，`[已核]`）

**先纠一个我上一轮含混的说法**：`[已核]` 比对 `dsh-web-app/presets/` 的 `cordis.patch.yml` 与 `standard.patch.yml` 的**工具行集合** ——
`cordis` 独有 = **只有 `@deepseek-ai/dsh-tool-cordis` 一项**（即 `cordis_inspect_list` + `cordis_inspect_query` 两把）；`standard` 独有 = 空。
**`plugin_manager` 两个 preset 都有**（`cordis:143` / `standard:135`），`cordis_define` 那批旧名字只存在于**客户端历史卡片**里、不在任何 tool schema 中。
→ 所以「创造模式多出来的工具」**精确地就是那两把 inspect**，不是一大簇。

把它的设计与本方案对齐 —— **它们在每一根轴上几乎都是相反的**，这种相反必须是有意的：

| 轴 | `cordis_inspect_list` / `_query`（创造模式独有） | **本仓 SHAPE** |
|---|---|---|
| **工具切分** | **两把，一宽一窄**：先给紧凑目录（provider + 用途 + 方法签名 + schema），再取一个精确契约 | 4 个观察（**按问题**切），彼此**不构成链** |
| **跨工具的工作流写在哪** | **写进描述**（不变）：「Call this Tool **before** writing or configuring a plugin, **then** select the provider and method for `cordis_inspect_query` from its result」 | 写进输出的 **L3**（每次不同） |
| **描述** | 一段长（约 600 字符）：职责 + 何时用 + **权限边界**（"cannot invoke business Service methods or modify the runtime"）+ **失败警告**（"Do not guess names"） | **四段骨架 ≤4 行**，但**保留后两项**（③边界 / ②里的反直觉点） |
| **输出** | `JSON.stringify(value, null, 2)` **原样** | `verdict` / `key` / `audit` **投影成 L1/L2/L3** |
| **「输出太大」怎么解** | **让载荷本身紧凑**（compact directory）+ 按需取精确契约 | **投影**（第三种解法） |

**我实际借了哪一条**：只有**描述里的「边界 + 失败警告」句**（→ 我的③边界）。其余全是分歧，不是模仿。

**但对照之后发现我漏了一条**，写下来免得下次再漏：

> **跨工具的调用链有两段，它把两段分开放，我原来混在一处。**
> **不变的那段**（「先调我、再拿我的结果去调它」）**属于描述** —— 它是知识，写一次；
> **条件的那段**（「这次结论是 A 才调 X」）**属于输出 L3** —— 它随本次结果变。
>
> 对本仓的实际影响**小**：我们的链几乎全是条件分支（`mode=restart-required` → `restart`；`401` → `sign_cookie`；包不在树里 → `dump_config`），无条件的那段基本不存在 → **仍然主要落在 L3**。但判据要写进 §3：**L3 只装「这次特有」的下一步；凡是不随结果变的工作流，属于描述②。**

**三处分歧要自证**：

1. **切分**：它们按「发现 / 取值」切（list/query，同一次排查里的两拍）；我们按**问题**切（何时生效 / 加载没有 / 401 还是没起 / 组合成什么，四个并列的入口）。理由在 §1：四个问题是**四个不同的起点**，被问哪个取决于用户遇到什么，不存在「先调 A 再调 B」的固定次序。
2. **描述长度**：它们的长度来自**两类内容**：执行前必须知道、且**调用结果里学不到**的约束（权限边界、别猜名字），以及**不变的工作流**。前者我们保留（③），后者我们的工具几乎没有，所以骨架能收短。**这是一条判据**：描述长短由「执行前必须知道多少不可学到的约束 + 多少不变的工作流」决定，不由风格决定。
3. **投影 vs 紧凑 + 按需取**（最要紧的一条）：它们对「输出太大」的答案是**让载荷本身紧凑**，再把精确契约推迟到第二次调用 —— **不是渲染层投影**。所以投影必须在**它自己成立的条件**下才用：

   > **工具手上有模型没有的知识 → 投影（`verdict`/`key`）。知识在模型手上、工具只是递原始记录 → 紧凑 + 按需取 + 原样给。**

   `cordis_inspect_*` 属于后者：它只查「宿主有什么」，**判断在模型**（设计上就这么定的 —— 那两个工具的用途是"给要写插件的人查契约"）。**我们的工具属于前者**：`--dump-config` 的退出码语义、`preset-*` 的已知误报、`hmr` 缺失导致一切降级 —— 这些**在原始数据里读不出来**，必须由工具判定。`verdict` 因此不是「替模型决策」，而是**把工具独有的宿主知识交出去**；`key` 才是留给模型决策的原料。
   → 若哪天某个工具的 `verdict` 变成「原始数据的一行摘要」，它就退化成多余的中间层，**该按它们的做法去掉它**。这条是**重开条件**。

---
2. **描述长度**：`plugin_manager` 的长描述**不是废话** —— 它写的是「这个动作会改整个 profile、会跑别人的构建脚本、版本豁免有崩溃风险」，**都是执行前必须知道的、不可从调用结果学到的约束**。我们的四个工具没有这类约束，所以骨架收短；**这是一条判据**：描述长短由「执行前必须知道多少不可学到的约束」决定，不由风格决定。
3. **投影 vs 紧凑/分页**（最要紧的一条）：官方对「输出太大」给的两个答案是**让载荷本身紧凑**与**分页**，**都不是渲染层投影**。所以投影必须在**它自己成立的条件**下才用：

   > **工具手上有模型没有的知识 → 投影（`verdict`/`key`）。知识在模型手上、工具只是递原始记录 → 紧凑 + 分页 + 原样给。**

   `cordis_inspect_*` 属于后者（它只查宿主有什么，判断在模型）；`plugin_manager` 也属于后者（列出来由模型决定装不装）。**我们的工具属于前者**：`--dump-config` 的退出码语义、`preset-*` 的已知误报、`hmr` 缺失导致一切降级 —— 这些**在原始数据里读不出来**，必须由工具判定。`verdict` 因此不是「替模型决策」，而是**把工具独有的宿主知识交出去**；`key` 才是留给模型决策的原料。
   → 若哪天某个工具的 `verdict` 变成「原始数据的一行摘要」，它就退化成多余的中间层，**该按官方的做法去掉它**。这条写在这里当**重开条件**。

---

## 2. 描述层：四段骨架

现状：5 个工具的 description 在系统提示里**恒占约 3364 字符**（工具描述 2134 + 参数描述 1230，实测），其中相当一部分是**输出结构的复述**（每次调用都能看见的东西）。

固定骨架，**顺序不许换**：

| 段 | 内容 | 上限 |
|---|---|---|
| ① 做什么 | 动词 + 对象 | 1 行 |
| ② 什么时候用我 | 触发条件 = 模型的路由信号 | 1–2 行 |
| ③ 边界 | 我**答不了**什么 + 唯一的反直觉点 | ≤2 行，没有就不写 |
| ④ 代价 | 只对行动 / 派生类：改不改状态、有没有 `dryRun`、可不可逆 | 1 行 |

**删**：机制解释（挪到参数自己的 description）、输出结构复述（例：`dump_config` 现在用两句解释退出码与已知误报）、枚举复述。
**移**：恒定知识从「每次输出」移到「③ 写一次」。例：`diagnose` 的 `loadProofCaveat`（365 字符，每次调用都印，一个字都不变）。
**参数规则放参数上**，工具描述里不复述。
**目标**：描述层总量减半，单工具 ≤4 行。

**段内上界与总上界的关系（2026-10-13 补，防实现误删一条）**：四段各自的上界加起来最多 **6 行**（`1+2+2+1`），而 §2.1 的总上界是 **4** ⇒ **`≤4` 才是真正生效的那一条**（四段齐全时每段实际只能 1 行）。两条都留，**`≤4` 优先** —— 不写明的话，实现会以为它们矛盾而删掉一条。

**骨架必须是类型，不是约定**：每个工具用四字段声明（`what / useWhen / boundary / cost`）再由 helper 合成字符串。这样「四段齐全」「行数上限」能被红线断言（见 §10 B20a）。

### 2.1 冻结签名：描述层（实现者照此写，不许各自解释）

```ts
// src/tools/describe.ts（新文件，唯一写者属于契约改造那一步）
interface ToolDescription {
  what: string        // 必填：做什么（动词 + 对象），1 行
  useWhen: string     // 必填：什么时候用我 = 模型的路由信号，1–2 行
  boundary?: string   // 可选：我答不了什么 + 唯一的反直觉点，≤2 行
  cost?: string       // 可选：只对行动 / 派生类写（改不改状态、有没有 dryRun、可不可逆）
}
/** 按固定顺序拼成最终 description：what → useWhen → boundary → cost。 */
function composeDescription(d: ToolDescription): string
```

**`composeDescription` 必须丢掉空段（补，防 B20a 的下界被架空）**：`boundary` / `cost` 是可选的，
若只是 `[what, useWhen, boundary, cost].join('\n')`，缺省时会产生**空行**（`"a\nb\n\n"`）。
空行会被「按 `\n` 切分」的行数算进去 → 两段齐全也能数出 4 行 → **`行数 ≥ 段数` 与 `行数 ≤ 4` 同时通过**，
而描述里躺着两条空行。**取法：先滤掉空串 / 纯空白段再 `join('\n')`**，于是「每个存在的段贡献 ≥1 行」成立，
`≥ 段数` 才是真下界（`useWhen` 合规折成 2 行时自然 > 段数，这也是下界用 `≥` 而不是 `===` 的原因）。

**连接符是 `\n`，不是空格**（2026-10-13 拍板，选 A）：
原稿写「用空格连接」，而 redline-verifier 指出 —— 空格连接 ⇒ **合成后行数恒为 1** ⇒ 「行数 ≤4」是**恒真断言**，而 §2 表里那句「③ 边界 ≤2 行」也**永远判不出来**。两条判据一起变成装饰。
→ 改成 `\n` 连接：四段各占一行，「≤4 行」与「段内 ≤2 行」同时成为**真判据**，且模型读到的描述是四行而不是一坨。**这是有意与宿主官方描述（单段）分歧的一处。**

**硬约束（B20a 逐条断言）**：

| 约束 | 值 | 为什么是硬数 |
|---|---|---|
| `what` / `useWhen` | 非空 | 缺任一段 = 模型不知道「这是什么」或「何时用」 |
| 合成后**行数** | ≤4 | 骨架就是四段 |
| 单工具 description 字符数 | **≤240** | 现状 371–575；五个工具描述合计 2134 → 目标 ≤1200 |
| **每个参数描述** | **非空，且合计 > 0** | 这是**唯一**的机械守卫（两条**下界**）；**上界已删**，见下 |
| 禁止出现 | 输出结构复述（`exit code` 这类） | 见 §10 B20b（只抓逐字，同义改写归评审） |

**参数描述：删掉上界，改人工标准（2026-10-13 拍板）**。
原来的「该工具全部参数描述合计 **≤100** 字符」**已删**。理由：那个数是在**还没有第二个轴**时定的；
`dshHome` / `profile` 这类真实的新参数需要地方写清「怎么填 / 不填怎样 / 有什么陷阱」——
而**上界只防啰嗦、下界才防空转**。机械部分因此只留「**非空** + **合计 > 0**」，质量归评审：

> 逐条自问：**模型看不到这条描述，会不会填错？**
> - **留**：怎么填 / 不填怎样 / 有什么陷阱
> - **删**：从参数名能推出 / 与工具描述重复 / 纯机制解释

**没有预算 ≠ 可以写长**：删上界是为了让**该说的说完**，不是为了让描述变长。

**为什么给死数字**：「减半」不是判据，`≤240` 才是。红线要能被机器判。

---

## 3. 输出层：模型读到的文本分三层

现状是「一行摘要 + 整块 pretty JSON + nextStep」，`RENDER_MAX_CHARS = 6000`。两个实测问题：

1. `dsh_dump_config` 在本机**默认调用直接传输层超时**（`--dump-config-schema` 三万多行）；
2. 证据越多越容易撞上 6000 截断 —— **最需要证据的那次（插件被整条丢弃）恰是最可能被砍的那次**。

改成三层，恒定顺序：

| 层 | 放什么 | 规则 |
|---|---|---|
| **L1 判定** | 一句话，含「所以呢」：结论 + 它**排除**了什么 | 恒有，成功失败都有。模型「告诉用户什么」全靠它 |
| **L2 观测** | 一行一条 `k=v`，只放**这次非默认、非恒定、且下一个决定可能要用**的 | 硬规则：**凡要做下一个工具的参数，标识符必须出现**（entryId / port / authority / 路径）；恒定块压成**一行**；截断要明说 |
| **L3 下一步** | 一个动作（工具 + 参数），或「无事可做」 | 没有就不出现；工具名可缺（如「重建客户端再刷新」），但那时不印空括号 |

**判据**：「模型看不到它，会不会做出不同的下一步？」会 → L2；不会 → `audit`（§5）。
**整块 JSON 不再进模型上下文**。模型需要细节时走**路径**：L2 给出日志路径 / 目录，它自己有读文件的工具。
**L3 只装「这次特有」的下一步**（`[已核]` 对照 §1.1 得出）：**跨工具调用链里不随结果变的那段属于描述②，写一次；随结果变的那段才进 L3**。本仓的链几乎全是条件分支（`mode=restart-required` → `restart`；`401` → `sign_cookie`；包不在树里 → `dump_config`），所以实际仍主要落在 L3。
**同一句不许印两遍**。现状 `dsh_diagnose_plugin_load.ts:338` 是 `ok({ ...data, verdict }, { why: verdict })` —— **同一个 `const` 绑了两次**，`buildVerdict` 的全部六个出口都这样。这不是措辞洁癖：根因是 **`nextStep` 允许没有动作**，而 `why` 的定义是「为什么建议这一步」，没有「这一步」可解释时只剩结论可写。修法：**`nextStep` 必须带动作，没有动作就不出现**。

### 3.1 冻结签名：渲染层（实现者照此写，不许各自解释）

```ts
// src/lib/render.ts
interface RenderTable<T> {
  /** L2：逐行文本，顺序即输出顺序。只放本次非默认、且下一个决定可能要用到的。 */
  key(data: ToolData<T>): readonly string[]
  /** L2 的行数上限；超出时截断并**明说**还剩几条。默认 15。 */
  maxKeyLines?: number
}
function renderToolResultText<T>(toolName: string, value: unknown, table: RenderTable<T>): string
```

**L1 没有投影函数 —— `verdict:` 行的正文就是 `data.verdict` 逐字**（2026-10-13 补，见下）。
`RenderTable` 因此**只有 `key` 一个投影**：`data.verdict` 已经是成品字符串，不需要再投影；
`data.key` 是各工具自己的结构化 `T`，把 `T` 摊成 L2 文本行才需要逐工具的函数。

> **为什么不能是 `verdict(data): string`（本轮自查抓到的自相矛盾）**：§3.1 原稿写于「L1 由 `summarize` 钩子产出」的年代
> （现 `src/lib/render.ts:64,78` 就是这个钩子）；§4.1 把 L1 挪进了 `data.verdict` 并把它**定为必填非空**。
> 两条都留 = **L1 有两个家**，正是本方案要消灭的那类重复。
> **决定性理由不是偏好，是 §4.1 的兜底分支**：`ensureToolResult` 合成的 internal 失败
> `data = { verdict: <形状错在哪>, key: {}, audit: {} }` 是**通用产物、没有专属的 `RenderTable`**
> —— 若 L1 只能由 `table.verdict(data)` 产出，这条兜底路径就**印不出任何判定行**。
> 所以 `data.verdict` 是唯一可行的源，`RenderTable.verdict` 删掉。
> 连带：§3.1 规则 1「渲染只读 `verdict` 与 `key`」读作「读 `data.verdict` 与 `table.key(data)`」。

**输出文本的逐行格式（冻结；`nextStep:` 前缀与**工具支**的 `—` 分隔沿用现状，别改）**：

```
[dsh_x] ok                              ← 或：[dsh_x] failed (<kind>)
verdict: <L1>
<L2 第一行>
<L2 第二行>
nextStep: <tool>(<args JSON>) — <why>   ← 工具支；`args` 缺省时印 `()`，即 nextStep: <tool>() — <why>
nextStep: <why>                         ← manual 支：**不印 `—`**，也不印空括号
```

**两支的逐字形状（补，防实现各自解释）**：`tool` 支恒为 ``nextStep: <tool>(<args JSON>) — <why>``
（`args` 缺省 → `()`；这与现状 `render.ts:98-105` 一致）；`manual: true` 支恒为 ``nextStep: <why>``
（现状那行 `nextStep: — <why>` 的空指代按规则 2 消失）。**B18b 比对的是这两支里 `<why>` 的正文**。

**七条冻结规则**：

1. **`audit` 不进这段文本**（B22 用哨兵断言）。渲染只读 `verdict` 与 `key`。
2. **L3 只在 `nextStep` 存在时出现**；两支都要能印出来，`manual` 支不印空括号（现状 `nextStep: — <why>` 那种空指代必须消失）。
3. **截断要明说并给总数**（照 `presentation.d.ts` 的 `truncated` + `total` 判例）：超 `maxKeyLines` 时末行写
   `<n> more line(s) not shown — the full record is in the session log`。
4. **不再输出整块 JSON**。形状不合法的值 → 退化成一行 `[dsh_x] <stable JSON>`（保持「永远有输出」）。
5. **B16 的判定范围 = 只看 `verdict:` 与 L2 这些行**，**排除** `[dsh_x] …` 头行与 `nextStep:` 行 ——
   否则两个 fixture 里相同的 `nextStep` 会造成**假红**。这条必须写进红线实现。
6. **B16 的两份 fixture 必须同时改变「输入」与「环境」**（2026-10-13 补，W1 实测踩到）：`resolved:` 这类行按**环境**恒定、不按输入恒定（`dshHome` / `profile` 由配置来）。两份 fixture 若**共用同一个临时 home**，这行必然逐字相同 → **假红**。
   → B16 要抓的是「**输入与环境都变了、这一行还是逐字不变**」= 真恒定块。**做法：两份 fixture 各用一份临时 home**（这是判据要求，不是随便挑两份）。W1 的样板自检正是双 home 才通过。

7. **B18b 的判定对象 = `verdict:` 行的正文与 `nextStep:` 行的正文**，两者字符串不相等。

---

## 4. 契约：从 5 个字段收到 3 个

| 字段 | 去留 | 理由 |
|---|---|---|
| `ok` | **留** | 唯一区分「干成没有」的位，也决定 `data` 怎么读 |
| `data` | **留**，并吞掉失败分支的观测 | 「这次看到了什么」只该有一个槽 |
| `error.kind` | **留** | 闭枚举 = 重试判据，唯一稳定的机器码 |
| `error.message` | **留，压缩** | 只写事实一句话，不写建议 |
| `error.hint` | **删** | 它的内容只有两种归宿，两种都已经有家：稳定知识 → 描述层③；具体动作 → `nextStep`。留着 = 给模型两个权威去分辨 |
| `error.evidence` | **并进 `data`** | 它与 `data` 对模型是**同一个东西**（渲染里并排出现），对作者却是两份负担（`summarize` 要为两个分支各跑一次，实测） |
| `nextStep` | **留但收紧** | 只在「看完会做不同的事」时出现，且**必须带动作** |

**`nextStep` 必须是两支之一（否则 B18a 无法断言）**：

```ts
type NextStep =
  | { tool: string; args?: JsonValue; why: string }   // ① 调一个工具
  | { manual: true; why: string }                     // ② 让用户做一个工具做不到的动作
```

「必须带动作」这条只有在**动作可分派**时才可机械断言。`manual: true` 是「重建客户端后刷新页面」这类没有工具可调的动作的**显式出口** —— 它的代价是那类 `nextStep` 多一个字段，收益是**「裸结论伪装成下一步」在类型上就写不出来**（现状 `nextStep: — <why>` 正是这种裸结论）。

**两种合法形态，以及 `{ tool, args: 空 }` 为什么非法（2026-10-13 真机抓到并定案）**：

| 形态 | 含义 | 合法性 |
|---|---|---|
| `{ tool, args: <非空>, why }` | 去问一个**更具体**的问题 | ✅ 永远合法 |
| `{ tool, args: {} }` | 「原样重跑」 | **看失败性质**：`timeout` 等**非确定性**失败 → ✅（重试可能不同）；`not-configured` / `not-found` / `command-failed` / `internal` 等**确定性**拒绝 → ❌ |
| `{ manual: true, why }` | 下一步是**用户动作** | ✅ 永远合法；**此时不许同时带 `tool`** |

**判据的真正分界不是「args 空不空」，是「这次失败会不会自己变」**：
- `not-configured` 的成因（端口来源三条都没有）**不会**因为你再调一次而改变 → 带工具名就是**不动点**（死路）；确定端口是**人的动作** → 该走 `manual` 支。**真机原文**：`nextStep: dsh_check_auth() — re-run this check with an explicit port once you know which one…`（模型此刻并不知道端口）。
- `timeout` 的成因（预算耗尽）**可能**变 → 「retry once」是真实动作。

**这一条由 B18a 机械断言**（读 `kind` 闭枚举，不靠人读 `why` 的语义）；「非确定性失败」白名单写在判据里，新增 `kind` 时必须同步裁决它属哪一档。

**`ok` 的语义不变**：`ok:false` = 操作没完成；「诊断成功、只是结论是坏消息」走 `ok:true` + `data`（`verdict` 承载结论）。变的是**槽的数量**。

**一处新事实**：本仓工具**从不 throw**，所以宿主的 `isError` 对本仓**恒为 `false`** —— 宿主眼里我们的 `{ok:false}` 是一个**成功结果**。`[已核]`（`dsh-tools/lib/index.js` 的 `createSuccessResult` 只对抛出的异常走 `toolErrorResult`；且实测 `dsh_check_auth` 的失败分支被 `render` 正常渲染过 —— `render` 只在成功分支被调用）。
→ 后果：`presentResult`（§8）里**不能靠 `result.isError` 判断本仓的失败分支**。

**复查（本轮）**：全仓 grep `isError` = **0 命中** → **本仓没有任何现存代码依赖它**，这条只约束**将来**写 `presentResult` 的人（也就是 §8.2 暂时不做的那件事）。顺带一条：宿主的 `tool/result` 还有一个 `error?: {name, code, reason?}` 字段、**只在 `isError: true` 时允许** —— 因为本仓从不 throw，这个字段对我们**永远是空的**。即：本仓的失败在会话日志里是「**内容里写着 failure 的成功事件**」。这是可接受的（模型看到的是 `render` 文本，一切照常），但要**记住**：谁要是按 `isError` 或 `error.code` 去统计「这个插件失败了几次」，会得到 0。

**同一族里另一条更值得注意的推论**：既然宿主只把**抛出的异常**当失败，那「`execute` 绝不 throw」就不只是本仓的风格，而是**契约的承载条件** —— `{ok:false}` 能到达模型，全靠它不被包成 `toolErrorResult`。一旦有人让 `execute` 抛出去，模型看到的会是宿主的 `Error: <message>`（不带 `verdict` / `key` / `audit`），**而我们所有的失败形状当场失效、且不会有任何红线报警**。
→ **已拍板落成 B24**（见 §10）：`[已核]` 五个工具里**只有 `hot_reload` 有顶层 `try/catch`**，四个观察工具都没有 —— 这条红线今天就有活干。

### 4.1 冻结签名：结果契约（W1–W4 一律照此实现，不许各自解释）

```ts
// ── src/lib/errors.ts ──────────────────────────────────────────────
type ToolResult<T> =
  | { ok: true;  data: ToolData<T>; nextStep?: NextStep }
  | { ok: false; error: ToolError; data: ToolData<T>; nextStep?: NextStep }

interface ToolError { kind: ToolErrorKind; message: string }   // hint 已删，就两项
type ToolErrorKind = …                                          // 闭枚举不变（现有 8 项）

type NextStep =
  | { tool: string; args?: JsonValue; why: string }             // ① 调一个工具
  | { manual: true; why: string }                               // ② 让用户做一个工具做不到的动作

/** data 顶层**恰好三个键，不许第四个**（B21 断言这条）。 */
interface ToolData<T> { verdict: string; key: T; audit: JsonValue }
```

**三条决定性约定**（写错任何一条，五份实现就会分裂）：

1. **`data` 两分支都必填、同形**（这是「失败时结构不变」的落法）。失败分支的 `data` 就是原来的 `evidence`。
   代价：连 `not-configured` 这种「还没开工就失败」也要给一句 `verdict`（例：`no port could be determined, so nothing was probed`）。
   收益：**失败分支从此也有 L1** —— 现状失败时常常没有判定行，模型只能读 `error.message` 猜。
   **`audit` 可以为 `{}`**，`verdict` 必须非空字符串。
2. **`data` 顶层只有 `verdict` / `key` / `audit`**，工具特有的字段一律塞进 `key`（要模型决策的）或 `audit`（给人复核的）。
   判据来自 §5：**模型看不到它，会不会做出不同的下一步？** 会 → `key`，不会 → `audit`。
3. **`fail()` 的第二个参数是 `data`（必填），`nextStep` 在最后**（2026-10-13 定稿，W1 实现后返工过一次）：
   ```ts
   function ok<T>(data: ToolData<T>, nextStep?: NextStep): ToolOk<T>
   function fail<T>(error: ToolError, data: ToolData<T>, nextStep?: NextStep): ToolFail<T>
   ```
   与 `ok` **同构**（可选参数在最后）。W1 初版写成 `fail(error, nextStep, data)` —— 必填在最后 ⇒ 每个没有下一步的失败都要写 `fail(err, undefined, data)`，全仓 31 个调用点都得带那个 `undefined` 占位符。**必填的 `data` 保留**：可选的话漏传只能被守卫在运行期转成 `internal`，那是「晚且绕」的报错。

**`error.message` 不进模型文本 —— 但它不是漏渲染（2026-10-13 补，防下一个人当 bug 修）**：

| 字段 | 角色 |
|---|---|
| `error.message` | **这次操作为什么没做成**（操作视角）。由守卫或 `toToolError` 产生 |
| `data.verdict` | **结论**（世界视角，L1）。每支都必填 |

两者角色不同，**不是同一句的两个副本**，所以删哪个都不对。`§3.1` 的冻结格式里没有 message 行是有意的。
→ **代价如实记**：`error.message` 目前**没有模型可见的消费者**（渲染不打印它）。若将来确认它连结构化消费者也没有，按「冗余是负担」**应当删掉它** —— 这是本条的重开条件。
→ **连带风险（已写进 W2 卡）**：既然失败分支的「所以呢」只能由 `data.verdict` 承载，**W2 每个失败分支都必须写实质 verdict**，不许只写 `failed`。否则模型只看到 `failed (kind)`。


**`ensureToolResult` 的校验规则（**绝不抛**，任何不合规都合成 internal 失败）**：

| 分支 | 必须满足 |
|---|---|
| `ok === true` | `data` 是对象且 `data.verdict` 是非空字符串、`data.key` 是对象、`data.audit` 存在（任意 JSON） |
| `ok === false` | `error.kind` ∈ 闭枚举、`error.message` 是非空字符串；`data` 同上面那条 |
| `nextStep`（若存在） | 两支**恰有其一**：`tool` 非空字符串，或 `manual === true`；两者都有也判不合规 |
| 兜底 | 不合规 → 合成 `internal` 失败，其 `data` = `{ verdict: <一句话描述形状错在哪>, key: {}, audit: {} }` |

**红线的一致性要求**：`ensureToolResult` 与 B21/B24 必须**同意同一套规则** —— 一处放宽、另一处收紧，就会出现「红线绿但模型收到坏形状」。改任一处必须同批改。

---

## 5. `data`：一个记录，两种投影

```
data
├─ verdict  一句话结论        → L1
├─ key      下一个决定可能要用 → L2
└─ audit    给人复核，模型不读 → 不进 render（走 §8 的人通道）
```

**外层形状所有工具共享**，各自定义 `key` 与 `audit`。**失败时结构不变**：失败分支的观测就是那时的 `key`。

**放 `key` 还是 `audit` 的判据**：模型看不到它，会不会做出不同的下一步？

**恒定不变的解释不进 `data`** —— 放描述层③，写一次。

**大 `audit` 的落点不是「写个文件」**：`[已核]` 宿主的两条既有机制决定了这件事：

- **宿主 spill 策略作用在 `content` 上，不作用在 `meta` 上**（`dsh-spill-policy` 的 `maxInlineTokens` 是对 tool result **content** 的保留/省略策略）→ 放进 `meta` 的大 `audit` **不会被自动 spill**，只会撑大会话日志；
- **本仓自己写文件违反 B10**（诊断半边只读，不许写 `$DSH_HOME`）。

所以只剩两条合法通道，按优先级：**① 宿主 `spillStore` 服务**（是宿主在写，不是本仓在写；`data.audit` 换成 `{locator, bytes, retrievalHint}`）；**② `presentationMeta`（会话日志）**。**不要写进 `inject`**（缺席会把整个插件挂成 PENDING，`skills` 已经踩过这条），要用 `ctx.get('spillStore')` 探测，缺席就退回 ②。
→ **待拍板**：B10 的措辞要精化为「不许**本仓自己**写 profile / `$DSH_HOME`；经宿主服务（spill）落盘不在此列」。不精化就只能走 ②。

### 5.1 `spillStore` 可达性：**已真机实测**（步骤 ⓪ 已完成）

**结论：可达。** 在本插件这一层的 `ctx` 上 `ctx.get('spillStore')` 解析得到 `LocalSpillStore`，`saveText` 真落盘并返回 `{ locator, bytes, retrievalHint }`。
证据：隔离 bench（独立 `DSH_HOME`、端口 18441、探针与本插件行同为根层兄弟）。原始记录见 §C.3 的 `.local/plan/spill-store.md` 与 `.local/spill-bench/`。

| 问题 | 结论 | 证据 |
|---|---|---|
| 服务定义 | `ctx.spillStore`，方法只有 `saveText` | `@deepseek-ai/dsh-spill`，检索串 `"spillStore"` |
| 本 profile 挂没挂实现 | **挂了** | `@deepseek-ai/dsh-base/cordis.patch.yml` 有 `spill-local` 与 `spill-policy` 两行；`bundles` 含 `dsh-base` |
| 组合树里的层级 | **与我们的行同级**（根层兄弟，无嵌套 / `disabled` / `isolate`） | `dsh --profile web --dump-config`：两行**行首缩进相同** |
| 真机可达 | **可达**：apply 期 `undefined` → **+3s** 变 `object`、ctor `LocalSpillStore` | bench 实测 |
| 负对照（证明判据不恒真） | `ctx.spillStore`（属性直取、无 inject）**抛** `cannot get property "spillStore" without inject` | bench 实测 |
| 真落盘 | `bytes=29` 与落盘文件 29 字节**逐字相符** | bench 实测 |
| 重复注册 | 第二个 `provide` 会抛（本插件不 `provide` 任何服务，无风险） | bench 实测 |

**三条实现规则（由实测直接推出，写代码时照此）**：

1. **每次 `execute` 现取**，不缓存 —— apply 期拿不到。
2. **绝不写进 `inject`** —— 缺席会把整个插件挂成 PENDING（`skills` 已经踩过这条）。
3. **三种失败一律降级，绝不让工具变失败**：后端缺席 / 无 owner / `saveText` rejects → **保留内联 `audit` + 一条 warn**。语义照抄 `dsh-spill-policy` 与 `dsh-tool-fs-search` 自己的处理。

**通知措辞别自创**：宿主形状是 `(Omitted <n> bytes. Full formatted result stored at: <locator>. <retrievalHint>)`（`formatSpillNotice` + `describeOmitted`）。
**两条互不干扰的路**：本插件工具结果的 **content** 若超 `maxInlineTokens`（本机 `12500`），spill-policy 会**自己**再 spill 一次 content —— 那是它的职责，与我们主动 spill `audit` 无关。

**它决定什么决策**：可达 → `data.audit` **可以很大**，落盘后 `audit` 换成 `{ locator, bytes, retrievalHint }`。§9 的 ③ 因此不被阻塞。

**仍未核实（如实列，但都不阻塞实现——都会走降级分支）**：

| # | 未核实 | 影响 |
|---|---|---|
| 1 | `exec.agent?.session.header.id` 在**本插件自己的 exec** 上没跑过（只有类型链 + 两个宿主调用点） | 取不到 → 走降级，不崩 |
| 2 | apply→+3s 的**确切**可用时刻（只两个采样点） | 所以规则 1 定为「每次现取」，把时序问题消掉 |
| 3 | `ctx.isolate('spillStore', …)` 下能否并存第二个实现 | 与本任务无关 |
| 4 | 非 `spill-local` 后端的 locator / `retrievalHint` 形状 | 按契约「不透明」处理即可 |
| 5 | 本机 spill root 在**进程级临时目录**、启动清扫 >30 天 → `locator` **不是长期归档** | 语义是「本次会话内可取回」；**别把它当持久证据**写进文档 |

---

## 6. 未做的工具：归属

| 目标 | 归属 | 理由 |
|---|---|---|
| 启动日志解析 | **并入 `diagnose`** | 同输入（`$DSH_HOME`）、同问题、同时机；现在只列路径不解析 = 把解析推给模型 |
| `dsh.bundle` 声明检查 | **并入 `diagnose`** | 那个包的 `package.json` 已经在读了；它正是 SKILL §3.2 的第三类原因 |
| Client failure 三态 | **不进 `check_auth`** | `[已核]` 三态来自 `dsh-cordis-host-runner` 的 **client 查询分支**（无在线页面 / 超时且 handler 抛错 / provider 未注册），**不是 HTTP 层**；并进 HTTP 探针会把两种传输混成一个结论。措辞 → 描述层③（零工具改动）。唯一可观测项是「有没有在线页面」，走 `typertGateway.hasLiveClient()`（见下） |

**「有没有在线页面」的可达性**（`[已核]`，只读源码 + 只读转储）：

- 服务存在且**挂在同一个根层**：`dsh-api-gateway` 提供 `ctx.typertGateway`（`lib/index.js:618`），组合树 `- id: typert-gateway` 在第 27 行、与我们的行同级、无 `disabled`。
- 语义**极简**：`hasLiveClient()` 就是「有没有一条未取消的 client 事件流」（`lib/index.js:663-666`）—— 它回答的是「**有没有页面连着**」，**不是**「页面健不健康」，也**不是**官方那句 `Client failure:` 的来源。
- **它答不了「三态」**：`Client failure: <msg>` 是 **host-runner 那条查询路径**的措辞（`hasLiveClient()===false` → 另一句；超时且 handler 抛错 → `Client failure`；provider 未注册 → 第三句）。所以本仓若报它，只能报一个更弱的事实（「此刻没有在线页面」），措辞必须**用我们自己的话**，不能冒充官方那三句。
- **依赖面**：它跨了模块（要 `ctx.get('typertGateway')`）。**它不在本仓既有的跨模块调用清单里**（本仓目前只有 `ctx.tools` / `ctx.get('loader')` / `ctx.agents` / `ctx.skills` 那几处，且每处都在 AGENTS 的活跃坑里记了代价）→ 用不用它是一次**新增依赖面的决策**，不是顺手加个字段。**建议：不在 v1.1 做**，先把三态措辞放进描述层③（零依赖）。
| `dsh_sign_cookie` | **独立工具**（派生类） | 见 §1 |
| 隔离实例 | **另起插件** | 见 §1 |
| `dsh_restart` | **独立工具，排最后** | 见 §1 与 §6.1 |

### 6.1 `dsh_restart`（原独立文件的内容并入本节）

**为什么它比热重载危险**：重启**不可逆** —— 它杀掉当前进程、连同发起这次调用的那个回合。

| | 热重载（已实现） | 重启 |
|---|---|---|
| 失败形态 | 旧版本放回，可继续 | **进程没了、会话回不来** |
| 可恢复性 | 重试即可 | 需要 marker + 唤醒，且要看外部进程管理器脸色 |
| 最难的部分 | 顺序（已解决） | **闸门与恢复**，不是动作本身 |

**四道闸**（任一不过即拒绝，且**不提供绕过参数**）：

| 闸 | 判据 | 拒绝时的返回 |
|---|---|---|
| ① 重启循环熔断 | 短窗口内重启次数超阈值 → 拒绝 | `restart-loop` |
| ② 其他会话在跑 | 除调用方自己以外的活跃会话仍在执行回合 → 拒绝；**调用方自己的会话不算忙** | `busy` + 列出阻塞者 |
| ③ bundle 表解析不了 | profile 的 `bundles` / patch 解析失败 → 拒绝 | `bad-composition` + 指路 `dsh_dump_config` |
| ④ 拿不到启动命令 | 无法确定「怎么把宿主重新拉起来」→ 拒绝（**不猜**） | `no-launch-command` |

闸②的判据已可落地（`agents.list` 的 `status` / `inbox`、`jobs.list`、`workspace/session-activity`），契约与一条 **fail-closed 要求**见 [HOST-CONTRACTS.md](HOST-CONTRACTS.md) §2.2。

**流程（顺序是判据）**：闸门检查 → **写 marker（落盘，必须在拉起之前）** → 拉起新进程 → 本进程退出 →（新进程）读 marker → 恢复会话 → 注入 notice → 删 marker。

- **拉起优先交给外部管理器**（supervisor / Windows 服务 / systemd）；插件只做「查闸门 → 落盘 marker → 退出」。自建 helper 是**降级路径**，且**必须两级 detached**。机制与 B1–B9 全部证据见 [HOST-CONTRACTS.md](HOST-CONTRACTS.md) §2.1 —— 不在这里重推。
- **降级路径的第一选择不是「两级 detached」，而是「让一个不属于我们的父进程来拉」** `[已核 —— 本轮复查]`：参考实现用的是 **WMI `Win32_Process.Create`**，它的父进程是 **`WmiPrvSE.exe`**、**不在 DSH 的进程树里**，所以「DSH 被杀也不影响它」是结构性成立，不靠 detached 标志去赌。本机结论印证了它的必要性：**`taskkill /PID <A> /T /F` 会把 detached helper 一起带走**（`[已实测]` `.local/detached-spawn/treekill-results.json` S2），两级 detached 逃不过树杀。→ 两条并存：**能交给外部管理器就交**；退而求其次**用 WMI 这类「外来父进程」**；「两级 detached」是最后一档。`dsh-restart` 自 0.1.3-alpha.4 **移除**内置 detached watchdog 正是同一判例。
- **绝不按进程名批量杀**：按**监听端口 + 精确 PID**，与本仓既有的「按端口找进程」一致。
- **不拥有 watchdog**：参考实现曾移除内置 detached watchdog，理由是交给外部管理器。

**恢复逻辑**：marker 必须是**独立文件**，不能写进会话日志（自定义 `SessionEventMap` 成员 + `session.append()` 会**写坏会话日志**，见 [AGENTS.md](../AGENTS.md) 活跃坑 4）；注入的是**信息性 notice**，不是强制「继续」；唤醒走官方通道、按会话原有预设；**唤醒失败保留 marker**，下次启动继续重试。

**工具草稿**：`{ reason, delayMs（默认 10s，留给回执落盘）, dryRun }` —— `dryRun` 是本仓新增（四道闸必须能单独演练）。
**返回草稿**：`verdict: gates=4/4 passed · marker=<path> · newPid=<pid>`，`nextStep` **无**（本进程即将退出）；被闸门拒绝时按 §3 的三层输出，`L3` 给 `dsh_check_effect_mode`。
**验收**：四道闸**各一条拒绝用例**；真机一条「重启 → 会话被唤醒 → notice 到达发起者」闭环；反向用例「marker 存在但新进程没起来」→ 下次启动仍能恢复或明确报「上次重启未完成」；真机判据由**独立角色**跑，写者不自己验自己（[ARCHITECTURE.md](ARCHITECTURE.md) §8）。

**协作纪律（契约，不是建议）**：`dsh_check_effect_mode` 先行 —— `mode=hot` 且 `hmr=present` → 通常不需要写侧工具 `[已实测]`；`mode=hot` 但 `hmr=absent` → 改 config **必须重启** `[已实测]`；`mode=restart-required` → 走 `dsh_restart`。
**拒绝不是失败**：闸门拒绝是设计的一部分，模型应原样报给用户（**没有 `force` 参数，这是判据**）。
**不把热重载与重启合并**：失败代价不同、闸门不同；合成一个「修复它」会让模型倾向选更重的那条路。

**待实测清单**（本轮逐条复查过，结论见下表；「已降级」= 本轮查到东西、问题变了）

| # | 待验证 | 本轮复查 | 影响 |
|---|---|---|---|
| 1 | 拉起形态在服务化场景（job object / 服务管理器）下的实际行为 | **已缩到环境里**：`[已核]` **宿主源码里没有任何 job object 代码**（全树无 `KILL_ON_JOB_CLOSE` / job 相关）；宿主自己的进程树只有 *终端子进程* 那条 `taskkill /T /F` 路径（`dsh-subprocess-local`），与宿主自身生命周期无关。→ 若真有 job object，它是**「谁启动了 dsh」**装上的（终端 / IDE / 服务管理器）**→ 这条不能从源码判定，只能在不同启动方式下各跑一次** | 自建 helper 能不能作为降级路径存在 |
| 2 | 父被 `/T` 树杀时两级 detached 的长期存活 | **已有本机实测，不再是待测**：`.local/detached-spawn/treekill-results.json` —— S1（父自己 exit）helper 活下来；**S2（`taskkill /PID A /T /F`）helper 被连带杀掉**。→ 两级 detached **逃不过树杀**，这是本机结论不是推断 | 同上 |
| 3 | 工具**是否默认注册** | **已查参考实现，答案分裂**：`dsh-smart-restart` 默认 **true**、`dsh-desktop-auto-restart` 默认 **false**（关着时**根本不注册**，模型看不见）。本机是 Windows 桌面形态 → 与后者同场景。**这仍是产品决策，不是技术未知** | 装完即生效 vs 需显式开启 |
| 4 | `appendPluginRecord()` 的可用性与前缀约束 | **已确认**：`dsh-session` 导出 `appendPluginRecord(session, type, data)`；类型语法是 `PLUGIN_RECORD_TYPE = /^plugin:[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/u`（`index.js:1246`），即**必须 `plugin:` 前缀**、只允许小写字母数字与 `._-` 和 `/`。**但有一条新发现**：`@deepseek-ai/dsh-session` **不在本仓 peer 里，也不在 profile 的 `node_modules` 顶层**（那里只有一个 `@deepseek-ai/dsh-mcp-client`）→ 我们的插件**解析不到它**。要用得先加 peer（抬高依赖面），或改用 `ctx.get('session')` 那条路（**未核**） | marker 之外要不要留会话记录 |
| 5 | 「按会话原有预设」唤醒的语义 | **已确认机制**：预设是**持久化的会话事实** —— session header 有 `agentPreset?`（`types.d.ts:89-94`），且有一条 `agentPreset` 投影（`init: header.agentPreset`，`apply` 于 `agent-preset/selected` 事件，`dsh-agent-preset-registry:42-54`），其注释明确「重建读投影，不读 header」。→ **「按原预设恢复」在宿主设计里是可表达的**。未钉死的只剩「resume 时真的按它 mount 且结果一致」这一步 | 恢复逻辑能否保证「回来的是同一个上下文」 |
| 6 | 重启后 notice 的投递时序 | **仍不确定**：参考实现给的是经验值（启动后等 3 秒 / 每 4 秒重试、最多 30 次）。可达的通道本机已确证（`agent.followup` 在 `dsh-agent-loop:806`），但**「多早拿得到会话」是运行时性质**，只能实测 | marker 删除时机与重试策略 |
| 7 | 闸①的阈值怎么定 | **查到参考值**：`dsh-desktop-auto-restart` **硬编码 60 秒并发冷却**（且 README 写明「为安全起见不可配置」）；`dsh-restart` 的 `watchdogCooldownMs` 默认 **60000**。→ 两个独立实现都落在 60 秒 → **本仓取 60 秒有据可依**，不必先验后定 | 会不会把正常运维误判成循环 |

**第 2 条降级后剩下一个真问题**：既然树杀会连带，「自建 helper」只在「父自然退出」这一种情况下成立；而重启恰恰是「父自己退出」→ 树杀那条路**只在别人杀我们时才发生**。这削弱了（但不消灭）对 job object 的担心 —— 见第 1 条。

---

## 7. 代码结构：只加边界，不加层

- **能力落地在 `lib/`，工具文件只做「参数 → 机制 → 契约」的翻译**（现状已是，保持）。新增：日志解析 → `lib/startup-log.ts`；页面在线 → `lib/inspect.ts`；cookie 签发 → `lib/cookie.ts`。
- **密钥材料与「存在性扫描」分文件**，并用红线钉住 import 方向：**观察层四个工具不许（间接）import 到取值路径**。这是「派生 / 观察」的分界线，靠目录自觉一定会破。
- **渲染层从「一个 `summarize` 钩子」改成「每个工具声明一张输出表」**（L1 生成器 + L2 字段白名单 + `audit` 投影）。好处是判断能逐工具断言 —— 见 §10。
- **`data` 的外层形状由一个共享 helper 构造**（`verdict / key / audit`），失败分支走同一形状。
- **契约改动（删 `hint`、并 `evidence`）与渲染层同批**：否则 `hint` 没了而渲染还在打印 `hint` 行。
- **行动类沿用「在自己文件里扩 deps」的范式**（`HotReloadDeps extends ToolDeps`），不造万能 deps。
- **`inject` 只声明硬依赖**：`spillStore` / `typertGateway` 这类可选能力一律 `ctx.get()` 探测 —— 写进 `inject` 会在缺席时把整个插件挂成 PENDING（`skills` 的教训）。

---

## 8. 双通道调查结果（新）

**问题**：`output.render` 返回的文本，是只进模型上下文，还是**人和模型共用同一段**？

**结论：双通道存在，而且人这条其实是两条；但今天的渲染确实是「一稿两用」。**

### 8.1 `[已核]` 宿主的输出契约有三个投影，不是一个

源码：`@deepseek-ai/dsh-tools`（本机运行时 `0.2.1-alpha.2`，`lib/types/index.d.ts:105-113, 182-205`）。

```ts
interface ToolOutputDefinition {
  schema: JsonSchemaNode                                   // 值域
  render(args, value): ContentBlock[]                      // ← 模型通道
  presentationMeta?(args, value): JsonValue                // ← 人通道（持久化）
}
interface ToolDefinition {
  presentCall?(args): ToolCallView | undefined             // ← 人通道（待执行卡片）
  presentResult?(args, result: ToolResult): ToolResultView // ← 人通道（完成卡片）
}
interface ToolResult { content: ContentBlock[]; isError: boolean; meta?: JsonValue }
```

`presentation.d.ts`（367 行）是一整套**与人界面无关的渲染意图词汇**：`generic / terminal / diff / search / read / web` 六种卡片。

**回答原问题**：

1. **有 `presentationMeta`** —— 就是那次报错里 `must declare output { schema, render, presentationMeta? }` 的第三个，是**可选的**。它的自述是「tool-private **presentation** payload … persisted on `tool/result` … for Host presenters and Client renderers to narrow independently」。
2. **它不是「只给人看」的旁路，而是「模型看不见」的旁路**：`[已核]` 会话日志的事件形状是 `'tool/result': { turn, step, message, error?, meta? }`，而 `deriveMessages()` 对 `tool/result` **只取 `event.data.message`**（`dsh-session/lib/index.js:225`）—— `meta` **不进模型上下文**。`[已核]` 客户端确实读它（`dsh-client-ui-tool/lib/client.js:66-73, 314, 394` 读 `block.meta`）。
3. **但 `data` 本身两条通道都到不了**：会话日志里**没有 `value`**（`appendToolResult` 只写 `{turn, step, message, error?, meta?}`）。完整 `value` 只活在进程内（`materializeFinalResult` 的返回值 + `tools/result` 事件的 `value`）。
   → **原先的假设「人通过 session log 看到完整 `data`」不成立**。人能看到的是：**`render` 文本** + **`meta`**。
4. **今天人看到的就是模型看到的那段文本**：没有 `presentResult` 时，客户端落到 generic 卡片，卡片正文是 `resultText(node)` —— 把 `node.content` 的文本块原样拼起来（`dsh-client-ui-tool/lib/client.js:193-199`）。`node.content` 就是 `render` 的输出。
   → **「一稿两用」是当前事实，不是猜测。** 而且两边都不理想：模型被整块 JSON 拖累，人也在对话里读同一坨 JSON。
5. `presentCall` / `presentResult` 在**当前 peer 下限** `@deepseek-ai/dsh-tools@0.1.7-rc.1` 里**已经存在**（已下载该版本 tarball 核对：`lib/types/presentation.d.ts` 367 行，`ToolCallView` / `ToolResultView` / `presentCall` / `presentResult` / `presentationMeta` 全在）→ **用它们不抬高 peer 下限**。

### 8.2 双通道怎么用（本仓的决定）

| 通道 | 机制 | 本仓怎么用 |
|---|---|---|
| **模型** | `output.render` | **L1 + L2 + L3**（§3）。这是唯一进模型上下文的东西 |
| **人（持久化）** | `output.presentationMeta(args, value)` | **承载 `audit`**（§5）。`meta` 与 `value` 同源，不需要第二份数据 —— **一个记录，两种投影** |
| **人（卡片 / 标题）** | `presentCall` · `presentResult` | **对 Web 客户端无效**（见下），不是「暂不使用」 |

> ⚠️ **更正上一轮的建议**：我曾写「`presentCall` 只给一行标题、成本一个纯函数、建议做」—— **这条是错的**。
> `[已核]` 在**全部 `@deepseek-ai` 包**里 grep `presentCall` / `presentResult`（点号调用、属性访问、连字符串形态各一次）
> → **Web 客户端一个都不读**。`presentation.d.ts` 自己的开头就写了它们面向的是
> "an editor's tool-call card, a CLI log line" —— 也就是**别的 UI 宿主**，不是这个 Web 客户端。
> → 所以：**在本客户端上，宿主半边声明 `presentCall` / `presentResult` 什么都不会发生**。
> 人通道要做，只有 §8.5 那条路。

**为什么 `presentResult` 不做（理由已更新）**：不是「返回 `GenericResultView.content` 会变成第二份文本」——而是**上一条：声明了也不渲染**。要卡片就得加客户端半边（§8.5）。

> ⚠️ **`presentationMeta` 在本仓是「存而不用」** —— 这一条必须写死，否则下一个人会去查「谁在读 `meta`」直到查空：
> - **只有生产者，没有消费者**。我们写 `meta`，但**没有任何 UI 读它**：客户端不认这四个工具名（落 generic 卡，正文取自 `node.content`，与 `meta` 无关）。今天读 `meta` 的只有 `read` / `write` / `edit` / `grep` / `glob` / `web_*` 那几张**宿主自己的卡**。
> - **它当下的全部价值是「东西落在会话日志里」**，而不是「有人看见它」。会话日志是它唯一的读者路径，而会话日志 UI 是否把 `meta` 渲染出来 —— **未实测**。
> - **写它的理由是为将来留的**：将来要看 `audit`，只有两条路 —— 补一个读 `meta` 的客户端半边（§8.5），或直接读会话日志文件。
> - **成本照实记**：`meta` 进**每一次** `tool/result` 事件，撑大的是**会话日志**（且不会被 spill 兜住，见 §5）。所以它是**有代价的预留**，不是免费的。

**`presentationMeta` 的三条纪律**：
- **必须是无损 JSON** —— `Session.append` 用 `isJsonValue` 运行期校验，非序列化值会在 append 处被拒。
- **必须纯函数** —— 会话日志回放时会被再次调用。
- **它不会被自动 spill**（§5）：`audit` 撑大的是会话日志，所以大 `audit` 要先走 `spillStore`。

**一处新坑（值得进活跃坑）**：本仓的 `{ok:false}` 在宿主眼里是**成功结果**（§4），所以宿主的 `isError` 恒 `false`；写 `presentResult` 时**不能**用它判断本仓的失败分支。

### 8.3 借鉴：宿主自己的工具怎么做「一个记录两种投影」

读宿主官方工具的实现（本机运行时 `…\@deepseek-ai\dsh-*`），有三条可直接抄的做法：

| 出处 | 做法 | 我们抄什么 |
|---|---|---|
| `dsh-tool-fs` 的 `read` | `presentationMeta: (_args, value) => ({ path, offset, lines, totalLines, lang })`，`render` 给模型文本 | **这就是「一个记录两种投影」的官方样板**。`presentation.d.ts` 自己写明了理由：这些结构化字段**无法从模型可见的文本里还原**，所以要走 `presentationMeta`。我们的 `audit` 同理 —— 它**本来就不是模型文本** |
| `dsh-tool-fs` 的 `write` | `presentationMeta` 里算一次 hunk diff；`presentResult` 再从 `meta` 窄化回卡片 | **projector 只算一次**，两条通道共享它，不做第二份数据 |
| `dsh-tool-cordis` 的 `cordis_inspect_query` | `render` 就是 `JSON.stringify(value, null, 2)` 原样输出；另加一个 `presentCall` 只给标题（`Query Cordis host Service.listService`） | **`presentCall` 是「只给人、不花模型上下文」的最低成本收益**；但**它的 render 我们不抄**（见下） |

**为什么 `cordis_inspect_query` 可以整块 JSON 而我们的工具不行**：它的返回值**全是模型要读的载荷**（服务目录 / 一个契约），没有「结论」这一层；而我们的工具返回的是**判定 + 证据**，模型要的是判定。同一套投影，两种记录形状 → 两种 render。这不是双标，是**投影要跟着记录形状走**。

**两条借来的纪律**：

- **别自己发明截断通知的措辞**：宿主 spill 的通知形状是 `(<n> bytes omitted … Full formatted result stored at: <locator>. <retrievalHint>)`（`dsh-spill-policy`）。我们 `audit` 落盘时**沿用同一形状**，人看到的是同一种句子。
- **截断必须同时给总数**：官方的 search 卡片带 `truncated` + `total`，理由写在 `presentation.d.ts` 里 —— 「**绝不把被裁过的结果当成完整的**」。我们的 L2 截断照此办理（明说被裁 + 给总数）。

### 8.4 改正：创造模式的 `Inspect providers` 不是「generic 卡」

**我上一轮说「官方自己的 cordis 工具也只是 generic 文字卡」—— 那句话是错的。** 错在把**两代不同名字的工具**当成了同一批（`[已核]`）：

| 名字 | 客户端有没有定制卡 | 证据 |
|---|---|---|
| `cordis_inspect_list` / `cordis_inspect_query`（**Inspect providers**，我们实际用的那几个） | **没有** → generic 文字卡 | 两者**都不在** `TOOL_VARIANTS` 里（`client.js:97-113`） |
| `cordis_package_inspect` / `cordis_runtime_inspect` / `cordis_run` / `cordis_stop` / `cordis_undefine`（**上一代** define/run 那批） | **有** —— 全套定制行 + 交互面板 | `TOOL_VARIANTS` 里有它们（`package_inspect`/`runtime_inspect` → `read`，其余 → `others`）；`dsh-client-ui-cordis/lib/client.js:1446-1482` **keyed `tool.call.toolview`** 注册 `CordisDefineRow` / `CordisRunRow` / `CordisActionRow`；另有 `tool.view.cordis` 插槽（`slots.d.ts`，Package 可在卡片里渲染自己的交互区）与面板动作（`onApprove` / `onRun` / `onStop` / `onRemove`） |

**所以「创造模式的 UI」指的应该是后者**（Plugin Manager 之前的那一代定义/运行卡片，那个包的 README 自己就写了 "Historical … New Creator plugins use Plugin Manager"）。我上一轮拿前者去问「有没有卡片」，**问错了对象**。

**这条改正不影响 `presentResult` 的结论，但换了理由**：

- **错的那半句删掉**：不能说「官方自己也不做卡」。
- **真正的理由**：**卡片的门在客户端半边**。定制行靠的是 `ctx.slots.register('tool.call.toolview', …)` 这个 **keyed slot**（声明在客户端插件里、要 `dsh.client` 元数据），**不是**宿主半边的 `presentResult`（`presentResult` 只能返回宿主预置的六种 `card` 形状）。本仓**今天没有客户端半边**（`package.json` 的 `dsh` 里只有 `bundle.patch`，没有 `client` 字段）→ 所以「给这四个工具做卡片」= **新增一个客户端插件**，与 `presentResult` 是两件事；`presentResult` 单独做，天花板就是 generic 卡里换一段文本。
- **上一条「没有人读 `meta`」仍然成立**，但要按这个理解：**不是没人愿意读，是本仓没有读它的那一半**。哪天要做卡片，正确的路是**补客户端半边**，而 `meta` 正好是它的输入（`tool.view.cordis` 那种 keyed 插槽拿的也是这类宿主投影）。

**可借鉴 / 不借鉴（更新）**：`cordis_inspect_query` 那种「**一堆 JSON 原样给模型**」的 render 仍然不抄（它的返回值没有「结论」这一层）；`cordis_package_inspect` 那套**keyed 卡片 + 面板**作为将来补客户端半边的**范本**记在这里。

### 8.5 视觉层（粗体 / 图标 / 标题）**整个归客户端**，工具声明不了

维护者 2026-10-13 给了一张真机截图：`Query runtime · host`，**粗体标题 + 一个图标 + `·` + 摘要**，并说「可以学这个设计，粗体字，并且复用它的图标」。把这套视觉的来源查到底，结论是**它不由工具决定**：

| 视觉元素 | 谁决定 | 证据（`dsh-client-ui-tool/lib/client.js`，本机 `0.2.1-alpha.2`） |
|---|---|---|
| **标题文字** | 客户端的**工具名 → locale key** 表 | `TOOL_TITLE_KEYS:134` `cordis_inspect_query: "tool.title.queryRuntime"` → `dsh-client-ui-conversation:19846` `"Query runtime"` |
| **摘要 `host`** | 客户端从 **args** 推 | `deriveSummary(variant, argsRaw)` + `SUMMARY_KEYS`（args 派生；注释自己写明「result-derived summaries are a ledger item」） |
| **粗体** | **CSS 按工具名前缀** | `client.js:1473`：`.o3BgMG_root[data-tool^=cordis_] .o3BgMG_title{font-weight:500}` / `.o3BgMG_title{font-weight:400}`；而 `data-tool` = `toolName`（`:1764`） |
| **图标** | 客户端的**工具名 → variant → 图标**表 | `VARIANT_ICONS`（`:1789-1797`）+ `classifyTool`（`:169-171` 查 `TOOL_VARIANTS`）；另一条按前缀的路是 `detailIcon`（`:3990-4000`，`toolName.startsWith("cordis_")` → `IconCordisPluginOutlineRegular`） |

**所以：那行粗体是 `cordis_` 前缀白拿的**（`font-weight:500`），我们的 `dsh_*` 前缀永远是 `400`；图标同理。**工具侧没有任何字段能改这两样** —— `presentCall` 连读都没人读（§8.2）。

**要复用，只有一条路：给本仓加客户端半边。**

- 形态：`package.json` 的 `dsh.client` 声明 + `ctx.slots.register('tool.call.toolview', …)` 注册 **keyed** 条目（**范本：`dsh-client-ui-cordis/lib/client.js:1446-1482`**，它注册自己的 `CordisDefineRow` / `CordisRunRow`）。
- **图标可直接复用**（都在 `@deepseek-ai/dsh-client-ui-primitives` 的导出表里）：`IconCordisPluginOutlineRegular`（`cordis_` 前缀用的那个，最可能是截图里那个）、`IconBrowseOutlineRegular`（`read` variant 用）、`IconSparkleRegular`（`others` 兜底）。
- **粗体照抄 500**（不自己发明一个新值），**结构照抄 `标题 · 摘要`**（`sep` 是 2px 圆点，`margin:0 8px`）。
- **注意它不是 `presentResult` 的替代品**：keyed 条目拿的是**冻结的 call/result 切片 + `block.meta`**，所以 §5 的 `audit`（走 `presentationMeta`）正好是它的输入 —— 两条设计在这里接上。
- **代价照实记**：新增一个客户端构建产物（要进 `files`、要过 `check:release`、多一份 HMR/replay 语义），且 keyed 条目必须在 **call/result 两侧都可重放**。→ 因此**排在形态改造之后**，不进 §9 的 ⓪–⑥。

**未定**：截图里那颗图标究竟是 `IconCordisPluginOutlineRegular`（走 `detailIcon`，说明那一行是 **DetailsRow**）还是 `VARIANT_ICONS.others = IconSparkleRegular`（走 generic 卡）—— 取决于客户端把 `cordis_inspect_query` 的结果派发到了哪条行渲染路径（它有 `inspectionDetails` 的解析分支，`:3730-3745`）。**做之前先在那张卡上量一次**，别猜。**这条不影响「必须加客户端半边」的结论。**

---

## 9. 推进顺序

一步一个 PR，每步都能独立验收。**第 ⓪ 步必须在 ① 之前**（它决定 `audit` 的设计空间），**第 ① 步先用一个工具做样板**再推广。

| 步 | 内容 | 为什么排这里 |
|---|---|---|
| **⓪ 可达性探针** | 只判「`ctx.get('spillStore')` 在本插件的 `ctx` 上解析得到吗，`saveText` 能不能落一次盘」。**不做别的形状** | 它决定大 `audit` 有没有地方去（§5.1）。不可达 → `audit` 必须重新设计成有界，②③ 的形状都要跟着变 → **必须最先跑** |
| **①a 单工具样板** | 只改 **`dsh_diagnose_plugin_load`** 一个：新契约（删 `hint`、并 `evidence`、`nextStep` 两分支）+ 三层输出 + 四段描述 + 按 §10 的红线脚手架 | 「三层输出 + 三段 `data` + 四段描述」是否真的可行，只有一个工具能回答；**改动面与全量一样，但回退只回一个文件**。样板跑通后再推广 |
| **①b 推广到其余四个** | 把 ①a 定稿的骨架套到 `effect_mode` / `check_auth` / `dump_config` / `hot_reload` | ①a 已经把所有形状决策做完，这一步是**搬运**，不再做设计 |
| **② 三个补字段** | 启动日志解析、`dsh.bundle` 检查、Client failure 措辞 | 无新机制；`diagnose` 已经读了同样的源（且它在 ①a 里已被改过，正好接上） |
| **③ 双投影** | `data` 三段化收口 + `presentationMeta` 带 `audit`（**不再附带 `presentCall`** —— 对 Web 客户端无效，见 §8.2） | 依赖 ⓪ 的结论与 ①a 的三层渲染定稿 |
| **⑦ 客户端半边**（形态之外，最后） | 加 `dsh.client` + keyed `tool.call.toolview`：**粗体标题（500）+ 复用宿主图标 + `标题 · 摘要` 结构**，读 `block.meta` 里的 `audit`（§8.5） | 它只影响**人**通道、不影响模型；代价是新构建产物与 replay 语义 → 排一切之后 |
| **④ `dsh_sign_cookie`** | 独立工具 + 真机红线 | 算法是照抄（SKILL §3.4 已实测），但**错误信号是二值**、调试困难，值一条独立真机红线 |
| **⑤ `dsh_restart`** | 四道闸 + marker + 恢复 | 不可逆，排一切之后 |
| **⑥ 隔离实例** | 另一个仓 | 与本仓边界已由 §1 划清 |

**为什么 ⓪ 可以很便宜**：`[已核]` 服务在同一次组合里、与我们的行同一作用域、且宿主自己的同级插件用的就是 `ctx.get` 这个写法（§5.1）。所以 ⓪ 不是「调研」，是一次**三行探针 + 一次真实落盘**，跑完即结案。

**`SKILL.md` 已解冻**（维护者 2026-10-13 拍板）：技能**跟着插件一起演化**，不再逐字冻结在 v2.1.4。
→ 具体动作：**新增一节「干预」**，纳入写侧（`hot_reload` / `restart`）与派生（`sign_cookie`）工具 —— 原 SKILL 定位是「排障」、只含诊断，写侧与派生工具**在原文里没有家**。
→ 排期：**与 ① 同批**（`hot_reload` 已经在跑，写侧的知识现在就该有落点，不必等到 ⑤）。
→ 连带同步点：`AGENTS.md` 里「SKILL.md 是逐字复制的 v2.1.4 本体、修正与否待拍板」那条待办**同批改掉**；`test/redlines.test.ts` 的 **B12**（技能文件本体）断言的对象从「与原件逐字一致」改成**结构约束**（见 §10 的 B12 修订注）。

---

## 10. 红线清单

**原则：能断言的，不靠自觉。** 全部落在 `test/redlines.test.ts`，编号从 **B16** 起（B15 是现有最后一条）。

**新增两条由本轮拍板/复查产生**：

- **B24（拍板加）`execute` 全路径不抛** —— 见下表与下方说明。
- **B12 修订（解冻的连带）**：现有 B12 断言的是「技能文件本体」的**结构**（frontmatter 合规 + 正文 >500 字符，`redlines.test.ts:1007-1060`），**并不断言与 v2.1.4 逐字一致** → `SKILL.md` 解冻后 **B12 无需改动**。反而要**补一条**：新增的「干预」一节必须**真的存在**（否则「解冻了但没写」是静默的）→ 归入 **B12b**。

| # | 红线 | 怎么断言（机械判据） |
|---|---|---|
| **B16** | **输出里不许有恒定块** | 同一工具用**两份不同 fixture** 各渲染一次，取所有 ≥40 字符的行；**两份都出现的行 → 判红**。**判定范围只看 `verdict:` 行与 L2 行**，**必须排除**：`[tool] …` 头行、`nextStep:` 行（两份 fixture 的 nextStep 合法地相同）、**截断模板行**（`<n> more line(s) not shown …` 是恒定模板，同 n 时误红）。不排除就是假红（§3.1 规则 5）<br>⚠️ **两份 fixture 还必须换环境（各一份临时 home）**：`resolved:` 这类行按环境恒定 ⇒ 共用同一个 home 时必然逐字相同 → **假红**（W1 实测踩到，§3.1 规则 6） |
| **B17** | **下一个工具的参数标识符必须出现** | 对含 `nextStep.args` 的 fixture，断言每个值能在**模型看得到的地方**找到：**`verdict:` 行 / L2 行 ∪ 目标工具自己的描述与参数文本**。⚠️ **范围必须排除 `nextStep:` 行** —— 那一行按格式**本来就会**把 `args` 印出来，不排除则本条**恒真**（redline-verifier 实测确认）。<br>⚠️ **取值面是「看过没有」，不是「这次输出里有没有」**（2026-10-13 修正）：本条的**本意**是「别让模型去用一个它从没见过的**标识符**」（entryId / port / authority / 路径 / 包名）。而 `change:'host-code'` 这种**目标工具自己的封闭枚举**，模型在**那个工具的参数描述里**就读得到 —— 逼它出现在本次输出里是**错的红线**（W1 因此把可派发的工具建议降级成了 `manual`，那是真损失）。所以要扩成上面那条并集。<br>三个例外：`0`/`1`/空串这类到处都在的值不算数；`args` 为空对象时**不适用**（**跳过并计数，不许静默 skip** —— 活跃坑 18） |
| **B18a** | **`nextStep` 出现时必须带动作** | 断言它属于 §4 的两支之一：`{tool, why}`（`tool` 非空字符串）或 `{manual: true, why}`。**这条是根因**：没有动作的 `nextStep` 在类型上写不出来 |
| **B18b** | **L3 的 `why` 不许逐字等于 L1** | 断言两者字符串**不相等**。**这条是防御性症状监控**，不是根因判据 —— 与 B18a 拆开正因为「结论恰好等于动作描述」是合法的，而「结论被当下一步复述」是坏的：前者由 B18a 排除，后者由本条报警 |
| **B19** | **观察层四个工具不许间接 import 到取值路径** | 从 4 个观察工具文件出发走完整 import 图（含 `lib/**`），断言**不出现** `lib/cookie.ts` 的导出名与 `lib/credentials.ts` 的取值函数；只有存在性扫描可达 |
| **B20a** | **描述四段骨架 + 下界** | 断言描述由 `what / useWhen / boundary? / cost?` 四字段声明、`what` 与 `useWhen` 非空、**每个参数描述非空**且**合计 > 0**；`composeDescription` 用 `\n` 连接；合成后 **`行数 ≥ 段数` 且 `行数 ≤ 4`**；单工具 description ≤240 字符。**参数描述的上界（≤100）已删**（§2，2026-10-13 拍板）—— 只留两条下界，质量归 §10.1 评审。<br>⚠️ **下界必须写 `行数 ≥ 段数`，不能写 `=== 段数`** —— 段内允许折行（`useWhen` 1–2 行、`boundary` ≤2 行），写等号会给**合规**的两行段判**假红**；<br>⚠️ **而没有下界时，把连接符改回空格会让行数=1、`1 ≤ 4` 照样通过 —— 我拍板的「A」就白拍了**。两种错法都已实测；<br>⚠️ **`行数` 的「行」必须先滤掉空段再数**（§2.1）：不滤空段时，`boundary`/`cost` 缺省产生的空行会把行数垫到 4，**上下界一起通过** —— 见 §10.0 口 2 |
| **B20b** | **描述不许复述输出** | 断言**描述文本与该工具 render 输出之间不存在 ≥40 字符的共享串**（同 B16 的取交集手法，对象换成「描述 × 输出」）。**这条能抓「逐字抄输出结构」** |
| **B21** | **`data` 外层形状是闭集** | 断言每个工具的成功与失败返回值顶层都是 `{verdict, key, audit}`（+ 显式声明的额外顶层字段白名单），且 `key` / `audit` 都是对象 |
| **B22** | **`audit` 不进模型文本** | 断言 `render` 的文本里**不出现** `audit` 的任何叶子值（用哨兵字符串放进 fixture 的 `audit`，断言渲染结果不含它） |
| **B23** | **观察层不许自己写文件** | 在 B10 的扫描上加。**注意它大部分是 B10 的子集**（`[已核]` B10 已扫全 `src/**`，其 `FS_WRITE_NAMES` 已含 `writeFile`/`mkdir`）—— **真实增量只有两条**：① 项目内 helper 名（如 `writeText`），B10 那条「须有 `node:fs` 来源」的规则照不到；② 把判据钉在**观察层闭包**而不是整个 `src/**`。不写明这一点，下一个人会以为 B23 提供了 B10 没有的 fs 覆盖 |
| **B24** | **`execute` 全路径不抛** | 对**每个工具**注入「底层端口抛异常」的替身（`spawn` / `fetch` / `loader` / `reload` 各来一次），断言 `execute` **返回一个合法的 `ToolResult` 而不是抛出**。判据是 **`ensureToolResult(value) === value`**（恒等 ⇒ 这个值是过了守卫的，不是被合成的兜底），不是「没报错」 |

**B24 为什么是红线而不是注释**（维护者 2026-10-13 拍板）：失败形状的承载条件是**契约**，不该只活在注释里。

- **它今天就是红的 —— 已实测，红在 4/6 组**（redline-verifier 按本卡判据跑出来的数，不是估计）：

  | 工具 × 替身 | 替身被调 | `execute` 的结果 |
  |---|---|---|
  | `check_auth` × `fetch` | 1 | 返回 `not-running`，过守卫 ✅ |
  | `effect_mode` × `spawn` | 1 | **THREW** |
  | `dump_config` × `spawn` | 1 | **THREW** |
  | `diagnose` × `spawn` | 1 | **THREW** |
  | `diagnose` × `loader` | 1 | **THREW** |
  | `hot_reload` × `reload` | 1 | 返回 `internal`，恒等 ✅ |

  印证 §4 那句「五个工具里只有 `hot_reload` 有顶层 `try/catch`」—— 四个观察工具**真的会抛**。
- **判据为什么不是「没报错」**：那是活跃坑 37 的形状（症状消失 ≠ 根因修好）。根因事实是「**返回的是一个结构合法的结果**」。
- **它的声明边界（必须写明，否则下一个人会误以为它管得更多）**：**B24 抓不到「异常被吞掉」** —— `try{…}catch{ return fail({kind:'internal'}) }` 的返回值合法，B24 照样绿。那是坑 37 的地盘，不是这条红线的。
- **配套硬要求（redline-verifier 实测踩出来的）**：**替身被调用次数 = 0 必须判红**，不许 skip。它的第一版探针在 `probe()` 里另造了一份 deps、注入被丢掉 → 六组**全部「通过」** → 差点得出「B24 今天已经是绿的」这个**反结论**。

**B12b（解冻的连带）**：断言 `skills/dsh-plugin-debugging/SKILL.md` **含「干预」一节**且该节非空。`[已核]` 现有 B12 **不比对 v2.1.4 原件**（只查 frontmatter 合规与正文长度），所以解冻**不会**让 B12 变红；但反过来，**不补 B12b 的话「解冻了却没写」是静默的**。

**B16 / B22 互为反面**：前者禁「恒定块进输出」，后者禁「`audit` 进输出」。两条合起来 = §3 + §5 的全部内容。

### 10.0 一类共同的假绿：**只有上界、没有下界**（「让判据空转」）

上表里凡是形如「**不得包含 X**」的断言，都有一条**反直觉的失效方式**：候选集为空时它**恒真** —— 判据看起来是绿的，其实什么都没测。已确认的三处（`[已实测]`）：

| 断言 | 空转方式 | 必须补的下界 |
|---|---|---|
| **B16** | 两份 fixture 都渲染出 0 行/极短行 → 「共有行」为空 → 恒真 | **候选行非空** |
| **B19** / **B23** | import 闭包解析失效 → 闭包为空 → 「不含越界写法」恒真 | **闭包非空** |
| **B20a**（口 1） | 把参数描述全删光 → 合计 0 → 通过 | **每个参数描述非空** |
| **B20a**（口 2，本轮补） | `boundary` / `cost` 留空却**不滤空段** → 空行被算进行数 → 两段齐全也数出 4 行 → **`行数 ≥ 段数` 与 `行数 ≤ 4` 同时通过**，而描述里躺着两条空行 | **`composeDescription` 先滤空段再 `join`**（§2.1）+ 断言**不存在纯空白行** |
| **B20a**（口 3，**实测确认，已咬到 4 个文件**） | **参数描述读错层级**：`defineTool` 把参数**编译**成 JSON schema（`{ type, properties }`，见活跃坑 11），而 `Object.values(tool.parameters)` 拿到的是 `'object'` **字符串**与 properties 对象本身 → 每条 `description` 都是 `undefined` → **合计恒为 0**。上界还在时这是**恒真的**（`0 ≤ 100`）；**上界删掉之后，接住它的正是那两条下界** —— 这反过来证明「**下界才是防空转的那一半**」。**实测：本仓 5 个工具的测试里 4 个是这种写法**（`hot-reload.test.ts` 是唯一写对的） | **点进 `.properties`**（照 `test/tools/hot-reload.test.ts` 的写法）+ **参数个数 > 0** + **每个参数描述非空** + **合计 > 0** |

**统一硬要求：空转必须判红，不许 skip**（与活跃坑 18 同族；GitHub 把 skipped 当 Success）。
**推论（可直接抄）**：写红线时，每条都要自问一句「**我怎么把它弄成空转**」；能空转的，就把「非空」写成断言的一部分。redline-verifier 的第一版 B24 探针就是栽在这上面（deps 接错 → 六组全「通过」 → 差点得出「B24 今天已经是绿的」这个**反结论**）。

### 10.1 断言的边界：B20 原来那条不能成立

**原 B20 混了两种东西**：一条能断言（四段骨架 + 上限），一条**不能**（「不得出现输出结构复述」，靠**开放黑名单** `known false positives` / `exit code`）。

**为什么黑名单必然漏**：从「输出结构」到「描述文字」没有有界映射 —— `exit code`、`退出码`、`status code`、`the schema dump reports…`、`总是 0` 都是同一件事的写法，穷举不完；而**漏一条就是假绿**（活跃坑 18 的同族：假绿比假红贵）。加长黑名单只是把「显然漏」变成「看起来不漏」。

**处置**：拆成 **B20a（机械）** 与 **B20b（机械，但窄）**。B20b 只抓**逐字复述**，抓不到同义改写 —— 这一点**明说**，不留给人以为它全覆盖：

| 失败形态 | 谁抓 |
|---|---|
| 描述里逐字抄了输出里的句子（例：把 `verdict` 的句式搬进描述） | **B20b（机械）** |
| 描述里同义改写了输出结构（例：把「退出码恒 0」写成 `the plain dump always reports success`） | **抓不到** → 归**评审清单**（下方），不是红线 |

**因此红线清单一共 12 条不是 10 条**（B18→B18a/B18b、B20→B20a/B20b；另加 B12b。B24 本就在表内，不另计。编号故意留 `a/b` 后缀、不重排，避免与已引用的编号漂）。

**评审清单（不进红线，因为不可机械断言）**：

1. 描述里有没有**同义改写**的输出结构说明。
2. 描述③「边界」写的反直觉点，是否**真的**在输出里出现过（否则是凭空写的）。
3. `key` 里留下的字段，是否**真的**会被下一个决定用到（B17 只管「标识符出现」，管不了「多余字段」）。
4. **参数描述逐条自问「模型看不到这条，会不会填错？」** —— **留**：怎么填 / 不填怎样 / 有什么陷阱；
   **删**：从参数名能推出 / 与工具描述重复 / 纯机制解释。**这是上界（≤100）被删之后的替代品**（§2）：
   机械部分只剩「非空 + 合计 > 0」，**质量只能人工过** —— 所以这条不是可选项。

**这四条故意留人工**：把它们写成正则只会造出「看起来被守住了」。**不可断言的事，宁可标成评审项，也不要做成假红线。**

### 10.2 侦察阶段确认「做不到」的四条（写下来，防下一个人硬凑）

| # | 做不到什么 | 为什么接受 |
|---|---|---|
| 1 | **B19 看不穿包名**：只解析相对 import，包带进来的取值函数看不见 | 要模块解析器，代价远超收益 |
| 2 | **B20b 抓不到同义改写** | 已是 §10.1 的结论（「输出结构 → 描述文字」没有有界映射） |
| 3 | **B16 / B17 不做近似匹配**（改写成同义句、折行） | **近似匹配引入假红，比漏更贵** |
| 4 | **B24 抓不到「异常被吞掉」** | `try{…}catch{ return fail({kind:'internal'}) }` 的返回值**合法** ⇒ B24 照样绿。**这是坑 37 的形状**，不在这条红线的声明范围内 —— 但必须写明，否则会被误以为覆盖了 |

**第 4 条与 §10 的 B24 配套读**：B24 保证「抛出去」这条路不存在；「吞掉」那条路**没有红线**，只能靠评审与变异测试。

---

## 附录 A：参考实现索引

调研方式：**只读**（npm registry 元数据 + GitHub API）；热重载与重启的核心路径**补读了实现源码**（结论见 [HOST-CONTRACTS.md](HOST-CONTRACTS.md)）。下表「核心做法」= **各项目 README 的自述**，不是我们的实测。

| 包名（版本） | 仓 | 核心做法（自述） | 可借鉴点 | 与我们的差异 |
|---|---|---|---|---|
| `dsh-plugin-reload` 0.2.1 | reina4xa/dsh-plugin-reload | 工具 `reload_plugin`，按 entry id / 模块名 / MCP `serverName` 重启单个 entry | 三种定位方式；「先 import 成功再换 fiber」的顺序（**本仓已实现并实测**） | 它是工具调用触发的单 entry 重启；我们先判「改动属于哪一档」 |
| `dsh-hot-reload` 0.2.4 | stuarthu/dsh-hot-reload | watch profile 的锁文件，已加载插件版本变化时原位替换；**失败过的版本不自动重试** | 「不自动重试失败版本」这条我们原本没有 | 它事件驱动、面向升级；我们工具调用驱动、面向刚改完源码 |
| `dsh-hotswap` 0.1.1 | HongzhongL/dsh-hotswap | Web 侧热启用/停用/重启；把开关写进 profile patch 的托管区块；**保护名单** | **保护名单**；`entry.update({disabled})` 是 Loader 级开关的正解 | 它允许写 profile；**本仓不写 profile** |
| `dsh-smart-restart` 0.5.1 | edusrez/dsh-smart-restart | 启动检测到新进程接管就 notice 唤醒；记录调用方会话；**canary 预检**；从 cgroup 识别 systemd | **canary 预检**（我们四道闸没有）；记录调用方会话 | 它是 systemd/Linux 导向；本机是 Windows，闸④必须处理「拿不到启动命令」 |
| `dsh-restart` 0.1.2 | anweat/dsh-restart | 工具 + `/restart` 命令；**自 0.1.3-alpha.4 移除内置 detached watchdog**，理由是交给外部管理器 | **「不自建看门狗」的判例**（他们做了又撤） | 我们的 §6.1 已改为「优先交给外部」 |
| `dsh-desktop-auto-restart` 0.1.0 | comer2031/dsh-desktop-auto-restart | 工具默认不注册；先写「待唤醒清单」再调脚本；**宿主繁忙时拒绝，调用方自己不算忙**；无 `force`；按端口 + 精确 PID | 与 §6.1 最接近的一份；另有三条硬信息：执行策略 `Restricted` 时脚本静默不执行而 WMI 仍返回 rc=0（**假成功**）；WMI 建进程会被安全软件记敏感动作；非桌面形态直接拒绝 | 它靠 PowerShell + WMI + user32，只支持 Windows 桌面端 |

**未找到的包**（npm registry 404）：`dsh-reload`、`dsh-host-restart`、`dsh-safety-restart`、`dsh-resume-on-restart`、`dsh-keep-going` → 记为「未找到」，不推断其存在。
**一处只作技术出处的引用**：`cordis-plugin-hmr` 在 npm 上不存在（404），只出现在 `dsh-plugin-reload` 的自述里；本机相关的 hmr 包是 `@deepseek-ai/dsh-hmr` 与 `@deepseek-ai/dsh-client-hmr`。
**调研边界**：参考实现面向的**不是**本机运行时版本 → 涉及 API 形状的结论必须回到本机运行时核对，冲突时以本仓实测为准。

## 附录 B：本文的同步点

**本文取代了原先独立的 `docs/RESTART-PLAN.md`**（已删除并并入 §6.1 与附录 A）—— 「未做的工具怎么做」与「整体形态」是同一件事，分两处会漂。

引用了 `RESTART-PLAN.md` 的地方已同批改为指向本文：[ARCHITECTURE.md](ARCHITECTURE.md) 头部、[HOST-CONTRACTS.md](HOST-CONTRACTS.md) 头部与 §5、[AGENTS.md](../AGENTS.md) 的能力面 / 文档地图 / 待办。

**文档分工（改版后）**：SHAPE 答「最终长什么样、怎么改」；ARCHITECTURE 答「现在为什么这样分层、代价是什么」；HOST-CONTRACTS 答「宿主实际上是什么样」；PUBLISHING 答「怎么发」；AGENTS 答「在这个仓里怎么干活」。

## 附录 C：真源索引（本文每条结论去**哪**找，重找得回来）

**为什么要有这份索引**：本文的结论分三类出处 —— 本仓源码、宿主运行时、仓外参考实现。前两类会随版本漂，第三类**可能被删掉**。
所以每条都写成**可重找**的形式：**仓内用相对根的路径 + 一个检索串**（不写行号，行号会漂）；**仓外不写机器绝对路径**，只写「**包名 → 包内路径 + 检索串**」与**重新取回的命令**。

> **纪律**：本仓文档**不许链接仓外路径**（链接校验会判 error）。所以下面所有仓外位置一律**写成文字，不做 Markdown 链接**。

### C.0 怎么定位宿主运行时（每次现查，别抄值）

```shell
npm root -g            # → <全局 node_modules>；宿主在它下面的 @deepseek-ai/dsh
dsh --version          # → 运行时版本（本轮所有宿主结论来自 0.2.1-alpha.2）
dsh --profile web --dump-config    # 只读转储：某个服务/行在不在组合树里、在第几层
```

要**在离线、可对照的形态下**读某个宿主包的源码（推荐，因为它固定版本）：

```shell
# 取任意版本的包到自己目录解开，不装、不动全局
npm pack @deepseek-ai/dsh-tools@0.1.7-rc.1     # → 解出 package/lib/types/presentation.d.ts
```
（本轮用这条核对过 **peer 下限**里 `presentation.d.ts` 已存在，见 §8.1 第 5 条。解出物是临时件，可删。）

### C.1 宿主运行时真源（结论 → 包 → 包内路径 → 检索串）

| 结论 | 包 | 包内路径 | 检索串 |
|---|---|---|---|
| 三个投影的形状（`render` / `presentationMeta` / `presentCall` / `presentResult` / `ToolResult`） | `@deepseek-ai/dsh-tools` | `lib/types/index.d.ts`、`lib/types/presentation.d.ts` | `ToolOutputDefinition` · `ToolDefinition` · `ToolCallView` |
| `presentationMeta` 是可选第三项 + 那句报错文案 | `@deepseek-ai/dsh-tools` | `lib/types/index.js` | `must declare output` |
| 三个投影的**调用点**（成功分支才跑 render/meta） | `@deepseek-ai/dsh-tools` | `lib/index.js` | `createSuccessResult` · `snapshotProjection` · `materializeFinalResult` |
| 只有**抛出的异常**算失败（本仓 `ok:false` → `isError:false`） | `@deepseek-ai/dsh-tools` | `lib/index.js` | `toolErrorResult` |
| 会话事件 `tool/result` 的形状（`message` + `error?` + `meta?`，**没有 `value`**） | `@deepseek-ai/dsh-session` | `lib/types/types.d.ts` | `'tool/result'` |
| `meta` **不进模型上下文** | `@deepseek-ai/dsh-session` | `lib/index.js` | `deriveMessages` |
| 持久化时**只写 `message`/`error`/`meta`**，不含 `value` | `@deepseek-ai/dsh-agent-loop` | `lib/index.js` | `appendToolResult` |
| spill 服务与策略、通知措辞、阈值配置 | `@deepseek-ai/dsh-spill` · `dsh-spill-policy` | `lib/index.js`、`lib/types/types.d.ts` | `"spillStore"` · `maxInlineTokens` · `formatSpillNotice` |
| spill 行挂在哪个 bundle（= 本 profile 有没有） | `@deepseek-ai/dsh-base` | `cordis.patch.yml` | `spill-local` · `spill-policy` |
| 卡片视觉全按**工具名**决定（标题表 / variant 图标表 / 粗体前缀选择器 / `data-tool`） | `@deepseek-ai/dsh-client-ui-tool` | `lib/client.js` | `TOOL_TITLE_KEYS` · `VARIANT_ICONS` · `data-tool^=cordis_` · `detailIcon` · `resultText` · `inspectionDetails` |
| 可复用的图标集（`Icon*OutlineRegular`） | `@deepseek-ai/dsh-client-ui-primitives` | `lib/index.js` | 末尾的 `export { … }` 表 |
| 官方 **keyed 卡片**范本（将来客户端半边的样板） | `@deepseek-ai/dsh-client-ui-cordis` | `lib/client.js`、`lib/types/client/slots.d.ts` | `tool.call.toolview` · `tool.view.cordis` |
| 客户端半边怎么声明 | **任一** `@deepseek-ai/dsh-*` | `package.json` | `dsh.client` |
| client 查询三态措辞（`Client failure` 的真出处） | `@deepseek-ai/dsh-cordis-host-runner` | `lib/index.js` | `Client failure` · `hasLiveClient` |
| 「有没有在线页面」 | `@deepseek-ai/dsh-api-gateway` | `lib/index.js` | `hasLiveClient` |
| 创造模式**独有**什么（对照两个 preset 的工具行） | `@deepseek-ai/dsh-web-app` | `presets/cordis.patch.yml` vs `presets/standard.patch.yml` | 都比 `dsh-tool-` 行 |
| 恢复预设：`agentPreset` 是持久会话事实 | `@deepseek-ai/dsh-session` · `dsh-agent-preset-registry` | `lib/types/types.d.ts`、`lib/index.js` | `agentPreset` · `agentPresetProjectionDefinition` |
| `appendPluginRecord` 的类型语法（`plugin:` 前缀） | `@deepseek-ai/dsh-session` | `lib/index.js` | `PLUGIN_RECORD_TYPE` |
| Windows 进程树杀（宿主自己的用法） | `@deepseek-ai/dsh-subprocess-local` | `lib/index.js` | `taskkill` |

### C.2 本仓真源（相对**仓根**的路径）

| 要找什么 | 路径 |
|---|---|
| 五个工具的实现（描述 / 参数 / 契约 / `nextStep`） | `src/tools/dsh_*.ts` |
| 工具共享依赖 + `effectiveConfig` + 输出 schema | `src/tools/shared.ts` |
| 模型可见渲染（现状：摘要 + 整块 JSON） | `src/lib/render.ts` |
| 契约（`ok` / `fail` / `nextStep` / `evidence` / `ensureToolResult`） | `src/lib/errors.ts` |
| 契约与 `execute` 不抛的判据、以及 B10/B15/B14 等旧红线 | `test/redlines.test.ts` |
| 单测助手（`expectOk` / `expectFail` / `expectFailEvidence` / `run`） | `test/tools/helpers.ts` |
| 技能本体（**已解冻**，待补「干预」一节） | `skills/dsh-plugin-debugging/SKILL.md` |
| 打包配置（`files` / `exports` / `dsh.bundle` / `peerDependencies`） | `package.json` |
| 启哪个 entry 进 profile | `cordis.patch.yml` |
| 发布态不变量 | `scripts/check-release.mjs` |
| 真机红线（本机跑，不进 CI） | `test/integration/README.md` + `test/integration/*.ps1` · `*.mjs` |
| 决策与代价（为什么这么定） | `.agents/notes/*.md` |
| 宿主已核事实台账 | `docs/HOST-CONTRACTS.md` |
| 现状设计（为何这样分层、代价） | `docs/ARCHITECTURE.md` |

### C.3 仓外参考实现（**可能已被删，故写下重现方式**）

本轮参考的是 6 份第三方实现的源码，缓存在**工作区**（不在本仓、`git` 忽略、可随时删）：

```
<工作区>/.local/refs/            # 6 份参考实现的只读检出
<工作区>/.local/detached-spawn/  # 本机的 detached / 树杀实验产物与结果 json
```

**要重新取回**：附录 A 的表里每一条都带**来源仓**（`<owner>/<repo>`），按它是 GitHub 仓库 clone 即可；包名与版本见同表。
**它们的证据等级**：附录 A 的「核心做法」是**各自 README 的自述**，不是我们的实测；与本仓实测冲突时**以本仓实测为准**。
**`detached-spawn` 那批产物的用法**：`treekill-results.json` 是 §6.1 第 2 条的实测依据（S1 父自然退出 helper 存活 / S2 `taskkill /T /F` 把 helper 一起带走）。缓存没了就要重跑那套实验，结论本身仍写在 [HOST-CONTRACTS.md](HOST-CONTRACTS.md) §2.1（B1–B9）。

### C.4 本文里带版本的引用怎么读

正文里的 `文件:行号`（例：`client.js:1473`、`config.js:97-113`）**都是本机运行时 `0.2.1-alpha.2` 的快照**。
宿主换版本后行号必然漂 —— **按 C.1 的「检索串」重找，不要按行号找**。同一条纪律见 [AGENTS.md](../AGENTS.md) 的「不抄会漂的值」。
