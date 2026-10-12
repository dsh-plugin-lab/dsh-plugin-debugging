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

## 常用命令

```shell
npm run check          # typecheck + build + test
npm run check:release  # 发布态不变量（scripts/check-release.mjs）
npm run lint           # ESLint
npm run format:check   # 格式
```

```shell
# 身份件比对：只比 5 个「逐字相同」件，离线只读，随时可跑
node ../.github-dsh-plugin-lab/scripts/scaffold.mjs check .

# 链接校验与换行校验
python ../.github-dsh-plugin-lab/scripts/check-links.py . --fragments --refs
git diff --check
```

## 文档地图

- 对外说明 → [README.md](README.md)（English）· [README_zh.md](README_zh.md)（中文）
- 设计说明（**为什么这样分层**）→ [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 发布流程与判例 → [docs/PUBLISHING.md](docs/PUBLISHING.md)
- 决策与依据 → [.agents/notes/](.agents/notes/)
- 展示元数据 → `locale/en.json` · `locale/zh.json`（只住这里，别处只留指针）

## 待办

- [ ] v1.1：`dsh_hot_reload`（前置门：profile 里真的挂了 `hmr`）与 `dsh_restart`
      （先 dry-run；`danger-full-access` 档下 `ask` 会被确定性拒绝，语义要先定）
- [ ] **技能压过用户级同名技能**：S2 实测已推翻「250 天然赢」的旧说法（用户级技能在 **preset 层**、
      更近，跨层直接遮蔽全局层的 runtime 注册）。当前方向：按官方机制把本插件行挂进 preset 层
      （override `preset-standard`），**先做实验证实再改 `cordis.patch.yml`**。
- [ ] `SKILL.md` §3.8 的「Fiber 级状态没有查询入口」已被证伪（见活跃坑 19）；正文是逐字复制的
      v2.1.4 本体，**修正与否待用户拍板**。

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
