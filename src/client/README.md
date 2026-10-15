# client/ — 浏览器半体

- 职责：在侧边栏「插件（Plugins）」→「已安装（Installed）」组 → **点本插件进它的详情页**时，
  渲染内联在描述与「包含的组件」之间的配置卡片（槽 `plugins.bundle.config`，`key` 是**包名**；
  没有多一次 Configure）。**卡片只承载一个布尔** —— `dsh_restart` 的总闸
  （宿主侧 `Config.enableRestart`，默认关）。本仓另外五个配置项由宿主自己的配置面负责，
  **不在这里渲染**：它们的字段名与取舍不由本目录决定。
- 文件索引：[index.tsx](index.tsx) 卡片本体与注册；[locales.ts](locales.ts) 中英字典，
  并导出 `LOCALE_NS`、`RestartToggleLocaleKey` 与 `LocaleNamespaceMap` 增强声明
  （key 拼错或漏一种语言即编译错误）。
- 关键导出：`apply`（注册字典与卡片）、`inject`（`['slots', 'locale']`）。
- 卡片怎么拿到配置面：**自己取**。`plugins.bundle.config` 的座位里**没有** `form`，
  所以卡片在嵌套的 `ctx.inject(['configForms'])` 里调 `ctx.configForms.get(ENTRY_ID)`，
  `ENTRY_ID` = bundle patch 那条 insert 的 `id`（loader entry id，也是设置命名空间）。
  **槽 key（包名）与这个 entry id 是两个不同的东西**，今天恰好同串。
- 卡片**自己订阅**表单快照（`getSnapshot` + `subscribe`，走 `useSyncExternalStore`）：
  没有页面重渲染这条路可等。命名空间不在册（`status === 'unavailable'`）或宿主不可写时
  按「不可写」渲染，沿用既有只读文案，不新增可见状态。
- 写入是一次**原子** `mutate`，显式写 `false` 而不是 unset：默认已经是 false，
  写 false 让用户层保持「有这条决定」，界面与盘上的配置不会分道扬镳。
- 能力探测：这条链有**两环**（服务 `configForms`、槽 `plugins.bundle.config`），各自缺席都不报错、
  界面静默缺席 —— 两环**各给一个超时窗口**，到点仍在缺席的那一环往**客户端控制台**写一条英文 WARN；
  那一环迟到则补一条 INFO 撤销它自己那条。只加提示路径，注册的槽名 / key / 时机一字不改。
  **服务缺席时槽那一环不发声**（一次超时只发一条，报的是真正断掉的那一环）。
- 被谁依赖：DSH Web 的客户端模块系统按包清单的 `dsh.client` 扫描并加载 `lib/client.js`。
- 改后必测：`pnpm run check` 的类型检查（客户端半体走的是仓根 [tsconfig.client.json](../../tsconfig.client.json)
  这一份配置，不在主 `tsconfig.json` 的 `include` 里 —— 那份把 `src/client` 排除掉了），
  以及 `pnpm run lint` / `pnpm run format:check` / `pnpm run check:release`。

## 视觉与结构

对齐官方配置表单（DSH `packages/client/ui-primitives/src/settings-form/` 的 `SettingsForm` + `fields`）：

- 不可折叠、没有标题、**没有外框**：标题与面包屑由插件页自己画，一列控件直接落在插件页的
  `data-plugin-config` 区里（无 border / 圆角 / 底色 / 内边距）。
- 一行开关：标签在左、官方 `Switch` 在右，行布局抄官方 `SubagentModelSelectionCard.module.css`
  的 `.toggleRow` / `.toggleLabel`，外观因此与官方卡片同款；其下两行说明：
  一行**状态行**（随开关换文案，同官方写法，让用户不必从开关位置反推它做了什么），
  两行**说明行**（分别说「改值不用重启」与「第一次装上这个设置页要重启一次」）。
- 底部：失败诊断（`role=status`，占满剩余宽度）+ **单一保存按钮**（无分割线、左对齐）；
  disabled = 无改动 / 不可写 / 保存中。草稿随卸载丢弃，因此没有「放弃」控件。
- 取值逐条对齐官方配置表单的样式表，只用 `--dsw-alias-*` 令牌。
- 文案全部取自 [locales.ts](locales.ts) 的字典，组件不写死字符串。字典把命名空间合并进
  `LocaleNamespaceMap`，key 拼错或漏一种语言都是**编译错误**。

`Switch` 与 `Button` 来自 `@deepseek-ai/dsh-client-ui-primitives`。它是外壳预置模块
（`PLATFORM_MODULES`），不是别的插件，因此可以直接用，不需要 `dsh.client.inject` 边。

## 变更影响路由

- 改 `index.tsx` 的 `BUNDLE_NAME` 或 `ENTRY_ID` → 前者必须与 [../../package.json](../../package.json)
  的 `name` 逐字一致（写错 = 整块配置不出现），后者必须与 [../../cordis.patch.yml](../../cordis.patch.yml)
  的行 id 逐字一致（写错 = 卡片照常出现但**永远只读且不报错**）。
- 改 `ENABLE_FIELD`（`enableRestart`）→ 必须与宿主侧 [../config.ts](../config.ts) 的字段名同批改。
  **别的一边不改的后果是静默的**：宿主照原样接受写入，而工具永远读不到那一条。
- 改 `inject` 声明 → 跑那条**按真实 Cordis 语义装配**的判据：它是唯一能看见 inject 门禁的地方，
  普通替身（传普通对象当 `ctx`）结构性地看不见。声明一个宿主上已删的服务会让整个 `apply` 不执行。
- 改样式 → 只用 `--dsw-alias-*` 语义令牌，不写字面色值。
- 加文案 → 只改 [locales.ts](locales.ts) 的 key 与两份字典；两处都补齐才编得过。
- 改 locale 命名空间 → 必须与槽位注册的 `locale:` 一致，否则 `t` 取不到值、界面显示 key 本身。
- 改探测窗口或提示文案 → 跑「配置能力探测」一组（两环各一个窗口：都按时到达不发声 / 服务缺席报服务 /
  服务在槽缺席报槽 / 迟到各撤各的 / 服务缺席时槽不跟着喊）。
- 改**渲染面**（文案值、JSX 结构、样式对象、可见状态）→ 用户看到的那张卡片变了；
  截图占用维护者的浏览器，**先问再动**。
- 改完必须 `pnpm run build`。客户端半体由 `dsh-client-hmr` 轮询 `lib/client.js` 就地换装；
  **host 半体换不了** —— 而「加 `dsh.client`」本身就要重启宿主一次（装上半边那一次；
  ⚠️ 与「开关值改动不用重启」是两件事，别混）。

## 参考

- 客户端半边为什么做、10-14 那条「不做」为什么被反转 → 见根 [../../AGENTS.md](../../AGENTS.md) 的待办
- 开关的宿主侧形态与 `.volatile()` 的理由 → 见 [../config.ts](../config.ts)
- 插件形态方案 → 见 [../../docs/SHAPE.md](../../docs/SHAPE.md)
- 使用约束与工作偏好 → 见 [AGENTS.md](AGENTS.md)