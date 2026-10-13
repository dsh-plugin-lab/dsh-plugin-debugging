# tools/ — 规则层

继承根规则，见 [../../AGENTS.md](../../AGENTS.md)。

括号里的编号指 [../../AGENTS.md](../../AGENTS.md) 的活跃坑。

tools/ 特有约束：

- 每个工具一个文件，命名 `dsh_*.ts`；注册处是本目录的聚合入口，工具清单以它为准。
- 输出 schema 用作者层字面量（`{ type: 'json' } as const`），结构强制挪到返回前的 `ensureToolResult()`。喂已标注的 schema 对象会把编译前后两层混了，报错方向还是反的（坑 11）。
- 工具声明的 `timeoutMs` 必须为正有限值，非正会被 `defineTool` 直接拒（坑 15）。
- 每个 `execute` 绝不 throw：预期内失败收敛成 `kind` 为闭枚举的结构化失败，由 `kind` 决定模型该不该重试。
- `exec.signal` 必须透传给底层 fetch / spawn，不许中途吞掉取消。
- 描述是四段骨架（做什么 / 什么时候用我 / 边界 / 代价），段序不许换；行动类与派生类必须写代价段。
- 只读纪律：不改 profile、不写 `$DSH_HOME`、不杀进程；进程与端口一律按端口查，不用命令行子串。
- 不写「有什么文件 / 怎么改」，那是 [README.md](README.md) 的职责。
