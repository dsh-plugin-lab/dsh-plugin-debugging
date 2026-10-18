/**
 * `lib/stop-url` 的判据：地址怎么取、什么时候**不许**给地址、发布文本的形状。
 *
 * 本文件只管纯逻辑（无 IO、无真进程）：真正的窗口行为在 integration 那一侧验。
 */
import { describe, expect, it } from 'vitest'

import { restartStopWindowUrlPath } from '../../src/lib/restart.js'
import { listeningPortOf, serializeStopWindowUrl, stopWindowUrlOf } from '../../src/lib/stop-url.js'

/** 造一个只有 `get` 的上下文替身。 */
function contextWith(services: Record<string, unknown>): { get: (name: string) => unknown } {
  return { get: (name) => services[name] }
}

describe('lib/stop-url · 取带 token 的地址', () => {
  const root = 'http://127.0.0.1:3080/'

  it('两个服务都在 ⇒ 返回带 token 的完整地址', () => {
    const ctx = contextWith({
      webApp: { getAdvertisedUrl: () => root },
      connection: { authenticatedUrl: (base: string) => `${base}?token=abc` },
    })
    expect(stopWindowUrlOf(ctx)).toBe('http://127.0.0.1:3080/?token=abc')
  })

  it('缺 `connection` ⇒ undefined（**不许**退回去拼一个不带 token 的地址）', () => {
    // 这一条防的是「看起来能用、点开是 401」：用户刚因为这种东西困惑过。
    // 宁可窗口写「还没有地址」，也不要给一个必定失败的链接。
    const ctx = contextWith({ webApp: { getAdvertisedUrl: () => root } })
    expect(stopWindowUrlOf(ctx)).toBeUndefined()
  })

  it('缺 `webApp` ⇒ undefined', () => {
    const ctx = contextWith({
      connection: { authenticatedUrl: (base: string) => `${base}?token=a` },
    })
    expect(stopWindowUrlOf(ctx)).toBeUndefined()
  })

  it('服务在场但形状不认识 ⇒ undefined（不猜）', () => {
    // 宿主换版本后 `getAdvertisedUrl` 可能改名/换签名：那时**降级**成「没有地址」，
    // 而不是抛 —— 这条通道是附加信息，不该拖垮插件挂载。
    for (const broken of [
      { webApp: {}, connection: { authenticatedUrl: (b: string) => `${b}?t=1` } },
      {
        webApp: { getAdvertisedUrl: () => '' },
        connection: { authenticatedUrl: (b: string) => b },
      },
      { webApp: { getAdvertisedUrl: () => 42 }, connection: {} },
      { webApp: null, connection: null },
    ]) {
      expect(stopWindowUrlOf(contextWith(broken)), JSON.stringify(broken)).toBeUndefined()
    }
  })

  it('上下文连 `get` 都没有 ⇒ undefined（不抛）', () => {
    expect(stopWindowUrlOf({})).toBeUndefined()
  })
})

describe('lib/stop-url · 实际监听端口', () => {
  it('正数端口照常返回', () => {
    expect(listeningPortOf(contextWith({ webServer: { port: 3080 } }))).toBe(3080)
  })

  it('`0` / 负数 / 非整数 / 字符串一律 undefined（哨兵不是端口）', () => {
    // `0` 是 schema 上「用户没填」的惯用值，`webServer.port` 在 listen 之前是 undefined。
    // 两者都不许流进文件名 —— 2026-10-17 的事故就是 `0` 变成 `stop-window-0.pid`。
    for (const bad of [0, -1, 1.5, Number.NaN, '3080', null, undefined]) {
      expect(
        listeningPortOf(contextWith({ webServer: { port: bad } })),
        String(bad),
      ).toBeUndefined()
    }
  })

  it('服务不在场 ⇒ undefined', () => {
    expect(listeningPortOf(contextWith({}))).toBeUndefined()
    expect(listeningPortOf({})).toBeUndefined()
  })
})

describe('lib/stop-url · 发布文本', () => {
  it('两行、带 pid、CRLF 结尾（窗口按 `key=value` 读）', () => {
    expect(serializeStopWindowUrl(1234, 'http://127.0.0.1:3080/?token=x')).toBe(
      'pid=1234\r\nurl=http://127.0.0.1:3080/?token=x\r\n',
    )
  })

  it('回收时 pid 为 0、url 为空但仍然**写出这一格**', () => {
    // 空值让窗口显示「还没有地址」；少写这一行会让「没有地址」与「文件坏了一半」混在一起。
    expect(serializeStopWindowUrl(0, undefined)).toBe('pid=0\r\nurl=\r\n')
  })
})

describe('lib/stop-url · 落点', () => {
  it('文件名带端口，且与本进程命名空间一致', () => {
    const home = 'C:\\Users\\someone\\.dsh'
    expect(restartStopWindowUrlPath(home, 3080)).toMatch(
      /[\\/]dsh-plugin-debugging[\\/]restart[\\/]url-3080\.txt$/u,
    )
  })

  it('端口没解析出来 ⇒ 抛 RangeError（不生成 `url-0.txt`）', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => restartStopWindowUrlPath('/tmp/home', bad), String(bad)).toThrow(RangeError)
    }
  })
})
