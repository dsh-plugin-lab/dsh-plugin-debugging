/**
 * 静态资产（`assets/`）的判据。
 *
 * ## 为什么这些必须判在**仓里的文件**上，而不是生成出来的字符串上
 *
 * 2026-10-17 之前，`relaunch.vbs` 与 `stop-window.ps1` 都是 TS 在运行期拼出来的。
 * 那种形态有两个结构性问题，而**两处都测不到**：
 *
 * 1. **没有编译期检查**：VBScript / PowerShell 的语法错在生成侧完全看不见，症状是
 *    「任务跑了、什么都没起」—— 本仓最怕的静默坏。
 * 2. **编码随写盘路径走**：PowerShell 5.1 把**没有 BOM** 的 `.ps1` 按 ANSI 解码、
 *    `cscript`/`wscript` 把 `.vbs` 按 ANSI 解码 ⇒ 任何非 ASCII 字符都会在解析期炸掉，
 *    而炸法取决于那一台机器的区域设置。
 *
 * 现在三份资产都是仓里的静态文件，于是上面两条都能变成**跑在本机上的判据**。
 */
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const ASSETS = ['assets/launcher.vbs', 'assets/launcher.js', 'assets/stop-window.ps1'] as const

function readAsset(path: string): string {
  return readFileSync(path, 'utf8')
}

/** 返回第一个非 ASCII 字符（没有则空串）—— 不用正则，避开 `no-control-regex`。 */
function nonAsciiIn(text: string): string {
  for (const character of text) {
    if ((character.codePointAt(0) ?? 0) > 0x7f) return character
  }
  return ''
}

describe('assets · 静态资产（取代运行期拼脚本）', () => {
  it('三份资产都在，且都不是空文件', () => {
    for (const path of ASSETS) {
      const text = readAsset(path)
      expect(text.length, `${path} 是空的 —— 空文件在拉起时会静默什么都不做`).toBeGreaterThan(200)
    }
  })

  it('`launcher.vbs` 与 `launcher.js` 是**纯 ASCII**（cscript 按 ANSI 读 .vbs）', () => {
    // 这一条是本仓踩过的坑：往 VBS 里写一句中文注释，vbs 会把下一行整条语句吃掉，
    // 报错是「未定义的变量」—— 与真正的原因差得很远。
    for (const path of ['assets/launcher.vbs', 'assets/launcher.js']) {
      expect(nonAsciiIn(readAsset(path)), `${path} 含非 ASCII 字符`).toBe('')
    }
  })

  it('`stop-window.ps1` 带 UTF-8 BOM，同时正文仍是纯 ASCII', () => {
    // 两条一起钉：BOM 是 B13 的既有红线（仓里每个 .ps1 都必须带），而正文纯 ASCII 是
    // 这个文件自己的额外约束 —— 少了 BOM 时正文仍然解析得对，于是「BOM 丢了」这件事
    // 只能靠 B13 抓；两条都留，是因为它们防的是不同的坏法。
    const bytes = readFileSync('assets/stop-window.ps1')
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf])
    const text = bytes.subarray(3).toString('utf8')
    expect(nonAsciiIn(text), '正文含非 ASCII 字符').toBe('')
  })

  it('停止窗口**不**自己杀进程：没有 taskkill / Stop-Process / process.kill', () => {
    // 这条是设计的一部分，不是风格偏好：终结宿主的是**内核**（job 的最后一个句柄关闭），
    // 不是脚本里的某一句。出现这三样中的任何一个，都意味着有人给这个机制加了兜底，
    // 而那会把「关闭窗口」的语义换成「按 pid 杀」—— 正是本仓红线 B10 要防的形态。
    //
    // ⚠️ 判据必须**剥掉注释**再扫：文件里有一句注释正是在说「本文件不调用 taskkill」，
    // 不剥的话这条判据禁的是「解释这件事」，而不是「做这件事」。
    const code = readAsset('assets/stop-window.ps1')
      .split(/\r?\n/u)
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')
      .toLowerCase()
    for (const forbidden of ['taskkill', 'stop-process', 'process.kill']) {
      expect(code, `停止窗口里出现了 ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('停止窗口确实持有带 KILL_ON_JOB_CLOSE 的 Job Object 句柄', () => {
    // 正向判据：上面那条「不许自己杀」只有在**内核这条路真的接上了**时才是对的，
    // 否则两份断言都能在一个「什么都不做」的脚本上通过。
    const text = readAsset('assets/stop-window.ps1')
    expect(text).toContain('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE')
    expect(text).toContain('AssignProcessToJobObject')
    expect(text, '句柄必须由本进程一直持有').toContain(
      '$script:job = [DshStopWindowJob]::CreateKillOnCloseJob()',
    )
  })

  it('停止窗口能对「第二次收编」重新起一个 job（而不是一辈子只绑一个）', () => {
    // 2026-10-18 真机缺陷：一个 job 句柄的层级由**第一次收编**决定，之后来自另一条
    // job 树的宿主永远加不进去（win32 5）。窗口本来就要跨重启存活，于是第二个宿主
    // 起不来 —— 而窗口会安静地退化成「黄字 + 关不掉」。修法是失败后**重建**句柄。
    //
    // 这里判的是**修法的存在与顺序**，不是「症状消失」：真机上的效果由 integration 那侧
    // 验（本目录不跑真进程）。没有这段结构，重建就不会发生；重建放错了地方，就可能
    // 在旧宿主还活着时把它一起收掉。
    const text = readAsset('assets/stop-window.ps1')

    // ① 建新 job 的入口是一个可重复调用的函数，而不是一次性语句
    expect(text, '必须有一条可重复执行的建 job 路径').toContain('function Open-ControlJob')

    // ② 失败后重试之前，必须先确认上一个宿主已经死了 —— 这是唯一能安全放弃旧句柄的条件
    const reArm = text.indexOf('re-armed for pid')
    expect(reArm, '没有重建分支').toBeGreaterThan(-1)
    const guard = text.indexOf('if (HostAlive $script:adoptedPid) { return $false }')
    expect(guard, '重建前缺少「旧宿主必须已死」的守卫').toBeGreaterThan(-1)
    expect(guard, '守卫必须在重建之前').toBeLessThan(reArm)

    // ③ 同一个目标只重建一次，否则每秒钟都会漏一个 job 句柄
    expect(text, '缺少「每个目标只重建一次」的闸').toContain(
      'if ($script:reArmedFor -eq $ProcessId) { return $false }',
    )

    // ④ 危险动作必须**不存在**：关闭旧句柄是唯一能误杀活宿主的一步，本文件不许有
    expect(text, '不许关闭旧 job 句柄（那是误杀活宿主的唯一途径）').not.toContain('CloseJobHandle')
  })
})

describe('assets · 语法与编码（能跑起来才算资产）', () => {
  const isWindows = process.platform === 'win32'

  it.skipIf(!isWindows)('`stop-window.ps1` 在 PowerShell 5.1 里**解析**通过（不执行）', () => {
    // 只解析、不执行：执行会真的建 job 与开窗口。
    const script =
      '$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile(' +
      "'assets/stop-window.ps1',[ref]$null,[ref]$e); " +
      'if ($e) { $e | ForEach-Object { Write-Output $_.Message }; exit 1 } else { exit 0 }'
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
    })
    expect(result.stdout ?? '', 'PowerShell 5.1 解析报错').toBe('')
    expect(result.status, '解析失败').toBe(0)
  })

  it('`launcher.js` 能被 import（语法与顶层 await 都成立）', async () => {
    const module = await import('../assets/launcher.js')
    expect(typeof module.runLauncher).toBe('function')
    expect(typeof module.parseJobFile).toBe('function')
    expect(typeof module.waitForExit).toBe('function')
  })
})
