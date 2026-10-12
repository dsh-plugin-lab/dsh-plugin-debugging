# dsh-plugin-debugging — 维护索引

本文件只服务「在这个仓里怎么干活」。它不回退到别处，也不引用仓外路径。

## 状态

- 版本以 [package.json](package.json) 的 `version` 为准
- 尚未发布
- **v1 能力面 = 1 个技能 + 4 个只读工具**；重启与热重载助手**有意推迟到 v1.1**

## 全局规则

- **结论必须来自实测**，不来自文档推断。引用宿主行为时写清是**哪一份真源、什么版本**
  —— 本机「在跑的宿主」与「源码检出」常常不是同一个版本。
- **能落成校验的就不写散文**：不变量做成 `test/` 下的红线或 `scripts/` 下的检查，这里只留指针。
- **v1 保持只读**：不改 profile、不写 `$DSH_HOME`、不杀进程。任何越界的「顺手修一下」先落决策。
- **一处一事实，别处只留指针**：一个事实有两个落点时，删掉一个。
- **改动连带同步点**：谁引用了你改过的路径 / 名字 / 规则，同批改。双语门面（[README.md](README.md)
  与 [README_zh.md](README_zh.md)）与两份 `locale/*.json` 是典型的成对件。
- **不抄会漂的值**：宿主版本号、计数、行号一律现查；写「形状」，不写「值」。
- **门面的语言切换行与姊妹仓写法一致**（放在居中 div 里的 HTML `<a href>`）。**这曾经是有意的分歧**：
  本仓原先用 Markdown 链接行（`English | 中文` 那种写法）以换取链接校验 **0 警告**，代价是那一行不居中；
  维护者 2026-10-13 要求门面与姊妹仓视觉一致，于是改回 HTML 形。**代价如实记下**：链接校验会把
  HTML 锚点报成「引用未做成链接」，即本仓现在**稳定有那两条警告**（错误数仍为 0）。
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
# （脚手架在**组织仓**，不在本仓；下面这条绝对路径是它的本机检出位置）
node "D:\.github-dsh-plugin-lab\scripts\scaffold.mjs" check .

# 链接校验与换行校验
# （check-links.py 住**枢纽仓**的 scripts/，不在本仓；它同时是那边 CI 用的那一份）
python "..\scripts\check-links.py" . --fragments --refs
git diff --check
```

## 文档地图

- 对外说明 → [README.md](README.md)（English）· [README_zh.md](README_zh.md)（中文）
- 设计说明（**为什么这样分层**）→ [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 发布流程与判例 → [docs/PUBLISHING.md](docs/PUBLISHING.md)
- 决策与依据 → [.agents/notes/](.agents/notes/)
- 展示元数据 → `locale/en.json` · `locale/zh.json`（只住这里，别处只留指针）
- 真机红线（**本机跑，不进 CI**）→ [test/integration/README.md](test/integration/README.md)
- 发布态不变量 → [scripts/check-release.mjs](scripts/check-release.mjs)

## 待办

- [ ] v1.1：`dsh_hot_reload`（前置门：profile 里真的挂了 `hmr`）与 `dsh_restart`
      （先 dry-run；`danger-full-access` 档下 `ask` 会被确定性拒绝，语义要先定）
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
- [ ] `SKILL.md` §3.8 的「Fiber 级状态没有查询入口」已被证伪（见活跃坑 19）；正文是逐字复制的
      v2.1.4 本体，**修正与否待用户拍板**。
- [ ] **非 Windows 的端口识别**（v1 只在 Windows 上查监听端口，见 `src/lib/ports.ts` 的早返回）。
      实现方向：Linux 用 `ss -ltnp`、macOS 用 `lsof -i`。
      **注意这事有个便宜可占**：CI 就在 ubuntu 上跑，所以这层**能被 CI 真正验证** ——
      与「只能本机红线」的那几项不同。做完要把 README 的「平台支持」一节同批改。
- [ ] **CI 与本地平台不同**：本机是 Windows，CI 是 ubuntu。**任何写死平台行为的断言都会在 CI 上红**
      （首次推送就踩过：`probed === true` 那一条）。新增与平台相关的判据时，
      要么按平台分支断言，要么让两种平台的行为都被钉住。

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
20. **别用「拒绝数组」的 helper 去取 `Symbol.iterator`**：`loader.entries()` 返回的**就是数组**，
    这类 helper 会把数组判成非法 → **每棵树都读出空**，表现得像「宿主没有任何 entry」。
    这是最坏形态的静默错（结论完全错、却不报错）。本仓 `src/lib/fiber.ts` 第一版踩过。
21. **读 `fiber._error` 时不要 `await fiber.await()`**：宿主的启动审计会 await，但**工具调用不能挂在一个
    可能永不 settle 的 fiber 上** —— 那会让「传输层先超时、再转结构化错误」这条纪律失效（工具永不返回）。
    只读已同步可见的字段。本仓用一条 `awaited` 标志的测试钉住这一点。
22. **同一棵树两次读不许给出不同结论**：投影里凡涉及「多行同包」的取值，定序必须写死
    （本仓 `worstOf`：严重级 failed>pending>unknown>disabled>active，同级按 `entryId` tie-break），
    否则「哪一行浮上来」会随遍历顺序漂，看起来像随机故障。
23. **`.gitignore` 里的 `lib/` 必须锚定成 `/lib/`** —— 裸 `lib/` 匹配**任意深度**，于是把
    `src/lib/`（本布局里的**源码**目录，12 个文件）一起忽略了。表现是本机全绿、`git ls-files`
    里却没有它们，**CI 克隆下来直接缺文件**。这个坑来自组织脚手架模板的 `_common/.gitignore`
    （模板里就是裸 `lib/`），任何把源码放在 `src/lib/` 的新仓都会中招。**加了新目录后，
    用 `git status --ignored --porcelain` 看一眼「被忽略的到底有哪些」**，别只看 `git status`。
    （模板已修：组织仓 `490e752`。）
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
