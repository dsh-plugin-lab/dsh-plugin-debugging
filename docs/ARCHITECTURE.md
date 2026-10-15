# dsh-plugin-debugging — 设计说明

**本文负责**：这个插件**为什么这样分层**、每条设计的理由与代价；**已实现的形态与契约以本文 §5 为真源**。
**不负责**：**宿主侧已核 / 未核的事实** → [HOST-CONTRACTS.md](HOST-CONTRACTS.md)（本文只引用结论，不重述证据）；**插件最终长什么样、接下来怎么改** → [SHAPE.md](SHAPE.md)；怎么在这个仓里干活 → [AGENTS.md](../AGENTS.md)；发布流程 → [PUBLISHING.md](PUBLISHING.md)；决策快照 → [.agents/notes/](../.agents/notes/)。

**读者纪律**：本文引用的宿主行为都带标记（`[已核]` = 回源码核过；`[已实测]` = 真机跑过；**无标记的不许当结论用**），标记定义见 [HOST-CONTRACTS.md](HOST-CONTRACTS.md) 的「怎么读本文」。**在跑的宿主**与**源码检出**常常不是同一个版本 —— 引用之前先确认是哪一份。

**本文不抄会漂的值**（宿主版本号 / 行号 / 计数 / 日期）：能写成「形状 + 检索串」的就那么写，需要具体值时去实体文件现查。凡是本文只能**指向**而没能落成判据的结论，都写明它住在哪。

---

## 1. 定位与边界

把一个排障知识本体（`skills/dsh-plugin-debugging/SKILL.md`，随包分发）里**可机械判定**的部分做成工具。
技能正文**已解冻**：它跟着插件一起演化，不再逐字冻结在某个版本（拍板记录与连带同步点见 [SHAPE.md](SHAPE.md)）。

**能力面 = 1 个技能 + 一组工具**（**只读** / **写侧** / **派生**三类角色；各类各几个**不在这里写** —— 那份清单会漂，见下一行）。
⚠️ **工具清单的真源是注册处**（`src/tools/index.ts`），红线 **B9** 钉住名字闭集 —— 本文 §5 的表是**解释**，不是清单的真源；加工具要同批改注册处、README×2、技能正文与 B9 词表。**所以本文刻意不写工具个数**：写一个数就得每加一个工具回来改一次，而漏改的那次就是一句假话（本仓因为「红线只到 B22」写错过一次）。

**管**：改动何时生效（热生效 / 重启 / HMR）、插件到底加载没有、`401` 与连接被拒的分辨、组合后的配置树、**就地热重载**、**自签 cookie**、**重启本宿主**。
**不管**：写插件、选扩展点、改 preset、列可安装包。

**权限面按「错一次能不能撤销」划分**（不看它算观察还是行动）：

- **诊断半边的只读工具**（是哪几个见注册处，不在此处抄）：只答问题，不改系统状态。**这是设计决定，不是进度妥协。**
- **写侧 `dsh_hot_reload`**：只做**不杀进程**的那一种 —— 就地换模块，失败时把旧版本放回（可逆）。
- **行动类 `dsh_restart`**：**不可逆** —— 它杀掉正在被排障的那个宿主。它因此**多了两道门**，且两道互相独立：**审批档**（先读档位再决定问不问；`never` 是「提示已关闭」，在那一档去问必然被拒）与**文件沙箱档**（写 marker 必须显式带 `danger-full-access`）。流程与顺序（闸门 → 审批 → 写 marker → 拉起 → 退出）见 [SHAPE.md](SHAPE.md) §6.1，宿主侧的退出与拉起契约见 [HOST-CONTRACTS.md](HOST-CONTRACTS.md) §2。

**只读纪律现在由机器判据守着**（真源 `test/redlines.test.ts` 的 `describe('B10…')` / `describe('B15…')`，规则本身不在本文重述）：

| 红线 | 判什么（形状） | 作用域 |
|---|---|---|
| **B10** | 杀进程 / fs 写入 / **写宿主数据路径** / 走 `dsh plugin` 安装面四类 | **整个 `src/**`**（刻意不止诊断半边：写侧若只由 B15 管，会漏掉 B10 独有的安装面那一类） |
| **B15** | 写侧只许碰**进程内**的模块缓存与 fiber；记号判据更严（连**读** `DSH_HOME` 都不许） | 按机制入口反推的**写侧实现文件**清单（要求文件存在，不给 skip） |

**唯一被放过的写**：`$DSH_HOME/<包名>/` 这一层（紧跟 home 的**第一段逐字等于包名**；该层以下随便分）。**同前缀兄弟**（`<包名>-logs`）不放 —— 这是维护者 2026-10-14 拍板的「精确命名空间」，与「前缀族白名单」是两种形态。其余位置照旧一律禁止。

## 2. 分层

```
src/
├─ index.ts        唯一接触 Cordis 的地方：读 config、装配两个半边、声明 inject
├─ contracts.ts    跨半边共享的**类型**（不含逻辑）
├─ config.ts       Config schema + resolveConfig（把「可能没配」补齐成工具半边认的形状）
├─ skills/         技能半边：解析 frontmatter → 注册进宿主注册表
├─ tools/          工具半边：一个工具一个文件，注册入口是本目录的聚合入口
└─ lib/            纯逻辑：IO 全部经注入点进出（子进程 / HTTP / Loader 树）
```

两条硬边界：

- **`skills/` 与 `tools/` 互不 import**，只共享 `contracts.ts`。两个半边因此可以并行开发、各自单测。
- **Cordis 只在 `index.ts` 与两个半边的注册函数里出现**（`[已核]`：全仓只有这三处 `from '@deepseek-ai/cordis'`）；`lib/` 全是可直接单测的普通函数，IO 走注入。

**状态纪律**：状态、监听器、定时器一律建在 `ctx.effect()` / `ctx.on()` 内并由返回的 disposer 释放，**模块顶层不持有可变状态** —— 否则热重载后会留下「两代插件共用一份状态」的幽灵故障。

## 3. 技能半边：为什么走 runtime 注册（含两次注册）

**结论：`ctx.skills.register()`**（而不是 filesystem provider）。三条理由：

1. **rank 语义逐字吻合**：runtime 注册的 rank 是模块常量 **250**、**无参数可改**（真源：`@deepseek-ai/dsh-skill` 里的 rank 常量与升序比较，检索串 `rank`）；官方 filesystem provider 的 `custom` 根是 300、`bundled` 是 600。250 的语义是「插件直接向注册表注入技能」，300 的语义是「用户配置的额外扫描目录」—— 我们要的是前者。
2. **方向要对**：目标是**盖过用户级同名技能**（rank 400/500）。走 `bundledSkillDir`(600) 优先级比用户级**更低**，方向与目标相反。
3. **生命周期干净**：注册挂在 fiber 上（`ctx.effect(function* () { yield skills.register(...) })`），卸载与热重载时自动撤，不留两代注册。

**代价**：放弃 filesystem provider 的自动解析与 watch —— frontmatter 得自己解析，fail-closed 也得自己担（见 §4）。

**rank 的三条边界**（不知道就会得到一个静默错误的心智模型）：

- 比较是**升序、数值小者胜**；且 rank **只在同一层内**裁决 —— 最近层的同名条目**直接胜出**，不比 rank。
- **250 压得住同层的 custom(300) 与 user(400/500)，压不住 project-dsh(100) / project-agents(200)**。项目级赢是预期行为。
- **被 shadow 是静默的**：没有 API 能列出被遮蔽的同名技能（登记表只暴露返回 winner 的那几个口）；**跨层遮蔽连 warn 都不打**（warn 只在同层去重时出现）。

**按发布形态，「250 压得住用户级」不成立** `[已实测：2026-10-12]`：标准部署里根上的 `skill-filesystem` 被关掉了，唯一开着的那份在 **preset 层**，于是项目级 / 用户级技能全在 preset 层，而本插件的 runtime 注册落**全局层** → 用户级同名技能会**跨层遮蔽**本插件的技能。同一实例上的对照（同一注册表两个视图的集合差，不依赖日志）：

| 场景 | winner |
|---|---|
| global 层（用 `--patch` 把 fs provider 拉回全局层） | `runtime(250)` —— 同层内 250 赢 400/500 |
| global 层 + 项目级存在 | `project-dsh(100)` —— 100 赢 250 |
| **发布形态**（fs provider 在 preset 层）+ 用户级存在 | **`user-dsh(400)`** —— 更近的层直接覆盖，rank 不参与 |

### 3.1 处置：动态 scope 注入（同一份技能注册两次）

```
全局层       ctx.skills.register(def)                 ← 插件挂在 profile 根，落全局层
每个活跃 agent  agent.ctx.get('skills').register(def)   ← 与 skill-filesystem 同层 → 同层内 rank 250 才真正赢
```

**处置分两步，顺序不能换**：① 先让插件那份**在同层赢**（即上面的两次注册）；② **再**撤掉个人副本。反过来的话，中间那段时间里模型读到的仍是那份会悄悄变旧的副本。

**这两步换来的东西与代价，都写清楚**：

- 收益：本插件那份在**同层**真的赢过用户级 400/500。
- 代价：插件那份**只存在于装了本插件的 profile**；个人副本原本是**跨 profile** 的。此前本机另有一份与本包**字节相同**的个人副本（rank 500）——**已撤（2026-10-13，从磁盘删除；维护者指定不碰 `~/.agents` 那个仓库，故未提交未推送）**。撤除之后，**没装本插件的 profile 就看不到这套排障技能**。这是有意的取舍（「同一个技能有两份、其中一份会悄悄变旧」比「少一个 profile 里能用」更坏）；要把它用在未装插件的环境里，正确做法是**再装一次插件**，而不是重新放一份个人副本（那样跨层遮蔽会原样回来，而且**完全静默**）。
- ✅ **已落地，但真机不可观测**：`SkillReport.scoped` 的计数只有插件内部看得到（`state.skill` 没有对外暴露面，pluginInventory 也不含插件内部状态）—— 想验「注册成了没有、几个 agent」目前只能靠 winner 反推。这是根 [AGENTS.md](../AGENTS.md) 待办里记着的一条。

**三条实测出来的纪律**（错一条都会**静默**）：

- **`agent/created` 是 serial 派发，处理器里不许 `await`** —— 实测在处理器里 await 会让 `agents.create()` **直接卡住**。所以注册是**全同步**的（显式 `return undefined`，没有 await 点）；类型签名本身就要求 `Promise<undefined> | undefined`。
- **作用域注册表取自 `agent.ctx.get('skills')`**：`presets.serviceFor(agent, 'skills')` 即使在 preset 已挂时也返回 `undefined`（它找的是 preset 组**内部**的服务，skills 不在里面）。
- **新会话覆盖得到**：处理器对「apply 之后才出现的 agent」同样生效，所以不依赖启动时遍历；服务此刻缺席也照样**武装处理器**（处理器用 payload 里的 agent）。

**还有一条必须收尾的事**：往别人的作用域里注册，**必须把返回的 disposer 收进我们自己的 fiber**（`ctx.effect(function* () { yield scopedRegistry.register(...) })`）。不收的话注册的生命周期只绑在那个 agent 上、与插件 fiber 无关，症状是**停用插件后老会话仍赢、新会话已退回用户级** —— 同一时刻两种结论，看起来像随机故障。收进自己的 fiber 之后两条路都能解开（插件卸载调我们 yield 的 disposer；agent 销毁由它自己的作用域解开）。

**边界（如实写出来）**：这条依赖宿主**内部 primitive**（`ctx.agents` / `agent.ctx` / `agent/created`），**不是公开契约** —— 宿主换版本必须重测。本仓因此用**结构型**声明而不是 import 具体类型，失效表现为「读不到」，不是编译不过或运行期炸。另外它**只在真的开了 agent 的会话里赢**（纯冷会话用临时层，覆盖不到）。

**为什么不是「把插件行写进 preset 组合」**：也试过，能赢，但一旦插件包不可解析，**默认 `standard` 会话直接建不起来**，等于插件坏了就没人能用；而且插件提供的**全部**工具会被一起限进 preset 层。动态注入下插件行**不动**，坏包只影响插件自己。决策、代价与重开条件见 [.agents/notes/2026-10-13-skill-registers-twice-dynamic-scope.md](../.agents/notes/2026-10-13-skill-registers-twice-dynamic-scope.md)。

## 4. 技能半边的 fail-closed 点

**权威依据是宿主源码**（检索串 `validateRuntimeSkill`）：它只校验 kebab name、非空 description 与 invocation，**`content` 不在运行时校验范围内**。也就是说，走 runtime 注册时**漏了正文字段不会报错**，一直到渲染 `<skill_content>` 才表现为空 —— 那时已经看不出是哪一步坏的。

所以本仓自己判：

| 情形 | `kind` | 为什么必须响亮 |
|---|---|---|
| 文件读不到 | `missing-file` | 宿主对缺失的 skill root 只「探测到出现为止」，不会让插件启动失败 |
| frontmatter 缺 name/description、name 非 kebab-case、description 是块标量 | `bad-frontmatter` | description 是模型**唯一**的路由信号（技能不进系统提示词）；把 `>-` 当描述注册进去 = 技能对模型不存在，且不报错 |
| 正文 trim 后为空 | `empty-content` | 见上：宿主不查 content |

`contentBytes` 是**正文的真实 UTF-8 字节数**，存在的意义就是把「注册成了但正文是空的」这种静默失败照出来。

**技能根按产物位置推断**：本模块产物是 `lib/skills/register.js`，故技能根 = 模块目录**上溯两级** + `skills`。（上溯**一**级会落到 `lib/skills`，那里没有 SKILL.md —— 而这个错只会静默报 `missing-file`。）

## 5. 工具半边

**每个工具**都遵守同一条输出契约（冻结签名见 [SHAPE.md](SHAPE.md) §4.1）：

```ts
{ ok: true,  data: { verdict, key, audit }, nextStep? }            // 成功
{ ok: false, error: { kind, message }, data: { ... }, nextStep? }  // 预期内失败
```

- **`execute` 绝不 throw**。`kind` 是**闭枚举**（真源 `src/lib/errors.ts` 的 `TOOL_ERROR_KINDS`），决定模型该不该重试 —— 「重试同一个调用」对 `timeout` 成立、对 `not-running` 是白费、对 `cancelled` 是错的。
- **`message` 与 `verdict` 角色不同，不是同一句的两个副本**：`message` 是**这次操作**为什么没做成（操作视角，由守卫或 `toToolError` 产生），**不进模型文本**，留在结构化值里供人复核；`verdict` 是**结论**（世界视角），就是模型读到的 L1。
- **`ok` 只描述「工具这次操作有没有完成」，不描述系统健不健康**。所以「诊断成功、只是结论是坏消息」走 `ok: true` + `data`；只有「操作没完成、但看到了值得留下的事实」才走 `ok: false`。
- **`data` 两分支同形且必填**，顶层**恰好三个键**（B21 断言这条）：`verdict`（L1，必填非空）/ `key`（L2，判据是「模型看不到它，会不会做出不同的下一步」）/ `audit`（给人复核，**不进模型文本**，可以为 `{}`）。两处旧字段已收干净：`evidence` 并进 `data`（失败路径的观测事实就是那时的 `key`）；`hint` 已删（它的内容只有两种归宿，两种都已经有家 —— 恒定知识进描述层边界段写一次，具体动作进 `nextStep`；留着就是给模型两个权威去分辨）。
- **`nextStep` 必须带动作**：`{ tool, args?, why }` 或 `{ manual: true, why }`，**没有动作就不出现**（旧形状「裸结论伪装成下一步」已在类型上写不出来）。排障进度不能靠模型背历史（compaction 会丢），所以有动作时要落进工具结果。
- **`exec.signal` 透传**到 fetch / spawn，让宿主的取消能到 IO 层。
- **工具侧超时 > 传输层超时**：让传输层先超时，得到结构化错误，而不是裸 `TimeoutError`。
- **零运行时依赖**：只用 `node:` 内建与宿主服务。加依赖要先过决策。

**这些语义背后的宿主侧实测证据**（哪一条是怎么核出来的）→ [HOST-CONTRACTS.md](HOST-CONTRACTS.md)。下面 §5.2 的表是**我们的解释**，不是证据的复述。

### 5.1 超时预算：收在一个映射点

**工具只声明自己是哪一档工作量**，预算一律经 `toolBudgetMs(WORKLOAD, deps.config)` 取：

| 档 | 谁在 | 为什么分档 |
|---|---|---|
| `quick` | 读文件 / 一条 `--dump-config` 量级的命令 / 一次 HTTP 探测 | —— |
| `schemaDump` | 会跑 `--dump-config-schema` 的工具（**只有 `dsh_dump_config`**） | 它是 CPU 密集、随 profile 规模增长的活；其余工具只是读文件、跑一条快命令、发一次 HTTP。**各工具干的活差得很远**（快档与慢档实测差一个数量级，数字见 `src/lib/timeouts.ts` 那张表）—— 用一个数兜住两者，结果只能是「快的那个白等、慢的那个在赌」，而那正是加这一档之前的实测故障 |

**三条纪律**（判据是 `test/tools/timeout-budgets.test.ts`，**扫源码、不靠跑一遍**）：

- **工具里不许出现毫秒字面量，也不许直接读配置的预算字段**（三条假绿方向与绕法写在 `test/redlines.test.ts` 文末「已知限度」）。
- **配置面不许被架空**：用户调大跟着变大；**往下填也照办**（不静默夹到默认值）。
- **不变量「传输预算 < 工具预算」对任何正预算都成立**（`transportTimeoutMs` 有一道封顶）；预算被配到极小时传输预算得到 `0`，调用方据此**不再发起 IO**、直接返回结构化超时。

**默认值只住 `src/lib/timeouts.ts`**（连同实测耗时、为什么这么取、以及那条「更慢的降级路径」的未知一起）；`src/config.ts` 的 schema 只**引用**它，不再把数字抄一遍。工具预算与传输预算之间的余量也在那一处定义。

### 5.2 工具的语义

| 工具 | 关键语义（判定都依赖它们，写错就静默给错结论） |
|---|---|
| `dsh_check_effect_mode` | 「热生效」的前提是 profile 里真的挂了 `hmr`，且这件事作为**契约字段**直接给出（**三值** `present` / `present-conditional` / `absent`，类型见 `src/tools/dsh_check_effect_mode.ts` 的 `HmrAvailability`），不让模型从 `why` 反推。`present-conditional` = profile 里 `hmr` 那行的 `disabled:` 是**运行时表达式** ⇒ 静态看**既不能当确定可用、也不能当确定不可用**：工具按**可用**处理，但**把条件本身印进 L1 与 L2**（只印记号，模型读不出条件）。⚠️ 这一档**没有真机实测**（`present` / `absent` 那两条实测不覆盖它），不要拿它当结论用。**机制**：loader 重读配置的能力一直都在，**缺的是触发者** —— watch patch 文件的正是 hmr；无 hmr 时改 config 文件**没有任何东西去重读它**。所以一切「热生效」都降级成 `restart-required`。⚠️ **别拿 `ctx.get('hmr')` 当探针**：挂着 hmr 的实例里它同样是 `undefined`；判断 hmr 可用性只有两条真源（profile 文件与 `--dump-config`），本工具走的正是这两条。正反两证见 [AGENTS.md](../AGENTS.md) 活跃坑（检索串 `触发者住在 hmr 里`）—— **结论已进台账**，故此处只留引用，不重述证据 |
| `dsh_diagnose_plugin_load` | 三处外部证据（`bundles` / 安装形态 / 进程）**只证前置条件，不证加载成功**。**Fiber 相位能查，但不在 `Config.listConfigs` 里** —— 走插件侧投影（`ctx.get('loader')` → `loader.entries()` → `entry.fiber.state`）；**import 期就失败的 entry `fiber` 是 `undefined`**，只看 `state===3` 会漏掉它（最凶的一种）。`Config.listConfigs` 的 `inactive` 混合「禁用 / 未导入 / 已销毁」三义、**从不报 FAILED**。启动失败的硬证据只在 `$DSH_HOME/logs/startup-*.log` 且**只在启动失败时生成** —— 但**它未必属于当前进程**：那种日志会**留在磁盘上跨重启**，所以工具把「最新那份的 mtime」与**当前进程的启动时间**（与产物新鲜度用**同一个参照**）比一次，结论是三值 `freshness`：`current` / `stale`（**历史遗留**，L1 必须说明它早于当前进程）/ `undated`（拿不到参照时间 ⇒ **不许**读成「当前进程加载失败」）。日志内容本身照常投影（旧失败也是事实），被补上的只是它的**时间限定**。投影实现：`src/lib/fiber.ts` + `src/lib/loader.ts` |
| `dsh_check_auth` | `401` = 服务活着、认证没过；连接被拒 = 没启动。两者**必须在 `kind` 上分开**，不能让模型从一句 message 里猜。⚠️ **但 401 本身不蕴含「authority 变了」**：本工具**发送不了凭据**（v1 不读值、不自签 cookie）⇒ 它拿到的是**匿名 401**，因此它**答不了**「你存的凭据是否有效」—— 判定函数在类型上就收不到凭据，从结构上不给这条错推论留缝。能区分「会话过期」与「authority 变了」的只有**带 cookie 的浏览器页面**。cookie 绑定 authority（`host:port`，`localhost` 与 `127.0.0.1` **不通用**），**签名密钥落盘、launch token 不落盘** —— 所以「同端口重启旧标签页照常可用、换端口才 401」 |
| `dsh_dump_config` | `--dump-config` 退出码**恒 0**，不能当门禁；`--dump-config-schema` 退出码 **1 = 有 error**；`preset-*` 行的 `unrecognized Loader tree carrier` 是已知误报，判定看 error 的 `path` 是否指向**你改过的行**。**「跑了什么」与「读到了什么」必须分开**：`key.notScreened` 记下「工具打算读、但这次没读到」的来源，渲染据此出三值 —— 读到且为空 = `actionable: none` / 读到且有 = 逐条列出 / **没读到 = 绝不许印 `none`**（那会把「不知道」说成「没有」）。`actionable` 里的字段是**宿主按需带的**（实测两种形状：有的条目只有 `path`，有的 `entryId` 与 `path` 都有）—— 工具**原样透传、不自己造** |
| `dsh_list_instances` | **发现**：列出本机活着的 DSH 宿主。认领靠**专有签名**，不是「401 就算」—— 未认证 `GET /` 必须**401 且 body 逐字**为 `dsh web authentication required; reopen the URL printed by dsh web.`；**别的 401（body 不同）算「不是 DSH」**，连不上 / 超时算**「没探到」**（三值互不重叠 —— 压成两值就是反向结论）。**它只能给 authority（`host:port`），给不出 `DSH_HOME`**：宿主 HTTP 面上没有任何路由能问出「我是谁 / 读哪个 home」，两者之间**没有可推导的关系** ⇒ 要把文件型工具指向另一个实例，**路径必须由调用方手填**（口径见 [SHAPE.md](SHAPE.md) §1.2；同一句话在两份 README 里也有）。只探**回环**（一律 `127.0.0.1`，不扫局域网），候选数与每次探测都有界；`probed` / 没人听 / 有人听但读不到 pid 的**四态语义照旧**。三平台的「列全部监听者」实现在 `src/lib/ports.ts`，与单端口查询**并列**（不改它） |
| `dsh_hot_reload`（**写侧**） | 就地换一个 entry 的代码，不重启。**顺序是判据**：定位 entry → 备份本地模块闭包 → 只清那批缓存 → **先 `import` 成功** → **再** dispose 旧 fiber → 挂载新的。import 期失败时**旧 fiber 从未被碰**；apply 期失败则从备份回滚（旧版本被真的重新实例化）。匹配 entry 要**两个字段都试 + URL 归一**（只比 id 会得到假阴性）。**它测不到的**：插件在 cordis 之外开的资源（定时器 / socket / `process.on` / 文件句柄 / worker）不会被追踪，会**静默泄漏** —— 所以这一条写在**描述层的边界段**（恒定知识写一次），不进每次输出。宿主事实与真机证据 → [HOST-CONTRACTS.md](HOST-CONTRACTS.md) §1 |
| `dsh_sign_cookie`（**派生**） | 本仓**唯一经手秘密**的工具：读本机 `.credentials.yaml` 的持久签名密钥，在内存里算 HMAC。**cookie 本体刻意不进返回值** —— 契约要求 `data` 可无损落 JSON，而 `audit` 会被 spill 到磁盘，凭证进 `audit` 就是**凭证落盘**；所以只报「签成了、绑在哪个 authority、cookie 叫什么名」。它**不联网**：签出来与用上去是两个动作（后者由人或浏览器做）。算法**照抄宿主、不自创**（逐步出处见 `src/lib/cookie-sign.ts` 文件头）。⚠️ 一条被真机钉住的反直觉点：cookie 绑定 authority 是**逐字匹配**，而宿主算 audience 读的是 `Host` 请求头 —— 显式设 `Host` 会被静默忽略，实际 authority 由**连接地址**决定，所以 `host` 参数必须填你**真正要连的那个地址** |
| `dsh_restart`（**行动**） | **唯一不可逆**的工具：它退出本宿主。**顺序是判据**：四道确定性闸门（重启循环 / 忙闲 / 组合 / 启动命令）→ **审批门** → 写 marker → 拉起 → 退出；**审批门排在闸门之后**，因为反过来会出现「先弹窗同意、再告诉用户闸③不过」。实现是**两段式**：`planRestart` 把「四道闸」与「写 marker」收在同一个入口里，所以先用 `dryRun` 探一遍（不落盘）、过了才走审批、再真落盘。**审批语义 = 先读档位再决定问不问**：`ask` ⇒ 走官方审批门，**只有 `allowed-once` 算允许**（`rejected` / `cancelled` / `unavailable` 一律当拒绝）；**`never` ⇒ 不问** —— 它是「提示已关闭」，在那一档主动去问**必然被拒**；读不出来 ⇒ fail-closed。**闸门拒绝不是失败**（`ok: true` + 一句 remedy）：它是设计的一部分，模型应原样报给用户。**闸②的真实收集不许漏成「只查 running agents」** —— 会话回合 / 后台作业 / 定时提醒全算，**含调用方自己的作业与提醒**（只排除「调用方自己那个回合」）。**拉起**走计划任务（`{detached:true}` 实测逃不出宿主 job）；**marker 必须在拉起之前 `await` 完成**，退出走 `ctx.get('appExit')`（**不用 `process.exit`**）。拉起失败 ⇒ 结构化失败且**不退出**：marker 留在盘上，下次启动仍能看出「上次重启没完成」。宿主契约与实测 → [HOST-CONTRACTS.md](HOST-CONTRACTS.md) §2 |

## 6. 配置

`inject` 只声明 **`tools`**（硬依赖）。**`skills` 不写进去** —— 写进去会让缺技能服务的宿主把整个插件挂成 PENDING（静默无输出，且不算错误），而技能只是可选能力：**技能注册失败时工具半边必须照常工作**。

profile 名只能从 env `DSH_PROFILE` / `DSH_PROFILE_DIR` 读：**`--profile` 被 CLI 自己吃掉了**，`ctx.cmdlineArgs` 里根本没有它。

**`dshHome` 的三个来源**（`config` / `env` / `default`）连同 `dshHomeSource` 一起进返回值：诊断工具最坏的一种失败不是报错，而是**看着成功、其实读的是另一份目录 / 另一个 profile**。把来源写进返回值，用户一眼就能看出「它读的是默认的 `~/.dsh`，不是我以为的那个」。这是只读的 —— 不改行为，只把隐藏假设摊开。

**两个预算字段**（快档 / 慢档）：默认值住在 `src/lib/timeouts.ts`，`src/config.ts` 只引用（见 §5.1）。schema **刻意不加 `.min()`**：用户填一个极小的值时，不变量「传输预算 < 工具预算」**不会**静默破（有封顶），而 `.min()` 会**新拒掉**今天能装的配置，且我们**判别不了宿主把 schema 拒绝呈现成什么**（响亮报错，还是活跃坑里那一族「被 catch 进 `skippedBundles` ⇒ 插件像没装一样消失」，后者更坏）。边界数因此只作为**推导出来的常量**与**判据**存在，要不要在配置面上强加它是维护者的决定。

配置项的名称、默认值与取值语义由 **README×2 的配置表**呈现（成对件）；**默认值的真源是 `src/config.ts` 与 `src/lib/timeouts.ts`** —— 表与代码不一致时，代码才算数。

## 7. 宿主兼容性：真正的门是 peer，不是 engines

- 兼容性判定读 **`peerDependencies`**，且带 `includePrerelease`。
- **`engines.dsh` 没有任何读取者** —— 只写 `engines` 等于没有约束。
- 失败是**静默**的：profile 加载路径把兼容性错误 `catch` 进 `skippedBundles`，进程照常启动、插件像没装一样消失。`dsh plugin add` 那条路才是硬失败。
- ⇒ `engines.dsh` 与每个 `@deepseek-ai/dsh-*` 的 peer **必须同值**，改一处就得改另一处（红线 A1/A2 断言这两条；改依赖范围时 peer 与 dev 也必须同批改）。

## 8. 测试策略

- **单测不碰真机**：`lib/` 的 IO 走注入（子进程 / HTTP / Loader 树），**不 mock 类**；文件系统不注入 —— 单测用临时目录造一个假 `$DSH_HOME` 更真。
- **每个注册表都要有「注册 / 销毁」断言**（官方要求 HMR-safety：dispose 掉贡献的 fiber 并断言清理）。
- **真机判据在 `test/integration/` 且由独立角色跑**：验证者不写 `src/`，发现问题回报写者 —— 避免「自己验自己」。
- **零依赖注入原则**：能注入函数就不要起真进程；能读真实产物就不要造替身。
- **判据优先做成「扫源码」而不是「跑一遍」**：不变量能静态照出来就不要靠一次运行（B10 / B15 扫整个 `src/**`；超时预算判据扫工具目录）。凡做不到的，把「为什么做不到」写成判据自己的已知限度。
- **平台相关的用例必须显式钉住平台**（`withPlatform(…)` 声明这一条测哪条分支），**不在用例里按真实平台分支** —— 本机是 Windows、CI 是 ubuntu，写死一边必然在另一边红；伪装的时机也有约束（必须在 worker 内改）。

**真机验证阶梯**（顺序不能换，每一步失败都会推翻后面所有步骤）：

| 步 | 判据 | 为什么排在这里 | 判据在哪 |
|---|---|---|---|
| S1 组合层 | 本插件的行真的进了配置树（来源头指向本仓的 `cordis.patch.yml`；schema error 的 `path` 不指向本行） | 组合期错误会被 `skipping` **整条丢弃** → 插件消失且毫无异样；不先钉住它，后面所有「没生效」都无法归因 | `test/integration/bench-s1.ps1` |
| S2 技能 rank | 隔离实例里本插件索引赢用户级、让位项目级；停用插件后老会话与新会话**同时**退回用户级（这条抓的是「停用即泄漏」） | rank 错了是静默 shadow，且同名竞争**此刻就存在** | `test/integration/leak-fix.ps1` |
| S3 工具端到端 | 工具真的被注册、返回值可读（永不 throw / 结构合法 / 每个工具成功与预期内失败各一条 / `nextStep` 合规）；**「观测」与「推断」不许混** | 不依赖产物路径解析，先打通注册通路 | `test/integration/s3-harness.mjs` |
| S4 产物 | `npm pack` 后 tarball 里含技能正文、解包目录里的 `lib/` 可 import 且**无副作用**、装进隔离实例后 catalog 出现本插件描述 | 「源码跑得通」**推不出**「发布产物里路径对」—— 缺 root 不会让插件启动失败 | `test/integration/s4-import-check.mjs` |
| S5 HMR 前置门 | 有 hmr 与无 hmr 两种 profile 各验一次 | 它是热重载工具能否安全存在的前提 | **无脚本**；本机以手工隔离实例验过两种情形（见 [AGENTS.md](../AGENTS.md) 活跃坑里那条讲「触发者住在 hmr 里」的） |
| S6 会话标记闭环 | 写 → 重启 → 读回 | 失败退路依赖工具通路 | **依赖 `dsh_restart` 的恢复半**；marker 由工具壳写、由恢复半消费这条**已在真宿主验过**（见 §9 那条的证据分级） |
| S7 副作用工具 | dry-run → 真跑 | 它会杀掉宿主；搞坏一次，S1–S6 的环境全部重来 | `dsh_restart` 的 `dryRun` 已实现；**真跑已在活宿主上做过**（四道闸全过、marker 落盘、宿主退出、新宿主起来） |

⚠️ **本文件不记这些脚本的执行结果**（那会立刻过期）：S1–S4 的判据脚本**已在仓里**，而**本仓内没有它们的执行记录** ⇒ 「过没过」是**无法判定**，要现跑。

## 9. 仍未落地的（产品 / 产物面）

**宿主侧「核过 / 还没核」的清单在 [HOST-CONTRACTS.md](HOST-CONTRACTS.md) §5**（那是同一种事实，只住一处）。本文件只留**不是宿主事实、而是产品 / 产物层面**的待验项：

- **S3 / S4 的执行**：脚本已入库（见 §8），**结果无记录** —— 下次发布前现跑。
- **`dsh_restart` 的闭环分两段，等级与判据在 [AGENTS.md](../AGENTS.md) 的待办里**（要真起服务、要空闲端口，理由见 [test/integration/README.md](../test/integration/README.md) §0）。
  边界只记一句：**「marker 被真消费」`[已实测]`，「重启后立刻恢复」那个时序 `[无法判定]`** —— 在后者成立之前，**不许把它写成「闭环全部跑通」**（含本文件上表那两行）。
- **`SkillReport.scoped` 的真机可观测性**：见 §3.1 末尾那条。
