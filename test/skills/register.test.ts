import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'
import type { SkillRegistration, SkillRegistry } from '@deepseek-ai/dsh-skill'
import { describe, expect, it } from 'vitest'

import { registerSkills } from '../../src/skills/register.ts'
import type { SkillReport } from '../../src/contracts.ts'

/**
 * 技能半边的红线。
 *
 * 三条纪律：
 * 1. **不引 Cordis 真身**：`ctx.effect` 用普通对象替身，但替身要像 Cordis 那样**真的迭代生成器**
 *    （cordis `_execute` 会同步迭代 `Symbol.iterator` 并逐个收集 yield 出来的 disposer，
 *    见 `…\cordis\lib\index.js:1142-1153`）。替身不跑生成器，就等于没测注册。
 * 2. **失败必须 fail-closed**：任何失败路径都不许调用 `register` —— 注册一个坏技能比不注册更糟。
 * 3. **字节数要是真的**：`contentBytes` 用来照出「注册成了但正文是空的」，所以断言要拿
 *    **独立算出来的**正文比对，不能拿实现自己的算法自证。
 */

/** 真实的、随包分发的技能文件。 */
const SKILL_PATH = fileURLToPath(
  new URL('../../skills/dsh-plugin-debugging/SKILL.md', import.meta.url),
)
/** 夹具根：`test/skills/fixtures/<case>/dsh-plugin-debugging/SKILL.md`。 */
const fixtureRoot = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))

/** `ctx.effect` 替身：同步跑生成器、收集 disposer，行为对齐 Cordis。 */
interface FakeCtx {
  ctx: Context
  /** 每次 `effect()` 收集到的 disposer，按注册序。 */
  disposers: Array<() => void>
  /**
   * 计数器放对象里，**不要**平铺成数字字段：平铺后解构出来的是**快照**，
   * 调用后读到的是 0 —— 这类「测试替身自己骗自己」的假绿比测不出更危险。
   */
  stats: { effectCalls: number }
  /** 按事件名记下 `ctx.on` 注册的处理器，供测试手动派发。 */
  handlers: Map<string, Array<(payload: unknown) => unknown>>
  /** 同步派发一个事件，返回各处理器的返回值（用来断言「同步、且返回 undefined」）。 */
  emit: (event: string, payload: unknown) => unknown[]
}

function makeCtx(options: { throwOnEffect?: boolean; throwOnOn?: boolean } = {}): FakeCtx {
  const disposers: Array<() => void> = []
  const handlers = new Map<string, Array<(payload: unknown) => unknown>>()
  const state: FakeCtx = {
    ctx: undefined as unknown as Context,
    disposers,
    stats: { effectCalls: 0 },
    handlers,
    emit(event: string, payload: unknown): unknown[] {
      return (handlers.get(event) ?? []).map((handler) => handler(payload))
    },
  }
  const fake = {
    effect(execute: () => unknown) {
      state.stats.effectCalls += 1
      if (options.throwOnEffect === true) throw new Error('fiber 已卸载')
      const result = execute()
      if (result !== null && typeof result === 'object' && Symbol.iterator in result) {
        for (const yielded of result as Iterable<unknown>) {
          if (typeof yielded === 'function') disposers.push(yielded as () => void)
        }
      } else if (typeof result === 'function') {
        disposers.push(result as () => void)
      }
      return () => {}
    },
    on(event: string, handler: (payload: unknown) => unknown) {
      if (options.throwOnOn === true) throw new Error('事件名不认识')
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {
        handlers.set(
          event,
          (handlers.get(event) ?? []).filter((h) => h !== handler),
        )
      }
    },
  }
  state.ctx = fake as unknown as Context
  return state
}

/** `ctx.skills` 替身：记录每次 `register` 的载荷。 */
interface FakeSkills {
  skills: SkillRegistry
  calls: SkillRegistration[]
}

function makeSkills(options: { throwOnRegister?: boolean } = {}): FakeSkills {
  const calls: SkillRegistration[] = []
  const fake = {
    register(skill: SkillRegistration) {
      calls.push(skill)
      if (options.throwOnRegister === true) throw new Error('宿主的注册表拒绝了这个技能')
      return () => {}
    },
  }
  return { skills: fake as unknown as SkillRegistry, calls }
}

/**
 * **独立**切出正文（不复用实现里的算法）：按行找第二行 `---`，其余即正文，再 trim。
 * 与实现的差别在于实现是按索引切片以保住 CRLF 字节，这里只用于算期望值。
 */
function expectedBody(raw: string): string {
  const lines = raw.split('\n')
  const close = lines.indexOf('---', 1)
  if (close < 0) throw new Error('夹具没有 frontmatter 闭合行')
  return lines
    .slice(close + 1)
    .join('\n')
    .replace(/\r$/, '')
    .trim()
}

describe('registerSkills —— 成功路径', () => {
  it('把随包分发的 SKILL.md 注册成 runtime 技能，字段齐全且只注册一次', () => {
    const handle = makeCtx()
    const { skills, calls } = makeSkills()

    const report = registerSkills(handle.ctx, skills)

    expect(report.ok).toBe(true)
    expect(report.error).toBeUndefined()
    expect(report.name).toBe('dsh-plugin-debugging')

    // 恰好一次：多注册一次会撞上宿主的 first-wins（后来者拿 no-op disposer 静默作废）。
    expect(calls).toHaveLength(1)
    expect(handle.stats.effectCalls).toBe(1)

    const registered = calls[0]
    expect(registered).toBeDefined()
    expect(Object.keys(registered).sort()).toEqual(['content', 'description', 'name', 'source'])
    expect(registered.name).toBe('dsh-plugin-debugging')
    expect(registered.source).toBe('runtime')
    expect(registered.description).toBe(
      'Debugging a DSH plugin against a running DSH instance. Use when a change did not take effect, when unsure whether to reload/restart, when the page returns 401, or when setting up an isolated instance.',
    )

    // 注册挂在 fiber 上：disposer 必须被 ctx.effect 收到，卸载时才撤得掉。
    expect(handle.disposers).toHaveLength(1)
    expect(typeof handle.disposers[0]).toBe('function')
  })

  it('正文是真实的技能正文（逐字），contentBytes 是它的 UTF-8 字节数', () => {
    const { ctx } = makeCtx()
    const { skills, calls } = makeSkills()

    const report = registerSkills(ctx, skills)

    const raw = readFileSync(SKILL_PATH, 'utf8')
    const body = expectedBody(raw)

    // 独立算出来的期望值：不能拿实现自己的算法自证。
    expect(report.contentBytes).toBe(Buffer.byteLength(body, 'utf8'))
    expect(report.contentBytes).toBe(Buffer.byteLength(calls[0].content, 'utf8'))
    expect(calls[0].content).toBe(body)

    // frontmatter 真的被切掉了、没有把整份文件当正文（字节数必须小于全文）。
    expect(report.contentBytes).toBeGreaterThan(0)
    expect(report.contentBytes as number).toBeLessThan(Buffer.byteLength(raw, 'utf8'))
    expect(calls[0].content.startsWith('---')).toBe(false)
    // 正文首尾的锚点：证明这是 v2.1.4 那份技能，不是别的文件。
    expect(calls[0].content.startsWith('# DSH 插件排障')).toBe(true)
    expect(calls[0].content.endsWith('不涉及 patch 方言的完整写法。')).toBe(true)
  })

  it('技能根按产物位置解析：从 lib/skills/ 上溯两级仍落在包根的 skills/', () => {
    // 本文件是 src/skills/register.ts，产物是 lib/skills/register.js；两种布局下
    // MODULE_DIR/../.. 都应等于包根。这里用**产物布局**算一遍并落到真实文件上。
    const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
    const producedModuleDir = join(repoRoot, 'lib', 'skills')
    const resolvedRoot = join(producedModuleDir, '..', '..', 'skills')

    expect(resolvedRoot).toBe(join(repoRoot, 'skills'))
    // 上溯一级会落到 lib/skills（错），这里显式钉住「不是一个『差不多』的路径」。
    expect(join(producedModuleDir, '..', 'skills')).not.toBe(resolvedRoot)
    expect(() => readFileSync(join(resolvedRoot, 'dsh-plugin-debugging', 'SKILL.md'))).not.toThrow()
  })
})

describe('registerSkills —— fail-closed 分支', () => {
  it('文件缺失 → missing-file，且不注册', () => {
    const { ctx } = makeCtx()
    const { skills, calls } = makeSkills()

    const report = registerSkills(ctx, skills, { skillRoot: fixtureRoot('does-not-exist') })

    expect(report.ok).toBe(false)
    expect(report.error?.kind).toBe('missing-file')
    expect(report.error?.message).toContain('SKILL.md')
    expect(report.error?.hint).not.toBe('')
    expect(calls).toHaveLength(0)
  })

  it('没有 frontmatter → bad-frontmatter，且不注册', () => {
    const { ctx } = makeCtx()
    const { skills, calls } = makeSkills()

    const report = registerSkills(ctx, skills, { skillRoot: fixtureRoot('no-frontmatter') })

    expect(report.error?.kind).toBe('bad-frontmatter')
    expect(calls).toHaveLength(0)
  })

  it('frontmatter 缺 description → bad-frontmatter，且不注册', () => {
    const { ctx } = makeCtx()
    const { skills, calls } = makeSkills()

    const report = registerSkills(ctx, skills, {
      skillRoot: fixtureRoot('bad-frontmatter-description'),
    })

    expect(report.error?.kind).toBe('bad-frontmatter')
    expect(calls).toHaveLength(0)
  })

  it('name 不是 kebab-case → bad-frontmatter，且不注册', () => {
    const { ctx } = makeCtx()
    const { skills, calls } = makeSkills()

    const report = registerSkills(ctx, skills, { skillRoot: fixtureRoot('bad-frontmatter-name') })

    expect(report.error?.kind).toBe('bad-frontmatter')
    expect(report.error?.message).toContain('Bad_Name')
    expect(calls).toHaveLength(0)
  })

  it('description 是块标量 → bad-frontmatter（不许把 >- 当描述文本注册进去）', () => {
    const { ctx } = makeCtx()
    const { skills, calls } = makeSkills()

    const report = registerSkills(ctx, skills, {
      skillRoot: fixtureRoot('block-scalar-description'),
    })

    expect(report.error?.kind).toBe('bad-frontmatter')
    expect(calls).toHaveLength(0)
  })

  it('正文为空（只有空白）→ empty-content，且不注册', () => {
    const { ctx } = makeCtx()
    const { skills, calls } = makeSkills()

    const report = registerSkills(ctx, skills, { skillRoot: fixtureRoot('empty-content') })

    expect(report.error?.kind).toBe('empty-content')
    expect(report.contentBytes).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  it('ctx.skills 缺席 → no-registry（正常降级，不是错误路径）', () => {
    const handle = makeCtx()

    const report = registerSkills(handle.ctx, undefined)

    expect(report.ok).toBe(false)
    expect(report.error?.kind).toBe('no-registry')
    // 没有注册表就**不该**开 effect：技能半边完全不该碰 fiber。
    expect(handle.stats.effectCalls).toBe(0)
  })
})

describe('registerSkills —— 异常不外泄', () => {
  it('register 抛错 → 收敛成 internal，不往外抛', () => {
    const { ctx } = makeCtx()
    const { skills, calls } = makeSkills({ throwOnRegister: true })

    let report: SkillReport | undefined
    expect(() => {
      report = registerSkills(ctx, skills)
    }).not.toThrow()

    expect(report?.ok).toBe(false)
    expect(report?.error?.kind).toBe('internal')
    expect(report?.error?.message).toContain('宿主的注册表拒绝了这个技能')
    // 注册确实被尝试过（抛错发生在 register 内部），但报告必须是失败。
    expect(calls).toHaveLength(1)
  })

  it('ctx.effect 抛错 → 收敛成 internal，不往外抛', () => {
    const { ctx } = makeCtx({ throwOnEffect: true })
    const { skills } = makeSkills()

    let report: SkillReport | undefined
    expect(() => {
      report = registerSkills(ctx, skills)
    }).not.toThrow()

    expect(report?.error?.kind).toBe('internal')
  })
})

/**
 * 动态 scope 注入 —— 技能进「活跃 agent 的 preset 作用域」，与 `skill-filesystem` 同层，
 * 这样 rank 250 才在同层仲裁里真正赢用户级 400/500（实测见 `.coord/verify-dynamic-scope.md`）。
 *
 * 这里钉住四条**实测出来的纪律**，它们错了都会**静默**（技能看着注册了、却赢不了或被遮蔽）：
 * 1. 已经在跑的 agent：apply 时遍历 `agents.list()` 注册；
 * 2. 之后新开的 agent：`agent/created` **同步**处理器注册（宿主类型要求返回 `undefined`，
 *    且实测在处理器里 `await` 会让 `agents.create()` 卡死）；
 * 3. 作用域注册表取自 `agent.ctx.get('skills')`（`presets.serviceFor` 那条路不用）；
 * 4. 动态注入失败**不**影响全局那次注册的 `ok`。
 */
describe('registerSkills —— 动态 scope 注入', () => {
  /** 一个 agent 替身：它的 ctx 能取到「作用域技能注册表」。 */
  function makeAgent(options: { noRegistry?: boolean; throwOnRegister?: boolean } = {}) {
    const calls: SkillRegistration[] = []
    const registry = {
      register(skill: SkillRegistration) {
        calls.push(skill)
        if (options.throwOnRegister === true) throw new Error('作用域注册表拒绝')
        return () => {}
      },
    }
    const agent = {
      ctx: {
        get(name: string) {
          if (name !== 'skills') return undefined
          return options.noRegistry === true ? undefined : registry
        },
      },
    }
    return { agent, calls }
  }

  it('apply 时已存在的 agent 会被注册进它的作用域，且计数如实', () => {
    const handle = makeCtx()
    const { skills } = makeSkills()
    const a = makeAgent()
    const b = makeAgent()

    const report = registerSkills(handle.ctx, skills, {
      agents: () => ({ list: () => [a.agent, b.agent] }),
    })

    expect(report.ok).toBe(true)
    expect(report.scoped).toEqual({ initial: 2, failed: 0 })
    // 每个 agent 各注册一次，**载荷与全局那次同一个定义**。
    expect(a.calls).toHaveLength(1)
    expect(b.calls).toHaveLength(1)
    expect(a.calls[0]?.source).toBe('runtime')
  })

  it('之后新开的 agent 由 agent/created 覆盖，且处理器是**同步**的', () => {
    const handle = makeCtx()
    const { skills } = makeSkills()
    const later = makeAgent()

    // apply 时一个 agent 都没有 —— 正是「插件先加载、会话后开」的现场。
    const report = registerSkills(handle.ctx, skills, {
      agents: () => ({ list: () => [] }),
    })
    expect(report.scoped).toEqual({ initial: 0, failed: 0 })
    expect(later.calls).toHaveLength(0)

    // 派发后**立即**断言：处理器里不许有 await，否则这里拿不到注册结果。
    const returned = handle.emit('agent/created', { agent: later.agent, source: 'startup' })

    expect(later.calls).toHaveLength(1)
    // 宿主签名要求 `Promise<undefined> | undefined`；`undefined` = 没有 await 点。
    expect(returned).toEqual([undefined])
  })

  it('agent.ctx 里没有 skills 注册表 → 记 failed，但全局那次仍然 ok', () => {
    const handle = makeCtx()
    const { skills } = makeSkills()
    const broken = makeAgent({ noRegistry: true })

    const report = registerSkills(handle.ctx, skills, {
      agents: () => ({ list: () => [broken.agent] }),
    })

    expect(report.ok).toBe(true)
    expect(report.scoped).toEqual({ initial: 0, failed: 1 })
  })

  it('作用域注册抛错被吸收成 failed，不外泄也不推翻 ok', () => {
    const handle = makeCtx()
    const { skills } = makeSkills()
    const angry = makeAgent({ throwOnRegister: true })

    let report: SkillReport | undefined
    expect(() => {
      report = registerSkills(handle.ctx, skills, {
        agents: () => ({ list: () => [angry.agent] }),
      })
    }).not.toThrow()

    expect(report?.ok).toBe(true)
    expect(report?.scoped).toEqual({ initial: 0, failed: 1 })
  })

  it('agents 服务此刻缺席时仍然**武装事件处理器**（服务晚到也能覆盖到），计数为 0/0', () => {
    const handle = makeCtx()
    const { skills } = makeSkills()
    const later = makeAgent()

    // `() => undefined` = 调用方说「这个宿主现在没有 agents 服务」。
    // 实现仍然挂上 `agent/created`：因为处理器用的是 payload 里的 agent，**不依赖**那次 list()。
    // 这样服务晚到（或 apply 时还没装好）也不会漏掉后续会话。
    const report = registerSkills(handle.ctx, skills, { agents: () => undefined })

    expect(report.ok).toBe(true)
    expect(report.scoped).toEqual({ initial: 0, failed: 0 })
    expect(handle.handlers.size).toBe(1)

    handle.emit('agent/created', { agent: later.agent, source: 'startup' })
    expect(later.calls).toHaveLength(1)
  })

  it('**根本不传** agents 选项时不做动态注入（scoped 缺席，也不挂处理器）', () => {
    const handle = makeCtx()
    const { skills } = makeSkills()

    const report = registerSkills(handle.ctx, skills)

    expect(report.ok).toBe(true)
    expect(report.scoped).toBeUndefined()
    // 全局层那一次注册照旧发生（不传选项 = 只要全局注册）。
    expect(handle.handlers.size).toBe(0)
  })

  it('ctx.on 抛错（事件名变了）→ 退回「只有全局注册」，仍 ok', () => {
    const handle = makeCtx({ throwOnOn: true })
    const { skills } = makeSkills()

    let report: SkillReport | undefined
    expect(() => {
      report = registerSkills(handle.ctx, skills, { agents: () => ({ list: () => [] }) })
    }).not.toThrow()

    expect(report?.ok).toBe(true)
    expect(report?.scoped?.failed).toBeGreaterThan(0)
  })
})
