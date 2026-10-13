# 隔离台（bench）配方 —— 本机红线，不是 CI 作业

> **先说结论：`--patch` 单用不足以验工具注册。**
> 组合树里出现这一行，不等于运行期它挂上了 —— 必须让包能从**被启动 profile 的目录**解析到。

本目录有两条本机红线：`bench-s1.ps1`（隔离实例 + 本插件真的挂上）与 `leak-fix.ps1`
（动态 scope 注册的「停用即解开」——含 task-13 抓到的那个泄漏的对照）。两者都自带 setup 与自还原。

## 0. 定位：本机红线，**不进 CI**

**理由**：它要求四件事同时成立 —— 本机装了 `dsh`（且在 PATH 上）、能建目录 junction、有**空闲端口**、
并且会**真起一个 web 服务**。CI 是单 ubuntu + 共享 runner，起服务会直接引入 flake，
而这些依赖在 CI 里属于「要额外搭一套」而不是「白拿」。

CI 的门禁由 `scripts/check-release.mjs` 与 `npm test`（含红线）承担；本脚本是**发布前在本机手动跑**的那一道。
原始证据（本轮验证报告）只在工作区本机留档，**不随本仓发布**；上面两个脚本本身就是可复跑的判据。

## 1. 它验什么

| 判据 | 内容 |
|---|---|
| S1-a | `--dump-config` 里出现本插件的行，且来源头 `# == <本仓 cordis.patch.yml 绝对路径>` |
| S1-b | `--dump-config-schema` 的 error **不落在**本插件的行上（`preset-*` 的 `unrecognized Loader tree carrier` 是已知误报） |
| S1-c | 隔离实例真的起来，且 `pluginInventory/list` 报本插件 `fiberPhase=active` |
| 收尾 | 杀掉自己起的实例并复核端口已释放（`finally`，失败路径也走） |

## 2. 跑法

```powershell
pwsh -NoProfile -File test/integration/bench-s1.ps1
# 换端口 / 换台子目录：
pwsh -NoProfile -File test/integration/bench-s1.ps1 -Port 18399
```

退出码 `0` = 三条判据全过；`1` = 有失败（逐条打印失败原因）。默认端口 `18331`，默认台子目录见下。

## 3. 手工复现（脚本里的同一条路，可复制）

```powershell
$repo        = '<本仓根>'                                                   # 例：<工作区>\dsh-plugin-debugging
$bench       = '<工作区>\.local\bench-dsh-plugin-debugging'
$profileName = 'bench'      # 变量名避开 PS 自动变量 $PROFILE；不得用 acp/headless/sdk/sdk-minimal/web（shipped 名）
$port        = 18331        # 必须避开 3080（本机宿主占用）

# ① 独立 DSH_HOME：只影响本 shell 起的子进程，不碰 ~/.dsh
New-Item -ItemType Directory -Force -Path $bench | Out-Null
$env:DSH_HOME = $bench

# ② 建 profile：只此一次，必须带 --from-default-profile
dsh --profile $profileName --from-default-profile web --dump-config | Out-Null

# ③ 让裸包名能被「该 profile」解析到 —— 这一步不能省，理由见 §4
New-Item -ItemType Directory -Force -Path "$bench\profiles\$profileName\node_modules" | Out-Null
New-Item -ItemType Junction -Path "$bench\profiles\$profileName\node_modules\dsh-plugin-debugging" -Target $repo

# ④ S1-a 组合层
dsh --profile $profileName --patch "$repo\cordis.patch.yml" --dump-config

# ⑤ S1-b 投影层（只有它的退出码能当门禁）
dsh --profile $profileName --patch "$repo\cordis.patch.yml" --dump-config-schema

# ⑥ 真启动
dsh --profile $profileName --patch "$repo\cordis.patch.yml" --port $port --no-open
```

关掉：`Stop-Process -Id <nodePid> -Force`，然后确认 `netstat -ano | Select-String ":<port>.*LISTENING"` 为空。
`$env:DSH_HOME` 随 shell 结束消失（**不要**用 `SetEnvironmentVariable` 写用户/机器级）。

## 4. 为什么 ③ 的 junction 是必需的

`cordis.patch.yml` 的 `insert:` 用的是**裸包名** `dsh-plugin-debugging`。
`anchorInsertedPluginNames` 只把**绝对路径 / `./` / `../`** 转成 file URL，裸名原样保留；
挂载时按**被启动 profile 的目录**做裸导入解析。解析不到时：

- `--dump-config`：**照样有这一行**，退出码 0
- `--dump-config-schema`：该行报 `Cannot find package 'dsh-plugin-debugging' imported from <profile>\cordis.yml`
- 真启动：实例照常起来，stderr 只有 `dsh: warning: 1 entry did not activate` + `dsh-plugin-debugging (dsh-plugin-debugging): failed to import`

即 **行在、功能不在**。所以「`--patch` 单用不足以验工具注册」；本脚本一律先建 junction。
（等价替代：`dsh plugin --profile <p> add <本仓>` —— 那个会走 pnpm 真装包，本脚本不用它。）

## 5. 失败特征速查（全部实测）

```
# 台子/profile 层
Error: dsh: profile "benchY" does not exist; create it with 'dsh plugin --profile benchY add <package>'
Error: dsh: profile "bench" already exists at <bench>\profiles\bench\package.json; omit --from-default-profile to use it
Error: dsh: unknown default profile "nosuch"; expected one of "acp", "headless", "sdk", "sdk-minimal", "web"
Error: dsh: profile "web" is shipped and cannot be a custom profile target; omit --from-default-profile to use it

# 「插件不见了」的四种成因（都不改退出码）
dsh: skipping profile bundle "X": Error: dsh: profile bundle "X" declares no dsh.bundle in its package.json   # 没声明 dsh.bundle
#（什么都没打印，也没行）                                                                                    # 没进 dsh.profile.bundles
dsh: [<层>] patch: name mismatch for "X" (expected "…", got "…"), skipping                                    # 后层 patch 被丢
dsh: warning: 1 entry did not activate / <name> (<name>): failed to import                                    # 裸名不可解析

# 401 vs 连不上（本插件工具要排障的两件事）
#   /api/* 不带 cookie → 401；服务没起来 → 连接被拒
```

## 6. 已知边界

- **`--dump-config` 的退出码恒为 0**，任何场景都不能当门禁；能用退出码的只有 `--dump-config-schema`（1 = 有 error）。
- 判定**不硬编码行下标**：脚本从 `x-cordis.entries` 里按 `id=dsh-plugin-debugging` 取该行的 `path` 再比对 error，preset 数量漂移不会让它假绿/假红。
- `pluginInventory/list` 的 payload **必须是 `{args:{}}`**（否则报 `Remote payload must contain exactly one plain-object args field`）；token 在启动打印的 URL 里，用它换一次页面即可拿到 `dsh-auth-*` cookie。
- 台子目录在工作区 `.gitignore` 的 `/.local/` 之下，**不进任何仓库历史**；脚本从不删目录，原始输出留在 `<bench>\logs\`。
- **别碰宿主**：宿主监听 **3080**。两个脚本都**按 `-HostPort`（默认 3080）现查**它的 pid
  （`netstat -ano | Select-String ':3080\s.*LISTENING'`），收尾清扫时把它排除在外。
  **绝不写常数**：宿主重启过多次，写死的 pid 会指向别的进程，保护就会**静默失效**。
  **查不到宿主 pid 时是 fail-safe**：`Get-SweepPids` 返回空集 = **一个 pid 都不杀**（宁可留下自己的台子，
  也不误杀主实例；代价是末尾的「端口仍被占用」会报红，不会静默过去）。
