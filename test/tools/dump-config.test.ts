/**
 * `dsh_dump_config` 的行为红线。
 *
 * 这一份最要紧的两条断言，都是 SKILL §3.8 里那两句容易读反的话：
 * 1. **`--dump-config` 退出码恒 0 → 不能当门禁**：所以「exit 0」绝不等于「配置没坏」，
 *    组合期错只出现在 stderr 里；
 * 2. **error 可能是误报**：`unrecognized Loader tree carrier` 落在 `preset-*` 行上时是已知误报，
 *    判它必须把 `path`（`/182`）解析成 entry id —— 这条断言直接钉住那个解析。
 */
import { describe, expect, it } from 'vitest'

import { createDumpConfigTool, DUMP_CONFIG_TOOL } from '../../src/tools/dsh_dump_config.ts'
import { TOOL_ERROR_KINDS } from '../../src/lib/errors.ts'
import {
  cmdResult,
  configFor,
  depsFor,
  execWith,
  expectFail,
  expectOk,
  recordingSpawn,
  run,
  tempDshHome,
} from './helpers.ts'
import type { CommandResult, RunCommandOptions } from '../../src/lib/exec.ts'

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

/** 一个按 flag 分派的 spawn。 */
function dumpSpawn(
  schema: { exitCode: number; stdout: string; stderr?: string },
  configDump: { exitCode?: number; stdout?: string; stderr?: string } = {},
) {
  return recordingSpawn((options: RunCommandOptions): CommandResult => {
    const flag = options.args[options.args.length - 1]
    if (flag === '--dump-config-schema') {
      return cmdResult({
        code: schema.exitCode,
        stdout: schema.stdout,
        stderr: schema.stderr ?? '',
      })
    }
    return cmdResult({
      code: configDump.exitCode ?? 0,
      stdout: configDump.stdout ?? composedConfig(),
      stderr: configDump.stderr ?? '',
    })
  })
}

describe('dsh_dump_config', () => {
  it('工具名与契约一致', () => {
    expect(DUMP_CONFIG_TOOL).toBe('dsh_dump_config')
  })

  describe('成功路径', () => {
    it('只有 preset 行的 error 时：退出码 1 但归为已知误报，仍算成功', async () => {
      const dshHome = await tempDshHome()
      const { spawn } = dumpSpawn({
        exitCode: 1,
        stdout: schemaOut([
          {
            level: 'error',
            path: '/182',
            message:
              'unrecognized Loader tree carrier; use cordis:group or cordis:include for native child collection',
          },
        ]),
      })
      const tool = createDumpConfigTool(depsFor(configFor(dshHome), { spawn }))

      const data = expectOk(await run(tool, {}))
      expect((data['schemaDump'] as Record<string, unknown>)['hasErrors']).toBe(true)
      expect((data['counts'] as Record<string, number>)['known-false-positive']).toBe(1)
      expect(data['actionable']).toEqual([])
      const fp = data['knownFalsePositives'] as Record<string, unknown>[]
      // path 被解析成了 entry id —— 这是「误报 vs 真问题」唯一的判据。
      expect(fp[0]?.['entryId']).toBe('preset-standard')
    })

    it('exit 0 且无诊断 → 成功，且明确说明退出码语义', async () => {
      const dshHome = await tempDshHome()
      const { spawn } = dumpSpawn({ exitCode: 0, stdout: schemaOut([]) })
      const tool = createDumpConfigTool(depsFor(configFor(dshHome), { spawn }))

      const data = expectOk(await run(tool, {}))
      expect((data['diagnostics'] as unknown[]).length).toBe(0)
      expect((data['exitCodeSemantics'] as Record<string, string>)['configDump']).toContain(
        'always exits 0',
      )
      expect((data['configDump'] as Record<string, unknown>)['entryCount']).toBe(183)
      // 「我 dump 的是哪个 profile」是这份输出的前提 —— 必须摊开。
      const resolved = data['resolved'] as Record<string, unknown>
      expect(resolved['profile']).toBe('web')
      expect(resolved['portSource']).toBe('not-used')
    })

    it('工具参数传的 profile 会如实进入 resolved（而不是谎报配置里那个）', async () => {
      const dshHome = await tempDshHome()
      const { spawn } = dumpSpawn({ exitCode: 0, stdout: schemaOut([]) })
      const tool = createDumpConfigTool(depsFor(configFor(dshHome, { profile: 'web' }), { spawn }))

      const data = expectOk(await run(tool, { profile: 'tui' }))
      expect((data['resolved'] as Record<string, unknown>)['profile']).toBe('tui')
    })

    it('hmr 行会被认出来', async () => {
      const dshHome = await tempDshHome()
      const stdout = ['- id: hmr', "  name: '@deepseek-ai/dsh-hmr'", '- id: llm'].join('\n')
      const { spawn } = dumpSpawn({ exitCode: 0, stdout: schemaOut([]) }, { stdout })
      const tool = createDumpConfigTool(depsFor(configFor(dshHome), { spawn }))

      const data = expectOk(await run(tool, {}))
      expect((data['hmr'] as Record<string, unknown>)['present']).toBe(true)
    })

    it('组合期错在 stderr、退出码却是 0 —— 必须被照出来（不能信退出码）', async () => {
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
      // 有组合期错 → 不该报成功（退出码是 0，所以只能靠 stderr）。
      const error = expectFail(result)
      expect(error.kind).toBe('command-failed')
      expect(error.message).toContain('composition error')
      expect(error.message).toContain('skipping')
    })

    it('error 指向非 preset 行 → 真问题，报 command-failed', async () => {
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

      const error = expectFail(await run(tool, {}))
      expect(error.kind).toBe('command-failed')
      expect(TOOL_ERROR_KINDS).toContain(error.kind)
    })
  })

  describe('错误路径（每条可达 kind）', () => {
    it('internal：dshHome 空串是**契约被违反**的防御性断言（不再是 not-configured）', async () => {
      // 兜底补上之后（config → env → <homedir>/.dsh），空串只可能是本插件的 bug。
      const tool = createDumpConfigTool(depsFor(configFor('')))
      const error = expectFail(await run(tool, {}))
      expect(error.kind).toBe('internal')
      expect(error.message).toContain('resolveConfig')
    })

    it('not-configured：起不了 dsh（ENOENT）', async () => {
      const dshHome = await tempDshHome()
      const { spawn } = recordingSpawn(() => cmdResult({ code: null, spawnError: 'spawn: ENOENT' }))
      const tool = createDumpConfigTool(depsFor(configFor(dshHome), { spawn }))

      const error = expectFail(await run(tool, {}))
      expect(error.kind).toBe('not-configured')
    })

    it('internal：起不了 dsh 但不是 ENOENT', async () => {
      const dshHome = await tempDshHome()
      const { spawn } = recordingSpawn(() => cmdResult({ code: null, spawnError: 'spawn: EACCES' }))
      const tool = createDumpConfigTool(depsFor(configFor(dshHome), { spawn }))

      const error = expectFail(await run(tool, {}))
      expect(error.kind).toBe('internal')
    })

    it('timeout：dump-config 传输层超时', async () => {
      const dshHome = await tempDshHome()
      const { spawn } = recordingSpawn(() => cmdResult({ code: null, timedOut: true }))
      const tool = createDumpConfigTool(depsFor(configFor(dshHome), { spawn }))

      const error = expectFail(await run(tool, {}))
      expect(error.kind).toBe('timeout')
    })

    it('cancelled：调用方取消', async () => {
      const dshHome = await tempDshHome()
      const { spawn } = recordingSpawn(() => cmdResult({ code: null, aborted: true }))
      const tool = createDumpConfigTool(depsFor(configFor(dshHome), { spawn }))

      const error = expectFail(await run(tool, {}))
      expect(error.kind).toBe('cancelled')
    })

    it('command-failed：--dump-config 意外非零退出（契约是恒 0）', async () => {
      const dshHome = await tempDshHome()
      const { spawn } = recordingSpawn((options) =>
        options.args[options.args.length - 1] === '--dump-config'
          ? cmdResult({ code: 3 })
          : cmdResult({ stdout: schemaOut([]) }),
      )
      const tool = createDumpConfigTool(depsFor(configFor(dshHome), { spawn }))

      const error = expectFail(await run(tool, {}))
      expect(error.kind).toBe('command-failed')
      // 断言的是**这条**消息里的措辞（不是 exitCodeSemantics 那句 "always exits 0"）。
      expect(error.message).toContain('the contract is always 0')
    })

    it('command-failed：--dump-config-schema 退出码不在 {0,1} 内', async () => {
      const dshHome = await tempDshHome()
      const { spawn } = dumpSpawn({ exitCode: 7, stdout: schemaOut([]) })
      const tool = createDumpConfigTool(depsFor(configFor(dshHome), { spawn }))

      const error = expectFail(await run(tool, {}))
      expect(error.kind).toBe('command-failed')
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
      const first = calls[0]?.timeoutMs ?? 0
      const second = calls[1]?.timeoutMs ?? 0
      expect(first).toBeGreaterThan(0)
      expect(second).toBeGreaterThan(0)
      expect(first).toBeLessThan(config.timeoutMs)
      expect(second).toBeLessThan(config.timeoutMs)
      expect(tool.timeoutMs).toBe(config.timeoutMs)
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
