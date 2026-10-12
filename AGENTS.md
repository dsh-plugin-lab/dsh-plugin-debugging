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
- [ ] 技能注册的运行时判据：在隔离实例上证明「本插件的 250 压过用户级 500、让位于项目级 100/200」

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
