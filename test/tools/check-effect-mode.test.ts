/**
 * `dsh_check_effect_mode` 的行为红线 + **W2-A 的形状断言**。
 *
 * 分两块：
 *
 * 1. **行为**（沿用改造前的断言，按新契约取数）：核心语义是 **HMR 前置门** ——
 *    先探 profile 里有没有可用的 hmr，文件层看不到才补跑一次 `--dump-config` 复核；
 *    没有 hmr 时任何「热生效」都必须降级成 `restart-required`。
 *    可达 kind 仍是穷举的：`internal`（防御性断言 / 非 ENOENT 的 spawn 错 / 意外异常）、
 *    `timeout`（预算耗尽 / dump 超时）、`cancelled`、`not-configured`（ENOENT）。
 * 2. **形状**（SHAPE §2.1 / §3.1 / §4.1）：四段描述、三层文本、`data` 恰好三键、
 *    `nextStep` 必须带动作、`audit` 不许进模型文本、失败分支也要有实质 `verdict`、
 *    `execute` 绝不 throw（B24 的形状）。这一块按红线 B16/B17/B18a/B18b/B20b/B21/B22 的
 *    判据在本工具自己身上跑一遍。
 */
import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import {
  CHECK_EFFECT_MODE_DESCRIPTION,
  createEffectModeTool,
  EFFECT_MODE_TOOL,
} from '../../src/tools/dsh_check_effect_mode.ts'
import {
  composeDescription,
  DESCRIPTION_MAX_CHARS,
  DESCRIPTION_MAX_LINES,
} from '../../src/tools/describe.ts'
import {
  ensureToolResult,
  TOOL_ERROR_KINDS,
  toolResultProblem,
  type JsonValue,
} from '../../src/lib/errors.ts'
import { decideEffectMode, type EffectChangeKind, type EffectInput } from '../../src/lib/effect.ts'
import {
  cmdResult,
  configFor,
  depsFor,
  execWith,
  expectFail,
  expectOk,
  jumpingClock,
  recordingSpawn,
  run,
  tempDshHome,
  writeProfile,
} from './helpers.ts'

/** 一段带 `- id: hmr` 的组合树。 */
const CONFIG_WITH_HMR = [
  '# == @deepseek-ai/dsh-base',
  '- id: hmr',
  "  name: '@deepseek-ai/dsh-hmr'",
  '- id: llm',
  "  name: '@deepseek-ai/dsh-llm'",
].join('\n')

/** 一段没有 hmr 的组合树。 */
const CONFIG_WITHOUT_HMR = [
  '# == @deepseek-ai/dsh-base',
  '- id: llm',
  "  name: '@deepseek-ai/dsh-llm'",
].join('\n')

/** hmr 所在的官方包名（放进 profile 的 `bundles` 就会被文件层探到）。 */
const HMR_BUNDLE = '@deepseek-ai/dsh-hmr'

/**
 * 走**工具自己的声明**取模型可见文本（不直接调 `renderToolResultText`）。
 *
 * 为什么：`toolOutput()` 已经绑好了工具名与输出表，直接调渲染函数就多一个「红线自己
 * 拼装」的漂移点；走 `tool.output.render` 才是宿主真正的取数口。
 *
 * @param tool 工具定义。
 * @param args 调用参数（渲染用）。
 * @param value 工具的返回值。
 */
function renderText(tool: ToolDefinition, args: unknown, value: unknown): string {
  const blocks = tool.output.render(args, value as JsonValue) as unknown as { text?: string }[]
  return blocks.map((block) => block.text ?? '').join('\n')
}

/**
 * 按 §3.1 的冻结逐行格式切分渲染文本（与红线实现同源的取数口）。
 *
 * @param text 渲染文本。
 */
function splitRender(text: string): { head?: string; verdict?: string; l2: string[]; l3?: string } {
  const headPattern = /^\[[\w_]+\] (ok|failed \([\w-]+\))$/
  const truncPattern = /^\d+ more line\(s\) not shown — the full record is in the session log$/
  const lines = text.split('\n')
  const verdictIndex = lines.findIndex((line) => line.startsWith('verdict: '))
  const nextStepIndex = lines.findIndex((line) => line.startsWith('nextStep:'))
  const head = lines.find((line) => headPattern.test(line))
  return {
    ...(head === undefined ? {} : { head }),
    ...(verdictIndex < 0 ? {} : { verdict: lines[verdictIndex]?.slice('verdict: '.length) }),
    l2: lines
      .slice(verdictIndex + 1, nextStepIndex < 0 ? lines.length : nextStepIndex)
      .filter((line) => !truncPattern.test(line)),
    ...(nextStepIndex < 0
      ? {}
      : { l3: (lines[nextStepIndex] ?? '').slice('nextStep:'.length).trim() }),
  }
}

/**
 * 找出 `a` 里**逐字出现在 `b` 中**的、长度 ≥`min` 的片段（B20b 的取交集手法）。
 *
 * @param a 描述文本。
 * @param b 渲染文本。
 * @param min 长度下限。
 */
function sharedSubstrings(a: string, b: string, min: number): string[] {
  const hits = new Set<string>()
  for (let start = 0; start + min <= a.length; start += 1) {
    const window = a.slice(start, start + min)
    if (b.includes(window)) hits.add(window)
  }
  return [...hits]
}

/**
 * 断言一条 `verdict` 是**实质句子**，不是 `failed` 这种占位。
 *
 * 为什么这条要单独写成助手：新格式里 `error.message` **不进模型文本**（SHAPE §4.1），
 * 失败分支的「所以呢」只能由 `data.verdict` 承载 —— 一旦某条分支写了个占位词，
 * 模型就只看到 `failed (kind)`，而没有任何红线会因此变红。
 *
 * @param verdict 失败（或成功）分支的 `data.verdict`。
 */
function expectSubstantiveVerdict(verdict: string): void {
  expect(verdict).not.toBe('')
  expect(verdict).not.toBe('failed')
  expect(verdict).not.toBe('unknown')
  expect(verdict.length, `verdict 太短、不像判定句：${verdict}`).toBeGreaterThan(60)
  expect(verdict).toMatch(/\s[\w]/u)
}

/** 一个「文件层就能看到 hmr」的 profile fixture。 */
async function hmrProfileFixture(): Promise<{
  tool: ReturnType<typeof createEffectModeTool>
  dshHome: string
}> {
  const dshHome = await tempDshHome()
  await writeProfile(dshHome, 'web', { bundles: [HMR_BUNDLE] })
  return { tool: createEffectModeTool(depsFor(configFor(dshHome))), dshHome }
}

/** 一个「文件层看不到 hmr、dump 复核也不带 hmr」的 fixture（降级路径）。 */
async function noHmrFixture(): Promise<{
  tool: ReturnType<typeof createEffectModeTool>
  calls: ReturnType<typeof recordingSpawn>['calls']
}> {
  const dshHome = await tempDshHome()
  await writeProfile(dshHome, 'web', { bundles: [] })
  const { spawn, calls } = recordingSpawn(() => cmdResult({ stdout: CONFIG_WITHOUT_HMR }))
  return { tool: createEffectModeTool(depsFor(configFor(dshHome), { spawn })), calls }
}

describe('dsh_check_effect_mode', () => {
  it('工具名与契约一致', () => {
    expect(EFFECT_MODE_TOOL).toBe('dsh_check_effect_mode')
  })

  describe('形状：描述层（SHAPE §2.1 冻结）', () => {
    it('四段骨架：合成器与声明一致、行数 ≤4、字符 ≤240', async () => {
      const dshHome = await tempDshHome()
      const tool = createEffectModeTool(depsFor(configFor(dshHome)))
      const description = CHECK_EFFECT_MODE_DESCRIPTION

      // 合成器与声明必须一致 —— 防止有人手写字符串绕过骨架。
      expect(tool.description).toBe(composeDescription(description))
      // 必填两段非空（滤空段不放宽它们）。
      expect(description.what.trim()).not.toBe('')
      expect(description.useWhen.trim()).not.toBe('')
      // 上界：骨架就是四段；下界：段数不许被空格连接并成一行。
      const present = [
        description.what,
        description.useWhen,
        description.boundary,
        description.cost,
      ].filter((segment) => segment !== undefined && segment.trim() !== '').length
      const lines = composeDescription(description).split('\n')
      expect(lines.length).toBeGreaterThanOrEqual(present)
      expect(lines.length).toBeLessThanOrEqual(DESCRIPTION_MAX_LINES)
      expect((tool.description ?? '').length).toBeLessThanOrEqual(DESCRIPTION_MAX_CHARS)

      // ⚠️ `defineTool` 把参数**编译成了 JSON schema**（`{ type, properties, required }`，
      // 见 AGENTS 活跃坑 11）—— 直接 `Object.values(tool.parameters)` 拿到的是 `'object'`
      // 字符串与 properties 对象本身，每条 `description` 都是 `undefined` ⇒ 合计恒为 0
      // ⇒ 合计恒为 0，**两条下界判红**（SHAPE §10.0：下界才是防空转的那一半）。
      const parameters = tool.parameters as {
        properties?: Record<string, { description?: string }>
      }
      const props = parameters.properties ?? {}
      const names = Object.keys(props)
      expect(names.length, '一个参数都没读到 —— 判据空转').toBe(2)
      let total = 0
      for (const name of names) {
        const text = props[name]?.description ?? ''
        expect(text, `参数 ${name} 的描述是空的`).not.toBe('')
        total += text.length
      }
      expect(total).toBeGreaterThan(0)
    })

    it('恒定知识只在描述层出现一次（旧输出里那两句机制说明逐字不在输出里）', async () => {
      const boundary = CHECK_EFFECT_MODE_DESCRIPTION.boundary ?? ''
      expect(boundary).toContain('Without hot reload')
      expect(boundary).toContain('Read-only')
      // 旧描述里那句「没挂 hmr 就落到重建+刷新」的复述必须消失（它现在是每次调用的结论）。
      expect(composeDescription(CHECK_EFFECT_MODE_DESCRIPTION)).not.toContain(
        'falls back to rebuild-and-refresh',
      )
    })
  })

  describe('成功路径', () => {
    it('profile 文件里有 hmr 时，配置改动是热生效（不降级），并给出可派发的下一步', async () => {
      const { tool } = await hmrProfileFixture()

      const result = await run(tool, { change: 'config' })
      const data = expectOk(result)
      expect(data.key['mode']).toBe('hot')
      expect(data.key['baseline']).toBe('hot')
      expect(data.key['downgraded']).toBe(false)
      expect(data.key['hmr']).toBe('present')
      // L1 必须点明**触发者在 hmr**，而不是只说「loader 会重读配置」。
      expect(data.verdict).toContain('watches the patch files')
      // `hot` 的下一步是可派发的：去组合树里核对那一行。
      expect(result.nextStep).toEqual({
        tool: 'dsh_dump_config',
        args: { profile: 'web' },
        why: expect.stringContaining('composed tree'),
      })
    })

    it('新装 bundle：不在 dependencies 里是热生效，在里面是必须重启', async () => {
      const { tool } = await hmrProfileFixture()

      const fresh = expectOk(
        await run(tool, { change: 'bundle-added', alreadyInDependencies: false }),
      )
      expect(fresh.key['mode']).toBe('hot')

      const alreadyResult = await run(tool, {
        change: 'bundle-added',
        alreadyInDependencies: true,
      })
      const already = expectOk(alreadyResult)
      expect(already.key['baseline']).toBe('restart-required')
      expect(already.key['mode']).toBe('restart-required')
      // hmr 可用且原表本来就要求重启 ⇒ **不是**降级（降级只有一个原因：没有 hmr）。
      expect(already.key['downgraded']).toBe(false)
      expect(already.key['hmr']).toBe('present')
      // 重启工具**尚未实现** ⇒ 只能给 manual，且不许建议调一个不存在的工具。
      expect(alreadyResult.nextStep).toEqual({
        manual: true,
        why: expect.stringContaining('restart the host process'),
      })
    })

    it('宿主端代码改动即使有 hmr 也必须重启（restart-required 不依赖降级）', async () => {
      const { tool } = await hmrProfileFixture()

      const result = await run(tool, { change: 'host-code' })
      const data = expectOk(result)
      expect(data.key['mode']).toBe('restart-required')
      expect(data.key['downgraded']).toBe(false)
      expect(data.key['hmr']).toBe('present')
      expect(data.verdict).toContain('not applied live')
    })

    it('文件层看不到、dump 复核里看到 hmr → 仍是热生效（复核的两条结论都要能落到）', async () => {
      const dshHome = await tempDshHome()
      // profile 文件里什么都不声明：文件层判不了，必须补跑 dump 复核。
      await writeProfile(dshHome, 'web', { bundles: [] })
      const { spawn, calls } = recordingSpawn(() => cmdResult({ stdout: CONFIG_WITH_HMR }))
      const tool = createEffectModeTool(depsFor(configFor(dshHome), { spawn }))

      const result = await run(tool, { change: 'config' })
      const data = expectOk(result)
      expect(data.key['mode']).toBe('hot')
      expect(data.key['downgraded']).toBe(false)
      expect(data.key['hmr']).toBe('present')
      expect(calls).toHaveLength(1)
      expect(calls[0]?.args).toContain('--dump-config')
      // 复核对 hmr 的**否定**才有降级；这里是否定的反面，两条证据都留下了。
      expect(data.audit['hmrSources']).toEqual(['profile-files', 'dump-config'])
    })

    it('dump 里找到 hmr 行但被静态禁用 → 仍降级；只被 !!js 条件禁用 → 仍算可用', async () => {
      // 「组合树里有那一行」**不等于**「有人在 watch patch 文件」：静态 disabled: true
      // 的 hmr 与没挂 hmr 是一回事（重读不会发生），必须降级。
      const disabledTree = ['- id: hmr', "  name: '@deepseek-ai/dsh-hmr'", '  disabled: true'].join(
        '\n',
      )
      // 本机 web profile 的真实形状：`disabled` 是一个运行时表达式（由 profileContext 决定）
      // → 不能当成确定不可用，按可用处理，但那次判定带着这个条件。
      const conditionalTree = [
        '- id: hmr',
        "  name: '@deepseek-ai/dsh-hmr'",
        "  disabled: !!js '!ctx.get(''profileContext'')'",
      ].join('\n')

      const disabledHome = await tempDshHome()
      await writeProfile(disabledHome, 'web', { bundles: [] })
      const { spawn: disabledSpawn } = recordingSpawn(() => cmdResult({ stdout: disabledTree }))
      const disabledTool = createEffectModeTool(
        depsFor(configFor(disabledHome), { spawn: disabledSpawn }),
      )
      const disabledData = expectOk(await run(disabledTool, { change: 'config' }))
      expect(disabledData.key['hmr']).toBe('absent')
      expect(disabledData.key['downgraded']).toBe(true)
      expect(disabledData.key['mode']).toBe('restart-required')

      const conditionalHome = await tempDshHome()
      await writeProfile(conditionalHome, 'web', { bundles: [] })
      const { spawn: conditionalSpawn } = recordingSpawn(() =>
        cmdResult({ stdout: conditionalTree }),
      )
      const conditionalTool = createEffectModeTool(
        depsFor(configFor(conditionalHome), { spawn: conditionalSpawn }),
      )
      const conditionalData = expectOk(await run(conditionalTool, { change: 'config' }))
      expect(conditionalData.key['hmr']).toBe('present')
      expect(conditionalData.key['downgraded']).toBe(false)
      expect(conditionalData.key['mode']).toBe('hot')
    })

    it('无 hmr 时「热生效」降级成 restart-required（核心断言）', async () => {
      const { tool, calls } = await noHmrFixture()

      const result = await run(tool, { change: 'config' })
      const data = expectOk(result)
      expect(data.key['baseline']).toBe('hot')
      expect(data.key['mode']).toBe('restart-required')
      expect(data.key['downgraded']).toBe(true)
      expect(data.key['hmr']).toBe('absent')
      // 文件层看不到 hmr → 必须补跑一次 dump 复核（否定的代价大）。
      expect(calls).toHaveLength(1)
      expect(calls[0]?.args).toContain('--dump-config')
      // L1 必须**直接读到**「没人 watch patch 文件，所以改 config 不会生效」。
      expect(data.verdict).toContain('nothing watches the patch files')
      expect(result.nextStep).toEqual({
        manual: true,
        why: expect.stringContaining('restart the host process'),
      })
    })

    it('无 hmr 时客户端改动降级成「构建 + 刷新」，不是重启', async () => {
      const { tool } = await noHmrFixture()

      const result = await run(tool, { change: 'client-code' })
      const data = expectOk(result)
      expect(data.key['baseline']).toBe('hmr')
      expect(data.key['mode']).toBe('client-rebuild')
      expect(data.key['downgraded']).toBe(true)
      expect(data.verdict).toContain('a host restart would not help')
      expect(result.nextStep).toEqual({
        manual: true,
        why: expect.stringContaining('rebuild the client'),
      })
    })

    it('有 hmr 时客户端改动走 hmr（下一步是刷新页面）', async () => {
      const { tool } = await hmrProfileFixture()

      const result = await run(tool, { change: 'client-code' })
      const data = expectOk(result)
      expect(data.key['mode']).toBe('hmr')
      expect(data.verdict).toContain('refresh the page')
      expect(result.nextStep).toEqual({
        manual: true,
        why: expect.stringContaining('refresh the page'),
      })
    })

    it('key 带出生效配置（含 DSH_HOME 来源）；端口报 not-used 而不是去猜', async () => {
      const dshHome = await tempDshHome()
      // profile 目录名必须与配置里的 profile **一致**：否则文件层探不到 hmr，
      // 就会退到 dump-config 那条路 —— 那这条断言就变成在测降级了。
      await writeProfile(dshHome, 'tui', { bundles: [HMR_BUNDLE] })
      // 来源声明成 default：诊断工具最怕「看着成功其实读错了目录」，来源必须可见。
      const tool = createEffectModeTool(
        depsFor(configFor(dshHome, { dshHomeSource: 'default', profile: 'tui' })),
      )

      const data = expectOk(await run(tool, { change: 'config' }))
      const resolved = data.key['resolved'] as Record<string, unknown>
      expect(resolved['dshHome']).toBe(dshHome)
      expect(resolved['dshHomeSource']).toBe('default')
      expect(resolved['profile']).toBe('tui')
      // 本工具不涉及端口：报 not-used，而不是把配置里那个「由工具推断」的 0 当结论。
      expect(resolved['port']).toBe(null)
      expect(resolved['portSource']).toBe('not-used')
      // 而且它确实真读了这个目录 —— hmr 是从 profiles/tui 里探到的（不是 dump 出来的）。
      expect(data.key['mode']).toBe('hot')
    })
  })

  describe('错误路径（每条可达 kind）', () => {
    it('internal：dshHome 空串是**契约被违反**的防御性断言（不再是 not-configured）', async () => {
      // 兜底补上之后（config → env → <homedir>/.dsh），空串在契约上不可能出现。
      // 所以这条不再是「配置缺失」而是「本插件的 bug」—— kind 必须是 internal，
      // 否则模型会去改配置、重试一个它根本改不动的东西。
      const tool = createEffectModeTool(depsFor(configFor('')))
      const failure = expectFail(await run(tool, { change: 'config' }))
      expect(failure.kind).toBe('internal')
      expect(failure.message).toContain('ResolvedConfig')
      expect(TOOL_ERROR_KINDS).toContain(failure.kind)
      expectSubstantiveVerdict(failure.data.verdict)
      // 没有动作可做 → nextStep 不出现（而不是把结论复述一遍）。
      expect(failure.nextStep).toBeUndefined()
      // 兜底 `key` 是 `{}`（由 shared.ts 合成）—— 渲染仍必须有输出、且不抛。
      const text = renderText(tool, { change: 'config' }, await run(tool, { change: 'config' }))
      expect(text).toContain('verdict:')
      expect(text).toContain(`[${EFFECT_MODE_TOOL}] failed (internal)`)
    })

    it('timeout：预算在复核 hmr 之前耗尽（stage=hmr-unverified）', async () => {
      const dshHome = await tempDshHome()
      await writeProfile(dshHome, 'web', { bundles: [] })
      const config = configFor(dshHome)
      const tool = createEffectModeTool(depsFor(config, { now: jumpingClock(config.timeoutMs) }))

      const failure = expectFail(await run(tool, { change: 'config' }))
      expect(failure.kind).toBe('timeout')
      expect(failure.data.key['stage']).toBe('hmr-unverified')
      expectSubstantiveVerdict(failure.data.verdict)
      expect(failure.data.verdict).toContain('neither "live" nor "restart required"')
      // 有动作可分派：去组合树里直接看 hmr 行。
      expect(failure.nextStep).toEqual({
        tool: 'dsh_dump_config',
        args: { profile: 'web' },
        why: expect.stringContaining('composed tree'),
      })
    })

    it('timeout：dump-config 传输层超时（stage=dump-timeout）', async () => {
      const dshHome = await tempDshHome()
      await writeProfile(dshHome, 'web', { bundles: [] })
      const { spawn } = recordingSpawn(() => cmdResult({ code: null, timedOut: true }))
      const tool = createEffectModeTool(depsFor(configFor(dshHome), { spawn }))

      const failure = expectFail(await run(tool, { change: 'host-code' }))
      expect(failure.kind).toBe('timeout')
      expect(failure.data.key['stage']).toBe('dump-timeout')
      expectSubstantiveVerdict(failure.data.verdict)
      expect(failure.nextStep).toEqual({
        tool: 'dsh_dump_config',
        args: { profile: 'web' },
        why: expect.any(String),
      })
    })

    it('cancelled：调用方在复核期间取消（stage=dump-cancelled）', async () => {
      const dshHome = await tempDshHome()
      await writeProfile(dshHome, 'web', { bundles: [] })
      const { spawn } = recordingSpawn(() => cmdResult({ code: null, aborted: true }))
      const tool = createEffectModeTool(depsFor(configFor(dshHome), { spawn }))

      const failure = expectFail(await run(tool, { change: 'config' }))
      expect(failure.kind).toBe('cancelled')
      expect(failure.data.key['stage']).toBe('dump-cancelled')
      expectSubstantiveVerdict(failure.data.verdict)
      expect(failure.nextStep).toEqual({ manual: true, why: expect.stringContaining('caller') })
    })

    it('not-configured：起不了 dsh（ENOENT）→ 派不了工具，只能 manual', async () => {
      const dshHome = await tempDshHome()
      await writeProfile(dshHome, 'web', { bundles: [] })
      const { spawn } = recordingSpawn(() => cmdResult({ code: null, spawnError: 'spawn: ENOENT' }))
      const tool = createEffectModeTool(depsFor(configFor(dshHome), { spawn }))

      const failure = expectFail(await run(tool, { change: 'config' }))
      expect(failure.kind).toBe('not-configured')
      expect(failure.data.key['stage']).toBe('launch-failed')
      expectSubstantiveVerdict(failure.data.verdict)
      expect(failure.data.verdict).toContain('could not be started')
      expect(failure.nextStep).toEqual({ manual: true, why: expect.stringContaining('PATH') })
    })

    it('internal：起不了 dsh 但不是 ENOENT（意外路径，不给下一步）', async () => {
      const dshHome = await tempDshHome()
      await writeProfile(dshHome, 'web', { bundles: [] })
      const { spawn } = recordingSpawn(() => cmdResult({ code: null, spawnError: 'spawn: EACCES' }))
      const tool = createEffectModeTool(depsFor(configFor(dshHome), { spawn }))

      const failure = expectFail(await run(tool, { change: 'config' }))
      expect(failure.kind).toBe('internal')
      expect(failure.data.key['stage']).toBe('launch-failed')
      expectSubstantiveVerdict(failure.data.verdict)
      expect(failure.data.verdict).toContain('unexpected way')
      expect(failure.nextStep).toBeUndefined()
    })

    it('internal：底层 spawn **抛异常**也被顶层兜住（execute 绝不 throw）', async () => {
      const dshHome = await tempDshHome()
      await writeProfile(dshHome, 'web', { bundles: [] })
      // 不给 spawn ⇒ helpers 的 `neverSpawn` 一调就抛。旧代码在这里**会抛出去**，
      // 于是宿主把它包成裸 `Error:`，`verdict` / `key` / `audit` 全部失效。
      const tool = createEffectModeTool(depsFor(configFor(dshHome)))

      const failure = expectFail(await run(tool, { change: 'config' }))
      expect(failure.kind).toBe('internal')
      expect(failure.data.key['stage']).toBe('unexpected')
      expectSubstantiveVerdict(failure.data.verdict)
      expect(failure.data.verdict).toContain('bug in this plugin')
      // 而且这句话是「人可复核」的原文，必须留在 audit 里（不进模型文本）。
      expect(String(failure.data.audit['error'])).not.toBe('')
    })
  })

  describe('signal 与超时纪律', () => {
    it('exec.signal 原样透传到底层 spawn', async () => {
      const dshHome = await tempDshHome()
      await writeProfile(dshHome, 'web', { bundles: [] })
      const controller = new AbortController()
      const { spawn, calls } = recordingSpawn(() => cmdResult({ stdout: CONFIG_WITHOUT_HMR }))
      const tool = createEffectModeTool(depsFor(configFor(dshHome), { spawn }))

      await run(tool, { change: 'config' }, execWith(controller.signal))
      expect(calls[0]?.signal).toBe(controller.signal)
      expect(calls[0]?.args).toContain('--dump-config')
    })

    it('传输层预算严格小于工具预算（否则宿主先掐，错误退化成裸 TimeoutError）', async () => {
      const dshHome = await tempDshHome()
      await writeProfile(dshHome, 'web', { bundles: [] })
      const { spawn, calls } = recordingSpawn(() => cmdResult({ stdout: CONFIG_WITHOUT_HMR }))
      const config = configFor(dshHome, { timeoutMs: 15_000 })
      const tool = createEffectModeTool(depsFor(config, { spawn }))

      await run(tool, { change: 'config' })
      const transport = calls[0]?.timeoutMs ?? 0
      expect(transport).toBeGreaterThan(0)
      expect(transport).toBeLessThan(config.timeoutMs)
      expect(tool.timeoutMs).toBe(config.timeoutMs)
    })
  })

  describe('形状：三层文本与 data（§3.1 / §4.1）', () => {
    it('`data` 顶层**恰好**三键：成功与失败都同形（B21）', async () => {
      const { tool } = await hmrProfileFixture()
      const success = await run(tool, { change: 'config' })
      expect(success.ok).toBe(true)
      if (!success.ok) throw new Error('期望成功')
      expect(Object.keys(success.data).sort()).toEqual(['audit', 'key', 'verdict'])
      expect(toolResultProblem(success)).toBeUndefined()

      const dshHome = await tempDshHome()
      await writeProfile(dshHome, 'web', { bundles: [] })
      const { spawn } = recordingSpawn(() => cmdResult({ code: null, spawnError: 'spawn: ENOENT' }))
      const broken = createEffectModeTool(depsFor(configFor(dshHome), { spawn }))
      const failure = await run(broken, { change: 'config' })
      expect(failure.ok).toBe(false)
      if (failure.ok) throw new Error('期望失败')
      expect(Object.keys(failure.data).sort()).toEqual(['audit', 'key', 'verdict'])
      expect(toolResultProblem(failure)).toBeUndefined()
    })

    it('模型文本只有 头行 / verdict / L2 / nextStep —— 没有整块 JSON，也没有 audit（B22）', async () => {
      const { tool } = await hmrProfileFixture()
      const result = await run(tool, { change: 'config' })
      const text = renderText(tool, { change: 'config' }, result)
      const parts = splitRender(text)

      expect(parts.head).toBe(`[${EFFECT_MODE_TOOL}] ok`)
      expect(parts.verdict).not.toBeUndefined()
      // L2 必须有判定本身与「读的是哪份配置」。
      expect(parts.l2).toContain('mode: hot')
      expect(parts.l2.some((line) => line.startsWith('resolved:'))).toBe(true)
      // 不再有 pretty JSON（两空格缩进的块）。
      expect(text).not.toContain('\n  "')

      // 哨兵自检：把哨兵埋进 `audit` 深处，渲染结果里**一个字符都不许出现**。
      const sentinel = 'SENTINEL_B22_9f3a1c'
      const raw = result as unknown as { data?: Record<string, unknown> }
      const patched = {
        ...(result as unknown as Record<string, unknown>),
        data: { ...(raw.data ?? {}), audit: { hmrProbe: { evidence: [sentinel] } } },
      }
      const patchedText = renderText(tool, { change: 'config' }, patched)
      expect(patchedText).toContain('verdict:') // 渲染确实跑了
      expect(patchedText).not.toContain(sentinel)
    })

    it('L1 逐字来自 `data.verdict`，且 `nextStep.why` 不许等于它（B18b）', async () => {
      const { tool } = await noHmrFixture()
      const result = await run(tool, { change: 'config' })
      const text = renderText(tool, { change: 'config' }, result)
      const parts = splitRender(text)
      const data = (result as { data: { verdict: string } }).data
      expect(parts.verdict).toBe(data.verdict)
      if (parts.l3 !== undefined) expect(parts.l3).not.toBe(parts.verdict)
    })

    it('`nextStep` 出现时**必须带动作**（B18a）：成功与失败两支都查一遍', async () => {
      const cases: Array<{ label: string; value: unknown }> = []
      const hot = await hmrProfileFixture()
      cases.push({ label: 'hot → tool', value: await run(hot.tool, { change: 'config' }) })
      const noHmr = await noHmrFixture()
      cases.push({
        label: 'restart-required → manual',
        value: await run(noHmr.tool, { change: 'config' }),
      })

      for (const item of cases) {
        const step = (item.value as { nextStep?: { tool?: string; manual?: boolean; why: string } })
          .nextStep
        expect(step, `${item.label} 缺 nextStep`).toBeDefined()
        const hasTool = typeof step?.tool === 'string' && step.tool !== ''
        const hasManual = step?.manual === true
        expect(hasTool !== hasManual, `${item.label} 的两支不满足「恰有其一」`).toBe(true)
        expect(String(step?.why)).not.toBe('')
      }
      // manual 支在文本里不印空括号、不印 `—`。
      const manualText = renderText(noHmr.tool, { change: 'config' }, cases[1]?.value)
      expect(manualText).not.toContain('nextStep: — ')
      expect(splitRender(manualText).l3?.startsWith('(')).toBe(false)
    })

    it('失败分支也能渲染出实质判定行（贴的是渲染层真实产物，不是字段）', async () => {
      const dshHome = await tempDshHome()
      await writeProfile(dshHome, 'web', { bundles: [] })
      const { spawn } = recordingSpawn(() => cmdResult({ code: null, spawnError: 'spawn: ENOENT' }))
      const tool = createEffectModeTool(depsFor(configFor(dshHome), { spawn }))
      const result = await run(tool, { change: 'config' })
      const text = renderText(tool, { change: 'config' }, result)
      const parts = splitRender(text)

      expect(parts.head).toBe(`[${EFFECT_MODE_TOOL}] failed (not-configured)`)
      expectSubstantiveVerdict(parts.verdict ?? '')
      expect(parts.l2).toContain('stage: launch-failed')
      expect(parts.l3).toContain('PATH')
      // 逐行形状：头行 / verdict / L2 / nextStep —— **没有** `message:` 行。
      // `error.message` 不是模型的取数口（SHAPE §4.1）；它要说的事实由 L1 承载，
      // 所以这里反过来断言那句事实**确实出现在 verdict 行里**。
      expect(text.split('\n').some((line) => line.startsWith('message:'))).toBe(false)
      expect(parts.verdict).toContain('spawn: ENOENT')
    })

    it('B16 自检：两份 fixture 的 `verdict:` + L2 行里**没有**共同的 ≥40 字符行', async () => {
      // ⚠️ **两份 fixture 必须同时改「输入」与「环境」**：B16 要抓的是「输入与环境都变了、
      // 这一行却还逐字不变」= 真恒定块；而 `resolved:` 这类行按**环境**恒定、不按输入恒定。
      // 所以两份 fixture 各用一份不同的临时 home（`hmrProfileFixture()` 一份、下面再取一份）
      // 且 profile 名也不同 —— 这是 B16 的判据要求，不是随便挑的两份 fixture。
      const hot = await hmrProfileFixture()
      const hotResult = await run(hot.tool, { change: 'config' })

      const dshHome = await tempDshHome()
      await writeProfile(dshHome, 'tui', { bundles: [] })
      const { spawn } = recordingSpawn(() => cmdResult({ stdout: CONFIG_WITHOUT_HMR }))
      const cold = createEffectModeTool(depsFor(configFor(dshHome, { profile: 'tui' }), { spawn }))
      const coldResult = await run(cold, { change: 'host-code' })

      const candidates = (tool: ToolDefinition, args: unknown, value: unknown): string[] => {
        const parts = splitRender(renderText(tool, args, value))
        return [parts.verdict ?? '', ...parts.l2].filter((line) => line.length >= 40)
      }
      const first = candidates(hot.tool, { change: 'config' }, hotResult)
      const second = candidates(cold, { change: 'host-code' }, coldResult)

      // 下界：两份 fixture 都必须真的吐出候选行，否则「交集为空」是空转。
      expect(first.length, '第一份 fixture 一条 ≥40 字符的行都没有 —— 判据空转').toBeGreaterThan(0)
      expect(second.length, '第二份 fixture 一条 ≥40 字符的行都没有 —— 判据空转').toBeGreaterThan(0)
      expect(splitRender(renderText(hot.tool, {}, hotResult)).verdict).not.toBe(
        splitRender(renderText(cold, {}, coldResult)).verdict,
      )
      const shared = first.filter((line) => second.includes(line))
      expect(shared, `两份 fixture 共有的恒定行：${shared.join(' | ')}`).toEqual([])
    })

    it('B17 自检：`nextStep.args` 的每个值都出现在 `verdict:` 行或 L2 行里', async () => {
      const { tool } = await hmrProfileFixture()
      const result = await run(tool, { change: 'config' })
      const step = result.nextStep as { tool?: string; args?: Record<string, unknown> } | undefined
      expect(step?.tool).toBe('dsh_dump_config')
      const parts = splitRender(renderText(tool, { change: 'config' }, result))
      const haystack = [parts.verdict ?? '', ...parts.l2].join('\n')
      const values = Object.values(step?.args ?? {}).filter(
        (value) =>
          value !== null && value !== true && value !== false && value !== 0 && value !== '',
      )
      expect(values.length, 'args 全被例外表排掉了 —— 判据空转').toBeGreaterThan(0)
      for (const value of values) expect(haystack).toContain(String(value))
    })

    it('B20b 自检：描述与该工具的输出之间没有 ≥40 字符的共享串', async () => {
      const { tool } = await hmrProfileFixture()
      const result = await run(tool, { change: 'config' })
      const text = renderText(tool, { change: 'config' }, result)
      const shared = sharedSubstrings(composeDescription(CHECK_EFFECT_MODE_DESCRIPTION), text, 40)
      expect(shared, `描述里逐字抄了输出：${shared.join(' | ')}`).toEqual([])
    })

    it('渲染永远有输出：形状不合法的值退化成一行，不抛', async () => {
      const { tool } = await hmrProfileFixture()
      const text = renderText(tool, {}, { nonsense: true })
      expect(text).toBe(`[${EFFECT_MODE_TOOL}] {"nonsense":true}`)
    })

    it('B24 形状：底层抛异常后返回的仍是**过守卫**的结果（恒等，不是被合成的兜底）', async () => {
      const dshHome = await tempDshHome()
      await writeProfile(dshHome, 'web', { bundles: [] })
      const tool = createEffectModeTool(depsFor(configFor(dshHome)))

      const raw = await run(tool, { change: 'config' })
      // 判据是恒等 ⇒ 这个值过了守卫，而不是「没报错」（坑 37 的形状）。
      expect(ensureToolResult(raw)).toBe(raw)
      expect(raw.ok).toBe(false)
      if (raw.ok) throw new Error('期望失败')
      expect(Object.keys(raw.data).sort()).toEqual(['audit', 'key', 'verdict'])
    })
  })

  /**
   * W2-A2 回归守卫：**解释与判定不许相反**。
   *
   * 原 `buildWhy()` 的收尾句只看 `mode === 'hot'`，于是 `restart-required` 那一档会挂上
   * 「客户端会换入」—— 判错会被断言抓住，**解释反了只有人读得出来**，而它躺着的位置
   * 正是 `audit`（定义是「给人复核的」）。所以这里把「`mode` ⇒ 收尾句」钉成矩阵断言，
   * 而不是只测一条字符串。
   */
  describe('解释与判定必须一致（effect.ts buildWhy 的收尾句，W2-A2）', () => {
    const CHANGES: readonly EffectChangeKind[] = [
      'config',
      'bundle-added',
      'host-code',
      'client-code',
    ]

    /** 全组合：改动 × 是否已在 dependencies（只对 bundle-added 有意义） × hmr 可用性。 */
    const MATRIX: EffectInput[] = []
    for (const change of CHANGES) {
      const depChoices: Array<boolean | undefined> =
        change === 'bundle-added' ? [false, true] : [undefined]
      for (const alreadyInDependencies of depChoices) {
        for (const hmrUsable of [true, false]) {
          MATRIX.push({
            change,
            ...(alreadyInDependencies === undefined ? {} : { alreadyInDependencies }),
            hmrUsable,
          })
        }
      }
    }

    /** 一个组合的可读标签（错了要能一眼看出是哪一格）。 */
    const label = (input: EffectInput): string => {
      const dep =
        input.alreadyInDependencies === undefined
          ? ''
          : `+alreadyInDependencies=${String(input.alreadyInDependencies)}`
      return `${input.change}${dep} hmrUsable=${String(input.hmrUsable)}`
    }

    it('矩阵非空且真的覆盖到 restart-required（否则下面那条是空转 —— SHAPE §10.0）', () => {
      expect(MATRIX.length, '判定矩阵是空的 —— 判据空转').toBe(10)
      const restart = MATRIX.map((input) => decideEffectMode(input)).filter(
        (decision) => decision.mode === 'restart-required',
      )
      expect(restart.length, '没有一格落在 restart-required —— 判据空转').toBeGreaterThan(0)
    })

    it('凡判定为 restart-required，解释里不许出现「hmr 会替你换」的措辞，且必须说到重启', () => {
      const offenders: string[] = []
      for (const input of MATRIX) {
        const decision = decideEffectMode(input)
        if (decision.mode !== 'restart-required') continue
        for (const claim of ['swaps the asset in', 're-read live']) {
          if (decision.why.includes(claim)) offenders.push(`${label(input)} → 含「${claim}」`)
        }
        if (!decision.why.includes('restart')) offenders.push(`${label(input)} → 没说到重启`)
      }
      expect(offenders, `解释与判定相反：${offenders.join(' | ')}`).toEqual([])
    })

    it('hmr 可用 + host-code → restart-required，且 why 说明 hmr 为什么帮不上忙', () => {
      const decision = decideEffectMode({ change: 'host-code', hmrUsable: true })
      expect(decision.mode).toBe('restart-required')
      // **不是降级**：原表本来就要重启 —— 这正是原实现走错分支的原因。
      expect(decision.downgraded).toBe(false)
      expect(decision.why).not.toContain('client swaps the asset in')
      expect(decision.why).toContain('restart is required')
      expect(decision.why).toContain('cannot change the host module graph')
    })

    it('hmr 可用 + bundle-added（已在 dependencies）→ 同样是重启，且不许说客户端换入', () => {
      const decision = decideEffectMode({
        change: 'bundle-added',
        alreadyInDependencies: true,
        hmrUsable: true,
      })
      expect(decision.mode).toBe('restart-required')
      expect(decision.downgraded).toBe(false)
      expect(decision.why).not.toContain('swaps the asset in')
      expect(decision.why).toContain('restart is required')
    })

    it('hmr 可用 + client-code → mode=hmr（**不是** hot），why 走客户端换入那条路径', () => {
      // ⚠️ 判据写清：`client-code` 的原表答案是 **`hmr`**（`baselineMode`），
      // 所以「hmr 可用 ⇒ 不降级」时 `mode` 就是 `hmr`，不是 `hot`。
      const decision = decideEffectMode({ change: 'client-code', hmrUsable: true })
      expect(decision.mode).toBe('hmr')
      expect(decision.downgraded).toBe(false)
      expect(decision.why).toContain('client swaps the asset in')
    })

    it('hmr 可用 + config → hot，why 指向「watch patch 文件的正是 hmr」', () => {
      const decision = decideEffectMode({ change: 'config', hmrUsable: true })
      expect(decision.mode).toBe('hot')
      expect(decision.why).toContain('watches the patch files')
      expect(decision.why).toContain('re-read live')
    })

    it('无 hmr 的两档收尾句各说各的：config 降级说「没人 watch」，client-code 降级说「重建」', () => {
      const configDecision = decideEffectMode({ change: 'config', hmrUsable: false })
      expect(configDecision.mode).toBe('restart-required')
      expect(configDecision.downgraded).toBe(true)
      expect(configDecision.why).toContain('nothing watches the patch files')
      expect(configDecision.why).not.toContain('swaps the asset in')

      const clientDecision = decideEffectMode({ change: 'client-code', hmrUsable: false })
      expect(clientDecision.mode).toBe('client-rebuild')
      expect(clientDecision.downgraded).toBe(true)
      expect(clientDecision.why).toContain('rebuild, then refresh the page')
      expect(clientDecision.why).not.toContain('client swaps the asset in')
    })

    it('工具把修好的 why 原样带进 audit（人复核通道就是它躺着的地方）', async () => {
      const { tool } = await hmrProfileFixture()
      const data = expectOk(await run(tool, { change: 'host-code' }))
      const decision = data.audit['decision'] as Record<string, unknown>
      const why = String(decision['why'])
      expect(data.key['mode']).toBe('restart-required')
      // 修复前这里躺着的正是那句反话（「client swaps the asset in」）。
      expect(why).not.toContain('swaps the asset in')
      expect(why).toContain('restart is required')
      expect(why).toContain('cannot change the host module graph')
    })
  })
})
