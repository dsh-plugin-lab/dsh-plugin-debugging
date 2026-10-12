/**
 * `dsh_diagnose_plugin_load` 的行为红线。
 *
 * 两条最要紧的断言：
 * 1. **「没在监听」不是本工具的失败** —— 它是诊断结论的一部分；而
 *    **「entry 文件不在」是**失败（组合层会整条丢弃那个插件，静默）；
 * 2. 输出里必须带 `loadProofCaveat` —— 不说这句，模型会把「三处都在」
 *    读成「插件活着」，而 Fiber 状态根本没有查询入口。
 *
 * 可达 kind 是穷举的：`not-configured` / `not-found` / `timeout` / `cancelled`。
 * `not-running` 与 `auth` 不可能出现（不探网络）；`command-failed` 也不会
 * —— 端口查询失败只会降级成 `probed: false`，不让整份文件层诊断作废。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  createDiagnosePluginLoadTool,
  DIAGNOSE_PLUGIN_LOAD_TOOL,
} from '../../src/tools/dsh_diagnose_plugin_load.ts'
import { TOOL_ERROR_KINDS } from '../../src/lib/errors.ts'
import {
  cmdResult,
  configFor,
  depsFor,
  execWith,
  expectFail,
  expectOk,
  jumpingClock,
  linkDir,
  recordingSpawn,
  run,
  tempDshHome,
  writeInstalledPackage,
  writeProfile,
  writeText,
} from './helpers.ts'

/** 一段正常回答端口查询的输出（pid|进程名|启动时间）。 */
const LISTENING_OUTPUT = '4242|node|2026-10-12T20:00:00.0000000+08:00\n'

describe('dsh_diagnose_plugin_load', () => {
  it('工具名与契约一致', () => {
    expect(DIAGNOSE_PLUGIN_LOAD_TOOL).toBe('dsh_diagnose_plugin_load')
  })

  describe('成功路径', () => {
    it('bundles / 安装形态 / entry 都查得到', async () => {
      const dshHome = await tempDshHome()
      const profileDir = await writeProfile(dshHome, 'web', {
        bundles: ['dsh-zhihu-search'],
        dependencies: { 'dsh-zhihu-search': 'link:D:/repo' },
      })
      await writeInstalledPackage(profileDir, 'dsh-zhihu-search')
      const { spawn } = recordingSpawn(() => cmdResult({ stdout: LISTENING_OUTPUT }))
      const tool = createDiagnosePluginLoadTool(depsFor(configFor(dshHome), { spawn }))

      const data = expectOk(await run(tool, {}))
      expect(data['profile']).toBe('web')
      expect(data['bundles']).toEqual(['dsh-zhihu-search'])
      const pkg = (data['packages'] as Record<string, unknown>[])[0]
      expect((pkg?.['entry'] as Record<string, unknown>)['entryExists']).toBe(true)
      // 必须是「三处只证前置条件」那句话，否则模型会误读成「插件活着」。
      expect(String(data['loadProofCaveat'])).toContain('不证加载成功')
    })

    it('link 形态被认出来（D:/repo 是 junction 的目标）', async () => {
      const dshHome = await tempDshHome()
      const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
      const repo = join(dshHome, 'fake-repo')
      await writeText(
        join(repo, 'package.json'),
        JSON.stringify({ name: 'pkg-a', main: './lib/index.js' }),
      )
      await writeText(join(repo, 'lib', 'index.js'), '// 产物\n')
      await linkDir(repo, join(profileDir, 'node_modules', 'pkg-a'))
      const { spawn } = recordingSpawn(() => cmdResult({ stdout: '' }))
      const tool = createDiagnosePluginLoadTool(depsFor(configFor(dshHome), { spawn }))

      const data = expectOk(await run(tool, {}))
      const pkg = (data['packages'] as Record<string, unknown>[])[0]
      expect((pkg?.['install'] as Record<string, unknown>)['linkType']).toBe('link')
    })

    it('没有 startup 日志 = 好消息，必须说出来', async () => {
      const dshHome = await tempDshHome()
      const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
      await writeInstalledPackage(profileDir, 'pkg-a')
      const { spawn } = recordingSpawn(() => cmdResult({ stdout: '' }))
      const tool = createDiagnosePluginLoadTool(depsFor(configFor(dshHome), { spawn }))

      const data = expectOk(await run(tool, {}))
      expect(data['startupLogs']).toEqual([])
      expect(String(data['startupLogsNote'])).toContain('只在**启动失败**时生成')
    })

    it('有 startup 日志时列出来（按时间倒序）', async () => {
      const dshHome = await tempDshHome()
      const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
      await writeInstalledPackage(profileDir, 'pkg-a')
      await writeText(join(dshHome, 'logs', 'startup-2026-10-12T20-00-00-000Z-abc.log'), 'boom\n')
      const { spawn } = recordingSpawn(() => cmdResult({ stdout: '' }))
      const tool = createDiagnosePluginLoadTool(depsFor(configFor(dshHome), { spawn }))

      const data = expectOk(await run(tool, {}))
      expect((data['startupLogs'] as unknown[]).length).toBe(1)
    })

    it('端口上没监听者不算失败（是结论的一部分）', async () => {
      const dshHome = await tempDshHome()
      const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
      await writeInstalledPackage(profileDir, 'pkg-a')
      const { spawn } = recordingSpawn(() => cmdResult({ stdout: '' }))
      const tool = createDiagnosePluginLoadTool(
        depsFor(configFor(dshHome, { port: 3080 }), { spawn }),
      )

      const data = expectOk(await run(tool, {}))
      const port = data['port'] as Record<string, unknown>
      expect((port['lookup'] as Record<string, unknown>)['probed']).toBe(true)
      expect((port['lookup'] as Record<string, unknown>)['listening']).toBe(false)
    })

    it('产物比进程新 → artifactNewerThanProcess=true（宿主端跑的是旧产物）', async () => {
      const dshHome = await tempDshHome()
      const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
      await writeInstalledPackage(profileDir, 'pkg-a')
      // 进程启动时间设成 2020 年，产物是「现在」写的 → 产物更新。
      const { spawn } = recordingSpawn(() =>
        cmdResult({ stdout: '4242|node|2020-01-01T00:00:00.0000000+08:00\n' }),
      )
      const tool = createDiagnosePluginLoadTool(
        depsFor(configFor(dshHome, { port: 3080 }), { spawn }),
      )

      const data = expectOk(await run(tool, {}))
      const pkg = (data['packages'] as Record<string, unknown>[])[0]
      expect(pkg?.['artifactNewerThanProcess']).toBe(true)
    })

    it('只查指定包时不会展开整份 bundles', async () => {
      const dshHome = await tempDshHome()
      const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
      await writeInstalledPackage(profileDir, 'pkg-a')
      // pkg-b **装了但不在 bundles 里** —— 正是「装了没启用」的第一类原因。
      await writeInstalledPackage(profileDir, 'pkg-b')
      const { spawn } = recordingSpawn(() => cmdResult({ stdout: '' }))
      const tool = createDiagnosePluginLoadTool(depsFor(configFor(dshHome), { spawn }))

      const data = expectOk(await run(tool, { package: 'pkg-b' }))
      expect((data['packages'] as unknown[]).length).toBe(1)
      expect((data['packages'] as Record<string, unknown>[])[0]?.['inBundles']).toBe(false)
    })
  })

  describe('错误路径（每条可达 kind）', () => {
    it('not-configured：拿不到 DSH_HOME', async () => {
      const tool = createDiagnosePluginLoadTool(depsFor(configFor('')))
      const error = expectFail(await run(tool, {}))
      expect(error.kind).toBe('not-configured')
      expect(TOOL_ERROR_KINDS).toContain(error.kind)
    })

    it('timeout：预算在开工前已耗尽', async () => {
      const dshHome = await tempDshHome()
      const config = configFor(dshHome)
      const tool = createDiagnosePluginLoadTool(
        depsFor(config, { now: jumpingClock(config.timeoutMs) }),
      )
      const error = expectFail(await run(tool, {}))
      expect(error.kind).toBe('timeout')
    })

    it('cancelled：调用方取消（不拿半份结果当结论）', async () => {
      const dshHome = await tempDshHome()
      const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
      await writeInstalledPackage(profileDir, 'pkg-a')
      const controller = new AbortController()
      const { spawn } = recordingSpawn(() => {
        controller.abort()
        return cmdResult({ stdout: '' })
      })
      const tool = createDiagnosePluginLoadTool(
        depsFor(configFor(dshHome, { port: 3080 }), { spawn }),
      )

      const error = expectFail(await run(tool, {}, execWith(controller.signal)))
      expect(error.kind).toBe('cancelled')
    })

    it('not-found：profile 的 package.json 读不到', async () => {
      const dshHome = await tempDshHome()
      const tool = createDiagnosePluginLoadTool(depsFor(configFor(dshHome)))
      const error = expectFail(await run(tool, {}))
      expect(error.kind).toBe('not-found')
    })

    it('not-found：entry 文件不存在（组合层会整条丢弃该插件）', async () => {
      const dshHome = await tempDshHome()
      const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
      await writeInstalledPackage(profileDir, 'pkg-a', { writeEntryFile: false })
      const { spawn } = recordingSpawn(() => cmdResult({ stdout: '' }))
      const tool = createDiagnosePluginLoadTool(depsFor(configFor(dshHome), { spawn }))

      const error = expectFail(await run(tool, {}))
      expect(error.kind).toBe('not-found')
      expect(error.message).toContain('pkg-a')
    })
  })

  describe('signal 与超时纪律', () => {
    it('exec.signal 原样透传给端口查询的 spawn', async () => {
      const dshHome = await tempDshHome()
      const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
      await writeInstalledPackage(profileDir, 'pkg-a')
      const controller = new AbortController()
      const { spawn, calls } = recordingSpawn(() => cmdResult({ stdout: '' }))
      const tool = createDiagnosePluginLoadTool(
        depsFor(configFor(dshHome, { port: 3080 }), { spawn }),
      )

      await run(tool, {}, execWith(controller.signal))
      expect(calls[0]?.signal).toBe(controller.signal)
    })

    it('端口查询的传输预算小于工具预算', async () => {
      const dshHome = await tempDshHome()
      const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
      await writeInstalledPackage(profileDir, 'pkg-a')
      const config = configFor(dshHome, { port: 3080, timeoutMs: 15_000 })
      const { spawn, calls } = recordingSpawn(() => cmdResult({ stdout: '' }))
      const tool = createDiagnosePluginLoadTool(depsFor(config, { spawn }))

      await run(tool, {})
      expect(calls[0]?.timeoutMs ?? 0).toBeLessThan(config.timeoutMs)
      expect(tool.timeoutMs).toBe(config.timeoutMs)
    })

    it('端口按 LocalPort 查，不用命令行子串（子串会误匹配派生 shell）', async () => {
      const dshHome = await tempDshHome()
      const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
      await writeInstalledPackage(profileDir, 'pkg-a')
      const { spawn, calls } = recordingSpawn(() => cmdResult({ stdout: '' }))
      const tool = createDiagnosePluginLoadTool(
        depsFor(configFor(dshHome, { port: 3080 }), { spawn }),
      )

      await run(tool, {})
      const script = calls[0]?.args.join(' ') ?? ''
      expect(script).toContain('-LocalPort 3080')
      expect(script).toContain('-State Listen')
      expect(script).not.toContain('bin.js')
    })
  })
})
