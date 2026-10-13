# src/ — 规则层

继承根规则，见 [../AGENTS.md](../AGENTS.md)。

src/ 特有约束：

- `index.ts` 是本仓**唯一**接触 Cordis 的地方（生命周期、配置校验、注册点都落在那里）；业务逻辑留在它之外，才能用普通对象直接单测。
- 模块顶层不许持有可变状态；状态、监听器、定时器一律建在 `ctx.effect()` / `ctx.on()` 内并由返回的 disposer 释放，否则热重载后会留下两代插件共用一份状态的幽灵故障。
- `inject` 只列硬依赖。可选服务（技能服务、活跃 agent 表）走 `ctx.get()` 容错取；写进 `inject` 会让缺该服务的宿主把整插件挂成静默 PENDING。
- 少了 `import type {} from '...'` 这类类型导入声明，对应的 `ctx.*` 在类型上不存在。
- 两个半边互不越界：工具半边不碰 `ctx.skills`，技能半边不碰 `ctx.tools`，共享面只有 `contracts.ts` 里的类型。
- 代码注释写中文；可能到达模型或用户眼里的字符串写英文（成因见 [../AGENTS.md](../AGENTS.md) 全局规则）。
- 不写「有什么文件 / 怎么改」，那是 [README.md](README.md) 的职责。
