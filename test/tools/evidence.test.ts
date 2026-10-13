/**
 * 契约：失败分支的 `evidence`（失败时**观测到的事实**）。
 *
 * 它存在的理由：`ToolFail` 原来没有放证据的地方，于是「诊断成功但结论是坏消息」的工具
 * 只能二选一 —— 要么把证据丢掉（`dsh_dump_config` 让模型去查一个看不见的 `actionable`），
 * 要么谎报成功（`ok: true`）。`evidence` 是第三条路：**保住 `ok: false` 与 `kind`，同时留下事实**。
 *
 * 三条不变量在这里钉住：
 * 1. 没有证据时**不写这个字段**（给空对象会让「有没有证据」不可判）；
 * 2. 守卫层（`ensureToolResult`）原样放行它 —— 它只校验 `error.kind/message/hint`；
 * 3. 渲染层失败分支会打出它，**并且让 `summarize` 在失败时也跑**（否则工具作者写在
 *    hook 里的那句判定永远到不了模型 —— `dsh_hot_reload` 就踩过这个）。
 */
import { describe, expect, it } from 'vitest'

import { ensureToolResult, fail, TOOL_ERROR_KINDS } from '../../src/lib/errors.ts'
import { renderToolResultText } from '../../src/lib/render.ts'

const ERROR = {
  kind: 'reload-failed',
  message: 'the new code failed to import',
  hint: 'fix it',
} as const

describe('契约：fail() 的 evidence', () => {
  it('不带证据时**不出现** evidence 字段', () => {
    const result = fail(ERROR)
    expect(result.ok).toBe(false)
    expect('evidence' in result).toBe(false)
    expect(Object.keys(result).sort()).toEqual(['error', 'ok'])
  })

  it('传 undefined 也不算证据（不写字段）', () => {
    expect('evidence' in fail(ERROR, undefined, undefined)).toBe(false)
  })

  it('带证据时原样落在结果上，且 nextStep 同时在', () => {
    const result = fail(ERROR, { why: 'look at the fiber' }, { oldFiberTouched: false })
    expect(result.evidence).toEqual({ oldFiberTouched: false })
    expect(result.nextStep?.why).toBe('look at the fiber')
  })

  it('证据可以是假值（false / 0）而不被当成「没给」', () => {
    expect('evidence' in fail(ERROR, undefined, false)).toBe(true)
    expect('evidence' in fail(ERROR, undefined, 0)).toBe(true)
  })
})

describe('契约：守卫层放行 evidence', () => {
  it('带 evidence 的失败能过 ensureToolResult，且字段没被削掉', () => {
    const guarded = ensureToolResult(fail(ERROR, undefined, { actionable: [{ entryId: 'a' }] }))
    expect(guarded.ok).toBe(false)
    expect((guarded as { evidence?: unknown }).evidence).toEqual({ actionable: [{ entryId: 'a' }] })
  })

  it('kind 仍在闭枚举内（evidence 不改变 kind 的职责）', () => {
    expect(TOOL_ERROR_KINDS).toContain(ERROR.kind)
  })

  it('error 形状不对仍然转 internal —— 加了 evidence 也没放松校验', () => {
    const guarded = ensureToolResult({ ok: false, error: { kind: 'nope' }, evidence: { a: 1 } })
    expect(guarded.ok).toBe(false)
    if (!guarded.ok) expect(guarded.error.kind).toBe('internal')
  })
})

describe('契约：渲染层打 evidence', () => {
  it('失败分支打出 evidence 行', () => {
    const text = renderToolResultText('dsh_hot_reload', {
      ok: false,
      error: ERROR,
      evidence: { oldFiberTouched: false, rolledBack: false },
    })
    expect(text).toContain('[dsh_hot_reload] failed (reload-failed)')
    expect(text).toContain('evidence: ')
    // `stableJson` 是**美化**输出（两空格缩进），所以断言要按真实形态写，别抄紧凑形式。
    expect(text).toContain('"oldFiberTouched": false')
  })

  it('没有 evidence 时**不打**这一行（别打一行空的）', () => {
    const text = renderToolResultText('dsh_hot_reload', { ok: false, error: ERROR })
    expect(text).not.toContain('evidence:')
  })

  it('summarize 在失败时也跑，且收到的是 evidence', () => {
    const seen: unknown[] = []
    const text = renderToolResultText(
      'dsh_hot_reload',
      { ok: false, error: ERROR, evidence: { oldFiberTouched: false } },
      (payload) => {
        seen.push(payload)
        return 'verdict: oldFiberUntouched=true'
      },
    )
    expect(seen).toEqual([{ oldFiberTouched: false }])
    // 结论必须排在 message 之前 —— 模型第一眼要的是判定。
    expect(text.indexOf('verdict: oldFiberUntouched=true')).toBeLessThan(
      text.indexOf('the new code failed'),
    )
  })

  it('成功时 summarize 收到的仍是 data（两条分支各跑一次，载荷不同）', () => {
    const seen: unknown[] = []
    renderToolResultText('t', { ok: true, data: { mode: 'hot' } }, (payload) => {
      seen.push(payload)
      return undefined
    })
    expect(seen).toEqual([{ mode: 'hot' }])
  })
})
