/**
 * `dsh_check_effect_mode` 的行为红线。
 *
 * 覆盖任务要求的三类：成功路径、每条可达 `kind`、signal 透传、超时先于工具超时。
 * 「可达 kind」是**穷举**的：`not-configured` / `cancelled` / `timeout` / `not-configured`(spawn ENOENT) / `internal`，
 * 唯一不可达的是 `not-running` / `auth` / `not-found` / `command-failed`
 * —— 这个工具不碰网络、不查文件存在性、不解释子进程退出码，所以不可能报它们。
 */
import { describe, expect, it } from 'vitest'

import { createEffectModeTool, EFFECT_MODE_TOOL } from '../../src/tools/dsh_check_effect_mode.ts'
import { TOOL_ERROR_KINDS } from '../../src/lib/errors.ts'
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

describe('dsh_check_effect_mode', () => {
  it('工具名与契约一致', () => {
    expect(EFFECT_MODE_TOOL).toBe('dsh_check_effect_mode')
  })

  describe('成功路径', () => {
    it('profile 文件里有 hmr 时，配置改动是热生效（不降级）', async () => {
      const dshHome = await tempDshHome()
      await writeProfile(dshHome, 'web', { bundles: ['@deepseek-ai/dsh-hmr'] })
      const tool = createEffectModeTool(depsFor(configFor(dshHome)))

      const data = expectOk(await run(tool, { change: 'config' }))
      expect(data['mode']).toBe('hot')
      expect(data['baseline']).toBe('hot')
      expect(data['downgraded']).toBe(false)
      expect((data['hmr'] as Record<string, unknown>)['usable']).toBe(true)
    })

    it('新装 bundle：不在 dependencies 里是热生效，在里面是必须重启', async () => {
      const dshHome = await tempDshHome()
      await writeProfile(dshHome, 'web', { bundles: ['@deepseek-ai/dsh-hmr'] })
      const tool = createEffectModeTool(depsFor(configFor(dshHome)))

      const fresh = expectOk(
        await run(tool, { change: 'bundle-added', alreadyInDependencies: false }),
      )
      expect(fresh['mode']).toBe('hot')

      const already = expectOk(
        await run(tool, { change: 'bundle-added', alreadyInDependencies: true }),
      )
      expect(already['baseline']).toBe('restart-required')
      expect(already['mode']).toBe('restart-required')
      expect(already['downgraded']).toBe(false)
    })

    it('宿主端代码改动无论有没有 hmr 都必须重启', async () => {
      const dshHome = await tempDshHome()
      await writeProfile(dshHome, 'web', { bundles: [] })
      const { spawn } = recordingSpawn(() => cmdResult({ stdout: CONFIG_WITHOUT_HMR }))
      const tool = createEffectModeTool(depsFor(configFor(dshHome), { spawn }))

      const data = expectOk(await run(tool, { change: 'host-code' }))
      expect(data['mode']).toBe('restart-required')
      expect(data['downgraded']).toBe(false)
    })

    it('无 hmr 时「热生效」降级成 restart-required（核心断言）', async () => {
      const dshHome = await tempDshHome()
      await writeProfile(dshHome, 'web', { bundles: [] })
      const { spawn, calls } = recordingSpawn(() => cmdResult({ stdout: CONFIG_WITHOUT_HMR }))
      const tool = createEffectModeTool(depsFor(configFor(dshHome), { spawn }))

      const data = expectOk(await run(tool, { change: 'config' }))
      expect(data['baseline']).toBe('hot')
      expect(data['mode']).toBe('restart-required')
      expect(data['downgraded']).toBe(true)
      // 文件层看不到 hmr → 必须补跑一次 dump 复核（否定的代价大）。
      expect(calls).toHaveLength(1)
      expect(calls[0]?.args).toContain('--dump-config')
    })

    it('无 hmr 时客户端改动降级成「构建 + 刷新」，不是重启', async () => {
      const dshHome = await tempDshHome()
      await writeProfile(dshHome, 'web', { bundles: [] })
      const { spawn } = recordingSpawn(() => cmdResult({ stdout: CONFIG_WITHOUT_HMR }))
      const tool = createEffectModeTool(depsFor(configFor(dshHome), { spawn }))

      const data = expectOk(await run(tool, { change: 'client-code' }))
      expect(data['baseline']).toBe('hmr')
      expect(data['mode']).toBe('client-rebuild')
      expect(data['downgraded']).toBe(true)
    })

    it('有 hmr 时客户端改动走 hmr', async () => {
      const dshHome = await tempDshHome()
      await writeProfile(dshHome, 'web', { bundles: ['@deepseek-ai/dsh-hmr'] })
      const tool = createEffectModeTool(depsFor(configFor(dshHome)))

      const data = expectOk(await run(tool, { change: 'client-code' }))
      expect(data['mode']).toBe('hmr')
    })

    it('每次成功都带 nextStep（决策 T19）', async () => {
      const dshHome = await tempDshHome()
      await writeProfile(dshHome, 'web', { bundles: ['@deepseek-ai/dsh-hmr'] })
      const tool = createEffectModeTool(depsFor(configFor(dshHome)))

      const result = await run(tool, { change: 'config' })
      expect(result.ok).toBe(true)
      expect(result.nextStep?.why).toBeTruthy()
    })
  })

  describe('错误路径（每条可达 kind）', () => {
    it('not-configured：拿不到 DSH_HOME', async () => {
      const tool = createEffectModeTool(depsFor(configFor('')))
      const error = expectFail(await run(tool, { change: 'config' }))
      expect(error.kind).toBe('not-configured')
      expect(TOOL_ERROR_KINDS).toContain(error.kind)
    })

    it('timeout：预算在复核前就耗尽', async () => {
      const dshHome = await tempDshHome()
      await writeProfile(dshHome, 'web', { bundles: [] })
      const config = configFor(dshHome)
      const tool = createEffectModeTool(depsFor(config, { now: jumpingClock(config.timeoutMs) }))
      const error = expectFail(await run(tool, { change: 'config' }))
      expect(error.kind).toBe('timeout')
    })

    it('timeout：dump-config 传输层超时', async () => {
      const dshHome = await tempDshHome()
      await writeProfile(dshHome, 'web', { bundles: [] })
      const { spawn } = recordingSpawn(() => cmdResult({ code: null, timedOut: true }))
      const tool = createEffectModeTool(depsFor(configFor(dshHome), { spawn }))

      const error = expectFail(await run(tool, { change: 'config' }))
      expect(error.kind).toBe('timeout')
      expect(error.message).toContain('超时')
    })

    it('cancelled：调用方取消', async () => {
      const dshHome = await tempDshHome()
      await writeProfile(dshHome, 'web', { bundles: [] })
      const { spawn } = recordingSpawn(() => cmdResult({ code: null, aborted: true }))
      const tool = createEffectModeTool(depsFor(configFor(dshHome), { spawn }))

      const error = expectFail(await run(tool, { change: 'config' }))
      expect(error.kind).toBe('cancelled')
      expect(error.hint).toContain('不要自动重试')
    })

    it('not-configured：起不了 dsh（ENOENT）', async () => {
      const dshHome = await tempDshHome()
      await writeProfile(dshHome, 'web', { bundles: [] })
      const { spawn } = recordingSpawn(() => cmdResult({ code: null, spawnError: 'spawn: ENOENT' }))
      const tool = createEffectModeTool(depsFor(configFor(dshHome), { spawn }))

      const error = expectFail(await run(tool, { change: 'config' }))
      expect(error.kind).toBe('not-configured')
    })

    it('internal：起不了 dsh 但不是 ENOENT', async () => {
      const dshHome = await tempDshHome()
      await writeProfile(dshHome, 'web', { bundles: [] })
      const { spawn } = recordingSpawn(() => cmdResult({ code: null, spawnError: 'spawn: EACCES' }))
      const tool = createEffectModeTool(depsFor(configFor(dshHome), { spawn }))

      const error = expectFail(await run(tool, { change: 'config' }))
      expect(error.kind).toBe('internal')
    })
  })

  describe('signal 与超时纪律', () => {
    it('exec.signal 原样透传到底层 spawn', async () => {
      const dshHome = await tempDshHome()
      await writeProfile(dshHome, 'web', { bundles: [] })
      const controller = new AbortController()
      const { spawn, calls } = recordingSpawn(() => cmdResult({ stdout: CONFIG_WITH_HMR }))
      const tool = createEffectModeTool(depsFor(configFor(dshHome), { spawn }))

      await run(tool, { change: 'config' }, execWith(controller.signal))
      expect(calls[0]?.signal).toBe(controller.signal)
    })

    it('传输层预算严格小于工具预算（否则宿主先掐，错误退化成裸 TimeoutError）', async () => {
      const dshHome = await tempDshHome()
      await writeProfile(dshHome, 'web', { bundles: [] })
      const { spawn, calls } = recordingSpawn(() => cmdResult({ stdout: CONFIG_WITH_HMR }))
      const config = configFor(dshHome, { timeoutMs: 15_000 })
      const tool = createEffectModeTool(depsFor(config, { spawn }))

      await run(tool, { change: 'config' })
      const transport = calls[0]?.timeoutMs ?? 0
      expect(transport).toBeGreaterThan(0)
      expect(transport).toBeLessThan(config.timeoutMs)
      expect(tool.timeoutMs).toBe(config.timeoutMs)
    })
  })
})
