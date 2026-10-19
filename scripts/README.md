# scripts/ — 发布态检查与兼容巡检

- 职责：把「发布态该有什么」落成可执行断言，以及在发版前拦住只改了文档 / 测试 / CI 的提交；另有一组**兼容巡检**脚本（见下）。
- `check-release.mjs` / `release-guard.mjs` 都是**只读检查**，各自的口径写在文件头：一个断言发布产物的不变量，一个按路径判断「上个 tag 以来有没有触及已发布产物」。
- 跑法都是 `pnpm run` 脚本或直接 `node` 调用；断言条数、判据细节会漂，以脚本本体的输出为准，本文不抄。
- 「发布态该有什么」的唯一 home 是这里的断言集合；流程、顺序与判例见 [../docs/PUBLISHING.md](../docs/PUBLISHING.md)。
- 变更影响路由：改这里 → 同步 [../docs/PUBLISHING.md](../docs/PUBLISHING.md) 与根 [../AGENTS.md](../AGENTS.md) 的常用命令；改 `package.json` 的打包字段还要同步 [../test/redlines.test.ts](../test/redlines.test.ts) 里与它对照的红线；必跑 `pnpm run check:release`。
- 使用约束与工作偏好 → 见 [AGENTS.md](AGENTS.md)。

## 兼容巡检三件套（与姊妹仓同一套判据）

由 [.github/workflows/compat.yml](../.github/workflows/compat.yml) 每周驱动，只在 schedule / dispatch 跑（看的是**上游**动没动，不是这次提交）：

- `check-declaration.mjs` —— 只读 `package.json` + 问 npm：声明的区间还罩不罩得住 README 指给用户的那条线（`--line` 可换线判）。不装依赖，几十秒出结果。
- `compat-swap.mjs` —— 真的换线、真的装、回头核对**实际装到了哪个版本**（`verify` 不是陪衬：安装会假绿）。收窄成单族靠 `--only`，测完不提交。
- `report-compat-failure.mjs` —— 承诺线红了就开 / 更新一条固定标题的跟踪 issue（幂等，不每周刷一条）。

口径与「红了怎么办」的唯一 home 是 [../docs/PUBLISHING.md](../docs/PUBLISHING.md) 的「兼容性」，这里只留指针。
