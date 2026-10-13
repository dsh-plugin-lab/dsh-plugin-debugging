# test/tools/ — 工具半边的覆盖

- 职责：工具实现与共享契约的自动化判据，含参数 schema、渲染文本、错误契约与平台分支。
- 覆盖映射按「一个测试文件对一个实现或一条契约」组织；**清单以本目录文件名为准**，本文不复制。
- 共用夹具在本目录：临时目录造假 `DSH_HOME`、注入假 spawn / fetch，不 mock 类。改夹具影响本目录全部用例 —— 根 [AGENTS.md](../../AGENTS.md) 待办里有重复助手的收敛计划，动之前先看那条。
- 平台分支的护栏在本目录单独成文件，是本机 Windows 与 CI ubuntu 差异的唯一拦截点。
- 变更影响路由：改 [../../src/tools/](../../src/tools/README.md) 或 [../../src/lib/](../../src/lib/README.md) → 同步本目录的覆盖映射与根 [AGENTS.md](../../AGENTS.md) 待办；契约变更还要同步 [../../docs/SHAPE.md](../../docs/SHAPE.md) 的红线清单；必跑 `npm test`。
- 使用约束与工作偏好 → 见 [AGENTS.md](AGENTS.md)。
