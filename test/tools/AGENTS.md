# tools/ — 规则层

继承根规则，见 [../../AGENTS.md](../../AGENTS.md)。

括号里的编号指 [../../AGENTS.md](../../AGENTS.md) 的活跃坑。

test/tools/ 特有约束：

- 平台相关的用例用 `withPlatform` **显式声明测哪条分支**，两条分支在任意机器上都被真跑到；按真实平台分支断言则本机与 CI 必有一边红（坑 25）。
- `process.platform` 的伪装必须在 worker 内改：进程启动时改会把打包器一起骗了。config 放仓外、别落进仓。
- 预算耗尽类用例不能拿 `timeoutMs = 0` 构造 —— 工具定义阶段就被拒；用注入时钟（坑 15）。
- 参数描述的判据必须点进 `parameters.properties`。顶层拿到的是编译后的 JSON schema，直接遍历只会得到 `undefined`，让上界恒真（坑 39）。
- 正则里断言命令行形态时，「引号紧邻」只认 argv 数组形态；字符串命令形态会漏，而漏掉的判据看起来是绿的（坑 17）。
- **通用助手以本文件为唯一落点**：`withPlatform` / `stripComments` 等已收敛到 [helpers.ts](helpers.ts)；**别再内联第二份**。内联副本在契约改造期出现过四处（`withPlatformRedline` 就在 `test/redlines.test.ts`），2026-10-15 已收敛、对应债条目删除。
  判据性用法与红线闭集不同：本目录的助手**可以**内联在红线语料里（红线要连注释一起剥，改共享实现会牵动全仓），**但通用形状不许复制第二份**。
- 不写「覆盖了什么 / 怎么跑」，那是 [README.md](README.md) 的职责。
