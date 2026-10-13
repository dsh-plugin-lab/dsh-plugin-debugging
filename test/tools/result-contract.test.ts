/**
 * 契约：工具结果的三层形状（SHAPE §4.1 冻结）与三层渲染（§3.1 冻结）。
 *
 * **这份文件是 `test/tools/evidence.test.ts` 的继任者**（改名 + 按新契约重写，2026-10-13）。
 * 旧文件的名字会撒谎：`evidence` 这个字段已经不存在了 —— 它并进了 `data`
 * （失败分支的 `data` 就是原来的 evidence），而 `error.hint` 被删掉，`summarize` 钩子
 * 退役成「L1 就是 `data.verdict` 逐字」。所以断言是**重写**，不是删掉：
 *
 * | 旧断言（evidence.test.ts） | 新断言（本文件） |
 * |---|---|
 * | 不带 evidence 时不写那个字段 | `fail(error, data)` 不写 `nextStep` 字段；`data` **必填** |
 * | evidence 可以是假值 | `audit` 可以是假值（只判「存在」） |
 * | 守卫层只校验 `kind`/`message`/`hint`、原样放行 evidence | 守卫层按 §4.1 的四条规则校验 `data`/`nextStep` |
 * | 失败分支打 `evidence:` 行、`summarize` 在失败时也跑 | 失败分支打 `verdict:` 行（**逐字 = `data.verdict`**）；旧三种行一个都不打 |
 * | 成功时 `summarize` 收到 `data` | 成功档的 `verdict:` 行 = `data.verdict` |
 */
import { describe, expect, it } from 'vitest'

import {
  ensureToolResult,
  fail,
  jsonValueProblem,
  ok,
  TOOL_ERROR_KINDS,
  toolResultProblem,
  type JsonValue,
  type NextStep,
  type ToolData,
  type ToolResult,
} from '../../src/lib/errors.ts'
import {
  DEFAULT_MAX_KEY_LINES,
  renderToolResultText,
  type RenderTable,
} from '../../src/lib/render.ts'

/** 一个合法的 `data`。 */
function dataFor(verdict = 'the probe finished, so the port answers'): ToolData<{ port: number }> {
  return { verdict, key: { port: 3080 }, audit: { raw: 'stdout' } }
}

/** 一个合法的工具支 `nextStep`。 */
const STEP: NextStep = { tool: 'dsh_check_auth', args: { port: 3080 }, why: 'confirm the 401' }

/** 一个合法的 manual 支 `nextStep`。 */
const MANUAL: NextStep = { manual: true, why: 'rebuild the client, then refresh the page' }

/** 只回一行 L2 的输出表。 */
const TABLE: RenderTable<{ port: number }> = {
  key: (data) => [`port: ${String(data.key.port)}`],
}

describe('契约：fail() 的形状（旧「fail() 的 evidence」组）', () => {
  it('`fail(error, data)`：恰好三个键，**没有** nextStep 字段', () => {
    const result = fail({ kind: 'timeout', message: 'the probe timed out' }, dataFor())
    expect(result.ok).toBe(false)
    expect(Object.keys(result).sort()).toEqual(['data', 'error', 'ok'])
    expect(result.data.verdict).not.toBe('')
  })

  it('显式传 `undefined` 的 nextStep 也不算给了（不写字段）', () => {
    const result = fail({ kind: 'timeout', message: 'the probe timed out' }, dataFor(), undefined)
    expect('nextStep' in result).toBe(false)
  })

  it('带 nextStep 时它原样落在结果上（工具支与 manual 支各一次）', () => {
    const withTool = fail({ kind: 'auth', message: 'the host answered 401' }, dataFor(), STEP)
    expect(withTool.nextStep).toEqual(STEP)
    const withManual = fail({ kind: 'auth', message: 'the host answered 401' }, dataFor(), MANUAL)
    expect(withManual.nextStep).toEqual(MANUAL)
  })

  it('`data` 是**必填**参数：`fail` 的 arity 不含可省略的第二参', () => {
    // 类型上必填由 `tsc` 守；运行期这里钉住「不传 data 得到的东西过不了守卫」——
    // 也就是「漏传」绝不会静默变成一个看起来合法的结果。
    const missing = (fail as unknown as (...args: unknown[]) => unknown)({
      kind: 'timeout',
      message: 'm',
    })
    expect(toolResultProblem(missing)).not.toBeUndefined()
  })

  it('`audit` 可以是假值（false / 0 / null）而不被当成「没给」（旧「证据可以是假值」的等价物）', () => {
    for (const audit of [false, 0, null, '']) {
      const result = fail(
        { kind: 'internal', message: 'm' },
        { verdict: 'v', key: {}, audit: audit as JsonValue },
      )
      expect(toolResultProblem(result)).toBeUndefined()
    }
  })
})

describe('契约：守卫层的四条规则（旧「守卫层放行 evidence」组）', () => {
  it('成功分支合规 → 原样放行（同一引用，字段没被削掉）', () => {
    const valid = ok(dataFor())
    const guarded = ensureToolResult(valid)
    expect(guarded).toBe(valid)
    expect(guarded.ok).toBe(true)
  })

  it('失败分支合规 → 原样放行，`data` 与 `nextStep` 都在', () => {
    const valid = fail({ kind: 'not-running', message: 'connection refused' }, dataFor(), MANUAL)
    const guarded = ensureToolResult(valid)
    expect(guarded).toBe(valid)
    if (guarded.ok) throw new Error('期望失败')
    expect(guarded.data.key).toEqual({ port: 3080 })
    expect(guarded.nextStep).toEqual(MANUAL)
  })

  it('`data` 顶层多一个键 → 判不合规（B21 的闭集）', () => {
    // 第四键必须加在 `data` 里 —— 闭集说的是 `data` 的顶层（结果本身有 ok/data/nextStep）。
    const drifted = { ...ok(dataFor()), data: { ...dataFor(), extra: true } }
    expect(toolResultProblem(drifted)).toContain('exactly the three keys')
  })

  it('`data.verdict` 为空串 / `data.key` 不是对象 / 缺 `audit` → 三种都判不合规', () => {
    // 这三种是**故意造坏的形状**，所以直接写字面量而不走 `ok()`（`ok` 的参数类型是合法 `ToolData`）。
    expect(toolResultProblem({ ok: true, data: { verdict: '', key: {}, audit: {} } })).toContain(
      '"data.verdict" must be a non-empty string',
    )
    expect(
      toolResultProblem({ ok: true, data: { verdict: 'v', key: 'nope', audit: {} } }),
    ).toContain('"data.key" must be an object')
    expect(toolResultProblem({ ok: true, data: { verdict: 'v', key: {} } })).toContain(
      'exactly the three keys',
    )
  })

  it('`error.kind` 不在闭枚举、`error.message` 空串 → 都判不合规', () => {
    expect(toolResultProblem(fail({ kind: 'nope' as never, message: 'm' }, dataFor()))).toContain(
      '"error.kind" must be one of the closed set',
    )
    expect(toolResultProblem(fail({ kind: 'timeout', message: '' }, dataFor()))).toContain(
      '"error.message" must be a non-empty string',
    )
  })

  it('`nextStep` 两支**恰有其一**：都没有 / 都有 / `tool` 空串 都判不合规', () => {
    const base = ok(dataFor())
    expect(toolResultProblem({ ...base, nextStep: { why: 'look at the fiber' } })).toContain(
      'must carry an action',
    )
    expect(
      toolResultProblem({
        ...base,
        nextStep: { tool: 'dsh_dump_config', manual: true, why: 'w' },
      }),
    ).toContain('not both')
    expect(toolResultProblem({ ...base, nextStep: { tool: '', why: 'w' } })).toContain(
      '"nextStep.tool" must be a non-empty string',
    )
  })

  it('兜底：不合规 → 合成 `internal` 失败，`data` 恰好 `{verdict, key:{}, audit:{}}` 且 verdict 非空', () => {
    const guarded = ensureToolResult({ ok: false, error: { kind: 'nope' } })
    expect(guarded.ok).toBe(false)
    if (guarded.ok) throw new Error('期望兜底失败')
    expect(guarded.error.kind).toBe('internal')
    expect(Object.keys(guarded.data).sort()).toEqual(['audit', 'key', 'verdict'])
    expect(guarded.data.verdict).not.toBe('')
    expect(guarded.data.key).toEqual({})
    // 兜底产出的东西自己必须合规 —— 否则守卫会拒掉自己的产物。
    expect(toolResultProblem(guarded)).toBeUndefined()
  })

  it('`toolResultProblem` 与 `ensureToolResult` **同意同一套规则**（§4.1 的硬要求）', () => {
    const candidates: unknown[] = [
      ok(dataFor()),
      fail({ kind: 'timeout', message: 'm' }, dataFor()),
      fail({ kind: 'timeout', message: 'm' }, dataFor(), MANUAL),
      { ok: true },
      { ok: 'yes', data: dataFor() },
      { ...ok(dataFor()), data: { verdict: 'v', key: {}, audit: {}, fourth: 1 } },
      { ...ok(dataFor()), nextStep: { tool: 'x', manual: true, why: 'w' } },
      'not an object',
      null,
      [1, 2],
    ]
    const problems = candidates.map((candidate) => toolResultProblem(candidate))
    for (const [index, candidate] of candidates.entries()) {
      const problem = problems[index]
      const guarded = ensureToolResult(candidate)
      if (problem === undefined) {
        expect(guarded, `候选 #${String(index)} 被守卫改写过，但校验器说它合规`).toBe(candidate)
      } else {
        expect(guarded.ok, `候选 #${String(index)} 被判不合规却没被兜底`).toBe(false)
        if (!guarded.ok) expect(guarded.error.kind).toBe('internal')
      }
    }
    // 自证非空转：这批候选里确实两种结论都出现过。
    expect(problems.some((problem) => problem === undefined)).toBe(true)
    expect(problems.some((problem) => problem !== undefined)).toBe(true)
  })

  it('kind 仍在闭枚举内（兜底不改变 kind 的职责）', () => {
    expect(TOOL_ERROR_KINDS).toContain('timeout')
    expect(TOOL_ERROR_KINDS).toContain('internal')
  })
})

/**
 * 契约：**返回值还必须可无损落 JSON**（2026-10-13 加，守宿主的边界）。
 *
 * ## 为什么形状表不够（这一节是**实测**出来的，不是推演）
 *
 * 真机回归：`dsh_diagnose_plugin_load` 的
 * `data.audit.startupLogs.reports[0].report.messages[2].text` 是一个**值为 `undefined`** 的
 * 自有可枚举属性 —— `toolResultProblem` 的形状表**逐条全绿**（`data` 恰好三键、
 * `verdict` 非空、`key` 是对象），而宿主在同一次调用上抛
 * `ToolOutputError(toolName, ['value is not lossless JSON'])`：
 * 模型拿到的是那句报错，**拿不到** `verdict` / `key` / `audit`。
 *
 * 所以 `toolResultProblem` 现在是**两段**：形状表 + 「可无损落 JSON」。
 * 判据本体是宿主 `@deepseek-ai/dsh-util-values` 的 `walkJsonValue` 那四条
 * （见 `src/lib/errors.ts` 的 `jsonValueProblem` 文件头）。
 */
describe('契约：返回值必须可无损落 JSON（宿主边界）', () => {
  /** 四条判据各一个反例（外加三个同族的），逐个判红。 */
  const violations: Array<[string, unknown, string]> = [
    ['undefined', { a: undefined }, 'undefined'],
    ['NaN', { a: Number.NaN }, 'NaN'],
    ['Infinity', { a: Number.POSITIVE_INFINITY }, 'Infinity'],
    ['negative zero', { a: -0 }, 'negative zero'],
    ['bigint', { a: 1n }, 'bigint'],
    ['function', { a: () => undefined }, 'function'],
    ['symbol', { a: Symbol('x') }, 'symbol'],
    ['class instance', new Error('x'), 'non-enumerable'],
    [
      'non-enumerable own property',
      Object.defineProperty({ a: 1 }, 'hidden', { value: 2 }),
      'non-enumerable',
    ],
    ['symbol key', { [Symbol('k')]: 1 }, 'symbol key'],
    [
      'accessor property',
      {
        get a(): number {
          return 1
        },
      },
      'accessor',
    ],
  ]

  it('四类违规逐个判红，且报出**完整路径**', () => {
    for (const [label, value, needle] of violations) {
      const problem = jsonValueProblem(value, 'the result')
      expect(problem, `${label} 竟然被判成无损 JSON`).toBeTypeOf('string')
      expect(problem, `${label} 的报告里应当点明原因`).toContain(needle)
    }
  })

  it('循环引用判红（DAG 的共享节点**不**判红 —— 只有祖先才算循环）', () => {
    const cyclic: Record<string, unknown> = { verdict: 'v' }
    cyclic['self'] = cyclic
    expect(jsonValueProblem(cyclic, 'the result')).toContain('circular reference')

    // 同一个对象在两处出现但**不是**循环：那是合法的 JSON，误判会让正常的共享记录变红。
    const shared = { file: './cordis.patch.yml' }
    const diamond = { a: { patches: [shared] }, b: { patches: [shared] } }
    expect(jsonValueProblem(diamond, 'the result')).toBeUndefined()
  })

  it('合法值判绿（含 `null` / 空数组 / 负有限数 / 深到 60 层）', () => {
    expect(jsonValueProblem(dataFor(), 'the result')).toBeUndefined()
    expect(jsonValueProblem({ a: null, b: [], c: 0, d: -1.5, e: '' }, 'the result')).toBeUndefined()
    let deep: unknown = 'leaf'
    for (let i = 0; i < 60; i += 1) deep = { next: deep }
    expect(jsonValueProblem(deep, 'the result')).toBeUndefined()
  })

  it('绝不抛：敌意对象与超深结构都收敛成一句话（`errors.ts` 承诺「绝不抛」）', () => {
    // getOwnPropertyDescriptor 的**陷阱**：`Proxy` 能让这一次读抛，而判据在返回值路径上。
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('trap')
        },
      },
    )
    expect(() => jsonValueProblem(hostile, 'the result')).not.toThrow()
    expect(jsonValueProblem(hostile, 'the result')).toContain('could not be verified')

    // getter 属性走的是「不可枚举 / 访问器」那一支 —— 判据**不调用它**，所以它抛不出来。
    const accessor = {
      get boom(): never {
        throw new Error('trap')
      },
    }
    expect(jsonValueProblem(accessor, 'the result')).toContain('accessor property')

    // 超深结构：判红，**不是**当成合法放行（放行就等于把异常交给宿主）。
    let tooDeep: unknown = 'leaf'
    for (let i = 0; i < 200; i += 1) tooDeep = { next: tooDeep }
    expect(jsonValueProblem(tooDeep, 'the result')).toContain('nesting depth')
  })

  it('`toolResultProblem` 把「形状合法但不是无损 JSON」判为违规 —— 守卫不再只查形状', () => {
    const candidate = {
      ok: true,
      data: { verdict: 'v', key: {}, audit: { messages: [{ text: undefined }] } },
    }
    const problem = toolResultProblem(candidate)
    expect(problem, '形状表全绿，而宿主会拒收 —— 这就是真机回归那条').toContain('undefined')
    expect(problem).toContain('audit.messages[0].text')
  })

  it('`ensureToolResult` 把它换成**自身也无损**的兜底，而不是原样放行', () => {
    const candidate = {
      ok: true,
      data: { verdict: 'v', key: {}, audit: { messages: [{ text: undefined }] } },
    }
    const guarded = ensureToolResult(candidate)
    expect(guarded, '原样放行 = 把一次硬失败交给宿主').not.toBe(candidate)
    if (guarded.ok) throw new Error('期望兜底失败')
    expect(guarded.error.kind).toBe('internal')
    // 兜底自己必须过两道判据 —— 否则宿主要拒收**它的**产物。
    expect(toolResultProblem(guarded)).toBeUndefined()
    expect(jsonValueProblem(guarded, 'the result')).toBeUndefined()
    // 措辞要说清是「不是无损 JSON」而不是「形状不对」：两者的修法不一样。
    expect(guarded.error.message).toContain('lossless JSON')
    expect(guarded.data.verdict).toContain('lossless JSON')
    // 形状类的兜底措辞**不许**被这一处改掉。
    const shapeBroken = ensureToolResult({ ok: true, data: { verdict: '', key: {}, audit: {} } })
    if (shapeBroken.ok) throw new Error('期望兜底失败')
    expect(shapeBroken.error.message).toContain('invalid shape')
  })

  it('形状判据的**原有措辞**不变（B21 / B24 的断言逐字依赖它们）', () => {
    // 判据按顺序走：形状先于无损，所以形状类的违规不会被新判据改写措辞。
    expect(toolResultProblem({ ok: 'yes', data: dataFor() })).toContain('"ok" must be a boolean')
    expect(toolResultProblem({ ok: true, data: { verdict: '', key: {}, audit: {} } })).toContain(
      '"data.verdict" must be a non-empty string',
    )
    expect(toolResultProblem('not an object')).toContain('the result must be an object')
  })
})

describe('契约：三层渲染（旧「渲染层打 evidence」组 → 新形状）', () => {
  it('失败档：头行是 `failed (<kind>)`，`verdict:` 行**逐字**等于 `data.verdict`', () => {
    const data = dataFor('the host answered 401, not a connection refusal')
    const result = fail({ kind: 'auth', message: 'the host answered 401' }, data, MANUAL)
    const text = renderToolResultText('dsh_check_auth', result, TABLE)

    expect(text).toContain('[dsh_check_auth] failed (auth)')
    expect(text).toContain(`verdict: ${data.verdict}`)
  })

  it('`evidence:` / `hint:` / `message:` 三种行**一个都不打**（这就是 evidence 退役的落点）', () => {
    const result = fail(
      { kind: 'reload-failed', message: 'the new code failed to import' },
      { verdict: 'the running entry was never touched', key: {}, audit: {} },
      MANUAL,
    )
    const text = renderToolResultText('dsh_hot_reload', result, TABLE)
    expect(text).not.toContain('evidence:')
    expect(text).not.toContain('hint:')
    expect(text).not.toContain('message:')
    // 但 `error.message` 确实还在**结构化值**里（它只是不进模型文本）。
    expect(result.error.message).toBe('the new code failed to import')
  })

  it('成功档：`verdict:` 行 = `data.verdict`，L2 的**顺序即 `table.key` 的顺序**', () => {
    const table: RenderTable<{ port: number }> = {
      key: () => ['first line', 'second line', 'third line'],
    }
    const text = renderToolResultText('dsh_check_auth', ok(dataFor('port resolved')), table)
    expect(text.split('\n')).toEqual([
      '[dsh_check_auth] ok',
      'verdict: port resolved',
      'first line',
      'second line',
      'third line',
    ])
  })

  it('L2 里非字符串 / 空串的条目被丢掉（渲染不抛，永远有输出）', () => {
    const table = {
      key: () => ['kept', '', 7 as unknown as string],
    } as unknown as RenderTable<{ port: number }>
    const text = renderToolResultText('dsh_check_auth', ok(dataFor('v')), table)
    expect(text.split('\n')).toEqual(['[dsh_check_auth] ok', 'verdict: v', 'kept'])
  })

  it('工具支：`nextStep: <tool>(<args JSON>) — <why>`；args 缺省印空括号', () => {
    const withArgs = renderToolResultText(
      't',
      ok(dataFor(), { tool: 'dsh_dump_config', args: { profile: 'web' }, why: 'check the tree' }),
      TABLE,
    )
    expect(withArgs).toContain('nextStep: dsh_dump_config({"profile":"web"}) — check the tree')

    const withoutArgs = renderToolResultText(
      't',
      ok(dataFor(), { tool: 'dsh_dump_config', why: 'check the tree' }),
      TABLE,
    )
    expect(withoutArgs).toContain('nextStep: dsh_dump_config() — check the tree')
  })

  it('manual 支：`nextStep: <why>` —— 不印 `—`、不印空括号', () => {
    const text = renderToolResultText('t', ok(dataFor(), MANUAL), TABLE)
    expect(text).toContain(`nextStep: ${MANUAL.why}`)
    expect(text).not.toContain('nextStep: —')
    expect(text).not.toContain('()')
  })

  it('没有 nextStep 时 `nextStep:` 行**不出现**', () => {
    const text = renderToolResultText('t', ok(dataFor()), TABLE)
    expect(text).not.toContain('nextStep:')
  })

  it('截断要**明说**并给总数（超 `maxKeyLines` 时末行是冻结模板）', () => {
    const table: RenderTable<{ port: number }> = { key: () => ['a', 'b', 'c', 'd'], maxKeyLines: 2 }
    const text = renderToolResultText('t', ok(dataFor('v')), table)
    expect(text.split('\n')).toEqual([
      '[t] ok',
      'verdict: v',
      'a',
      'b',
      '2 more line(s) not shown — the full record is in the session log',
    ])
  })

  it('不声明 `maxKeyLines` 时用默认上限（15）', () => {
    const lines = Array.from(
      { length: DEFAULT_MAX_KEY_LINES + 1 },
      (_item, index) => `l${String(index)}`,
    )
    const text = renderToolResultText('t', ok(dataFor('v')), { key: () => lines })
    const shown = text.split('\n')
    expect(shown.length).toBe(DEFAULT_MAX_KEY_LINES + 3) // 头行 + verdict 行 + 15 行 + 截断行
    expect(shown.at(-1)).toBe('1 more line(s) not shown — the full record is in the session log')
  })

  it('`audit` 的叶子值**不进**模型文本（哨兵；B22 的判据）', () => {
    const sentinel = 'SENTINEL_B22_9f3a1c'
    const data: ToolData<{ port: number }> = {
      verdict: 'ok',
      key: { port: 3080 },
      audit: { deep: { locator: sentinel } },
    }
    const text = renderToolResultText('t', ok(data), TABLE)
    expect(text).toContain('verdict: ok') // 渲染确实跑了
    expect(text).not.toContain(sentinel)
  })

  it('形状不合法的值 → 退化成**一行**原始 JSON（保持永远有输出）', () => {
    expect(renderToolResultText('dsh_x', { ok: true }, TABLE)).toBe('[dsh_x] {"ok":true}')
    expect(renderToolResultText('dsh_x', null, TABLE)).toBe('[dsh_x] null')
    expect(renderToolResultText('dsh_x', { ok: false, error: {} }, TABLE)).toBe(
      '[dsh_x] {"ok":false,"error":{}}',
    )
  })

  it('渲染不修改传入的值（纯函数：同一个 value 两次渲染同一个文本）', () => {
    const value: ToolResult<{ port: number }> = ok(dataFor('v'), STEP)
    const before = JSON.stringify(value)
    const first = renderToolResultText('t', value, TABLE)
    const second = renderToolResultText('t', value, TABLE)
    expect(first).toBe(second)
    expect(JSON.stringify(value)).toBe(before)
  })
})
