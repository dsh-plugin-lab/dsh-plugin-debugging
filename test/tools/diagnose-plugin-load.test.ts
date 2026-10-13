/**
 * `dsh_diagnose_plugin_load` 的行为红线 + **W1 样板的三处形状断言**。
 *
 * 分两块：
 *
 * 1. **行为**（沿用改造前的断言，按新契约取数）：诊断的两个关键区分 ——
 *    「没在监听」不是本工具的失败；而「entry 文件真的不在」是（组合层会整条丢弃那个插件）。
 *    可达 kind 仍是穷举的：`not-found` / `timeout` / `cancelled` / `internal`。
 *    `internal` 只由**防御性断言**产生（`dshHome` 空串 = 契约被违反）。
 * 2. **形状**（SHAPE §2.1 / §3.1 / §4.1）：四段描述、三层文本、`data` 恰好三键、
 *    `nextStep` 必须带动作、恒定块不许进输出、`audit` 不许进模型文本。
 *    这一块同时是本样板的**自检** —— 它按红线 B16/B17/B18b/B22 的判据在样板自己身上跑一遍。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import {
  createDiagnosePluginLoadTool,
  DIAGNOSE_PLUGIN_LOAD_DESCRIPTION,
  DIAGNOSE_PLUGIN_LOAD_TOOL,
  toBundleKey,
} from '../../src/tools/dsh_diagnose_plugin_load.ts'
import { parseStartupLog } from '../../src/lib/startup-log.ts'
import {
  composeDescription,
  DESCRIPTION_MAX_CHARS,
  DESCRIPTION_MAX_LINES,
} from '../../src/tools/describe.ts'
import { FIBER_STATE } from '../../src/lib/fiber.ts'
import { PORT_LOOKUP_SHELL } from '../../src/lib/ports.ts'
import {
  ensureToolResult,
  TOOL_ERROR_KINDS,
  toolResultProblem,
  type JsonValue,
} from '../../src/lib/errors.ts'
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
  loaderUnavailable,
  loaderWith,
  recordingSpawn,
  run,
  tempDshHome,
  writeInstalledPackage,
  writeProfile,
  writeText,
  withPlatform,
} from './helpers.ts'

/** 一段正常回答端口查询的输出（pid|进程名|启动时间）。 */
const LISTENING_OUTPUT = '4242|node|2026-10-12T20:00:00.0000000+08:00\n'

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
  return {
    ...(lines.find((line) => headPattern.test(line)) === undefined
      ? {}
      : { head: lines.find((line) => headPattern.test(line)) }),
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
 * 实现：把 `a` 按 `min` 宽滑窗，逐个查 `b.includes(window)` —— 只要没有窗口命中，
 * 就不存在 ≥`min` 的共享串（任一更长的共享串必然包含一个命中的窗口）。
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

describe('dsh_diagnose_plugin_load', () => {
  it('工具名与契约一致', () => {
    expect(DIAGNOSE_PLUGIN_LOAD_TOOL).toBe('dsh_diagnose_plugin_load')
  })

  describe('形状：描述层（SHAPE §2.1 冻结）', () => {
    it('四段骨架：合成器与声明一致、行数 ≤4、字符 ≤240', () => {
      const tool = createDiagnosePluginLoadTool(depsFor(configFor('/tmp/nowhere')))
      const description = DIAGNOSE_PLUGIN_LOAD_DESCRIPTION

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

      // ⚠️ `defineTool` 把参数编译成了 JSON schema（`{ type, properties }`），所以要点进
      // `properties` 才看得到每个参数的描述。直接 `Object.values(tool.parameters)` 会拿到
      // `'object'` 字符串与 properties 对象本身 → 每条 `description` 都是 `undefined`
      // → 合计恒为 0 → **判据空转**（SHAPE §10.0 的口 3；活跃坑 18 的形状）。
      const parameters = tool.parameters as {
        properties?: Record<string, { description?: string }>
      }
      const props = parameters.properties ?? {}
      const names = Object.keys(props)
      // 下界：一个参数都没读到 = 注入/取数错了，判据空转，必须判红。
      expect(names.length, '一个参数都没读到 —— 判据空转').toBe(2)
      for (const name of names) {
        expect(props[name]?.description ?? '', `参数 ${name} 的描述是空的`).not.toBe('')
      }
      const total = Object.values(props).reduce(
        (sum, item) => sum + (item.description?.length ?? 0),
        0,
      )
      expect(total).toBeGreaterThan(0)
    })

    it('搬走的恒定知识**只能**在描述层出现一次（旧的两种 caveat 逐字不在输出里）', () => {
      const boundary = DIAGNOSE_PLUGIN_LOAD_DESCRIPTION.boundary ?? ''
      expect(boundary).toContain('startup-*.log exists only on failure')
      expect(boundary).toContain('host-internal')
      // 旧字段名与旧句子都不许再出现在任何一段描述里（它们已不存在于输出层）。
      expect(composeDescription(DIAGNOSE_PLUGIN_LOAD_DESCRIPTION)).not.toContain('loadProofCaveat')
      expect(composeDescription(DIAGNOSE_PLUGIN_LOAD_DESCRIPTION)).not.toContain(
        'Could not observe directly',
      )
    })
  })

  describe('成功路径', () => {
    it('bundles / 安装形态 / 入口三处都查得到（决策字段进 key，明细进 audit）', async () => {
      const dshHome = await tempDshHome()
      const profileDir = await writeProfile(dshHome, 'web', {
        bundles: ['dsh-zhihu-search'],
        dependencies: { 'dsh-zhihu-search': 'link:D:/repo' },
      })
      await writeInstalledPackage(profileDir, 'dsh-zhihu-search')
      const { spawn } = recordingSpawn(() => cmdResult({ stdout: LISTENING_OUTPUT }))
      const tool = createDiagnosePluginLoadTool(depsFor(configFor(dshHome), { spawn }))

      const data = expectOk(await run(tool, {}))
      // 这份诊断的全部结论都建立在「读的是哪个目录」上 —— 来源必须可见（key，会进 L2）。
      const resolved = data.key['resolved'] as Record<string, unknown>
      expect(resolved['profile']).toBe('web')
      expect(resolved['dshHome']).toBe(dshHome)
      expect(resolved['dshHomeSource']).toBe('config')
      // bundles 全列表是复核用的 → audit。
      expect(data.audit['bundles']).toEqual(['dsh-zhihu-search'])
      const pkg = (data.key['packages'] as Record<string, unknown>[])[0]
      expect(pkg?.['inBundles']).toBe(true)
      expect(pkg?.['entryState']).toBe('present')
      expect(pkg?.['artifactNewerThanProcess']).toBeDefined()
      // 安装形态只在 audit 里（人复核用，模型不需要）。
      const audited = (data.audit['packages'] as Record<string, unknown>[])[0]
      expect((audited?.['entry'] as Record<string, unknown>)['entryState']).toBe('present')
      expect((audited?.['install'] as Record<string, unknown>)['packageName']).toBe(
        'dsh-zhihu-search',
      )
    })

    it('默认没有 loader → 降级成 inferred，带上原因（不再是恒定 note 文本）', async () => {
      const dshHome = await tempDshHome()
      const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
      await writeInstalledPackage(profileDir, 'pkg-a')
      const { spawn } = recordingSpawn(() => cmdResult({ stdout: '' }))
      // 不给 loader → 用默认的「没有宿主上下文」实现。
      const tool = createDiagnosePluginLoadTool(depsFor(configFor(dshHome), { spawn }))

      const data = expectOk(await run(tool, {}))
      const observation = data.key['observation'] as Record<string, unknown>
      expect(observation['mode']).toBe('inferred')
      // 降级的原因必须**在本次输出里**（它是观测，不是恒定知识）。
      expect(observation['reason']).toBe('no host context')
      // 恒定解释不许再进输出：`note` 整个字段没了。
      expect(observation['note']).toBeUndefined()
      expect(data.key['packages']).toBeDefined()
      // L1 必须自己说出「这次什么都没观测到」（旧稿说的是 inferred，同义）。
      expect(String(data.verdict)).toContain('nothing here is observed')
      // 降级时不给 per-package 的观测字段 —— 推断的东西不许混进观测字段。
      expect((data.key['packages'] as Record<string, unknown>[])[0]?.['phase']).toBeUndefined()
      expect((data.audit['packages'] as Record<string, unknown>[])[0]?.['observed']).toBeUndefined()
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
      const pkg = (data.audit['packages'] as Record<string, unknown>[])[0]
      expect((pkg?.['install'] as Record<string, unknown>)['linkType']).toBe('link')
    })

    it('没有 startup 日志 = **确定没有**（state=none），知识在描述层不在这里', async () => {
      const dshHome = await tempDshHome()
      const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
      await writeInstalledPackage(profileDir, 'pkg-a')
      const { spawn } = recordingSpawn(() => cmdResult({ stdout: '' }))
      const tool = createDiagnosePluginLoadTool(depsFor(configFor(dshHome), { spawn }))

      const data = expectOk(await run(tool, {}))
      const logs = data.key['startupLogs'] as Record<string, unknown>
      expect(logs['state']).toBe('none')
      expect(logs['paths']).toEqual([])
      // 旧字段（每次调用都逐字重复的说明句）必须消失。
      expect(data.key['startupLogsNote']).toBeUndefined()
      expect(data.audit['startupLogsNote']).toBeUndefined()
    })

    it('有 startup 日志时给出**路径**（下一个决定要用它去读文件）', async () => {
      const dshHome = await tempDshHome()
      const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
      await writeInstalledPackage(profileDir, 'pkg-a')
      const logPath = join(dshHome, 'logs', 'startup-2026-10-12T20-00-00-000Z-abc.log')
      await writeText(logPath, 'boom\n')
      const { spawn } = recordingSpawn(() => cmdResult({ stdout: '' }))
      const tool = createDiagnosePluginLoadTool(depsFor(configFor(dshHome), { spawn }))

      const data = expectOk(await run(tool, {}))
      const logs = data.key['startupLogs'] as Record<string, unknown>
      expect(logs['state']).toBe('present')
      expect(logs['paths']).toEqual([logPath])
      // 全字段在 audit。
      const audited = data.audit['startupLogs'] as Record<string, unknown>
      expect((audited['logs'] as unknown[]).length).toBe(1)
      expect(audited['dirExisted']).toBe(true)
    })

    it('日志目录**读不到** → state=unknown（绝不等于「没有失败日志」）', async () => {
      const dshHome = await tempDshHome()
      const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
      await writeInstalledPackage(profileDir, 'pkg-a')
      // 把 `logs` 造成一个**文件**：readdir 会以 ENOTDIR 失败 —— 那是「未知」，不是「没有」。
      await writeText(join(dshHome, 'logs'), 'not a directory\n')
      const { spawn } = recordingSpawn(() => cmdResult({ stdout: '' }))
      const tool = createDiagnosePluginLoadTool(depsFor(configFor(dshHome), { spawn }))

      const data = expectOk(await run(tool, {}))
      const logs = data.key['startupLogs'] as Record<string, unknown>
      expect(logs['state']).toBe('unknown')
      expect(String(logs['readError'])).not.toBe('')
      // 而且这件事必须**出现在 L2**（模型看不到它就会把「未知」说成「没有」）。
      const text = renderText(tool, {}, await run(tool, {}))
      expect(text).toContain('startupLogs: unknown')
      expect(text).not.toContain('startupLogs: none')
    })

    it('装上但**没进 bundles** → inBundles=false（第一类「装了没生效」）', async () => {
      const dshHome = await tempDshHome()
      const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
      await writeInstalledPackage(profileDir, 'pkg-a')
      await writeInstalledPackage(profileDir, 'pkg-b')
      const { spawn } = recordingSpawn(() => cmdResult({ stdout: '' }))
      const tool = createDiagnosePluginLoadTool(depsFor(configFor(dshHome), { spawn }))

      const data = expectOk(await run(tool, { package: 'pkg-b' }))
      const pkg = (data.key['packages'] as Record<string, unknown>[])[0]
      expect(pkg?.['inBundles']).toBe(false)
    })

    it('**查不到的包** → entryState=unknown，且整次调用仍然成功（缺 A 的回归守卫）', async () => {
      const dshHome = await tempDshHome()
      await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
      // 故意不安装 pkg-a：它既不在 profile 的 node_modules，也不在任何安装锚点下。
      const { spawn } = recordingSpawn(() => cmdResult({ stdout: '' }))
      const tool = createDiagnosePluginLoadTool(depsFor(configFor(dshHome), { spawn }))

      const data = expectOk(await run(tool, {}))
      const pkg = (data.key['packages'] as Record<string, unknown>[])[0]
      // 关键区分：`unknown` 是「这次没查到」，**不是**「文件不在」。
      expect(pkg?.['entryState']).toBe('unknown')
    })

    it('win32：端口上有监听者 → probed=true / listening=true / 拿到 pid 与启动时间', async () => {
      await withPlatform('win32', async () => {
        const dshHome = await tempDshHome()
        const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
        await writeInstalledPackage(profileDir, 'pkg-a')
        const { spawn, calls } = recordingSpawn(() => cmdResult({ stdout: LISTENING_OUTPUT }))
        const tool = createDiagnosePluginLoadTool(
          depsFor(configFor(dshHome, { port: 3080 }), { spawn }),
        )

        const data = expectOk(await run(tool, {}))
        const lookup = (data.audit['port'] as Record<string, unknown>)['lookup'] as Record<
          string,
          unknown
        >
        expect(lookup['probed']).toBe(true)
        expect(lookup['listening']).toBe(true)
        const listeners = lookup['listeners'] as Record<string, unknown>[]
        expect(listeners[0]?.['pid']).toBe(4242)
        expect(listeners[0]?.['processName']).toBe('node')
        // Windows 分支**必须**真的起了那次查询。
        expect(calls).toHaveLength(1)
      })
    })

    it('win32：端口上没有监听者 → probed=true 但 listening=false（不算失败）', async () => {
      await withPlatform('win32', async () => {
        const dshHome = await tempDshHome()
        const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
        await writeInstalledPackage(profileDir, 'pkg-a')
        const { spawn } = recordingSpawn(() => cmdResult({ stdout: '' }))
        const tool = createDiagnosePluginLoadTool(
          depsFor(configFor(dshHome, { port: 3080 }), { spawn }),
        )

        const data = expectOk(await run(tool, {}))
        const lookup = (data.audit['port'] as Record<string, unknown>)['lookup'] as Record<
          string,
          unknown
        >
        expect(lookup['probed']).toBe(true)
        expect(lookup['listening']).toBe(false)
      })
    })

    it('非 win32（CI 就是这一条）：不 spawn、降级成 probed=false，并说明当前平台', async () => {
      await withPlatform('linux', async () => {
        const dshHome = await tempDshHome()
        const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
        await writeInstalledPackage(profileDir, 'pkg-a')
        // 关键断言：即便给了 spawn 实现，非 Windows 上**一次都不许调用** ——
        // 否则等于在 Linux 上试图跑 `powershell.exe`。
        const { spawn, calls } = recordingSpawn(() => cmdResult({ stdout: LISTENING_OUTPUT }))
        const tool = createDiagnosePluginLoadTool(
          depsFor(configFor(dshHome, { port: 3080 }), { spawn }),
        )

        const data = expectOk(await run(tool, {}))
        const lookup = (data.audit['port'] as Record<string, unknown>)['lookup'] as Record<
          string,
          unknown
        >
        expect(lookup['probed']).toBe(false)
        expect(lookup['listening']).toBe(false)
        expect(lookup['listeners']).toEqual([])
        expect(String(lookup['detail'])).toContain('linux')
        expect(calls).toHaveLength(0)

        // 端口值与来源仍然照报（文件层诊断不受平台影响）。
        const resolved = data.key['resolved'] as Record<string, unknown>
        expect(resolved['port']).toBe(3080)
        expect(resolved['portSource']).toBe('plugin-config')
      })
    })

    it('win32：产物比进程新 → artifactNewerThanProcess=true', async () => {
      await withPlatform('win32', async () => {
        const dshHome = await tempDshHome()
        const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
        await writeInstalledPackage(profileDir, 'pkg-a')
        // 进程启动时间设成 2020 年，产物是「现在」写的 → 产物更新。
        const { spawn, calls } = recordingSpawn(() =>
          cmdResult({ stdout: '4242|node|2020-01-01T00:00:00.0000000+08:00\n' }),
        )
        const tool = createDiagnosePluginLoadTool(
          depsFor(configFor(dshHome, { port: 3080 }), { spawn }),
        )

        const data = expectOk(await run(tool, {}))
        const pkg = (data.key['packages'] as Record<string, unknown>[])[0]
        expect(pkg?.['artifactNewerThanProcess']).toBe(true)
        // 这条判据成立的前提就是「那次 spawn 的输出被消费了」。
        expect(calls).toHaveLength(1)
      })
    })

    it('非 win32：同一次 spawn 输出**不被消费** → artifactNewerThanProcess=null（未知，不是 false）', async () => {
      await withPlatform('linux', async () => {
        const dshHome = await tempDshHome()
        const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
        await writeInstalledPackage(profileDir, 'pkg-a')
        const { spawn, calls } = recordingSpawn(() =>
          cmdResult({ stdout: '4242|node|2020-01-01T00:00:00.0000000+08:00\n' }),
        )
        const tool = createDiagnosePluginLoadTool(
          depsFor(configFor(dshHome, { port: 3080 }), { spawn }),
        )

        const data = expectOk(await run(tool, {}))
        const pkg = (data.key['packages'] as Record<string, unknown>[])[0]
        // 关键区分：`null` = **判不了**（拿不到进程启动时间），不是 `false` = 「产物不比进程新」。
        // 把未知报成 false 会在非 Windows 上给出**反向结论**。
        expect(pkg?.['artifactNewerThanProcess']).toBeNull()
        expect(calls).toHaveLength(0)
      })
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
      expect((data.key['packages'] as unknown[]).length).toBe(1)
      expect((data.key['packages'] as Record<string, unknown>[])[0]?.['inBundles']).toBe(false)
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
      expect((data.key['observation'] as Record<string, unknown>)['mode']).toBe('observed')
      const pkg = (data.key['packages'] as Record<string, unknown>[])[0]
      expect(pkg?.['phase']).toBe('failed')
      expect(pkg?.['error']).toBe('failed to import')
      expect(String(data.verdict)).toContain('Observed load failure')
    })

    it('apply 失败（state=3）→ observed failed，带上失败原因', async () => {
      const { tool } = await observedFixture(
        entrySnapshot({ moduleName: 'pkg-a', fiberState: FIBER_STATE.FAILED, fiberError: 'boom' }),
      )

      const data = expectOk(await run(tool, {}))
      const pkg = (data.key['packages'] as Record<string, unknown>[])[0]
      expect(pkg?.['phase']).toBe('failed')
      expect(pkg?.['error']).toBe('boom')
      // `fiberState` 是解释性细节 → audit。
      const audited = (data.audit['packages'] as Record<string, unknown>[])[0]
      const observed = audited?.['observed'] as Record<string, unknown>
      expect(observed['fiberState']).toBe(3)
      expect(String(observed['basis'])).not.toBe('')
    })

    it('pending（state=0）→ observed pending，缺哪些 service 在 audit、结论在 L1', async () => {
      const { tool } = await observedFixture(
        entrySnapshot({
          moduleName: 'pkg-a',
          fiberState: FIBER_STATE.PENDING,
          inject: ['tools', 'fs'],
          presentServices: ['tools'],
        }),
      )

      const data = expectOk(await run(tool, {}))
      const pkg = (data.key['packages'] as Record<string, unknown>[])[0]
      expect(pkg?.['phase']).toBe('pending')
      const audited = (data.audit['packages'] as Record<string, unknown>[])[0]
      expect((audited?.['observed'] as Record<string, unknown>)['missingInject']).toEqual(['fs'])
      expect(String(data.verdict)).toContain('Still pending')
    })

    it('active（state=2）→ 结论是「确实加载成功了」，且**没有** nextStep（没有动作可做）', async () => {
      const { tool } = await observedFixture(
        entrySnapshot({ moduleName: 'pkg-a', fiberState: FIBER_STATE.ACTIVE }),
      )

      const result = await run(tool, {})
      const data = expectOk(result)
      const pkg = (data.key['packages'] as Record<string, unknown>[])[0]
      expect(pkg?.['phase']).toBe('active')
      expect(String(data.verdict)).toContain('really did load')
      // 「没有动作就不出现」：全 active 时 nextStep 必须缺省，而不是印一句结论。
      expect(result.nextStep).toBeUndefined()
    })

    it('装了但树里一行都没有 → 硬证据：组合层没有它（下一步给 dsh_dump_config）', async () => {
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

      const result = await run(tool, {})
      const data = expectOk(result)
      const pkg = (data.key['packages'] as Record<string, unknown>[])[0]
      expect(pkg?.['matchedEntryIds']).toEqual([])
      expect(String(pkg?.['error'])).toContain('no row in the Loader tree')
      expect(String(data.verdict)).toContain('absent from the Loader tree')
      // nextStep 必须带动作 —— 这里指向 dsh_dump_config，且带着 profile。
      // 「不在树里」的是 bundles 里那个包（pkg-a），不是树里那个别的行。
      expect(result.nextStep).toEqual({
        tool: 'dsh_dump_config',
        args: { profile: 'web' },
        why: expect.stringContaining('pkg-a'),
      })
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
      const pkg = (data.key['packages'] as Record<string, unknown>[])[0]
      expect(pkg?.['phase']).toBe('failed')
      expect(pkg?.['matchedEntryIds']).toEqual(['a1', 'a2'])
    })

    it('观测模式给出 entry 总数与相位直方图（判断快照是否已稳定）', async () => {
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
      const observation = data.key['observation'] as Record<string, unknown>
      expect(observation['entryCount']).toBe(3)
      expect(observation['phaseHistogram']).toEqual({ active: 1, failed: 2 })
    })
  })

  describe('错误路径（每条可达 kind）', () => {
    it('internal：dshHome 空串是**契约被违反**的防御性断言（不再是 not-configured）', async () => {
      // 本工具**不**起 dsh 子进程，所以它没有别的 not-configured 来源：
      // 兜底补上之后（config → env → <homedir>/.dsh），空串只可能是本插件的 bug。
      const tool = createDiagnosePluginLoadTool(depsFor(configFor('')))
      const failure = expectFail(await run(tool, {}))
      expect(failure.kind).toBe('internal')
      expect(failure.message).toContain('ResolvedConfig')
      expect(TOOL_ERROR_KINDS).toContain(failure.kind)
      // 失败分支也有 L1（§4.1 约定 1）。
      expect(failure.data.verdict).not.toBe('')
      // 没有动作可做 → nextStep 不出现（而不是把结论复述一遍）。
      expect(failure.nextStep).toBeUndefined()
    })

    it('timeout：预算在开工前已耗尽，且 nextStep 带工具与参数', async () => {
      const dshHome = await tempDshHome()
      const config = configFor(dshHome)
      const tool = createDiagnosePluginLoadTool(
        depsFor(config, { now: jumpingClock(config.timeoutMs) }),
      )
      const failure = expectFail(await run(tool, { package: 'pkg-a' }))
      expect(failure.kind).toBe('timeout')
      expect(failure.nextStep).toEqual({
        tool: DIAGNOSE_PLUGIN_LOAD_TOOL,
        args: { package: 'pkg-a' },
        why: expect.stringContaining('retry'),
      })
      // 失败分支的 key 仍然存在（形状同成功分支），只是这次什么都没看到。
      expect(failure.data.key['packages']).toEqual([])
    })

    it('cancelled：调用方在进入前就取消（与平台无关的取消路径）', async () => {
      const dshHome = await tempDshHome()
      const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
      await writeInstalledPackage(profileDir, 'pkg-a')
      const controller = new AbortController()
      controller.abort()
      const { spawn } = recordingSpawn(() => cmdResult({ stdout: '' }))
      const tool = createDiagnosePluginLoadTool(
        depsFor(configFor(dshHome, { port: 3080 }), { spawn }),
      )

      // 这条**不依赖端口查询**：进入前已取消，工具在读完文件后必须报 cancelled。
      // 第一版把它建在「端口查询中途 abort」上，于是非 Windows（CI）上 spawn 压根不被调用
      // —— 取消没发生、工具返回成功，测试红在平台差异而不是被测行为上。
      const failure = expectFail(await run(tool, {}, execWith(controller.signal)))
      expect(failure.kind).toBe('cancelled')
      expect(failure.nextStep).toEqual({ manual: true, why: expect.stringContaining('caller') })
    })

    it('win32：调用方在端口查询中途取消也能到达 IO 层', async () => {
      await withPlatform('win32', async () => {
        const dshHome = await tempDshHome()
        const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
        await writeInstalledPackage(profileDir, 'pkg-a')
        const controller = new AbortController()
        const { spawn, calls } = recordingSpawn(() => {
          controller.abort()
          return cmdResult({ stdout: '' })
        })
        const tool = createDiagnosePluginLoadTool(
          depsFor(configFor(dshHome, { port: 3080 }), { spawn }),
        )

        const failure = expectFail(await run(tool, {}, execWith(controller.signal)))
        expect(failure.kind).toBe('cancelled')
        // 而且确实把调用方的信号交给了那次端口查询。
        expect(calls).toHaveLength(1)
        expect(calls[0]?.signal).toBe(controller.signal)
      })
    })

    it('not-found：profile 的 package.json 读不到（L2 必须印出找的是哪个目录）', async () => {
      const dshHome = await tempDshHome()
      const tool = createDiagnosePluginLoadTool(depsFor(configFor(dshHome)))
      const failure = expectFail(await run(tool, {}))
      expect(failure.kind).toBe('not-found')
      const resolved = failure.data.key['resolved'] as Record<string, unknown>
      expect(String(resolved['profileDir'])).toContain(join(dshHome, 'profiles', 'web'))
      // 下一步是可分派的：dsh_dump_config 带着 profile（它的值也出现在 L2 的 resolved 行里）。
      expect(failure.nextStep).toEqual({
        tool: 'dsh_dump_config',
        args: { profile: 'web' },
        why: expect.any(String),
      })
    })

    it('not-found：entry 文件**真的不在**（entryState=missing，组合层会整条丢弃该插件）', async () => {
      const dshHome = await tempDshHome()
      const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
      await writeInstalledPackage(profileDir, 'pkg-a', { writeEntryFile: false })
      const { spawn } = recordingSpawn(() => cmdResult({ stdout: '' }))
      const tool = createDiagnosePluginLoadTool(depsFor(configFor(dshHome), { spawn }))

      const failure = expectFail(await run(tool, {}))
      expect(failure.kind).toBe('not-found')
      expect(failure.message).toContain('pkg-a')
      const pkg = (failure.data.key['packages'] as Record<string, unknown>[])[0]
      expect(pkg?.['entryState']).toBe('missing')
      expect(failure.nextStep).toEqual({ manual: true, why: expect.stringContaining('pkg-a') })
    })
  })

  describe('signal 与超时纪律', () => {
    it('win32：exec.signal 原样透传给端口查询的 spawn', async () => {
      await withPlatform('win32', async () => {
        const dshHome = await tempDshHome()
        const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
        await writeInstalledPackage(profileDir, 'pkg-a')
        const controller = new AbortController()
        const { spawn, calls } = recordingSpawn(() => cmdResult({ stdout: '' }))
        const tool = createDiagnosePluginLoadTool(
          depsFor(configFor(dshHome, { port: 3080 }), { spawn }),
        )

        await run(tool, {}, execWith(controller.signal))
        expect(calls).toHaveLength(1)
        expect(calls[0]?.signal).toBe(controller.signal)
      })
    })

    it('win32：端口查询的传输预算小于工具预算', async () => {
      await withPlatform('win32', async () => {
        const dshHome = await tempDshHome()
        const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
        await writeInstalledPackage(profileDir, 'pkg-a')
        const config = configFor(dshHome, { port: 3080, timeoutMs: 15_000 })
        const { spawn, calls } = recordingSpawn(() => cmdResult({ stdout: '' }))
        const tool = createDiagnosePluginLoadTool(depsFor(config, { spawn }))

        await run(tool, {})
        expect(calls).toHaveLength(1)
        expect(calls[0]?.timeoutMs ?? 0).toBeLessThan(config.timeoutMs)
        expect(calls[0]?.timeoutMs ?? 0).toBeGreaterThan(0)
        expect(tool.timeoutMs).toBe(config.timeoutMs)
      })
    })

    it('win32：端口按 LocalPort 查，不用命令行子串（子串会误匹配派生 shell）', async () => {
      await withPlatform('win32', async () => {
        const dshHome = await tempDshHome()
        const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
        await writeInstalledPackage(profileDir, 'pkg-a')
        const { spawn, calls } = recordingSpawn(() => cmdResult({ stdout: '' }))
        const tool = createDiagnosePluginLoadTool(
          depsFor(configFor(dshHome, { port: 3080 }), { spawn }),
        )

        await run(tool, {})
        expect(calls).toHaveLength(1)
        const script = calls[0]?.args.join(' ') ?? ''
        expect(script).toContain('-LocalPort 3080')
        expect(script).toContain('-State Listen')
        expect(script).not.toContain('bin.js')
        // 也钉住用的是哪个 shell —— Windows 专有路径，非 Windows 上根本不该走到这儿。
        expect(calls[0]?.command).toBe(PORT_LOOKUP_SHELL)
      })
    })
  })

  describe('形状：三层文本与 data（§3.1 / §4.1）', () => {
    /** 造一份「有 loader、包 active」的成功 fixture。 */
    async function activeFixture(): Promise<ToolDefinition> {
      const dshHome = await tempDshHome()
      const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
      await writeInstalledPackage(profileDir, 'pkg-a')
      const { spawn } = recordingSpawn(() => cmdResult({ stdout: '' }))
      return createDiagnosePluginLoadTool(
        depsFor(configFor(dshHome), {
          spawn,
          loader: loaderWith([entrySnapshot({ moduleName: 'pkg-a', fiberState: 2 })]),
        }),
      )
    }

    it('`data` 顶层**恰好**三键：成功与失败都同形（B21）', async () => {
      const tool = await activeFixture()
      const success = await run(tool, {})
      expect(success.ok).toBe(true)
      if (!success.ok) throw new Error('期望成功')
      expect(Object.keys(success.data).sort()).toEqual(['audit', 'key', 'verdict'])
      expect(toolResultProblem(success)).toBeUndefined()

      const failed = await run(tool, { package: 'ghost-package' })
      expect(failed.ok).toBe(true)
      // 真正的失败分支：profile 读不到。
      const broken = createDiagnosePluginLoadTool(depsFor(configFor(await tempDshHome())))
      const failure = await run(broken, {})
      expect(failure.ok).toBe(false)
      if (failure.ok) throw new Error('期望失败')
      expect(Object.keys(failure.data).sort()).toEqual(['audit', 'key', 'verdict'])
      expect(toolResultProblem(failure)).toBeUndefined()
    })

    it('模型文本只有 头行 / verdict / L2 / nextStep —— 没有整块 JSON，也没有 audit（B22）', async () => {
      const tool = await activeFixture()
      const result = await run(tool, {})
      const text = renderText(tool, {}, result)
      const parts = splitRender(text)

      expect(parts.head).toBe(`[${DIAGNOSE_PLUGIN_LOAD_TOOL}] ok`)
      expect(parts.verdict).not.toBeUndefined()
      // L2 至少要有「读了哪份配置」与每包一行。
      expect(parts.l2.length).toBeGreaterThan(0)
      expect(parts.l2.some((line) => line.startsWith('resolved:'))).toBe(true)
      expect(parts.l2.some((line) => line.startsWith('pkg-a:'))).toBe(true)
      // 不再有 pretty JSON（两空格缩进的块）。
      expect(text).not.toContain('\n  "')

      // 哨兵自检：把哨兵埋进 `audit` 深处，渲染结果里**一个字符都不许出现**。
      const sentinel = 'SENTINEL_B22_9f3a1c'
      // 转成 `unknown` 再转记录：`ToolResult` 是 interface（不带隐式索引签名），
      // 直接转会被 TS 判成「两者不重叠」。
      const raw = result as unknown as { data?: Record<string, unknown> }
      const patched = {
        ...(result as unknown as Record<string, unknown>),
        data: { ...(raw.data ?? {}), audit: { port: { lookup: { detail: sentinel } } } },
      }
      const patchedText = renderText(tool, {}, patched)
      expect(patchedText).toContain('verdict:') // 渲染确实跑了
      expect(patchedText).not.toContain(sentinel)
    })

    it('L1 逐字来自 `data.verdict`，且 `nextStep.why` 不许等于它（B18b）', async () => {
      const tool = await activeFixture()
      const result = await run(tool, {})
      const text = renderText(tool, {}, result)
      const parts = splitRender(text)
      const data = (result as { data: { verdict: string } }).data
      expect(parts.verdict).toBe(data.verdict)
      if (parts.l3 !== undefined) expect(parts.l3).not.toBe(parts.verdict)
    })

    it('`nextStep` 出现时**必须带动作**（B18a）：这里走 manual 支', async () => {
      const dshHome = await tempDshHome()
      const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
      await writeInstalledPackage(profileDir, 'pkg-a', { writeEntryFile: false })
      const { spawn } = recordingSpawn(() => cmdResult({ stdout: '' }))
      const tool = createDiagnosePluginLoadTool(depsFor(configFor(dshHome), { spawn }))

      const result = await run(tool, {})
      expect(result.nextStep).toBeDefined()
      const step = result.nextStep as { tool?: string; manual?: boolean; why: string }
      const hasTool = typeof step.tool === 'string' && step.tool !== ''
      const hasManual = step.manual === true
      expect(hasTool !== hasManual).toBe(true) // 两支恰有其一
      // manual 支在文本里不印空括号。
      const text = renderText(tool, {}, result)
      const parts = splitRender(text)
      expect(parts.l3).not.toBe('')
      expect(parts.l3?.startsWith('(')).toBe(false)
      expect(text).not.toContain('nextStep: — ')
    })

    it('B16 自检：两份 fixture 的 `verdict:` + L2 行里**没有**共同的 ≥40 字符行', async () => {
      // ⚠️ **两份 fixture 必须同时改「输入」与「环境」**：B16 要抓的是「输入与环境都变了、
      // 这一行却还逐字不变」= 真恒定块；而 `resolved:` 这类行是按**环境**恒定、不按输入恒定的。
      // 所以两份 fixture 各用一份**不同的临时 home**（`activeFixture()` 自己一份、下面再取
      // 一份）—— 这是 B16 的判据要求，不是随便挑的两份 fixture。Lead 2026-10-13 已把这条
      // 写进 SHAPE §3.1 规则 5 与 §10 的 B16 行；两份 fixture 共用同一个临时 home 时，
      // `resolved:` 行必然逐字相同 → B16 假红。
      const active = await activeFixture()
      const activeResult = await run(active, {})

      const dshHome = await tempDshHome()
      const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
      await writeInstalledPackage(profileDir, 'pkg-a')
      const { spawn } = recordingSpawn(() => cmdResult({ stdout: '' }))
      const failed = createDiagnosePluginLoadTool(
        depsFor(configFor(dshHome), {
          spawn,
          loader: loaderWith([entrySnapshot({ moduleName: 'pkg-a', hasFiber: false })]),
        }),
      )
      const failedResult = await run(failed, {})

      const candidates = (tool: ToolDefinition, value: unknown): string[] => {
        const parts = splitRender(renderText(tool, {}, value))
        return [parts.verdict ?? '', ...parts.l2].filter((line) => line.length >= 40)
      }
      const first = candidates(active, activeResult)
      const second = candidates(failed, failedResult)

      // 下界：两份 fixture 都必须真的吐出候选行，否则「交集为空」是空转。
      expect(first.length, '第一份 fixture 一条 ≥40 字符的行都没有 —— 判据空转').toBeGreaterThan(0)
      expect(second.length, '第二份 fixture 一条 ≥40 字符的行都没有 —— 判据空转').toBeGreaterThan(0)
      // 两份的 L1 必须不同（相同会让 B16 自己误红）。
      expect(splitRender(renderText(active, {}, activeResult)).verdict).not.toBe(
        splitRender(renderText(failed, {}, failedResult)).verdict,
      )
      const shared = first.filter((line) => second.includes(line))
      expect(shared, `两份 fixture 共有的恒定行：${shared.join(' | ')}`).toEqual([])
    })

    it('产物比进程新（无别的症状）→ 下一步是**可派发**的 dsh_check_effect_mode', async () => {
      await withPlatform('win32', async () => {
        const dshHome = await tempDshHome()
        const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
        await writeInstalledPackage(profileDir, 'pkg-a')
        // 进程启动时间设成 2020 → 产物比进程新。
        const { spawn } = recordingSpawn(() =>
          cmdResult({ stdout: '4242|node|2020-01-01T00:00:00.0000000+08:00\n' }),
        )
        const tool = createDiagnosePluginLoadTool(
          depsFor(configFor(dshHome, { port: 3080 }), {
            spawn,
            loader: loaderWith([entrySnapshot({ moduleName: 'pkg-a', fiberState: 2 })]),
          }),
        )

        const result = await run(tool, {})
        const data = expectOk(result)
        expect(String(data.verdict)).toContain('artifacts are newer than the process')
        // 这一支**有工具可派**，所以不许退回 `manual`（Lead 2026-10-13 裁决）：
        // `change: 'host-code'` 是目标工具自己的封闭枚举，不必出现在本次输出里。
        expect(result.nextStep).toEqual({
          tool: 'dsh_check_effect_mode',
          args: { change: 'host-code' },
          why: expect.stringContaining('pkg-a'),
        })
        // B18b：L3 正文不许逐字等于 L1 正文。
        const parts = splitRender(renderText(tool, {}, result))
        expect(parts.l3).not.toBe(parts.verdict)
      })
    })

    it('B17 自检：`nextStep.args` 的每个值都出现在 `verdict:` 行或 L2 行里', async () => {
      // 注：B17 的取值面含「目标工具自己的描述/参数文本」（Lead 裁决扩的），所以枚举值
      // （如 `change: 'host-code'`）**不必**出现在本次输出里；本用例挑的是标识符那一类
      // —— `dsh_dump_config` 的 `args.profile` 必须真的印在 L2 的 `resolved:` 行里。
      const dshHome = await tempDshHome()
      const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
      await writeInstalledPackage(profileDir, 'pkg-a')
      const { spawn } = recordingSpawn(() => cmdResult({ stdout: '' }))
      const tool = createDiagnosePluginLoadTool(
        depsFor(configFor(dshHome), {
          spawn,
          loader: loaderWith([entrySnapshot({ moduleName: 'other-pkg', fiberState: 2 })]),
        }),
      )

      const result = await run(tool, {})
      const step = result.nextStep as { tool?: string; args?: Record<string, unknown> } | undefined
      expect(step?.tool).toBe('dsh_dump_config')
      const parts = splitRender(renderText(tool, {}, result))
      const haystack = [parts.verdict ?? '', ...parts.l2].join('\n')
      const values = Object.values(step?.args ?? {}).filter(
        (value) =>
          value !== null && value !== true && value !== false && value !== 0 && value !== '',
      )
      expect(values.length, 'args 全被例外表排掉了 —— 判据空转').toBeGreaterThan(0)
      for (const value of values) expect(haystack).toContain(String(value))
    })

    it('B20b 自检：描述与该工具的输出之间没有 ≥40 字符的共享串', async () => {
      const tool = await activeFixture()
      const text = renderText(tool, {}, await run(tool, {}))
      const shared = sharedSubstrings(
        composeDescription(DIAGNOSE_PLUGIN_LOAD_DESCRIPTION),
        text,
        40,
      )
      expect(shared, `描述里逐字抄了输出：${shared.join(' | ')}`).toEqual([])
    })

    it('渲染永远有输出：形状不合法的值退化成一行，不抛', async () => {
      const tool = await activeFixture()
      const text = renderText(tool, {}, { nonsense: true })
      expect(text).toBe(`[${DIAGNOSE_PLUGIN_LOAD_TOOL}] {"nonsense":true}`)
    })

    it('守卫合成的兜底（`key` 是 `{}`）必须可渲染，且降级值看得出来', async () => {
      const tool = await activeFixture()

      // 造一个**形状非法**的返回值（`data.verdict` 是空串）→ 守卫合成兜底（`key: {}`）。
      const malformed = { ok: true, data: { verdict: '', key: {}, audit: {} } }
      const fallback = ensureToolResult(malformed)

      // ⚠️ 下界（活跃坑 18 / 37）：自证这**真的是**兜底 —— 幂等（它自己过了守卫），
      // 且**不等于**输入（输入被换掉了）。否则下面「渲染它当然不抛」是恒真的。
      expect(fallback, '守卫没换掉这个值 —— 下面测的就不是兜底路径').not.toBe(malformed)
      expect(ensureToolResult(fallback), '兜底自己没过守卫').toBe(fallback)
      expect(fallback.ok).toBe(false)

      // 渲染层**绝不抛**（`render.ts` §3.1）：兜底里 `packages` 整块缺席，
      // 直接 `for…of` 会当场抛。
      let text = ''
      expect(() => {
        text = renderText(tool, {}, fallback)
      }, '守卫合成的兜底把渲染层打崩了').not.toThrow()
      expect(text).toContain('verdict:')
      expect(text).toContain('resolved: unknown (the guard synthesized this result)')
      // 「不知道」不许印成「一个包都没有」。
      expect(text).toContain('packages: unknown (the guard synthesized this result)')
    })
  })

  describe('三值不许压成两值（缺 A 与活跃坑 18 的回归守卫）', () => {
    it('inferred 模式下 `reason` 短于 40 字符（它每次调用都同值，长句会被 B16 判成恒定块）', async () => {
      const dshHome = await tempDshHome()
      const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
      await writeInstalledPackage(profileDir, 'pkg-a')
      const { spawn } = recordingSpawn(() => cmdResult({ stdout: '' }))
      const tool = createDiagnosePluginLoadTool(
        depsFor(configFor(dshHome), { spawn, loader: loaderUnavailable() }),
      )

      const data = expectOk(await run(tool, {}))
      const observation = data.key['observation'] as Record<string, unknown>
      expect(String(observation['reason']).length).toBeLessThan(40)
      const text = renderText(tool, {}, await run(tool, {}))
      expect(text).toContain('reason: no host context')
    })
  })

  // ══════════════════════════════════════════════════════════════════════════
  // A · 启动日志解析（task-44 的主要交付）
  //
  // 真源是 `util.inspect` 的输出、**不是 JSON**，所以只能行导向解析。`REAL_STARTUP_LOG`
  // 是**本机那份真机日志**（2026-09-30 03:03 +08 写、`dshVersion: 0.2.0-rc.1`）的逐字
  // 拷贝，只把家目录名替换成了 `user`。实测锚点：headline=2 / Failed=1 / waiting=11 /
  // entries=12 —— **2 ≠ 1**，headline 的 2 是「未激活的 required 条目」数，不是失败个数。
  // ══════════════════════════════════════════════════════════════════════════

  /** 一份「结构合法、但真的没有失败条目」的最小日志（用来钉住与「解析失败」的可分性）。 */
  const LOG_WITHOUT_FAILED = String.raw`{
  timestamp: '2026-01-01T00:00:00.000Z',
  dshVersion: '0.0.0',
  nodeVersion: 'v24.0.0',
  platform: 'win32',
  arch: 'x64',
  profile: 'web',
  error: StartupError: dsh: startup failed: 1 required plugin did not activate
  
  Plugins waiting for services (1):
    Plugin                 Missing services
    connection (required)  webRuntime
    [entries]: [
      {
        id: 'connection',
        module: '@deepseek-ai/dsh-client-connection',
        required: true,
        fiberState: 0,
        outcome: { kind: 'pending', missing: [ 'webRuntime', [length]: 1 ] }
      },
      [length]: 1
    ]
  }
}`

  /**
   * 这份日志「**红**」了没有。
   *
   * 判据是**任一**：整体解析失败（`ok=false`），或认出来了但有缺口（`gaps` 非空）。
   * 两者都必须可见 —— 只判 `ok` 会让「某段标题被改掉」静默丢信息（活跃坑 18）。
   *
   * @param text 日志内容。
   */
  function isRed(text: string): boolean {
    const { parse } = parseStartupLog(text)
    return !parse.ok || parse.gaps.length > 0
  }

  describe('A1 · 解析器（纯函数，真机样本）', () => {
    it('实测锚点：headline=2 / Failed=1 / waiting=11 / entries=12，且 2≠1', () => {
      const { parse, report } = parseStartupLog(REAL_STARTUP_LOG)
      expect(parse.ok).toBe(true)
      expect(parse.gaps).toEqual([])
      expect(parse.truncated).toBeUndefined()
      expect(report.headline).toBe('startup failed: 2 required plugins did not activate')
      expect(report.requiredNotActivated).toBe(2)
      expect(report.failed).toHaveLength(1)
      expect(report.pending).toHaveLength(11)
      expect(report.entries).toHaveLength(12)
      expect(parse.sections).toEqual([
        'header',
        'failed',
        'pending',
        'entries',
        'startup',
        'messages',
      ])
      // **关键区分**：headline 的 2 是 required 未激活数，不是失败插件个数。
      expect(report.failed.length).not.toBe(report.requiredNotActivated)
    })

    it('失败条目：id / 包名 / 原因都取到了（`error` 是唯一能导向「端口被占」的原料）', () => {
      const { report } = parseStartupLog(REAL_STARTUP_LOG)
      const failed = report.failed[0]
      expect(failed?.id).toBe('webserver')
      expect(failed?.required).toBe(true)
      expect(failed?.module).toBe('@deepseek-ai/dsh-host-webserver')
      expect(failed?.error).toBe('listen EADDRINUSE: address already in use 127.0.0.1:19388')
      // 续行块（栈）留给人工复核。
      expect(String(failed?.stack)).toContain('at Server.setupListenHandle')
    })

    it('等待表：11 条、表头不算一条、`(required)` 与多值 missing 都对', () => {
      const { report } = parseStartupLog(REAL_STARTUP_LOG)
      // 表头行绝不能被当成一条 —— 否则永远差 1（假红）。
      expect(report.pending.some((item) => item.id === 'Plugin')).toBe(false)
      const connection = report.pending.find((item) => item.id === 'connection')
      expect(connection?.required).toBe(true)
      expect(connection?.missing).toEqual(['webRuntime'])
      expect(report.pending.find((item) => item.id === 'open-in-app')?.missing).toEqual([
        'webServer',
        'connection',
      ])
      // 右列是字面量 `unknown` 时不是「缺一个叫 unknown 的服务」。
      const unknownRow = parseStartupLog(
        REAL_STARTUP_LOG.replace(
          '    connection (required)  webRuntime',
          '    connection (required)  unknown',
        ),
      )
      const row = unknownRow.report.pending.find((item) => item.id === 'connection')
      expect(row?.missing).toEqual([])
      expect(row?.missingUnknown).toBe(true)
    })

    it('`[entries]` 块：12 条、带 module（等待表没有的信息）、失败条目带 hasError', () => {
      const { report } = parseStartupLog(REAL_STARTUP_LOG)
      expect(report.entries).toHaveLength(12)
      const webserver = report.entries.find((item) => item.id === 'webserver')
      expect(webserver?.module).toBe('@deepseek-ai/dsh-host-webserver')
      expect(webserver?.required).toBe(true)
      expect(webserver?.kind).toBe('failed')
      expect(webserver?.hasError).toBe(true)
      expect(webserver?.fiberState).toBe(3)
      const connection = report.entries.find((item) => item.id === 'connection')
      expect(connection?.kind).toBe('pending')
      expect(connection?.missing).toEqual(['webRuntime'])
    })

    it('header / `[startup]`：profile、版本、configurationPath（还原转义）、组合期消息', () => {
      const { report } = parseStartupLog(REAL_STARTUP_LOG)
      expect(report.profile).toBe('web')
      expect(report.dshVersion).toBe('0.2.0-rc.1')
      expect(report.platform).toBe('win32')
      expect(report.arch).toBe('x64')
      // inspect 把反斜杠写成 `\\`，必须还原成单反斜杠（否则路径没法用）。
      const configurationPath = String(report.configurationPath)
      expect(configurationPath).toContain('cordis.yml')
      expect(configurationPath).toContain('\\')
      expect(configurationPath).not.toContain('\\\\')
      // `[length]: 5` 是伪字段，不是第 5 条消息。
      expect(report.messages).toHaveLength(5)
      expect(report.messages.map((item) => item.type)).toContain('warn')
      // Error 形态的 `args[0]`：取 `Error: ` 之后的第一行。
      expect(report.messages.some((item) => item.text === 'HMR is disposed')).toBe(true)
      // 字符串形态原样。
      expect(
        report.messages.some(
          (item) => item.name === 'hmr' && item.text === 'config reload at %C failed',
        ),
      ).toBe(true)
    })

    it('解析失败 → `parse.ok=false`（判红），且与「真的没有失败条目」**可分**', () => {
      // 结尾是 `}`（所以**不是**截断），但里面一个锚点都没有。
      const broken = parseStartupLog('{ nothingRecognisable: true }\n')
      expect(broken.parse.ok).toBe(false)
      expect(String(broken.parse.reason)).toContain('none of the known sections')
      expect(broken.report.failed).toEqual([])

      // 反面对照：结构合法、真的没有失败条目 → ok=true 且没有缺口。
      const clean = parseStartupLog(LOG_WITHOUT_FAILED)
      expect(clean.parse.ok).toBe(true)
      expect(clean.parse.gaps).toEqual([])
      expect(clean.report.failed).toEqual([])
      // 这两件事在 JSON 里可分（ok 不同）—— 压成一个值就是活跃坑 18。
      expect(broken.parse.ok).not.toBe(clean.parse.ok)
    })

    it('截断：结尾不是 `}` 只标 truncated，**不**当成解析失败', () => {
      const truncated = parseStartupLog(REAL_STARTUP_LOG.slice(0, 400))
      expect(truncated.parse.ok).toBe(true)
      expect(truncated.parse.truncated).toBe(true)
    })

    it('部分解析：`Failed plugins (N)` 的 N 与实取条数不符 → `gaps` 里必须有一条', () => {
      const tampered = REAL_STARTUP_LOG.replace('Failed plugins (1):', 'Failed plugins (2):')
      const { parse } = parseStartupLog(tampered)
      expect(parse.ok).toBe(true)
      expect(parse.gaps.join(' ')).toContain('failed-count')
      expect(parse.gaps.join(' ')).toContain('declared 2, parsed 1')
    })

    it('`[length]: N` 与实取条数不符 → `gaps` 里必须有一条（它是断言，不是字段）', () => {
      const tampered = REAL_STARTUP_LOG.replace('      [length]: 12', '      [length]: 99')
      const { parse } = parseStartupLog(tampered)
      expect(parse.gaps.join(' ')).toContain('entries-count')
      expect(parse.gaps.join(' ')).toContain('declared 99, parsed 12')
    })

    it('**把任一段的标题改掉都必须可见**（四条护栏，堵「标题一改就静默丢段」）', () => {
      // 未动过的样本不能是红的 —— 否则下面四条是空转（SHAPE §10.0）。
      expect(isRed(REAL_STARTUP_LOG), '样本自己就是红的 —— 判据空转').toBe(false)
      const tampered: Record<string, string> = {
        // headline 只在**活的那一行**上认 —— `error.message` 的转义副本里也有这句话，
        // 认副本会让这一条静默通过（第一版就踩到了，所以它单独有一条断言）。
        headline: REAL_STARTUP_LOG.replace(
          'startup failed: 2 required plugins did not activate',
          'startup problem: 2 required plugins did not activate',
        ),
        failed: REAL_STARTUP_LOG.replace('Failed plugins (1):', 'Failed plugins list (1):'),
        pending: REAL_STARTUP_LOG.replace(
          'Plugins waiting for services (11):',
          'Plugins awaiting services (11):',
        ),
        entries: REAL_STARTUP_LOG.replace('    [entries]: [', '    [entries] list: ['),
      }
      for (const [name, text] of Object.entries(tampered)) {
        expect(text, `${name}: 替换没生效 —— 判据空转`).not.toBe(REAL_STARTUP_LOG)
        expect(isRed(text), `${name}: 段被改掉后居然还是绿的（静默丢信息）`).toBe(true)
      }
    })
  })

  describe('A2 · 工具投影（解析结论进 key，别读成「没有失败」）', () => {
    /** 造一个「有一份日志」的诊断 fixture。 */
    async function logFixture(
      content: string,
      name = 'startup-2026-01-01T00-00-00-000Z-abc.log',
    ): Promise<ToolDefinition> {
      const dshHome = await tempDshHome()
      const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
      await writeInstalledPackage(profileDir, 'pkg-a')
      await writeText(join(dshHome, 'logs', name), content)
      const { spawn } = recordingSpawn(() => cmdResult({ stdout: '' }))
      return createDiagnosePluginLoadTool(depsFor(configFor(dshHome), { spawn }))
    }

    it('解析成功：失败条目 / required 数 / profile 一致性进 key，根因（EADDRINUSE）进 L1 与 L2', async () => {
      const tool = await logFixture(REAL_STARTUP_LOG)
      const data = expectOk(await run(tool, {}))
      const evidence = data.key['startupEvidence'] as Record<string, unknown>
      expect(evidence['parseState']).toBe('parsed')
      expect(evidence['logCount']).toBe(1)
      expect(evidence['requiredNotActivated']).toBe(2)
      expect(evidence['profileMatches']).toBe(true)
      const failed = evidence['failed'] as Record<string, unknown>[]
      expect(failed).toHaveLength(1)
      expect(failed[0]?.['id']).toBe('webserver')
      expect(failed[0]?.['module']).toBe('@deepseek-ai/dsh-host-webserver')
      // L1 必须带上根因：没有 EADDRINUSE，模型只会建议「重启宿主」，而重启解决不了。
      expect(String(data.verdict)).toContain('2 required plugin(s) did not activate')
      expect(String(data.verdict)).toContain('EADDRINUSE')

      const text = renderText(tool, {}, await run(tool, {}))
      expect(text).toContain('startupEvidence: parseState=parsed')
      expect(text).toContain('requiredNotActivated=2')
      expect(text).toContain(
        'logFailed: webserver (required) @deepseek-ai/dsh-host-webserver — listen EADDRINUSE',
      )

      // 全表（等待表 11 / entries 12）进 audit —— 真机 11 条里绝大多数与本插件无关。
      const reports = (data.audit['startupLogs'] as Record<string, unknown>)['reports'] as Record<
        string,
        unknown
      >[]
      const report = reports[0]?.['report'] as Record<string, unknown>
      expect((report['pending'] as unknown[]).length).toBe(11)
      expect((report['entries'] as unknown[]).length).toBe(12)
      expect((reports[0]?.['parse'] as Record<string, unknown>)['ok']).toBe(true)
    })

    it('解析失败：`parseState=unparsed`（判红），L1 说明、L2 明说、nextStep 指向那份文件', async () => {
      const name = 'startup-2026-01-01T00-00-00-000Z-broken.log'
      const tool = await logFixture('this is not an inspect report\n', name)
      const result = await run(tool, {})
      const data = expectOk(result)
      const evidence = data.key['startupEvidence'] as Record<string, unknown>
      expect(evidence['parseState']).toBe('unparsed')
      expect(evidence['from']).toBeUndefined()
      expect((evidence['parseErrors'] as Record<string, unknown>[])[0]?.['name']).toBe(name)
      // L1 必须点破「别读成没有失败」。
      expect(String(data.verdict)).toContain('could not parse 1 startup log(s)')
      expect(String(data.verdict)).toContain('do not read that as "no plugin failed"')
      const text = renderText(tool, {}, result)
      expect(text).toContain('startupEvidence: parseState=unparsed')
      expect(text).toContain(`logParseError: ${name}`)
      // 没有工具能替模型读一份格式不认识的日志 —— 这正是 manual 支的定义。
      expect(result.nextStep).toEqual({
        manual: true,
        why: expect.stringContaining(name),
      })
    })

    it('**读不到**日志：`parseState=unreadable`（未知 ≠ 没有失败），与「目录读不到」分开', async () => {
      const dshHome = await tempDshHome()
      const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
      await writeInstalledPackage(profileDir, 'pkg-a')
      // 把 `startup-x.log` 造成一个**目录**：`readdir` 列得到它，`readFile` 会失败。
      await writeText(join(dshHome, 'logs', 'startup-x.log', 'inner'), 'x\n')
      const { spawn } = recordingSpawn(() => cmdResult({ stdout: '' }))
      const tool = createDiagnosePluginLoadTool(depsFor(configFor(dshHome), { spawn }))

      const data = expectOk(await run(tool, {}))
      // 列表层是 present（真列到了），解析层是 unreadable（读不到内容）—— 两个轴不许混。
      expect((data.key['startupLogs'] as Record<string, unknown>)['state']).toBe('present')
      const evidence = data.key['startupEvidence'] as Record<string, unknown>
      expect(evidence['parseState']).toBe('unreadable')
      expect((evidence['readErrors'] as Record<string, unknown>[])[0]?.['name']).toBe(
        'startup-x.log',
      )
      expect(String(data.verdict)).toContain('could not read 1 startup log(s)')
      expect(String(data.verdict)).toContain('that is unknown, not "no plugin failed"')
      expect(renderText(tool, {}, await run(tool, {}))).toContain('logReadError: startup-x.log')
    })

    it('部分解析：`parseState=partial`，缺口进 L2，L1 说「别把缺的段读成没有」', async () => {
      const tool = await logFixture(
        REAL_STARTUP_LOG.replace('Failed plugins (1):', 'Failed plugins (2):'),
      )
      const data = expectOk(await run(tool, {}))
      const evidence = data.key['startupEvidence'] as Record<string, unknown>
      expect(evidence['parseState']).toBe('partial')
      expect(String(data.verdict)).toContain('only partially parsed')
      expect(String(data.verdict)).toContain('do not read the missing sections as "nothing there"')
      const text = renderText(tool, {}, await run(tool, {}))
      expect(text).toContain('logGap:')
      expect(text).toContain('failed-count')
    })

    it('日志的 profile 与本次不同 → `profileMatches=false`，L1 说它解释不了当前 profile', async () => {
      const tool = await logFixture(
        REAL_STARTUP_LOG.replace("profile: 'web',", "profile: 'other',"),
      )
      const data = expectOk(await run(tool, {}))
      const evidence = data.key['startupEvidence'] as Record<string, unknown>
      expect(evidence['profileMatches']).toBe(false)
      expect(evidence['logProfile']).toBe('other')
      expect(String(data.verdict)).toContain('from profile other, not web')
      expect(renderText(tool, {}, await run(tool, {}))).toContain('profileMatches=no')
    })

    it('没有日志 / 目录读不到时**不给** `startupEvidence`（「没查」与「查了没有」可分）', async () => {
      const dshHome = await tempDshHome()
      const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
      await writeInstalledPackage(profileDir, 'pkg-a')
      const { spawn } = recordingSpawn(() => cmdResult({ stdout: '' }))
      const tool = createDiagnosePluginLoadTool(depsFor(configFor(dshHome), { spawn }))

      const data = expectOk(await run(tool, {}))
      expect(data.key['startupEvidence']).toBeUndefined()
    })
  })

  // ══════════════════════════════════════════════════════════════════════════
  // B · `dsh.bundle` 声明检查（SKILL §3.2 的第三类原因：装了却没生效）
  // ══════════════════════════════════════════════════════════════════════════

  describe('B · `dsh.bundle` 声明检查', () => {
    /** 手写一个已安装包（要精确控制 `dsh.bundle.patch` 的形态）。 */
    async function writeRawPackage(
      profileDir: string,
      name: string,
      manifest: unknown,
      files: string[] = [],
    ): Promise<void> {
      const packageDir = join(profileDir, 'node_modules', name)
      await writeText(
        join(packageDir, 'package.json'),
        typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2),
      )
      for (const file of files) await writeText(join(packageDir, file), '[]\n')
    }

    /** 一个包的 `key` 投影。 */
    function packageKeyOf(data: { key: Record<string, unknown> }): Record<string, unknown> {
      return (data.key['packages'] as Record<string, unknown>[])[0] ?? {}
    }

    it('三值映射：`undeclared` → false、`unknown` → null、其余 → true（不许压成两值）', () => {
      const base = {
        packageName: 'pkg-a',
        packageDir: '/tmp/pkg-a',
        resolvedFrom: 'profile' as const,
        entryState: 'present' as const,
        patches: [],
      }
      expect(toBundleKey({ ...base, patchState: 'undeclared' }).declared).toBe(false)
      expect(toBundleKey({ ...base, patchState: 'unknown' }).declared).toBeNull()
      expect(toBundleKey({ ...base, patchState: 'present' }).declared).toBe(true)
      expect(toBundleKey({ ...base, patchState: 'missing' }).declared).toBe(true)
      expect(toBundleKey({ ...base, patchState: 'malformed' }).declared).toBe(true)
      // 坏声明是**发现**（不是解析失败）：它照样 `declared: true`，但带 issue。
      expect(toBundleKey({ ...base, patchState: 'malformed' }).patchIssue).toBe('malformed')
    })

    it('**字符串与数组两种形态都算「声明了」**（数组不是只取第一个）', async () => {
      const dshHome = await tempDshHome()
      const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-str', 'pkg-arr'] })
      await writeRawPackage(
        profileDir,
        'pkg-str',
        { name: 'pkg-str', main: './lib/index.js', dsh: { bundle: { patch: './one.yml' } } },
        ['lib/index.js', 'one.yml'],
      )
      await writeRawPackage(
        profileDir,
        'pkg-arr',
        {
          name: 'pkg-arr',
          main: './lib/index.js',
          dsh: { bundle: { patch: ['./one.yml', './two.yml'] } },
        },
        ['lib/index.js', 'one.yml', 'two.yml'],
      )
      const { spawn } = recordingSpawn(() => cmdResult({ stdout: '' }))
      const tool = createDiagnosePluginLoadTool(depsFor(configFor(dshHome), { spawn }))

      const single = packageKeyOf(expectOk(await run(tool, { package: 'pkg-str' })))[
        'bundle'
      ] as Record<string, unknown>
      expect(single['declared']).toBe(true)
      expect(single['patches']).toEqual(['./one.yml'])
      expect(single['missing']).toEqual([])
      expect(single['patchIssue']).toBeUndefined()

      const array = packageKeyOf(expectOk(await run(tool, { package: 'pkg-arr' })))[
        'bundle'
      ] as Record<string, unknown>
      expect(array['declared']).toBe(true)
      expect(array['patches']).toEqual(['./one.yml', './two.yml'])
      expect(array['missing']).toEqual([])
    })

    it('数组形态里**第二个**文件不在 → `missing` 判出来（只看第一个是假绿）', async () => {
      const dshHome = await tempDshHome()
      const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-arr'] })
      await writeRawPackage(
        profileDir,
        'pkg-arr',
        {
          name: 'pkg-arr',
          main: './lib/index.js',
          dsh: { bundle: { patch: ['./one.yml', './two.yml'] } },
        },
        ['lib/index.js', 'one.yml'],
      )
      const { spawn } = recordingSpawn(() => cmdResult({ stdout: '' }))
      const tool = createDiagnosePluginLoadTool(depsFor(configFor(dshHome), { spawn }))

      const data = expectOk(await run(tool, {}))
      const bundle = packageKeyOf(data)['bundle'] as Record<string, unknown>
      expect(bundle['declared']).toBe(true)
      expect(bundle['patchIssue']).toBe('missing')
      expect(bundle['missing']).toEqual(['./two.yml'])
      // L2 必须印出**缺的那个文件名** —— 下一步要用它去修。
      const text = renderText(tool, {}, await run(tool, {}))
      expect(text).toContain('bundle=missing ./two.yml (the host drops the whole layer)')
    })

    it('没声明 `dsh.bundle` → `declared=false` + L2 明说「不贡献层」', async () => {
      const dshHome = await tempDshHome()
      const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
      await writeInstalledPackage(profileDir, 'pkg-a')
      const { spawn } = recordingSpawn(() => cmdResult({ stdout: '' }))
      const tool = createDiagnosePluginLoadTool(depsFor(configFor(dshHome), { spawn }))

      const data = expectOk(await run(tool, {}))
      const bundle = packageKeyOf(data)['bundle'] as Record<string, unknown>
      expect(bundle['declared']).toBe(false)
      expect(bundle['patches']).toEqual([])
      expect(bundle['patchIssue']).toBeUndefined()
      expect(renderText(tool, {}, await run(tool, {}))).toContain(
        'bundle=none (contributes no layer)',
      )
    })

    it('`dsh.bundle.patch` 形态坏（数字）→ `malformed`：宿主丢掉整条层，必须说出来', async () => {
      const dshHome = await tempDshHome()
      const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-bad'] })
      await writeRawPackage(
        profileDir,
        'pkg-bad',
        { name: 'pkg-bad', main: './lib/index.js', dsh: { bundle: { patch: 42 } } },
        ['lib/index.js'],
      )
      const { spawn } = recordingSpawn(() => cmdResult({ stdout: '' }))
      const tool = createDiagnosePluginLoadTool(depsFor(configFor(dshHome), { spawn }))

      const data = expectOk(await run(tool, {}))
      const bundle = packageKeyOf(data)['bundle'] as Record<string, unknown>
      expect(bundle['declared']).toBe(true)
      expect(bundle['patchIssue']).toBe('malformed')
      const text = renderText(tool, {}, await run(tool, {}))
      expect(text).toContain('bundle=malformed declaration (the host drops the whole layer)')
    })

    it('那份 `package.json` 读不到（坏 JSON）→ `declared=null`（未知 ≠ 没声明）', async () => {
      const dshHome = await tempDshHome()
      const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-broken'] })
      await writeRawPackage(profileDir, 'pkg-broken', '{ this is not json')
      const { spawn } = recordingSpawn(() => cmdResult({ stdout: '' }))
      const tool = createDiagnosePluginLoadTool(depsFor(configFor(dshHome), { spawn }))

      const data = expectOk(await run(tool, {}))
      const bundle = packageKeyOf(data)['bundle'] as Record<string, unknown>
      // 三值里的第三档：读不到 ≠ 没声明（把两者混起来正是 B0 那条假红）。
      expect(bundle['declared']).toBeNull()
      expect(bundle['patchIssue']).toBeUndefined()
      // 而且**不许**据此判「缺文件」（entryState 是 unknown，不是 missing）。
      expect(packageKeyOf(data)['entryState']).toBe('unknown')
      expect(renderText(tool, {}, await run(tool, {}))).toContain('bundle=unknown (resolvedFrom=')
    })

    it('默认情形（声明了、文件都在）**不进** L2 —— 只放本次非默认的事实', async () => {
      const dshHome = await tempDshHome()
      const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
      await writeInstalledPackage(profileDir, 'pkg-a', { patch: './cordis.patch.yml' })
      const { spawn } = recordingSpawn(() => cmdResult({ stdout: '' }))
      const tool = createDiagnosePluginLoadTool(depsFor(configFor(dshHome), { spawn }))

      const data = expectOk(await run(tool, {}))
      const bundle = packageKeyOf(data)['bundle'] as Record<string, unknown>
      expect(bundle['declared']).toBe(true)
      expect(renderText(tool, {}, await run(tool, {}))).not.toContain('bundle=')
    })
  })

  // ══════════════════════════════════════════════════════════════════════════
  // C · `entry=present` 的方向性措辞
  //
  // 独立验证者实测：本机 15 个 bundle 里有 5 个是 `present` 但组合树里没有同名行。
  // `present` 只回答「能不能解析到 + 入口文件在」，**不回答「进树 / 生效」** ——
  // 读不到树时它是模型唯一原料，会被读成「装了就是生效了」。
  // ══════════════════════════════════════════════════════════════════════════

  describe('C · `entry=present` 不许被读成「装了=生效了」', () => {
    /** 造一个 `pkg-a` 已装、bundles 里有它的 fixture，可选注入 loader。 */
    async function presentFixture(loader?: () => never): Promise<ToolDefinition> {
      const dshHome = await tempDshHome()
      const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
      await writeInstalledPackage(profileDir, 'pkg-a')
      const { spawn } = recordingSpawn(() => cmdResult({ stdout: '' }))
      return createDiagnosePluginLoadTool(
        depsFor(configFor(dshHome), loader === undefined ? { spawn } : { spawn, loader }),
      )
    }

    it('**读不到树**时带方向性措辞（这时这行是唯一原料）', async () => {
      const tool = await presentFixture()
      const data = expectOk(await run(tool, {}))
      expect(packageKeyOf(data)['entryState']).toBe('present')
      const text = renderText(tool, {}, await run(tool, {}))
      expect(text).toContain('entry=present (resolvable; not proof of composition)')
      // 没读树 → 没有 ids=（正因为如此才必须带方向）。
      expect(text).not.toContain('ids=')
    })

    it('能解析到**且**在树里 → 不带措辞（`ids=` 已经明确回答了）', async () => {
      const tool = await presentFixture(
        loaderWith([
          entrySnapshot({ moduleName: 'pkg-a', fiberState: 2 }),
        ]) as unknown as () => never,
      )
      const text = renderText(tool, {}, await run(tool, {}))
      expect(text).toContain('ids=include:pkg-a')
      expect(text).toContain('entry=present')
      expect(text).not.toContain('not proof of composition')
    })

    it('能解析到但**不在**树里 → `ids=none` + 硬证据（不靠措辞）', async () => {
      const tool = await presentFixture(
        loaderWith([
          entrySnapshot({ moduleName: 'other-pkg', fiberState: 2 }),
        ]) as unknown as () => never,
      )
      const data = expectOk(await run(tool, {}))
      const pkg = packageKeyOf(data)
      expect(pkg['entryState']).toBe('present')
      expect(pkg['matchedEntryIds']).toEqual([])
      expect(String(pkg['error'])).toContain('no row in the Loader tree')
      const text = renderText(tool, {}, await run(tool, {}))
      expect(text).toContain('ids=none')
    })
  })

  // ══════════════════════════════════════════════════════════════════════════
  // B24 · `execute` 全路径不抛（契约的承载条件）
  //
  // 宿主只把**抛出的异常**当失败；一旦 `execute` 抛出去，模型看到的是一句裸
  // `Error: …`，`verdict` / `key` / `audit` 全部失效（SHAPE §4）。
  // 判据是 **`ensureToolResult(value) === value`（恒等）**：那才证明这个值**过了守卫**，
  // 而不是被守卫合成的兜底（活跃坑 37：症状消失 ≠ 根因修好）。
  // ══════════════════════════════════════════════════════════════════════════

  describe('B24 · `execute` 绝不 throw', () => {
    it('注入的 `spawn` 抛异常 → 返回**过了守卫**的合法结果', async () => {
      await withPlatform('win32', async () => {
        const dshHome = await tempDshHome()
        const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
        await writeInstalledPackage(profileDir, 'pkg-a')
        let calls = 0
        const tool = createDiagnosePluginLoadTool(
          depsFor(configFor(dshHome, { port: 3080 }), {
            spawn: () => {
              calls += 1
              throw new Error('spawn exploded')
            },
          }),
        )

        const value = await run(tool, {})
        // 下界：替身一次都没被调用 = 注入没生效 → 这条判据就是空转（活跃坑 18）。
        expect(calls, '替身一次都没被调用 —— 注入没生效，判据空转').toBeGreaterThan(0)
        expect(ensureToolResult(value)).toBe(value)
        expect(value.ok).toBe(false)
        if (value.ok) throw new Error('期望失败')
        expect(Object.keys(value.data).sort()).toEqual(['audit', 'key', 'verdict'])
        expect(value.data.verdict).not.toBe('')
        expect(toolResultProblem(value)).toBeUndefined()
      })
    })

    it('注入的 `loader` 抛异常 → 同样返回**过了守卫**的合法结果', async () => {
      const dshHome = await tempDshHome()
      const profileDir = await writeProfile(dshHome, 'web', { bundles: ['pkg-a'] })
      await writeInstalledPackage(profileDir, 'pkg-a')
      let loaderCalls = 0
      const { spawn } = recordingSpawn(() => cmdResult({ stdout: '' }))
      const tool = createDiagnosePluginLoadTool(
        depsFor(configFor(dshHome), {
          spawn,
          loader: () => {
            loaderCalls += 1
            throw new Error('loader exploded')
          },
        }),
      )

      const value = await run(tool, {})
      expect(loaderCalls, '替身一次都没被调用 —— 注入没生效，判据空转').toBeGreaterThan(0)
      expect(ensureToolResult(value)).toBe(value)
      expect(value.ok).toBe(false)
      if (value.ok) throw new Error('期望失败')
      expect(value.data.verdict).not.toBe('')
    })
  })
})

/** 取一个 `key.packages[0]`。 */
function packageKeyOf(data: { key: Record<string, unknown> }): Record<string, unknown> {
  return (data.key['packages'] as Record<string, unknown>[])[0] ?? {}
}

/**
 * 本机那份**真机启动日志**的逐字拷贝（`$DSH_HOME/logs/startup-2026-09-29T19-03-37.556Z-*.log`，
 * `dshVersion: 0.2.0-rc.1`）。**唯一的改动**是把家目录名换成了 `user`。
 *
 * 为什么整份贴进来而不是造一个「形状差不多」的：解析器面对的是 `util.inspect` 的真实输出
 * —— `[length]: N` 伪字段、`error.message` 里那份**转义过的字符串副本**（`'Failed plugins (1):\n' +`）、
 * 嵌套对象的缩进、`[Getter/Setter]`。任何一处「差不多」都会把锚点定偏，而锚点一偏，
 * 判据就变成假绿。
 *
 * 实测锚点：headline=2 / Failed plugins=1 / waiting=11 / entries=12（**2 ≠ 1**）。
 * 它同时是 `test/integration` 之外唯一能离线复现真机日志形状的东西。
 */
const REAL_STARTUP_LOG = String.raw`
WARNING: Raw diagnostics may contain configuration or credential values from plugin errors. Review before sharing.

{
  timestamp: '2026-09-29T19:03:37.556Z',
  dshVersion: '0.2.0-rc.1',
  nodeVersion: 'v24.18.0',
  platform: 'win32',
  arch: 'x64',
  profile: 'web',
  error: StartupError: dsh: startup failed: 2 required plugins did not activate
  
  Failed plugins (1):
    webserver (required)
      Package: @deepseek-ai/dsh-host-webserver
      Error: listen EADDRINUSE: address already in use 127.0.0.1:19388
          at Server.setupListenHandle [as _listen2] (node:net:2009:16)
          at listenInCluster (node:net:2066:12)
          at node:net:2275:7
          at process.processTicksAndRejections (node:internal/process/task_queues:90:21)
  
  Plugins waiting for services (11):
    Plugin                 Missing services
    connection (required)  webRuntime
    session-log-download   connection
    open-in-app            webServer, connection
    directory-picker       webServer
    session-controller     fileUploads
    web-runtime            webServer
    client-hmr             webServer
    file-upload            connection
    ui-deliverables        connection, sessionController
    xmanrui-dsh-im         connection
    usage-stats            webServer
      at auditStartupEntries (file:///C:/Users/user/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:4012:31)
      ... 3 lines matching cause stack trace ...
      at async file:///C:/Users/user/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/bin.js:248:23 {
    [stack]: [Getter/Setter],
    [message]: 'dsh: startup failed: 2 required plugins did not activate\n' +
      '\n' +
      'Failed plugins (1):\n' +
      '  webserver (required)\n' +
      '    Package: @deepseek-ai/dsh-host-webserver\n' +
      '    Error: listen EADDRINUSE: address already in use 127.0.0.1:19388\n' +
      '        at Server.setupListenHandle [as _listen2] (node:net:2009:16)\n' +
      '        at listenInCluster (node:net:2066:12)\n' +
      '        at node:net:2275:7\n' +
      '        at process.processTicksAndRejections (node:internal/process/task_queues:90:21)\n' +
      '\n' +
      'Plugins waiting for services (11):\n' +
      '  Plugin                 Missing services\n' +
      '  connection (required)  webRuntime\n' +
      '  session-log-download   connection\n' +
      '  open-in-app            webServer, connection\n' +
      '  directory-picker       webServer\n' +
      '  session-controller     fileUploads\n' +
      '  web-runtime            webServer\n' +
      '  client-hmr             webServer\n' +
      '  file-upload            connection\n' +
      '  ui-deliverables        connection, sessionController\n' +
      '  xmanrui-dsh-im         connection\n' +
      '  usage-stats            webServer',
    [cause]: AggregateError: Plugin activation failures
        at new StartupError (file:///C:/Users/user/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:3874:49)
        at auditStartupEntries (file:///C:/Users/user/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:4012:31)
        at async boot (file:///C:/Users/user/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:4086:3)
        at async runProfile (file:///C:/Users/user/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/profile-boot-BZ2ZjNWi.js:271:15)
        at async runCli (file:///C:/Users/user/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/bin.js:212:5)
        at async file:///C:/Users/user/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/bin.js:248:23 {
      [stack]: [Getter/Setter],
      [message]: 'Plugin activation failures',
      [errors]: [
        Error: listen EADDRINUSE: address already in use 127.0.0.1:19388
            at Server.setupListenHandle [as _listen2] (node:net:2009:16)
            at listenInCluster (node:net:2066:12)
            at node:net:2275:7
            at process.processTicksAndRejections (node:internal/process/task_queues:90:21) {
          [stack]: [Getter/Setter],
          [message]: 'listen EADDRINUSE: address already in use 127.0.0.1:19388',
          code: 'EADDRINUSE',
          errno: -4091,
          syscall: 'listen',
          address: '127.0.0.1',
          port: 19388
        },
        [length]: 1
      ]
    },
    [entries]: [
      {
        id: 'session-log-download',
        module: '@deepseek-ai/dsh-session-log-export',
        required: false,
        fiberState: 0,
        outcome: { kind: 'pending', missing: [ 'connection', [length]: 1 ] }
      },
      {
        id: 'open-in-app',
        module: '@deepseek-ai/dsh-host-open-in-app',
        required: false,
        fiberState: 0,
        outcome: {
          kind: 'pending',
          missing: [ 'webServer', 'connection', [length]: 2 ]
        }
      },
      {
        id: 'directory-picker',
        module: '@deepseek-ai/dsh-host-directory-picker-auto',
        required: false,
        fiberState: 0,
        outcome: { kind: 'pending', missing: [ 'webServer', [length]: 1 ] }
      },
      {
        id: 'session-controller',
        module: '@deepseek-ai/dsh-api-session-controller',
        required: false,
        fiberState: 0,
        outcome: { kind: 'pending', missing: [ 'fileUploads', [length]: 1 ] }
      },
      {
        id: 'webserver',
        module: '@deepseek-ai/dsh-host-webserver',
        required: true,
        fiberState: 3,
        outcome: {
          kind: 'failed',
          error: Error: listen EADDRINUSE: address already in use 127.0.0.1:19388
              at Server.setupListenHandle [as _listen2] (node:net:2009:16)
              at listenInCluster (node:net:2066:12)
              at node:net:2275:7
              at process.processTicksAndRejections (node:internal/process/task_queues:90:21) {
            [stack]: [Getter/Setter],
            [message]: 'listen EADDRINUSE: address already in use 127.0.0.1:19388',
            code: 'EADDRINUSE',
            errno: -4091,
            syscall: 'listen',
            address: '127.0.0.1',
            port: 19388
          }
        }
      },
      {
        id: 'web-runtime',
        module: '@deepseek-ai/dsh-web-app',
        required: false,
        fiberState: 0,
        outcome: { kind: 'pending', missing: [ 'webServer', [length]: 1 ] }
      },
      {
        id: 'client-hmr',
        module: '@deepseek-ai/dsh-client-hmr',
        required: false,
        fiberState: 0,
        outcome: { kind: 'pending', missing: [ 'webServer', [length]: 1 ] }
      },
      {
        id: 'connection',
        module: '@deepseek-ai/dsh-client-connection',
        required: true,
        fiberState: 0,
        outcome: { kind: 'pending', missing: [ 'webRuntime', [length]: 1 ] }
      },
      {
        id: 'file-upload',
        module: '@deepseek-ai/dsh-client-file-upload',
        required: false,
        fiberState: 0,
        outcome: { kind: 'pending', missing: [ 'connection', [length]: 1 ] }
      },
      {
        id: 'ui-deliverables',
        module: '@deepseek-ai/dsh-client-ui-deliverables',
        required: false,
        fiberState: 0,
        outcome: {
          kind: 'pending',
          missing: [ 'connection', 'sessionController', [length]: 2 ]
        }
      },
      {
        id: 'xmanrui-dsh-im',
        module: '@xmanrui/dsh-im',
        required: false,
        fiberState: 0,
        outcome: { kind: 'pending', missing: [ 'connection', [length]: 1 ] }
      },
      {
        id: 'usage-stats',
        module: 'dsh-usage-statistics-panel',
        required: false,
        fiberState: 0,
        outcome: { kind: 'pending', missing: [ 'webServer', [length]: 1 ] }
      },
      [length]: 12
    ],
    [startup]: {
      configurationPath: 'C:\\Users\\user\\.dsh\\profiles\\web\\cordis.yml',
      messages: [
        {
          ts: 1790708610269,
          name: 'root',
          type: 'warn',
          args: [
            'patch: name mismatch for "llm-deepseek" (expected "@deepseek-ai/dsh-llm-deepseek-api-key", got "@deepseek-ai/dsh-llm-deepseek"), skipping',
            [length]: 1
          ]
        },
        {
          ts: 1790708616460,
          name: 'web-server',
          type: 'error',
          args: [
            Error: listen EADDRINUSE: address already in use 127.0.0.1:19388
                at Server.setupListenHandle [as _listen2] (node:net:2009:16)
                at listenInCluster (node:net:2066:12)
                at node:net:2275:7
                at process.processTicksAndRejections (node:internal/process/task_queues:90:21) {
              [stack]: [Getter/Setter],
              [message]: 'listen EADDRINUSE: address already in use 127.0.0.1:19388',
              code: 'EADDRINUSE',
              errno: -4091,
              syscall: 'listen',
              address: '127.0.0.1',
              port: 19388
            },
            [length]: 1
          ]
        },
        {
          ts: 1790708617473,
          name: 'workspace-registry',
          type: 'warn',
          args: [
            "workspace '886971a7-22b9-4790-b871-f2be03a06ef6' filtered session 'session-f4af1511-6be3-4742-abb4-980a91058b9c' from membership: cwd 'D:\\ProjectSomething\\dsh-zhihu-search' does not resolve",
            [length]: 1
          ]
        },
        {
          ts: 1790708617549,
          name: 'hmr',
          type: 'warn',
          args: [
            'config reload at %C failed',
            'C:\\Users\\user\\.dsh\\profiles\\web\\package.json',
            [length]: 2
          ]
        },
        {
          ts: 1790708617549,
          name: 'hmr',
          type: 'warn',
          args: [
            Error: HMR is disposed
                at file:///C:/Users/user/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-hmr/lib/index.js:282:29 {
              [stack]: [Getter/Setter],
              [message]: 'HMR is disposed'
            },
            [length]: 1
          ]
        },
        [length]: 5
      ]
    }
  }
}
`
