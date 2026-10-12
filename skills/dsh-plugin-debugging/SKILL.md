---
name: dsh-plugin-debugging
description: Debugging a DSH plugin against a running DSH instance. Use when a change did not take effect, when unsure whether to reload/restart, when the page returns 401, or when setting up an isolated instance.
version: 2.1.4
author: Zayn
---

# DSH 插件排障

定位：**排障**。本技能管「改完没生效、要不要重启、401、隔离、拿凭证」；**写插件本身不在范围内**。

贯穿原理：**产物在不同时机被读取，读取时机决定改动后的动作。** 判断不清时先问：这份产物是什么时候被读的？

## 一、核心模型：生效机制三档

| 改了什么 | 生效方式 | 为什么 |
| --- | --- | --- |
| 配置 / patch / 启用状态 / 卸载 | **热生效** | loader 每次变更都重读，按行比较，只重建变化的行 |
| 新装 bundle | **热生效**；但该包已在 `dependencies` 里时 → **重启** | 全新装走 `reload()`；已在依赖中只改选择则报 `restart-required` |
| 已装插件宿主端代码 / 改插件依赖 | **必须重启** | 进程启动只装载一次模块；依赖变化改模块图 |
| 客户端代码 / 界面 | HMR 自动换入；未挂则构建 + 刷新 | 浏览器侧独立加载，与宿主模块缓存无关 |

**"热生效"的前提是 HMR 已挂**：`reload()` 在没有 `hmr` 服务时是空操作，此时任何变更都退化成 `restart-required`。判断前先确认 profile 里有 `hmr`（`Config.listConfigs` 查 `include:hmr`）。

差别不在「谁更麻烦」，而在**谁在读那份产物**：loader 每次重读配置，进程只在启动时装载代码，浏览器按资源指纹自行换入。

**推论**：凡「改代码没反应」，默认答案是重启；凡「改配置没反应」，默认答案是配置写错或落在被更高层整行覆盖的位置——配置本就该热生效。

## 二、判断流程

**先定模式**：工具列表里有 `cordis_inspect_list` → 有自检能力，§3.7 / §3.8 可用；没有 → 跳过那两节，只走下面的外部查法。

按序问，命中即停：

1. **改完没生效？** 分类：客户端 / 宿主端 / 配置，对照 §一。**别先重装**——重装只改安装形态，不改生效时机。配置存疑 → §3.8。
2. **插件加载了吗？** 有 `cordis_inspect_list` 就自检（`Config.listConfigs` 看 entry 在不在）；没有就外部查三处：`bundles`、形态（link/copy 见 §3.2）、进程。**三处都只证前置条件，不证加载成功**——Fiber 状态没有查询入口；启动失败看 `$DSH_HOME/logs/startup-*.log`（§3.8）。
3. **401？** 先分「连接被拒」（没启动）与「401」（服务在、认证没过）。401 再问端口变没变，见 §3.3。
4. **重装 / 重启 / 隔离？** 依次看 §3.2（重装）／§一（重启）／§3.6（隔离）。
5. **需要访问网页但没有 token / cookie？** → §3.4。（与 401 不同：可能还没访问过。）

## 三、事实库与理由

### 3.1 组合模型 —— 解释「装了却没启用」

- bundle 是**带 `dsh.bundle` 声明的 npm 包**，贡献一个 patch 层，不是插件本身。
- profile 的 `dsh.profile.bundles` 有序；加载序：各 bundle patch（按列表序）→ profile patch → home patch → `--patch`。
- **后层按行胜出，patch 替换整行 config，不深合并。**
- 于是「装了没生效」有两类原因：**没进 bundles**（层没激活），或 **config 被后层整行替换**。第三类（包没声明 `dsh.bundle`）见 §3.2。
- 为什么整行替换：每层结果可预测、可回滚；代价是覆盖一个字段要重写整行。

### 3.2 安装形态 —— 解释「要不要重装」

- `dsh plugin add ./<本地目录>` → **link**：改仓库即时生效，不用重装。
- `dsh plugin add <registry 包>` → **拷贝快照**：改源码不影响已装副本，需重装。
- 两种形态混存**正常**，由来源决定。
- `add` = pnpm 装依赖 + 包名追加进 `dsh.profile.bundles`。
- link 免重装的原理：link 只是指向仓库的入口，仓库产物就是被读产物，中间没有拷贝层。

**第三类原因：包有没有声明 `dsh.bundle`。** §3.1 的两类（没进 bundles / config 被覆盖）之外：

- **判据是 `dsh.bundle` 声明，与 link/copy 无关**：声明了 → 贡献 patch 层、**自动应用**（link 也一样）；没声明 → 只是普通依赖，**不贡献层**，`add` 会警告 `declares no dsh.bundle`，装它需要自己写条目。
- **`link`/`copy` 只决定"改源码要不要重装"**，不决定 patch 应不应用。别把两件事混成一件。
- profile patch 的条目往往**不是挂载**（行来自 bundle 层），而是**只覆盖 config**——`--dump-config` 的 `patched by <file>` 标注即此意。
- **官方约束**：不要手写 profile 的 `package.json` 依赖/bundles 列表（由 `add` 管理），不要在 `$DSH_HOME` 下建包，不要在 profile 目录跑 pnpm。

### 3.3 认证机制

- 有效 token 交换是 **303 + Set-Cookie → 200**，不是直接 200；拿 303 是成功。
- cookie 由 `.credentials.yaml` 的**持久签名密钥**签发，**30 天**，**绑定 authority（host:port）**。
- **30 天是死的，不滑动刷新**：全流程只有交换那一次 `set-cookie`，已认证请求只验签、不发新 cookie。所以「同端口重启照常可用」的边界就是这 30 天。
- 因此 **同端口重启旧标签页照常可用**；**换端口才 401**。旧 launch token 重启后失效 → 401；连接被拒 = 没启动。
- 「token 不落盘」**不准确**：准确说是 **launch token 不落盘，签名密钥落盘**。这个区别是 §3.4 的全部理由。

### 3.4 凭证获取 —— 怎么拿（为什么通常不用问人）

**首选**读 `$DSH_HOME/.credentials.yaml` 中 `client-connection/browser-session` 的 secret，自签 cookie（名 `dsh-auth-<base64url(sha256(authority))>`）直接访问，不依赖日志或终端；**兜底**才让用户从终端或地址栏复制。

**别扫进程内存**：对**主实例基本不可用**——主进程内存就装着当前会话记录（含历史 token），必然污染判定；只对隔离实例干净。

**别再试的两条**：读进程环境变量（token 是进程内对象，env 里只有**不含 token** 的 `DSH_WEB_URL`）；读启动终端（ConPTY 无传统控制台缓冲区，UI Automation 只有可视区）。

**首选成立的原理**：cookie 验证只依赖签名密钥与 authority，与 launch token 无关——token 只是首次进入的敲门砖，不是长期凭证。**边界**：独立 `DSH_HOME` = 独立 credentials = 独立 cookie secret。

### 3.5 进程识别

按端口：`Get-NetTCPConnection -LocalPort <port> -State Listen`，唯一准确。不要用命令行子串（如 `*bin.js*`）过滤，会误匹配派生的 shell 子进程。

### 3.6 隔离实例

必须带 `--from-default-profile <template>`，否则新 `DSH_HOME` 下没有 profile 可启动而报错。独立 `DSH_HOME` 才真正隔离：数据、credentials、cookie secret 全独立。

`<template>` 常用 `web`；**合法值以报错枚举为准**（填错会打印 `unknown default profile …; expected one of …`），勿硬编码。

### 3.7 client 查询失败：`Client failure` ≠ 没有页面

client 查询的三态措辞在工具描述里可见，不重复。**只记这个反直觉点**：`Client failure: <msg>` 看着像「没页面，重试吧」，实际是**页面在线**的证据——它只在 handler 抛错后出现，`<msg>` 才是真错因。「没有在线页面」是另一条措辞。据此把「没页面」与「页面在、插件代码炸了」分开，正是排插件要的区分。Host 查询不走这条路（本地直接返回）。

### 3.8 插件真的加载失败了吗

**Fiber 级状态没有查询入口**。`Config.listConfigs` 的 **Config 状态**（`schema` / `absent` / `unsupported` / `tree` / `inactive`）运行期可查，但 `inactive` 混合了「禁用 / 未导入 / 已销毁」三义，**从不报 FAILED**——它答不了"崩没崩"。要确认得看：

- **启动期**有硬证据：必需插件没激活会让启动直接失败，并把完整诊断写到 `$DSH_HOME/logs/startup-<ISO>-<uuid>.log`（**只在启动失败时生成**，不是常驻日志），同时把路径打到终端。
- **运行期**：查该插件应有的注册面（工具、slot、服务）是否缺失，并回看它在启动报告里是否已被点名。
- **配置写错了**：`dsh --profile <p> --dump-config-schema`，看 `x-cordis.diagnostics`（也打到 stderr）。它同时覆盖**组合期错**（`patch: name mismatch` / `entry not found`，会被 `skipping` **整条丢弃**）与 **schema 层问题**；**退出码 1 = 有 error**。
  - 但 **error 可能是误报**（如官方 `preset-*` 行的 `config.plugins` 会报 `unrecognized Loader tree carrier`）：先看 error 的 `path` 是否指向**你改过的行**，再当问题。
- 只要配置树、不要三万多行 JSON：`--dump-config`——stderr 仍报组合期错，但**不做 schema 校验**，且**退出码恒 0，别拿它当门禁**。

## 四、命令参考

占位符：`<port>`、`<profile>`、`<plugin-repo>`、`<DSH_HOME>`、`<包名>`。

```powershell
# 进程（按端口，唯一可靠）；产物比进程新 = 宿主端是旧产物
$conn = Get-NetTCPConnection -LocalPort <port> -State Listen
Get-CimInstance Win32_Process -Filter "ProcessId=$($conn.OwningProcess)" | Select-Object CreationDate
(Get-Item <plugin-repo>\lib\index.js).LastWriteTime

# 安装形态：SymbolicLink=link；普通目录=拷贝
Get-Item "<DSH_HOME>\profiles\<profile>\node_modules\<包名>" | Select-Object LinkType, Target

# 安装 / 列表
dsh plugin --profile <profile> add <plugin-repo>   # 本地目录 -> link
dsh plugin --profile <profile> add <registry 包>    # registry -> 拷贝

# 核对组合结果（配置错位时最有用）；`patched by <file>` = 该行被该层改过，
# 无标注的行来自 bundle 层（不是 profile patch 挂的）
# 注意：退出码恒 0，不能拿它判断配置好坏
dsh --profile <profile> --dump-config | Select-String -Pattern '<行 id>' -Context 0,8

# 验配置：看 x-cordis.diagnostics（覆盖组合期错 + schema 层）；退出码 1 = 有 error
dsh --profile <profile> --dump-config-schema

# 加载：entry 在不在、Config 状态为何（inactive 不区分崩溃与禁用）
#   启动失败才会生成完整诊断 → $DSH_HOME\logs\startup-*.log

# 隔离实例（缺 --from-default-profile 会报 profile does not exist）
$env:DSH_HOME = "<独立目录>"
dsh --profile <新 profile> --from-default-profile <template> --port <未占用端口> --no-open

# 认证自检：401=服务活着且认证生效；连接被拒=没启动
try { Invoke-WebRequest "http://127.0.0.1:<port>/" -MaximumRedirection 0 } `
catch { $_.Exception.Response.StatusCode.value__ }

# 自签 cookie：取 client-connection/browser-session 的 32B secret（字段均为必填，编码已实测）
#   name  = "dsh-auth-" + base64url(sha256("<host>:<port>"))     # 摘要 43；前缀 9，完整名 52
#   body  = base64url(JSON)                                      # 键序无关
#   value = "v1." + body + "." + base64url(HMAC-SHA256(secret, body))
#   JSON  = {"version":1,"authority":"<host>:<port>","issuedAt":ms,"expiresAt":ms}
# 要点：签的是 body 这个字符串本身（不是原始 JSON）；authority 必须与实际 Host 逐字一致
#       （含端口，且 localhost 与 127.0.0.1 不通用），否则 401。
```

## 五、边界：管什么、不管什么

**管**：装载时机与生效判断（§一）、安装形态与 patch 层归属（§3.1–3.2）、加载状态查询（§3.7–3.8）、认证与凭证（§3.3–3.4）、进程与端口（§3.5）、隔离实例（§3.6）。

**不管**：插件代码怎么写、扩展点选哪个、模板长什么样、preset 怎么改、可安装包有哪些——这些要另找对应资料。

边界上的一处重叠：§3.2 讲 patch 条目，只为判断「这行为什么在这个层」，不涉及 patch 方言的完整写法。
