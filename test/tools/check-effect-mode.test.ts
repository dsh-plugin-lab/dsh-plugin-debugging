/**
 * `dsh_check_effect_mode` 的行为红线。
 *
 * 覆盖任务要求的三类：成功路径、每条可达 `kind`、signal 透传、超时先于工具超时。
 * 「可达 kind」是**穷举**的：`cancelled` / `timeout` / `not-configured`(dsh 起不来) / `internal`。
 * 其中 `internal` 现在只由**防御性断言**产生（`dshHome` 空串 = 契约被违反），
 * 不再是「配置缺失」；`not-running` / `auth` / `not-found` / `command-failed`
 * 不可能出现 —— 这个工具不碰网络、不查文件存在性、不解释子进程退出码。
 */
import { describe, expect, it } from 'vitest'

import {
  createEffectModeTool,
  EFFECT_MODE_TOOL,
  summarizeEffectMode,
} from '../../src/tools/dsh_check_effect_mode.ts'
import { TOOL_ERROR_KINDS } from '../../src/lib/errors.ts'
import { renderToolResultText } from '../../src/lib/render.ts'
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
      // 契约字段：一眼可读的 hmr 结论（模型不该靠 why 反推）。
      expect(data['hmr']).toBe('present')
      expect((data['hmrDetail'] as Record<string, unknown>)['usable']).toBe(true)
      // why 必须点明**触发者在 hmr**，而不是只说「loader 会重读配置」。
      expect(String(data['why'])).toContain('watches the patch files')
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
      // 契约字段 + 自解释的 why：模型必须**直接读到**「没人 watch patch 文件，所以改 config 不会生效」。
      expect(data['hmr']).toBe('absent')
      expect((data['hmrDetail'] as Record<string, unknown>)['usable']).toBe(false)
      expect(String(data['why'])).toContain('nothing watches the patch files')
      // 渲染首行必须把结论摆出来（模型不必从长 JSON 里找）。
      const text = renderToolResultText(EFFECT_MODE_TOOL, { ok: true, data }, summarizeEffectMode)
      expect(text).toContain('mode=restart-required')
      expect(text).toContain('hmr=absent')
      expect(text).toContain('nothing watches the patch files')
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

    it('成功 data 带出生效配置（含 DSH_HOME 来源）', async () => {
      const dshHome = await tempDshHome()
      // profile 目录名必须与配置里的 profile **一致**：否则文件层探不到 hmr，
      // 会退到 dump-config 那条路 —— 那这条断言就变成在测降级，而不是在测「读的是哪个目录」。
      await writeProfile(dshHome, 'tui', { bundles: ['@deepseek-ai/dsh-hmr'] })
      // 声明来源是 default：诊断工具最怕「看着成功其实读错了目录」，来源必须可见。
      const tool = createEffectModeTool(
        depsFor(configFor(dshHome, { dshHomeSource: 'default', profile: 'tui' })),
      )

      const data = expectOk(await run(tool, { change: 'config' }))
      const resolved = data['resolved'] as Record<string, unknown>
      expect(resolved['dshHome']).toBe(dshHome)
      expect(resolved['dshHomeSource']).toBe('default')
      expect(resolved['profile']).toBe('tui')
      // 而且它确实真读了这个目录 —— hmr 是从 profiles/tui 里探到的（不是 dump 出来的）。
      expect(data['mode']).toBe('hot')
      // 本工具不涉及端口：报 not-used，而不是把配置里那个「由工具推断」的 0 当结论。
      expect(resolved['port']).toBe(null)
      expect(resolved['portSource']).toBe('not-used')
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
    it('internal：dshHome 空串是**契约被违反**的防御性断言（不再是 not-configured）', async () => {
      // 兜底补上之后（config → env → <homedir>/.dsh），空串在契约上不可能出现。
      // 所以这条不再是「配置缺失」而是「本插件的 bug」—— kind 必须是 internal，
      // 否则模型会去改配置、重试一个它根本改不动的东西。
      const tool = createEffectModeTool(depsFor(configFor('')))
      const error = expectFail(await run(tool, { change: 'config' }))
      expect(error.kind).toBe('internal')
      expect(error.message).toContain('resolveConfig')
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
