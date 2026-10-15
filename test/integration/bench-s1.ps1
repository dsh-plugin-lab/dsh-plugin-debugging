# bench-s1.ps1 —— S1「组合层最小 bundle」的可重复红线
#
# 定位：**本机红线，不是 CI 作业。**
#   它要求本机装了 dsh（在 PATH 上）、能建目录 junction、有**空闲端口**，并且会**真起一个 web 服务**。
#   CI 是单 ubuntu + 共享 runner，起服务会直接引入 flake；这些依赖在 CI 里属于「要额外搭一套」。
#   CI 的门禁由 scripts/check-release.mjs 与 pnpm test（含红线）承担；本脚本是发布前在本机手动跑的那一道。
#
# 判据与配方的一处事实来源：test/integration/README.md（排错表、失败特征、为什么需要 junction）
# 原始证据（本轮验证报告）留在工作区本机，**不随本仓发布** —— 本脚本自身即是可复跑的判据。
# 本脚本只做验证，不改被测仓的 src/**、package.json、.github/**。
#
# 它做三件事，任一步失败即以非 0 退出：
#   S1-a  --dump-config 里出现本插件的行，且 # == 头标出本仓 cordis.patch.yml
#   S1-b  --dump-config-schema 的 error 不落在本插件的行上
#   S1-c  隔离实例真的起来，且 pluginInventory 报本插件 fiberPhase=active
# 收尾在 finally 里：杀掉自己起的实例并复核端口已释放（失败路径也走）。
#
# 独占资源纪律：只碰自己的 $BenchHome 与 $Port；绝不动正在跑的宿主
# （3080 / C:\Users\speak\.dsh 一律不碰，端口必须另选）。
# 宿主 pid **按 -HostPort 现查**、不写常数；**查不到就一个 pid 都不杀**（fail-safe）。
#
# 用法（pwsh 7）：
#   pwsh -NoProfile -File test/integration/bench-s1.ps1
#   pwsh -NoProfile -File test/integration/bench-s1.ps1 -Port 18399

[CmdletBinding()]
param(
  # 隔离实例监听的端口；默认值刻意避开 3080（本机宿主占用）
  [int]$Port = 18331,
  # 本机资产目录：枢纽仓 .gitignore 的 /.local/ 之下，不进任何仓库历史
  [string]$BenchHome = 'D:\ProjectSomething\dsh-plugins\.local\bench-dsh-plugin-debugging',
  # 隔离 profile 名（变量名避开 PS 自动变量 $PROFILE）；不得用 acp/headless/sdk/sdk-minimal/web（shipped 名）
  [string]$ProfileName = 'bench',
  # 本会话宿主**监听的端口**：只用于收尾前**现查**宿主 pid 并把它排除在清扫之外，绝不发信号给它。
  # （原先收尾里内联写死 34216 —— 宿主重启后该值指向别的进程或已不存在，保护**静默失效**。）
  [int]$HostPort = 3080
)

$ErrorActionPreference = 'Stop'

$RepoRoot   = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$PatchFile  = Join-Path $RepoRoot 'cordis.patch.yml'
$ProfileDir = Join-Path $BenchHome "profiles\$ProfileName"
$LogDir     = Join-Path $BenchHome 'logs'
$Junction   = Join-Path $ProfileDir 'node_modules\dsh-plugin-debugging'

$Failures     = New-Object System.Collections.Generic.List[string]
$BootProcess  = $null

function Step([string]$Text) { Write-Host "`n=== $Text ===" -ForegroundColor Cyan }
function Ok([string]$Text)   { Write-Host "  [PASS] $Text" -ForegroundColor Green }
function Note([string]$Text) { Write-Host "  [INFO] $Text" -ForegroundColor DarkGray }
function Bad([string]$Text) {
  Write-Host "  [FAIL] $Text" -ForegroundColor Red
  $script:Failures.Add($Text)
}

# stdout 与 stderr 分开收：schema dump 的 stdout 是 JSON，混进 stderr 会解析不了
function Invoke-Dsh([string[]]$DshArgs) {
  $tag     = [guid]::NewGuid().ToString('N').Substring(0, 8)
  $outFile = Join-Path $LogDir "run-$tag.out.txt"
  $errFile = Join-Path $LogDir "run-$tag.err.txt"
  & dsh @DshArgs 1> $outFile 2> $errFile
  $code = $LASTEXITCODE
  [pscustomobject]@{
    Code   = $code
    Stdout = [string](Get-Content $outFile -Raw -ErrorAction SilentlyContinue)
    Stderr = [string](Get-Content $errFile -Raw -ErrorAction SilentlyContinue)
    OutFile = $outFile
  }
}

function Test-PortListening([int]$P) {
  return [bool](netstat -ano | Select-String (':{0}\s.*LISTENING' -f $P))
}

# 监听 $P 的 pid 全集（纯查询，不做任何排除）
function Get-ListenerPids([int]$P) {
  return @(netstat -ano | Select-String (':{0}\s.*LISTENING' -f $P) |
    ForEach-Object { ($_.Line -split '\s+')[-1] } |
    Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ } | Sort-Object -Unique)
}

# ── 宿主保护：按端口**现查**宿主 pid ──────────────────────────────────
# 不写常数：宿主重启后写死的 pid 会指向**别的进程**或不存在，保护于是**静默失效**。
# fail-safe：查不到时**绝不退回猜一个数** —— 宁可不杀，也不误杀主实例。
# 并把 fail-safe **喊出来**（静默的 fail-safe 与静默的保护失效一样危险，活跃坑 18）。
$script:HostPids = @(Get-ListenerPids $HostPort)
$script:HostPidResolved = $script:HostPids.Count -gt 0

# 收尾清扫谁：只杀**监听 $Port 且不在宿主 pid 集里**的进程；查不到宿主 → 空集 = 一个都不杀。
function Get-SweepPids([int]$P) {
  if (-not $script:HostPidResolved) { return @() }
  return @(Get-ListenerPids $P | Where-Object { $script:HostPids -notcontains $_ })
}

# ── 前置 ─────────────────────────────────────────────────────────────
Step '前置检查'
if ($Port -eq 3080) { throw '拒绝在 3080 上起台子：那是本会话宿主的端口' }
if ($Port -eq $HostPort) { throw "拒绝在宿主端口 $HostPort 上起台子（-Port 与 -HostPort 必须不同）" }
if ($script:HostPidResolved) {
  Ok "宿主保护：端口 $HostPort 上现查到 pid $($script:HostPids -join ',')（收尾按 pid 排除，绝不发信号）"
}
else {
  Note "宿主保护：端口 $HostPort 现查为空 → 宿主 pid 未知"
  Write-Warning "端口 $HostPort 上查不到监听进程 → 宿主 pid 未知。本轮 fail-safe：收尾**不按 pid 杀任何进程**；自己的台子若没释放，末尾的端口判定会报红。"
}
if (Test-Path $PatchFile) { Ok "本仓 patch 文件在：$PatchFile" } else { throw "找不到 $PatchFile" }
if (Test-PortListening $Port) { throw "端口 $Port 已被占用，换一个 -Port" }
Ok "端口 $Port 空闲"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

try {
  # ── ① 独立 DSH_HOME ────────────────────────────────────────────────
  Step '① 独立 DSH_HOME'
  New-Item -ItemType Directory -Force -Path $BenchHome | Out-Null
  $env:DSH_HOME = $BenchHome
  $env:DSH_TELEMETRY_DISABLED = '1'
  Note "DSH_HOME = $env:DSH_HOME（只在本进程环境内，不写用户/机器级）"

  # ── ② 建 profile（幂等）────────────────────────────────────────────
  Step '② 建隔离 profile'
  if (Test-Path (Join-Path $ProfileDir 'package.json')) {
    Ok "profile 已存在，跳过初始化：$ProfileDir"
  }
  else {
    $r = Invoke-Dsh @('--profile', $ProfileName, '--from-default-profile', 'web', '--dump-config')
    if ($r.Code -eq 0) { Ok "从 shipped 模板 web 初始化 profile ""$ProfileName""" }
    else { throw "profile 初始化失败（exit $($r.Code)）：$($r.Stderr)" }
  }

  # ── ③ 让裸包名可从本 profile 解析（免安装等价物）────────────────────
  Step '③ 让 dsh-plugin-debugging 可从本 profile 解析'
  New-Item -ItemType Directory -Force -Path (Split-Path $Junction) | Out-Null
  if (Test-Path $Junction) { Ok "junction 已在：$Junction" }
  else {
    New-Item -ItemType Junction -Path $Junction -Target $RepoRoot | Out-Null
    Ok "建立 junction -> $RepoRoot"
  }

  # ── S1-a 组合层 ────────────────────────────────────────────────────
  Step 'S1-a --dump-config 里出现本插件的行'
  $r = Invoke-Dsh @('--profile', $ProfileName, '--patch', $PatchFile, '--dump-config')
  Note "exit=$($r.Code)（--dump-config 退出码恒 0，故不作判据）；原始输出 $($r.OutFile)"
  $hasRow = $r.Stdout -match '(?m)^\s*-\s+id:\s+dsh-plugin-debugging\s*$'
  $hasOrigin = $r.Stdout -match [regex]::Escape($PatchFile)
  if ($hasRow -and $hasOrigin) { Ok '本插件的行在组合树里，且 # == 头标出本仓 patch 文件' }
  else { Bad "组合层判据不成立（行=$hasRow，来源标注=$hasOrigin）" }

  # ── S1-b 投影层 ────────────────────────────────────────────────────
  Step 'S1-b --dump-config-schema 的 error 不落在本插件的行上'
  $r = Invoke-Dsh @('--profile', $ProfileName, '--patch', $PatchFile, '--dump-config-schema')
  Note "exit=$($r.Code)（退出码 1 = 有 error）；原始输出 $($r.OutFile)"

  $errors = @([regex]::Matches($r.Stderr, '(?m)^dsh: error: \[/(\d+)\] (.+)$') |
    ForEach-Object { [pscustomobject]@{ Index = [int]$_.Groups[1].Value; Message = $_.Groups[2].Value.Trim() } })
  foreach ($e in $errors) { Note "error [/$($e.Index)] $($e.Message)" }

  $pluginPath = $null
  try {
    $doc = $r.Stdout | ConvertFrom-Json
    $entry = @($doc.'x-cordis'.entries | Where-Object { $_.id -eq 'dsh-plugin-debugging' })
    if ($entry.Count -eq 1) { $pluginPath = $entry[0].path }
    Note "x-cordis.complete=$($doc.'x-cordis'.complete)；entries=$(@($doc.'x-cordis'.entries).Count)"
  }
  catch { Bad "schema stdout 不是合法 JSON：$($_.Exception.Message)" }

  if ($null -eq $pluginPath) {
    Bad 'schema dump 里找不到 id=dsh-plugin-debugging 的条目'
  }
  else {
    Note "本插件的 schema 条目 path = $pluginPath"
    $mine = @($errors | Where-Object { "/$($_.Index)" -eq $pluginPath })
    if ($mine.Count -gt 0) { Bad "有 error 落在本插件的行 $pluginPath 上" }
    else { Ok "没有任何 error 落在本插件的行 $pluginPath 上" }
    $known = @($errors | Where-Object { $_.Message -like 'unrecognized Loader tree carrier*' })
    Note "其中 preset-* 已知误报 $($known.Count) 条（path 不指向本插件行，故不影响判定）"
  }

  # ── S1-c 运行期 ────────────────────────────────────────────────────
  Step "S1-c 隔离实例起来并挂载（127.0.0.1:$Port）"
  $bootOut = Join-Path $LogDir 'bench-boot.out.txt'
  $bootErr = Join-Path $LogDir 'bench-boot.err.txt'
  $BootProcess = Start-Process -FilePath 'cmd.exe' -PassThru -WindowStyle Hidden -ArgumentList @(
    '/c', "dsh --profile $ProfileName --patch `"$PatchFile`" --port $Port --no-open 1> `"$bootOut`" 2> `"$bootErr`""
  )

  $url = $null
  for ($i = 0; $i -lt 44; $i++) {
    Start-Sleep -Milliseconds 500
    $boot = [string](Get-Content $bootOut -Raw -ErrorAction SilentlyContinue)
    if ($boot -match 'http://127\.0\.0\.1:(\d+)/\?token=([A-Za-z0-9_\-]+)') { $url = $Matches[0]; break }
  }
  if ($null -eq $url) {
    $be = [string](Get-Content $bootErr -Raw -ErrorAction SilentlyContinue)
    throw "实例 22 秒内没打印 URL。stderr：$be"
  }
  Ok "实例起来：$url"

  $bootErrText = [string](Get-Content $bootErr -Raw -ErrorAction SilentlyContinue)
  if ([string]::IsNullOrWhiteSpace($bootErrText)) { Ok '启动 stderr 为空（没有 entry did not activate）' }
  else { Bad "启动 stderr 非空：$bootErrText" }

  # /api/* 无 cookie 是 401；payload 必须是 {args:{}}
  $token = ([regex]::Match($url, 'token=([A-Za-z0-9_\-]+)')).Groups[1].Value
  $null = Invoke-WebRequest "http://127.0.0.1:$Port/?token=$token" -UseBasicParsing -SessionVariable sess -TimeoutSec 15
  $body = @{
    type = 'client-request'; rpcId = [guid]::NewGuid().ToString()
    method = 'pluginInventory/list'; payload = @{ args = @{} }
  } | ConvertTo-Json -Compress -Depth 6
  $resp = Invoke-WebRequest "http://127.0.0.1:$Port/api/pluginInventory/list" -Method POST `
    -ContentType 'application/json' -Body $body -WebSession $sess -UseBasicParsing -TimeoutSec 30
  $json = $resp.Content | ConvertFrom-Json

  if ($json.result.ok -eq $true) { Ok "pluginInventory/list ok=True（entries=$(@($json.result.value.entries).Count)）" }
  else { Bad "pluginInventory/list 失败：$($json.result.error | ConvertTo-Json -Compress)" }

  $row = @($json.result.value.entries | Where-Object { $_.entryId -eq 'include:dsh-plugin-debugging' })
  if ($row.Count -eq 0) { Bad 'pluginInventory 里没有 include:dsh-plugin-debugging' }
  elseif ($row[0].enabled -eq $true -and $row[0].fiberPhase -eq 'active') {
    Ok 'include:dsh-plugin-debugging enabled=True fiberPhase=active'
  }
  else { Bad "本插件行状态不对：enabled=$($row[0].enabled) fiberPhase=$($row[0].fiberPhase)" }
}
finally {
  # ── 收尾：杀自己起的实例 + 复核端口释放 ────────────────────────────
  Step '收尾'
  if ($script:HostPidResolved) {
    Note "宿主 pid（端口 $HostPort 现查）= $($script:HostPids -join ',')；只杀监听 $Port 且不等于它的进程"
  }
  else {
    Note "宿主 pid 未知（端口 $HostPort 现查为空）→ fail-safe：不按 pid 杀任何进程"
  }
  if ($null -ne $BootProcess) {
    foreach ($p in (Get-SweepPids $Port)) {
      Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
      Note "已终止 node pid $p"
    }
    Stop-Process -Id $BootProcess.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  }
  if (Test-PortListening $Port) { Bad "端口 $Port 仍被占用" } else { Ok "端口 $Port 已释放" }
  Note "台子目录保留在 $BenchHome（本脚本从不删目录）"
}

# ── 结论 ────────────────────────────────────────────────────────────
Step '结论'
if ($Failures.Count -eq 0) {
  Write-Host '  S1 通过：组合层有本插件的行，且隔离实例里 fiberPhase=active。' -ForegroundColor Green
  exit 0
}
Write-Host "  S1 不通过，$($Failures.Count) 条失败：" -ForegroundColor Red
foreach ($f in $Failures) { Write-Host "    - $f" -ForegroundColor Red }
exit 1
