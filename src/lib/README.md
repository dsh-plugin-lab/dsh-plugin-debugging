# lib/ — 纯函数与 IO 层

- 职责：宿主侧算法与 IO。**不 import Cordis** —— 真实宿主对象只在端口工厂处以结构化方式绑上，算法因此能脱离宿主直接单测。
- 内部分两类，职责互斥：纯投影（输入一个已读出的形状，输出一档判定，零 IO）与 IO（读文件、跑子进程、发请求）。分开的理由见 [../README.md](../README.md)。
- 注入点只有三个：子进程、HTTP、loader 树。文件系统**不注入** —— 单测用临时目录造假 `DSH_HOME` 比 mock 类更能照出路径拼接的错。
- 跨模块契约集中在本层的错误契约与渲染两处；本层是扁平目录、没有索引文件，其余职责按文件名自明，改前先读该文件头。
- 读到的宿主字段形状是**内部 primitive、不是公开契约**：真源与核验方式见 [../../docs/HOST-CONTRACTS.md](../../docs/HOST-CONTRACTS.md)，调宿主 API 前先查它，不要凭推断。
- 变更影响路由：改这里 → 同步 [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) 的分层理由；若引用了宿主行为，同步 [../../docs/HOST-CONTRACTS.md](../../docs/HOST-CONTRACTS.md) 的真源；必跑 `pnpm run test`。
- 使用约束与工作偏好 → 见 [AGENTS.md](AGENTS.md)；根规则见 [../../AGENTS.md](../../AGENTS.md)。
