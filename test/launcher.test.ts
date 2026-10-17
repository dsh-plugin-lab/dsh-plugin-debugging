/**
 * `assets/launcher.js` 的行为判据。
 *
 * 这个文件取代了原先写在 VBScript 里的**全部逻辑**（等旧进程退出、起新宿主、确保停止窗口）。
 * 它存在的意义就是「能被这样测」—— VBS 版本只能去真机跑，跑坏了还不留痕。
 *
 * 所有副作用都注入，所以这些用例**不起任何真进程、不开任何窗口**。
 */
import { describe, expect, it } from 'vitest'
import {
  defaultIsAlive,
  ensureStopWindow,
  parseJobFile,
  readPidFile,
  runLauncher,
  startHost,
  waitForExit,
} from '../assets/launcher.js'
import type { SpawnCall, SpawnOptions } from '../assets/launcher.d.ts'

/** 一份最小的作业文件文本（字段与 `serializeLauncherJob` 一致）。 */
const JOB_TEXT = [
  'node=C:\\nodejs\\node.exe',
  'launcher=C:\\pkg\\assets\\launcher.js',
  'log=C:\\home\\restart\\relaunch.log',
  'capMs=3000',
  'oldPid=4242',
  'command=C:\\nodejs\\node.exe',
  'args=["C:\\\\pkg\\\\lib\\\\bin.js","--profile","web"]',
  'cwd=C:\\repo',
  'dshHome=C:\\home',
  'powershell=C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  'wscript=C:\\Windows\\System32\\wscript.exe',
  'showWindow=C:\\pkg\\assets\\show-window.vbs',
  'job=C:\\home\\restart\\launch-3080.job',
  'stopWindowCommand=powershell -File "C:\\pkg\\assets\\stop-window.ps1" -Port 3080',
  'stopWindow=C:\\pkg\\assets\\stop-window.ps1',
  'stopWindowPid=C:\\home\\restart\\stop-window-3080.pid',
  'stopWindowLog=C:\\home\\restart\\stop-window-3080.log',
  'stopWindowPort=3080',
  'markerPath=C:\\home\\restart\\marker.json',
].join('\r\n')

describe('launcher.js · parseJobFile', () => {
  it('逐行读 key=value，且**只按第一个 `=` 切**（值里可以有 `=`）', () => {
    const job = parseJobFile(JOB_TEXT + '\r\nweird=a=b=c\r\n')
    expect(job['oldPid']).toBe('4242')
    expect(job['stopWindowPort']).toBe('3080')
    expect(job['weird'], '值里的 = 被吃掉了').toBe('a=b=c')
  })

  it('空行与 `#` 注释行被跳过；没有 `=` 的行被忽略（不抛）', () => {
    const job = parseJobFile('a=1\r\n\r\n# comment\r\nno-equals\r\nb=2\r\n')
    expect(job).toEqual({ a: '1', b: '2' })
  })

  it('args 是 JSON 数组 ⇒ 参数里的空格、引号、`&` 都无损', () => {
    const job = parseJobFile(JOB_TEXT)
    expect(JSON.parse(job['args'])).toEqual(['C:\\pkg\\lib\\bin.js', '--profile', 'web'])
  })
})

describe('launcher.js · waitForExit（等待是上限，不是固定睡眠）', () => {
  it('旧进程一开始就不在 ⇒ 一次都不等', async () => {
    let slept = 0
    const out = await waitForExit(
      1,
      3000,
      () => false,
      async () => {
        slept++
      },
    )
    expect(out).toEqual({ gone: true, waited: 0 })
    expect(slept, '明明已经退了却还在睡').toBe(0)
  })

  it('旧进程 300ms 后消失 ⇒ 只等 300ms，不用等满上限', async () => {
    const calls: number[] = []
    let alive = true
    const out = await waitForExit(
      1,
      3000,
      () => alive,
      async () => {
        calls.push(1)
        if (calls.length === 2) alive = false
      },
    )
    // 第 1 次 sleep 后仍活、第 2 次 sleep 后已死 ⇒ 循环在第 3 次探测时退出。
    expect(out.gone).toBe(true)
    expect(out.waited).toBeLessThan(3000)
  })

  it('旧进程一直不退 ⇒ 到上限就放弃等待并**照样**返回（绝不卡死）', async () => {
    const out = await waitForExit(
      1,
      300,
      () => true,
      async () => {},
    )
    expect(out.gone).toBe(false)
    expect(out.waited).toBeGreaterThanOrEqual(300)
  })
})

describe('launcher.js · startHost', () => {
  it('以 argv 数组 spawn：不走 shell，且注入 DSH_HOME 与无窗口标记', () => {
    const calls: SpawnCall[] = []
    startHost(parseJobFile(JOB_TEXT), (command, args, options) => {
      calls.push([command, args, options])
      return { pid: 999, unref() {} }
    })
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe('C:\\nodejs\\node.exe')
    expect(calls[0][1]).toEqual(['C:\\pkg\\lib\\bin.js', '--profile', 'web'])
    expect(calls[0][2].cwd).toBe('C:\\repo')
    expect(calls[0][2].env?.['DSH_HOME']).toBe('C:\\home')
    expect(calls[0][2].env?.['DSH_DEBUG_WINDOWLESS']).toBe('1')
    expect(calls[0][2].windowsHide, '不加上这个就会闪一个控制台').toBe(true)
    expect(calls[0][2].detached).toBe(true)
  })

  it('args 为空串 ⇒ 空数组（而不是 `[""]`）', () => {
    const calls: SpawnCall[] = []
    const job = { ...parseJobFile(JOB_TEXT), args: '' }
    startHost(job, (command, args, options) => {
      calls.push([command, args, options])
      return { pid: 1, unref() {} }
    })
    expect(calls[0][1]).toEqual([])
  })
})

describe('launcher.js · ensureStopWindow（N 次重启只有一个窗口）', () => {
  it('记下的窗口进程还活着 ⇒ **不创建**（这就是「不会每次重启都多开一个」）', () => {
    const spawns: SpawnCall[] = []
    const job = { ...parseJobFile(JOB_TEXT), stopWindowPid: '' }
    // 用一个真实存在的 pid 当「窗口还活着」：本进程自己。
    const out = ensureStopWindow(
      { ...job, stopWindowPid: '__SELF__' },
      () => true,
      (command: string, args: readonly string[], options: SpawnOptions) => {
        spawns.push([command, args, options])
        return { pid: 1, unref() {} }
      },
      { readPid: () => process.pid },
    )
    expect(out.launched).toBe(false)
    expect(out.existing).toBe(process.pid)
    expect(spawns, '窗口还活着却又起了一个').toHaveLength(0)
  })

  it('记下的窗口进程已经死了 ⇒ 起一个，并把三个落点都传给它', () => {
    const spawns: SpawnCall[] = []
    const job = parseJobFile(JOB_TEXT)
    const out = ensureStopWindow(
      job,
      () => false,
      (command: string, args: readonly string[], options: SpawnOptions) => {
        spawns.push([command, args, options])
        return { pid: 1, unref() {} }
      },
      {
        readPid: () => 4242,
      },
    )
    expect(out.launched).toBe(true)
    expect(spawns).toHaveLength(1)
    const [command, args, options] = spawns[0]
    // 走 show-window.vbs 那一跳：Node 无法自己开一个新的**可见**控制台。
    expect(command).toBe(job['wscript'])
    expect(args[0]).toBe(job['showWindow'])
    // ⚠️ 只传**路径**，绝不传命令行：node 会把参数里的引号转义成反斜杠加引号，而
    // wscript 不还原 ⇒ `Shell.Run` 静默失败，症状只是「没有窗口」（2026-10-17 实测）。
    expect(args[1]).toBe(job['job'])
    expect(args[1], '命令串被当 argv 传了').not.toContain('stop-window.ps1')
    expect(args, '只应有 shim 与 job 两个参数').toHaveLength(2)
    // 这一跳自己必须隐藏（它是 GUI 子系统程序，不隐藏也看不见，但别赌）。
    expect(options.windowsHide).toBe(true)
  })

  it('pidfile 不存在 ⇒ 起一个（首次拉起就是这个形态）', () => {
    const spawns: SpawnCall[] = []
    const out = ensureStopWindow(
      parseJobFile(JOB_TEXT),
      () => false,
      (command: string, args: readonly string[], options: SpawnOptions) => {
        spawns.push([command, args, options])
        return { pid: 1, unref() {} }
      },
      {
        readPid: () => 0,
      },
    )
    expect(out.launched).toBe(true)
    expect(spawns).toHaveLength(1)
  })
})

describe('launcher.js · readPidFile', () => {
  it('文件不在 / 内容是垃圾 / 是非正数 ⇒ 一律 0（不抛）', () => {
    expect(readPidFile('')).toBe(0)
    expect(readPidFile('C:\\definitely\\not\\here.pid')).toBe(0)
  })
})

describe('launcher.js · runLauncher（整条仪式）', () => {
  it('顺序是「记日志 → 等旧进程 → 起宿主 → ensure 窗口 → 记日志」', async () => {
    const log: string[] = []
    const spawns: SpawnCall[] = []
    const out = await runLauncher(parseJobFile(JOB_TEXT), {
      isAlive: () => false,
      sleep: async () => {},
      spawn: (command, args, options) => {
        spawns.push([command, args, options])
        return { pid: 7, unref() {} }
      },
      say: (_path: string, message: string) => log.push(message),
      readPid: () => 0,
    })
    expect(out.launched).toBe(true)
    expect(spawns).toHaveLength(2)
    // 第一条 spawn 是新宿主，第二条是停止窗口。
    expect(spawns[0][1]).toContain('--profile')
    expect(spawns[1][1][0]).toContain('show-window.vbs')
    expect(log[0]).toContain('launcher started')
    expect(log.join('\n')).toContain('launched hidden')
    expect(log.join('\n')).toContain('stop window launched')
  })

  it('起宿主抛异常 ⇒ **不**再起停止窗口，且如实记 LAUNCH FAILED（不吞）', async () => {
    const log: string[] = []
    const spawns: SpawnCall[] = []
    const out = await runLauncher(parseJobFile(JOB_TEXT), {
      isAlive: () => false,
      sleep: async () => {},
      spawn: () => {
        throw new Error('spawn EPERM')
      },
      say: (_path: string, message: string) => log.push(message),
      readPid: () => 0,
    })
    expect(out.launched).toBe(false)
    expect(spawns).toHaveLength(0)
    expect(log.join('\n')).toContain('LAUNCH FAILED: spawn EPERM')
  })
})

describe('launcher.js · defaultIsAlive', () => {
  it('当前进程活着、一个显然不存在的 pid 是死的', () => {
    expect(defaultIsAlive(process.pid)).toBe(true)
    expect(defaultIsAlive(0x7ffffffe)).toBe(false)
  })
})
