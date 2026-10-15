<p align="center">
  <img src="icon.svg" alt="dsh-plugin-debugging" width="80" height="80">
</p>

<h1 align="center">dsh-plugin-debugging</h1>

<div align="center">
  <p><strong>让 DSH agent 自检自修它身处的运行时</strong></p>
  <p><em>Let your DSH agent inspect and fix its own runtime</em></p>

  <p>
    <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/powered_by_dsh-4D6BFE?style=flat&logo=deepseek&logoColor=white" alt="由 dsh 驱动"></a>
  </p>

  <p>
    <a href="https://github.com/dsh-plugin-lab/dsh-plugin-debugging/actions/workflows/ci.yml"><img src="https://github.com/dsh-plugin-lab/dsh-plugin-debugging/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
    <a href="https://www.npmjs.com/package/dsh-plugin-debugging"><img src="https://img.shields.io/npm/v/dsh-plugin-debugging.svg?style=flat" alt="npm"></a>
    <a href="https://www.npmjs.com/package/dsh-plugin-debugging"><img src="https://img.shields.io/badge/SLSA-Build%20L2-green?logo=slsa&style=flat" alt="SLSA Build L2"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat" alt="MIT 许可证"></a>
    <!-- SLSA 徽章能不能挂，判据见 [docs/PUBLISHING.md](docs/PUBLISHING.md)（对**具体版本**查 attestations 端点；别凭印象挂）。 -->
  </p>

  <p>
    各版本改动 → <a href="https://github.com/dsh-plugin-lab/dsh-plugin-debugging/releases">Releases</a>
  </p>

  <p>
    <strong><a href="README_zh.md">简体中文</a></strong> · <a href="README.md">English</a>
  </p>
</div>

---

你改了个东西，发现没生效？在 DSH 里，这通常有三种原因：

- **配置**：每次修改都会被重新读取，改完就生效。前提是 `profile` 里已挂载 `hmr`；没有 `hmr` 时，一切改动退化为需要重启。
- **宿主代码**：进程只在启动时加载一次，改了必须重启。
- **前端资源**：浏览器按指纹换资源，改完需要热重载或刷新。

这个插件让 agent（智能体）自己判断你遇到的是哪一种，并给出下一步。

## 它做什么

装上之后，agent 多了一组工具和一份 skill（技能）文档，skill 按需加载。

### 工具

| 工具 | 必填 | 可选 | 做什么 |
|---|---|---|---|
| `dsh_check_effect_mode` | `change`：`config` / `bundle-added` / `host-code` / `client-code` | `alreadyInDependencies`、`dshHome` | 判断一个改动是实时生效、需要重启，还是热重载。在正在运行的 `profile` 上实际探测。 |
| `dsh_diagnose_plugin_load` | — | `package`、`port`、`dshHome` | 查一个插件到底加载没有：`bundle` 归属、挂载形态、`loader` 树，并区分实测证据和推断证据。 |
| `dsh_list_instances` | — | `port` | 列出本机正在运行的 DSH 宿主。只有未认证的 `GET /` 返回完全相同的响应体时，才认定为 DSH。“探不到”和“不是 DSH”分开报告。 |
| `dsh_check_auth` | — | `host`、`port` | 区分“没在运行”和“没通过认证”。 |
| `dsh_dump_config` | — | `profile`、`dshHome` | 展示一个 `profile` 最终解析成什么：组合树，以及解释它的诊断信息。 |
| `dsh_hot_reload` | `entryId` / `module` / `serverName` 三者取一 | `dryRun` | 把一个已挂载的 `entry` 替换成磁盘上的最新代码，不重启；失败自动回滚。 |
| `dsh_sign_cookie` | — | `host`、`port`、`maxAgeDays`、`dshHome` | 签一个浏览器会话 `cookie`，让脚本或命令行客户端访问你自己的 DSH 实例。 |
| `dsh_restart` | `reason` | `delayMs`、`dryRun`、`force` | 当改动确实需要重启时，重启当前宿主。**默认关闭。** |

**三个容易踩的坑：**

- **`dsh_check_auth` 的 `401` 不代表会话过期。** 不带 `cookie` 的请求永远得到 `401`，所以 `auth probe` 的 `401` 只证明服务在运行且要求认证。要区分“会话还有效”和“`authority` 不对”，只能用浏览器打开那个 `host:port`。同一端口重启后旧 `cookie` 仍然有效；端口变了才会 `401`。
- **`dsh_hot_reload` 可能留下泄漏。** 框架未跟踪的资源（比如 `timer` 或 `socket`）在 `swap` 后会静默泄漏。
- **`dsh_restart` 的行为见下文专节。**

### 背后的 skill 文档

skill 文档在 [`skills/dsh-plugin-debugging/SKILL.md`](skills/dsh-plugin-debugging/SKILL.md)，里面写了安装方式、凭证获取、进程识别和隔离实例的完整推理。

**工具只是加速器；如果工具输出和这份 skill 文档冲突，以 skill 文档为准。**

## 安装

**通过插件页安装：**

进入 **插件** 页，点右上角 **添加插件**，填入 `dsh-plugin-debugging`，安装。

**通过 npm 安装：**

```shell
dsh plugin --profile web add dsh-plugin-debugging
```

**从源码安装：**

```shell
git clone https://github.com/dsh-plugin-lab/dsh-plugin-debugging.git
cd dsh-plugin-debugging
pnpm install && pnpm run build
dsh plugin --profile web add "$PWD"
```

**注意事项：**

- **不要跳过 `pnpm install`**：如果用 `link:` 安装，依赖来自仓库本身；跳过这一步，插件会显示未运行，并报 `ERR_MODULE_NOT_FOUND`。
- **重启生效**：安装后需要重启 `dsh --profile web`。
- **`link:` 与 `dsh.bundle` 是两件事**：`link:` 只决定改源码要不要重装；`patch` 层是否应用，取决于包是否声明了 `dsh.bundle`。

**环境要求：**

Node `>= 20`，以及 DSH 版本满足 [package.json](package.json) 中的范围。

**维护规则：**

`profile` 的 `dependency` 和 `bundle list` 由 `dsh plugin add` 管理，不要手改。不要在 `$DSH_HOME` 下创建包，也不要在 `profile` 目录里跑包管理器。

## 安全与边界

这些工具**不会重启进程、不会改写 `profile`、不会写入宿主数据**。这条规则由测试保证：只要有写操作指向宿主数据路径（`profiles` / `sessions` / `storages` / `logs` / `cache` / `attachments` / `backups` / `integrations` / `mcp` / `settings.yaml` / `.credentials.yaml` …），或者把 `DSH_HOME` 本身当作目标，`pnpm run test` 就会失败。

**唯一例外是本插件自己的命名空间** `$DSH_HOME/<包名>/`：只允许 `$DSH_HOME` 下第一层目录名恰好等于包名，再往下的路径不受限制。

**逐工具边界：**

- **只读，不发请求**：`dsh_check_effect_mode`、`dsh_diagnose_plugin_load`、`dsh_dump_config`。只读实例已有的文件，不产生凭据。
- **只读，会发 HTTP**：`dsh_check_auth` 连接你指定的 `host:port`；`dsh_list_instances` 只探测 loopback 端口。两者都不发凭据。
- **只动运行中的模块树**：`dsh_hot_reload`，不杀进程。
- **读本地签名密钥**：`dsh_sign_cookie`，为你自己的实例签一个 `cookie`。不发请求，`cookie` 的值刻意不返回。

### `dsh_restart`

`dsh_restart` 是唯一不可逆的动作：它会让宿主退出，也就是你正在排障的那个。它默认关闭，跑起来要连过三道门槛：

1. **四道确定性检查**：是否陷入重启循环、是否有其他会话或作业在忙、`bundle` 表是否可读、启动命令能否确定。`force` 只能覆盖“会话在忙”这一道，另外三道绕不过。
2. **一道独立的审批检查**：先读取审批策略，只有策略是 `ask` 时才询问。`never` 表示提示已关闭，在 `never` 下询问必然被拒，所以必须先读策略再决定是否询问。
3. **写 `marker` 前的独立检查**：本插件自己的命名空间不在默认文件沙箱内，所以这次写入会显式使用 `danger-full-access`。

**三道的结果都会写进工具输出。** `dryRun` 会跑完所有门槛，但不写任何东西。

**重启后会发生什么：**

- 新宿主读取 `marker`，唤醒之前列出的每一个会话，发一条通知，并让它们各跑一轮。
- 通知里的 `reason` 只发给请求重启的那个会话。
- 被中断的其他会话收到同样的事实——何时请求、花了多久、`marker` 的最终状态——但看不到 `reason`。

## 平台支持

**按端口识别监听进程**支持 Windows、Linux 和 macOS。具体行为：

- **找不到可用命令时**：报告“无法检查”，而不是“没有监听者”。这两个结论正好相反。
- **弱兜底命令**：可能发现“有人在监听”，但说不出是哪个进程；这种情况记为“未识别”，而不是报告“没有监听者”。
- **唯一例外**：`dsh_restart` 只在 Windows 上能真正重新拉起宿主（计划任务路线已实测）。在其他平台上，它会在写入任何东西之前拒绝，避免先落下 `marker` 才发现拉不回来。

## 配置

### 字段

这些字段用于配置 `profile` 组合中的本插件。其中 `enableRestart` 在 **插件** 页的本插件卡片上也有一个开关。

| 字段 | 默认 | 含义 |
|---|---|---|
| `enableRestart` | `false` | 是否允许运行 `dsh_restart`。立即生效，无需重启宿主。 |
| `dshHome` | `$DSH_HOME` 或 `<home>/.dsh` | 实例存放 `profiles`、日志和凭据的目录。 |
| `profile` | `$DSH_PROFILE` 或默认 `profile` | 工具要检查哪个 `profile`。 |
| `port` | `0` | 要探测的宿主端口；`0` 表示自动寻找监听端口。 |
| `timeoutMs` | `60000` | 快速操作的超时预算：读文件、运行命令，或发一次 HTTP 探测。 |
| `schemaDumpTimeoutMs` | `240000` | 运行 `--dump-config-schema` 的超时预算（实测 10.2–15.7 秒；高负载 32 秒）。 |

### 预算

工具内部每一条外部命令或 HTTP 探测的超时，都比工具总预算少 2 秒。传输层必须先于宿主的工具时限超时；否则 agent 只会得到一个没有错误类别的 `TimeoutError`，无法判断重试是否有意义。

### 调试另一个实例

**什么时候需要它：** 当你正在调试一个实例，但证据在另一个实例上——另一个 `profile`，或另一个 `DSH_HOME`。隔离实例必须给一个 `template profile`，否则新 `home` 没有 `profile` 可起，会直接报 `profile` 不存在。

**哪些工具收 `dshHome`：** `dsh_dump_config`、`dsh_check_effect_mode`、`dsh_diagnose_plugin_load`、`dsh_sign_cookie`。路径解析和它启动的 `dsh` 子进程都会使用你传入的 `home`；输出会写明实际读取的是哪一个（`dshHomeSource: tool-argument`）。参数传入的值绝不会被悄悄写成配置默认值。

**哪些不收，为什么：**

- `dsh_check_auth`：它回答的是某个 `host:port` 的认证状态，本身已经有 `host` / `port`。
- `dsh_list_instances`：它只做发现，能给出的只是一个 `host:port`。
- `dsh_hot_reload`：它替换的是**当前进程**内存里的模块，无法跨到另一个实例。
- `dsh_restart`：它杀掉的就是**自己所在的**宿主，不存在可以指向的“另一个实例”。

**一个坑：** 发现类工具只能给出 `host:port`，无法推导出对应的 `DSH_HOME`；所以 `dshHome` 需要你自己传。相应地，`dsh_diagnose_plugin_load` 会把答案分成两部分：磁盘证据来自你传入的 `home`，`loader` 树部分只反映**当前进程**。

## 许可证

[MIT](LICENSE)。

## 贡献

问题与需求请走仓库 Issues。

维护者文档地图 → [AGENTS.md](AGENTS.md)。
