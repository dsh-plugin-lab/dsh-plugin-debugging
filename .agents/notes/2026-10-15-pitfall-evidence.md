# 活跃坑的完整证据与复现

状态：已归档 —— 它记的是「当时为什么」，**不追改**；规则本身以根 [AGENTS.md](../../AGENTS.md) 的「活跃坑」为准。

**这是什么**：2026-10-15 从根 AGENTS.md 搬出的**原文**（40 条，逐字未改，含规则句）。
根 AGENTS.md 是**每个会话都注入**的规则层，而每条坑当时都把实测数据、复现步骤、被否掉的方案写在同一条里 ——
那是「当时为什么」。搬出后根文件每条只留**一行规则**，证据在这里，**编号 1–40 一一对应**。
⚠️ 根文件后来新增了**坑 41**（`DSH_PROFILE` 的成因与后果，2026-10-15 真机缺陷）——
本文已归档不追改，坑 41 的证据指针**就地挂在根文件那一格**（指向 desktop-carrier-decision 篇）。

**为什么值得搬**：那 40 条约 230 行，占根文件的一半以上；而一个会话真正需要的是「别做什么」，
不是「上次是怎么测出来的」。证据留在仓里、可查、不注入。

---
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
   —— **已记的分歧（迁 pnpm，两个文件）**：`.pre-commit-config.yaml` 把钩子从 `npx --no-install`
   换成 `pnpm exec`（并加 `--config.verify-deps-before-run=false` —— 不加的话 pnpm 每次跑钩子都会
   先隐式校验依赖树、等于偷偷装一次东西）；`.prettierignore` 与它的钩子 `exclude` 从
   `package-lock.json` 换成 `pnpm-lock.yaml`。⇒ **`scaffold check` 会在这两个文件上报 `DIFF`，
   这是预期的**；另有意的分歧要照这里追加一句，别让 `DIFF` 变成「说不清哪来的」。
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
30. **`prettier` 对 `.ps1` 的「假红」与坑 18 方向相反**：`pnpm exec prettier --check "test/integration/**"`
    会报 `No parser could be inferred for .ps1`、退出码 2；但本仓自己的门禁**是绿的**
    （`pnpm run format:check` 即 `prettier --check .` 对 `.ps1` **跳过**）。
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
    实测：改动 `package.json` 后那份锁会被重新生成，删掉它会再长出来。**这条的处置方向随包管理器翻转，
    而文件名不变**：本仓用 npm 时它是**安装方式的副产物**（`.gitignore` 忽略 `/pnpm-lock.yaml` 才对，
    两个锁文件会让人以为本仓用 pnpm）；**本仓自己改用 pnpm 之后，同一份文件就是唯一的锁文件**，
    必须进版本控制、由 CI 以 `--frozen-lockfile` 消费。
    ⇒ 换包管理器时 `.gitignore`、两个 workflow、`.prettierignore`、`.pre-commit-config.yaml`、
    `scripts/release-guard.mjs` 的非产物清单**必须同批翻**。**漏掉 `.gitignore` 最凶**：锁文件被本地忽略、
    本机全绿，CI 克隆下来却没有它（同族于第 23 条，用 `git status --ignored --porcelain` 照）。
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
    ⚠️ **这不是新坑，是本仓第二次踩**：[docs/SHAPE.md](../../docs/SHAPE.md) §10 里 B24 的那条配套硬要求记着同一个形状
    （「替身被调用次数 = 0 必须判红，不许 skip」—— 那次是 **B24 探针**在 `probe()` 里另造了一份 deps、
    注入被丢掉 ⇒ 六组全「通过」⇒ **差点得出「B24 今天已经是绿的」这个反结论**）。
    ⇒ **两处合起来才是完整判据**：**替身要真的被接上**（构造方式）+ **被调用过**（断言计数）。
    （附带一条**真实证据**：本机 3080 上的宿主确实返回那句 DSH 专有签名 —— 发现工具的判据因此顺带被真机确认过一次。）
