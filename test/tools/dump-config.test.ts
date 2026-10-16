/**
 * `dsh_dump_config` 的行为红线 + **新契约的形状断言**（W2-C）。
 *
 * 三块：
 *
 * 1. **行为**：这个工具最容易写错的一条是「拿退出码当门禁」。所以这里钉死
 *    「`--dump-config` 退出码 0 但 stderr 里有组合期错」**必须报失败**，以及
 *    「已知误报不看文本、看 `path` 解析出的 entryId」。
 * 2. **形状**（SHAPE §2.1 / §3.1 / §4.1）：四段描述、三层文本、`data` 恰好三键、
 *    失败分支有实质 `verdict`、`nextStep` 必须带动作、恒定块不许进输出、
 *    `audit` 不许进模型文本、`execute` 绝不 throw。
 * 3. **本文件自带的断言助手**：`test/tools/helpers.ts` 是共享的冻结文件，所以
 *    render 取数口与 B16/B20b 的比对手法都写在**本文件里**。
 */
import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import {
  createDumpConfigTool,
  DUMP_CONFIG_DESCRIPTION,
  DUMP_CONFIG_TOOL,
} from '../../src/tools/dsh_dump_config.ts'
import {
  composeDescription,
  DESCRIPTION_MAX_CHARS,
  DESCRIPTION_MAX_LINES,
} from '../../src/tools/describe.ts'
import { ensureToolResult, TOOL_ERROR_KINDS, toolResultProblem } from '../../src/lib/errors.ts'
import {
  carrierOf,
  cmdResult,
  configFor,
  depsFor,
  execWith,
  expectFail,
  expectOk,
  recordingSpawn,
  renderText,
  run,
  sharedSubstrings,
  splitRender,
  tempDshHome,
} from './helpers.ts'
import type { CommandResult, RunCommandOptions } from '../../src/lib/exec.ts'
import { toolBudgetMs, TRANSPORT_MARGIN_MS } from '../../src/lib/timeouts.ts'

/** 组合树：第 181 个条目是 agent-preset-registry，182 是 preset-standard。 */
function composedConfig(): string {
  const lines: string[] = ['# == @deepseek-ai/dsh-base']
  for (let index = 1; index <= 181; index += 1) {
    if (index === 181) {
      lines.push('- id: agent-preset-registry', "  name: '@deepseek-ai/dsh-agent-preset-registry'")
    } else {
      lines.push(`- id: entry-${String(index)}`, `  name: '@deepseek-ai/entry-${String(index)}'`)
    }
  }
  lines.push('- id: preset-standard', "  name: '@deepseek-ai/dsh-agent-preset'")
  lines.push('- id: preset-ptc', "  name: '@deepseek-ai/dsh-agent-preset'")
  return lines.join('\n')
}

/** schema dump 的 stdout（只保留 diagnostics 那一小段形状）。 */
function schemaOut(diagnostics: unknown[]): string {
  return JSON.stringify({ $defs: {}, diagnostics })
}

/** 官方那条已知误报的文案。 */
const CARRIER_MESSAGE =
  'unrecognized Loader tree carrier; use cordis:group or cordis:include for native child collection'

/**
 * 一次 dump 的结果旋钮。
 *
 * `timedOut` 是**必须**有的那一格：没有它就构造不出「config 成功 + schema 超时」——
 * 而那正是真机上出事的那条路径（`--dump-config` 退出码 0、stderr 带组合期错，
 * 紧接着 `--dump-config-schema` 传输层超时）。夹具缺这一格时，缺陷整条不可测。
 */
interface DumpStub {
  exitCode?: number
  stdout?: string
  stderr?: string
  /** 传输层超时：进程被杀 ⇒ 退出码是 `null`（不是某个数）。 */
  timedOut?: boolean
}

/** 把旋钮转成一次命令结果（`timedOut` 时退出码必须按契约置 `null`）。 */
function dumpResult(stub: DumpStub, fallback: { exitCode: number; stdout: string }): CommandResult {
  const stdout = stub.stdout ?? fallback.stdout
  const stderr = stub.stderr ?? ''
  return stub.timedOut === true
    ? cmdResult({ code: null, stdout, stderr, timedOut: true })
    : cmdResult({ code: stub.exitCode ?? fallback.exitCode, stdout, stderr })
}

/** 一个按 flag 分派的 spawn：两次调用各有一套旋钮。 */
function dumpSpawn(schema: DumpStub, configDump: DumpStub = {}) {
  return recordingSpawn((options: RunCommandOptions): CommandResult => {
    const flag = options.args[options.args.length - 1]
    return flag === '--dump-config-schema'
      ? dumpResult(schema, { exitCode: 0, stdout: '' })
      : dumpResult(configDump, { exitCode: 0, stdout: composedConfig() })
  })
}

/** 形状自检：`data` 恰好三键、结果过守卫（B21 的判据）。 */
function expectShape(result: unknown): void {
  const record = result as { data: Record<string, unknown> }
  expect(Object.keys(record.data).sort()).toEqual(['audit', 'key', 'verdict'])
  expect(toolResultProblem(result)).toBeUndefined()
}

/** 失败分支的 `verdict` 必须是**实质句子**（不许只写 `failed`）。 */
function expectSubstantiveVerdict(verdict: string): void {
  expect(verdict.trim()).not.toBe('')
  expect(verdict.trim().split(/\s+/u).length).toBeGreaterThanOrEqual(6)
}

describe('dsh_dump_config', () => {
  it('工具名与契约一致', () => {
    expect(DUMP_CONFIG_TOOL).toBe('dsh_dump_config')
  })

  describe('形状：描述层（SHAPE §2.1 冻结）', () => {
    it('四段骨架：合成器与声明一致、行数 ≤4、字符 ≤240', () => {
      const tool = createDumpConfigTool(depsFor(configFor('/tmp/nowhere')))
      const description = DUMP_CONFIG_DESCRIPTION

      // 合成器与声明必须一致 —— 防止有人手写字符串绕过骨架。
      expect(tool.description).toBe(composeDescription(description))
      expect(description.what.trim()).not.toBe('')
      expect(description.useWhen.trim()).not.toBe('')
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
      // 不许有纯空白行（空段必须先滤掉再 join，SHAPE §2.1）。
      expect(lines.every((line) => line.trim() !== '')).toBe(true)

      // ⚠️ `defineTool` 把参数编译成了 JSON schema（`{ type, properties }`，活跃坑 11），
      // 所以要点进 `properties` 才看得到每个参数的描述。直接 `Object.values(tool.parameters)`
      // 会拿到 `'object'` 与 properties 对象本身 → 每条 `description` 都是 `undefined`
      // → 合计恒为 0 → **判据空转**（SHAPE §10.0「只有上界、没有下界」那一类假绿）。
      const parameters = tool.parameters as {
        properties?: Record<string, { description?: string }>
      }
      const props = parameters.properties ?? {}
      const names = Object.keys(props)
      // 精确闭集（不是个数）：加/删参数都要同批改这里。`dshHome` 是跨实例观察那个接缝
      // （`docs/SHAPE.md` §1.2 的 D′），它的存在本身就是契约的一部分。
      expect(names, '一个参数都没读到 —— 判据空转').toEqual(['profile', 'dshHome'])
      for (const name of names) {
        expect(props[name]?.description ?? '', `参数 ${name} 的描述是空的`).not.toBe('')
      }
      const total = Object.values(props).reduce(
        (sum, item) => sum + (item.description?.length ?? 0),
        0,
      )
      // 下界：`total > 0` —— 上界已删（SHAPE §2），这两条下界是唯一的机械守卫。
      expect(total).toBeGreaterThan(0)
    })

    it('恒定知识只在描述层边界段写一次：退出码语义 + 已知误报的判据', () => {
      const boundary = DUMP_CONFIG_DESCRIPTION.boundary ?? ''
      expect(boundary).toContain('--dump-config always exits 0')
      expect(boundary).toContain('--dump-config-schema exits 1')
      expect(boundary).toContain('known false positive')
      expect(boundary).toContain('judge by path')
      // 旧的「每次输出都印一遍」的字段名不许再出现在描述里。
      expect(composeDescription(DUMP_CONFIG_DESCRIPTION)).not.toContain('exitCodeSemantics')
    })
  })

  describe('跨实例（D′ 第②块）：dshHome 参数', () => {
    it('给了 dshHome ⇒ 它进 resolved 且来源是 `tool-argument`（不许印成 config/default）', async () => {
      const home = await tempDshHome()
      const other = 'C:\\other-dsh-home'
      const recorded = recordingSpawn(() => cmdResult({ stdout: composedConfig() }))
      const tool = createDumpConfigTool(depsFor(configFor(home), { spawn: recorded.spawn }))
      const data = expectOk(await run(tool, { dshHome: other }))
      const resolved = data.key['resolved'] as Record<string, unknown>
      expect(resolved['dshHome']).toBe(other)
      // 三值纪律：参数来的值**不许**印成配置 / 默认值 —— 否则「它在读另一个实例」这件事消失。
      expect(resolved['dshHomeSource']).toBe('tool-argument')
    })

    it('**子进程环境**真的注入了 DSH_HOME（只断言「参数进了返回值」是假绿）', async () => {
      // 这是本卡最容易漏的那一层：`runDump` 走 `deps.spawn`，而 `lib/exec.ts` 的 `env`
      // 默认 `process.env`。只加参数不注环境 ⇒ 子进程读回**本进程**的 home，
      // 而 `resolved.dshHome` 印的却是参数值 —— 那正是「看着成功、读的是另一个目录」。
      const home = await tempDshHome()
      const other = 'C:\\other-dsh-home'
      const recorded = recordingSpawn(() => cmdResult({ stdout: composedConfig() }))
      const tool = createDumpConfigTool(
        depsFor(configFor(home), { spawn: recorded.spawn, env: { PATH: '/x' } }),
      )
      expectOk(await run(tool, { dshHome: other }))
      // 走**完整入口**（真跑一遍工具），断言的是**底层 spawn 收到的参数** ——
      // 不是某个中间变量、也不是返回值里的影子字段。
      expect(recorded.calls.length).toBeGreaterThan(0)
      for (const call of recorded.calls) {
        expect(
          call.env?.['DSH_HOME'],
          `子进程没拿到参数里的 home：${JSON.stringify(call.env)}`,
        ).toBe(other)
      }
    })

    it('没给 dshHome ⇒ 子进程照样拿到**本次认的** home（配置那个），来源仍是 config', async () => {
      // 「永远注入」那一半：工具报的 home 与子进程读的 home 不许是两回事。
      const home = await tempDshHome()
      const recorded = recordingSpawn(() => cmdResult({ stdout: composedConfig() }))
      const tool = createDumpConfigTool(
        depsFor(configFor(home), { spawn: recorded.spawn, env: {} }),
      )
      const data = expectOk(await run(tool, {}))
      const resolved = data.key['resolved'] as Record<string, unknown>
      expect(resolved['dshHomeSource']).toBe('config')
      for (const call of recorded.calls) expect(call.env?.['DSH_HOME']).toBe(home)
      // 反面：环境是**新对象**，不是被就地改过的 `process.env`（那会跨调用泄漏、且是写侧动作）。
      expect(recorded.calls[0]?.env).not.toBe(process.env)
    })

    it('空串 / 全空白与没给等价（不覆盖）：不许拿一个空 home 去读文件', async () => {
      const home = await tempDshHome()
      const recorded = recordingSpawn(() => cmdResult({ stdout: composedConfig() }))
      const tool = createDumpConfigTool(depsFor(configFor(home), { spawn: recorded.spawn }))
      const data = expectOk(await run(tool, { dshHome: '   ' }))
      const resolved = data.key['resolved'] as Record<string, unknown>
      expect(resolved['dshHome']).toBe(home)
      expect(resolved['dshHomeSource']).toBe('config')
    })

    it('失败时重试参数带上 dshHome（否则重试会问到另一个实例，而输出长得一样）', async () => {
      const home = await tempDshHome()
      const other = 'C:\\other-dsh-home'
      const recorded = recordingSpawn(() =>
        cmdResult({ code: null, timedOut: true, stderr: 'boom' }),
      )
      const tool = createDumpConfigTool(depsFor(configFor(home), { spawn: recorded.spawn }))
      const result = await run(tool, { dshHome: other })
      const failed = expectFail(result)
      const next = failed.nextStep
      expect(next !== undefined && 'tool' in next ? next.tool : undefined).toBe(DUMP_CONFIG_TOOL)
      if (next !== undefined && 'args' in next) {
        expect(next.args).toMatchObject({ dshHome: other })
      }
      // B17：这个值必须在模型看得见的地方出现（L2 的 `resolved:` 行就是它出现的地方）。
      expect(splitRender(renderText(tool, {}, result)).l2.join('\n')).toContain(other)
    })
  })

  describe('保留 profile（desktop）：在 spawn 之前拒，且不许换一个 profile 去答', () => {
    /** 一次「本该成功」的 spawn —— 早拒的那条路一次都不该走到它。 */
    function wouldSucceed() {
      return recordingSpawn(() => cmdResult({ stdout: composedConfig() }))
    }

    it('profile 参数是保留名 ⇒ 结构化失败，且**一次子进程都没起**（下界）', async () => {
      const dshHome = await tempDshHome()
      const { spawn, calls } = wouldSucceed()
      const tool = createDumpConfigTool(
        depsFor(configFor(dshHome), { spawn, carrier: carrierOf('desktop-host') }),
      )

      const result = await run(tool, { profile: 'desktop' })
      const failure = expectFail(result)
      expectShape(result)
      // **下界**：判据不是「它失败了」，而是「它一次 dump 都没跑」—— 少了这条，
      // 「先起进程、再让那次必然失败的 dump 报错」也会让上面那句绿（本仓典型的假绿）。
      expect(calls, '保留 profile 还去起了子进程 —— 那条路必然失败').toHaveLength(0)
      expect(failure.kind).toBe('not-configured')
      // L1 必须说清「任何平台上都 dump 不了」与「所以这棵树从这儿读不出来」。
      expect(String(failure.data.verdict)).toContain('every platform')
      expect(String(failure.data.verdict)).toContain('cannot be read from here')
      // 人要做什么：去桌面应用自己的诊断里看，或**显式**指定一个非保留 profile。
      expect(failure.nextStep).toEqual({
        manual: true,
        why: expect.stringContaining('non-reserved profile'),
      })
      // 生效 profile **不许被换掉** —— 换掉就是答了另一个问题。
      const resolved = failure.data.key['resolved'] as Record<string, unknown>
      expect(resolved['profile']).toBe('desktop')
      // audit 带 `profile` 与载体观测（复核者要问的第二件事正是「宿主跑在什么载体上」）。
      expect(failure.data.audit['profile']).toBe('desktop')
      const carrierAudit = failure.data.audit['carrier'] as Record<string, unknown>
      expect(carrierAudit['kind']).toBe('desktop-host')
      // 一次都没跑 ⇒ 「没读到」是事实：渲染层必须印 unknown，不许印 none。
      const parts = splitRender(renderText(tool, { profile: 'desktop' }, result))
      expect(parts.l2).not.toContain('actionable: none')
      expect(parts.l2.some((line) => line.startsWith('actionable: unknown'))).toBe(true)
    })

    it('配置里的 profile 是保留名时同样早拒（不只看工具参数）', async () => {
      const dshHome = await tempDshHome()
      const { spawn, calls } = wouldSucceed()
      const tool = createDumpConfigTool(
        depsFor(configFor(dshHome, { profile: 'desktop' }), { spawn, carrier: carrierOf('cli') }),
      )

      const failure = expectFail(await run(tool, {}))
      expect(calls).toHaveLength(0)
      expect((failure.data.key['resolved'] as Record<string, unknown>)['profile']).toBe('desktop')
    })

    it('大小写与空白归一（CLI 那一侧的判据不是逐字相等）', async () => {
      const dshHome = await tempDshHome()
      const { spawn, calls } = wouldSucceed()
      const tool = createDumpConfigTool(depsFor(configFor(dshHome), { spawn }))

      expectFail(await run(tool, { profile: ' Desktop ' }))
      expect(calls).toHaveLength(0)
    })

    it('显式传别的 profile ⇒ 照旧工作（桌面载体也一样：早拒只看 profile 名）', async () => {
      const dshHome = await tempDshHome()
      const { spawn, calls } = dumpSpawn({ exitCode: 0, stdout: schemaOut([]) })
      const tool = createDumpConfigTool(
        depsFor(configFor(dshHome), { spawn, carrier: carrierOf('desktop-host') }),
      )

      const data = expectOk(await run(tool, { profile: 'web' }))
      // 反面判据：早拒**没有**扩大成「桌面端一律不答」—— 两次 dump 都真的跑了。
      expect(calls).toHaveLength(2)
      expect((data.key['resolved'] as Record<string, unknown>)['profile']).toBe('web')
    })
  })

  describe('成功路径', () => {
    it('退出码 0 且无诊断 → 成功，结论排除组合层（不再印退出码语义那两句）', async () => {
      const dshHome = await tempDshHome()
      const { spawn } = dumpSpawn({ exitCode: 0, stdout: schemaOut([]) })
      const tool = createDumpConfigTool(depsFor(configFor(dshHome), { spawn }))

      const result = await run(tool, {})
      const data = expectOk(result)
      expectShape(result)
      // 退出码是观测（进 L2），但它不是判定本身。
      const invocations = data.key['invocations'] as Record<string, unknown>[]
      expect(invocations.map((item) => item['flag'])).toEqual([
        '--dump-config',
        '--dump-config-schema',
      ])
      expect(invocations[0]?.['exitCode']).toBe(0)
      expect(invocations[1]?.['exitCode']).toBe(0)
      expect(data.key['actionable']).toEqual([])
      // 覆盖完整 ⇒ 这个空数组才**是** `none`（不是「没读到」）。
      expect(data.key['notScreened']).toEqual([])
      // 全量记录在 audit（模型不读）。
      expect((data.audit['diagnostics'] as unknown[]).length).toBe(0)
      expect(data.audit['entryCount']).toBe(183)
      expect(String(data.verdict)).toContain('can be ruled out')
      // 没有动作可做 → nextStep 不出现（§3.1：没有动作就不出现）。
      expect(result.nextStep).toBeUndefined()
      // 恒定知识已搬走：旧的 exitCodeSemantics 块不许再出现在任何一层。
      expect(data.key['exitCodeSemantics']).toBeUndefined()
      expect(data.audit['exitCodeSemantics']).toBeUndefined()
      expect(JSON.stringify(data.key) + JSON.stringify(data.audit)).not.toContain(
        'cannot be used as a gate',
      )
    })

    it('preset 行的 error：退出码 1 但归为已知误报 → 成功，且 entryId 由 path 解析出来', async () => {
      const dshHome = await tempDshHome()
      const { spawn } = dumpSpawn({
        exitCode: 1,
        stdout: schemaOut([{ level: 'error', path: '/182', message: CARRIER_MESSAGE }]),
      })
      const tool = createDumpConfigTool(depsFor(configFor(dshHome), { spawn }))

      const data = expectOk(await run(tool, {}))
      expect(data.key['actionable']).toEqual([])
      // 误报的细节是复核材料 → audit（模型只需要「它不指向你改的那行」这句结论）。
      const fps = data.audit['knownFalsePositives'] as Record<string, unknown>[]
      expect(fps).toHaveLength(1)
      // path 被解析成了 entry id —— 这是「误报 vs 真问题」唯一的判据。
      expect(fps[0]?.['entryId']).toBe('preset-standard')
      expect((data.audit['counts'] as Record<string, number>)['known-false-positive']).toBe(1)
      expect(String(data.verdict)).toContain('known false positive')
      // 结论必须点明「没有一条指向你改的那行」，而不是复述退出码。
      expect(String(data.verdict)).toContain('nothing points at a row you changed')
    })

    it('agent-preset-registry 行上的同一条 error 也算已知误报（实测那一档）', async () => {
      const dshHome = await tempDshHome()
      const { spawn } = dumpSpawn({
        exitCode: 1,
        stdout: schemaOut([{ level: 'error', path: '/181', message: CARRIER_MESSAGE }]),
      })
      const tool = createDumpConfigTool(depsFor(configFor(dshHome), { spawn }))

      const data = expectOk(await run(tool, {}))
      const fps = data.audit['knownFalsePositives'] as Record<string, unknown>[]
      expect(fps[0]?.['entryId']).toBe('agent-preset-registry')
      expect(data.key['actionable']).toEqual([])
    })

    it('退出码 1 却一条诊断都读不出来 → **不许**说成 clean（形状漂了是静默坏）', async () => {
      const dshHome = await tempDshHome()
      // schema 退出码 1，但 stdout 不是 JSON、stderr 也没有可认的行。
      const { spawn } = dumpSpawn({ exitCode: 1, stdout: 'not json at all' })
      const tool = createDumpConfigTool(depsFor(configFor(dshHome), { spawn }))

      const data = expectOk(await run(tool, {}))
      expect(String(data.verdict)).toContain('unexplained')
      expect(String(data.verdict)).not.toContain('can be ruled out')
    })

    it('工具参数传的 profile 会如实进入 resolved（而不是谎报配置里那个）', async () => {
      const dshHome = await tempDshHome()
      const { spawn } = dumpSpawn({ exitCode: 0, stdout: schemaOut([]) })
      const tool = createDumpConfigTool(depsFor(configFor(dshHome, { profile: 'web' }), { spawn }))

      const data = expectOk(await run(tool, { profile: 'tui' }))
      const resolved = data.key['resolved'] as Record<string, unknown>
      expect(resolved['profile']).toBe('tui')
      expect(resolved['dshHome']).toBe(dshHome)
      expect(resolved['dshHomeSource']).toBe('config')
      // 而且它必须出现在 L2 里（B17：下一步的 profile 参数得是模型见过的东西）。
      const parts = splitRender(renderText(tool, {}, await run(tool, { profile: 'tui' })))
      expect(parts.l2.some((line) => line.includes('profile=tui'))).toBe(true)
    })

    it('hmr 行会被认出来（present 进 key，恒定解释不进 L2）', async () => {
      const dshHome = await tempDshHome()
      const stdout = ['- id: hmr', "  name: '@deepseek-ai/dsh-hmr'", '- id: llm'].join('\n')
      const { spawn } = dumpSpawn({ exitCode: 0, stdout: schemaOut([]) }, { stdout })
      const tool = createDumpConfigTool(depsFor(configFor(dshHome), { spawn }))

      const data = expectOk(await run(tool, {}))
      expect((data.key['hmr'] as Record<string, unknown>)['present']).toBe(true)
      // 旧输出里那句恒定的 note 不许再进模型文本（恒定块搬去描述层）。
      expect(JSON.stringify(data.key)).not.toContain('reload() is a no-op')
    })
  })

  describe('假绿防线：门是 actionable，不是退出码', () => {
    it('`--dump-config` 退出码 0、stderr 有组合期错 → 必须失败（不能信退出码）', async () => {
      const dshHome = await tempDshHome()
      const { spawn } = dumpSpawn(
        { exitCode: 0, stdout: schemaOut([]) },
        {
          exitCode: 0,
          stderr:
            'dsh: [C:\\x\\cordis.patch.yml] patch: name mismatch for "llm" (expected "a", got "b"), skipping\n',
        },
      )
      const tool = createDumpConfigTool(depsFor(configFor(dshHome), { spawn }))

      const result = await run(tool, {})
      // 退出码是 0；唯一能照出这件事的是 stderr 的文本行。
      const failure = expectFail(result)
      expectShape(result)
      expect(failure.kind).toBe('command-failed')
      expect(failure.message).toContain('composition error')
      expect(failure.message).toContain('skipping')
      // 观测到的事实必须在 `data`（旧契约的 evidence 槽），且 actionable 进 `key`。
      const actionable = failure.data.key['actionable'] as Record<string, unknown>[]
      expect(actionable.length).toBeGreaterThan(0)
      expect(actionable[0]?.['classification']).toBe('composition-error')
      // stderr 是这条分支唯一的证据 —— 必须带在 key 里（模型看不见 audit）。
      const invocations = failure.data.key['invocations'] as Record<string, unknown>[]
      expect(String(invocations[0]?.['stderr'])).toContain('name mismatch')
      // 全量 counts / diagnostics 仍在 audit。
      expect((failure.data.audit['diagnostics'] as unknown[]).length).toBeGreaterThan(0)
    })

    it('error 指向非 preset 行 → 真问题，报 command-failed 且点出 path / entryId', async () => {
      const dshHome = await tempDshHome()
      const { spawn } = dumpSpawn({
        exitCode: 1,
        stdout: schemaOut([
          {
            level: 'error',
            path: '/2',
            message: 'unrecognized Loader tree carrier; use cordis:group',
          },
        ]),
      })
      const tool = createDumpConfigTool(depsFor(configFor(dshHome), { spawn }))

      const result = await run(tool, {})
      const failure = expectFail(result)
      expectShape(result)
      expect(failure.kind).toBe('command-failed')
      expect(TOOL_ERROR_KINDS).toContain(failure.kind)
      const actionable = failure.data.key['actionable'] as Record<string, unknown>[]
      expect(actionable[0]?.['entryId']).toBe('entry-2')
      expect(String(failure.data.verdict)).toContain('point at rows in this profile')
      // 这条 actionabel 与已知误报不是一回事 —— 结论必须说清。
      expect(String(failure.data.verdict)).toContain('not the preset-* false positive')
      // 模型要拿 path / entryId 去定位那一行 → 必须印在 L2。
      const parts = splitRender(renderText(tool, {}, result))
      expect(
        parts.l2.some((line) => line.startsWith('actionable:') && line.includes('entryId=entry-2')),
      ).toBe(true)
    })

    it('失败分支的 verdict 是实质句子，不是 `failed`', async () => {
      const dshHome = await tempDshHome()
      const { spawn } = dumpSpawn({
        exitCode: 1,
        stdout: schemaOut([{ level: 'error', path: '/3', message: 'something is wrong' }]),
      })
      const tool = createDumpConfigTool(depsFor(configFor(dshHome), { spawn }))
      const failure = expectFail(await run(tool, {}))
      expectSubstantiveVerdict(failure.data.verdict)
      // 渲染出来的 `verdict:` 行必须与 data.verdict 逐字一致（L1 唯一来源）。
      const rendered = renderText(tool, {}, await run(tool, {}))
      const parts = splitRender(rendered)
      expect(parts.verdict).toBe(failure.data.verdict)
      expect(parts.head).toBe(`[${DUMP_CONFIG_TOOL}] failed (command-failed)`)
    })
  })

  describe('覆盖完整性：`actionable: none` 只有一种合法情形', () => {
    /** 真机那条组合期错（活跃坑 14 的第二种形状：不带严重级、只带来源）。 */
    const COMPOSITION_STDERR =
      'dsh: [C:\\x\\cordis.patch.yml] patch: name mismatch for "llm-deepseek" (expected "a", got "b"), skipping\n'

    it('config 成功（stderr 带组合期错）+ schema 超时 → 已读到的错进 actionable，且明示 schema 未读', async () => {
      const dshHome = await tempDshHome()
      // 真机形状：第一次 dump 退出码 0 且 stderr 上有组合期错；第二次传输层超时。
      const { spawn } = dumpSpawn(
        { exitCode: 0, stdout: '', timedOut: true },
        { stderr: COMPOSITION_STDERR },
      )
      const tool = createDumpConfigTool(depsFor(configFor(dshHome), { spawn }))

      const result = await run(tool, {})
      const failure = expectFail(result)
      expectShape(result)
      expect(failure.kind).toBe('timeout')

      // ① 已跑成的那次 dump 里的诊断**不许因为第二次失败而消失**（根因造成的那个事实）。
      const actionable = failure.data.key['actionable'] as Record<string, unknown>[]
      expect(actionable).toHaveLength(1)
      expect(actionable[0]?.['classification']).toBe('composition-error')
      expect(String(actionable[0]?.['message'])).toContain('name mismatch')
      // ② 覆盖不全是一等值：只差 schema 那一份。
      expect(failure.data.key['notScreened']).toEqual(['--dump-config-schema'])
      // ③ 两者都要出现在 L1（`error.message` 不进模型文本）。
      expect(String(failure.data.verdict)).toContain('1 actionable diagnostic(s)')
      expect(String(failure.data.verdict)).toContain('--dump-config-schema')

      // ④ 渲染：真错逐条列出，**并另起一行**说明未读来源。
      const parts = splitRender(renderText(tool, {}, result))
      expect(
        parts.l2.some(
          (line) =>
            line.startsWith('actionable: [composition-error]') && line.includes('name mismatch'),
        ),
      ).toBe(true)
      expect(parts.l2).toContain('screening: incomplete (not read: --dump-config-schema)')
      expect(parts.l2).not.toContain('actionable: none')
    })

    it('config 成功（stderr 干净）+ schema 超时 → **不得**渲染 `actionable: none`', async () => {
      const dshHome = await tempDshHome()
      const { spawn } = dumpSpawn({ exitCode: 0, stdout: '', timedOut: true })
      const tool = createDumpConfigTool(depsFor(configFor(dshHome), { spawn }))

      const result = await run(tool, {})
      const failure = expectFail(result)
      expectShape(result)
      // 空数组是**没读到**，不是「筛过了、是空的」。
      expect(failure.data.key['actionable']).toEqual([])
      expect(failure.data.key['notScreened']).toEqual(['--dump-config-schema'])
      expect(String(failure.data.verdict)).toContain('the screening is incomplete')
      expect(String(failure.data.verdict)).toContain('this is not a "none"')

      const parts = splitRender(renderText(tool, {}, result))
      expect(parts.l2).not.toContain('actionable: none')
      expect(parts.l2).toContain(
        'actionable: unknown (--dump-config-schema was not read, so this is not a "none")',
      )
    })

    it('config 自身超时 → 两个来源都没读到，第二次 dump 也不跑（读不出组合树就判不了）', async () => {
      const dshHome = await tempDshHome()
      const { spawn, calls } = dumpSpawn({ exitCode: 0, stdout: schemaOut([]) }, { timedOut: true })
      const tool = createDumpConfigTool(depsFor(configFor(dshHome), { spawn }))

      const result = await run(tool, {})
      const failure = expectFail(result)
      expectShape(result)
      expect(failure.kind).toBe('timeout')
      expect(failure.data.key['notScreened']).toEqual(['--dump-config', '--dump-config-schema'])
      // 实测：只起过一次子进程 —— 「跑过哪几次」是观测，不许假装跑了两次。
      expect(calls).toHaveLength(1)

      const parts = splitRender(renderText(tool, {}, result))
      expect(parts.l2).not.toContain('actionable: none')
      expect(parts.l2).toContain(
        'actionable: unknown (--dump-config and --dump-config-schema were not read, so this is not a "none")',
      )
    })

    it('Screening 的「筛过了、是空的」那一侧：`--dump-config` 干净、schema 退出码 0 → 才印 none', async () => {
      const dshHome = await tempDshHome()
      const { spawn } = dumpSpawn({ exitCode: 0, stdout: schemaOut([]) })
      const tool = createDumpConfigTool(depsFor(configFor(dshHome), { spawn }))

      const result = await run(tool, {})
      const data = expectOk(result)
      // 正例也被钉住：否则「一律印 unknown」这种过度修正也会全绿。
      expect(data.key['notScreened']).toEqual([])
      expect(splitRender(renderText(tool, {}, result)).l2).toContain('actionable: none')
    })
  })

  describe('错误路径（每条可达 kind）', () => {
    it('internal：dshHome 空串是**契约被违反**的防御性断言（不再是 not-configured）', async () => {
      const tool = createDumpConfigTool(depsFor(configFor('')))
      const result = await run(tool, {})
      const failure = expectFail(result)
      expectShape(result)
      expect(failure.kind).toBe('internal')
      expect(failure.message).toContain('ResolvedConfig')
      expectSubstantiveVerdict(failure.data.verdict)
      expect(failure.nextStep).toBeUndefined()
    })

    it('not-configured：起不了 dsh（ENOENT），下一步是 manual（没有工具可派）', async () => {
      const dshHome = await tempDshHome()
      const { spawn } = recordingSpawn(() => cmdResult({ code: null, spawnError: 'spawn: ENOENT' }))
      const tool = createDumpConfigTool(depsFor(configFor(dshHome), { spawn }))

      const result = await run(tool, {})
      const failure = expectFail(result)
      expectShape(result)
      expect(failure.kind).toBe('not-configured')
      expectSubstantiveVerdict(failure.data.verdict)
      expect(failure.nextStep).toEqual({ manual: true, why: expect.stringContaining('PATH') })
    })

    it('internal：起不了 dsh 但不是 ENOENT → 没有可派动作，nextStep 不出现', async () => {
      const dshHome = await tempDshHome()
      const { spawn } = recordingSpawn(() => cmdResult({ code: null, spawnError: 'spawn: EACCES' }))
      const tool = createDumpConfigTool(depsFor(configFor(dshHome), { spawn }))

      const result = await run(tool, {})
      const failure = expectFail(result)
      expectShape(result)
      expect(failure.kind).toBe('internal')
      expectSubstantiveVerdict(failure.data.verdict)
      expect(failure.nextStep).toBeUndefined()
    })

    it('timeout：dump-config 传输层超时，nextStep 带工具与 profile 参数', async () => {
      const dshHome = await tempDshHome()
      const { spawn } = recordingSpawn(() => cmdResult({ code: null, timedOut: true }))
      const tool = createDumpConfigTool(depsFor(configFor(dshHome), { spawn }))

      const result = await run(tool, {})
      const failure = expectFail(result)
      expectShape(result)
      expect(failure.kind).toBe('timeout')
      expectSubstantiveVerdict(failure.data.verdict)
      // ⚠️ 这一条**不改**成 `none`：这次一次 dump 都没读成 ⇒ 空数组是「没读到」，
      // 不是「筛过了、是空的」。旧断言 `toEqual([])` 只钉住了数组本身，
      // 真正要钉住的是「它不许被渲染成 none」（下一条用例管渲染）。
      expect(failure.data.key['actionable']).toEqual([])
      expect(failure.data.key['notScreened']).toEqual(['--dump-config', '--dump-config-schema'])
      // 第二次 dump 根本没跑：读不出组合树 ⇒ schema 的 `path` 解析不了 ⇒ 判不了（不是少一份材料）。
      expect(failure.data.key['invocations']).toHaveLength(1)
      expect(failure.nextStep).toEqual({
        tool: DUMP_CONFIG_TOOL,
        args: { profile: 'web' },
        why: expect.stringContaining('retry'),
      })
      // ⚠️ `schemaDumpTimeoutMs` 是**插件配置字段**，不是本工具的参数（`defineTool` 的
      // `timeoutMs` 注册期定死，工具 schema 送到模型前只保留 name/description/parameters）
      // ⇒ 「让模型去调大它」是它永远做不到的指引。判据断的是根因：动作必须指给**人**。
      const why = (failure.nextStep as { why?: string } | undefined)?.why ?? ''
      expect(why).toContain('human')
      expect(why, '超时分支又让模型去调大预算了（模型做不到这件事）').not.toMatch(
        /raise schemaDumpTimeoutMs/u,
      )
      // B17：args 里的 profile 必须出现在 L1/L2 里。
      const parts = splitRender(renderText(tool, {}, result))
      const haystack = [parts.verdict ?? '', ...parts.l2].join('\n')
      expect(haystack).toContain('profile=web')
    })

    it('cancelled：调用方取消 → manual 支（取消是调用方的决定，重试无意义）', async () => {
      const dshHome = await tempDshHome()
      const { spawn } = recordingSpawn(() => cmdResult({ code: null, aborted: true }))
      const tool = createDumpConfigTool(depsFor(configFor(dshHome), { spawn }))

      const result = await run(tool, {})
      const failure = expectFail(result)
      expectShape(result)
      expect(failure.kind).toBe('cancelled')
      expectSubstantiveVerdict(failure.data.verdict)
      expect(failure.nextStep).toEqual({ manual: true, why: expect.stringContaining('caller') })
      // manual 支在文本里不印 `— `、不印空括号。
      const text = renderText(tool, {}, result)
      expect(text).not.toContain('nextStep: — ')
      expect(splitRender(text).l3?.startsWith('(')).toBe(false)
    })

    it('command-failed：--dump-config 意外非零退出（契约是恒 0）', async () => {
      const dshHome = await tempDshHome()
      const { spawn } = recordingSpawn((options) =>
        options.args[options.args.length - 1] === '--dump-config'
          ? cmdResult({ code: 3, stderr: 'boom\n' })
          : cmdResult({ stdout: schemaOut([]) }),
      )
      const tool = createDumpConfigTool(depsFor(configFor(dshHome), { spawn }))

      const result = await run(tool, {})
      const failure = expectFail(result)
      expectShape(result)
      expect(failure.kind).toBe('command-failed')
      // 断言的是**这条**消息里的措辞（不是描述层那句 "always exits 0"）。
      expect(failure.message).toContain('the contract is always 0')
      expect(String(failure.data.verdict)).toContain('contradicts its always-0 contract')
      // 只跑了第一次 dump —— 「跑过哪几次」是本次观测，不许假装跑了两次。
      expect(failure.data.key['invocations']).toHaveLength(1)
      // 而「这一次没读到」同样要说出来：这条路上什么都没筛，`actionable` 为空
      // **不是** `none`（覆盖不全 ⇒ 渲染成 `unknown`）。
      expect(failure.data.key['notScreened']).toEqual(['--dump-config', '--dump-config-schema'])
    })

    it('command-failed：--dump-config-schema 退出码不在 {0,1} 内（且带上第一次的观测）', async () => {
      const dshHome = await tempDshHome()
      const { spawn } = dumpSpawn({ exitCode: 7, stdout: schemaOut([]) })
      const tool = createDumpConfigTool(depsFor(configFor(dshHome), { spawn }))

      const result = await run(tool, {})
      const failure = expectFail(result)
      expectShape(result)
      expect(failure.kind).toBe('command-failed')
      expect(String(failure.data.verdict)).toContain('outside the contract')
      // 第一次 dump 已经跑成了 —— 证据不许丢。
      const invocations = failure.data.key['invocations'] as Record<string, unknown>[]
      expect(invocations.map((item) => item['flag'])).toEqual([
        '--dump-config',
        '--dump-config-schema',
      ])
    })
  })

  describe('截断与渲染纪律', () => {
    it('L2 超上限时**明说并给总数**（`--dump-config-schema` 实测三万多行）', async () => {
      const dshHome = await tempDshHome()
      const diagnostics = Array.from({ length: 20 }, (_item, index) => ({
        level: 'error',
        path: `/${String(index + 1)}`,
        message: `carrier problem number ${String(index + 1)} that needs attention`,
      }))
      const { spawn } = dumpSpawn({ exitCode: 1, stdout: schemaOut(diagnostics) })
      const tool = createDumpConfigTool(depsFor(configFor(dshHome), { spawn }))

      const result = await run(tool, {})
      const failure = expectFail(result)
      expectShape(result)
      expect((failure.data.key['actionable'] as unknown[]).length).toBe(20)

      const text = renderText(tool, {}, result)
      const parts = splitRender(text)
      // 默认上限 15 行。
      expect(parts.l2).toHaveLength(15)
      // 截断必须明说，而且**给出被藏起来的条数**（20 + 4 条框架行 = 24 → 藏 9）。
      // ⚠️ 断言**整行逐字**（不是 `toContain`）：`toContain` 是子串判据，句尾再挂半句也照样绿。
      expect(text.split('\n')).toContain('9 more line(s) not shown')
    })

    it('形状不合法的值退化成一行，不抛', async () => {
      const dshHome = await tempDshHome()
      const tool = createDumpConfigTool(depsFor(configFor(dshHome)))
      const text = renderText(tool, {}, { nonsense: true })
      expect(text).toBe(`[${DUMP_CONFIG_TOOL}] {"nonsense":true}`)
    })

    it('守卫合成的兜底（`key` 是 `{}`）必须可渲染，且降级值看得出来', async () => {
      const dshHome = await tempDshHome()
      const tool = createDumpConfigTool(depsFor(configFor(dshHome)))

      // 造一个**形状非法**的返回值（`data.verdict` 是空串）→ 守卫合成兜底（`key: {}`）。
      const malformed = { ok: true, data: { verdict: '', key: {}, audit: {} } }
      const fallback = ensureToolResult(malformed)

      // ⚠️ 下界（活跃坑 18 / 37）：自证这**真的是**兜底 —— 幂等（它自己过了守卫），
      // 且**不等于**输入（输入被换掉了）。否则下面「渲染它当然不抛」是恒真的。
      expect(fallback, '守卫没换掉这个值 —— 下面测的就不是兜底路径').not.toBe(malformed)
      expect(ensureToolResult(fallback), '兜底自己没过守卫').toBe(fallback)
      expect(fallback.ok).toBe(false)

      // 渲染层**绝不抛**（`render.ts` §3.1）：兜底里 `invocations` / `actionable` 整块缺席，
      // 直接 `for…of` / `.length` 会当场抛。
      let text = ''
      expect(() => {
        text = renderText(tool, {}, fallback)
      }, '守卫合成的兜底把渲染层打崩了').not.toThrow()
      expect(text).toContain('verdict:')
      expect(text).toContain('resolved: unknown (the guard synthesized this result)')
      // 「不知道」不许印成「没有」：`actionable: none` 会被读成「一条问题都没有」。
      expect(text).toContain('actionable: unknown (the guard synthesized this result)')
    })

    it('`audit` 的叶子值一个字符都不许进模型文本（B22 的哨兵手法）', async () => {
      const dshHome = await tempDshHome()
      const { spawn } = dumpSpawn({ exitCode: 0, stdout: schemaOut([]) })
      const tool = createDumpConfigTool(depsFor(configFor(dshHome), { spawn }))
      const result = await run(tool, {})

      const sentinel = 'SENTINEL_B22_9f3a1c'
      const raw = result as unknown as { data?: Record<string, unknown> }
      const patched = {
        ...(result as unknown as Record<string, unknown>),
        data: { ...(raw.data ?? {}), audit: { deep: { secret: sentinel } } },
      }
      const text = renderText(tool, {}, patched)
      expect(text).toContain('verdict:')
      expect(text).not.toContain(sentinel)
      // 也不许有整块 pretty JSON（两空格缩进的块）。
      expect(text).not.toContain('\n  "')
    })

    it('`nextStep` 出现时必须带动作，且 L3 正文不许等于 L1（B18a / B18b）', async () => {
      const dshHome = await tempDshHome()
      const { spawn } = dumpSpawn({
        exitCode: 1,
        stdout: schemaOut([{ level: 'error', path: '/5', message: 'real problem' }]),
      })
      const tool = createDumpConfigTool(depsFor(configFor(dshHome), { spawn }))

      const result = await run(tool, {})
      expect(result.nextStep).toBeDefined()
      const step = result.nextStep as { tool?: string; manual?: boolean; why: string }
      const hasTool = typeof step.tool === 'string' && step.tool !== ''
      const hasManual = step.manual === true
      expect(hasTool !== hasManual).toBe(true)
      const parts = splitRender(renderText(tool, {}, result))
      expect(parts.l3).not.toBe(parts.verdict)
      expect(parts.l3).not.toBe('')
    })

    it('渲染永远有输出：头行 / verdict / L2 三层齐全', async () => {
      const dshHome = await tempDshHome()
      const { spawn } = dumpSpawn({ exitCode: 0, stdout: schemaOut([]) })
      const tool = createDumpConfigTool(depsFor(configFor(dshHome), { spawn }))
      const text = renderText(tool, {}, await run(tool, {}))
      const parts = splitRender(text)
      expect(parts.head).toBe(`[${DUMP_CONFIG_TOOL}] ok`)
      expect(parts.verdict).not.toBeUndefined()
      expect(parts.l2.some((line) => line.startsWith('resolved:'))).toBe(true)
      expect(parts.l2).toContain('actionable: none')
    })
  })

  describe('形状自检：B16 / B20b / B24 的判据在**本工具自己**身上跑一遍', () => {
    it('B16：两份 fixture（换输入**也换环境**）的 `verdict:` + L2 里没有共同的 ≥40 字符行', async () => {
      // 两份 fixture 各用一份临时 home：`resolved:` 行按环境恒定、不按输入恒定，
      // 共用同一个 home 时那行必然逐字相同 → 假红（SHAPE §3.1 规则 6）。
      const firstHome = await tempDshHome()
      const first = createDumpConfigTool(
        depsFor(configFor(firstHome), {
          spawn: dumpSpawn({ exitCode: 0, stdout: schemaOut([]) }).spawn,
        }),
      )
      const firstResult = await run(first, {})

      const secondHome = await tempDshHome()
      const secondTool = createDumpConfigTool(
        depsFor(configFor(secondHome), {
          spawn: dumpSpawn({
            exitCode: 1,
            stdout: schemaOut([{ level: 'error', path: '/2', message: 'real problem' }]),
          }).spawn,
        }),
      )
      const secondResult = await run(secondTool, {})

      const candidates = (tool: ToolDefinition, value: unknown): string[] => {
        const parts = splitRender(renderText(tool, {}, value))
        return [parts.verdict ?? '', ...parts.l2].filter((line) => line.length >= 40)
      }
      const a = candidates(first, firstResult)
      const b = candidates(secondTool, secondResult)

      // 下界：两份都要真的吐出候选行，否则「交集为空」是空转。
      expect(a.length, '第一份 fixture 没有 ≥40 字符的行 —— 判据空转').toBeGreaterThan(0)
      expect(b.length, '第二份 fixture 没有 ≥40 字符的行 —— 判据空转').toBeGreaterThan(0)
      expect(splitRender(renderText(first, {}, firstResult)).verdict).not.toBe(
        splitRender(renderText(secondTool, {}, secondResult)).verdict,
      )
      const shared = a.filter((line) => b.includes(line))
      expect(shared, `两份 fixture 共有的恒定行：${shared.join(' | ')}`).toEqual([])
    })

    it('B20b：描述与该工具的 render 输出之间没有 ≥40 字符的共享串', async () => {
      const cleanHome = await tempDshHome()
      const clean = createDumpConfigTool(
        depsFor(configFor(cleanHome), {
          spawn: dumpSpawn({ exitCode: 0, stdout: schemaOut([]) }).spawn,
        }),
      )
      const falsePositiveHome = await tempDshHome()
      const falsePositive = createDumpConfigTool(
        depsFor(configFor(falsePositiveHome), {
          spawn: dumpSpawn({
            exitCode: 1,
            stdout: schemaOut([{ level: 'error', path: '/182', message: CARRIER_MESSAGE }]),
          }).spawn,
        }),
      )

      const description = composeDescription(DUMP_CONFIG_DESCRIPTION)
      for (const tool of [clean, falsePositive]) {
        const text = renderText(tool, {}, await run(tool, {}))
        const shared = sharedSubstrings(description, text, 40)
        expect(shared, `描述里逐字抄了输出：${shared.join(' | ')}`).toEqual([])
      }
    })

    it('B24：底层 spawn 抛异常时 `execute` 也**返回**一个过守卫的合法结果', async () => {
      const dshHome = await tempDshHome()
      const { spawn } = recordingSpawn(() => {
        throw new Error('the spawn replacement exploded')
      })
      const tool = createDumpConfigTool(depsFor(configFor(dshHome), { spawn }))

      // 不许抛 —— 宿主只把抛出去的异常当失败，一旦抛出去，三层形状全部失效。
      const result = await run(tool, {})
      expect(result.ok).toBe(false)
      // 判据是「过守卫的恒等」，不是「没报错」：形状不合法的兜底结果不算通过。
      expect(toolResultProblem(result)).toBeUndefined()
      const failure = expectFail(result)
      expectShape(result)
      expect(failure.kind).toBe('internal')
      expectSubstantiveVerdict(failure.data.verdict)
      // 抛的是真原因，不是被吞掉。
      expect(failure.message).toContain('exploded')
    })
  })

  describe('signal 与超时纪律', () => {
    it('exec.signal 原样透传给两次 dump', async () => {
      const dshHome = await tempDshHome()
      const controller = new AbortController()
      const { spawn, calls } = dumpSpawn({ exitCode: 0, stdout: schemaOut([]) })
      const tool = createDumpConfigTool(depsFor(configFor(dshHome), { spawn }))

      await run(tool, {}, execWith(controller.signal))
      expect(calls).toHaveLength(2)
      expect(calls[0]?.signal).toBe(controller.signal)
      expect(calls[1]?.signal).toBe(controller.signal)
    })

    it('两条命令共享一个预算：各自的传输超时都小于工具预算，且总和不超', async () => {
      const dshHome = await tempDshHome()
      const config = configFor(dshHome, { timeoutMs: 15_000 })
      const { spawn, calls } = dumpSpawn({ exitCode: 0, stdout: schemaOut([]) })
      const tool = createDumpConfigTool(depsFor(config, { spawn }))

      await run(tool, {})
      // 本工具走**慢档**（它跑 `--dump-config-schema`），所以刀口在 `schemaDumpTimeoutMs`
      // 上，而不是 `timeoutMs` —— 后者是快档工具那一档的数（见 `lib/timeouts.ts` 的唯一映射点）。
      const budget = toolBudgetMs('schemaDump', config)
      expect(budget).toBe(config.schemaDumpTimeoutMs)
      expect(tool.timeoutMs).toBe(budget)
      const first = calls[0]?.timeoutMs ?? 0
      const second = calls[1]?.timeoutMs ?? 0
      expect(first).toBeGreaterThan(0)
      expect(second).toBeGreaterThan(0)
      // 「传输必须先于工具」：两条命令都得留出余量（`TRANSPORT_MARGIN_MS`）。
      expect(first).toBeLessThan(budget)
      expect(second).toBeLessThan(budget)
      expect(budget - first).toBeGreaterThanOrEqual(TRANSPORT_MARGIN_MS)
      // 只改了快档 ⇒ 慢档**不许**跟着动（两档是两件事）。
      expect(toolBudgetMs('quick', config)).toBe(15_000)
    })

    it('profile 参数会传进两次 dump 的命令行', async () => {
      const dshHome = await tempDshHome()
      const { spawn, calls } = dumpSpawn({ exitCode: 0, stdout: schemaOut([]) })
      const tool = createDumpConfigTool(depsFor(configFor(dshHome), { spawn }))

      await run(tool, { profile: 'tui' })
      expect(calls[0]?.args).toContain('tui')
      expect(calls[1]?.args).toContain('tui')
    })
  })
})
