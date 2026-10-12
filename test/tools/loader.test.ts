/**
 * `lib/loader.ts` 的红线：**读宿主内部结构时，任何异常都必须变成降级，不能变成抛**。
 *
 * 这一层的每一条「容错」都不是防御性编程的洁癖，而是有具体后果的：
 * 宿主换个字段名 / 不装 loader / `entries()` 半路抛 —— 这些在别的机器上都会发生，
 * 而工具在那种情况下**必须**退回推断，绝不能因为读不到就整个失败
 * （那会让「诊断插件」在最需要它的时候自己先崩）。
 *
 * 顺带钉住一条实现选择：**不 `await fiber.await()`**。宿主启动审计会 await 拿拒绝值，
 * 但工具调用不能挂在可能不 settle 的 fiber 上 —— 那会让「传输层先于工具超时」失效。
 */
import { describe, expect, it } from 'vitest'

import { FIBER_STATE } from '../../src/lib/fiber.ts'
import { loaderFrom, readLoaderEntries, snapshotEntry } from '../../src/lib/loader.ts'

/** 造一个宿主样子的 entry。 */
function hostEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    options: { id: 'include:pkg-a', name: 'pkg-a' },
    disabled: false,
    fiber: { state: FIBER_STATE.ACTIVE, inject: {}, ctx: { get: () => undefined } },
    ...overrides,
  }
}

/** 造一个宿主样子的 loader。 */
function hostLoader(entries: unknown[]): unknown {
  return { entries: () => entries }
}

describe('lib/loader · 取 loader 服务', () => {
  it("从 ctx.get('loader') 取（不依赖 inject，也不做属性访问）", () => {
    const loader = { entries: () => [] }
    const ctx = { get: (name: string) => (name === 'loader' ? loader : undefined) }

    expect(loaderFrom(ctx)).toBe(loader)
  })

  it('ctx.get 抛错 → undefined（降级，不抛）', () => {
    const ctx = {
      get: () => {
        throw new Error('service resolution exploded')
      },
    }

    expect(loaderFrom(ctx)).toBeUndefined()
  })

  it('ctx 没有 get（单测替身）→ undefined', () => {
    expect(loaderFrom({})).toBeUndefined()
    expect(loaderFrom(undefined)).toBeUndefined()
  })
})

describe('lib/loader · 读 entries（全部失败都收敛成降级）', () => {
  it('没有 loader → ok:false + 原因', () => {
    const result = readLoaderEntries(undefined)

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('no loader service')
    expect(result.entries).toEqual([])
  })

  it('loader 上没有 entries()（宿主内部结构变了）→ ok:false', () => {
    const result = readLoaderEntries({})

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('entries()')
  })

  it('entries() 抛错 → ok:false，且原因里带原文', () => {
    const result = readLoaderEntries({
      entries: () => {
        throw new Error('tree is gone')
      },
    })

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('tree is gone')
  })

  it('正常树 → 抄成快照', () => {
    const result = readLoaderEntries(hostLoader([hostEntry()]))

    expect(result.ok).toBe(true)
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]?.moduleName).toBe('pkg-a')
    expect(result.entries[0]?.fiberState).toBe(FIBER_STATE.ACTIVE)
  })

  it('可迭代对象中途抛错 → 保留已经读到的部分（宁可拿一半也不要零）', () => {
    const partial = {
      *[Symbol.iterator]() {
        yield hostEntry({ options: { id: 'e1', name: 'pkg-a' } })
        throw new Error('iterator died')
      },
    }
    const result = readLoaderEntries({ entries: () => partial })

    expect(result.ok).toBe(true)
    expect(result.entries.map((entry) => entry.moduleName)).toEqual(['pkg-a'])
  })

  it('连 id 都读不出来的 entry 被跳过，而不是编一个', () => {
    const result = readLoaderEntries(hostLoader([{ foo: 'bar' }, hostEntry()]))

    expect(result.ok).toBe(true)
    expect(result.entries).toHaveLength(1)
  })

  it('不可迭代的返回值 → 空树 + ok:true（不是失败：确实是空）', () => {
    const result = readLoaderEntries({ entries: () => 42 })

    expect(result.ok).toBe(true)
    expect(result.entries).toEqual([])
  })
})

describe('lib/loader · 抄 entry 形状', () => {
  it('disabled 是 getter 且求值抛错 → 记成 disabledExpressionError', () => {
    const entry = hostEntry()
    Object.defineProperty(entry, 'disabled', {
      get() {
        throw new Error('bad disabled expression')
      },
    })

    const snapshot = snapshotEntry(entry, 0)
    expect(snapshot?.disabledExpressionError).toBe('bad disabled expression')
  })

  it('fiber 缺失 → hasFiber:false（这是 import 失败那一档的输入）', () => {
    const snapshot = snapshotEntry(hostEntry({ fiber: undefined }), 0)

    expect(snapshot?.hasFiber).toBe(false)
    expect(snapshot?.fiberState).toBeUndefined()
  })

  it('inject 里能解析到的 service 被记下来（pending 档据此算缺谁）', () => {
    const snapshot = snapshotEntry(
      hostEntry({
        fiber: {
          state: FIBER_STATE.PENDING,
          inject: { tools: {}, skills: {} },
          ctx: { get: (name: string) => (name === 'tools' ? {} : undefined) },
        },
      }),
      0,
    )

    expect([...(snapshot?.inject ?? [])].sort()).toEqual(['skills', 'tools'])
    expect(snapshot?.presentServices).toEqual(['tools'])
  })

  it('fiber.ctx.get 抛错 → 当作「这个 service 不在」，而不是让整次读取失败', () => {
    const snapshot = snapshotEntry(
      hostEntry({
        fiber: {
          state: FIBER_STATE.PENDING,
          inject: { tools: {} },
          ctx: {
            get: () => {
              throw new Error('resolution error')
            },
          },
        },
      }),
      0,
    )

    expect(snapshot?.presentServices).toEqual([])
  })

  it('state=3 时从 _error 取原因（**不** await fiber.await()）', () => {
    let awaited = false
    const snapshot = snapshotEntry(
      hostEntry({
        fiber: {
          state: FIBER_STATE.FAILED,
          inject: {},
          ctx: { get: () => undefined },
          _error: new Error('apply blew up'),
          await: () => {
            awaited = true
            return Promise.resolve()
          },
        },
      }),
      0,
    )

    expect(snapshot?.fiberError).toBe('apply blew up')
    // 工具调用不能挂在可能不 settle 的 fiber 上。
    expect(awaited).toBe(false)
  })

  it('非 FAILED 的 state 不去读 _error（避免把陈旧错误当成当前原因）', () => {
    const snapshot = snapshotEntry(
      hostEntry({
        fiber: {
          state: FIBER_STATE.ACTIVE,
          inject: {},
          ctx: { get: () => undefined },
          _error: new Error('陈年旧错'),
        },
      }),
      0,
    )

    expect(snapshot?.fiberError).toBeUndefined()
  })
})
