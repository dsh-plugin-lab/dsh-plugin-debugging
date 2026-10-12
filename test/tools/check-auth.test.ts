/**
 * `dsh_check_auth` 的行为红线。
 *
 * 这个工具存在的**唯一**理由就是把「连接被拒」与「401」分开，所以那两条是本文件
 * 最重要的断言 —— 它们各自对应一个完全相反的下一步。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createCheckAuthTool, CHECK_AUTH_TOOL } from '../../src/tools/dsh_check_auth.ts'
import { TOOL_ERROR_KINDS } from '../../src/lib/errors.ts'
import type { FetchImpl } from '../../src/lib/http.ts'
import {
  configFor,
  depsFor,
  execWith,
  expectFail,
  expectOk,
  run,
  tempDshHome,
  writeText,
} from './helpers.ts'

/** 一个「按状态码应答」的 fetch。 */
function fetchWithStatus(status: number, location?: string): FetchImpl {
  return async () => ({
    status,
    headers: {
      get: (name: string) => (name === 'location' && location !== undefined ? location : null),
    },
  })
}

/** 一个「连不上」的 fetch（模拟 Node 把 ECONNREFUSED 包在 cause 上）。 */
const refusingFetch: FetchImpl = async () => {
  const error = new TypeError('fetch failed')
  ;(error as { cause?: unknown }).cause = Object.assign(new Error('connect ECONNREFUSED'), {
    code: 'ECONNREFUSED',
  })
  throw error
}

describe('dsh_check_auth', () => {
  it('工具名与契约一致', () => {
    expect(CHECK_AUTH_TOOL).toBe('dsh_check_auth')
  })

  describe('成功路径', () => {
    it('200 → 服务在、认证通过', async () => {
      const dshHome = await tempDshHome()
      const tool = createCheckAuthTool(depsFor(configFor(dshHome), { fetch: fetchWithStatus(200) }))

      const data = expectOk(await run(tool, { port: 3080 }))
      expect(data['authority']).toBe('127.0.0.1:3080')
      expect(data['verdict']).toBe('服务在、认证通过')
      expect((data['probe'] as Record<string, unknown>)['status']).toBe(200)
      // 端口是参数给的 —— 来源必须可见（参数 / 配置 / env 会给不同 authority）。
      const resolved = data['resolved'] as Record<string, unknown>
      expect(resolved['port']).toBe(3080)
      expect(resolved['portSource']).toBe('tool-argument')
      expect(resolved['dshHomeSource']).toBe('config')
    })

    it('303（token 交换成功）算 ok，并带回 Location', async () => {
      const dshHome = await tempDshHome()
      const tool = createCheckAuthTool(
        depsFor(configFor(dshHome), { fetch: fetchWithStatus(303, 'http://127.0.0.1:3080/') }),
      )

      const data = expectOk(await run(tool, { port: 3080 }))
      expect((data['probe'] as Record<string, unknown>)['kind']).toBe('ok')
      expect((data['probe'] as Record<string, unknown>)['location']).toBe('http://127.0.0.1:3080/')
    })

    it('500 也算「服务在」：重点是排除「没启动」', async () => {
      const dshHome = await tempDshHome()
      const tool = createCheckAuthTool(depsFor(configFor(dshHome), { fetch: fetchWithStatus(500) }))

      const data = expectOk(await run(tool, { port: 3080 }))
      expect(data['verdict']).toContain('服务在')
      expect((data['probe'] as Record<string, unknown>)['kind']).toBe('http-error')
    })

    it('报告凭证条目是否存在（v1 不读值）', async () => {
      const dshHome = await tempDshHome()
      await writeText(
        join(dshHome, '.credentials.yaml'),
        ['client-connection:', '  browser-session:', '    secret: deadbeef'].join('\n'),
      )
      const tool = createCheckAuthTool(depsFor(configFor(dshHome), { fetch: fetchWithStatus(200) }))

      const data = expectOk(await run(tool, { port: 3080 }))
      const credentials = data['credentials'] as Record<string, unknown>
      expect(credentials['exists']).toBe(true)
      expect(credentials['browserSessionPresent']).toBe(true)
      // 返回值里不能出现任何秘密。
      expect(JSON.stringify(data)).not.toContain('deadbeef')
    })

    it('端口能从 DSH_WEB_URL 里定出来（config.port 为 0 时不猜端口）', async () => {
      const dshHome = await tempDshHome()
      const tool = createCheckAuthTool(
        depsFor(configFor(dshHome), {
          fetch: fetchWithStatus(200),
          env: { DSH_WEB_URL: 'http://127.0.0.1:4444' },
        }),
      )

      const data = expectOk(await run(tool, {}))
      expect(data['authority']).toBe('127.0.0.1:4444')
      // 「这个端口是宿主自己在 env 里告诉我们的」，不是我们猜的 3080。
      const resolved = data['resolved'] as Record<string, unknown>
      expect(resolved['port']).toBe(4444)
      expect(resolved['portSource']).toBe('env:DSH_WEB_URL')
    })
  })

  describe('错误路径（每条可达 kind）', () => {
    it('auth：401 —— 服务在、认证没过（本工具的核心区分之一）', async () => {
      const dshHome = await tempDshHome()
      const tool = createCheckAuthTool(depsFor(configFor(dshHome), { fetch: fetchWithStatus(401) }))

      const error = expectFail(await run(tool, { port: 3080 }))
      expect(error.kind).toBe('auth')
      expect(TOOL_ERROR_KINDS).toContain(error.kind)
      expect(error.message).toContain('401')
      expect(error.message).toContain('不是没启动')
    })

    it('not-running：ECONNREFUSED —— 宿主没启动（本工具的核心区分之二）', async () => {
      const dshHome = await tempDshHome()
      const tool = createCheckAuthTool(depsFor(configFor(dshHome), { fetch: refusingFetch }))

      const error = expectFail(await run(tool, { port: 3080 }))
      expect(error.kind).toBe('not-running')
      expect(error.hint).toContain('没在监听')
    })

    it('not-configured：定不出端口', async () => {
      const dshHome = await tempDshHome()
      const tool = createCheckAuthTool(depsFor(configFor(dshHome), { fetch: fetchWithStatus(200) }))

      const error = expectFail(await run(tool, {}))
      expect(error.kind).toBe('not-configured')
    })

    it('cancelled：调用方在探测前就取消了', async () => {
      const dshHome = await tempDshHome()
      const controller = new AbortController()
      controller.abort()
      const tool = createCheckAuthTool(depsFor(configFor(dshHome), { fetch: fetchWithStatus(200) }))

      const error = expectFail(await run(tool, { port: 3080 }, execWith(controller.signal)))
      expect(error.kind).toBe('cancelled')
    })

    it('timeout：传输层先于工具预算超时', async () => {
      const dshHome = await tempDshHome()
      // 一个「只有被 abort 才结束」的 fetch：超时定时器一响就拒绝，模拟真实 fetch。
      const hangingFetch: FetchImpl = (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(init.signal.reason ?? new Error('aborted'))
          })
        })
      const config = configFor(dshHome, { timeoutMs: 1_000 })
      const tool = createCheckAuthTool(depsFor(config, { fetch: hangingFetch }))

      const error = expectFail(await run(tool, { port: 3080 }))
      expect(error.kind).toBe('timeout')
      expect(error.message).toContain('超时')
    })
  })

  describe('signal 与超时纪律', () => {
    it('调用方取消能到达 IO 层：取消时探测结束且结论是 cancelled', async () => {
      const dshHome = await tempDshHome()
      const controller = new AbortController()
      const seen: AbortSignal[] = []
      // 一个「只有被 abort 才结束」的 fetch：模拟真实 fetch，用来证明取消真的透传到了 IO。
      const hangingFetch: FetchImpl = (_url, init) => {
        seen.push(init.signal)
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(init.signal.reason ?? new Error('aborted'))
          })
        })
      }
      const tool = createCheckAuthTool(depsFor(configFor(dshHome), { fetch: hangingFetch }))

      const pending = run(tool, { port: 3080 }, execWith(controller.signal))
      // 等底层 fetch 把信号登记下来，再取消调用方。
      await Promise.resolve()
      controller.abort()

      const error = expectFail(await pending)
      expect(error.kind).toBe('cancelled')
      // 透传的不是同一个对象（我们套了一层 controller 以便自己超时），但必须联动。
      expect(seen).toHaveLength(1)
      expect(seen[0]?.aborted).toBe(true)
    })

    it('传下去的 redirect 是 manual（否则 303 会被跟成 200，无法区分）', async () => {
      const dshHome = await tempDshHome()
      const seen: string[] = []
      const spyFetch: FetchImpl = async (_url, init) => {
        seen.push(init.redirect)
        return { status: 200 }
      }
      const tool = createCheckAuthTool(depsFor(configFor(dshHome), { fetch: spyFetch }))

      await run(tool, { port: 3080 })
      expect(seen).toEqual(['manual'])
    })
  })
})
