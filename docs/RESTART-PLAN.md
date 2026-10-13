# `dsh_restart` 计划（v1.1 剩余部分）

> **本文件是计划，不是实测结论。** 未标 `[已实测]` / `[已核]` 的表述都是**推断**。
> 只写「做什么 / 怎么做 / 做完怎么验」，不写「什么时候做」。

**本文职责**：唯一还没实现的写侧工具（`dsh_restart`）的方案 —— 四道闸、流程、恢复逻辑、验收。
**不负责**：**已实现**的 `dsh_hot_reload` → [ARCHITECTURE.md](ARCHITECTURE.md) §5；宿主侧已核事实 → [HOST-CONTRACTS.md](HOST-CONTRACTS.md)；在这里怎么干活 → [AGENTS.md](../AGENTS.md)。
**读者**：动手做 `dsh_restart` 的人。**动手前先读 [HOST-CONTRACTS.md](HOST-CONTRACTS.md) §2**（拉起与恢复的契约全在那里，本文只留结论）。

## 1. 为什么它比热重载危险

重启是**不可逆**动作：它杀掉当前进程、连同发起这次调用的那个回合。热重载可回滚，重启不能。

| | 热重载（已实现） | 重启（本文） |
|---|---|---|
| 失败形态 | 旧版本放回，可继续 | **进程没了、会话回不来** |
| 可恢复性 | 重试即可 | 需要 marker + 唤醒，且要看外部进程管理器脸色 |
| 最难的部分 | 顺序（已解决） | **闸门与恢复**，不是动作本身 |

所以本计划的重心是**四道闸**（§2）与**恢复逻辑**（§4）。

**与既有工具的关系**：它必须建立在 `dsh_check_effect_mode` 的判定之上 —— 那个工具已能回答「这次改动属于哪一档、这个 profile 的 `hmr` 是否真的在 watch patch 文件」。这条写成纪律（§8）。

## 2. 四道闸（任一不过即拒绝，且**不提供绕过参数**）

| 闸 | 判据 | 拒绝时的返回 |
|---|---|---|
| **① 重启循环熔断** | 短窗口内重启次数超过阈值 → 拒绝（例如上次重启在 N 秒内，或本轮已重启 ≥N 次） | `restart-loop` + 说明 |
| **② 其他会话在跑** | 除调用方自己以外的活跃会话仍在执行回合 → 拒绝；**调用方自己的会话不算忙** | `busy` + 列出阻塞者 + `nextStep` 建议等待 |
| **③ bundle 表解析不了** | profile 的 `bundles` / patch 解析失败 → 拒绝（重启后起不来就再也回不来） | `bad-composition` + 指路 `dsh_dump_config` |
| **④ 拿不到启动命令** | 无法确定「怎么把宿主重新拉起来」 → 拒绝（**不猜**） | `no-launch-command` + 请用户给命令 / 走外部管理器 |

闸①③④ 是本仓新增；闸② 的语义借自参考实现。
**闸② 的判据已可落地**（`agents.list` 的 `status`/`inbox`、`jobs.list`、`workspace/session-activity` 的 `kind:'schedule'`）—— 契约与注意事项见 [HOST-CONTRACTS.md](HOST-CONTRACTS.md) §2.2，**含一条 fail-closed 要求**。

## 3. 流程（顺序是判据）

```
闸门检查（§2 四道）
  → 写 marker（重启前，落盘）
  → 拉起新进程
  → 本进程退出
  ── 新进程启动 ──
  → 读 marker
  → 恢复会话
  → 注入 notice
  → 删 marker
```

- **marker 必须落盘、必须在拉起之前** —— 留给回执落盘的时间（参考实现默认 10 秒）。
- **拉起新进程的形态**：`[已实测]` 结论是**优先交给外部管理器**（supervisor / Windows 服务 / systemd），插件只做「查闸门 → 落盘 marker → 退出」；自建 helper 是**降级路径**，且**必须两级 detached**。
  机制（`/T` 按当时的活链枚举、服务化场景两级也未必够）与全部 B1–B9 证据见 [HOST-CONTRACTS.md](HOST-CONTRACTS.md) §2.1 —— **不要在本文重推一遍**。
- **绝不按进程名批量杀**：按**监听端口 + 精确 PID** 定位 —— 与本仓既有的「按端口找进程，不按命令行子串」一致。
- **不拥有 watchdog**：参考实现 `dsh-restart` 曾在 `0.1.3-alpha.4` **移除**内置 detached watchdog，理由是把进程生命周期交给 systemd / Windows 服务等外部管理器。→ 默认应当是「交给外部」。

## 4. 恢复逻辑

- **恢复标记绝不能写进会话日志** `[已实测：AGENTS 活跃坑 4]`：自定义 `SessionEventMap` 成员 + `session.append()` 会**写坏会话日志** —— 写入当次可用，但下次加载时持久层会因「未知且未标 `ignorable` 的事件」拒绝解释整份日志。仓外插件的正确通道是 `appendPluginRecord()`。
  → **marker 必须是独立文件**，不是会话事件。
- **注入的是信息性 notice，不是强制「继续」**：让 agent 自己决定要不要接着干（参考实现里 `dsh-smart-restart` 与 `dsh-desktop-auto-restart` 两种做法不同，本仓取前者）。
- **唤醒要走官方通道、按会话原有预设**；唤醒失败**保留 marker**，下次启动继续重试。
- **记录调用方会话**，把 notice 送回**发起重启的那个会话**。
- 通道（`resolveAgent` → `agents.get` → `followup`）与「必须延迟重试」的原因见 [HOST-CONTRACTS.md](HOST-CONTRACTS.md) §2.2。

## 5. 工具定义草稿

```ts
{
  name: 'dsh_restart',
  description:
    'Restarts the DSH host process after four gates pass, and hands the calling session a notice when it comes back. ' +
    'Use it only after dsh_check_effect_mode says the change is restart-required — it kills the running turn, including yours. ' +
    'It is the most destructive tool in this plugin: it refuses unless the gates pass, and it has no force option — ' +
    'a refusal means restarting now would lose work or leave nothing to come back to.',
  parameters: {
    reason: 'Short human-readable reason; recorded in the marker and the notice.',
    delayMs: 'Delay before exiting, so the receipt can reach disk. Defaults to 10s; 0 restarts immediately.',
    dryRun: 'Run all four gates and report the verdict without restarting.',
  },
}
```

形状取自 `dsh-desktop-auto-restart`；`dryRun` 是本仓新增（四道闸必须能单独演练）。
**待定**：工具**是否默认注册**（参考实现的同类工具默认关）—— 见 §9 第 3 条。

## 6. 返回草稿

```
[dsh_restart] ok
verdict: gates=4/4 passed · marker=<path> · newPid=<pid>
why: <一句话：哪些会话会被唤醒、marker 什么时候删>
nextStep: （无 —— 本进程即将退出）
```

被闸门拒绝时：

```
[dsh_restart] failed (busy)
2 other sessions are mid-turn; restarting now would kill them
hint: wait for them to finish, or restart from outside the host
nextStep: dsh_check_effect_mode({"change":"config"}) — 先确认这次改动是否真的必须重启
```

## 7. 做完怎么验

- 四道闸**各一条拒绝用例**（构造条件 → 断言不重启且返回正确 `kind`）。
- 真机一条「重启 → 会话被唤醒 → notice 到达发起者」的闭环。
- 反向用例：**marker 存在但新进程没起来**（kill 掉）→ 下次启动必须仍能恢复，或明确报「上次重启未完成」。
- 沿用本仓的验证纪律：真机判据由**独立角色**跑，写者不自己验自己（见 [ARCHITECTURE.md](ARCHITECTURE.md) §8）。

## 8. 协作纪律

**判断驱动行动：模型不应该跳过 `dsh_check_effect_mode` 直接调写侧工具。**

- 顺序是**契约**而不是建议：先 `dsh_check_effect_mode` 拿到 `mode` 与 `hmr`，再决定调不调写侧工具。
  - `mode=hot` 且 `hmr=present` → 通常**不需要**写侧工具（改动会被重读）`[已实测]`。
  - `mode=hot` 但 `hmr=absent` → 改 config **必须重启** `[已实测]` → 走 `dsh_restart`。
  - `mode=restart-required` → `dsh_restart`；`mode=hmr` → 两个都不需要。
- **能只读解决的不动手**：写侧工具都提供 `dryRun`，且**默认建议先 dryRun**。
- **拒绝不是失败**：闸门拒绝是设计的一部分；模型应当把拒绝原样报给用户，而不是想办法绕过（**没有 `force` 参数，这是判据**）。
- **不把热重载与重启合并成一个工具**：失败代价不同（前者可回滚，后者不可逆），闸门也不同。合成一个「修复它」工具会让模型倾向于选更重的那条路。

## 9. 待实测清单

每条标：**待验证什么 / 影响什么决策**。全部未做。

| # | 待验证 | 影响什么决策 |
|---|---|---|
| 1 | **拉起形态在服务化场景（job object / Windows 服务 / `KILL_ON_JOB_CLOSE`）下的实际行为** —— 两级 detached 是否也无效 | 自建 helper 到底能不能作为降级路径存在；否则只能「有外部管理器才允许重启」 |
| 2 | **父被 `/T` 树杀时两级 detached 的长期存活**（G 能否长期活着，`taskkill /IM` 按名杀会不会连坐） | 同上 |
| 3 | **工具是否默认注册**（参考实现的同类工具默认关） | 装完即生效 vs 需显式开启；影响 README 的安装分档 |
| 4 | **`appendPluginRecord()` 的可用性与前缀约束**（若真要写自己的 `plugin:` 记录） | marker 之外要不要留会话记录 |
| 5 | **「按会话原有预设」唤醒的语义**（参考实现自述如此，未在本机验） | 恢复逻辑能否保证「回来的是同一个上下文」 |
| 6 | **重启后 notice 的投递时序**（参考实现实测「启动后 3 秒 `agents.get()` 还取不到」） | marker 的删除时机与重试策略 |
| 7 | **闸① 的阈值怎么定**（短窗口内几次算循环） | 会不会把正常运维动作误判成循环 |

**已不再是待实测**（曾在旧版本文件里）：热重载的三条判据（已全过）、`loader.internal` 的前置门、忙判定的可读性、恢复通道、拉起形态的可行性 —— 结论都在 [HOST-CONTRACTS.md](HOST-CONTRACTS.md)。

## 附：参考实现索引

调研方式：**只读**（npm registry 元数据 + GitHub API 读 README/文件清单）；热重载与重启的核心路径**补读了实现源码**（结论见 [HOST-CONTRACTS.md](HOST-CONTRACTS.md)）。
下表「核心做法」= **各项目 README 的自述**，不是我们的实测。

| 包名（版本） | 仓 | 核心做法（自述） | 可借鉴点 | 与我们的差异 |
|---|---|---|---|---|
| `dsh-plugin-reload` 0.2.1 | reina4xa/dsh-plugin-reload | 工具 `reload_plugin`，**按 entry id / 模块名 / MCP `serverName`** 重启单个 entry，兄弟 entry 不动 | 三种定位方式；「先 import 成功再换 fiber」的顺序（**本仓已实现并实测**） | 它是工具调用触发的单 entry 重启；我们还要先判「改动属于哪一档」 |
| `dsh-hot-reload` 0.2.4 | stuarthu/dsh-hot-reload | **watch profile 的 `pnpm-lock.yaml`**，已加载插件版本变化时原位替换。import 期失败在碰运行中插件前就被抓住；apply 期失败回滚。**失败过的版本不自动重试** | 「不自动重试失败版本」这条**我们原本没有**（值得考虑）；停用行静默跳过 | 它是**事件驱动**、面向「升级已装插件」；我们是**工具调用驱动**、面向「刚改完源码」 |
| `dsh-hotswap` 0.1.1 | HongzhongL/dsh-hotswap | Web 侧热启用/停用/重启（`entry.update({disabled})`）；watch `package.json`；把开关写进 profile patch 的**托管区块**；**保护名单**不可停用 | **保护名单**（哪些 entry 永远不许动）；`entry.update({disabled})` 是 Loader 级开关的正解 | 它允许写 profile；**本仓不写 profile** |
| `dsh-smart-restart` 0.5.1 | edusrez/dsh-smart-restart | 每次启动检测到新进程接管就用 notice 唤醒主 agent；工具记录调用方会话并把 notice 送回该会话；`SIGTERM`/`SIGINT` 时落 `shutdown-notice.json`；**canary 预检**（临时启动验证能否起来，失败就中止重启）；从 `/proc/self/cgroup` 识别 systemd | **canary 预检**（我们四道闸里没有这一道）；记录调用方会话；停机信号落盘 | 它是 **systemd/Linux 导向**；本仓验收主机是 Windows，闸④ 必须显式处理「拿不到启动命令」 |
| `dsh-restart` 0.1.2 | anweat/dsh-restart | 工具 `restart_harness`（可选 `delayMs`）+ `/restart` 命令 + 设置卡片。`legacyRestart` 默认关。重启 POST 只接受环回 + 同源。**自 0.1.3-alpha.4 移除内置 detached watchdog**，理由是交给外部管理器 | **「不自建看门狗」的判例**（他们做了又撤）；`delayMs`；环回 + 同源 | 我们的 §3 原写「spawn detached」——与它撤掉 watchdog 的决定**方向相反**，已改为「优先交给外部」 |
| `dsh-desktop-auto-restart` 0.1.0 | comer2031/dsh-desktop-auto-restart | Windows 桌面端：工具 `dsh_restart` `{reason, sessionIds, delaySeconds?}`。**工具默认不注册**。先写「待唤醒清单」再调脚本（默认 10 秒留给回执落盘）。**宿主繁忙时拒绝，调用方自己不算忙**；无 `force`。重启后按**原预设**走官方通道唤醒，**失败就保留清单下次重试**。只用「监听端口 + 精确 PID」定位 | 与我们 §2/§3 最接近的一份：闸② 语义、先落盘再重启、失败保留清单、端口+PID、默认关。另有三条硬信息：执行策略 `Restricted` 时脚本静默不执行而 WMI 仍返回 rc=0（**假成功**）；WMI 建进程会被安全软件记敏感动作；非桌面形态直接拒绝 | 它靠 PowerShell + WMI + user32，**只支持 Windows 桌面端** |

**未找到的包**（npm registry 404，2026-10-13）：`dsh-reload`、`dsh-host-restart`、`dsh-safety-restart`、`dsh-resume-on-restart`、`dsh-keep-going`。→ 记为「未找到」，不推断其存在。

**一处只作技术出处的引用**：`cordis-plugin-hmr` —— npm 上不存在（404），只出现在 `dsh-plugin-reload` 的自述里。本机相关的 hmr 包是 `@deepseek-ai/dsh-hmr` 与 `@deepseek-ai/dsh-client-hmr`。

**调研边界**：参考实现面向的**不是**本机运行时版本（本机 `0.2.1-alpha.2`）→ 涉及 API 形状的结论**必须回到本机运行时核对**，不能照抄。表里每一条与「我们已经实测过的东西」冲突的可能，都以本仓实测为准。
