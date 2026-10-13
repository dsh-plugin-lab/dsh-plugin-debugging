# lib/ — 规则层

继承根规则，见 [../../AGENTS.md](../../AGENTS.md)。

括号里的编号指 [../../AGENTS.md](../../AGENTS.md) 的活跃坑。

lib/ 特有约束：

- 本层是宿主内部结构与 IO 的唯一入口，每个字段读取都必须容错：宿主换版本时表现为降级，不是抛异常。
- 取 loader 树一律按 `Symbol.iterator` 迭代。用「拒绝数组」的 helper 取迭代器、或假定 `.find()` / `.length` 存在，两种都会每棵树读出空或永远读不到目标，且都静默（坑 20）。
- 不 `await` fiber：只读已同步可见的字段。挂在一个可能永不 settle 的 fiber 上会让传输层超时纪律失效（坑 21）。
- import 期就失败的 entry，其 `fiber` 是 `undefined`，不是某个 state 值；只看 `state` 会漏掉它（坑 19）。
- 同一棵树两次读不许给出不同结论：凡涉及多行同包的取值，定序必须写死并有 tie-break（坑 22）。
- 格式化本层用 `src/lib/*.ts` 或直接给目录名；`src/lib/**/*.ts` 在扁平目录下匹配不到任何文件（坑 16）。
- 不写「有什么文件 / 怎么改」，那是 [README.md](README.md) 的职责。
