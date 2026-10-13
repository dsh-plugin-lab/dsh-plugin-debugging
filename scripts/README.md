# scripts/ — 发布态检查

- 职责：把「发布态该有什么」落成可执行断言，以及在发版前拦住只改了文档 / 测试 / CI 的提交。
- 两个脚本都是**只读检查**，各自的口径写在文件头：一个断言发布产物的不变量，一个按路径判断「上个 tag 以来有没有触及已发布产物」。
- 跑法都是 `npm run` 脚本或直接 `node` 调用；断言条数、判据细节会漂，以脚本本体的输出为准，本文不抄。
- 「发布态该有什么」的唯一 home 是这里的断言集合；流程、顺序与判例见 [../docs/PUBLISHING.md](../docs/PUBLISHING.md)。
- 变更影响路由：改这里 → 同步 [../docs/PUBLISHING.md](../docs/PUBLISHING.md) 与根 [../AGENTS.md](../AGENTS.md) 的常用命令；改 `package.json` 的打包字段还要同步 [../test/redlines.test.ts](../test/redlines.test.ts) 里与它对照的红线；必跑 `npm run check:release`。
- 使用约束与工作偏好 → 见 [AGENTS.md](AGENTS.md)。
