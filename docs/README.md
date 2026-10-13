# docs/ — 活文档区

- 职责：四份互斥职责的活文档，分工由各自开头「本文负责 / 不负责」那行声明。
- [ARCHITECTURE.md](ARCHITECTURE.md) 答「现在为什么这么设计、代价是什么」。
- [SHAPE.md](SHAPE.md) 答「最终长什么样、接下来怎么改」，含工具归属、契约与红线清单。
- [HOST-CONTRACTS.md](HOST-CONTRACTS.md) 答「宿主实际上是什么样」，调宿主 API 前先查它。
- [PUBLISHING.md](PUBLISHING.md) 答「怎么发」；发布态该有什么由 [../scripts/check-release.mjs](../scripts/check-release.mjs) 的断言集合定义，两者互补不互抄。
- 本目录**不建索引清单**：职责映射就是上面这四条，加一份文档时改这里；决策与依据不在这里，见 [../.agents/notes/](../.agents/notes/)。
- 变更影响路由：改这里的结论 → 同步根 [../AGENTS.md](../AGENTS.md) 的待办与文档地图、以及它指向的实现目录 README；改宿主事实的真源 → 同批更新引用它的那几份。
- 使用约束与工作偏好 → 见 [AGENTS.md](AGENTS.md)。
