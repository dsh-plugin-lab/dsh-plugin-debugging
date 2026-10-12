# leak-fix.ps1 —— 动态 scope 注册「泄漏与解开」的可重复红线
#
# 定位：**本机红线，不是 CI 作业。**
#   它要求本机装了 dsh（在 PATH 上）、能建目录 junction、有**空闲端口**，并且会**真起一个 web 服务**。
#   CI 是单 ubuntu + 共享 runner，起服务会直接引入 flake；那些依赖在 CI 里属于「要额外搭一套」。
#   它验的是**宿主的运行期行为**（fiber 作用域解开、Loader 行的 live 停用），不是本仓单测能覆盖的。
#
# 这一条守的是什么（对应 AGENTS.md 活跃坑第 28 条）：
#   `SkillRegistry.register` 内部是 `this.layers.effect(this.ctx, …)`，而 `this.ctx` 是**那个作用域自己的
#   ctx（= agent）**。所以「往 agent 作用域里注册」时，如果**不把返回的 disposer 收进我们自己的 fiber**
#   （`ctx.effect(function* () { yield scopedRegistry.register(...) })`），生命周期就只绑在 agent 上：
#   **停用插件后，停用前已存在的 agent 仍认为本插件赢，而同一次停用之后新开的会话已退回用户级。**
#   同一时刻两种结论 —— 看起来像随机故障，实际是泄漏。
#
# 本脚本就把「停用前已存在的 agent (a)」与「停用后新开的会话 (b)」**在同一时刻**各读一次 ——
#   两条必须**同为 MARKER**才算过。(a)/(b) 不一致就是泄漏的定义；只问「停用后技能还在吗」抓不到它。
#
# ⚠️ 一个值钱的坑，别当成 bug 查：`pluginManager/setPluginEnabled` 只**改写 profile 的 patch 文件**，
#   要让它在**运行期真的生效**，profile 的 `dsh.profile.patchReload` 必须是 **"live"**。
#   不加它：调用返回 `{ application: "overridden" }`、**行仍 enabled:true / fiberPhase:active**，
#   停用看起来「没反应」—— 这正是本脚本开头要把它写进去的原因。
#   另一个坑：插件行若来自 `--patch` 覆盖层，profile 里的 `disabled: true` 补丁会**先于**覆盖层的
#   insert 执行（命中不到），停用同样不生效。所以本脚本让插件行由 **profile 自己 insert**。
#
# 判据（任一失败即非 0 退出）：
#   L-a 基线：插件启用时，宿主开的会话里 winner = 本插件（runtime 注册的特征：**没有 path**）
#   L-b 停用后：(a) 停用前已存在的 agent 与 (b) 停用后新开的会话，**两条都**退回 MARKER（有 path）
#   L-c 重新启用：两条都回到本插件（证明可逆、不是单向坏掉）
#   L-d 不重复撤销：多轮 停用/启用 之后，实例 stderr **无线程级错误**，且行为仍与 L-a/L-b 一致
#
# 自还原（finally 里，失败路径也走）：杀自己起的实例 → 还原 profile 的 cordis.patch.yml 与
#   package.json 的 patchReload → 还原 junction → 复核端口已释放。
#
# 独占资源纪律：只碰自己的 $BenchHome 与 $Port；绝不动正在跑的宿主
#   （3080 / C:\Users\speak\.dsh / pid 34216 一律不碰，端口必须另选）。
#   真实 `~/.agents/skills` 只读 —— 本脚本**不碰**它。
#
# 用法（pwsh 7）：
#   pwsh -NoProfile -File test/integration/leak-fix.ps1
#   pwsh -NoProfile -File test/integration/leak-fix.ps1 -Port 18394

[CmdletBinding()]
param(
  # 隔离实例监听的端口；默认值刻意避开 3080（本机宿主占用）
  [int]$Port = 18394,
  # 本机资产目录：枢纽仓 .gitignore 的 /.local/ 之下，不进任何仓库历史
  [string]$BenchHome = 'D:\ProjectSomething\dsh-plugins\.local\bench-dsh-plugin-debugging',
  # 隔离 profile 名（变量名避开 PS 自动变量 $PROFILE）；不得用 acp/headless/sdk/sdk-minimal/web（shipped 名）
  [string]$ProfileName = 'bench',
  # 本会话宿主的 pid：只用于前置自检，绝不发信号
  [int]$HostPid = 34216
)

$ErrorActionPreference = 'Stop'

$RepoRoot    = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$ProfileDir  = Join-Path $BenchHome "profiles\$ProfileName"
$ProfilePatch= Join-Path $ProfileDir 'cordis.patch.yml'
$ProfilePkg  = Join-Path $ProfileDir 'package.json'
$Junction    = Join-Path $ProfileDir 'node_modules\dsh-plugin-debugging'
$MarkerSkill = Join-Path $BenchHome 'skills\dsh-plugin-debugging\SKILL.md'
$LogDir      = Join-Path $BenchHome 'logs'

$Failures    = New-Object System.Collections.Generic.List[string]
$BootProcess = $null
# 自还原用的原件（读了才写，写前先存）
$OrigPatch   = $null
$OrigPkg     = $null

function Step([string]$Text) { Write-Host "`n=== $Text ===" -ForegroundColor Cyan }
function Ok([string]$Text)   { Write-Host "  [PASS] $Text" -ForegroundColor Green }
function Note([string]$Text) { Write-Host "  [INFO] $Text" -ForegroundColor DarkGray }
function Bad([string]$Text) {
  Write-Host "  [FAIL] $Text" -ForegroundColor Red
  $script:Failures.Add($Text)
}

function Test-PortListening([int]$P) {
  return [bool](netstat -ano | Select-String (':{0}\s.*LISTENING' -f $P))
}

function Get-ListenerPids([int]$P) {
  return @(netstat -ano | Select-String (':{0}\s.*LISTENING' -f $P) |
    ForEach-Object { ($_.Line -split '\s+')[-1] } | Sort-Object -Unique |
    Where-Object { $_ -match '^\d+$' -and [int]$_ -ne $HostPid })
}

# 把 UTF-8 无 BOM 写回文件（profile 的 JSON / YAML 都是 UTF-8 无 BOM）
function Write-Utf8NoBom([string]$Path, [string]$Text) {
  [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false)))
}

# ── RPC：宿主 /api 是 HTTP POST JSON-RPC，且需要带 dsh-auth-* cookie ──
$script:RpcBase = $null
$script:RpcSess = $null
function Connect-Api([string]$Url) {
  # **必须带 token 请求一次**才会拿到 dsh-auth-* cookie：宿主对不带 cookie 的 `/` 返回 401
  # （这是有意的鉴权行为，不是故障 —— 不带 cookie 的 `/` 返回 401 是宿主的鉴权设计）。
  $null = Invoke-WebRequest $Url -UseBasicParsing -SessionVariable s -TimeoutSec 15
  $script:RpcSess = $s
  $script:RpcBase = ($Url -replace '\?.*$', '').TrimEnd('/')
}
# 参数名刻意不叫 $Args —— 它会与 PS 自动变量 $args（未绑定参数数组）同名，
# 于是调用方传进来的哈希表会被当成 Object[] 绑定，报「无法转换为 Hashtable」。
function Invoke-Rpc([string]$Method, [hashtable]$RpcParams) {
  $body = @{
    type = 'client-request'
    rpcId = [guid]::NewGuid().ToString()
    method = $Method
    payload = @{ args = $RpcParams }
  } | ConvertTo-Json -Compress -Depth 16
  $resp = Invoke-WebRequest "$($script:RpcBase)/api/$Method" -Method POST -ContentType 'application/json' `
    -Body $body -WebSession $script:RpcSess -UseBasicParsing -TimeoutSec 60
  return ($resp.Content | ConvertFrom-Json)
}

# 判 winner：runtime 注册的特征是**没有 path**；文件系统来的候选一定带 path。
# 刻意不比对 description 文本 —— 那会在改文案时假红；path 的有无是结构性判据。
function Get-Winner([string]$SessionId) {
  $r = Invoke-Rpc 'skills/list' @{ request = @{ sessionId = $SessionId } }
  if ($r.result.ok -ne $true) { return [pscustomobject]@{ Kind = 'rpc-error'; Raw = ($r.result.error | ConvertTo-Json -Compress) } }
  $hit = @($r.result.value.skills | Where-Object { $_.name -eq 'dsh-plugin-debugging' })
  if ($hit.Count -eq 0) { return [pscustomobject]@{ Kind = 'absent'; Raw = '<catalog 里没有该技能>' } }
  $w = $hit[0]
  $kind = if ($null -eq $w.path -or '' -eq [string]$w.path) { 'plugin-runtime' } else { 'marker-file' }
  return [pscustomobject]@{ Kind = $kind; Raw = ($w | ConvertTo-Json -Compress -Depth 6) }
}

function New-Session() {
  $r = Invoke-Rpc 'session/create' @{ request = @{ cwd = (Join-Path $BenchHome 'project') } }
  if ($r.result.ok -ne $true) { throw "session/create 失败：$($r.result.error | ConvertTo-Json -Compress)" }
  return $r.result.value.sessionId
}

function Set-PluginEnabled([bool]$Enabled) {
  $r = Invoke-Rpc 'pluginManager/setPluginEnabled' @{ id = 'include:dsh-plugin-debugging'; enabled = $Enabled }
  if ($r.result.ok -ne $true) { throw "setPluginEnabled 失败：$($r.result.error | ConvertTo-Json -Compress)" }
  return $r.result.value
}

# ── 前置 ─────────────────────────────────────────────────────────────
Step '前置检查'
if ($Port -eq 3080) { throw '拒绝在 3080 上起台子：那是本会话宿主的端口' }
if (Test-PortListening $Port) { throw "端口 $Port 已被占用，换一个 -Port" }
Ok "端口 $Port 空闲"
if (-not (Test-Path $MarkerSkill)) {
  throw "缺少同名 MARKER 技能：$MarkerSkill（没有它就没有「争」的对手，L-b 无从判定）"
}
Ok "MARKER 同名技能在（用户级，rank 400）：$MarkerSkill"
foreach ($p in @((Join-Path $BenchHome 'project\.dsh\skills\dsh-plugin-debugging\SKILL.md'),
                 (Join-Path $BenchHome 'project\.agents\skills\dsh-plugin-debugging\SKILL.md'))) {
  if (Test-Path $p) { throw "项目根不该有同名技能（rank 100/200 会先赢，盖掉我们要看的对照）：$p" }
}
Ok '项目根无同名技能（否则 100/200 会先赢）'
if (-not (Test-Path $ProfileDir)) { throw "profile 不存在：$ProfileDir（先跑 bench-s1.ps1 建台子）" }
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

try {
  # ── ① 独立 DSH_HOME ────────────────────────────────────────────────
  Step '① 独立 DSH_HOME'
  $env:DSH_HOME = $BenchHome
  $env:DSH_AGENTS_HOME = Join-Path $BenchHome 'agents'
  $env:DSH_TELEMETRY_DISABLED = '1'
  Note "DSH_HOME = $env:DSH_HOME（只在本进程环境内，不写用户/机器级）"

  # ── ② 让裸包名可从本 profile 解析 ──────────────────────────────────
  Step '② 让 dsh-plugin-debugging 可从本 profile 解析（junction）'
  New-Item -ItemType Directory -Force -Path (Split-Path $Junction) | Out-Null
  if (Test-Path $Junction) { Ok "junction 已在：$Junction" }
  else {
    New-Item -ItemType Junction -Path $Junction -Target $RepoRoot | Out-Null
    Ok "建立 junction -> $RepoRoot"
  }

  # ── ③ 改 bench profile：插件行由 profile 自己 insert + patchReload live ──
  #    （两处都必须，理由见文件头注释；两处都在 finally 里还原）
  Step '③ bench profile：profile-insert 插件行 + patchReload=live'
  $OrigPatch = [IO.File]::ReadAllText($ProfilePatch)
  $OrigPkg   = [IO.File]::ReadAllText($ProfilePkg)

  Write-Utf8NoBom $ProfilePatch @"
- insert:
    - id: dsh-plugin-debugging
      name: dsh-plugin-debugging
"@
  Note "cordis.patch.yml 已写成 profile-insert（原件已留存，收尾还原）"

  $pkg = $OrigPkg | ConvertFrom-Json
  $pkg.dsh.profile | Add-Member -NotePropertyName 'patchReload' -NotePropertyValue 'live' -Force
  Write-Utf8NoBom $ProfilePkg (($pkg | ConvertTo-Json -Depth 8) + "`n")
  Note "package.json 已设 dsh.profile.patchReload=live（不加它 setPluginEnabled 只返回 overridden 而不生效）"

  # ── ④ 起隔离实例 ───────────────────────────────────────────────────
  Step "④ 起隔离实例（127.0.0.1:$Port，**不加** --patch）"
  $bootOut = Join-Path $LogDir 'leakfix-boot.out.txt'
  $bootErr = Join-Path $LogDir 'leakfix-boot.err.txt'
  $BootProcess = Start-Process -FilePath 'cmd.exe' -PassThru -WindowStyle Hidden -ArgumentList @(
    '/c', "dsh --profile $ProfileName --port $Port --no-open 1> `"$bootOut`" 2> `"$bootErr`""
  )

  $url = $null
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    $txt = [string](Get-Content $bootOut -Raw -ErrorAction SilentlyContinue)
    $m = [regex]::Match($txt, 'http://127\.0\.0\.1:(\d+)/\?token=([A-Za-z0-9_\-]+)')
    if ($m.Success) { $url = $m.Value; break }
  }
  if ($null -eq $url) { throw "10 秒内没打印 URL；stderr=$([string](Get-Content $bootErr -Raw -ErrorAction SilentlyContinue))" }
  Ok "实例已起：$url"
  Connect-Api $url
  Note "boot stderr（原始）：$([string](Get-Content $bootErr -Raw -ErrorAction SilentlyContinue))"

  # ── L-a 基线 ───────────────────────────────────────────────────────
  Step 'L-a 基线：插件启用时，宿主开的会话里 winner = 本插件'
  $agentX = New-Session
  Start-Sleep -Seconds 2
  $w = Get-Winner $agentX
  Note "agent X = $agentX"
  Note "winner 原始 = $($w.Raw)"
  if ($w.Kind -eq 'plugin-runtime') { Ok 'winner = 本插件（runtime 注册，无 path）' }
  else { Bad "基线不成立：winner 种类 = $($w.Kind)（期望 plugin-runtime）" }

  # ── L-b 停用：两条都要退回 MARKER（这就是泄漏的定义）──────────────
  Step 'L-b 停用插件本体 → (a) 存量 agent 与 (b) 新会话**都要**退回 MARKER'
  $chg = Set-PluginEnabled $false
  Note "setPluginEnabled(false) → application=$($chg.application) changed=$($chg.changed)"
  Start-Sleep -Seconds 8
  $rows = @((Invoke-Rpc 'pluginInventory/list' @{}).result.value.entries |
    Where-Object { $_.moduleName -eq 'dsh-plugin-debugging' })
  Note "插件行 = $(($rows | Select-Object enabled, fiberPhase | ConvertTo-Json -Compress))"

  $a = Get-Winner $agentX
  Note "(a) 停用**之前**已存在的 agent X  winner 原始 = $($a.Raw)"
  if ($a.Kind -eq 'marker-file') { Ok '(a) 存量 agent 已退回 MARKER（不再泄漏）' }
  else { Bad "(a) 存量 agent 仍判 $($a.Kind) —— 注册泄漏未修好" }

  $newSid = New-Session
  Start-Sleep -Seconds 2
  $b = Get-Winner $newSid
  Note "(b) 停用**之后**新开的会话      winner 原始 = $($b.Raw)"
  if ($b.Kind -eq 'marker-file') { Ok '(b) 新会话退回 MARKER' }
  else { Bad "(b) 新会话判 $($b.Kind)（期望 marker-file）" }

  if ($a.Kind -eq $b.Kind) { Ok "(a)/(b) 结论一致（$($a.Kind)）——这正是 task-13 里不一致的那对" }
  else { Bad "(a) 与 (b) 结论不一致：(a)=$($a.Kind) vs (b)=$($b.Kind)" }

  # ── L-c 重新启用：两条都要回到本插件 ───────────────────────────────
  Step 'L-c 重新启用 → 两条都回到本插件（证明可逆）'
  $chg = Set-PluginEnabled $true
  Note "setPluginEnabled(true) → application=$($chg.application) changed=$($chg.changed)"
  Start-Sleep -Seconds 8
  $a2 = Get-Winner $agentX
  Note "(a) 重新启用后 X     = $($a2.Raw)"
  $c2 = New-Session
  Start-Sleep -Seconds 2
  $b2 = Get-Winner $c2
  Note "(b) 重新启用后新会话 = $($b2.Raw)"
  if ($a2.Kind -eq 'plugin-runtime' -and $b2.Kind -eq 'plugin-runtime') { Ok '重新启用后两条都回到本插件' }
  else { Bad "重新启用后可逆性不成立：(a)=$($a2.Kind) (b)=$($b2.Kind)" }

  # ── L-d 不重复撤销：多轮切换后无错误、行为仍一致 ───────────────────
  Step 'L-d 不重复撤销：再切一轮 停用→启用，确认无错误、无二次撤销副作用'
  $null = Set-PluginEnabled $false
  Start-Sleep -Seconds 6
  $d1 = Get-Winner $agentX
  $null = Set-PluginEnabled $true
  Start-Sleep -Seconds 6
  $d2 = Get-Winner $agentX
  Note "第二轮 停用后 X = $($d1.Kind) ；启用后 X = $($d2.Kind)"
  if ($d1.Kind -eq 'marker-file' -and $d2.Kind -eq 'plugin-runtime') { Ok '第二轮仍然可逆（同一 disposer 被两个 owner 持有，撤销幂等）' }
  else { Bad "第二轮可逆性不成立：停用后=$($d1.Kind) 启用后=$($d2.Kind)" }

  $errText = [string](Get-Content $bootErr -Raw -ErrorAction SilentlyContinue)
  $errLines = @($errText -split "`r?`n" | Where-Object { $_ -match 'error|Error|\[ERR\]|throw|unhandled' })
  if ($errLines.Count -eq 0) { Ok '实例 stderr 无线程级错误（重复撤销没有可见副作用）' }
  else { Bad "实例 stderr 出现错误行：`n$($errLines -join "`n")" }
}
catch {
  Bad "脚本异常：$($_.Exception.Message)"
}
finally {
  # ── 自还原（失败路径也走）──────────────────────────────────────────
  Step '收尾：还原 bench 三处 + 释放端口'
  if ($null -ne $BootProcess) {
    foreach ($p in (Get-ListenerPids $Port)) {
      Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
      Note "已终止实例 pid $p"
    }
    Stop-Process -Id $BootProcess.Id -Force -ErrorAction SilentlyContinue
  }
  foreach ($p in (Get-ListenerPids $Port)) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2

  if ($null -ne $OrigPatch) { Write-Utf8NoBom $ProfilePatch $OrigPatch; Note 'cordis.patch.yml 已还原为原件' }
  if ($null -ne $OrigPkg)   { Write-Utf8NoBom $ProfilePkg   $OrigPkg;   Note 'package.json 已还原为原件（patchReload 撤销）' }
  Note "junction 保持指向本仓：$(Test-Path $Junction)（台子配方需要它，故意不撤）"

  if (Test-PortListening $Port) { Bad "端口 $Port 仍在监听（未释放）" } else { Ok "端口 $Port 已释放" }
}

Step '判定'
if ($Failures.Count -eq 0) {
  Write-Host "  全部通过：泄漏已修好，两条路都解开，且可逆。" -ForegroundColor Green
  exit 0
}
Write-Host "  失败 $($Failures.Count) 条：" -ForegroundColor Red
foreach ($f in $Failures) { Write-Host "    - $f" -ForegroundColor Red }
exit 1
