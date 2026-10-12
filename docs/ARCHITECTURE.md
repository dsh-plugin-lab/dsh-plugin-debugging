# dsh-plugin-debugging — 设计说明

**本文职责**：这个插件**为什么这样分层**、每条设计的理由与代价、以及「哪些结论是核过的、哪些还没」。
**不负责**：怎么在这个仓里干活 → [AGENTS.md](../AGENTS.md)；发布流程 → [PUBLISHING.md](PUBLISHING.md)；决策快照 → [.agents/notes/](../.agents/notes/)。
**读者纪律**：本文里的宿主行为结论都标了真源。**在跑的宿主**与**源码检出**常常不是同一个版本 —— 引用之前先确认哪一份。

---

## 1. 定位与边界

把一份排障知识本体（`skills/dsh-plugin-debugging/SKILL.md`，v2.1.4）随包分发，并用四个**只读**工具把其中
可机械判定的部分做成加速器。

**管**：改动何时生效（热生效 / 重启 / HMR）、插件到底加载没有、`401` 与连接被拒的分辨、组合后的配置树。
**不管**：写插件、选扩展点、改 preset、列可安装包。

**v1 只读是设计决定，不是进度妥协。** 唯一会杀掉「正在被排障的那个宿主」的动作是重启与热重载；
它们的审批语义、冷却、失败恢复边界没定之前不引入（见 [AGENTS.md 的「待办」](../AGENTS.md#待办)）。

## 2. 分层

```
src/
├─ index.ts        唯一接触 Cordis 的地方：读 config、装配两个半边、声明 inject
├─ contracts.ts    跨半边共享的**类型**（不含逻辑）：SkillReport / PluginState / ResolvedConfig
├─ config.ts       Config schema + resolveConfig（把「可能没配」补齐成工具半边认的形状）
├─ skills/         技能半边：解析 frontmatter → 注册进宿主注册表
├─ tools/          工具半边：四个只读工具，一个工具一个文件
└─ lib/            纯逻辑：exec / http / ports / profile / dump / errors / render / timeouts / credentials
```

两条硬边界：
- **`skills/` 与 `tools/` 互不 import**，只共享 `contracts.ts`。这样两个半边可以并行开发且各自单测。
- **Cordis 只在 `index.ts` 与两个半边的注册函数里出现**；`lib/` 全是可直接单测的普通函数（IO 走注入）。

## 3. 技能为什么走 runtime 注册（而不是 filesystem provider）

**结论：`ctx.skills.register()`。** 三条理由，都是回源码核过的：

1. **rank 语义逐字吻合。** runtime 注册的 rank 是模块常量 **250**、**无参数可改**；官方 filesystem provider 的
   `custom` 根是 **300**、`bundled` 是 **600**。250 的语义是「插件直接向注册表注入技能」，300 的语义是
   「用户配置的额外扫描目录」—— 我们要的是前者。
2. **方向要对。** 目标是**盖过用户级同名技能**（本机 `~/.agents/skills/` 下确实有一份同名副本，rank 500）。
   若走 `bundledSkillDir`(600)，优先级比用户级更低 —— 方向与目标相反。
3. **生命周期干净。** 注册挂在 fiber 上（`ctx.effect(function* () { yield skills.register(...) })`），
   卸载与热重载时自动撤，不会留下两代注册。

**代价**：放弃 filesystem provider 的自动解析与 watch，frontmatter 得自己解析，fail-closed 也得自己担。

**rank 的两条边界**（都必须知道，否则会得到一个静默错误的心智模型）：
- 比较是**升序、数值小者胜**；且 rank **只在同一层内**裁决 —— 最近层的同名条目**直接胜出**，不比 rank。
  runtime 注册与宿主行、repository 插件同落**全局层**；由 agent preset 常驻组合挂载的插件落**该 preset 的层**。
  所以「挂载位置」比 rank 更靠前。
- 250 压得住 custom(300) 与 user(400/500)，**压不住** project-dsh(100) / project-agents(200)。项目级赢是预期行为。
- 被 shadow 是**完全静默**的：没有 API 能列出被遮蔽的同名技能。

## 4. 技能半边的三个 fail-closed 点

权威依据是宿主源码：`validateRuntimeSkill` 只校验 kebab name、非空 description 与 invocation；
**`content` 不在运行时校验范围内**（只有 provider 路径的 `validateDefinition` 才查）。也就是说，
走 runtime 注册时**漏了正文字段不会报错**，一直到渲染 `<skill_content>` 才表现为空 —— 那时已经看不出是哪一步坏的。

所以本仓自己判：

| 情形 | kind | 为什么必须响亮 |
|---|---|---|
| 文件读不到 | `missing-file` | 宿主对缺失的 skill root 只「探测到出现为止」，不会让插件启动失败 |
| frontmatter 缺 name/description、name 非 kebab-case、description 是块标量 | `bad-frontmatter` | description 是模型**唯一**的路由信号（技能不进系统提示词）；把 `>-` 当描述注册进去 = 技能对模型不存在且不报错 |
| 正文 trim 后为空 | `empty-content` | 见上：宿主不查 content |

`contentBytes` 是**正文的真实 UTF-8 字节数**，存在的意义就是把「注册成了但正文是空的」这种静默失败照出来。

**技能根路径按产物位置推断**：本模块产物是 `lib/skills/register.js`，故技能根 = `MODULE_DIR/../..` + `skills`。
（上溯**一**级会落到 `lib/skills`，那里没有 SKILL.md —— 而这个错只会静默报 `missing-file`。）

## 5. 工具半边

四个工具都遵守同一条输出契约：

```ts
{ ok: true,  data: {...}, nextStep?: {...} }          // 成功
{ ok: false, error: { kind, message, hint }, nextStep? }  // 预期内失败
```

- **`execute` 绝不 throw**。`kind` 是**闭枚举**，决定模型该不该重试；`message` 给人看；`hint` 是下一步。
- **每个工具都给 `nextStep`**：排障进度不能靠模型背历史（compaction 会丢），要把下一步落进工具结果。
- **`exec.signal` 透传**到 fetch / spawn，让宿主的取消能到 IO 层。
- **工具侧超时 > 传输层超时**：让传输层先超时，得到结构化错误，而不是裸 `TimeoutError`。
- **零运行时依赖**：只用 `node:` 内建与宿主服务。加依赖要先过决策。

各工具的关键语义（判定都依赖它们，写错就静默给错结论）：

| 工具 | 关键语义 |
|---|---|
| `dsh_check_effect_mode` | 「热生效」的前提是 profile 里真的挂了 `hmr` —— 没有 hmr 时 `reload()` 是**空操作**，任何变更都退化成 `restart-required` |
| `dsh_diagnose_plugin_load` | 三处外部证据（`bundles` / 安装形态 / 进程）**只证前置条件，不证加载成功**；Fiber 级状态没有查询入口；`Config.listConfigs` 的 `inactive` 混合「禁用 / 未导入 / 已销毁」三义，**从不报 FAILED**。启动失败的硬证据只在 `$DSH_HOME/logs/startup-*.log`，且**只在启动失败时生成** |
| `dsh_check_auth` | `401` = 服务活着、认证没过；连接被拒 = 没启动。cookie 绑定 authority（`host:port`，`localhost` 与 `127.0.0.1` 不通用），签名密钥落盘、launch token 不落盘 —— 所以「同端口重启旧标签页照常可用、换端口才 401」 |
| `dsh_dump_config` | `--dump-config` 退出码**恒 0**，不能当门禁；`--dump-config-schema` 退出码 **1 = 有 error**；`preset-*` 行的 `unrecognized Loader tree carrier` 是已知误报，判定看 error 的 `path` 是否指向你改过的行 |

## 6. 配置

`inject` 只声明 **`tools`**（硬依赖）。`skills` **不写进去** —— 写进去会让缺技能服务的宿主把整个插件挂成
PENDING（静默无输出，且不算错误），而技能只是可选能力：技能注册失败时工具半边必须照常工作。

profile 名只能从 env `DSH_PROFILE` / `DSH_PROFILE_DIR` 读：**`--profile` 被 CLI 自己吃掉了**，
`ctx.cmdlineArgs` 里根本没有它。

## 7. 宿主兼容性：真正的门是 peer，不是 engines

- 兼容性判定读 **`peerDependencies`**，且带 `includePrerelease`。
- **`engines.dsh` 目前没有任何读取者**（类型注释自陈 declarative until a reader enforces it）——
  只写 `engines` 等于没有约束。
- 失败是**静默**的：profile 加载路径把兼容性错误 `catch` 进 `skippedBundles`，进程照常启动、插件像没装一样消失。
  `dsh plugin add` 那条路才是硬失败。

→ 因此 `engines.dsh` 与每个 `@deepseek-ai/dsh-*` 的 peer **必须同值**，改一处就得改另一处。

## 8. 测试策略

- **单测不碰真机**：`lib/` 的 IO 走注入（`spawnImpl` / `fetchImpl`），**不 mock 类**。
- **每个注册表都要有「注册 / 销毁」断言**（官方要求 HMR-safety：dispose 掉贡献的 fiber 并断言清理）。
- **真机判据在 `test/integration/` 且由独立角色跑**：验证者不写 `src/`，发现问题回报写者 —— 避免「自己验自己」。
- **零依赖注入原则**：能注入函数就不要起真进程；能读真实产物就不要造替身。

**真机验证阶梯**（顺序不能换，每一步失败都会推翻后面所有步骤）：

| 步 | 判据 | 为什么排在这里 |
|---|---|---|
| S1 组合层 | 本插件的行真的进了配置树（`--dump-config` 带 `patched by`；schema error `path` 不指向本行） | 组合期错误会被 `skipping` **整条丢弃** → 插件消失且毫无异样；不先钉住它，后面所有「没生效」都无法归因 |
| S2 技能 rank | 隔离实例里本插件索引赢用户级、让位项目级 | rank 错了是静默 shadow，且同名竞争**此刻就存在** |
| S3 工具端到端 | schema 进模型请求、返回可读、卡片回退正常 | 不依赖产物路径解析，先打通注册通路 |
| S4 产物 | `npm pack` 后 tarball 里含 `skills/**/SKILL.md`，`lib/` 可导入，装进隔离实例后 catalog 出现本插件描述 | 「源码跑得通」**推不出**「发布产物里路径对」—— 缺 root 不会让插件启动失败 |
| S5 HMR 前置门 | 有 hmr 与无 hmr 两种 profile 各验一次 | 它是热重载工具能否安全存在的前提 |
| S6 会话标记闭环 | 写 → 重启 → 读回 | 失败退路依赖工具通路 |
| S7 副作用工具 | dry-run → 真跑 | 它会杀掉宿主；搞坏一次，S1–S6 的环境全部重来 |

## 9. 还没核过的（写在这里，别当成已知）

- 插件技能在**真实 catalog** 里的合并结果与 `source` 显示值 —— 源码只给恒定 250 与分层规则，**必须起实例看**。
- `ctx.skills.register()` 的注册时机与 catalog 缓存失效是否正确配对（源码有实现，耦合读不出来）。
- 审批门在真实 UI/策略下的表现（`danger-full-access` 档下 `ask` 会被确定性拒绝）。
- `schemastery` 两个版本间的行为差异（运行时比检出新一个预发布号）。
- `npm pack` 的 tarball 与隔离实例装载 —— S4 尚未执行。
