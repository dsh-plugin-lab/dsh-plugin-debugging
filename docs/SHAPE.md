# SHAPE — 插件形态：工具怎么分、JSON 怎么管、模型和人各看到什么

**本文职责**：这个插件**最终长什么样** —— 四类角色、工具清单、描述层骨架、输出层三层、契约、`data` 的三段划分、**双通道**（模型 / 人）、工具的归属、代码边界、推进顺序、以及能把上面这些**钉住的红线**。
**不负责**：宿主侧已核 / 未核的事实 → [HOST-CONTRACTS.md](HOST-CONTRACTS.md)；为什么这样分层、代价是什么 → [ARCHITECTURE.md](ARCHITECTURE.md)；发布流程 → [PUBLISHING.md](PUBLISHING.md)；在这个仓里怎么干活 → [AGENTS.md](../AGENTS.md)；决策快照 → [.agents/notes/](../.agents/notes/)。
**读者**：要动这个插件的形态（加工具、改描述、改输出、改契约）的人。**动之前先读本文，再读 HOST-CONTRACTS。**

> **本文是方案，也是已拍板决定的记录。** 已实现的形态（**工具清单以注册处为真源**、`{verdict, key, audit}` 三段契约、双通道）以 [ARCHITECTURE.md](ARCHITECTURE.md) §5 为真源；本文写**目标形态**与**已拍板但尚未落地的部分**。引用宿主事实时只标**可信度等级**，等级的定义与分级清单在 [HOST-CONTRACTS.md](HOST-CONTRACTS.md) 的「怎么读本文」—— 本文不重述证据（一处一事实）。

---

## 1. 整体形态：四类角色

插件定位是**「Agent 和它身处的运行时」**。工具按**认知角色**分四类，不按个数分。

| 类 | 工具 | 粒度判据 |
|---|---|---|
| **观察** | `dsh_check_effect_mode` · `dsh_diagnose_plugin_load` · `dsh_check_auth` · `dsh_dump_config` | 这是四个**问题**，不是一个工具的四个参数：何时生效 / 加载没有 / 是 401 还是没起 / 组合成什么。**加工具不改这一层** |
| **派生** | `dsh_sign_cookie` | 唯一会**产出凭证**的工具：不同权限（要读密钥）、不同参数（authority / ttl）。**绝不能并进 `check_auth`** —— 那会把秘密带进一个判定型输出 |
| **行动** | `dsh_hot_reload` · `dsh_restart` | 可逆与不可逆是两种权限面：前者失败放回旧版；后者不可逆。判据是**要不要审批闸门**。**本表只答归属**，顺序与状态见 §9 与根 [AGENTS.md](../AGENTS.md) |
| **实例** | **列 → 收进本仓**（发现工具，见 §1.2 的 D′）；**建 / 销毁 → 另起插件** | 分界是**动不动手**：**「列」只发现**（扫本机监听者 + 用 DSH 专有签名认领），**不起进程、不写另一个 `DSH_HOME`、不分配端口** ⇒ 不越界；**「建 / 销毁」**要起长期进程、写**另一个** `DSH_HOME`、分配端口 ⇒ **越出两条边界**（B10 只读半边 / B15 写侧只碰进程内树），且它管的是**另一个**进程 |

**两条纪律**：

- **观察要宽，行动要窄**。观察工具一次调用给全该层证据；行动工具一次只做一个动作，有回滚、可审批。
- **判断与行动不合并**。模型必须先看到判断结果，再决定动不动手 —— 合并会剥夺它的决策点。

**「为什么行动要独立」的硬判据（`[已核]` 对照 §1.1 得出）**：**看「错一次能不能撤销」，不看「它算观察还是行动」。**

- 平台**能接受**把观察与行动合到一个工具里 —— `plugin_manager` 就是这么干的（一把工具 + 8 个 `action` 枚举，`list_*` 与 `set_*` 同住）。它之所以可以：那几个 `set_*`/`install` 改的是 **profile 配置**，改错了由 loader 按行重建、再改回来就撤销了。
- 本仓的行动工具改的是**运行中的树**（`hot_reload`，失败必须回滚）与**宿主进程**（`restart`，**不可逆**）→ 它们必须与判断**分开**：合起来会让「先判断再动手」这个决策点消失，而**错一次的代价不可撤销**。
- 这条同时解释了 `sign_cookie` 为什么独立 —— 它可重试、可撤销，**不同在可逆性**，而在**输出里带凭证**。判据是第二条：**有没有秘密要经手**。

**跨实例观察：做（D′）** —— 维护者 2026-10-14 拍板。原设想「观察层四个工具各加一个 `dshHome` 参数」**按字面核不上**（三条理由见 §1.2），所以改为**两块一起做**：**① 新增一个「列出活着的 DSH 宿主」的发现工具**；**② 给文件型工具加 `dshHome`（含把 `DSH_HOME` 注进子进程环境）**。`check_auth` 用 **authority**、`hot_reload` **不加**（跨不了，描述里诚实标注）、`restart` **不加**（行动类只能作用于本宿主，§1.2 第 3 条）。
⚠️ **硬边界**：**发现只能给 authority，给不出 home** ⇒ 「让文件型工具指向别的实例」**只能调用方手填路径**，**不得承诺自动配对**。识别 DSH 靠**专有签名**（未认证 `GET /` → 401 且 body 逐字是那句），**不是「401 就是 DSH」**。细节与代价见 §1.2。
**特例**：**「列」进本仓，「建 / 销毁」不进** —— 分界是**动不动手**（§1 实例类判据）。

**工具名是冻结的模型可见 API**。加工具、改描述可以；改已有工具名不行。「描述层」因此是**唯一还能调路由的杠杆**。

### 1.1 与「创造模式」那批工具的设计对照（本轮核对，`[已核]`）

**先纠一个我上一轮含混的说法**：`[已核]` 比对 `dsh-web-app/presets/` 的 `cordis.patch.yml` 与 `standard.patch.yml` 的**工具行集合** ——
`cordis` 独有 = **只有 `@deepseek-ai/dsh-tool-cordis` 一项**（即 `cordis_inspect_list` + `cordis_inspect_query` 两把）；`standard` 独有 = 空。
**`plugin_manager` 两个 preset 都有**（在 `@deepseek-ai/dsh-web-app` 的 `presets/cordis.patch.yml` 与 `presets/standard.patch.yml` 里各按检索串 `tool-plugin-manager` 定位），`cordis_define` 那批旧名字只存在于**客户端历史卡片**里、不在任何 tool schema 中。
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

### 1.2 §1 那句「接缝」为什么按字面核不上、以及 **D′（已拍板）**

§1 末尾那句「观察层四个工具加一个 `dshHome` 参数，隔离实例因此本身可被观察」**核不上**，没有按它的字面实现。

**三条核不上的理由**（架构评估）：

- **`diagnose` 的 Loader 半边是进程内的**（`ctx.get('loader')`）→ **跨 home 永远不可得**。换个 `dshHome` 参数也答不了另一个实例的树状态。
- **spawn 型工具不注入 env 会读回本进程 home**（`src/lib/exec.ts` 的 `env` 默认 `process.env`）→ `effect_mode` / `dump_config` 起的 `dsh` 子进程**不会**跟着参数走。`dshHome` 今天只由插件配置 / `DSH_HOME` / 默认值在加载时定一次（`src/config.ts`），**没有任何工具把它当参数接**。
- **`check_auth` 要的是 authority（`host:port`），不是 `dshHome`** → 一个 `dshHome` 参数喂不进它。

**后果**：「隔离实例本身可被观察」今天**不成立**。四个观察工具里只有 `dump_config` 能看到另一个实例（它跑 `dsh --profile … --dump-config`），但换 home 要改**插件配置或环境变量**，**不是调用时给一个参数**；`diagnose` 跨不了，`check_auth` 喂不进。

#### 已拍板

**不做**（原选项 C）**被维护者 2026-10-14 的决定取代**：改为 **D′**（见下）—— **发现工具可以进本仓**，因为「列」只读、不动手（§1 的实例类判据已按此改）。

#### D′（**维护者 2026-10-14 拍板：做**）

**两块，一起做：**

1. **新增一个发现工具**：**列出活着的 DSH 宿主**。做法 = 扫本机监听者 + 用 DSH 的**专有签名**认领（不是「401 就是 DSH」——见下面的硬边界）。
2. **给「文件型」工具加 `dshHome` 参数**（`dump_config` / `check_effect_mode` / `sign_cookie` / `diagnose`），**含把 `DSH_HOME` 注进子进程环境**这一层。`check_auth` 不加（它要的是 **authority**，本来就收 `host:port`）。`hot_reload` **不加** —— 它换的是**本进程内存**里的模块，跨实例**做不到**，描述里必须**诚实标注**。
3. **`dsh_restart` 两个都不加**（`dshHome` 与 `port`）：它是**行动类**，作用对象**只能是本宿主**；跨实例重启不在边界内（§1 的行动类判据）。理由与前两条不同 —— `check_auth` / `hot_reload` 是「**做不到**」，`restart` 是「**不该做**」。

#### D′ 的硬边界（**必须写进工具描述，否则就是骗模型**）

1. **发现只能给 authority（`host:port`），给不出 home。** 宿主 HTTP 面上没有任何路由能问出「我是谁 / 读哪个 home」；`$DSH_HOME` 里没有别的实例的登记文件；系统里也没有与 home 无关的全局登记处。
2. ⇒ **「让文件型工具指向另一个实例」只能由调用方手填 home 路径**，**不得承诺自动配对**（发现结果与 home 之间没有可推导的关系）。
3. **识别 DSH 要靠专有签名，不能只靠 401**（401 是「需要认证」的通用响应）。签名见下。

#### 已核的识别签名（D′ 的地基）

> 未认证 `GET /` → **401 且响应体逐字**为 `dsh web authentication required; reopen the URL printed by dsh web.\n`。
> 对照：`/api`、`/api/session.export` 的 body 只是通用 `unauthorized`；`/health`、`/version` 是 **404**。
> 证据与真源在 [HOST-CONTRACTS.md](HOST-CONTRACTS.md)（本文不重述）。

⚠️ **401 本身不是签名** —— 任何要认证的服务都会返 401。判据是「**401 且 body 逐字等于那句**」。

#### 三项代价（`[已核]`）

1. **新增工具名 ⇒ B9 的闭集要同批改**。
2. **系统提示多占一段描述**（§2 在数这个字符数，B20a / B20b 管它）。
3. **三平台「列全部监听者」是新能力，不是开关**：现有实现只查「给定那一个端口」，且 **win32 分支的脚本不输出端口**（只输出 `pid|name|startedAt`）⇒ 要扩字段 + 同步改解析器，并**原样保住** `probed` / `listening` / `unidentified` 的**四态语义**（「查不了」≠「没人听」≠「有人听但读不到 pid」）。

#### 跨实例输出必须标注两件事（维护者的硬要求）

**看的是哪个实例** + **看到了哪几层**。半能看到不可怕，**半能看到却不说才可怕** —— 所以：

- `resolved.dshHomeSource` 在参数生效时必须显式是 `tool-argument`（三值纪律：`config` / `env` / `default` / `tool-argument`，**不许把参数来的值印成 `default`**）。
- `diagnose` 跨实例时**必须把两半分开报**：磁盘证据（日志、profile）= **目标实例的**；**插件树状态 = 仅本进程**（那半在别的进程内存里，跨不了）。
- 其余文件型工具的结论句里要能看出**读的是哪个 home**。

#### 原三个候选（保留为记录）

原「不做接缝」的原因是**加一个参数做不到**；现在改做 D′ 后，原候选 A 变成 D′ 的第二块，判据如下：

- **按工具分**（= D′ 采用的）：能跨的给 `dshHome`（并**注入 env**），`diagnose` 那半显式标注，`check_auth` 用 `authority`。代价：工具接口**不再对称**。
- **只承认进程内那半边**：`dshHome` 只定位磁盘证据，Loader 半边标「只覆盖本进程」。代价：`diagnose` 变成「一半答案 + 一句免责」（D′ 实际就是这么处理它的）。
- ~~**不做接缝**~~：**已被 D′ 取代**（原选项 C）。

---

## 2. 描述层：四段骨架

现状：**每个工具**的 description 都在系统提示里占一段固定开销，其中相当一部分是**输出结构的复述**（每次调用都能看见的东西）。
⚠️ **不在这里抄字符数** —— 它是**实测值、会漂**（加一个工具就变），照 §9.3 那条纪律办。**现测取法见下面「硬约束」那张表的字符数那一行**（⚠️ B20a 只在判红时带出数字，**通过时它一个字符都不打** —— 别指望「跑一遍看清单」）；上限常量在 `src/tools/describe.ts`，检索串 `DESCRIPTION_MAX_CHARS`。工具**个数**的真源是注册处 `src/tools/index.ts`。

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
| 单工具 description 字符数 | **≤240**（`DESCRIPTION_MAX_CHARS`，`src/tools/describe.ts`） | 上界是**判据**，不是现状快照。⚠️ **现状值不写在这里**：它随工具个数与文字漂（§9.3 的纪律）。**现测取法**：跑 `pnpm run test` 的 B20a 用例 —— 它**只在判红时**把越界那一项的实际字符数带进失败消息（`offenders` 列表），**通过时不打印任何数字**。所以「跑一遍看清单」这条路不存在：全量当前值要自己按那个上限常量去量 |
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
**同一句不许印两遍**。**这条曾经真的发生过**：`src/tools/dsh_diagnose_plugin_load.ts` 里的旧代码是 `ok({ ...data, verdict }, { why: verdict })` —— **同一个 `const` 绑了两次**，`buildVerdict` 的每个出口都这样（那次修正记在同文件头，检索串 `不再有`）。这不是措辞洁癖：根因是 **`nextStep` 允许没有动作**，而 `why` 的定义是「为什么建议这一步」，没有「这一步」可解释时只剩结论可写。修法：**`nextStep` 必须带动作，没有动作就不出现**。

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

> **为什么不能是 `verdict(data): string`（本轮自查抓到的自相矛盾）**：§3.1 原稿写于「L1 由 `summarize` 钩子产出」的年代；§4.1 把 L1 挪进了 `data.verdict` 并把它**定为必填非空**。
> **那次修订已经落地**：`src/lib/render.ts` 现在**没有** `summarize` 钩子（检索串 `renderToolResultText` 就是它现在唯一的渲染入口），L1 直接读 `data.verdict`。
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
（`args` 缺省 → `()`；与现状一致，见 `src/lib/render.ts` 的 `nextStepLine`）；`manual: true` 支恒为 ``nextStep: <why>``
（现状那行 `nextStep: — <why>` 的空指代按规则 2 消失）。**B18b 比对的是这两支里 `<why>` 的正文**。

**七条冻结规则**：

1. **`audit` 不进这段文本**（B22 用哨兵断言）。渲染只读 `verdict` 与 `key`。
2. **L3 只在 `nextStep` 存在时出现**；两支都要能印出来，`manual` 支不印空括号（现状 `nextStep: — <why>` 那种空指代必须消失）。
3. **截断要明说并给总数**（照 `presentation.d.ts` 的 `truncated` + `total` 判例）：超 `maxKeyLines` 时末行写
   `<n> more line(s) not shown`。
   ⚠️ **末尾到此为止是有意的分歧，不是漏印** —— `— the full record is in the session log` 那半句**不许加回来**：
   **不许在模型通道里指向模型够不到的位置** —— 会话日志里 `tool/result` **没有 `value`**（§8.1 的 `[已核]`），
   被截掉的那些行**任何通道都拿不到**（本仓也没有读会话日志的工具）。B27 按**规则**判这件事（换个同义
   说法一样红），不按这一行的字面判。
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
→ **已拍板落成 B24**（见 §10）：`[已核]` **当时**「只有 `hot_reload` 有顶层 `try/catch`」，四个观察工具都没有 —— 那条红线**当时**就有活干。
⚠️ **那句计数与那份分布都已过期**（2026-10-14 复核）：**六个工具的 `execute` 现在都有顶层 `try`**（逐个看 `src/tools/dsh_*.ts` 即可）。所以这条红线的是非**不以本节为真源** —— 真源是 `test/redlines.test.ts` 的 B24，工具**数目**以注册处 `src/tools/index.ts` 为准。

### 4.1 冻结签名：结果契约（W1–W4 一律照此实现，不许各自解释）

```ts
// ── src/lib/errors.ts ──────────────────────────────────────────────
type ToolResult<T> =
  | { ok: true;  data: ToolData<T>; nextStep?: NextStep }
  | { ok: false; error: ToolError; data: ToolData<T>; nextStep?: NextStep }

interface ToolError { kind: ToolErrorKind; message: string }   // hint 已删，就两项
type ToolErrorKind = …                                          // 闭枚举，成员以 `src/lib/errors.ts` 的 `TOOL_ERROR_KINDS` 为准（**不在文档里抄条数**）

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
- **本仓自己写文件违反 B10**（只读半边，不许写 `$DSH_HOME`）。**这一条现在是机器判据**（2026-10-14 落地）：`test/redlines.test.ts` 的 B10 按**路径前缀**判——写动作一旦指向宿主数据目录（`profiles` / `sessions` / `storages` / `logs` / `cache` / `attachments` / `backups` / `integrations` / `mcp` / `settings.yaml` / `.credentials.yaml` / `.salt` / `.anonymous-user-id`）或取值为 `DSH_HOME` / `dshHome`，当场红。**读**这些路径不在禁止面里（那是诊断半边的本职）。
  ⚠️ **同日维护者放宽了一处（见 §10.3 的形态 A）**：**只放过 `$DSH_HOME/<包名>/` 这一层**（目录名**逐字**等于包名），该层以下随便分；其余顶层项**一律照旧禁止**。注意别混：`$DSH_HOME/logs` **禁止**，`$DSH_HOME/<包名>/logs` **放过** —— 只看紧跟 home 的**第一段**。

**合法通道，按优先级**：**① 宿主 `spillStore` 服务**（是宿主在写，不是本仓在写；`data.audit` 换成 `{locator, bytes, retrievalHint}`）；**② `presentationMeta`（会话日志）**。**不要写进 `inject`**（缺席会把整个插件挂成 PENDING，`skills` 已经踩过这条），要用 `ctx.get('spillStore')` 探测，缺席就退回 ②。

⚠️ **`spillStore` 不跨重启**（`[已核]` 源码）：它默认落**每进程私有临时目录**，并在启动时清扫 ⇒ **适合「这次会话里的大 `audit`」，不适合任何要活过重启的东西**（`dsh_restart` 的 marker 因此**不能**放这里 —— 见 §6.1）。
→ **「放宽写自己的命名空间」已于 2026-10-14 拍板：做，形态 A（精确一层）** —— 清单与两种形态的差异见 §10.3。本仓因此多了一条**可持久**的自有落点：**`$DSH_HOME/<包名>/`**（子目录随便分）。

### 5.1 `spillStore` 可达性：**已真机实测**

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

## 6. 工具的归属（含尚未做的）

| 目标 | 归属 | 理由 |
|---|---|---|
| 启动日志解析 | **并入 `diagnose`** | 同输入（`$DSH_HOME`）、同问题、同时机；现在只列路径不解析 = 把解析推给模型 |
| `dsh.bundle` 声明检查 | **并入 `diagnose`** | 那个包的 `package.json` 已经在读了；它正是 SKILL §3.2 的第三类原因 |
| Client failure 三态 | **不进 `check_auth`** | `[已核]` 三态来自 `dsh-cordis-host-runner` 的 **client 查询分支**（无在线页面 / 超时且 handler 抛错 / provider 未注册），**不是 HTTP 层**；并进 HTTP 探针会把两种传输混成一个结论。措辞 → 描述层③（零工具改动）。唯一可观测项是「有没有在线页面」，走 `typertGateway.hasLiveClient()`（见下） |

**「有没有在线页面」的可达性**（`[已核]`，只读源码 + 只读转储）：

- 服务存在且**挂在同一个根层**：`dsh-api-gateway` 提供 `ctx.typertGateway`（`@deepseek-ai/dsh-api-gateway` 的 `lib/index.js`，检索串 `typertGateway`）；组合树里有 `- id: typert-gateway`、与我们的行同级、无 `disabled`（用 `dsh --profile <p> --dump-config` 现查，**别按行号找**）。
- 语义**极简**：`hasLiveClient()` 就是「有没有一条未取消的 client 事件流」（同包同文件，检索串 `hasLiveClient`）—— 它回答的是「**有没有页面连着**」，**不是**「页面健不健康」，也**不是**官方那句 `Client failure:` 的来源。
- **它答不了「三态」**：`Client failure: <msg>` 是 **host-runner 那条查询路径**的措辞（`hasLiveClient()===false` → 另一句；超时且 handler 抛错 → `Client failure`；provider 未注册 → 第三句）。所以本仓若报它，只能报一个更弱的事实（「此刻没有在线页面」），措辞必须**用我们自己的话**，不能冒充官方那三句。
- **依赖面**：它跨了模块（要 `ctx.get('typertGateway')`）。**它不在本仓既有的跨模块调用清单里**（本仓目前只有 `ctx.tools` / `ctx.get('loader')` / `ctx.agents` / `ctx.skills` 那几处，且每处都在 AGENTS 的活跃坑里记了代价）→ 用不用它是一次**新增依赖面的决策**，不是顺手加个字段。**建议：不在 v1.1 做**，先把三态措辞放进描述层③（零依赖）。
| `dsh_sign_cookie` | **独立工具**（派生类） | 见 §1 |
| 隔离实例 | **另起插件** | 见 §1 |
| `dsh_restart` | **独立工具**（行动类） | 见 §1 与 §6.1 |

### 6.1 `dsh_restart`（原独立文件的内容并入本节）

**为什么它比热重载危险**：重启**不可逆** —— 它杀掉当前进程、连同发起这次调用的那个回合。

| | 热重载（已实现） | 重启 |
|---|---|---|
| 失败形态 | 旧版本放回，可继续 | **进程没了、会话回不来** |
| 可恢复性 | 重试即可 | 需要 marker + 唤醒，且要看外部进程管理器脸色 |
| 最难的部分 | 顺序（已解决） | **闸门与恢复**，不是动作本身 |

**四道闸**（任一不过即拒绝；**只有闸②另有显式逃生口 `force`**，见本节末）：

| 闸 | 判据 | 拒绝时的返回 |
|---|---|---|
| ① 重启循环熔断 | 短窗口内重启次数超阈值 → 拒绝 | `restart-loop` |
| ② 其他会话在跑 | 除调用方自己以外的活跃会话仍在执行回合 → 拒绝；**调用方自己的会话不算忙** | `busy` + 列出阻塞者 |
| ③ bundle 表解析不了 | profile 的 `bundles` / patch 解析失败 → 拒绝 | `bad-composition` + 指路 `dsh_dump_config` |
| ④ **载体没有已实测的回归路线** | **先问「这个载体能不能把宿主带回来」，再问「命令拼不拼得出来」**：路线为 `none` ⇒ 拒绝；路线是 `task-scheduler` 但定不出启动命令 ⇒ 也拒绝（**不猜**） | `no-relaunch-route` / `no-launch-command` |

闸②的判据已可落地（`agents.list` 的 `status` / `inbox`、`jobs.list`、`workspace/session-activity`），契约与一条 **fail-closed 要求**见 [HOST-CONTRACTS.md](HOST-CONTRACTS.md) §2.3（忙判定与唤醒通道）。

**闸④的语义在 2026-10-16 变更过一次，但四道闸的数量没变** —— 变的是闸④的观测更准。原判据只问「命令拼不拼得出来」，而 2026-10-15 的真机缺陷恰好是**命令拼得出来却拼错了**（桌面宿主上 `argv` 齐全 ⇒ 旧闸④放行、宿主退出、没人回来）⇒ 现在**先问路线、再问命令**。两个拒绝码的分工：

- `no-relaunch-route` —— **现实**问题：这个载体**结构上**没有通道。三档：桌面宿主（只有 Electron 壳能 `app.relaunch()`）、非 win32（没有已实测路线）、认不出来（不猜）。重试不会让它变。
- `no-launch-command` —— **取值**问题：路线在（`task-scheduler`），但启动命令定不出来。改配置可能让它变。

两档的措辞（`verdict` / `remedy`）**只写在 `src/lib/carrier.ts` 的 `relaunchRefusalFor` 一处**，判定在 `src/lib/restart.ts` 的 `judgeLaunchCommand`。载体这一维的宿主事实（谁拉起桌面宿主、插件侧为什么没有通道）在 [HOST-CONTRACTS.md](HOST-CONTRACTS.md) §2.7 —— 本文不重述。

**流程（顺序是判据）**：闸门检查 → **审批门** → **写 marker（落盘，必须在拉起之前）** → 拉起新进程 → **本进程退出** →（新进程）读 marker → 恢复会话 → 注入 notice → **把 marker 标为「已消费」**（**不是删除**：宿主 `fs` 缝上没有任何删除方法 —— 状态迁移替代删除的裁决见 §10.3 与 [HOST-CONTRACTS.md](HOST-CONTRACTS.md) §2.5）。
**桌面载体在「闸门检查」这一步就拒绝，也就是动手之前** —— 不写 marker、不拉起、不退出，一条副作用都不发生；这正是闸门排在审批门之前的意义。

**实现落点**：库半边 `src/lib/restart.ts`（marker + 四道闸 + 恢复判定）· `src/lib/carrier.ts`（载体观测 + 只认已实测路线的回归路线表）· 真实 IO `src/lib/restart-fs.ts`（走宿主 `ctx.fs`）· 恢复半 `src/lib/restart-recovery.ts`（由 `src/index.ts` 调度）· 工具壳 `src/tools/dsh_restart.ts`（四道闸 → 审批门 → 写 marker → 计划任务拉起 → `appExit`）；注册处在 `src/tools/index.ts`。

**四步的通道都已核过**（证据与分级在 [HOST-CONTRACTS.md](HOST-CONTRACTS.md) §2，这里只留结论）：

- **退出 = `ctx.get('appExit')`** —— `AppExit = (code: number) => void`，语义原话「**等树 dispose 完**再退」；`dsh web` 的启动器**实测真的 provide 它**（`provideCmdline(hostCtx, { …, exit: (code) => void shutdown.shutdown(code) })`）。⚠️ **别用 `process.exit`**（源码注释点名那条路 bypassing `ctx.appExit`）；取不到要**转成结构化失败**（B24：不许抛）。**顺序：先 `await` 完 marker 的写，再调 `appExit`** —— 反了就是「树都拆了、写还在飞」。
- **审批门的位置本身是判据**：**四道确定性闸门全过之后**才轮到它 —— 反过来会出现「先弹窗让用户同意、再告诉用户闸③不过」。⚠️ 实现要**两段式**：先用 `dryRun` 探一遍闸门（**不落盘**），过了才走审批，再真正落盘 —— 因为 `planRestart` 把「四道闸」与「写 marker」收在**同一个入口**里，**不许**为了插审批而把那道顺序拆坏。
- **审批语义（2026-10-14 改正一处写反的）**：**不声明静态审批** —— 工具自己在动作前**先读档位、再决定问不问**。`ask` ⇒ 调 `request()`（只有 `allowed-once` 算允许；`rejected`/`cancelled`/`unavailable` 一律当拒绝）；**`never`（= `danger-full-access`）⇒ 不问、直接执行**（并在 `key` / `audit` 记 `policy=never, not required`）；读不出来 ⇒ fail-closed。⚠️ **`never` 是「提示已关闭」，不是「拒绝一切」** —— 在那一档主动去问**必然被拒**，那会把「你什么都授权了」变成「什么都不许做」。机制真源见 `dsh-user-approval`（`decide()` 的 `never` 分支 + `effectivePolicy()`），档位接线见 profile 的 `cordis.yml`（`danger-full-access` ⇔ `sandbox: danger-full-access` + `approval: never`）、`[已核]`。
- **拉起** = 首选外部管理器 / 计划任务（见下面那张降级路径表）。
- **恢复** = 新进程读 marker → `resolveAgent` 唤醒 → `followup` 投 notice（**信息性，不是「请继续」**；notice 只放事实 + 指针）→ 标记已消费。通道实测与分级见 [HOST-CONTRACTS.md](HOST-CONTRACTS.md) §2.4.1（含 C28 那条闭环与末尾「工具壳写的 marker 已被恢复半真消费」那条）。

- **拉起优先交给外部管理器**（supervisor / Windows 服务 / systemd）；插件只做「查闸门 → 落盘 marker → 退出」。**自建 helper 是降级路径**，而它的落地方式**已被本机实测改写**（见下条）。
- **降级路径：`{detached: true}` 已实测不可用，改用「由一个不在宿主 job 里的进程代起」**（`[已实测]`，证据在 [HOST-CONTRACTS.md](HOST-CONTRACTS.md) §2）：

  | 方式 | 结论 |
  |---|---|
  | `{detached: true}`（本插件自己的 `spawn`） | ❌ **子进程落在宿主的 job 里** ⇒ 宿主退出时被 `KILL_ON_JOB_CLOSE` 一起收掉。「两级 detached」同样不可靠 |
  | **计划任务**（`schtasks`） | ✅ **首选** —— 无需提权、父进程是 `svchost.exe`、实测**不在宿主 job 里** |
  | `explorer.exe` 代起 | ✅ 同样不在宿主 job 里 |
  | PowerShell 中间进程 + `Add-Type` 代发 `CREATE_BREAKAWAY_FROM_JOB` | ✅ 机制成立（宿主 job 恰好有 `BREAKAWAY_OK`），但**更贵**（要 spawn + 编译 C#），非首选 |
  | WMI `Win32_Process.Create` | ⚠️ **不能判定**（本机只验到「不在宿主 job 里」，其余未知）—— **别拿它当依据** |

  **三种可用方式都能用现成的 `src/lib/exec.ts` 实现，不需要任何原生绑定。**
  ⚠️ **仍未测**：「是否也在**另一个** job 里」（job 身份未知）⇒ **helper 的长期存活必须由插件内真机实测钉死**，不许当已排除风险。
  **绝不按进程名批量杀**：按**监听端口 + 精确 PID**，与本仓既有的「按端口找进程」一致。**不拥有 watchdog**（参考实现曾移除内置 detached watchdog，理由是交给外部管理器）。

- **marker 落点：`$DSH_HOME/<包名>/restart/marker.json`**（维护者 2026-10-14 拍板；那正是 §10.3 形态 A 开出的白名单，所以**不违反 B10**）。**必须是独立文件** —— 理由是**可发现性**：文件有固定路径，新进程启动即可读；若改放会话日志，得**逐会话扫日志**才能找到（宿主没有按类型索引的读入口）。

### 6.1.2 无窗口宿主的可见停止入口（2026-10-17 拍板）

§6.1.1 把控制台拿掉之后，宿主**没有了任何可见的停止方式**（`MainWindowHandle=0`、Web GUI 没有
退出入口）。补回来的办法是：**启动器另外拉起一个可见窗口，由它持有宿主所在的 Job Object 句柄。**

**机制一句话**：窗口进程持有一个带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 job，宿主被收编进去。
窗口结束 ⇒ 最后一个句柄关闭 ⇒ **内核**终结宿主。所以关窗口 / Ctrl+C / 被强杀**三条路都成立**，
包括 `finally` 根本不跑的那条（实测 0.3 s）。

⚠️ **Ctrl+C 走的是按键通道，不是信号**（2026-10-17 真机踩过）：窗口由 `wscript` +
`Shell.Run` 拉起，那会给子进程建**新进程组**，而 Windows 对 `CREATE_NEW_PROCESS_GROUP`
**默认禁用 Ctrl+C** —— 信号根本不送达，用户一直按、窗口毫无反应，而**关窗口照常有效**。
对策是 `[Console]::TreatControlCAsInput = $true`，让 Ctrl+C 以普通按键进输入缓冲，主循环
每 100 ms 轮询。这条不依赖进程组标志、不依赖控制台模式、也不依赖祖先装过什么 handler。
**同一个缺陷在原型里测不出来**：原型是用 `Start-Process -WindowStyle Normal` 起的（没有新进程组），
Ctrl+C 是好的 —— 换到生产路径才暴露。教训：**验证要在真实启动路径上做**。

⚠️ **这不是「插件在杀进程」**：`src/**` 里没有 `taskkill` / `Stop-Process` / `process.kill`，B10 照旧绿。
**也正因为如此，不许加「显式杀进程的兜底」** —— 那会把「内核动的手」降级成「我们的代码杀的」，
并让两份实现开始漂。这一条由 `test/assets.test.ts` 守着。

**身份按端口**（多实例）：真宿主的命令行里**没有** `--port` / `--profile` / `DSH_HOME`（实测），
所以窗口轮询 `<port>` 的属主 pid，并要求进程名是 `node`。两个实例实测互不影响。

⚠️ **端口必须经 `resolvePort` 解析，不能直接拿配置值当端口**。2026-10-17 真机 dry-run 抓到过
这个错：当时 `ResolvedConfig.port` 是 `number`、默认 `0`（语义是「自己推断」），直接传下去产出
`launch-0.job` / `stop-window-0.pid`，窗口去绑 0 号端口、永远找不到宿主，而**当时 931 条用例 +
CI + lint 全是绿的**（没有任何判据断言过端口是几）。

**已按「把哨兵挡在边界」修掉**（同日）：

| 层 | 现在的形状 |
|---|---|
| schema（`Config.port`） | `z.number().default(0)` 照旧 —— `0` 在**用户没填**这个位置是合理的惯用法 |
| `ResolvedConfig.port` | `number \| undefined`：**「没写」而不是「0」**。「忘了解析」从静默的 0 变成类型上的缺席 |
| `resolvePort` | 三段优先级不变（显式参数 > 配置 > `DSH_WEB_URL`），只接受 `number \| undefined` |
| 拼文件名的三个函数 | 收到非正数**抛 `RangeError`**（断言而非控制流）—— 哨兵真正咬人的就是这一层 |
| 端口定不出来时 | **不创建停止窗口**，作业文件名退化成 `launch.job`，且 `key.stopWindowSkipped` 明说原因 |

⚠️ **本机实测：宿主进程里没有 `DSH_WEB_URL`**（`dsh_check_auth` 报 `no port could be determined`），
所以 `resolvePort` 的第三条来源在真机上不成立 —— 得靠插件配置里的 `port`。**代价是装了这个插件
的人必须自己配端口**，否则重启后没有停止窗口（会如实报 `stopWindowSkipped`，不是静默失败）。
这一条是**待修缺口**：见根 [AGENTS.md](../AGENTS.md) 待办里的「自动发现宿主自己的端口」。

**单例**：命名 mutex + pidfile + 启动器拉起前先验活 ⇒ 连跑三次启动器窗口数恒为 **1**。

**落地形态 = 静态资产 + 一个作业文件**（动态值不再拼进脚本）：

| 资产 | 职责 | 为什么要它 |
|---|---|---|
| `assets/launcher.vbs` | 样式 0 隐藏起 `launcher.js` | `node.exe` 是控制台程序，计划任务跑它必开窗口 |
| `assets/show-window.vbs` | 样式 1 开**可见**控制台 | Node 无法请求 `CREATE_NEW_CONSOLE`（`detached` ⇒ `DETACHED_PROCESS`，无控制台） |
| `assets/launcher.js` | 等 pid / 起宿主 / 确保窗口 | 全部决策在这里 ⇒ **可单测** |
| `assets/stop-window.ps1` | 持 job 句柄、绑宿主、渲染面板 | 窗口本体 |
| `restart/launch-<port>.job` | 上面四个要的动态值 | `/tr` 上限 261 字符，塞不进目标命令 |

**两条硬约束**（都是实测出来的，不是风格）：

1. **VBS 必须纯 ASCII**：`cscript`/`wscript` 按 ANSI 读 `.vbs`，一句中文注释会把下一条语句吃掉，
   报错是「未定义的变量」——离真正的原因很远。
2. **命令行不许当 argv 交给 VBS**：`node` 把参数里的双引号转义成反斜杠加引号，`wscript` 不还原
   ⇒ `Shell.Run` **静默失败**，症状只是「没有窗口」。只传路径，命令写进作业文件。

**回退形态**（`wscript.exe` 不在）：`/tr` 直接跑 `node "<launcher.js>" "<job>"` —— 等待与拉起
**同一份实现**，只是会闪一个可见控制台；`key.launcherMode = console-fallback` 如实标出。

决策与全部实测读数 → [.agents/notes/2026-10-17-visible-stop-window.md](../.agents/notes/2026-10-17-visible-stop-window.md)。

### 6.1.1 拉起的落地形态：`wscript` + 启动器（2026-10-17 拍板）

**目标命令不进 `/tr`，而是写进 `$DSH_HOME/<包名>/restart/launch-<port>.job`；`/tr` 只指静态
shim 与那份作业文件**（同目录的 `relaunch.log` 是启动器自己的步骤日志）。三个收益：

1. **不再创建可见控制台。** `wscript.exe` 是 **GUI 子系统**程序，自己**没有控制台**；
   `sh.Run(cmd, 0, False)` 的窗口样式 0 让 `cmd` 也在隐藏状态起。2026-10-17 真机四形态实测
   （20ms 采样 7 秒）：`cmd /c …` **会**创建控制台；`powershell -WindowStyle Hidden …` **也**会
   （ConPTY 下 `SW_HIDE` 管不到 Windows Terminal 的标签页）；`powershell` 不加隐藏更会；
   **只有 `wscript` + 样式 0 是零窗口活动**。二次真机验证：重启前后可见窗口**新增 0 个**。
2. **等待语义从「固定睡眠」变成「等待上限」。** 启动器轮询旧进程（`process.pid`）是否消失，
   一消失就起、最多等到 `delayMs`。真机实测等待 **150 ms**（原固定 3 秒）⇒ 常见路径更快、
   慢退出的路径仍有余量。⚠️ **PID 复用的边界**：判据是「存在该进程号的进程」，
   号码被复用时只会**多等**（到上限为止），方向安全。
3. **原已知限度③（`schtasks` 存储 → 重放之间的引号保真度未实测）不再适用** ——
   那条串不过那两跳了；`/tr` 同时从 199 字符量级降到 105 字符量级（实测）。

⚠️ **回退形态**：`wscript.exe` 不存在时（VBScript 已被微软标记弃用），`/tr` 直接跑
`node "<launcher.js>" "<job 文件>"` —— **能起、但会创建一个可见控制台**，这一点如实进 `key`
（`launcherMode: console-fallback` 出现即是回退）。⚠️ 注意 `node` 直跑**不能**替代 shim：
它本身是控制台程序，而 `schtasks` 没有隐藏开关。**

⚠️ **「脚本写坏 = 静默不启动」这一类风险已结构性消除**（2026-10-17 重构）：两个脚本不再是
运行期拼出来的字符串，而是仓里的静态资产，**能进 CI 校验**（`test/assets.test.ts`：纯 ASCII、
BOM、PowerShell 5.1 解析、以及「不含 taskkill」）。仍然保留的一条纪律是**启动器第一步就写日志、
路径进 `key`** —— 「压根没跑」与「跑了但失败」靠那份日志分开。**下一次遇到同形故障时，先看
`relaunch.log`：不存在 ⇒ 启动器没跑起来。**

  **顺带纠正一条过期理由**：本文原先写「不能写进会话日志，因为会写坏会话日志」——那条说的是**自定义 `SessionEventMap` 成员 + `session.append()`**；而**经 `appendPluginRecord()` 写 `plugin:` 记录是合法的**（它硬写 `ignorable: true`，读取侧不会拒绝解释日志，`[已核]` 源码）。**我们仍选独立文件，是因为上面那条可发现性，不是因为日志不能写。**
  **两条实现裁决（2026-10-14）**：
  1. **marker 是纯 JSON，不加「末尾哨兵行」**（决策笔记里曾提议）—— 数据里夹一行非 JSON 会**破坏 `JSON.parse` 与任何外部读者**；版本演进用「`version` 放第一个键 + 版本门 + 未知版本**结构化失败**（不许读成「没有 marker」）」足够。**这是有意的取舍，不是遗漏。**
  2. **写 marker 不能走 `node:fs`** —— B10 的 `judgeFsWriteUsage` 判的是**来源**（用没用 `node:fs` 写 API），**与路径无关**，所以形态 A 的白名单在**真实写入**面前够不到（`[已核]`：探针实测过）。⇒ 走**宿主 `fs` 服务**（`ctx.get('fs')`，`dsh-fs` 包的 `FileSystem`；与 §5 的 `spillStore` 同族 —— **宿主在写**）。**别用放宽红线的方式解决。**
  ⚠️ **「谁来写」在库半边是注入面**（`RestartFsPort`：`read` / `write` / `remove`，其中 `read` 是**三值**：有内容 / 不存在 / 读失败）——真实适配器单独一层。这样判定逻辑可单测、换实现不动判定。
  **本半实现不了、但被有意保留的一条**：库半边的 verdict 明说「marker 已在任何拉起之前写好；本半不启动进程，因此尚无新 pid」—— **宁可这么写，也不许凑一个 pid。**

**恢复逻辑**：注入的是**信息性 notice**，不是强制「继续」；唤醒走官方通道、按会话原有预设；**唤醒失败保留 marker**，下次启动继续重试。**`reason` 只发给发起者**（靠 marker 的 `initiator` 字段认人）：它是用户给自己留的便条，广播给被顺手打断的其它会话就是**串话**；那些会话收到**同样的事实但不含 `reason`**。⚠️ `initiator` **缺席**（本字段之前写的 marker）的语义是「不知道谁发起的」，此时**谁都不发** —— 不许退化成「那就发给所有人」。

**工具参数**：`{ reason, delayMs（默认 3s，**拉起前的等待上限**：启动器等旧进程退出、一退就起）, dryRun, force }` —— `dryRun` 是本仓特有的（四道闸必须能单独演练）；`force` **只对闸②有效**，且命中时**必须留痕**（见本节末）。
**返回形状**（逐字真源在 `src/lib/restart.ts` 与 `src/tools/dsh_restart.ts`，**不在此抄**）：库半边报 `gates=4/4 passed` + marker 路径 + 「marker 已在任何拉起之前写好」；工具壳报闸门 / 审批 / marker / 拉起 / 退出这几件事。`nextStep` **无**（本进程即将退出）；被闸门拒绝时按 §3 的三层输出，`L3` 给 `dsh_check_effect_mode`。
**验收**：四道闸**各一条拒绝用例**；真机一条「重启 → 会话被唤醒 → notice 到达发起者」闭环；反向用例「marker 存在但新进程没起来」→ 下次启动仍能恢复或明确报「上次重启未完成」；真机判据由**独立角色**跑，写者不自己验自己（[ARCHITECTURE.md](ARCHITECTURE.md) §8）。

**协作纪律（契约，不是建议）**：`dsh_check_effect_mode` 先行 —— `mode=hot` 且 `hmr=present` → 通常不需要写侧工具 `[已实测]`；`mode=hot` 但 `hmr=absent` → 改 config **必须重启** `[已实测]`；`mode=hot` 且 `hmr=present-conditional`（`disabled:` 是运行时表达式 ⇒ 当时按**可用**处理，条件进 L1/L2）→ **按 `present` 那档走，但结论只在那个表达式求值为启用时成立**，这一档**没有实测**；`mode=restart-required` → 走 `dsh_restart`。
⚠️ **保留 profile（`desktop`）上这一节的协作纪律不适用**：那里的 `hmr` 是**不可核实**（CLI 拒绝那个 profile 的 dump ⇒ 组合树读数拿不到），工具会按「**这次的答案是否依赖 hmr**」分岔 —— 依赖的走诚实失败、不依赖的照常回答。结论与真源见 [HOST-CONTRACTS.md](HOST-CONTRACTS.md) §2.7，本文不重述机制。
**拒绝不是失败**：闸门拒绝是设计的一部分，模型应原样报给用户。
**闸②（别的会话在飞）另有一个显式逃生口 `force: true`**（维护者 2026-10-14 拍板）：
它**只覆盖闸②** —— ①③④ 是「这件事根本做不成」，不是「用户知情后的选择」，因此**不可绕过**；
而覆盖**必须留痕**（写日志 + 记进 marker），让「这次是覆盖过的」事后可查。
拍板的理由：**打断在飞的任务不可逆，而拒绝的代价只是等；不可逆的那个该由用户显式决定，不该让工具静默决定。**
（决策记录见 [.agents/notes/2026-10-13-restart-persistence-and-helper.md](../.agents/notes/2026-10-13-restart-persistence-and-helper.md) 的「拍板记录」。）
**不把热重载与重启合并**：失败代价不同、闸门不同；合成一个「修复它」会让模型倾向选更重的那条路。

**待实测清单**（本轮逐条复查过，结论见下表；「已降级」= 本轮查到东西、问题变了）

| # | 待验证 | 本轮复查 | 影响 |
|---|---|---|---|
| 1 | 拉起形态在服务化场景（job object / 服务管理器）下的实际行为 | **本机已实测到一半，问题被缩到「谁启动的 dsh」**：`[已核]` **宿主确实在一个 job 里**，该 job 带 `KILL_ON_JOB_CLOSE`（证据与句柄验证在 [HOST-CONTRACTS.md](HOST-CONTRACTS.md) §2.2.1 —— 本文不重推）。**注意**：这里曾经写「宿主源码里没有任何 job object 代码」—— **那是假话，已被证伪**：`dsh-win32-process` 里有 `CreateJobObject` / `AssignProcessToJobObject`，而 `dsh-subprocess-local` 的 runner 正是用它的 Job-owning 路径。⇒ 剩下的未知是**服务化部署**（Windows 服务 / 计划任务常驻）下的行为，**本机测不了** | 自建 helper 能不能作为降级路径存在（**已另有实测，见下条与 §6.1 的降级路径表**） |
| 2 | 父被 `/T` 树杀时两级 detached 的长期存活 | **已有本机实测，不再是待测**：`.local/detached-spawn/treekill-results.json` —— S1（父自己 exit）helper 活下来；**S2（`taskkill /PID A /T /F`）helper 被连带杀掉**。→ 两级 detached **逃不过树杀**，这是本机结论不是推断 | 同上 |
| 3 | 工具**是否默认注册** | **已查参考实现，答案分裂**：`dsh-smart-restart` 默认 **true**、`dsh-desktop-auto-restart` 默认 **false**（关着时**根本不注册**，模型看不见）。本机是 Windows 桌面形态 → 与后者同场景。**这仍是产品决策，不是技术未知** | 装完即生效 vs 需显式开启 |
| 4 | `appendPluginRecord()` 的可用性与前缀约束 | **已确认**：`dsh-session` 导出 `appendPluginRecord(session, type, data)`；类型语法是 `PLUGIN_RECORD_TYPE = /^plugin:[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/u`（在 `@deepseek-ai/dsh-session` 的 `lib/index.js` 里按检索串 `PLUGIN_RECORD_TYPE` 找），即**必须 `plugin:` 前缀**、只允许小写字母数字与 `._-` 和 `/`。**但有一条新发现**：`@deepseek-ai/dsh-session` **不在本仓 peer 里，也不在 profile 的 `node_modules` 顶层**（那里只有一个 `@deepseek-ai/dsh-mcp-client`）→ 我们的插件**解析不到它**。要用得先加 peer（抬高依赖面），或改用 `ctx.get('session')` 那条路（**未核**） | marker 之外要不要留会话记录 |
| 5 | 「按会话原有预设」唤醒的语义 | **已确认机制**：预设是**持久化的会话事实** —— session header 有 `agentPreset?`（`@deepseek-ai/dsh-session` 的 `lib/types/types.d.ts`，检索串 `agentPreset`），且有一条 `agentPreset` 投影（`init: header.agentPreset`，`apply` 于 `agent-preset/selected` 事件；`@deepseek-ai/dsh-agent-preset-registry` 的 `lib/index.js`，检索串 `agentPresetProjectionDefinition`），其注释明确「重建读投影，不读 header」。→ **「按原预设恢复」在宿主设计里是可表达的**。未钉死的只剩「resume 时真的按它 mount 且结果一致」这一步 | 恢复逻辑能否保证「回来的是同一个上下文」 |
| 6 | 重启后 notice 的投递时序 | **仍不确定**：参考实现给的是经验值（启动后等 3 秒 / 每 4 秒重试、最多 30 次）。可达的通道本机已确证（`agent.followup`，`@deepseek-ai/dsh-agent-loop` 的 `lib/index.js`，检索串 `followup`），但**「多早拿得到会话」是运行时性质**，只能实测 | marker 删除时机与重试策略 |
| 7 | 闸①的阈值怎么定 | **查到参考值**：`dsh-desktop-auto-restart` **硬编码 60 秒并发冷却**（且 README 写明「为安全起见不可配置」）；`dsh-restart` 的 `watchdogCooldownMs` 默认 **60000**。→ 两个独立实现都落在 60 秒 → **本仓取 60 秒有据可依**，不必先验后定 | 会不会把正常运维误判成循环 |

**第 2 条降级后剩下一个真问题**：既然树杀会连带，「自建 helper」只在「父自然退出」这一种情况下成立；而重启恰恰是「父自己退出」→ 树杀那条路**只在别人杀我们时才发生**。这削弱了（但不消灭）对 job object 的担心 —— 见第 1 条。

---

## 7. 代码结构：只加边界，不加层

- **能力落地在 `lib/`，工具文件只做「参数 → 机制 → 契约」的翻译**（现状已是，保持）。落点：日志解析 → `lib/startup-log.ts`；cookie 签发 → `lib/cookie-sign.ts`；`dsh_restart` 的库半边 → `lib/restart.ts` / `lib/restart-fs.ts` / `lib/restart-recovery.ts`。**页面在线（原计划 `lib/inspect.ts`）未做**，理由见 §6。
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

源码：`@deepseek-ai/dsh-tools`（`lib/types/index.d.ts`，检索串 `ToolOutputDefinition` / `ToolDefinition`；本轮核对时本机运行时是 `0.2.1-alpha.2` —— **版本号与行号都会漂，按检索串重找**）。

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
2. **它不是「只给人看」的旁路，而是「模型看不见」的旁路**：`[已核]` 会话日志的事件形状是 `'tool/result': { turn, step, message, error?, meta? }`，而 `deriveMessages()` 对 `tool/result` **只取 `event.data.message`**（`@deepseek-ai/dsh-session` 的 `lib/index.js`，检索串 `deriveMessages`）—— `meta` **不进模型上下文**。`[已核]` 客户端确实读它（`@deepseek-ai/dsh-client-ui-tool` 的 `lib/client.js`，检索串 `block.meta`）。
3. **但 `data` 本身两条通道都到不了**：会话日志里**没有 `value`**（`appendToolResult` 只写 `{turn, step, message, error?, meta?}`）。完整 `value` 只活在进程内（`materializeFinalResult` 的返回值 + `tools/result` 事件的 `value`）。
   → **原先的假设「人通过 session log 看到完整 `data`」不成立**。人能看到的是：**`render` 文本** + **`meta`**。
4. **今天人看到的就是模型看到的那段文本**：没有 `presentResult` 时，客户端落到 generic 卡片，卡片正文是 `resultText(node)` —— 把 `node.content` 的文本块原样拼起来（`@deepseek-ai/dsh-client-ui-tool` 的 `lib/client.js`，检索串 `resultText`）。`node.content` 就是 `render` 的输出。
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
| `cordis_inspect_list` / `cordis_inspect_query`（**Inspect providers**，我们实际用的那几个） | **没有** → generic 文字卡 | 两者**都不在** `TOOL_VARIANTS` 里（`@deepseek-ai/dsh-client-ui-tool` 的 `lib/client.js`，检索串 `TOOL_VARIANTS`） |
| `cordis_package_inspect` / `cordis_runtime_inspect` / `cordis_run` / `cordis_stop` / `cordis_undefine`（**上一代** define/run 那批） | **有** —— 全套定制行 + 交互面板 | `TOOL_VARIANTS` 里有它们（`package_inspect`/`runtime_inspect` → `read`，其余 → `others`）；`@deepseek-ai/dsh-client-ui-cordis` 的 `lib/client.js`（检索串 `tool.call.toolview` / `CordisDefineRow`）**keyed** 注册 `CordisDefineRow` / `CordisRunRow` / `CordisActionRow`；另有 `tool.view.cordis` 插槽（`slots.d.ts`，Package 可在卡片里渲染自己的交互区）与面板动作（`onApprove` / `onRun` / `onStop` / `onRemove`） |

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
| **标题文字** | 客户端的**工具名 → locale key** 表 | `@deepseek-ai/dsh-client-ui-tool` 的 `lib/client.js`（检索串 `TOOL_TITLE_KEYS`）里 `cordis_inspect_query: "tool.title.queryRuntime"` → 该 locale 串在 `@deepseek-ai/dsh-client-ui-conversation` 的 `lib/client.js`（检索串 `Query runtime`） |
| **摘要 `host`** | 客户端从 **args** 推 | `deriveSummary(variant, argsRaw)` + `SUMMARY_KEYS`（args 派生；注释自己写明「result-derived summaries are a ledger item」） |
| **粗体** | **CSS 按工具名前缀** | 同文件（检索串 `data-tool^=cordis_`）：`.o3BgMG_root[data-tool^=cordis_] .o3BgMG_title{font-weight:500}` / `.o3BgMG_title{font-weight:400}`；而 `data-tool` = `toolName`（同文件检索串 `data-tool`） |
| **图标** | 客户端的**工具名 → variant → 图标**表 | `VARIANT_ICONS` + `classifyTool`（查 `TOOL_VARIANTS`）；另一条按前缀的路是 `detailIcon`（`toolName.startsWith("cordis_")` → `IconCordisPluginOutlineRegular`）。`[已实测]` 那张卡走的是**后一条**（DetailsRow，见本节末） |

（上表三处的检索串都指 `@deepseek-ai/dsh-client-ui-tool` 的 `lib/client.js`：`TOOL_TITLE_KEYS` · `data-tool^=cordis_` · `data-tool` · `VARIANT_ICONS` · `classifyTool` · `detailIcon`。）

**⚠️ 纠正本节原来那句结论**（原文：「那行粗体是 `cordis_` 前缀白拿的，我们的 `dsh_*` 前缀永远是 `400`；图标同理。工具侧没有任何字段能改这两样」）。

- **错在后半句**：注册 keyed 条目之后，**那一行就是我们自己的组件** → `fontWeight:500` 直接写在行内样式里即可，**不是只能白拿**。原文把「宿主自己派发的那一行」当成了「我们注册的那一行」。
- **改不了粗体的是宿主自己派发的 generic 行**：它按 `[data-tool^=cordis_]` 选择器决定（`data-tool` = `toolName`，同文件检索串 `data-tool`），而全文件**只有那两条**规则（检索串 `data-tool^=cordis_`）。我们的工具名不落在 `cordis_` 前缀上，所以落在 `400`。
- **「工具侧没有任何字段能改」这半句仍成立**，但它的对象是 `presentCall`（§8.2 无人读），**不是**客户端组件的 props。

**要复用，只有一条路：给本仓加客户端半边。**

- 形态：`package.json` 的 `dsh.client` 声明 + `ctx.slots.register('tool.call.toolview', …)` 注册 **keyed** 条目（**范本：`@deepseek-ai/dsh-client-ui-cordis` 的 `lib/client.js`**，检索串 `tool.call.toolview` / `CordisDefineRow`，它注册自己的 `CordisDefineRow` / `CordisRunRow`）。
- **图标可直接复用**（都在 `@deepseek-ai/dsh-client-ui-primitives` 的导出表里）：`IconCordisPluginOutlineRegular`（`cordis_` 前缀用的那个，`[已实测]` **就是截图里那颗**）、`IconBrowseOutlineRegular`（`read` variant 用）、`IconSparkleRegular`（`others` 兜底）。
- **复用没有「双 React」风险**（`[已实测]`）：`dsh-client-ui-primitives` 走**浏览器模块表**（`window.__ModuleLoader__`）而不是 npm 解析 → 宿主内层的包在插件里同样可得（`dsh-client-ui-tool` 自己就这么 `require`），`require('react')` 拿到的是**同一个** React 实例。
- **粗体照抄 500**（不自己发明一个新值），**结构照抄 `标题 · 摘要`**（`sep` 是 2px 圆点，`margin:0 8px`）。
- **注意它不是 `presentResult` 的替代品**：keyed 条目拿的是**冻结的 call/result 切片 + `block.meta`**，所以 §5 的 `audit`（走 `presentationMeta`）正好是它的输入 —— 两条设计在这里接上。
- **代价照实记**：新增一个客户端构建产物（要进 `files`、要过 `check:release`、多一份 HMR/replay 语义），且 keyed 条目必须在 **call/result 两侧都可重放**。→ 因此**排在形态改造之后**，不进 §9 的 ⓪–⑥。**维护者 2026-10-14 拍板：不做**（见 §9.2）—— 本节保留为「已评估、怎么做」的记录。
- **加 `dsh.client` 必须重启宿主一次**（`[已实测]`）：`dsh-client-modules` 把 **package.json 元数据缓存到重启为止**（其 README，检索串 `cached per Loader specifier`）。此后改**产物内容**走 HMR 的 `rebuilt()`，不用重启；⚠️ **但磁盘上删字段也要重启才生效** —— 缓存的反面同样成立。

**`[已实测]` 那张卡走 DetailsRow、图标是 `IconCordisPluginOutlineRegular`**（原先这条「未定」销掉）。

- **走哪条行**：**DetailsRow** —— `@deepseek-ai/dsh-client-ui-tool` 的 `lib/client.js` 里（检索串 `key: "cordis_inspect_list"`）给三个 `cordis_inspect_*` 逐个注册了 keyed 条目。所以走的是 `detailIcon`（`cordis_` 前缀那一支），**不是** `VARIANT_ICONS.others = IconSparkleRegular`。
- **展开栏的结构**：`detailList`（`groups` / `items` / `fields` / `code`）+ 折叠 + 代码块复制 + hover 才现的 `Inspect` 按钮（`.o3BgMG_inspectButton`）。
- **对方案的影响**：只影响「抄哪套结构与图标」。**不影响「必须加客户端半边」这个结论。**

---

## 9. 推进顺序与当前队列

**原则：一步一个 PR，每步都能独立验收。** 本节的「已完成」只写**形态上已经定下来**的东西；**具体验收以代码与 `test/redlines.test.ts` 为真源**，本节不重述判据（一处一事实）。

### 9.1 已落地（形态已定）

| 项 | 形态 | 真源 |
|---|---|---|
| **契约** | `{verdict, key, audit}` 顶层恰好三键、成败同形；`hint` 已删、`evidence` 已并入 `data` | `src/lib/errors.ts` 的 `ensureToolResult` + §4.1 的冻结签名 |
| **输出三层** | L1 判定 / L2 事实 / L3 指路（`nextStep` 两分支） | §3.1 + `src/lib/render.ts` |
| **描述四段骨架** | 做什么 / 什么时候用我 / 边界 / 代价，段序不许换 | §2.1 + B20a / B20b |
| **工具清单** | 四类角色的划分见 §1；**具体有哪几个、叫什么，真源是注册处**（本文不抄清单、也不抄个数）；**名字闭集由 B9 钉住** | `src/tools/index.ts` 注册处 |
| **技能半边** | `SKILL.md` 是运行时载荷；冻结状态与「干预」一节的覆盖见 §9.3 | 冻结真源 = 根 [AGENTS.md](../AGENTS.md) 待办（本文不复述） |
| **超时预算** | 工具**只声明工作量档**（`quick` / `schemaDump`），预算收在 `src/lib/timeouts.ts` 的**唯一映射点**；工具里不许有毫秒字面量 | `test/tools/timeout-budgets.test.ts`（**扫源码**） |
| **只读纪律** | 是**机器判据**：B10（杀进程 / fs 写入 / **写宿主数据路径** / 安装面，作用域**整个 `src/**`**）+ B15（写侧窄作用域、更严记号） | §10.3 与 `test/redlines.test.ts` |
| **大 `audit` 的去处** | `spillStore` 可达性**已实测**（§5.1）；但它**不跨重启**（每进程临时目录 + 启动清扫）⇒ 只适合「这次会话里的大 `audit`」 | §5 / §5.1 |

### 9.2 队列（按顺序）

**本节只记形态与顺序**：哪一项已落地、还剩什么，以根 [AGENTS.md](../AGENTS.md) 的待办与「能力面」为准（一处一事实）。

| 序 | 内容 | 为什么排这里 | 前置 |
|---|---|---|---|
| **D′** | 发现工具（列出活着的 DSH 宿主）+ 给文件型工具加 `dshHome`（含 `DSH_HOME` 注进子进程环境）；形态见 §1.2 | 它是 §1.2 已拍板的一块，且**独立于 `restart`** | 真源是 `src/tools/index.ts` 注册处与各工具的参数声明 |
| **④ `dsh_sign_cookie`** | ✅ **已完成**（独立工具 + 真机红线） | 算法是照抄（SKILL §3.4 已实测），但**错误信号是二值**、调试困难 ⇒ 值一条独立真机红线 | 实现与契约见 [ARCHITECTURE.md](ARCHITECTURE.md) §5 |
| **⑤ `dsh_restart`** | 四道闸 + marker + 恢复；形态见 §6.1，**实现状态见根 [AGENTS.md](../AGENTS.md) 的待办** | 它**不可逆，因此排在一切之后** | 宿主契约与实测见 [HOST-CONTRACTS.md](HOST-CONTRACTS.md) §2 —— 本文不重推 |
| **⑦ 客户端半边**（形态之外） | 加 `dsh.client` + keyed `tool.call.toolview`：粗体标题（500）+ 复用宿主图标 + `标题 · 摘要`，读 `block.meta` 里的 `audit`（§8.5）。**已评估、不做**（维护者 2026-10-14 拍板）—— 记录保留，不再排进队列 | 只影响**人**通道、不影响模型 | 已实测：视觉来源已定；仍是推断：构建产物进 `files` 并过 `check:release`、keyed 条目在 call/result 两侧可重放、多一份 HMR 语义 |
| **⑥ 隔离实例** | **建 / 销毁 → 另一个仓**（**「列」已收进本仓，见 D′**） | 与本仓边界已由 §1 划清 | 它要起长期进程、写**另一个** `DSH_HOME`、分配端口 |

### 9.3 连带同步点（改上面任何一项都要同批看）

- **`SKILL.md`**：它是**运行时载荷**，不是文档；状态**已冻结**（2026-10-13 拍板解冻、**2026-10-15 拍板收回**）。
  冻结的理由、取代关系与连带机制都以根 [AGENTS.md](../AGENTS.md) 待办那一条为真源，本文不复述。
  ⚠️ **冻结不等于正文永远正确**：B12 只查 frontmatter 与正文长度、B9 只钉工具名闭集，两条都**抓不到正文里不带工具名的假话**（例：一句「本插件不提供 X」）—— 正文真要动时，那只能靠人工通读。
- **两份门面**（[README.md](../README.md) / [README_zh.md](../README_zh.md)）：配置表、工具清单、只读纪律的措辞**成对改**。
- **载体这一维（闸④ / 拒绝码）**：拒绝码闭集在 §6.1 那张表与 `src/lib/restart.ts` 的 `RefusalCode`；**模型可见的措辞**在 `src/tools/dsh_restart.ts` 的 `RESTART_DESCRIPTION` 与 `src/lib/carrier.ts` 的 `relaunchRefusalFor`；宿主事实在 [HOST-CONTRACTS.md](HOST-CONTRACTS.md) §2.7；两份门面的 `dsh_restart` 那一节与平台支持那一节也引用了它。**改任一处都要同批看其余几处。**
- **描述预算（§2）**：**加一个工具 = 系统提示多占一段** —— 那个字符数是**实测值、会漂**，别抄；加工具时同批复核 §2 的结论是否还成立。

---

## 10. 红线清单

**原则：能断言的，不靠自觉。** 全部落在 `test/redlines.test.ts`。
⚠️ **编号不在这里维护**：`describe('B…')` 的**闭集才是真源**，**别在这份文档里抄编号清单，也别抄条数**（抄一次就意味着每次加红线都得同批改这里，而漏改的那次就是一句假话 —— 本仓为此写错过一次）。本节只放「**为什么这么判**」与**容易踩空的边界**。

**新增两条由本轮拍板/复查产生**：

- **B24（拍板加）`execute` 全路径不抛** —— 见下表与下方说明。
- **B12 修订（解冻期的连带，与冻结不矛盾）**：现有 B12 断言的是「技能文件本体」的**结构**（frontmatter 合规 + 正文长度下界；`test/redlines.test.ts`，检索串 `describe('B12 技能文件本体'`），**并不断言与 v2.1.4 逐字一致** → 解冻与冻结都**不影响** B12 是否要改。「干预」一节必须**真的存在**（否则「正文说有、实际没有」是静默的）→ 归入 **B12b**。

| # | 红线 | 怎么断言（机械判据） |
|---|---|---|
| **B16** | **输出里不许有恒定块** | 同一工具用**两份不同 fixture** 各渲染一次，取所有 ≥40 字符的行；**两份都出现的行 → 判红**。**判定范围只看 `verdict:` 行与 L2 行**，**必须排除**：`[tool] …` 头行、`nextStep:` 行（两份 fixture 的 nextStep 合法地相同）、**截断模板行**（`<n> more line(s) not shown` 是恒定模板，同 n 时误红）。不排除就是假红（§3.1 规则 5）<br>⚠️ **两份 fixture 还必须换环境（各一份临时 home）**：`resolved:` 这类行按环境恒定 ⇒ 共用同一个 home 时必然逐字相同 → **假红**（W1 实测踩到，§3.1 规则 6） |
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
| **B26** | **返回值必须可无损落 JSON** | 对每个返回值做**一次 JSON 往返**后断言**深度相等**（`isDeepStrictEqual`，**不是** `toEqual` —— 后者忽略值为 `undefined` 的属性，恰好放过本条要抓的那一类）。抓住四类：`undefined` 值（往返后该键消失）、`NaN` / `±Infinity`（变 `null`）、`-0`（`Object.is` 不等）、循环引用（`stringify` 抛），外加 `Date` / `Map` / 类实例变成别的形状。<br>⚠️ **为什么不能靠 B21 的形状表顶替**（本条存在的理由）：形状表照不到宿主的**逐值**判据。实测（2026-10-13 真机回归）`audit.startupLogs…messages[2].text` 是一个**值为 `undefined` 的自有可枚举属性** —— B21 逐条全绿，宿主却在同一次调用上抛 `ToolOutputError(…, ['value is not lossless JSON'])`，模型**一个字段都拿不到**（不是「少一个字段」，是整个工具不可用）。宿主那条边界的完整清单见 [HOST-CONTRACTS.md](HOST-CONTRACTS.md) **§0**。<br>⚠️ **判据必须是往返 + 深度相等，不是 `toEqual`**（换成 `toEqual` 这条就只剩下面那半在起作用）；<br>⚠️ **并且每条都要断言「返回值**不是**守卫合成的兜底」**（`data.audit.received` 存在即是）：工具自己的 `toOutput()` 在返回前就调过 `ensureToolResult`，所以宿主与本红线拿到的**永远是兜底** —— 而兜底当然无损、也当然过自己的守卫。**只断言「往返能过」是坑 37 的原样形状**（症状消失 ≠ 根因修好）：实测把真机缺陷改回去，B26 仍然全绿 |
| **B27** | **截断行不许指向模型够不到的位置** | 从渲染文本里**按前缀**取出截断行（`RENDER_TRUNCATED_RE`），断言它**明说并给总数**、且**不含** `UNREACHABLE_POINTERS` 里的任何位置（`session log` 一族 —— 会话日志里没有完整 `data`，见 §8.1）。**为什么禁词按规则判**：逐字断言（`RENDER_TRUNCATED_RE`、各工具测试里的 `toContain`）在「两处同改」时照样绿 —— 把假话换个说法加回来一条都不会红，所以这里钉**规则**不钉字面（`session log` 一族的同义说法一样红）。<br>⚠️ **禁词表是闭集**：换个说法指向**别的**够不到的位置（表外的说法）它抓不到 —— 要新增不可达位置时**同批补表并写理由**。<br>⚠️ **下界**：取不到截断行 ⇒ 判红，不许 skip（§10.0） |

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

  印证 §4 那句（**当时的**分布在 2026-10-14 已变，见 §4 的更正注）：四个观察工具**真的会抛**。
  ⚠️ **这张表是当时的实测记录，不是现状断言**（2026-10-14 加注）：**六条现在都是绿的** ——
  六个工具的 `execute` 现在都有顶层 `try`（逐个看 `src/tools/dsh_*.ts` 即可）。
  **本表不据此修改**：它记的是「这条红线当时红在哪」，改掉它会让「为什么要有这条红线」失去证据。
  现状请**现跑** `test/redlines.test.ts` 的 B24 那一条。
- **判据为什么不是「没报错」**：那是活跃坑 37 的形状（症状消失 ≠ 根因修好）。根因事实是「**返回的是一个结构合法的结果**」。
- **它的声明边界（必须写明，否则下一个人会误以为它管得更多）**：**B24 抓不到「异常被吞掉」** —— `try{…}catch{ return fail({kind:'internal'}) }` 的返回值合法，B24 照样绿。那是坑 37 的地盘，不是这条红线的。
- **配套硬要求（redline-verifier 实测踩出来的）**：**替身被调用次数 = 0 必须判红**，不许 skip。它的第一版探针在 `probe()` 里另造了一份 deps、注入被丢掉 → 六组**全部「通过」** → 差点得出「B24 今天已经是绿的」这个**反结论**。

**B12b（解冻期补上、冻结期仍然有效）**：断言 `skills/dsh-plugin-debugging/SKILL.md` **含「干预」一节**且该节非空。`[已核]` 现有 B12 **不比对 v2.1.4 原件**（只查 frontmatter 合规与正文长度），所以解冻 / 冻结**都不会**让 B12 变红；但反过来，**不补 B12b 的话「正文说有、实际没有」是静默的**。

**B16 / B22 互为反面**：前者禁「恒定块进输出」，后者禁「`audit` 进输出」。两条合起来 = §3 + §5 的全部内容。

### 10.0 一类共同的假绿：**只有上界、没有下界**（「让判据空转」）

上表里凡是形如「**不得包含 X**」的断言，都有一条**反直觉的失效方式**：候选集为空时它**恒真** —— 判据看起来是绿的，其实什么都没测。已确认的三处（`[已实测]`）：

| 断言 | 空转方式 | 必须补的下界 |
|---|---|---|
| **B16** | 两份 fixture 都渲染出 0 行/极短行 → 「共有行」为空 → 恒真 | **候选行非空** |
| **B19** / **B23** | import 闭包解析失效 → 闭包为空 → 「不含越界写法」恒真 | **闭包非空** |
| **B20a**（口 1） | 把参数描述全删光 → 合计 0 → 通过 | **每个参数描述非空** |
| **B20a**（口 2，本轮补） | `boundary` / `cost` 留空却**不滤空段** → 空行被算进行数 → 两段齐全也数出 4 行 → **`行数 ≥ 段数` 与 `行数 ≤ 4` 同时通过**，而描述里躺着两条空行 | **`composeDescription` 先滤空段再 `join`**（§2.1）+ 断言**不存在纯空白行** |
| **B20a**（口 3，**实测确认，已咬到 4 个文件**） | **参数描述读错层级**：`defineTool` 把参数**编译**成 JSON schema（`{ type, properties }`，见活跃坑 11），而 `Object.values(tool.parameters)` 拿到的是 `'object'` **字符串**与 properties 对象本身 → 每条 `description` 都是 `undefined` → **合计恒为 0**。上界还在时这是**恒真的**（`0 ≤ 100`）；**上界删掉之后，接住它的正是那两条下界** —— 这反过来证明「**下界才是防空转的那一半**」。**实测：当时本仓的工具测试里有四份是这种写法**（`hot-reload.test.ts` 是唯一写对的） | **点进 `.properties`**（照 `test/tools/hot-reload.test.ts` 的写法）+ **参数个数 > 0** + **每个参数描述非空** + **合计 > 0** |

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

**因此 B18 / B20 各拆两条，不是一条**（B18→B18a/B18b、B20→B20a/B20b；另加 B12b。B24 本就在表内，不另计。编号故意留 `a/b` 后缀、不重排，避免与已引用的编号漂）。
**⚠️ 不要再在文档里数「一共几条」**：这个数每加一条红线就变一次，而它一漂就骗人。**数就数 `test/redlines.test.ts` 里 `describe('B…')` 的闭集**。

**评审清单（不进红线，因为不可机械断言）**：

1. 描述里有没有**同义改写**的输出结构说明。
2. 描述③「边界」写的反直觉点，是否**真的**在输出里出现过（否则是凭空写的）。
3. `key` 里留下的字段，是否**真的**会被下一个决定用到（B17 只管「标识符出现」，管不了「多余字段」）。
4. **参数描述逐条自问「模型看不到这条，会不会填错？」** —— **留**：怎么填 / 不填怎样 / 有什么陷阱；
   **删**：从参数名能推出 / 与工具描述重复 / 纯机制解释。**这是上界（≤100）被删之后的替代品**（§2）：
   机械部分只剩「非空 + 合计 > 0」，**质量只能人工过** —— 所以这条不是可选项。

**这四条故意留人工**：把它们写成正则只会造出「看起来被守住了」。**不可断言的事，宁可标成评审项，也不要做成假红线。**

### 10.2 侦察阶段确认「做不到」的（写下来，防下一个人硬凑）

| # | 做不到什么 | 为什么接受 |
|---|---|---|
| 1 | **B19 看不穿包名**：只解析相对 import，包带进来的取值函数看不见 | 要模块解析器，代价远超收益 |
| 2 | **B20b 抓不到同义改写** | 已是 §10.1 的结论（「输出结构 → 描述文字」没有有界映射） |
| 3 | **B16 / B17 不做近似匹配**（改写成同义句、折行） | **近似匹配引入假红，比漏更贵** |
| 4 | **B24 抓不到「异常被吞掉」** | `try{…}catch{ return fail({kind:'internal'}) }` 的返回值**合法** ⇒ B24 照样绿。**这是坑 37 的形状**，不在这条红线的声明范围内 —— 但必须写明，否则会被误以为覆盖了 |
| 5 | **B26 的判据与宿主那条边界不是同一条** —— 两个方向都有实测差 | B26 判「往返 + 深度相等」，宿主判 `walkJsonValue`。实测差两处：① **不可枚举自有属性**宿主拒、B26 绿；② **null 原型对象**宿主接受、B26 判红。其余逐条一致。**写新投影面之前先核 [HOST-CONTRACTS.md](HOST-CONTRACTS.md) §0 整节**，别拿「B26 绿」当「宿主会收」 |
| 6 | **B25 / B26 共用 `redlineCorpus()` 语料 = 同一条覆盖缺口** | 语料里缺某工具的第三条返回路径（新增 `kind` / 新增成功分支）时，**两条都看不见那条路**。加分支时**同批加 fixture**（同 B17 / B18a / B21） |

**第 4 条与 §10 的 B24 配套读**：B24 保证「抛出去」这条路不存在；「吞掉」那条路**没有红线**，只能靠评审与变异测试。

**第 5 条与 §10 的 B26 配套读**：B26 抓的是「往返会丢的那些」，抓不到「往返碰巧没丢而宿主仍拒」的（**不可枚举自有属性**就是这么一个），也会把**宿主接受的值**误判红（**null 原型对象**）。宿主那份清单在 [HOST-CONTRACTS.md](HOST-CONTRACTS.md) **§0** —— **写新投影面之前先核那一节**，别拿「B26 绿」当「宿主会收」。

### 10.3 已拍板：允许插件写**自己的命名空间**，形态 **A（精确一层）**（2026-10-14）

**拍板结果：形态 A** —— **只放过 `$DSH_HOME/<包名>/` 这一层**，目录名**逐字等于包名**（`dsh-plugin-debugging`），**该层以下随便分**。维护者给的形状：

```
$DSH_HOME/dsh-plugin-debugging/
    restart/marker.json      ← `dsh_restart` 用它（§6.1）
    cookie/                  ← 将来要用就加
    logs/                    ← 将来要用就加
```

**判据的形态**（`[已核]`，**已落地**；真源 `test/redlines.test.ts` 的 `judgeHostDataWrites` / `firstSegmentAfterHome`）：从「命中任一禁止前缀 ⇒ 红」改成「**写 `$DSH_HOME` 时，只有第一个路径段逐字等于包名才放过；否则红**」。

**四条必须成立的边界**（每条都要有能判红的用例）：

| 情形 | 判定 |
|---|---|
| `join(dshHome, '<包名>', 'restart', 'marker.json')` | **放过** |
| `join(dshHome, '<包名>', 'restart', 'nested', 'marker.json')`（更深） | **放过**（子目录随便分） |
| `join(dshHome, 'profiles', '<包名>')`（包名在**第二**位） | **红** —— **「行里出现了包名」≠「包名是第一段」** |
| `.../<包名>-logs/x`（同前缀**兄弟**，不是逐字相等） | **红** —— 这正是 A 与 B 的分界 |

**其余一律照旧禁止**：`profiles` / `sessions` / `storages` / **`logs`（指 `$DSH_HOME/logs`，不是 `.../<包名>/logs`）** / `cache` / `attachments` / `backups` / `integrations` / `mcp` / `settings.yaml` / `.credentials.yaml` / `.salt` / `.anonymous-user-id`，以及 `$DSH_HOME` 下**任何别的**顶层项。**判断只看紧跟 home 的第一段。**
**读一律不受影响**：诊断半边合法地读 `$DSH_HOME`（凭据、启动日志、profile 清单）⇒ 读白名单**内外**都不报。

**包名不许手抄**：从 `package.json` 的 `name` 取；若硬编码，必须配一条「该字面量 == `package.json` 的 `name`」的自证。

**已知限度（同批进 `test/redlines.test.ts` 文末正典表）**：
- **动态首段无法验证** —— `join(dshHome, name, …)`（`name` 是变量）时判据只能**保守判红**。
- 前缀表是**手抄副本** + 用例里一份独立副本逐条比对；**删一行 ⇒ 第二副本判红**（响亮），但**两处同批删同一族 ⇒ 静默失守**。

**落选形态（保留为记录）**：**形态 B 前缀族白名单**（放过 `^<包名>/` **或** `^<包名>[-_.]` 开头的顶层项）—— 它额外放过 `dsh-plugin-debugging-restart/`、`dsh-plugin-debugging.tmp/` 这类**同族兄弟目录**；**落选理由**：与本插件**无关**但恰好同前缀的目录会被一起放过（同一个 `$DSH_HOME` 下多插件的命名冲突面变大）。维护者选了 A。

**本节只决定「往哪写」**；「**谁清理、什么时候清理**」是**另一件**决策（决策笔记 §一 的三段分层），**未拍板**。
**与 §6.1 的 `force` 无关**：那件（闸②的显式逃生口）**已由维护者 2026-10-14 拍板落地**，不受本节影响。

**判据先立、放宽后议**：本条落地时，B10 的路径判据**只加了一条更严的规则**（原先一条路径判据都没有），**没有削弱任何现有保护面** —— 放宽要动的正是这条新判据，届时必须同批改 `HOST_DATA_PATH_SEGMENTS` 的用法与「已知限度」表。

---

## 附录 A：参考实现索引

调研方式：**只读**（npm registry 元数据 + GitHub API）；热重载与重启的核心路径**补读了实现源码**（结论见 [HOST-CONTRACTS.md](HOST-CONTRACTS.md)）。下表「核心做法」= **各项目 README 的自述**，不是我们的实测。

| 包名（版本） | 仓 | 核心做法（自述） | 可借鉴点 | 与我们的差异 |
|---|---|---|---|---|
| `dsh-plugin-reload` 0.2.1 | reina4xa/dsh-plugin-reload | 工具 `reload_plugin`，按 entry id / 模块名 / MCP `serverName` 重启单个 entry | 三种定位方式；「先 import 成功再换 fiber」的顺序（**本仓已实现并实测**） | 它是工具调用触发的单 entry 重启；我们先判「改动属于哪一档」 |
| `dsh-hot-reload` 0.2.4 | stuarthu/dsh-hot-reload | watch profile 的锁文件，已加载插件版本变化时原位替换；**失败过的版本不自动重试** | 「不自动重试失败版本」这条我们原本没有 | 它事件驱动、面向升级；我们工具调用驱动、面向刚改完源码 |
| `dsh-hotswap` 0.1.1 | HongzhongL/dsh-hotswap | Web 侧热启用/停用/重启；把开关写进 profile patch 的托管区块；**保护名单** | **保护名单**；`entry.update({disabled})` 是 Loader 级开关的正解 | 它允许写 profile；**本仓不写 profile** |
| `dsh-smart-restart` 0.5.1 | edusrez/dsh-smart-restart | 启动检测到新进程接管就 notice 唤醒；记录调用方会话；**canary 预检**；从 cgroup 识别 systemd | **canary 预检**（我们四道闸没有）；记录调用方会话 | 它是 systemd/Linux 导向；本机是 Windows，闸④必须处理「载体没有已实测的回归路线」（其次才是「拿不到启动命令」） |
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
| **客户端包的元数据缓存到重启为止**（加 `dsh.client` 必须重启一次） | `@deepseek-ai/dsh-client-modules` | 包内 `README` | `cached per Loader specifier` · `rebuilt()` |
| 客户端半边走**浏览器模块表**（不是 npm 解析，故宿主内层的包可得、React 同实例） | `@deepseek-ai/dsh-client-ui-tool` | `lib/client.js` | `window.__ModuleLoader__.load` · `require("react")` |
| client 查询三态措辞（`Client failure` 的真出处） | `@deepseek-ai/dsh-cordis-host-runner` | `lib/index.js` | `Client failure` · `hasLiveClient` |
| 「有没有在线页面」 | `@deepseek-ai/dsh-api-gateway` | `lib/index.js` | `hasLiveClient` |
| 创造模式**独有**什么（对照两个 preset 的工具行） | `@deepseek-ai/dsh-web-app` | `presets/cordis.patch.yml` vs `presets/standard.patch.yml` | 都比 `dsh-tool-` 行 |
| 恢复预设：`agentPreset` 是持久会话事实 | `@deepseek-ai/dsh-session` · `dsh-agent-preset-registry` | `lib/types/types.d.ts`、`lib/index.js` | `agentPreset` · `agentPresetProjectionDefinition` |
| `appendPluginRecord` 的类型语法（`plugin:` 前缀） | `@deepseek-ai/dsh-session` | `lib/index.js` | `PLUGIN_RECORD_TYPE` |
| Windows 进程树杀（宿主自己的用法） | `@deepseek-ai/dsh-subprocess-local` | `lib/index.js` | `taskkill` |

### C.2 本仓真源（相对**仓根**的路径）

| 要找什么 | 路径 |
|---|---|
| 各工具的实现（描述 / 参数 / 契约 / `nextStep`） | `src/tools/dsh_*.ts`（**逐个列文件、别用 glob 数个数** —— 清单真源是 `src/tools/index.ts` 注册处） |
| 工具共享依赖 + `effectiveConfig` + 输出 schema | `src/tools/shared.ts` |
| 模型可见渲染（现状：摘要 + 整块 JSON） | `src/lib/render.ts` |
| 契约（`ok` / `fail` / `nextStep` / `evidence` / `ensureToolResult`） | `src/lib/errors.ts` |
| 契约与 `execute` 不抛的判据、以及 B10/B15/B14 等旧红线 | `test/redlines.test.ts` |
| 单测助手（`expectOk` / `expectFail` / `expectFailEvidence` / `run`） | `test/tools/helpers.ts` |
| 技能本体（**已冻结**，含「干预」一节） | `skills/dsh-plugin-debugging/SKILL.md` |
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

**行号一律不写** —— 行号换版本必漂。所有宿主结论都写成 **C.1 的「包 → 包内路径 → 检索串」**形式（检索串可直接 `grep` 命中），本仓结论写成「**相对仓根的路径 + 检索串**」。这与 [AGENTS.md](../AGENTS.md) 的「不抄会漂的值」是同一条纪律。

⚠️ **但版本号必须写**（这是 [AGENTS.md](../AGENTS.md) 的硬要求：引用宿主行为要说清是哪一份宿主、什么版本）—— 它标的是**核对的时点**，不是查找键。本文里凡出现 `0.2.1-alpha.2` 这类版本号，读作「**这条结论是在那个版本的运行时上核的**」；宿主升级后按 C.1 的**检索串**重找、重核，**不要按行号找**。
