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
      '$job = [DshStopWindowJob]::CreateKillOnCloseJob()',
    )
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
