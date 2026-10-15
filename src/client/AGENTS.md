# client/ — 规则层

继承根规则，见 [../../AGENTS.md](../../AGENTS.md)；`src/` 的规则同样适用，见 [../AGENTS.md](../AGENTS.md)。

括号里的编号指 [../../AGENTS.md](../../AGENTS.md) 的活跃坑。

本目录特有约束：

- **注释写中文；界面文案中英双语（跟随界面语言切换）** —— 维护者 2026-10-15 拍板。
  落在 [locales.ts](locales.ts) 的字符串是**给人看的界面文案**，注册走 **typed 形态**
  （`register(ns, dicts)`）：`LOCALE_IDS` 恰好是 `zh` 与 `en` 两项，⇒ **漏译是编译错误**，不会静默。
  ⚠️ 这**不等于**「中文能进 `src/**`」：B14 排除的只是**本目录**（界面文案到不了模型）；
  工具的 `data` 文本字段 / `message` / `nextStep.why` / render 文本**仍必须英文**，那条判据在别处照样判红。
- **注释里不许出现 `**/`**（坑 17）：它在块注释里会提前终止注释，整文件解析失败，
  而报错不是语法错的那一行。用「A 目录下的 B 文件」写，不要写 glob。
- 禁止运行时 import 其他插件的值：跨插件只走 Cordis 服务，DSH 的 bundle-purity gate 会拒绝值导入。
- 只允许 `import type`（DSH 类型）与**外壳预置模块**的值导入。预置清单以 DSH
  `packages/client/web/src/platform.ts` 的 `PLATFORM_MODULES` 为准 —— 由 seed 表解析，
  不需要依赖边。**不要在此抄一份**：原抄件漏了 `react-dom/client` 且混用简写。
- 落在 `PLATFORM_MODULES` 之外的值导入必须同时写进 `dsh.client.inject` 与 `dsh.client.external`，
  否则工厂不会先到。
- 只为一个类型引入新的 `peerDependencies` 不划算：客户端装配包用**结构类型**在本目录就地收窄，
  写法见 [index.tsx](index.tsx) 的 `ConfigFormFace` / `ConfigFormsFace`。**槽声明是例外** ——
  槽名由提供方合并进共享的 `SlotMap`，结构类型复制不出来，只能 `import type {} from '<包>/client'`
  并保留那条边：现在它是 `dsh-client-ui-plugin-manager`（`plugins.bundle.config`，**只声明槽**）。
  **本目录刻意不欠 `dsh-client-ui-settings` 任何类型边** —— 表单是从 `ctx.configForms` 取的服务，
  形状在这里以结构类型就地收窄。
- **`inject` 必须对齐真实的访问方式**：Cordis 的判据是「服务名**逐字**出现在某个 fiber 的 `inject`
  里」。**反过来同样致命：声明一个已删的服务会让整个 `apply` 不执行** —— inject 是**激活门禁**，
  不是降级开关，用户看到的只是「插件 pending」，没有任何报错。
- **新版才有的 / 可选的服务走嵌套 `ctx.inject`，不写进模块级 `inject`**：`configForms` 是这样。
  写进模块级会让更早宿主上的整个客户端半体 pending（连字典注册都轮不上）；嵌套的代价只是
  「卡片不注册」这一件事，而且那次缺席**可观测**（探测的那条 WARN 正是报它）。
- **只碰一个布尔、绝不碰任何 secret 字段**：本仓 `dsh_sign_cookie` 是唯一经手密钥的工具。
  `form.mutate` 写下的每一个字段都落在**活动 profile 的 Cordis patch**，那是明文可读的 ——
  界面里出现凭据输入框就是本仓那条「诊断半边保持只读」的破口。
- **字段名不由本目录决定**：`enableRestart` 是它与宿主侧那条线（[../config.ts](../config.ts)）
  的唯一耦合点。改它要两边同批改，否则卡片渲染的是宿主不认的那一格 —— 而**界面上看不出差别**
  （宿主照原样接受写入，只是工具永远读不到）。
- 样式只用 `--dsw-alias-*` 语义令牌，不写字面色值、不引外部 UI 库；**没有** `--dsw-color-*` 系列，
  写了不会报错但不会生效。
- **错误色用 `--dsw-alias-state-error-primary`**：原生表单 CSS 写的 `--dsw-alias-label-error`
  在 `ui-theme` 里**从未定义**，照抄原生会静默不着色（坑 18 那一族：判据绿着，功能不在）。
- 注册必须走 `ctx.slots.inject(name, () => ctx.slots.register(...))`，禁止模块级副作用；
  模块顶层不得持有可变状态，状态、监听器、定时器一律建在 `ctx.effect()` 内并由返回的 disposer 释放。
- 能力探测只**新增提示路径**：槽名 / key / 注册时机一字不改，不查版本号，不因探测失败改动任何既有
  功能；提示英文、WARN 前缀、落客户端控制台，**迟到必须撤销**（补一条 INFO）。
  它盯的是「卡片拿不到 `form」**这一个真实故障**，而这条链有**两环**（服务 `configForms`、
  槽 `plugins.bundle.config`），各自缺席都不报错、界面静默缺席 —— 两环**各给一个超时窗口**，
  各报实际断掉的那一环、各撤各的提示；服务缺席时槽那一环**不发声**。
  **探测不能只盯槽名**：该槽在两版宿主上**都不传 `form`**（座位始终只有 `view` 与 `entryKey`），
  所以「槽在不在」与「拿不拿得到表单」**结构性地**无关 —— 只换槽名的探测必然说谎。
  真正会断的那一环是**服务缺席**。
- **提示里点名的槽必须是实际注册的那一个**：探测说要装 A、卡片装进 B，是最坏的一种「说谎」。
- 改完必须重新 build；产物格式由仓根 [scripts/build-client.mjs](../../scripts/build-client.mjs) 负责，不得手改 `lib/client.js`。
- 不写「有什么文件 / 怎么改」，那是 [README.md](README.md) 的职责。