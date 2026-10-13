# skills/ — 规则层

继承根规则，见 [../../AGENTS.md](../../AGENTS.md)。

括号里的编号指 [../../AGENTS.md](../../AGENTS.md) 的活跃坑。

skills/ 特有约束：

- 三个点必须 fail-closed，宿主都不校验：缺文件、`name` / `description` 不合法、正文为空（坑 3）。
- 宿主不导出 frontmatter 解析函数，它是模块内部实现且签名依赖宿主上下文 → 自己解析（坑 2）。
- frontmatter 的 `description` 必须是**单行标量**。块标量要响亮失败，不能把 `>-` 当描述注册进去：技能不进系统提示词，描述写坏等于插件不存在且不报错。
- 往别人的作用域注册时，注册与撤销必须落在**同一条 effect 链**上 —— 把返回的 disposer 收进自己的 fiber，否则撤销只在不发生事故的路径上成立（坑 28）。
- `agent/created` 是 serial 派发，处理器里**不许 `await`**；在这里 await 会让建 agent 直接卡住（坑 26）。
- 技能根按产物位置推断，上溯两级到包根；算错一级不会崩，只会静默报缺文件。
- 不 import 工具半边、不碰 `ctx.tools`；不写「有什么文件 / 怎么改」，那是 [README.md](README.md) 的职责。
