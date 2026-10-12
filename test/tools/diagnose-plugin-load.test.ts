/**
 * `dsh_diagnose_plugin_load` 的行为红线。
 *
 * 两条最要紧的断言：
 * 1. **「没在监听」不是本工具的失败** —— 它是诊断结论的一部分；而
 *    **「entry 文件不在」是**失败（组合层会整条丢弃那个插件，静默）；
 * 2. 输出里必须带 `loadProofCaveat` —— 不说这句，模型会把「三处都在」
 *    读成「插件活着」，而 Fiber 状态根本没有查询入口。
 *
 * 可达 kind 是穷举的：`not-found` / `timeout` / `cancelled` / `internal`。
 * `internal` 现在只由**防御性断言**产生（`dshHome` 空串 = 契约被违反）。
 * `not-configured` **不再可达** —— 本工具不起 dsh 子进程，而 dshHome 兜底已补上；
 * 端口查不出来只会降级成 `probed: false`，不让文件层诊断作废。
 * `not-running` 与 `auth` 不可能出现（不探网络）；`command-failed` 也不会
 * —— 端口查询失败不会让整份说明失败。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  createDiagnosePluginLoadTool,
  DIAGNOSE_PLUGIN_LOAD_TOOL,
} from '../../src/tools/dsh_diagnose_plugin_load.ts'
import { FIBER_STATE } from '../../src/lib/fiber.ts'
import { TOOL_ERROR_KINDS } from '../../src/lib/errors.ts'
import {
  cmdResult,
  configFor,
  depsFor,
  entrySnapshot,
  execWith,
  expectFail,
  expectOk,
  jumpingClock,
  linkDir,
  loaderWith,
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
      // 这份诊断的全部结论都建立在「读的是哪个目录」上 —— 来源必须可见。
      const resolved = data['resolved'] as Record<string, unknown>
      expect(resolved['profile']).toBe('web')
      expect(resolved['dshHome']).toBe(dshHome)
      expect(resolved['dshHomeSource']).toBe('config')
      expect(data['bundles']).toEqual(['dsh-zhihu-search'])
      const pkg = (data['packages'] as Record<string, unknown>[])[0]
      expect((pkg?.['entry'] as Record<string, unknown>)['entryExists']).toBe(true)
      // 旧的推断字段必须原样还在（向后兼容）。
      expect(pkg?.['inBundles']).toBe(true)
      expect(pkg?.['artifactNewerThanProcess']).toBeDefined()
    })

    it('默认没有 loader → 降级成 inferred，并显式标注「未能直接观测」', async () => {
      const dshHome = await tempDshHome()
      const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
      await writeInstalledPackage(profileDir, 'pkg-a')
      const { spawn } = recordingSpawn(() => cmdResult({ stdout: '' }))
      // 不给 loader → 用默认的「没有宿主上下文」实现。
      const tool = createDiagnosePluginLoadTool(depsFor(configFor(dshHome), { spawn }))

      const data = expectOk(await run(tool, {}))
      const observation = data['observation'] as Record<string, unknown>
      expect(observation['mode']).toBe('inferred')
      // 这是要求②的核心：读不到时必须**在输出里标注**，不能默默给推断结论。
      expect(String(observation['note'])).toContain('未能直接观测')
      expect(String(observation['note'])).toContain('推断')
      // 降级时不给 per-package 的观测字段 —— 推断的东西不许混进观测字段。
      expect((data['packages'] as Record<string, unknown>[])[0]?.['observed']).toBeUndefined()
      expect(String(data['verdict'])).toContain('推断')
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
      const lookup = port['lookup'] as Record<string, unknown>
      // 端口查询是**平台相关**的：v1 只在 Windows 上查监听端口，非 Windows 恒为
      // `probed: false`（见 src/lib/ports.ts 的早返回）。所以这里必须按平台断言 ——
      // 写死 `probed === true` 会在 CI(ubuntu) 上红，而那是**设计如此**，不是缺陷。
      if (process.platform === 'win32') {
        expect(lookup['probed']).toBe(true)
        expect(lookup['listening']).toBe(false)
      } else {
        expect(lookup['probed']).toBe(false)
        expect(lookup['listening']).toBe(false)
        expect(String(lookup['detail'])).toContain(process.platform)
      }
      // 端口值与其来源在 resolved 里（一处一事实，不在这里重复）。
      const resolved = data['resolved'] as Record<string, unknown>
      expect(resolved['port']).toBe(3080)
      expect(resolved['portSource']).toBe('plugin-config')
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

  describe('观测路径（Loader 树可读）', () => {
    /** 造一个「有 loader」的诊断 fixture。 */
    async function observedFixture(
      snapshot: ReturnType<typeof entrySnapshot>,
    ): Promise<{ tool: ReturnType<typeof createDiagnosePluginLoadTool> }> {
      const dshHome = await tempDshHome()
      const profileDir = await writeProfile(dshHome, 'web', { bundles: [snapshot.moduleName] })
      await writeInstalledPackage(profileDir, snapshot.moduleName)
      const { spawn } = recordingSpawn(() => cmdResult({ stdout: '' }))
      return {
        tool: createDiagnosePluginLoadTool(
          depsFor(configFor(dshHome), { spawn, loader: loaderWith([snapshot]) }),
        ),
      }
    }

    it('import 期失败（fiber 不存在）→ observed failed / failed to import', async () => {
      const { tool } = await observedFixture(
        entrySnapshot({ moduleName: 'pkg-a', hasFiber: false }),
      )

      const data = expectOk(await run(tool, {}))
      expect((data['observation'] as Record<string, unknown>)['mode']).toBe('observed')
      const observed = (data['packages'] as Record<string, unknown>[])[0]?.['observed'] as Record<
        string,
        unknown
      >
      expect(observed['phase']).toBe('failed')
      expect(observed['error']).toBe('failed to import')
      expect(String(data['verdict'])).toContain('观测到加载失败')
    })

    it('apply 失败（state=3）→ observed failed，带上失败原因', async () => {
      const { tool } = await observedFixture(
        entrySnapshot({ moduleName: 'pkg-a', fiberState: FIBER_STATE.FAILED, fiberError: 'boom' }),
      )

      const data = expectOk(await run(tool, {}))
      const observed = (data['packages'] as Record<string, unknown>[])[0]?.['observed'] as Record<
        string,
        unknown
      >
      expect(observed['phase']).toBe('failed')
      expect(observed['error']).toBe('boom')
      expect(observed['fiberState']).toBe(3)
    })

    it('pending（state=0）→ observed pending，带缺哪些 service', async () => {
      const { tool } = await observedFixture(
        entrySnapshot({
          moduleName: 'pkg-a',
          fiberState: FIBER_STATE.PENDING,
          inject: ['tools', 'fs'],
          presentServices: ['tools'],
        }),
      )

      const data = expectOk(await run(tool, {}))
      const observed = (data['packages'] as Record<string, unknown>[])[0]?.['observed'] as Record<
        string,
        unknown
      >
      expect(observed['phase']).toBe('pending')
      expect(observed['missingInject']).toEqual(['fs'])
      expect(String(data['verdict'])).toContain('仍在 pending')
    })

    it('active（state=2）→ 结论是「确实加载成功了」', async () => {
      const { tool } = await observedFixture(
        entrySnapshot({ moduleName: 'pkg-a', fiberState: FIBER_STATE.ACTIVE }),
      )

      const data = expectOk(await run(tool, {}))
      const observed = (data['packages'] as Record<string, unknown>[])[0]?.['observed'] as Record<
        string,
        unknown
      >
      expect(observed['phase']).toBe('active')
      expect(String(data['verdict'])).toContain('确实加载成功')
    })

    it('装了但树里一行都没有 → 硬证据：组合层没有它', async () => {
      const dshHome = await tempDshHome()
      const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
      await writeInstalledPackage(profileDir, 'pkg-a')
      const { spawn } = recordingSpawn(() => cmdResult({ stdout: '' }))
      const tool = createDiagnosePluginLoadTool(
        depsFor(configFor(dshHome), {
          spawn,
          // 树里有别的行，就是没有 pkg-a。
          loader: loaderWith([entrySnapshot({ moduleName: 'other-pkg', fiberState: 2 })]),
        }),
      )

      const data = expectOk(await run(tool, {}))
      const observed = (data['packages'] as Record<string, unknown>[])[0]?.['observed'] as Record<
        string,
        unknown
      >
      expect(observed['matchedEntryIds']).toEqual([])
      expect(String(observed['error'])).toContain('任何一行')
      expect(String(data['verdict'])).toContain('Loader 树里没有这一行')
    })

    it('一个包有多行时取最坏的一档（报 active 而另一行崩了最误导）', async () => {
      const dshHome = await tempDshHome()
      const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
      await writeInstalledPackage(profileDir, 'pkg-a')
      const { spawn } = recordingSpawn(() => cmdResult({ stdout: '' }))
      const tool = createDiagnosePluginLoadTool(
        depsFor(configFor(dshHome), {
          spawn,
          loader: loaderWith([
            entrySnapshot({ moduleName: 'pkg-a', entryId: 'a1', fiberState: 2 }),
            entrySnapshot({ moduleName: 'pkg-a', entryId: 'a2', hasFiber: false }),
          ]),
        }),
      )

      const data = expectOk(await run(tool, {}))
      const observed = (data['packages'] as Record<string, unknown>[])[0]?.['observed'] as Record<
        string,
        unknown
      >
      expect(observed['phase']).toBe('failed')
      expect(observed['matchedEntryIds']).toEqual(['a1', 'a2'])
    })

    it('观测模式给出相位直方图（判断快照是否已稳定）', async () => {
      const dshHome = await tempDshHome()
      const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
      await writeInstalledPackage(profileDir, 'pkg-a')
      const { spawn } = recordingSpawn(() => cmdResult({ stdout: '' }))
      const tool = createDiagnosePluginLoadTool(
        depsFor(configFor(dshHome), {
          spawn,
          loader: loaderWith([
            entrySnapshot({ moduleName: 'pkg-a', fiberState: 2 }),
            entrySnapshot({ moduleName: 'pkg-b', fiberState: 3 }),
            entrySnapshot({ moduleName: 'pkg-c', hasFiber: false }),
          ]),
        }),
      )

      const data = expectOk(await run(tool, {}))
      const observation = data['observation'] as Record<string, unknown>
      expect(observation['entryCount']).toBe(3)
      expect(observation['phaseHistogram']).toEqual({ active: 1, failed: 2 })
    })
  })

  describe('错误路径（每条可达 kind）', () => {
    it('internal：dshHome 空串是**契约被违反**的防御性断言（不再是 not-configured）', async () => {
      // 本工具**不**起 dsh 子进程，所以它没有别的 not-configured 来源：
      // 兜底补上之后（config → env → <homedir>/.dsh），空串只可能是本插件的 bug。
      const tool = createDiagnosePluginLoadTool(depsFor(configFor('')))
      const error = expectFail(await run(tool, {}))
      expect(error.kind).toBe('internal')
      expect(error.message).toContain('resolveConfig')
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
