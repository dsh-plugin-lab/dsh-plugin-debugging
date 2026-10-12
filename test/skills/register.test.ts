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
}

function makeCtx(options: { throwOnEffect?: boolean } = {}): FakeCtx {
  const disposers: Array<() => void> = []
  const state: FakeCtx = {
    ctx: undefined as unknown as Context,
    disposers,
    stats: { effectCalls: 0 },
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
