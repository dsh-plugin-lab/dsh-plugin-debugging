<p align="center">
  <img src="icon.svg" alt="dsh-plugin-debugging" width="80" height="80">
</p>

<h1 align="center">dsh-plugin-debugging</h1>

<div align="center">
  <p><strong>Let your DSH agent inspect and fix its own runtime</strong></p>
  <p><em>让 DSH Agent 自检自修它身处的运行时</em></p>

  <p>
    <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/powered_by_dsh-4D6BFE?style=flat&logo=deepseek&logoColor=white" alt="由 dsh 驱动"></a>
  </p>

  <p>
    <a href="https://github.com/dsh-plugin-lab/dsh-plugin-debugging/actions/workflows/ci.yml"><img src="https://github.com/dsh-plugin-lab/dsh-plugin-debugging/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
    <a href="https://www.npmjs.com/package/dsh-plugin-debugging"><img src="https://img.shields.io/npm/v/dsh-plugin-debugging.svg?style=flat" alt="npm"></a>
    <a href="https://www.npmjs.com/package/dsh-plugin-debugging"><img src="https://img.shields.io/badge/SLSA-Build%20L2-green?logo=slsa&style=flat" alt="SLSA Build L2"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat" alt="MIT 许可证"></a>
    <!-- SLSA 徽章的**真实性判据**（别凭印象挂）：对**具体版本**查
         https://registry.npmjs.org/-/npm/v1/attestations/dsh-plugin-debugging@<版本> —— 200 才算有 provenance。
         实测：`0.1.0`（手动发）→ 404，**那一版不该挂**；`0.2.0`（由 release.yml 发）→ 200。 -->
  </p>

  <p>
    各版本改动 → <a href="https://github.com/dsh-plugin-lab/dsh-plugin-debugging/releases">Releases</a>
  </p>

  <p>
    <strong><a href="README_zh.md">简体中文</a></strong> · <a href="README.md">English</a>
  </p>
</div>

---

这套插件只用一句话就能说清：**产物在不同时机被读取，读取时机决定你改完该做什么。**
配置每次变更都被重读；进程只在启动时装载一次代码；浏览器按资源指纹自行换入。
当「改了没用」时，第一个问题是：你看的是这三者里的哪一个。

## 它做什么

装上之后，模型多出回答那个问题所需的工具，外加一个装着背后理由的技能：

- **判定改动要什么** —— 实时生效、重启、还是热重载；对正在跑的 profile 探测，不靠猜。
- **查插件到底加载没有** —— bundle 归属、挂载形态、Loader 树，并把观测到的与推断出的证据分开。
- **分开「没在跑」与「没过认证」** —— 连接被拒与 401 的下一步相反，就不能给同一个答案。
- **展示这份 profile 解析成了什么** —— 组合树，以及解释它的诊断信息。
- **把一个已挂载的 entry 就地换成磁盘上的代码** —— 不重启，失败自动放回。
- **签一个 browser-session cookie** —— 让脚本或命令行客户端能访问你自己的实例。
- **列出本机活着的 DSH 宿主** —— 只有未认证 `GET /` 返回**逐字**那句 DSH 响应体时才认领该端口；「探不到」与「不是 DSH」分开报。

技能里装着安装形态、凭证获取、进程识别与隔离实例。
**工具只是加速器；两者冲突时以技能正文为准。**

**指向另一个实例。** 文件型工具（`dsh_dump_config` / `dsh_check_effect_mode` / `dsh_diagnose_plugin_load` / `dsh_sign_cookie`）都收一个 `dshHome` 参数，于是你不必重启任何东西就能读**第二个实例**的磁盘证据。路径解析**与**它起的 `dsh` 子进程都用那个 home，输出里也写明读的是哪一个（`dshHomeSource: tool-argument`）—— 参数来的值**绝不**被悄悄印成配置里的默认值。发现类工具只能给你一个 authority（`host:port`）；authority 与 `dshHome` 之间没有可推导的关系，所以那个路径由你填。两个工具**有意不收**它：`dsh_check_auth` 回答的是 authority（本来就有 `host` / `port`）；`dsh_hot_reload` 换的是**本进程**内存里的模块，跨不到另一个实例。`dsh_diagnose_plugin_load` 因此把答案**分成两半报**：磁盘证据属于你给的那个 home，Loader 树那一半**只属于本进程**。

## 安装

```shell
dsh plugin --profile web add dsh-plugin-debugging
```

从源码装：

```shell
git clone https://github.com/dsh-plugin-lab/dsh-plugin-debugging.git
cd dsh-plugin-debugging
npm install && npm run build
dsh plugin --profile web add "$PWD"
```

⚠️ `npm install` 那一步不能省：`link:` 装法下依赖由仓库自己提供，漏装会让插件显示「未运行」（`ERR_MODULE_NOT_FOUND`）。

重启 `dsh --profile web` 后生效。

前置条件：Node `>= 20`，以及满足 [package.json](package.json) 的 DSH 区间 —— 支持区间只认这一处，不在文档里另抄一份。

## 安全与边界

- 诊断类工具只读实例本来就有的文件，不产生凭据。
- 它们不重启进程、不改写 profile、不往 `DSH_HOME` 写任何东西 —— **这条是机器判据**：写动作一旦指向宿主数据路径（`profiles` / `sessions` / `storages` / `logs` / `cache` / `attachments` / `backups` / `integrations` / `mcp` / `settings.yaml` / `.credentials.yaml` …）或取值为 `DSH_HOME`，`npm test` 当场红。**唯一的例外是本插件自己的命名空间** `$DSH_HOME/<包名>/` —— 只放过**紧跟 home 的那一段**（逐字等于包名），该层以下随便分。
- `dsh_hot_reload` 只动**运行中的模块树**：不写 profile、不写 `DSH_HOME`、不杀进程。
- `dsh_sign_cookie` 读你的本地签名密钥，为你自己的实例签一个 cookie。它不发请求、不写任何东西；cookie 的值**刻意不返回**。
- 重启助手**有意不做**：它是仅有的、能杀掉「你正在排障的那个宿主」的动作。

## 平台支持

按端口识别监听进程覆盖 Windows、Linux 与 macOS。
一条可用的命令都找不到时，它会报「查不了」—— **刻意不写成「没有监听者」**：因为这两者是相反的两个结论。
两档较弱的兜底命令可能报出「有人在听」但说不出是哪个进程；这种情况记为「未识别」，而不是谎称「没有监听者」。
其余能力与平台无关。

## 配置

没有设置卡片：这几个字段属于插件在 profile 组合里的配置。

| 字段 | 默认 | 含义 |
|---|---|---|
| `dshHome` | `$DSH_HOME`，否则 `<home>/.dsh` | 实例存放 profile、日志与凭据的目录 |
| `profile` | `$DSH_PROFILE`，否则默认 profile | 工具检查哪个 profile |
| `port` | `0` | 要探测的宿主端口；`0` = 自己找监听端口 |
| `timeoutMs` | `15000` | **快档**工具的工具预算：读文件、跑一条命令、发一次 HTTP 探测 |
| `schemaDumpTimeoutMs` | `60000` | 跑 `--dump-config-schema` 那个工具的工具预算（实测 10.2–15.7 s，负载重时 32 s） |

工具内部每一条外部命令 / HTTP 探测拿到的预算比工具预算少 2 s：传输层必须先于宿主的工具死线超时，否则模型拿到的是没有错误类别的裸 `TimeoutError`，无法判断重试是否有意义。

## 许可证

[MIT](LICENSE)。

## 贡献

问题与需求请走仓库 Issues。

维护者文档地图 → [AGENTS.md](AGENTS.md)。