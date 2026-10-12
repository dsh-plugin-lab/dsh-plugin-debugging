<p align="center">
  <img src="icon.svg" alt="dsh-plugin-debugging" width="80" height="80">
</p>

<h1 align="center">dsh-plugin-debugging</h1>

<div align="center">
  <p><em>给一个正在跑的 DSH 实例排障：改动要不要重启、插件到底加载了没有、401 还是连接被拒、组合后的配置究竟长什么样。</em></p>

  <p>
    <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat&logo=deepseek&logoColor=white" alt="由 dsh 驱动"></a>
  </p>

  <p>
    <a href="https://github.com/dsh-plugin-lab/dsh-plugin-debugging/actions/workflows/ci.yml"><img src="https://github.com/dsh-plugin-lab/dsh-plugin-debugging/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat" alt="MIT 许可证"></a>
  </p>

  <p>
    各版本改动 → <a href="https://github.com/dsh-plugin-lab/dsh-plugin-debugging/releases">Releases</a>（与 npm 版本一一对应）
  </p>
</div>

<p align="center"><a href="README.md">English</a> | 中文</p>

---

## 提供什么

一个技能 + 四个**只读**工具，服务的是同一个问题：**「我改了点东西，怎么没生效？」**

贯穿的原理只有一句：*产物在不同时机被读取，读取时机决定改动后该做什么。* 配置由 loader 每次变更重读；进程只在启动时装载一次代码；浏览器按资源指纹自行换入。

| 工具 | 回答什么 |
|---|---|
| `dsh_check_effect_mode` | 给定「你改了什么」→ 热生效、要重启、还是走 HMR |
| `dsh_diagnose_plugin_load` | 插件在不在 `bundles`、什么挂载形态（link / 拷贝）、entry 在不在、启动日志里有没有被点名 |
| `dsh_check_auth` | 区分「连接被拒（没启动）」与「401（服务活着、认证没过）」，并给出实际在用的 authority 与端口 |
| `dsh_dump_config` | 组合后的配置树与 `x-cordis.diagnostics`，连同「哪个退出码才算真有错」的语义 |

同时随包分发一个技能（`dsh-plugin-debugging`），装载完整的排障知识：每个检查背后的理由、生效三档、安装形态、凭证获取、进程识别、隔离实例。工具是它的加速器；两者冲突时**以技能正文为准**。

**v1 刻意只读。** 这里没有任何东西会重启进程、改写 profile 或写 `DSH_HOME`。重启与热重载助手被有意推迟：它们是仅有的、会杀掉「你正在排障的那个宿主」的动作，而它们的审批、冷却与失败恢复语义必须先定下来。

## 安装

```shell
dsh plugin --profile <profile> add dsh-plugin-debugging
```

## 版本兼容

支持的宿主范围声明在 `package.json` —— `engines.dsh`，以及每个 `@deepseek-ai/dsh-*` peer 上的同一区间。**这里刻意不重复那些值**：它们会漂，抄进文档就会静默过期。要具体值请现查清单。

这条门有两个性质值得知道，因为两者都**静默**失败：

- 兼容性判定读的是 **`peerDependencies`**（带 `includePrerelease`）。`engines.dsh` 目前**没有任何读取者**，只写它等于没有约束。
- profile 级的 bundle 判定失败时，错误被 `catch` 成 `skippedBundles` —— 进程照常启动，插件像没装一样消失。`dsh plugin add` 那条路才是硬失败。

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `dshHome` | `$DSH_HOME`，否则 `<home>/.dsh` | 实例存放 profile、日志与凭据的目录 |
| `profile` | `$DSH_PROFILE`，否则 `web` | 工具检查哪个 profile。注意 `--profile` 被 CLI 自己吃掉了，插件永远看不到它 —— 环境变量是唯一来源 |
| `port` | `0`（自动推断） | 要探测的宿主端口；`0` = 自己找监听端口 |
| `timeoutMs` | `15000` | 一次外部命令或 HTTP 探测的上限 |

不存任何凭据：插件只读实例本来就有的文件，自己不产生密钥。

## 开发

```shell
npm ci
npm run check          # typecheck + build + test
npm run check:release  # 发布态不变量
```

设计说明见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)；决策与理由见 [.agents/notes/](.agents/notes/)；维护规则见 [AGENTS.md](AGENTS.md)；发布流程见 [docs/PUBLISHING.md](docs/PUBLISHING.md)。

## 许可证

[MIT](LICENSE)
