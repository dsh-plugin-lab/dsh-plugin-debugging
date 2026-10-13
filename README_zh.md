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

技能里装着安装形态、凭证获取、进程识别与隔离实例。
**工具只是加速器；两者冲突时以技能正文为准。**

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
- 它们不重启进程、不改写 profile、不往 `DSH_HOME` 写任何东西。
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
| `timeoutMs` | `15000` | 一次外部命令或 HTTP 探测的上限 |

## 许可证

[MIT](LICENSE)。

## 贡献

问题与需求请走仓库 Issues。

维护者文档地图 → [AGENTS.md](AGENTS.md)。