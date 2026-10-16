# tools/ — 规则层

继承根规则，见 [../../AGENTS.md](../../AGENTS.md)。

括号里的编号指 [../../AGENTS.md](../../AGENTS.md) 的活跃坑。

tools/ 特有约束：

- 每个工具一个文件，命名 `dsh_*.ts`；注册处是本目录的聚合入口，工具清单以它为准。
- **同一种语义只许有一个实现**：装配、投影、渲染三类助手一律住在 `shared.ts`，工具文件里**不许出现第二份**。三类落点见 [README.md](README.md) 的「共享助手住在哪」。理由：同一件事在多个工具里印出两种说法时，**没有任何判据照得出来**（红线 B25 只断言「兜底可渲染」，不断言措辞与字段顺序）。
- 输出 schema 用作者层字面量（`{ type: 'json' } as const`），结构强制挪到返回前的 `ensureToolResult()`。喂已标注的 schema 对象会把编译前后两层混了，报错方向还是反的（坑 11）。
- 工具**只声明工作量档**（`const WORKLOAD: Workload = 'quick' | 'schemaDump'`），预算一律经 `lib/timeouts.ts` 的 `toolBudgetMs(WORKLOAD, deps.config)` 取。**工具里不许出现毫秒字面量，也不许直接读配置的预算字段** —— 判据是 `test/tools/timeout-budgets.test.ts`（它扫描本目录的源码，不靠跑一遍）。
- `timeoutMs`（`defineTool` 声明）必须为正有限值，非正会被直接拒（坑 15）—— 所以走 `toolBudgetMs` 而不是自己算。
- 每个 `execute` 绝不 throw：预期内失败收敛成 `kind` 为闭枚举的结构化失败，由 `kind` 决定模型该不该重试。
- `exec.signal` 必须透传给底层 fetch / spawn，不许中途吞掉取消。
- 描述是四段骨架（做什么 / 什么时候用我 / 边界 / 代价），段序不许换；行动类与派生类必须写代价段。
- 只读纪律：不改 profile、不写 `$DSH_HOME`、不杀进程；进程与端口一律按端口查，不用命令行子串。**这三条由机器判据守着**（[../../test/redlines.test.ts](../../test/redlines.test.ts) 的 B10：杀进程 / fs 写入 / 写宿主数据路径 / 安装面；写侧另见 B15）。**唯一例外**：`$DSH_HOME/<包名>/` 这一层可以写（该层以下随便分）—— 规则不在这里重述，判据才是真源。
- 不写「有什么文件 / 怎么改」，那是 [README.md](README.md) 的职责。
