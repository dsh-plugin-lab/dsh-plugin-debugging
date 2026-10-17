# dsh-plugin-debugging — 维护索引

本文件只服务「在这个仓里怎么干活」。它不回退到别处，也不引用仓外路径。

## 状态

- 版本以 [package.json](package.json) 的 `version` 为准
- **已发布到 npm**（当前版本见 [package.json](package.json)；`latest` 与 dist-tags 以 registry 为准）。**`0.2.0` 是第一个由 `release.yml` 发出的版本**（带 provenance）；`0.1.0` 是手动发的、**没有** provenance。SLSA 徽章的真实性判据是 [docs/PUBLISHING.md](docs/PUBLISHING.md) 的「provenance 要对具体版本查」那一条 —— 两份门面的徽章注释只留指针，不重述规则（一处一事实）。版本线与判例见 [docs/PUBLISHING.md](docs/PUBLISHING.md)
- **能力面 = 1 个技能 + 8 个工具**：5 个只读（`dsh_check_effect_mode` / `dsh_diagnose_plugin_load` / `dsh_check_auth` / `dsh_dump_config` / **`dsh_list_instances`** —— 最后一个是 D′ 的**发现**工具：列本机活着的 DSH，**只给 authority（`host:port`）、给不出 `DSH_HOME`**）、**1 个写侧** `dsh_hot_reload`（已实现、已真机验证；算法与关键语义见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §5）、**1 个派生** `dsh_sign_cookie`（唯一会经手秘密的工具，**cookie 值刻意不进返回值**）、**1 个行动** `dsh_restart`（四道闸 → 审批门 → 真拉起 → 退出宿主；**已实现**，且真机闭环已验两次：「工具壳写的 marker 被恢复半真消费」+ **「重启后立刻恢复」的时序**（2026-10-15，`103s`）。默认**关**：配置字段 `enableRestart`（`.volatile()` ⇒ 拨开即生效、不用重启），关着时**结构化拒绝**而**不是**不注册）。**目标形态与后续工具的归属见 [docs/SHAPE.md](docs/SHAPE.md)**
  —— 工具清单以 [src/tools/index.ts](src/tools/index.ts) 的注册处为真源，红线 B9 钉住名字闭集。
- **本仓是两个半边**：工具半边（`src/tools/`，都是代码）与技能半边（正文 + [src/skills/](src/skills/README.md) 的注册代码）。
  技能正文在 [skills/](skills/README.md)，它**是运行时载荷而不是文档** —— 同一目录下那两份双件才是文档，区别见那条目录的说明。
- **「只读」纪律只覆盖诊断半边**：写侧改动必须先落决策 —— 见 [.agents/notes/2026-10-13-write-side-tool-boundaries.md](.agents/notes/2026-10-13-write-side-tool-boundaries.md)。**边界与唯一例外见下面「诊断半边保持只读」那一条**；判据才是真源（`test/redlines.test.ts` 的 B10 / B15）。
- **输出契约 = `{ verdict, key, audit }`**（顶层恰好三键，成功失败同形）。冻结签名见 [docs/SHAPE.md](docs/SHAPE.md) §4.1；`hint` 已删、`evidence` 已并入 `data`；**`error.message` 不进模型文本**（它的角色与 `verdict` 不同，见 SHAPE §4.1 的字段角色表）

## 索引

**先看这里。三条链按「你现在要做什么」分；证据一律在 notes，本文件只留规则。**

| 你现在要 | 去哪 |
|---|---|
| 改一处，不知道还要同步什么 | 下面「改动影响路由」 |
| 遇到一个症状，找对应规则 | 下面「症状 → 条目」 |
| 核某条规则**凭什么**成立 | [.agents/notes/](.agents/notes/README.md) —— 证据、实测、被否掉的方案都在那里 |

### 改动影响路由

| 你改了 | 同批必须改 |
|---|---|
| 工具的名字或数量 | [src/tools/index.ts](src/tools/index.ts) → [docs/SHAPE.md](docs/SHAPE.md) §2 → 红线 B9 |
| 工具的模型可见文本 | 红线 B14（`src/**`）/ B14b（技能正文）/ B17（描述面） |
| 技能正文的 frontmatter 或首尾 | [test/redlines.test.ts](test/redlines.test.ts) 的 B12 / B12b、[test/skills/register.test.ts](test/skills/register.test.ts) 的锚点 |
| 配置字段 | [src/config.ts](src/config.ts) → [docs/SHAPE.md](docs/SHAPE.md) → 两份门面的配置表 |
| 输出契约 | [src/contracts.ts](src/contracts.ts) → SHAPE §4.1 → 红线 B24 |
| 跨工具共享的助手（装配 / 投影 / 渲染） | 只住在 [src/tools/shared.ts](src/tools/shared.ts)；落点索引见 [src/tools/README.md](src/tools/README.md)「共享助手住在哪」 |
| 依赖范围 | `peerDependencies` **与** devDependencies 同时改（坑 1：`engines.dsh` 没人读） |
| 门面或 `locale/*.json` | 成对改（两份门面 / 两份 locale） |
| 任何文档 | 跑 `python "..\scripts\check-links.py" . --fragments --refs`，**错误数必须保持 0** |

### 症状 → 条目

| 症状 | 看 |
|---|---|
| 改了配置没生效 | 全局规则「配置会被重读，但**触发者住在 hmr 里**」（坑 34） |
| 装了插件却像没装 | 坑 1（peer 冲突**静默**）· 坑 12（裸包名解析不到） |
| 判据全绿，但其实坏了 | 坑 18 · 坑 37 · 坑 40 —— **假绿三兄弟** |
| 结论看着对，其实读错了对象 | 坑 19 · 坑 20 · 坑 21 · 坑 22 |
| 本机绿 CI 红（或反过来） | 坑 24 · 坑 25 —— 先问「这条判据在哪个上下文跑」 |
| 写 `.ps1` 出怪错 | 坑 29（撞自动变量）· 坑 32（BOM）· 坑 38（`edit` 剥 BOM） |
| 提交时弄脏了别人的活 | 坑 31（`git add -A`）· 坑 36（`reset --hard`） |
| 目录树里少文件、CI 却说缺 | 坑 23（裸 `lib/` 忽略任意深度） |

## 验证快照

- **本机**：`pnpm run check` 全绿；`tsc` 两个配置各 **0 error**；`lint` / `format:check` / `check:release` 全过（2026-10-14 实跑）
  —— **文件数 / 用例数 / `check:release` 的条数都是会漂的值，一律现查**（`pnpm run test` 的汇总行、`pnpm run check:release` 的输出）
- **红线**：覆盖面**以 `test/redlines.test.ts` 里 `describe('B…')` 的闭集为准** —— **不要在这里手抄编号清单，也不要抄用例数**。
  理由（踩过）：抄一次就意味着**每次加红线都得同批改这里**，而漏改的那次就是一句**骗人的假话**（本仓据此把「红线只到 B22」写错过一次）。
  要个数就去 `pnpm run test` 看那一行 —— **文件数是稳定的，用例数不是**（并发写者会让它在同一轮里就变）
- **CI**：见 [.github/workflows/ci.yml](.github/workflows/ci.yml) 的 `CI Success`（唯一 required check）
- 上面留的是**跑法 + 形状**；任何会漂的值（用例数、红线条数、行号、宿主版本号）一律现查

## 全局规则

- **结论必须来自实测**，不来自文档推断。引用宿主行为时写清是**哪一份真源、什么版本**
  —— 本机「在跑的宿主」与「源码检出」常常不是同一个版本。
- **能落成校验的就不写散文**：不变量做成 `test/` 下的红线或 `scripts/` 下的检查，这里只留指针。
- **诊断半边保持只读**：不改 profile、不写 `$DSH_HOME`、不杀进程。**写侧只做「不杀进程」的那一种**（就地换模块，失败放回旧版本）。**会杀掉宿主的重启类动作不并入写侧** —— 它是**独立的行动类**，靠四道闸 + 审批门 + marker 恢复（形态见 [docs/SHAPE.md](docs/SHAPE.md) §6.1）。任何越界的「顺手修一下」先落决策。**这条规则本身由机器判据守着**（`test/redlines.test.ts` 的 B10：杀进程 / fs 写入 / **写宿主数据路径** / 安装面四类，作用域是整个 `src/**`）；写侧的窄作用域与更严的记号判据是 B15。**唯一的例外**（维护者 2026-10-14 拍板，**精确命名空间 / 形态 A**）：`$DSH_HOME/<包名>/` 这一层可以写 —— **只有紧跟 home 的第一段逐字等于包名**才放过，其余顶层项照旧禁止。清单与四条边界用例见 [docs/SHAPE.md](docs/SHAPE.md) §10.3。
- **一处一事实，别处只留指针**：一个事实有两个落点时，删掉一个。
- **指针要能解析，且分层要能被查**：链路由浅到深是 **门面 → 根 [AGENTS.md](AGENTS.md) 仪表盘 → 子树 [README.md](src/README.md) / [AGENTS.md](src/AGENTS.md) 双件 → [docs/](docs/README.md) 活文档 → 判据**。
  「改一处能查到要同步哪」是这条链的**工程结果**，不是风格偏好。
  - **断链比没有更坏** —— 读者以为查得到 ⇒ 每次文档同步后跑链接校验（错误数必须保持 **0**）。
  - **别把「更新文档」当默认动作**：维护者 2026-10-15 明确「不必增加文档压力」——
    文档更新的成本随文档量上涨、且难及时同步，**逐条追着改会追不上**。
    ⇒ **默认动作是「改机器判据」**：能落成红线/校验的事实就落成判据（它会自己红、不会骗人），
    文档只留**形状 + 指针**，不抄会漂的值（见下条）。
  - **活文档说「现在是什么」（过时即改）；非活文档（[.agents/notes/](.agents/notes/README.md)）说「当时为什么」（不追改，只按状态行标注生效/被取代/已归档）。把非活文档改成「正确的」会毁掉它存在的价值。**
- **改动连带同步点**：谁引用了你改过的路径 / 名字 / 规则，同批改。双语门面（[README.md](README.md)
  与 [README_zh.md](README_zh.md)）与两份 `locale/*.json` 是典型的成对件。
- **不抄会漂的值**：宿主版本号、计数、行号一律现查；写「形状」，不写「值」。
- **CI 与本地平台不同**：本机是 Windows，CI 是 ubuntu。**任何写死平台行为的断言都会在 CI 上红**
  （首次推送就踩过：`probed === true` 那条）。新增平台相关判据时，用显式声明测哪条分支的写法
  （见 [test/tools/AGENTS.md](test/tools/AGENTS.md)），别在用例里按真实平台分支。详见坑 25。
- **代码注释写中文；可能到达模型/用户眼里的字符串写英文**（工具 `data` 文本字段、`message` /
  `nextStep.why` / render 文本）。只被实现内部 catch、进不了返回值的字符串不受此限
  （例如测试替身自己的中文 Error）。**这条由 `test/redlines.test.ts` 的 B14 守着。**
- **改动走 PR，不直推 `main`**（维护者 2026-10-13 指定）。ruleset 里那条 `RepositoryRole` bypass 让直推
  **技术上能过** —— 但那是逃生门，不是常规路径。流程：开分支 → 推 → `gh pr create` → 等 `CI Success` → 合并。
  本地门禁（`pnpm run check` / `lint` / `format:check` / `check:release` / 链接校验）照旧在开 PR 前跑完。
- **门面的语言切换行与工作区其他插件仓写法一致**（放在居中 div 里的 HTML `<a href>`）。**这曾经是有意的分歧**：
  本仓原先用 Markdown 链接行（`English | 中文` 那种写法）以换取链接校验 **0 警告**，代价是那一行不居中；
  维护者 2026-10-13 要求门面与工作区其他插件仓视觉一致，于是改回 HTML 形。**代价如实记下**：链接校验会把
  HTML 锚点报成「引用未做成链接」——**这两个文件各贡献一条**（[README.md](README.md) 与 [README_zh.md](README_zh.md)），**错误数仍为 0**。
  ⚠️ **警告总数不只是那两条，别抄总数**：另有一族是**裸写 `AGENTS.md` 而不做成链接**
  （本文件自身、[.agents/notes/](.agents/notes/README.md) 若干、[docs/SHAPE.md](docs/SHAPE.md)）—— 它们与门面无关，是独立的一族。
  **要写就写形状（「门面各一条」+「裸引用另成一族」）**：总数是会漂的值，现跑
  `python "..\scripts\check-links.py" . --fragments --refs` 看。
  想回到 0 警告就把两份门面的语言切换改回 Markdown 行 —— 要改就同批改这里。

## 常用命令

```shell
pnpm run check          # typecheck + build + test
pnpm run check:release  # 发布态不变量（scripts/check-release.mjs）
pnpm run lint           # ESLint
pnpm run format:check   # 格式
```

```shell
# 身份件比对：只比 5 个「逐字相同」件，离线只读，随时可跑
# （脚手架**不在本仓**，在工作区里的另一份检出中；下面这条路径按实际那份填）
node "<脚手架检出>/scripts/scaffold.mjs" check dsh-plugin-debugging

# 链接校验与换行校验
# （check-links.py **不在本仓**，在工作区根的 scripts/ 下）
python "..\scripts\check-links.py" . --fragments --refs
git diff --check
```

## 文档地图

**两层职责互斥**：规则层只答「在这里工作要遵守什么」，手册层只答「这里有什么、改哪波及谁」。
每个可维护目录都有一对；进目录自动注入规则层，手册层按需读。

- 对外说明（门面）→ [README.md](README.md)（English）· [README_zh.md](README_zh.md)（中文）

**根级文档**（跨模块的那几份，各答一个问题、别混）：

- 设计说明（为什么这样分层）→ [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 宿主契约台账（已核 / 已实测的宿主事实，调宿主 API 前先查）→ [docs/HOST-CONTRACTS.md](docs/HOST-CONTRACTS.md)
- 插件形态方案（工具怎么分、JSON 怎么管、双通道、工具的归属、红线清单）→ [docs/SHAPE.md](docs/SHAPE.md)
- 发布流程与判例 → [docs/PUBLISHING.md](docs/PUBLISHING.md)
- 发布态不变量（可执行的检查脚本）→ [scripts/check-release.mjs](scripts/check-release.mjs)
- 展示元数据 → `locale/en.json` · `locale/zh.json`（只住这里，别处只留指针）

**子树手册**（各子树的职责、依赖与变更影响路由在各自的手册层里）：

- 实现半边 → [src/](src/README.md) · 三棵子树的规则与手册见各自双件
- 技能半边 → [skills/](skills/README.md)（正文目录的规则见其 [AGENTS.md](skills/AGENTS.md)）
  ⚠️ **技能正文是运行时载荷，不是文档**：它由 [src/skills/register.ts](src/skills/register.ts) 在启动时读走交给宿主技能服务，**没有「源文件 vs 产物」的关系，不需要跟谁同步，改了也不必重新编译**。删掉它不会让插件崩溃，只会让技能静默消失 —— [scripts/check-release.mjs](scripts/check-release.mjs) 才拦得住。
- 判据 → [test/](test/README.md) · 本机红线（不进 CI）见 [test/integration/README.md](test/integration/README.md)
- 决策与依据 → [.agents/notes/](.agents/notes/README.md)（不建索引，去哪查规则见它的双件）
- 托管侧配置（工作流与依赖升级）→ `.github/` 的配置本身；**这里刻意没有 `README.md`** ——
  GitHub 会把 `.github/README.md` 渲染到**仓库首页**，那份版面属于访客，不属于 CI 内部约定。
  工作流改动的约束见 [.github/AGENTS.md](.github/AGENTS.md) 与 [workflows/AGENTS.md](.github/workflows/AGENTS.md)。
- 发布态检查脚本 → [scripts/](scripts/README.md)
- 目录级规则与手册的分工见本文件「[文档地图](#文档地图)」开篇的「两层职责互斥」那两条；门面与子目录双件**不是**同一套设计，理由同样在那里。

## 待办

**已完成条目的完整证据已搬去** [.agents/notes/2026-10-15-completed-items-evidence.md](.agents/notes/2026-10-15-completed-items-evidence.md)
（7 条：marker 恢复闭环、重启 verdict 落盘、客户端半边、非 Windows 端口识别、红线批 2b、测试助手收敛、两条复验残余）。
**为什么搬**：那 7 条记的是「当时为什么」，而本文件**每个会话都注入** —— 规则层放叙事，等于每次会话都交一遍历史的上下文税。

**还开着的：**

- [ ] **停止窗口拿不到端口时只能退化成「没有窗口」—— 宿主自己的端口应当被自动发现。**
      现状：`dsh_restart` 用 `resolvePort` 定端口（显式参数 > 插件配置 > `DSH_WEB_URL`），
      而本机实测**宿主进程里没有 `DSH_WEB_URL`** ⇒ 只剩插件配置一条路 ⇒ **装了这个插件的人
      得自己配 `port`**，否则重启后新宿主既无控制台、又无可见停止入口（会如实报
      `stopWindowSkipped`，但那已经是降级）。
      可做的方向：拿**本进程自己的 pid** 反查它在监听哪个端口（宿主就是自己，不需要猜），
      作为 `resolvePort` 的第四条来源。它是 IO（Windows 上要起查询子进程），而
      `relaunchPlanOf` 目前是同步的 ⇒ 得把它提到 `planRestart` 的异步侧。
      形态与实测 → [docs/SHAPE.md](docs/SHAPE.md) §6.1.2 的端口段。

- [ ] **技能压过用户级同名技能 —— 机制已实现，代价仍在**：动态 scope 注入让 rank 250 真正赢；
      成本是技能此后**只在装了本插件的 profile 里**可见（见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §3）。
      决策与「静态写进 preset 为何被否决」→ [.agents/notes/2026-10-13-skill-registers-twice-dynamic-scope.md](.agents/notes/2026-10-13-skill-registers-twice-dynamic-scope.md)。
- [ ] **`SkillReport.scoped` 真机不可观测** —— `state.skill` 没有对外暴露面，pluginInventory 也不含插件内部状态。
      v1.1 可考虑让本仓某个工具报出「技能半边注册成了没有、几个 agent」，这样「注册了但没生效」不必靠 winner 反推。
- [ ] **桌面载体上插件侧没有回归路线** —— `dsh_restart` 在那里只能**如实拒绝**（拒绝码 `no-relaunch-route`）：能重启它的只有 Electron 壳，而 Host↔壳的 IPC 是闭集、对页面的通道里没有 restart / relaunch。要让它真正可用，**得上游在闭集里加一条重启请求**（落地后本仓只多一个 `relaunchRouteFor` 取值 + 一条实现）。
      事实真源 → [docs/HOST-CONTRACTS.md](docs/HOST-CONTRACTS.md) §2.7；决策与被否掉的替代方案 → [.agents/notes/2026-10-16-desktop-carrier-decision.md](.agents/notes/2026-10-16-desktop-carrier-decision.md)。
- [x] **`SKILL.md` 冻结**（维护者 2026-10-15 拍板）：技能正文**冻在 0.4.0 那一版**，不再跟着插件演化。
      理由是收益判断：一轮无背景冷读显示，「问题」里**大部分其实是技能与工具的设计分工**，再改误伤多于修好。
      冻结声明写在那次提交的提交信息里；正文见 [skills/dsh-plugin-debugging/SKILL.md](skills/dsh-plugin-debugging/SKILL.md)。
      ⚠️ **本条取代了 2026-10-13 的「解冻」决定**：那条的**推理链**（插件在演化，冻结会让正文说谎）没被推翻，
      被推翻的是**边际收益** —— 解冻之后的改动已经低于误伤成本。中文初版存档在
      [skills/dsh-plugin-debugging/archive/2026-10-12-pure-text.md](skills/dsh-plugin-debugging/archive/2026-10-12-pure-text.md)。

## 活跃坑

**每条都是踩过的，按「错了会不会静默坏」排序。这里只留规则；证据（实测、复现、被否掉的方案）在
[.agents/notes/2026-10-15-pitfall-evidence.md](.agents/notes/2026-10-15-pitfall-evidence.md)，编号 1–40 一一对应
（坑 41 的证据在 [.agents/notes/2026-10-16-desktop-carrier-decision.md](.agents/notes/2026-10-16-desktop-carrier-decision.md)）。**
⚠️ = 静默坏 —— 错了不报错，最费人。

1. `engines.dsh` **没有任何读取者**；兼容性门是 `peerDependencies`（带 `includePrerelease`）。⚠️ 冲突被 `catch` 进 `skippedBundles`，插件像没装。**改依赖范围时 peer 与 dev 同批改。**
2. `parseSkillFile` **不是公开 API**（签名依赖 `ctx.fs` 与真实路径）⇒ frontmatter 自己解析。
3. `ctx.skills.register()` **不校验 `content`** ⇒ 「正文为空」必须由本仓判成失败，否则要到渲染时才是空。
4. 自定义 `SessionEventMap` 成员 + `session.append()` 会**写坏会话日志** ⇒ 走 `appendPluginRecord()`（`plugin:` 前缀、强制 `ignorable`）。
5. **5 个身份件不要动**（`.gitattributes` / `.node-version` / `release-drafter.yml` / `.pre-commit-config.yaml` / `.prettierignore`）—— 它们是 `scaffold check` 的比对对象；有意分歧必须就地记一句。**已记的分歧（迁 pnpm，两个文件）在证据篇里 —— `scaffold check` 在这两个文件上报 `DIFF` 是预期的。**
6. rank **升序、小者胜**；runtime 恒 250 且无旋钮，只在**同层内**比较 ⇒ 压得住 custom / user，**压不住** project-dsh(100) / project-agents(200)。⚠️ 被 shadow 完全静默。
7. **技能不进系统提示词**：模型只先看到 `name` + `description` ⇒ 描述写不好 = 插件不存在。
8. `--dump-config` **退出码恒 0**，不能当门禁；`--dump-config-schema` 退出码 1 = 有 error。已知误报看 error 的 `path` 指不指向**你改过的那一行**。
9. **`--profile` 不会到达插件**（CLI 自己吃掉了）⇒ 只能从 env `DSH_PROFILE` / `DSH_PROFILE_DIR` 读。⚠️ **但 profile 身份不要从这里读** —— 见坑 41。
10. 装带安装脚本的依赖要**先明确放行字段**，否则本机与 CI 行为不一致（本仓为 `esbuild` 的 postinstall 踩过）。
11. `defineTool` 的 `output.schema` 要**作者层字面量**，结构强制挪到返回前的 `ensureToolResult()`。⚠️ 喂已标注的 schema 会报**方向相反**的类型错，`execute` 静默退化成 `Promise<never>`。
12. `cordis.patch.yml` 的 `insert:` 用裸包名时，**只有该包能从「被启动 profile 的目录」解析到才挂得上**。⚠️ 组合树照样有行、退出码 0，运行期 `failed to import` —— 行在、功能不在。
13. `patched by <file>` 标的是**改动该行的那一层**，不是插入者 ⇒ 别按「带该标注」判本插件进没进树。
14. 解析 `dsh` 的 stderr 要认**两种形状**（带严重级 / 只带来源），否则组合期错整条漏掉。判定用「已筛出的 actionable 列表非空」，不用退出码。
15. `defineTool` **拒绝非正 `timeoutMs`** ⇒ 「预算已耗尽」的用例要用注入时钟，不能拿 0 构造。
16. `prettier --write "src/lib/**/*.ts"` 在扁平目录**一个文件都匹配不到** ⇒ 写 `src/lib/*.ts`，或直接给目录名。
17. `**/` 这一族两处咬人：块注释里的 `*/` 会**提前终止注释**（报「no tests」而非语法错）；正则里 `['"]x['"]` 只认 argv，`'…'` 字符串命令会漏。
18. **判据的假绿要自己探**。⚠️ 最危险的是 `skip`（GitHub 当 Success）⇒「文件在但提不出任何名字」**必须判红**。
19. **「Fiber 级状态没有查询入口」是错的**：`ctx.get('loader')` 无需声明 inject 就可见。⚠️ **import 期就失败的 entry 没有 `fiber`**。别去 import `dsh-host-plugin-inventory`（解析不到）。
20. 取 `loader.entries()` **必须按 `Symbol.iterator`**，不能假定数组（`.find()` / `.length`）。⚠️ 两种错法都静默：当数组用 ⇒ 假阴性；拒绝数组 ⇒ 每棵树读空。
21. 读 `fiber._error` 时**不要 `await fiber.await()`**（可能永不 settle ⇒ 工具永不返回）。
22. **同一棵树两次读不许给出不同结论** ⇒ 多行同包的定序写死（严重级 + `entryId` tie-break）。
23. `.gitignore` 的 `lib/` **必须锚定成 `/lib/`** —— 裸的匹配任意深度，会把 `src/lib/`（源码）一起忽略。⚠️ 本机全绿、CI 缺文件。
24. **判据要写清「在哪个运行上下文里成立」** —— 上下文与实际不一致时，得到的是假红或假绿。
25. **平台相关判据显式声明测哪条分支**（`withPlatform`），别按真实平台分支；伪装 `process.platform` **必须在 worker 内改**。
26. `agent/created` 是 **serial 派发，处理器里不许 `await`**（会让建 agent 直接卡住）⇒ 技能注册必须同步完成。
27. 探针里**别 `JSON.stringify` 活对象**（循环引用抛错）；flush 失败**另写错误文件**，别吞。⚠️ 否则报告静默停在上次成功态，看起来像「事件没触发」。
28. **在 A 的作用域注册、由 B 撤销时，注册与撤销必须落在同一条 effect 链上** —— 否则撤销只在不出事的路径上成立。
29. 本仓 `.ps1` 的参数**不许叫 `$Args` / `$Profile`**（撞自动变量，报错方向很偏）。
30. **判据要跑本仓自己的门禁命令**，别自造更严格的调用 —— 那会造出「已提交且 CI 一直绿的文件被判红」的假红。
31. **提交时不许 `git add -A`**：有并发写者时只 add 自己的路径 —— 提交者不能替别人决定提交边界。
32. **本仓 `.ps1` 必须 UTF-8 *with BOM***（PS5.1 无 BOM 按 GBK 解码 ⇒ 中文注释直接解析失败）。⚠️ prettier 跳过、CI 不解析，本机与 CI 全绿也照不出来。
33. **包管理器翻转时** `.gitignore`、两个 workflow、`.prettierignore`、`.pre-commit-config.yaml`、`release-guard.mjs` 的非产物清单**必须同批翻**。⚠️ 漏 `.gitignore` 最凶：锁文件被本地忽略、CI 缺它。
34. **「配置会被重读」的触发者住在 hmr 里**；判断 hmr 只有两条真源：**profile 文件**与 **`--dump-config`**。⚠️ 别拿 `ctx.get('hmr')` 当探针（挂着也是 `undefined`）。⚠️ **保留 profile（`desktop`）上第二条取不到**（CLI 拒绝那个 profile 的 dump）—— 那一档读什么，见 [docs/HOST-CONTRACTS.md](docs/HOST-CONTRACTS.md) §2.7。
35. **别拿不存在的字段当判据**：`resolved` 只有 `{ dshHome, dshHomeSource, profile, port, portSource }` ⇒ 验「重读」看 `resolved.profile`。
36. 共享工作树里**别用 `git reset --hard` 同步分支** —— **「工作区干净」≠「没人在写」**，落进窗口的改动会无声消失。
37. **「断言症状消失」≠「断言根因修好」** ⇒ 修复里带兜底 `try/catch` 时，**先写护栏、再把 bug 改回去跑一遍**。**推断不算钉死，变异才算。**
38. **`edit` 工具会剥掉 `.ps1` 的 BOM** ⇒ 用 `[IO.File]::WriteAllText(…, UTF8Encoding($true))` 写回并复核头三字节。
39. `tool.parameters` 是**编译后的 JSON schema** ⇒ 参数描述的判据必须点进 `.properties`，并配**下界**（个数 > 0 / 描述非空 / 合计 > 0）。
40. **测试替身被静默丢弃 ⇒ 判据退回真实世界**：overrides 用**显式对象构造**，并**给替身配调用计数、断言它真被调用过**。⚠️「没生效」与「生效了」在绿的时候长得一样。
41. **`DSH_PROFILE` 不是 profile 身份的真源**（真源是运行时的 `profileContext.name`：启动器在建树之前 `provide`，检索串 `provide('profileContext'`）。⚠️ **它记的不是这个宿主的身份** —— 可能来自启动 shell 的**继承**、也可能来自本仓 `DEFAULT_PROFILE` 的**兜底**，**成因判「推不出来」**（本机没有用户级 / 机器级持久 `DSH_PROFILE`）；两种成因**后果相同**：**按它拼重启命令行会拉起另一个 profile**（2026-10-15 真机缺陷：桌面宿主上拼出 `--profile web`，恢复半的成果落进了错的实例）。证据与决策 → [.agents/notes/2026-10-16-desktop-carrier-decision.md](.agents/notes/2026-10-16-desktop-carrier-decision.md)、宿主事实 → [docs/HOST-CONTRACTS.md](docs/HOST-CONTRACTS.md) §2.7。