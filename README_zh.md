<p align="center">
  <img src="icon.svg" alt="dsh-plugin-debugging" width="80" height="80">
</p>

<h1 align="center">dsh-plugin-debugging</h1>

<div align="center">
  <p><strong>Diagnose a running DSH instance — read-only checks, plus one in-place hot reload</strong></p>
  <p><em>给正在跑的 DSH 实例排障：只读诊断，外加一个就地热重载</em></p>

  <p>
    <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/powered_by_dsh-4D6BFE?style=flat&logo=deepseek&logoColor=white" alt="由 dsh 驱动"></a>
  </p>

  <p>
    <a href="https://github.com/dsh-plugin-lab/dsh-plugin-debugging/actions/workflows/ci.yml"><img src="https://github.com/dsh-plugin-lab/dsh-plugin-debugging/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
    <a href="https://www.npmjs.com/package/dsh-plugin-debugging"><img src="https://img.shields.io/npm/v/dsh-plugin-debugging.svg?style=flat" alt="npm"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat" alt="MIT 许可证"></a>
    <!-- SLSA 徽章**故意不挂**：0.1.0 是手动发的，npm 上没有 provenance（SLSA 要求由
         release.yml 走 Trusted Publisher 发布）。第一次由 CI 带 provenance 发版之后再补这枚 ——
         在那之前挂上去就是假声明：
         <a href="https://www.npmjs.com/package/dsh-plugin-debugging"><img src="https://img.shields.io/badge/SLSA-Build%20L2-green?logo=slsa&style=flat" alt="SLSA Build L2"></a> -->
  </p>

  <p>
    各版本改动 → <a href="https://github.com/dsh-plugin-lab/dsh-plugin-debugging/releases">Releases</a>
  </p>

  <p>
    <strong><a href="README_zh.md">简体中文</a></strong> · <a href="README.md">English</a>
  </p>
</div>

---

这套插件只用一句话就能说清：**产物在不同时机被读取，读取时机决定你改完该做什么。** 配置每次变更都被重读；进程只在启动时装载一次代码；浏览器按资源指纹自行换入。当「改了没用」时，第一个问题是：你看的是这三者里的哪一个。

## 工具一览

装上后模型多出五个工具 —— 四个只读、一个写侧 —— 外加一个技能：

| 工具 | 一句话说明 | 适用场景 |
|---|---|---|
| `dsh_check_effect_mode` | 判定你的改动属于三种读取时机里的哪一种 | 改了没生效，且不知道该重载还是该重启 |
| `dsh_diagnose_plugin_load` | 插件在不在 `bundles`、什么挂载形态、Loader 树怎么说 | 插件装了却像不存在 |
| `dsh_check_auth` | 区分连接被拒（没在跑）与 401（在跑、没过认证） | 页面返回 401，或分不清宿主是否活着 |
| `dsh_dump_config` | 组合后的配置树与其诊断 | 要知道这份组合究竟解析成了什么 |
| `dsh_hot_reload`（**写侧**） | 就地把一个已挂载的 entry 换成磁盘上的新代码 | 改了宿主侧代码，而重启比这次改动更贵 |

`dsh-plugin-debugging` 是它们背后的技能：每个检查的理由、生效三档、安装形态、凭证获取、进程识别、隔离实例都在里面。**工具只是加速器；两者冲突时以技能正文为准。**

### `dsh_check_effect_mode` —— 改动要什么

- `change`（**必填**）：`config`（配置 / patch / 启用状态 / 卸载）· `bundle-added`（新装 bundle）· `host-code`（已装插件的宿主端代码）· `client-code`（客户端代码 / 界面）。
- `alreadyInDependencies`：仅 `change: bundle-added` 时有意义。

**边界**：它先探测 profile 里到底挂没挂 `hmr`。没有 `hmr` 时 `reload()` 是空操作，任何「热生效」判定都会降级成 `restart-required`。它不重启任何东西。

### `dsh_diagnose_plugin_load` —— 插件加载了没有

- `package`：要查的包名，如 `dsh-zhihu-search` 或 `@scope/name`；省略则逐个列出 `bundles` 里的包。
- `port`：要探测的宿主端口。

**边界**：**观测**到的证据（`loader` 树可读时看 `fiber.state`；模块在 import 期就崩时 `fiber` 是 `undefined`）与**推断**出的证据（三处前置条件：在不在 `bundles`、安装形态、entry 文件）分开呈现；读不到树时输出会显式标注 `mode=inferred`。进程**按端口**查，不用命令行子串。

### `dsh_check_auth` —— 没在跑，还是没过认证

- `port`：要探测的宿主端口。
- `host`：主机名，默认 `127.0.0.1`。

**边界**：authority 是 `host:port` **逐字匹配**，所以 `localhost` 与 `127.0.0.1` 不通用。它报告 `client-connection` / `browser-session` 条目**是否存在**；v1 不提取密钥、不自签 cookie。

### `dsh_dump_config` —— 组合解析成了什么

- `profile`：profile 名；省略则用插件配置里的 profile。

**边界**：`--dump-config` 退出码恒 0，不能当门禁；`--dump-config-schema` 退出码 1 表示有 error，而 `preset-*` 那类已知误报会与「指向你改过的那一行」的真错分开。

## 刻意只读（一个例外）

- 四个诊断工具只读实例本来就有的文件；不存凭据，也不产生凭据。
- 它们不重启进程、不改写 profile、不往 `DSH_HOME` 写任何东西。
- **唯一的写侧例外是 `dsh_hot_reload`**：它只动**运行中的模块树**（原地换代码），仍不写 profile、不写 `DSH_HOME`、不杀进程；失败时旧版本会被放回（import 期失败则**根本没碰过**旧版本）。
- 重启助手**有意不做**：它是仅有的、能杀掉「你正在排障的那个宿主」的动作。

## 安装

### 前置

- **支持的 DSH 区间写在 [package.json](package.json)**（`engines.dsh`，以及每个 `@deepseek-ai/dsh-*` peer 上的同一区间）—— 那是唯一真源；本文件不抄它，因为抄下来的值会静默过期。
- Node `>= 20`。

### 从 npm 安装

```shell
dsh plugin --profile web add dsh-plugin-debugging
```

尚未发布到 npm —— 这条路径在首次发布后可用。

### 从源码安装

```shell
git clone https://github.com/dsh-plugin-lab/dsh-plugin-debugging.git
cd dsh-plugin-debugging
npm install && npm run build

dsh plugin --profile web add "$PWD"
```

⚠️ `npm install` 那一步不能省：`link:` 装法下依赖由仓库自己提供，漏装会让插件显示「未运行」（`ERR_MODULE_NOT_FOUND`）。

重启 `dsh --profile web` 后生效。

## 平台支持

v1 的按端口进程识别**只在 Windows 上可用**。其他平台会报 `probed: false`，并把平台名写进说明 ——
**刻意不写成「没有监听者」**：因为「查不了」与「没在跑」是相反的两个结论。其余能力与平台无关。

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `dshHome` | `$DSH_HOME`，否则 `<home>/.dsh` | 实例存放 profile、日志与凭据的目录 |
| `profile` | `$DSH_PROFILE`，否则默认 profile | 工具检查哪个 profile |
| `port` | `0` | 要探测的宿主端口；`0` = 自己找监听端口 |
| `timeoutMs` | `15000` | 一次外部命令或 HTTP 探测的上限 |

没有设置卡片：这几个字段属于插件在 profile 组合里的配置。

## 许可证

[MIT](LICENSE)。

## 贡献

问题与需求请走仓库 Issues。

维护者文档地图 → [AGENTS.md](AGENTS.md)。
