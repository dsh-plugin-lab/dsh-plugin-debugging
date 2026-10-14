# dsh-plugin-debugging — 维护索引

本文件只服务「在这个仓里怎么干活」。它不回退到别处，也不引用仓外路径。

## 状态

- 版本以 [package.json](package.json) 的 `version` 为准
- **已发布到 npm**（当前版本见 [package.json](package.json)；`latest` 与 dist-tags 以 registry 为准）。**`0.2.0` 是第一个由 `release.yml` 发出的版本**（带 provenance）；`0.1.0` 是手动发的、**没有** provenance。SLSA 徽章的真实性判据写在 [README.md](README.md) 的徽章注释里（对**具体版本**查 attestations 端点）。版本线与判例见 [docs/PUBLISHING.md](docs/PUBLISHING.md)
- **能力面 = 1 个技能 + 8 个工具**：5 个只读（`dsh_check_effect_mode` / `dsh_diagnose_plugin_load` / `dsh_check_auth` / `dsh_dump_config` / **`dsh_list_instances`** —— 最后一个是 D′ 的**发现**工具：列本机活着的 DSH，**只给 authority（`host:port`）、给不出 `DSH_HOME`**）、**1 个写侧** `dsh_hot_reload`（已实现、已真机验证；算法与关键语义见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §5）、**1 个派生** `dsh_sign_cookie`（唯一会经手秘密的工具，**cookie 值刻意不进返回值**）、**1 个行动** `dsh_restart`（四道闸 → 审批门 → 真拉起 → 退出宿主；**已实现，真机闭环未跑**，见下方待办）。**目标形态与后续工具的归属见 [docs/SHAPE.md](docs/SHAPE.md)**
  —— 工具清单以 [src/tools/index.ts](src/tools/index.ts) 的注册处为真源，红线 B9 钉住名字闭集。
- **本仓是两个半边**：工具半边（`src/tools/`，都是代码）与技能半边（正文 + [src/skills/](src/skills/README.md) 的注册代码）。
  技能正文在 [skills/](skills/README.md)，它**是运行时载荷而不是文档** —— 同一目录下那两份双件才是文档，区别见那条目录的说明。
- **「只读」纪律只覆盖诊断半边**：写侧改动必须先落决策 —— 见 [.agents/notes/2026-10-13-write-side-tool-boundaries.md](.agents/notes/2026-10-13-write-side-tool-boundaries.md)。**边界与唯一例外见下面「诊断半边保持只读」那一条**；判据才是真源（`test/redlines.test.ts` 的 B10 / B15）。
- **输出契约 = `{ verdict, key, audit }`**（顶层恰好三键，成功失败同形）。冻结签名见 [docs/SHAPE.md](docs/SHAPE.md) §4.1；`hint` 已删、`evidence` 已并入 `data`；**`error.message` 不进模型文本**（它的角色与 `verdict` 不同，见 SHAPE §4.1 的字段角色表）

## 验证快照

- **本机**：`npm run check` 全绿；`tsc` 两个配置各 **0 error**；`lint` / `format:check` / `check:release` 全过（2026-10-14 实跑）
  —— **文件数 / 用例数 / `check:release` 的条数都是会漂的值，一律现查**（`npm run test` 的汇总行、`npm run check:release` 的输出）
- **红线**：覆盖面**以 `test/redlines.test.ts` 里 `describe('B…')` 的闭集为准** —— **不要在这里手抄编号清单，也不要抄用例数**。
  理由（踩过）：抄一次就意味着**每次加红线都得同批改这里**，而漏改的那次就是一句**骗人的假话**（本仓据此把「红线只到 B22」写错过一次）。
  要个数就去 `npm run test` 看那一行 —— **文件数是稳定的，用例数不是**（并发写者会让它在同一轮里就变）
- **CI**：见 [.github/workflows/ci.yml](.github/workflows/ci.yml) 的 `CI Success`（唯一 required check）
- 上面留的是**跑法 + 形状**；任何会漂的值（用例数、红线条数、行号、宿主版本号）一律现查

## 全局规则

- **结论必须来自实测**，不来自文档推断。引用宿主行为时写清是**哪一份真源、什么版本**
  —— 本机「在跑的宿主」与「源码检出」常常不是同一个版本。
- **能落成校验的就不写散文**：不变量做成 `test/` 下的红线或 `scripts/` 下的检查，这里只留指针。
- **诊断半边保持只读**：不改 profile、不写 `$DSH_HOME`、不杀进程。**写侧只做「不杀进程」的那一种**（就地换模块，失败放回旧版本）。**会杀掉宿主的重启类动作不并入写侧** —— 它是**独立的行动类**，靠四道闸 + 审批门 + marker 恢复（形态见 [docs/SHAPE.md](docs/SHAPE.md) §6.1）。任何越界的「顺手修一下」先落决策。**这条规则本身由机器判据守着**（`test/redlines.test.ts` 的 B10：杀进程 / fs 写入 / **写宿主数据路径** / 安装面四类，作用域是整个 `src/**`）；写侧的窄作用域与更严的记号判据是 B15。**唯一的例外**（维护者 2026-10-14 拍板，**精确命名空间 / 形态 A**）：`$DSH_HOME/<包名>/` 这一层可以写 —— **只有紧跟 home 的第一段逐字等于包名**才放过，其余顶层项照旧禁止。清单与四条边界用例见 [docs/SHAPE.md](docs/SHAPE.md) §10.3。
- **一处一事实，别处只留指针**：一个事实有两个落点时，删掉一个。
- **改动连带同步点**：谁引用了你改过的路径 / 名字 / 规则，同批改。双语门面（[README.md](README.md)
  与 [README_zh.md](README_zh.md)）与两份 `locale/*.json` 是典型的成对件。
- **不抄会漂的值**：宿主版本号、计数、行号一律现查；写「形状」，不写「值」。
- **代码注释写中文；可能到达模型/用户眼里的字符串写英文**（工具 `data` 文本字段、`message` /
  `nextStep.why` / render 文本）。只被实现内部 catch、进不了返回值的字符串不受此限
  （例如测试替身自己的中文 Error）。**这条由 `test/redlines.test.ts` 的 B14 守着。**
- **改动走 PR，不直推 `main`**（维护者 2026-10-13 指定）。ruleset 里那条 `RepositoryRole` bypass 让直推
  **技术上能过** —— 但那是逃生门，不是常规路径。流程：开分支 → 推 → `gh pr create` → 等 `CI Success` → 合并。
  本地门禁（`npm run check` / `lint` / `format:check` / `check:release` / 链接校验）照旧在开 PR 前跑完。
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
npm run check          # typecheck + build + test
npm run check:release  # 发布态不变量（scripts/check-release.mjs）
npm run lint           # ESLint
npm run format:check   # 格式
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
- 目录级规则与手册的分工见根 [AGENTS.md](AGENTS.md) 的「上下文注入」那一节；门面与子目录双件**不是**同一套设计，理由同样在里面。

## 待办

- [ ] **`dsh_restart`：工具已落地并注册（2026-10-14），剩「真机闭环」+ 一条可达性实测**。
      形态（四道闸 / 审批门 / marker / 恢复）见 [docs/SHAPE.md](docs/SHAPE.md) §6.1；宿主侧的拉起 / 恢复 / 退出契约见
      [docs/HOST-CONTRACTS.md](docs/HOST-CONTRACTS.md) §2。
      ⚠️ **仍欠两件，都只能在隔离实例上做**：① **`ctx.get('appExit')` 在本插件这一层的可达性未实测**（台账 §2.6 的 E10 仍标 `[无法判定]`）—— 它是退出那一步的前提，**真机闭环前必须钉死**；② 「重启 → 会话被唤醒 → notice 到达发起者」那条闭环没跑。
      ⇒ **验证方式已定：隔离实例上验，不进 CI**（理由同 [test/integration/README.md](test/integration/README.md) §0：要真起服务、要空闲端口、要 junction）；那条真机闭环**只能是本机红线**。
- [x] **客户端半边（`dsh.client` + keyed `tool.call.toolview`）→ 维护者 2026-10-14 拍板：不做**。
      它只影响**人**通道、不影响模型；而代价不小（新构建产物要进 `files` 并过 `check:release`、
      keyed 条目要在 call/result 两侧可重放、加 `dsh.client` **要重启宿主一次**）。
      [docs/SHAPE.md](docs/SHAPE.md) §8.5 / §9.2 的记录保留为「已评估、不做」，**不要再排进队列**。
- [ ] **技能压过用户级同名技能**：已实现（**动态 scope 注入**：技能同时注册进全局层与每个活跃 agent
      的 preset 作用域，与 `skill-filesystem` 同层 → rank 250 才真正赢）。静态写进 preset 组合的方案
      **已实测否决**（坏包会让默认 standard 会话建不起来）。决策见
      [.agents/notes/2026-10-13-skill-registers-twice-dynamic-scope.md](.agents/notes/2026-10-13-skill-registers-twice-dynamic-scope.md)。
      个人副本**已撤**（2026-10-13，`~/.agents/skills/dsh-plugin-debugging/` 从磁盘删除；维护者指定不碰那个仓库，
      故未提交未推送）。代价已写进 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §3 ——
      技能此后**只在装了本插件的 profile 里**可见。
- [ ] **`SkillReport.scoped` 真机不可观测**（`state.skill` 没有对外暴露面，pluginInventory 也不含插件内部状态）
      → v1.1 可考虑让本仓自己的某个工具报出「技能半边注册成了没有、几个 agent」，
      这样「注册了但没生效」这类问题不必靠 winner 反推。
- [ ] **`SKILL.md` 已解冻**（维护者 2026-10-13 拍板）：技能**跟着插件一起演化**，不再逐字冻结在 v2.1.4。
      ① **「干预」一节已落地**（纳入写侧 `hot_reload`、派生 `sign_cookie` 与行动 `restart`）；
      ② **已完成**（2026-10-14）：`SKILL.md` §3.8 首句与 §3.6 提问清单第 2 条、以及
      [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 的工具表都改成了「Fiber 状态**能查、但不在 `Config.listConfigs` 里`**
      —— 插件侧走 `ctx.get('loader')` + `entry.fiber.state`（见活跃坑 19）。
      **同批改这三处是必须的**：原先「没有查询入口」这句假话有三处落点，只改一处就是「一处一事实」被破。
      **红线 B12b 已补**（断言「干预」一节存在且非空）—— 之前不补的话「解冻了却没写」是静默的
      （现有 B12 **不比对 v2.1.4 原件**，只查 frontmatter 合规与正文长度 → 解冻不会让它变红）。
- [x] **非 Windows 的端口识别** —— **已落地**（Windows / Linux / macOS 三平台；Linux 走 `ss` 两档、
      macOS 走 `lsof` → `netstat`；方案表在 `src/lib/ports.ts` 的 `portLookupPlan`，别在文档里抄命令名）。
      **这层能被 CI 真验**（CI 在 ubuntu 上），与「只能本机红线」的项不同。
      ⚠️ 三值互不重叠：`probed:false`（查不了）/ `listening:false`（没人听）/ `listening:true + unidentified`
      （有人在听但读不到 pid）。压成两值就是**反向结论**。
- [ ] **CI 与本地平台不同**：本机是 Windows，CI 是 ubuntu。**任何写死平台行为的断言都会在 CI 上红**
      （首次推送就踩过：`probed === true` 那一条）。新增与平台相关的判据时，
      要么按平台分支断言，要么让两种平台的行为都被钉住。
- [x] **红线批 2b：`B17 / B20a / B20b / B18a / B21 / B24`** —— **六条已全部落地**（2026-10-13 核；
      真源是 `test/redlines.test.ts` 里 `describe('B…')` 的闭集，规则与逐条判据见 [docs/SHAPE.md](docs/SHAPE.md) §10）。
      其中 **`B24`** 是 SHAPE §4 说的「契约的承载条件」（`execute` 全路径不抛）。
      **B17 的取值面是** L1/L2 ∪ 目标工具自己的描述；**空转口清单**见 [docs/SHAPE.md](docs/SHAPE.md) §10.0（不在这里抄条数）。
- [x] **技术债：收敛重复的测试助手** —— **已收敛**（2026-10-13）。`renderText` / `splitRender` /
      `sharedSubstrings` 三条各从 5/5/3 份合成 1 份，`test/tools/helpers.ts` 只增不改既有导出。
      实测净减 **183 行**（此前估的 350–500 与更早的 800–1000 都偏高：这三条助手本体只有 3–18 行，
      大头是各自的注释，而接收方要一次性付掉定义成本）。**用例数前后未变**，即没有丢断言。
      ⚠️ **尚余一处**：`test/redlines.test.ts` 里的 `withPlatformRedline` 与 [test/tools/helpers.ts](test/tools/helpers.ts) 的
      `withPlatform` **语义同构、但不是逐字同构**（2026-10-14 实测三处差异：`fn` 的类型一个是 `() => Promise<T>`、
      另一个是 `() => Promise<T> | T`；拿不到属性描述符时的错误文案一个英文一个中文；一个 `export` 一个不导出）。
      收敛时**按「语义同构」判**，别按逐字比对 —— 逐字比对会得出「要改」，而改哪一份都得先定这三处的取舍。
      且该文件文末「已知限度」第 29 条写着「收敛那笔债时连它一起收」—— 债还了要把那条**删掉**，不是留着。
- [ ] **两条独立复验留下的残余**（都不影响模型决策，方向安全，故未阻塞发布）：
      ① `resolvedDir` 对 `link:` 包报 realpath，偏离宿主的 `packageDirFromAnchor`（只进 `audit`，不进 `key`）；
      ② 凭据存在性扫描对 `records` 段内**更深层**的同名键会判 true（需 `grant` + 同名键同时出现才触发）。

## 活跃坑

**每一条都是踩过的，按「错了会不会静默坏」排序。**

1. **`engines.dsh` 没有任何读取者**。真正的兼容性门是 `peerDependencies`（判定带
   `includePrerelease`）。而且失败是**静默**的：profile 加载路径把兼容性错误 `catch` 进
   `skippedBundles` → 进程照常启动、插件像没装一样消失。**改依赖范围时 peer 与 dev 必须同时改。**
2. **`parseSkillFile` 不是公开 API**。`@deepseek-ai/dsh-skill-filesystem` 的运行时导出只有
   `Config / FileSystemSkillProvider / apply / inject / name`；它的 `package.json` 里 `exports`
   只有 `.` / `./src/*` / `./package.json`，而 `files` 只发 `lib/types/**/*.d.ts`。这个函数是模块
   内部实现，签名还依赖 `ctx.fs` 与真实路径 —— 仓外拿不到。frontmatter 必须自己解析。
3. **`ctx.skills.register()` 不校验 `content`**：运行时校验只看 kebab name、非空 description 与
   invocation。漏字段**当场不报错**，要到渲染 `<skill_content>` 时才是空 —— 所以「正文为空」
   必须由本仓判成失败。
4. **自定义 `SessionEventMap` 成员 + `session.append()` 会写坏会话日志**：写入成功、当次可用，
   但下次加载时持久层会因为遇到「未知且未标 `ignorable` 的事件」而**拒绝解释整份日志**。
   仓外插件该走 `appendPluginRecord()`（`plugin:` 前缀、强制 `ignorable: true`）。
5. **5 个身份件不要动**：`.gitattributes`、`.node-version`、`.github/workflows/release-drafter.yml`、
   `.pre-commit-config.yaml`、`.prettierignore`。它们是 `scaffold check` 的比对对象，
   给 `.prettierignore` 加一行都会报 `DIFF`。要加就是**有意的分歧**，得在此处记一句。
6. **rank 是升序、数值小者胜**；runtime 注册恒为 250 且**无旋钮**。250 压得住 custom(300) 与
   user(400/500)，**压不住** project-dsh(100) / project-agents(200)。且 rank 只在**同一层内**
   比较 —— 最近层的同名条目直接胜出。**被 shadow 是完全静默的**，没有 API 能列出被遮蔽者。
7. **技能不进系统提示词**：模型只先看到目录里的 `name` + `description`。描述写不好 = 插件不存在。
8. **`--dump-config` 的退出码恒 0**，不能当门禁；`--dump-config-schema` 退出码 1 = 有 error。
   已知误报：`preset-*` 行的 `unrecognized Loader tree carrier` —— 判定要看 error 的 `path`
   是否指向你改过的那一行。
9. **`--profile` 不会到达插件**：CLI 自己吃掉了它，`ctx.cmdlineArgs` 里没有；profile 名只能从
   env `DSH_PROFILE` / `DSH_PROFILE_DIR` 读。
10. **npm 12 会拦 postinstall**（本仓曾因此去掉用不到的 `esbuild`）。要装带安装脚本的依赖，
    得先明确 `allowScripts`，否则本机与 CI 的行为会不一致。
11. **`defineTool` 的 `output.schema` 要的是「作者层字面量」**，它自己编译成强制的 `JsonSchemaNode`。
    把已标注 `ValueSchemaSpec` 的对象喂进去 = 把编译前后两层混了，而报错方向是**反的**
    （`Type 'ValueSchemaSpec' is not assignable to 'JsonSchemaNode'`，真因是 `enum` 的
    `readonly string[]` vs 可变数组）。中途想改用两分支 `oneOf` 会让推断出的 `data` 与返回类型对不上，
    `execute` 静默退化成 `Promise<never>`。**取法：schema 用 `{ type: 'json' } as const`，
    结构强制挪到返回前的 `ensureToolResult()` 里做**（绝不抛，形状不对就转 `internal` 失败）。
12. **`cordis.patch.yml` 的 `insert:` 用裸包名时，只有该包能从「被启动 profile 的目录」解析到才挂得上。**
    `--patch` 开发循环下若 profile 里没有这个包：组合树**照样有行、退出码 0**，但运行期
    `dsh-plugin-debugging (dsh-plugin-debugging): failed to import` —— 行在、功能不在。
    台子配方里因此必须多一步 junction（把仓链进 profile 的 `node_modules`），或直接走 `dsh plugin add`。
13. **`patched by <file>` 后面跟的是「改动该行的那一层」，不是插入者。** 本仓 patch 是**插入者**，
    所以它只会以来源头 `# == <本仓 cordis.patch.yml 路径>` 的形态出现。**按「带 patched by 标注」
    去判本插件有没有进树，永远判不过** —— 这个判据本身是错的（我们自己的验收书里犯过一次）。
    另外：`--dump-config` 退出码**恒 0**，能当门禁的只有 `--dump-config-schema` 的退出码。
14. **解析 `dsh` 的 stderr 要认两种形状**，否则组合期错会**整条漏掉**：一种带严重级
    （`dsh: error: …`），一种**不带严重级、只带来源**
    （`dsh: [<file>] patch: name mismatch for "x" (expected …, got …), skipping`）。
    只认前者时，错误明明打印了、你的工具却报成功 —— 本仓 `src/lib/dump.ts` 踩过。
    同理：**不能用 `--dump-config-schema` 的退出码判断「有没有该管的组合期错」**，
    组合期错走的是 `--dump-config`（退出码恒 0）那条路；判定要基于「已筛出的 actionable 列表是否非空」。
15. **`defineTool` 拒绝非正 `timeoutMs`**（实测报 `timeoutMs must be a positive finite number`），
    所以「预算已耗尽」这类用例**不能拿 0 构造**，测试要用注入时钟。
16. **`prettier --write "src/lib/**/*.ts"` 在扁平目录下一个文件都匹配不到**（`**/` 要求至少一层
    子目录），会让人以为「格式已经好了」。要么写 `src/lib/*.ts`，要么直接给目录名。
17. **`**/` 这一族在别处同样咬人**：① 在**块注释里**写 `skills/**/SKILL.md`，其中 `*/` 会
    **提前终止注释**，整文件解析失败（vitest 报 `Tests no tests`，不是语法错的行号）；写
    `skills/<name>/SKILL.md`。② 正则里用 `['"]plugin['"]` 这种「引号紧邻」的写法，只认
    argv 数组形态，`'dsh plugin add …'` 这种**字符串命令**形态会漏 —— 而漏掉的判据看起来是绿的。
18. **判据的「假绿」要自己探**：本仓红线曾有三处确认的假绿（引号形态、fs 写入枚举、
    提取失败静默 `skip`）。**最危险的是 skip** —— GitHub 把 skipped 当 Success，
    所以「文件在但提不出任何名字」必须**判红**，不能当成「尚未实现」而跳过。
19. **「Fiber 级状态没有查询入口」是错的**（`SKILL.md` §3.8 的前半句，已实测证伪）。
    插件侧可以直接观测：`ctx.get('loader')` **无需声明 inject** 就可见、`loader.entries()` 可枚举，
    `entry.fiber.state` 实测 **`2`=active / `3`=apply 失败（还能读到 `fiber._error`）/ `0`=pending**。
    ⚠️ **最凶的一种要单独处理：import 期就失败的 entry，`entry.fiber` 是 `undefined`**
    （宿主自己把它归为 `failed to import`，而 `fiberPhase` 报 `null`）—— 只看 `state===3` 会漏掉它。
    **不要去 `import '@deepseek-ai/dsh-host-plugin-inventory'`**：实测 `ERR_MODULE_NOT_FOUND`
    （插件在 profile 的 `node_modules`，解析不到宿主内层，十条搜索路径都没有）；自己用
    `loader.entries()` 投影几行即可（官方那个函数本体也是这么写的）。
20. **别用「拒绝数组」的 helper 去取 `Symbol.iterator`**：`loader.entries()` 在**同一台机器上两种形状都出现过** ——
    历史上读到的是**数组**；2026-10-13 真机复测（隔离实例、`0.2.1-alpha.2`）读到的是**可迭代对象**
    （`Array.isArray()=false`、`hasIterator=true`、`ctor=""`、188 条 entry）`[已实测：真机实验A]`。
    结论不是「哪一种才对」，而是：**必须按 `Symbol.iterator` 取，不能假定 `.find()` / `.length` 存在** ——
    验证者的第一版探针只当数组用（`.find()`），`entryFound` **永远是 false**（**假阴性**，看着像「没有这个 entry」）。
    坑的反面同样成立：**别用「拒绝数组」的 helper 去取 `Symbol.iterator`** —— 它会把数组判成非法 →
    **每棵树都读出空**，表现得像「宿主没有任何 entry」（本仓 `src/lib/fiber.ts` 第一版踩过）。
    **两种错法都静默**。现行写法在 `src/lib/loader.ts`（直接读 `Symbol.iterator`，两种形状通吃；按检索串现找，不按行号）。
21. **读 `fiber._error` 时不要 `await fiber.await()`**：宿主的启动审计会 await，但**工具调用不能挂在一个
    可能永不 settle 的 fiber 上** —— 那会让「传输层先超时、再转结构化错误」这条纪律失效（工具永不返回）。
    只读已同步可见的字段。本仓用一条 `awaited` 标志的测试钉住这一点。
22. **同一棵树两次读不许给出不同结论**：投影里凡涉及「多行同包」的取值，定序必须写死
    （本仓 `worstOf`：严重级 failed>pending>unknown>disabled>active，同级按 `entryId` tie-break），
    否则「哪一行浮上来」会随遍历顺序漂，看起来像随机故障。
23. **`.gitignore` 里的 `lib/` 必须锚定成 `/lib/`** —— 裸 `lib/` 匹配**任意深度**，于是把
    `src/lib/`（本布局里的**源码**目录，文件数会随改动变）一起忽略了。表现是本机全绿、`git ls-files`
    里却没有它们，**CI 克隆下来直接缺文件**。这个坑来自组织脚手架模板的 `_common/.gitignore`
    （模板里就是裸 `lib/`），任何把源码放在 `src/lib/` 的新仓都会中招。**加了新目录后，
    用 `git status --ignored --porcelain` 看一眼「被忽略的到底有哪些」**，别只看 `git status`。
    （模板已修。）
24. **判据必须写清「在哪个运行上下文里成立」**：`npm pack` 解包目录里 `import` 一个**peer 型**包
    **恒假** —— 实测报 `ERR_MODULE_NOT_FOUND: @deepseek-ai/schemastery`（peers 不在解包目录里）。
    正确判据是「**在 peers 可解析的上下文里** import 成功且无副作用」。
    同一族的问题还有「本机跑绿推不出 CI 跑绿」：**判据的上下文与实际使用的上下文不一致时，
    得到的是假红或假绿**，两种都费人。**写判据时先把「它在什么环境里跑」写出来。**
25. **平台相关的行为要显式钉住平台，不要在用例里按真实平台分支**：本机 Windows、CI ubuntu，
    写死一边就必然在另一边红（首次推送连红两次，都在这上面）。做法是每条用例用
    `withPlatform('win32' | 'linux' | 'darwin')` **显式声明它测哪条分支** —— 这样两条分支
    在**任意机器上都被真跑到**，而不是「非 Windows 那条永不执行」。
    配套的坑：`process.platform` 的伪装**必须在 worker 内改**。
    **用 `NODE_OPTIONS=--import` 在进程启动时改会把打包器一起骗了**（rolldown 按平台选原生绑定，
    报 `@rolldown/binding-wasm32-wasi` 找不到，整套起不来）。可行做法是临时 vitest config 的
    `setupFiles` 指向一个改 `process.platform` 的模块（config 放仓外、别落进仓）。
26. **`agent/created` 是 serial 派发，处理器里不许 `await`**：本仓探针实测 —— 在处理器里
    `await scoped.list(...)` 会让 **`agents.create()` 直接卡住**，而且宿主只留下极少的痕迹
    （日志里只有 `listeners-registered`）。技能注册必须**同步**完成。
27. **写探针/报告时 `JSON.stringify` 活对象（Cordis ctx、registry、agent）会因循环引用抛错** ——
    若 flush 外面套了一层 `try/catch`，**报告会静默停在上一次成功状态**，看起来就像「那个事件
    根本没触发」。本轮探针真踩过：差点据此得出「`agent/created` 收不到」的**反结论**。
    做法：活对象放模块级 map、只序列化抽出来的纯数据；flush 失败**另写一个错误文件**而不是吞掉。
    与第 18 条同族：**最危险的静默失败，是让判据自己看起来通过了。**
28. **往别人的作用域里注册，必须把返回的 disposer 收进自己的 fiber**（本仓真踩过，且**是半坏**的）：
    `SkillRegistry.register` 内部是 `this.layers.effect(this.ctx, …)`，`this.ctx` 是**那个作用域自己的
    ctx** —— 于是动态注册的生命周期只绑在 **agent** 上，**与插件 fiber 无关**。症状极隐蔽：
    **停用插件后，停用前已存在的 agent 仍认为本插件赢，而同一次停用之后新开的会话已退回用户级**
    —— 同一时刻两种结论，看起来像随机故障。正确写法是
    `ctx.effect(function* () { yield scopedRegistry.register(registration) })`：**两条路都能解开**
    （插件卸载调我们 yield 的 disposer；agent 销毁由它自己的作用域解开）。
    一般化：**「在 A 的作用域里注册、由 B 负责撤销」时，注册与撤销必须落在同一条 effect 链上**，
    否则撤销只在不发生事故的路径上成立。
29. **本仓 `.ps1` 里函数参数不许叫 `$Args` / `$Profile`**：它们与 PowerShell **自动变量**撞名，
    传进去的哈希表会被当成参数数组绑定 —— 报错方向还很偏，看起来像调用方传错了。
    （验证者在本仓连踩三次同族坑：`$args` 撞名、`$PROFILE`、以及请求不带 token 的 `/` 得到 401 ——
    最后那条**不是错**，宿主对无 cookie 的 `/` 返回 401 是**有意的鉴权行为**。）
30. **`prettier` 对 `.ps1` 的「假红」与坑 18 方向相反**：`npx prettier --check "test/integration/**"`
    会报 `No parser could be inferred for .ps1`、退出码 2；但本仓自己的门禁**是绿的**
    （`npm run format:check` 即 `prettier --check .` 对 `.ps1` **跳过**）。
    **显式传文件路径**才会踩到，`--check .` 不会。判据要跑**本仓自己的门禁命令**，
    不要自造一条更严格的调用再把它当判据 —— 那会造出「已提交且 CI 一直绿的文件被判红」的假红。
31. **提交时不许 `git add -A`**（Lead 自己踩的）：本轮验证者正在写
    `test/integration/leak-fix.ps1`，Lead 一笔 `git add -A` 把那个**308 行的半成品**卷进了
    一个**文档提交**（`048786d`）里 —— 提交历史于是撒谎（说改文档，实际带进来一个脚本），
    而且提交的很可能是**别人还没写完的中间态**。有并发写者时**只 add 自己的路径**；
    「谁写谁提交」这条纪律的另一半是**提交者不能替别人决定提交边界**。
32. **本仓的 `.ps1` 必须是 UTF-8 *with BOM***：没有 BOM 时 **Windows PowerShell 5.1（系统默认那个）
    会按 GBK 解码**，而本仓脚本的注释是中文 → **直接解析失败**
    （实测报 `Unexpected token '}' in expression or statement.`，看起来像语法错，其实是编码）。
    本仓两个红线脚本一开始都是无 BOM（照抄了先有的那个），实测 `powershell.exe` 下**两个都 PARSE-FAIL**，
    加 BOM 后 PS5.1 与 pwsh 7 **都 PARSE-OK**。
    注意这与第 16/30 条那类「工具默认行为」的坑不同：**prettier 会跳过 `.ps1`，CI 也不会解析它**
    —— 所以这条**本机与 CI 全绿也照不出来**，只有真拿 5.1 跑一次才现形。
33. **本仓被以 `link:` 装进 profile 后，宿主会就地跑 pnpm，往仓里写一份 `pnpm-lock.yaml`** ——
    而本仓的锁文件是 npm 的 `package-lock.json`（单一锁文件原则）。实测：改动 `package.json` 之后
    那份 pnpm 锁被**重新生成**（时间戳紧跟在编辑之后），所以删掉它会再长出来。
    处置：`.gitignore` 里忽略 `/pnpm-lock.yaml`（安装方式的副产物，不是本仓的包管理器选择）。
    **别把它提交进历史** —— 两个锁文件会让人以为本仓用 pnpm，而 CI 走的是 `npm ci`。
34. **「配置会被重读」是真的，但触发者住在 hmr 里** —— 这是本仓最容易被误解的一条机制。
    实测（2026-10-13，**无 hmr** 的隔离实例）：把插件行的 `config.profile` 从 `bench-nohmr` 改成 `bench`，
    **同一进程跨改文件时刻连续 21 个采样点 / 70 秒**，`resolved.profile` **一直是旧值**，且**实例 stderr 全程为空**
    （既没 watcher、也没报错）；**重启后**立刻读到新值。
    对照：**有 hmr** 时走 `pluginManager` 会返回 `applied`、行当场变 `disabled`（task-14）—— 但那是 **manager 主动应用**，
    不是 watcher 的功劳；而 **watch patch 文件的正是 hmr**：`…\dsh-hmr\lib\index.js:718` 的
    `watchConfig(filename, …)` 遍历的就是 patch 文件，且 `watchConfig` 的**唯一出处**是 `dsh-hmr`。
    → 所以 `baseline = hot`（描述 loader 的**能力**：一旦重读就按行重建）与 `downgrade`（补上**触发者**）自洽，
    错的是「重读会自动发生」这个隐含前提。**工具输出必须点明触发者**（`why` 里已写 "nothing watches the patch files"）。
    **正证也补上了**（2026-10-13，挂了 hmr 的实例）：**同一个操作**（改 patch 里的 `config.profile`）**不重启**，
    **3.6 秒后读到新值**（47 个采样点，`mode` 全程 `hot` 不翻）。→ 同一动作、两种结果，**唯一变量是 hmr**。
    补充纠正：**别拿 `ctx.get('hmr')` 当探针** —— 实测在**挂着 hmr** 的实例里它同样是 `undefined`
    （hmr 并不把服务注册成那个名字）。判断 hmr 可用性只有两条真源：**profile 文件**与 **`--dump-config`**
    （本仓工具走的正是这两条）。「读不到 hmr 服务」≠「没挂 hmr」。
35. **观察面纠正：`resolved` 里没有 `timeoutMs`**。`EffectiveConfigBlock` 的字段只有
    `{ dshHome, dshHomeSource, profile, port, portSource }`（`src/tools/shared.ts` 的 `EffectiveConfigBlock`，按类型名现找）。
    想验「改了配置有没有被重读」，可观察的是 **`resolved.profile`**（`dsh_check_effect_mode`），
    或 `resolved.port` / `portSource`（`dsh_check_auth` —— 但它在**错误路径**上不返回 `resolved`，
    所以 `profile` 是这两者里唯一稳定的一项）。**别拿不存在的字段当判据**：
    本轮任务卡就建议过读 `resolved.timeoutMs`，实际不存在，白跑一轮才知道。
36. **共享工作树里别用 `git reset --hard` 同步分支**（Lead 本轮真踩，且**吞掉了别人的在途改动**）：
    Lead 在自己分支上 `git reset --hard origin/main` 同步时，`arch-scout` **正在同一棵工作树里**
    改 `test/redlines.test.ts`（它刚发现 `stripComments` 的行号缺陷并修好）—— 重置把它的改动**静默吞掉**，
    `git status` 随即变空，**看起来像「它没保存」，实际是被覆盖了**（线索是它自己报的「隔离跑 53 / 全量跑 52」计数差）。
    处置：有并发写者时同步分支只用**不改工作区**的方式（`git fetch` + `merge --ff-only`），或先确认没人正在写。
    **「工作区是干净的」不等于「没人正在写」** —— 重置与写入之间有一个窗口，落进去的改动会无声消失。
    与坑 31（`git add -A` 卷进别人半成品）同族：**共享工作树上的破坏性 git 操作，要当成对别人的写来对待。**
37. **「断言症状消失」不等于「断言根因修好」**（`host-verifier` 本轮用**变异测试**自己抓到的**假绿**）：
    `dsh_hot_reload` 的 import 期失败真机红（`kind:internal` + Node 内部错误文案）。修完之后写了三条护栏
    （`kind === 'reload-failed'` / message 含真原因 / hint 含 never touched）—— **把 bug 改回去，三条依然全绿**。
    根因：给缓存写回那条路加了一个「永不抛」的防御性 `try/catch`，于是错误被吞成 `return false`：
    **症状（internal）消失了，但缓存在真机上根本没放回** —— 那是另一种静默坏（下次 import 会重新求值）。
    真正的判据是**「放回成功」**：`hint` 不含 `could not be fully restored`，且真机形状下 `has(url) === true`。
    补上这两条后再变异 → **2 条红**；还原 → 全绿。
    一般化：**当一个修复包含「吞掉异常的兜底」时，凡是以「不再报错」为形式的断言都可能假绿** ——
    要断言**根因造成的事实**（缓存真的回去了），而不是断言**症状消失**。与坑 18 同族。
    做法（可直接抄）：**先写护栏、再把 bug 改回去跑一遍**（变异测试）；若护栏仍绿，说明它没在测根因。
    **本轮第二次用（Lead）**：`evidence` 契约里「失败分支的 `summarize` 会跑」这条，verifier 只给了
    **基于源码的强推断**（它自己标了「没做变异测试」）。把 `summarize?.(result.evidence)` 摘掉复跑 →
    **2 条红**（`oldFiberUntouched=true` 那条 + 契约测试那条），还原 → 全绿。
    **推断不算钉死，变异才算。**
38. **`edit` 工具会剥掉 `.ps1` 的 BOM**：本仓两个真机脚本改完 BOM 就没了（实测：改前 `EF BB BF`，
    改后同一份文件 BOM=False）。同族于坑 32 —— **`prettier` 跳过 `.ps1`、CI 也不解析它**，
    所以「本机全绿 + CI 全绿」照不出来，只有真拿 `powershell.exe`（5.1）parse 一次才现形
    （无 BOM 时实测报 `PARSE-FAIL x14 :: Unexpected token '}'`）。
    处置：用 `[IO.File]::WriteAllText($p, $txt, (New-Object Text.UTF8Encoding($true)))` 写回并复核头三字节。
    **谁再改这两个 `.ps1`，改完必须重补 BOM。**
39. **`tool.parameters` 是编译后的 JSON schema，不是作者写的那个字面量** —— 参数描述的判据**必须点进
    `.properties`**。实测（2026-10-13，本仓当时的五个工具）：`Object.values(tool.parameters)` 拿到的是
    `'object'` **字符串**与 properties 对象本身（rawKeys = `["type","properties","required"]`），
    于是每条 `description` 都是 `undefined` → **合计恒为 0**。当时那条「合计 ≤100」的上界因此
    **恒真**（`0 ≤ 100`）—— **上界已于 2026-10-13 删除（SHAPE §2），现在接住它的正是那两条下界**，
    这反过来证明「下界才是防空转的那一半」。**本仓当时的五个工具测试里曾有四份是这种写法**
    （`hot-reload.test.ts` 是唯一写对的），改前实测 `total = 0`、改后才是真值（88 / 86 / 55）。
    同族于第 11 条（`defineTool` 编译 schema）与第 18 条（假绿）。**取法**：读 `parameters.properties`，
    并配**两条下界** —— 「参数个数 > 0」「每个参数描述非空」「合计 > 0」，否则换个写法照样空转。
    **上界删掉之后，参数描述的质量归人工评审**（SHAPE §10.1 第 4 项：自问「模型看不到会不会填错」）。
40. **测试替身被静默丢弃 ⇒ 判据退回真实世界**（本轮 `task-26` 真踩，且**危害形状是反的**）：
    把 `signatureFetch` 塞进 `depsFor(config, { ... })` 的 **overrides 形参** —— 那个形参的**类型里没有它**，
    而**对象展开不受多余属性检查**约束 ⇒ 替身**被静默丢掉**，探针退回**真的全局 `fetch`**。
    于是那条判据打到了 `127.0.0.1:3080` 上的**活宿主**、真读回了签名 —— **它是靠真机通过的**。
    ⇒ **绿得更有说服力，实际测的不是你的夹具**，而且**测试开始依赖外部世界的状态**（换台机器/宿主没起就红）。
    **取法（照抄）**：① overrides 用**显式对象构造**（`{ ...deps, signatureFetch }`）而不是往窄类型的形参里塞多余字段；
    ② **给替身配调用计数并断言它真被调用过** —— 本仓 B24 的注入组本来就是这么写的（`calls()` 计数）。
    一般化：**「替身没生效」与「替身生效了」在绿的时候长得一样** —— 与第 18/27 条同族。
    ⚠️ **这不是新坑，是本仓第二次踩**：[docs/SHAPE.md](docs/SHAPE.md) §10 里 B24 的那条配套硬要求记着同一个形状
    （「替身被调用次数 = 0 必须判红，不许 skip」—— 那次是 **B24 探针**在 `probe()` 里另造了一份 deps、
    注入被丢掉 ⇒ 六组全「通过」⇒ **差点得出「B24 今天已经是绿的」这个反结论**）。
    ⇒ **两处合起来才是完整判据**：**替身要真的被接上**（构造方式）+ **被调用过**（断言计数）。
    （附带一条**真实证据**：本机 3080 上的宿主确实返回那句 DSH 专有签名 —— 发现工具的判据因此顺带被真机确认过一次。）
