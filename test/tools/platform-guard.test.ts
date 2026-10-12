/**
 * 平台分支的红线 —— 本机 Windows / CI ubuntu 这个差异的**唯一**护栏。
 *
 * 为什么单独一个文件：本仓已经因为「判据写死平台行为」在 CI 上红过两次
 * （`probed === true`、`artifactNewerThanProcess === true`），而两次都只能靠 CI 发现。
 * 这里做两件事：
 * 1. **自检 `withPlatform` 真的会还原** —— 一个「临时改全局」的助手如果会漏还原，
 *    它自己就是下一个静默故障源；
 * 2. 把 `lookupPort` 的**两条平台分支**与 Windows 分支的**各条失败路径**直接钉住，
 *    这样它们在任何机器上都被真跑到，不再依赖「谁在什么平台跑」。
 */
import { describe, expect, it } from 'vitest'

import { lookupPort, parsePortLookup, PORT_LOOKUP_SHELL } from '../../src/lib/ports.ts'
import { cmdResult, recordingSpawn, withPlatform } from './helpers.ts'

describe('withPlatform 自检', () => {
  it('会伪装平台，并在结束后还原', async () => {
    const before = process.platform
    // 不假设宿主平台：本机 win32、CI linux，这个文件自己也可能被
    // 「强制 linux 的整套跑」覆盖（仓里就是这么自检 CI 的）。
    const fake: NodeJS.Platform = before === 'linux' ? 'darwin' : 'linux'

    const seen = await withPlatform(fake, () => process.platform)
    expect(seen).toBe(fake)
    // 还原：这一条才是「助手可信」的判据。
    expect(process.platform).toBe(before)
  })

  it('伪装的值与真实值无关：再伪装一次别的平台也能还原', async () => {
    const before = process.platform

    expect(await withPlatform('darwin', () => process.platform)).toBe('darwin')
    expect(process.platform).toBe(before)
  })

  it('伪装成任何平台都还原（含 darwin，覆盖非 win32 的第二种取值）', async () => {
    const before = process.platform

    expect(await withPlatform('darwin', () => process.platform)).toBe('darwin')
    expect(process.platform).toBe(before)
  })

  it('内层抛错时也会还原（否则后续用例全在错的平台上跑）', async () => {
    const before = process.platform

    await expect(
      withPlatform('linux', () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    expect(process.platform).toBe(before)
  })

  it('异步内层抛错时也会还原', async () => {
    const before = process.platform

    await expect(
      withPlatform('linux', async () => {
        await Promise.resolve()
        throw new Error('async boom')
      }),
    ).rejects.toThrow('async boom')

    expect(process.platform).toBe(before)
  })

  it('嵌套使用时逐层还原', async () => {
    const before = process.platform

    await withPlatform('linux', async () => {
      expect(process.platform).toBe('linux')
      await withPlatform('darwin', async () => {
        expect(process.platform).toBe('darwin')
      })
      expect(process.platform).toBe('linux')
    })

    expect(process.platform).toBe(before)
  })
})

describe('lookupPort · 非 Windows 分支（CI 走这条）', () => {
  it('不 spawn，直接降级成 probed=false 并说明当前平台', async () => {
    await withPlatform('linux', async () => {
      const { spawn, calls } = recordingSpawn(() => cmdResult({ stdout: '4242|node|2020-01-01\n' }))

      const result = await lookupPort(3080, { spawn, timeoutMs: 1_000 })

      expect(result.probed).toBe(false)
      expect(result.listening).toBe(false)
      expect(result.listeners).toEqual([])
      expect(result.detail).toContain('linux')
      // 最要紧的一条：绝不尝试跑 `powershell.exe`。
      expect(calls).toHaveLength(0)
    })
  })
})

describe('lookupPort · Windows 分支', () => {
  it('解析出监听者 → probed=true / listening=true', async () => {
    await withPlatform('win32', async () => {
      const { spawn, calls } = recordingSpawn(() =>
        cmdResult({ stdout: '4242|node|2026-10-12T20:00:00.0000000+08:00\n' }),
      )

      const result = await lookupPort(3080, { spawn, timeoutMs: 1_000 })

      expect(result.probed).toBe(true)
      expect(result.listening).toBe(true)
      expect(result.listeners[0]?.pid).toBe(4242)
      expect(calls[0]?.command).toBe(PORT_LOOKUP_SHELL)
    })
  })

  it('空输出 → probed=true 但 listening=false（查到了，就是没人听）', async () => {
    await withPlatform('win32', async () => {
      const { spawn } = recordingSpawn(() => cmdResult({ stdout: '' }))

      const result = await lookupPort(3080, { spawn, timeoutMs: 1_000 })

      expect(result.probed).toBe(true)
      expect(result.listening).toBe(false)
    })
  })

  it('起不了 shell（spawnError）→ probed=false，原因原样带出', async () => {
    await withPlatform('win32', async () => {
      const { spawn } = recordingSpawn(() => cmdResult({ code: null, spawnError: 'spawn: ENOENT' }))

      const result = await lookupPort(3080, { spawn, timeoutMs: 1_000 })

      expect(result.probed).toBe(false)
      expect(result.detail).toContain('ENOENT')
    })
  })

  it('查询超时 / 调用方取消 → probed=false（各有各的说明）', async () => {
    await withPlatform('win32', async () => {
      const timedOut = recordingSpawn(() => cmdResult({ code: null, timedOut: true }))
      const aborted = recordingSpawn(() => cmdResult({ code: null, aborted: true }))

      const timeoutResult = await lookupPort(3080, { spawn: timedOut.spawn, timeoutMs: 1_000 })
      const abortResult = await lookupPort(3080, { spawn: aborted.spawn, timeoutMs: 1_000 })

      expect(timeoutResult.probed).toBe(false)
      expect(timeoutResult.detail).toContain('超时')
      expect(abortResult.probed).toBe(false)
      expect(abortResult.detail).toContain('取消')
    })
  })
})

describe('parsePortLookup', () => {
  it('忽略空行与非法 pid，保留合法行', () => {
    const listeners = parsePortLookup(
      [
        '',
        '4242|node|2026-10-12T20:00:00.0000000+08:00',
        'not-a-pid|node|',
        '   ',
        '-1|node|',
      ].join('\n'),
    )

    expect(listeners).toHaveLength(1)
    expect(listeners[0]?.pid).toBe(4242)
  })

  it('进程名或启动时间缺失时不留空串（用占位 / 省略）', () => {
    const listeners = parsePortLookup('4242||')

    expect(listeners[0]?.processName).toBe('(unknown)')
    expect(listeners[0]?.startedAt).toBeUndefined()
  })
})
