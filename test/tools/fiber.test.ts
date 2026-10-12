/**
 * `lib/fiber.ts` 纯投影的红线。
 *
 * 这一份是本次升级的**语义核心**：三档判定逐字复刻宿主自己的启动审计
 * （真源 `…\@deepseek-ai\dsh-app-boot\lib\index.js:4043-4107`，0.2.1-alpha.2）。
 * 语义错了，工具会给出**看着很确定**的错误结论 —— 比不观测更糟，所以每一档都钉一条。
 *
 * 最要紧的一条：**`fiber === undefined`（import 期就崩）不能与 `state === 3`（apply 崩）混为一谈**，
 * 而宿主那张 `FIBER_PHASE` 表恰恰会把它抹平成 `null`。
 */
import { describe, expect, it } from 'vitest'

import {
  FIBER_PHASE,
  FIBER_STATE,
  indexByIdentifier,
  projectFiberPhase,
  worstOf,
  type IndexedObservation,
} from '../../src/lib/fiber.ts'
import { entrySnapshot } from './helpers.ts'

describe('lib/fiber · 三档判定', () => {
  it('fiber 不存在 → failed / failed to import（最凶的一档）', () => {
    const observation = projectFiberPhase(entrySnapshot({ hasFiber: false }))

    expect(observation.phase).toBe('failed')
    expect(observation.error).toBe('failed to import')
    // 而且它和宿主那张表的答案**不同** —— 这正是不能只用映射表的证据。
    expect(FIBER_PHASE[Number.NaN]).toBeUndefined()
    expect(observation.fiberState).toBeUndefined()
  })

  it('state=3 → failed，并把 _error 带出来（apply 崩）', () => {
    const observation = projectFiberPhase(
      entrySnapshot({ fiberState: FIBER_STATE.FAILED, fiberError: 'boom in apply' }),
    )

    expect(observation.phase).toBe('failed')
    expect(observation.error).toBe('boom in apply')
    expect(observation.fiberState).toBe(3)
    expect(observation.basis).toContain('FAILED')
  })

  it('state=3 但取不到原因 → 仍然 failed，且说明原因没取到', () => {
    const observation = projectFiberPhase(entrySnapshot({ fiberState: FIBER_STATE.FAILED }))

    expect(observation.phase).toBe('failed')
    expect(observation.error).toBeUndefined()
    expect(observation.basis).toContain('could not be read')
  })

  it('state=0 → pending，并算出缺哪些 service', () => {
    const observation = projectFiberPhase(
      entrySnapshot({
        fiberState: FIBER_STATE.PENDING,
        inject: ['tools', 'skills', 'fs'],
        presentServices: ['tools'],
      }),
    )

    expect(observation.phase).toBe('pending')
    expect(observation.missingInject).toEqual(['skills', 'fs'])
    expect(observation.basis).toContain('skills, fs')
  })

  it('state=0 且 service 都在 → pending（挂载尚未轮到它），missingInject 是空数组', () => {
    const observation = projectFiberPhase(
      entrySnapshot({
        fiberState: FIBER_STATE.PENDING,
        inject: ['tools'],
        presentServices: ['tools'],
      }),
    )

    expect(observation.phase).toBe('pending')
    expect(observation.missingInject).toEqual([])
    expect(observation.basis).toContain('has not been mounted yet')
  })

  it('state=2 → active', () => {
    const observation = projectFiberPhase(entrySnapshot({ fiberState: FIBER_STATE.ACTIVE }))

    expect(observation.phase).toBe('active')
    expect(observation.fiberState).toBe(2)
    expect(observation.error).toBeUndefined()
  })

  it('disabled 为真 → disabled（**不是** failed：宿主直接跳过）', () => {
    const observation = projectFiberPhase(entrySnapshot({ disabled: true, hasFiber: false }))

    expect(observation.phase).toBe('disabled')
  })

  it('disabled 表达式求值抛错 → failed（宿主把它算作一种启动失败）', () => {
    const observation = projectFiberPhase(
      entrySnapshot({ disabledExpressionError: 'config is not defined' }),
    )

    expect(observation.phase).toBe('failed')
    expect(observation.error).toBe('config is not defined')
    expect(observation.basis).toContain('disabled expression threw')
  })

  it('判定顺序：disabled 优先于 fiber 缺失（避免把禁用的行报成崩了）', () => {
    const observation = projectFiberPhase(entrySnapshot({ disabled: true, hasFiber: false }))
    expect(observation.phase).toBe('disabled')
  })

  it('其它 state（loading / disposed / unloading）与宿主一样按失败处理', () => {
    for (const state of [FIBER_STATE.LOADING, FIBER_STATE.DISPOSED, FIBER_STATE.UNLOADING]) {
      const observation = projectFiberPhase(entrySnapshot({ fiberState: state }))
      expect(observation.phase).toBe('failed')
      expect(observation.error).toBe(`fiber state ${String(state)}`)
    }
  })

  it('每个判定都带 basis（让人能复核这一档是怎么来的）', () => {
    const observations = [
      projectFiberPhase(entrySnapshot({ hasFiber: false })),
      projectFiberPhase(entrySnapshot({ fiberState: 2 })),
      projectFiberPhase(entrySnapshot({ fiberState: 3 })),
      projectFiberPhase(entrySnapshot({ fiberState: 0 })),
      projectFiberPhase(entrySnapshot({ disabled: true })),
      projectFiberPhase(entrySnapshot({ fiberState: 1 })),
    ]
    for (const observation of observations) {
      expect(observation.basis.length).toBeGreaterThan(0)
    }
  })
})

describe('lib/fiber · 建索引', () => {
  it('按模块名索引，且子路径行也能用父包名查到', () => {
    const index = indexByIdentifier([
      entrySnapshot({ moduleName: '@deepseek-ai/dsh-plugin-manager/tools', entryId: 'e1' }),
      entrySnapshot({ moduleName: 'dsh-zhihu-search', entryId: 'e2' }),
    ])

    expect(index.get('dsh-zhihu-search')).toHaveLength(1)
    // 子路径行：全名与父包名都应命中。
    expect(index.get('@deepseek-ai/dsh-plugin-manager/tools')).toHaveLength(1)
    expect(index.get('@deepseek-ai/dsh-plugin-manager')).toHaveLength(1)
  })

  it('同一个包有多行时全部保留，且**不重排**（索引是树的原始投影）', () => {
    const index = indexByIdentifier([
      entrySnapshot({ moduleName: 'pkg-a', entryId: 'a1', fiberState: 2 }),
      entrySnapshot({ moduleName: 'pkg-a', entryId: 'a2', hasFiber: false }),
    ])

    const rows = index.get('pkg-a')
    expect(rows).toHaveLength(2)
    // 顺序无关的集合断言：索引按 loader 顺序返回，**不保证**按严重级排。
    expect([...(rows ?? [])].map((row) => row.observation.phase).sort()).toEqual([
      'active',
      'failed',
    ])
    // 而顺序确实是 loader 顺序 —— 重排就等于替调用方藏了东西。
    expect(rows?.map((row) => row.entry.entryId)).toEqual(['a1', 'a2'])
  })

  it('worstOf 把 failed 挑出来 —— 同包多行不会把崩掉的那行藏起来', () => {
    const index = indexByIdentifier([
      entrySnapshot({ moduleName: 'pkg-a', entryId: 'a1', fiberState: 2 }),
      entrySnapshot({ moduleName: 'pkg-a', entryId: 'a2', hasFiber: false }),
    ])

    const worst = worstOf(index.get('pkg-a') ?? [])
    expect(worst?.observation.phase).toBe('failed')
    expect(worst?.entry.entryId).toBe('a2')
  })

  it('worstOf 的严重级：把 active 排在最前喂进去，仍挑出 failed', () => {
    const rows: IndexedObservation[] = [
      {
        entry: entrySnapshot({ entryId: 'e-active' }),
        observation: { phase: 'active', basis: 't' },
      },
      {
        entry: entrySnapshot({ entryId: 'e-disabled' }),
        observation: { phase: 'disabled', basis: 't' },
      },
      {
        entry: entrySnapshot({ entryId: 'e-unknown' }),
        observation: { phase: 'unknown', basis: 't' },
      },
      {
        entry: entrySnapshot({ entryId: 'e-pending' }),
        observation: { phase: 'pending', basis: 't' },
      },
      {
        entry: entrySnapshot({ entryId: 'e-failed' }),
        observation: { phase: 'failed', basis: 't' },
      },
    ]

    expect(worstOf(rows)?.observation.phase).toBe('failed')
    // 逐个砍掉最坏的那一档，剩下的必须按严重级依次浮上来。
    expect(worstOf(rows.filter((row) => row.entry.entryId !== 'e-failed'))?.observation.phase).toBe(
      'pending',
    )
    expect(
      worstOf(rows.filter((row) => ['e-failed', 'e-pending'].includes(row.entry.entryId) === false))
        ?.observation.phase,
    ).toBe('unknown')
  })

  it('worstOf 同级时按 entryId 定序（结果不取决于 loader 的偶然顺序）', () => {
    const rows: IndexedObservation[] = [
      { entry: entrySnapshot({ entryId: 'zzz' }), observation: { phase: 'active', basis: 't' } },
      { entry: entrySnapshot({ entryId: 'aaa' }), observation: { phase: 'active', basis: 't' } },
    ]

    expect(worstOf(rows)?.entry.entryId).toBe('aaa')
    expect(worstOf([...rows].reverse())?.entry.entryId).toBe('aaa')
  })

  it('worstOf 空数组 → undefined', () => {
    expect(worstOf([])).toBeUndefined()
  })

  it('scope 包名不会把裸包名切错', () => {
    const index = indexByIdentifier([entrySnapshot({ moduleName: '@scope/pkg' })])
    expect(index.get('@scope/pkg')).toHaveLength(1)
    // 不能把 '@scope' 当成父包名塞进索引。
    expect(index.has('@scope')).toBe(false)
  })
})
