/**
 * `dsh_restart` 工具壳的判据 —— **不依赖真机**，全部用注入端口。
 *
 * ## 这一份要钉住的是「顺序」与「三值」，不是「跑通了」
 *
 * 1. **顺序是判据**（SHAPE §6.1）：四道确定性闸门**全过之后**才轮到审批门 ——
 *    反了就是「先弹窗让用户同意、再告诉他闸③不过」。所以有一条用例专门断言
 *    「闸门拒绝时审批替身零调用」。
 * 2. **marker 必须在拉起之前 `await` 完成**：拉起替身在**被调用的那一刻**回看
 *    写次数，退出替身同样回看 —— 这比「返回值里写了 markerWritten: true」强得多。
 * 3. **`ask` 档只有 `allowed-once` 算允许**，`rejected` / `cancelled` / `unavailable`
 *    一律当拒绝（`unavailable` 是最容易被写成放行的那一格）；**`never` 档不问**。
 * 4. **三值纪律**：档位读不出来 ⇒ fail-closed；`decideRecovery` 的两个 `none`
 *    （`absent` / `consumed`）必须给出**不同**的重启历史（合并它们 = 静默丢掉一次冷却）。
 *
 * ## 替身必须「真的被接上」且「真的被调用过」（本仓坑 40）
 *
 * 每条用例都断言**调用计数**（写次数 / 拉起次数 / 退出次数 / 审批请求次数）。
 * 「替身没生效」与「替身生效了」在绿的时候长得一样 —— 只数次数才分得开。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

import {
  ensureToolResult,
  TOOL_ERROR_KINDS,
  toolResultProblem,
  type ToolResult,
} from '../../src/lib/errors.ts'
import type { ResolvedConfig } from '../../src/contracts.ts'
import { resolveConfig } from '../../src/config.ts'
import {
  carrierAuditOf,
  relaunchRefusalFor,
  relaunchRouteFor,
  type CarrierObservation,
} from '../../src/lib/carrier.ts'
import type { CommandResult, RunCommandOptions, SpawnImpl } from '../../src/lib/exec.ts'
import type {
  BusySource,
  LaunchCommand,
  Observed,
  RestartFsPort,
  RestartPorts,
  TextRead,
} from '../../src/lib/restart.ts'
import {
  createRestartTool,
  keyText,
  launchCommandFrom,
  relaunchViaTaskScheduler,
  restartHistoryFrom,
  busySourcesFrom,
  appExitOf,
  approvalPolicyOf,
  approvalRequestOf,
  RESTART_DESCRIPTION,
  RESTART_CONFIG_FIELD,
  RESTART_TOOL,
  SCHTASKS_TR_MAX_CHARS,
  type RelaunchRequest,
  type RelaunchResult,
  type RestartApprovalOutcome,
  type RestartHost,
} from '../../src/tools/dsh_restart.ts'
import { composeDescription } from '../../src/tools/describe.ts'
import {
  cmdResult,
  carrierOf,
  configFor,
  depsFor,
  expectFail,
  expectOk,
  recordingSpawn,
  renderText,
  run,
  splitRender,
  stripComments,
  tempDshHome,
  volatileOf,
  withPlatform,
} from './helpers.ts'

const NOW = Date.UTC(2026, 9, 14, 6, 0, 0)
const CALLER = 'session-caller'

/** 仓根：本文件在 `test/tools/` 下。 */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const LAUNCH: LaunchCommand = {
  command: 'node',
  args: ['bin.js', '--profile', 'web'],
  cwd: 'C:/repo',
}

/** 一个**记调用**的 marker IO 替身。 */
interface FsRecorder {
  port: RestartFsPort
  reads: string[]
  writes: { path: string; text: string }[]
  /**
   * 只数 **marker** 的写入（不含启动器脚本）。
   *
   * 拉起前的判据是「**marker** 已经落盘」—— 2026-10-17 起一次成功拉起会写两份
   * （marker + VBS 启动器），所以「写了几次」必须分开问，否则那条判据会被脚本的写入垫高。
   */
  markerWrites(): { path: string; text: string }[]
  /** marker 的当前内容（`undefined` = 文件不在）。 */
  content(): string | undefined
  seed(text: string): void
}

/**
 * 造 marker 的 IO 替身。
 *
 * ⚠️ **按路径分开存**（2026-10-17 起）：marker 一份、启动器脚本（VBS）是另一份。
 * 早先的实现只有一格 `stored`，两次写会互相覆盖 —— 那时只写 marker 所以没暴露，
 * 现在写两份就必须分路径，否则「marker 的内容」问出来的是 VBS。
 *
 * @param options `seed` = 预置 marker 内容；`failWriteWith` = 每次写都抛这个错误（沙箱拒绝那条路）。
 */
function makeFs(
  options: { seed?: string; failWriteWith?: { code: string; message: string } } = {},
): FsRecorder {
  const reads: string[] = []
  const writes: { path: string; text: string }[] = []
  const files = new Map<string, string>()
  let seeded = options.seed
  const isMarker = (path: string): boolean => path.endsWith('marker.json')
  const port: RestartFsPort = {
    read: async (path): Promise<TextRead> => {
      reads.push(path)
      const text = files.get(path) ?? (isMarker(path) ? seeded : undefined)
      return text === undefined ? { status: 'absent' } : { status: 'text', text }
    },
    write: async (path, text) => {
      if (options.failWriteWith !== undefined) {
        throw Object.assign(new Error(options.failWriteWith.message), {
          code: options.failWriteWith.code,
        })
      }
      writes.push({ path, text })
      files.set(path, text)
    },
  }
  return {
    port,
    reads,
    writes,
    markerWrites: () => writes.filter((entry) => isMarker(entry.path)),
    content: () => {
      const marker = writes.filter((entry) => isMarker(entry.path)).at(-1)
      return marker?.text ?? seeded
    },
    seed: (text) => {
      seeded = text
    },
  }
}

/** 一个「调用方自己」的 exec（`dsh_restart` 要从 `agent` 取会话 id）。 */
function execFor(sessionId = CALLER): ToolRunContext {
  return {
    signal: new AbortController().signal,
    agent: { id: sessionId, session: { id: sessionId } },
  } as unknown as ToolRunContext
}

/**
 * 造一份合法 marker 文本。 */
function markerText(overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    version: 1,
    reason: 'the plugin code changed',
    at: new Date(NOW).toISOString(),
    sessions: [CALLER],
    state: 'armed',
    trace: ['restart-loop=pass'],
    ...overrides,
  })}\n`
}

/** 夹具的覆盖面。 */
interface HarnessOptions {
  /** 审批档位；`undefined` = 读不出来（fail-closed 那一格）。 */
  policy?: 'ask' | 'never' | undefined
  /** `ask` 档下 `request` 的返回值。 */
  outcome?: RestartApprovalOutcome
  history?: Observed<readonly number[]>
  busy?: Observed<readonly BusySource[]>
  bundles?: Observed<readonly string[]>
  launch?: Observed<LaunchCommand>
  fs?: FsRecorder
  relaunch?: RelaunchResult
  /** `exit()` 返回的通道；`undefined` = 取不到。 */
  exitChannel?: ((code: number) => void) | undefined
  /** 让某个端口抛异常（B24 的注入组）。 */
  portThrows?: 'history' | 'busy' | 'bundles' | 'launch'
  /** `policyOf` 自己抛。 */
  policyThrows?: boolean
  /** `request` 自己抛（宿主在「没有打开的回合」上就是这样）。 */
  requestThrows?: boolean
  /** 拉起端口自己抛（用来钉「兜底分支的 `key.stage` 按调用点报」）。 */
  relaunchThrows?: boolean
  /**
   * 这个宿主跑在什么载体上。
   *
   * **默认给 `cli × win32`**（唯一有已实测回归路线的那一格）：本文件绝大多数用例测的是
   * 闸①②③与审批门那条老路，载体不是它们的变量。⚠️ 但**忘了给**时 `depsFor` 的兜底是
   * `UNKNOWN_CARRIER` ⇒ 闸④ 会在它们之前响亮地拒 —— 那正是兜底该有的方向（fail-closed），
   * 也正是本文件显式给默认值的理由：让「忘了给」在**新写的**用例上立刻暴露，而不是
   * 让老用例悄悄换一条路。
   */
  carrier?: CarrierObservation
  /** 生效配置的覆盖项；**默认 `enableRestart: true`**（本文件要测的四道闸那一路）。 */
  config?: Partial<ResolvedConfig>
}

/** 一套夹具。 */
interface Harness {
  tool: ToolDefinition
  fs: FsRecorder
  /** 每次 `policyOf` 的实参。 */
  policyCalls: unknown[]
  /** 每次 `request` 的实参（次数就是「问了几次」）。 */
  requestCalls: { reason: string }[]
  /** 每次拉起的请求。 */
  launchCalls: RelaunchRequest[]
  /** 拉起**被调用的那一刻**，marker 已经写了几次。 */
  writesAtLaunch: number[]
  /** 退出通道被调用的参数。 */
  exitCalls: number[]
  /** 退出**被调用的那一刻**，marker 已经写了几次。 */
  writesAtExit: number[]
  ports: RestartPorts
}

/**
 * 让出**一个宏任务**，把 `dsh_restart` 排到下一 tick 的那次退出等它真的跑完。
 *
 * 为什么需要它：成功路径上工具**先返回结论、再退出**（结论必须比退出先到，否则真机上
 * 那句 verdict 永远落不了盘 —— 2026-10-14 实测）。退出被排进 `setImmediate`，所以
 * `execute()` resolve 的那一刻 `exitCalls` **还是空的**。
 *
 * ⚠️ 所以「退出被调用过」这条断言**必须**在这个 flush 之后断，否则它量的是「还没轮到
 * 退出」，是**假红**；反过来，只在 flush 之后断，又会漏掉「退出排在了结论之前」那个
 * 真缺陷 —— **两处都要**：先断 `execute` resolve 时 `exitCalls` 仍为空（结论先到），
 * 再 flush 后断它变成 `[0]`（退出确实发生）。只有后者会放过原来的 bug。
 *
 * @returns 一个 resolve 之后即已让出宏任务的 promise。
 */
async function flushDeferredExit(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve)
  })
}

/**
 * 造一套夹具。
 *
 * 默认四道闸全绿、审批档 `never`（不问）、拉起成功、退出通道在场。
 *
 * @param home 临时 `$DSH_HOME`。
 * @param options 覆盖项。
 */
function harnessFor(home: string, options: HarnessOptions = {}): Harness {
  const fs = options.fs ?? makeFs()
  const policyCalls: unknown[] = []
  const requestCalls: { reason: string }[] = []
  const launchCalls: RelaunchRequest[] = []
  const writesAtLaunch: number[] = []
  const exitCalls: number[] = []
  const writesAtExit: number[] = []

  const maybeThrow = (name: HarnessOptions['portThrows']): void => {
    if (options.portThrows === name) throw new Error(`${name} port exploded`)
  }

  const ports: RestartPorts = {
    fs: fs.port,
    restartHistory: async () => {
      maybeThrow('history')
      return options.history ?? { known: true, value: [] }
    },
    busySessions: async () => {
      maybeThrow('busy')
      return options.busy ?? { known: true, value: [] }
    },
    bundles: async () => {
      maybeThrow('bundles')
      return options.bundles ?? { known: true, value: ['dsh-plugin-debugging'] }
    },
    launchCommand: async () => {
      maybeThrow('launch')
      return options.launch ?? { known: true, value: LAUNCH }
    },
    now: () => NOW,
  }

  const host: RestartHost = {
    ports,
    approval: {
      policyOf: (agent) => {
        policyCalls.push(agent)
        if (options.policyThrows === true) throw new Error('approval policy read exploded')
        // 没给 `policy` 与显式给 `undefined` 都是「读不出来」（fail-closed 那一格）。
        return options.policy
      },
      request: async (_agent, reason) => {
        requestCalls.push({ reason })
        if (options.requestThrows === true) throw new Error('approval request exploded')
        return options.outcome ?? 'allowed-once'
      },
    },
    launch: {
      relaunch: async (request) => {
        launchCalls.push(request)
        writesAtLaunch.push(fs.writes.length)
        if (options.relaunchThrows === true) throw new Error('relaunch port exploded')
        return options.relaunch ?? { ok: true, detail: 'schtasks /run exited 0' }
      },
    },
    exit: {
      exit: () => {
        const channel =
          'exitChannel' in options
            ? options.exitChannel
            : (code: number) => {
                exitCalls.push(code)
              }
        if (channel === undefined) return undefined
        return (code: number) => {
          writesAtExit.push(fs.writes.length)
          channel(code)
        }
      },
    },
  }

  // 本文件其余用例要测的都是「开关**开**着」的那条路（默认关是另一条，见第 22 节）。
  const config = configFor(home, { enableRestart: volatileOf(true), ...options.config })
  // 载体**显式给**（默认「命令行 × win32」= 唯一有已实测回归路线的那一格）。
  const deps = depsFor(config, { carrier: options.carrier ?? carrierOf('cli', 'win32') })
  // ⚠️ 显式对象构造（不是往窄类型的形参里塞多余字段）：替身被静默丢掉是本仓踩过的坑 40。
  const tool = createRestartTool({ ...deps, restart: host })
  return {
    tool,
    fs,
    policyCalls,
    requestCalls,
    launchCalls,
    writesAtLaunch,
    exitCalls,
    writesAtExit,
    ports,
  }
}

/** 一份默认参数。 */
const ARGS = { reason: 'the plugin code changed and only a restart picks it up' }

// ── 1. 三键形状 + 全路径不抛 ────────────────────────────────────────────────

describe('dsh_restart · 形状与不抛', () => {
  it('成功与失败两条路都是顶层闭集 + data 恰好三键，且都过了守卫', async () => {
    const home = await tempDshHome()
    const cases: Array<{ label: string; options: HarnessOptions; args: unknown }> = [
      { label: '成功（闸门全过 + 拉起 + 退出）', options: {}, args: ARGS },
      {
        label: '失败（审批档读不出来）',
        options: { policy: undefined },
        args: ARGS,
      },
      {
        label: '失败（端口抛异常）',
        options: { portThrows: 'busy' },
        args: ARGS,
      },
    ]
    for (const item of cases) {
      const h = harnessFor(home, item.options)
      const result = await run(h.tool, item.args, execFor())
      expect(toolResultProblem(result), `${item.label}: 形状非法`).toBeUndefined()
      expect(ensureToolResult(result), `${item.label}: 没过守卫`).toBe(result)
      const data = (result as unknown as { data: Record<string, unknown> }).data
      expect(Object.keys(data).sort(), `${item.label}: data 不是三键闭集`).toEqual([
        'audit',
        'key',
        'verdict',
      ])
      expect(typeof data['verdict']).toBe('string')
      expect((data['verdict'] as string).length).toBeGreaterThan(0)
    }
  })

  it('端口抛异常 / 审批替身抛异常 / 读档位抛异常：`execute` **一次都不抛**，全部收敛成 internal', async () => {
    const home = await tempDshHome()
    const cases: Array<{ label: string; options: HarnessOptions }> = [
      { label: 'history 抛', options: { portThrows: 'history' } },
      { label: 'busy 抛', options: { portThrows: 'busy' } },
      { label: 'bundles 抛', options: { portThrows: 'bundles' } },
      { label: 'launchCommand 抛', options: { portThrows: 'launch' } },
      { label: 'policyOf 抛', options: { policyThrows: true } },
      { label: 'request 抛（没有打开的回合）', options: { policy: 'ask', requestThrows: true } },
    ]
    for (const item of cases) {
      const h = harnessFor(home, item.options)
      let threw: unknown
      let result: ToolResult<unknown> | undefined
      try {
        result = await run(h.tool, ARGS, execFor())
      } catch (error) {
        threw = error
      }
      expect(threw, `${item.label}: execute 抛了 —— B24 的承载条件失效`).toBeUndefined()
      expect(result?.ok, `${item.label}: 期望结构化失败`).toBe(false)
      expect(ensureToolResult(result), `${item.label}: 没过守卫`).toBe(result)
      // 拉起与退出一次都不许发生（失败必须发生在动任何东西之前）。
      expect(h.launchCalls, `${item.label}: 失败路径拉起过`).toHaveLength(0)
      expect(h.exitCalls, `${item.label}: 失败路径退出过`).toHaveLength(0)
    }
  })

  it('没有 agent（取不到调用方会话）⇒ 结构化失败，**不是**默默当成「没人忙」', async () => {
    const home = await tempDshHome()
    const h = harnessFor(home)
    const result = await run(h.tool, ARGS, {
      signal: new AbortController().signal,
    } as unknown as ToolRunContext)
    const failure = expectFail(result)
    expect(failure.data.verdict).toContain('no session id')
    expect(h.launchCalls).toHaveLength(0)
    // ⚠️ O3：模型**无法选择自己在哪个会话** ⇒ 下一步必须是**人**的动作，
    // 而不是「换一个带 session id 的会话再调」（那对它不是可执行的动作，重试必然同样失败）。
    const why = String((failure.nextStep as { why?: string } | undefined)?.why)
    expect(why, '让模型去换一个会话 —— 它做不到').toContain('ask the user')
    expect(why).not.toContain('call again from a session that has a session id')
  })
})

// ── 2. `ask` 档的映射表 ────────────────────────────────────────────────────

describe('dsh_restart · `ask` 档：只有 allowed-once 算允许', () => {
  it('allowed-once ⇒ 继续：写一次 marker、拉起一次、退出一次', async () => {
    const home = await tempDshHome()
    const h = harnessFor(home, { policy: 'ask', outcome: 'allowed-once' })
    const result = await run(h.tool, ARGS, execFor())
    const data = expectOk(result)
    expect(h.requestCalls, '没有走审批门').toHaveLength(1)
    expect(h.fs.markerWrites(), 'marker 没写').toHaveLength(1)
    expect(h.launchCalls).toHaveLength(1)
    // 顺序（两条都要）：结论先到、退出后到。少断前一条就放过「退出排在结论之前」那个真缺陷。
    expect(h.exitCalls, '退出排在了结论之前 ⇒ 真机上 verdict 不会落盘').toEqual([])
    await flushDeferredExit()
    expect(h.exitCalls).toEqual([0])
    expect(data.key['approval']).toBe('allowed-once')
  })

  it('rejected / cancelled / unavailable 三种**都**当拒绝（unavailable 最容易被写成放行）', async () => {
    const home = await tempDshHome()
    for (const outcome of ['rejected', 'cancelled', 'unavailable'] as const) {
      const h = harnessFor(home, { policy: 'ask', outcome })
      const result = await run(h.tool, ARGS, execFor())
      const failure = expectFail(result)
      expect(h.requestCalls, `${outcome}: 没问审批`).toHaveLength(1)
      expect(failure.data.verdict, `${outcome}: verdict 没说清为什么拒绝`).toContain(outcome)
      expect(h.fs.markerWrites(), `${outcome}: 拒绝了却写了 marker`).toHaveLength(0)
      expect(h.launchCalls, `${outcome}: 拒绝了却拉起了`).toHaveLength(0)
      expect(h.exitCalls, `${outcome}: 拒绝了却退出了`).toHaveLength(0)
      // 防空转：三种必须给出**互不相同**的机器码，否则「映射表」只是同一个值的三个名字。
      expect(failure.data.key['approval']).toBe(outcome)
    }
    // 三者的 kind 也要分开：`unavailable` 是「这一档根本问不到人」，不是「用户拒绝」。
    const unavailable = harnessFor(home, { policy: 'ask', outcome: 'unavailable' })
    expect(expectFail(await run(unavailable.tool, ARGS, execFor())).kind).toBe('not-configured')
    const rejected = harnessFor(home, { policy: 'ask', outcome: 'rejected' })
    expect(expectFail(await run(rejected.tool, ARGS, execFor())).kind).toBe('cancelled')
  })

  it('`cancelled` 与 `rejected` 的下一步**必须分开**（S4）：取消弹窗 ≠ 拒绝', async () => {
    const home = await tempDshHome()
    const whys: string[] = []
    for (const outcome of ['rejected', 'cancelled'] as const) {
      const h = harnessFor(home, { policy: 'ask', outcome })
      const failure = expectFail(await run(h.tool, ARGS, execFor()))
      whys.push(String((failure.nextStep as { why?: string } | undefined)?.why))
    }
    // `rejected` 是明确的拒绝：请用户批准再调。
    expect(whys[0], 'rejected 的下一步丢了「让用户批准」').toContain('ask the user to approve')
    // `cancelled` 是用户**取消了弹窗**（没有说「不」）⇒ 同一句会让模型立刻再弹一次。
    expect(whys[1], 'cancelled 与 rejected 共用同一句 —— 模型会立刻再弹一次').not.toBe(whys[0])
    expect(whys[1]).toContain('dismissed')
  })

  it('`unavailable` 的措辞不许把「没拿到值」说成「答了 unavailable」（S4 附带）', async () => {
    const home = await tempDshHome()
    const h = harnessFor(home, { policy: 'ask', outcome: 'unavailable' })
    const failure = expectFail(await run(h.tool, ARGS, execFor()))
    // 判据面还在（渲染文本里仍要认得出是哪一格）。
    expect(failure.data.verdict).toContain('unavailable')
    // ⚠️ 根因：`approvalRequestOf` 在**服务缺席 / 抛异常 / 返回非闭集值**时也归 `unavailable`，
    // 而那三种**没有 resolve 出任何值** ⇒ 「resolved "unavailable"」比事实肯定。
    expect(failure.data.verdict, '把「没拿到值」说成了「答了 unavailable」').toContain(
      'or could not be reached',
    )
    expect(failure.message).toContain('or could not be reached')
  })
})

// ── 3. `never` 档 ─────────────────────────────────────────────────────────

describe('dsh_restart · `never` 档：不问，直接执行', () => {
  it('零次 request，且继续走到位（写、拉起、退出各一次）；输出里有 not-required (policy=never)', async () => {
    const home = await tempDshHome()
    const h = harnessFor(home, { policy: 'never' })
    const result = await run(h.tool, ARGS, execFor())
    const data = expectOk(result)
    // 判据是**计数**：在 `never` 档主动去问必然被拒，那会把「你什么都授权了」变成「什么都不许做」。
    expect(h.requestCalls, '`never` 档去问审批了 —— 那一档问了必然被拒').toHaveLength(0)
    expect(h.policyCalls, '没读档位就决定了问不问').toHaveLength(1)
    expect(h.fs.markerWrites()).toHaveLength(1)
    expect(h.launchCalls).toHaveLength(1)
    expect(h.exitCalls, '退出排在了结论之前').toEqual([])
    await flushDeferredExit()
    expect(h.exitCalls).toEqual([0])
    expect(data.key['approval']).toBe('not-required (policy=never)')
    expect(renderText(h.tool, ARGS, result)).toContain('not-required (policy=never)')
  })
})

// ── 4. 档位读不出来 ⇒ fail-closed ──────────────────────────────────────────

describe('dsh_restart · 档位读不出来 ⇒ fail-closed', () => {
  it('拒绝（不是「当成已授权」），且零写零拉起零退出', async () => {
    const home = await tempDshHome()
    const h = harnessFor(home, { policy: undefined })
    const failure = expectFail(await run(h.tool, ARGS, execFor()))
    expect(failure.data.verdict).toContain('could not be determined')
    expect(failure.data.key['approval']).toBe('unreadable')
    expect(h.requestCalls, '档位读不出来还去问审批了').toHaveLength(0)
    expect(h.fs.markerWrites()).toHaveLength(0)
    expect(h.launchCalls).toHaveLength(0)
    expect(h.exitCalls).toHaveLength(0)
  })
})

// ── 5. dryRun ─────────────────────────────────────────────────────────────

describe('dsh_restart · dryRun 零写零拉起零退出（配一条反空转）', () => {
  it('dryRun ⇒ 三个计数都是 0；同一组端口去掉 dryRun ⇒ 恰好各一次', async () => {
    const home = await tempDshHome()
    const dry = harnessFor(home, { policy: 'never' })
    const dryResult = await run(dry.tool, { ...ARGS, dryRun: true }, execFor())
    expectOk(dryResult)
    expect(dry.fs.markerWrites(), 'dryRun 写了 marker').toHaveLength(0)
    expect(dry.launchCalls, 'dryRun 拉起了').toHaveLength(0)
    expect(dry.exitCalls, 'dryRun 退出了').toHaveLength(0)
    expect(dry.requestCalls, 'dryRun 弹了审批窗').toHaveLength(0)

    // 反空转：同一组端口在 dryRun: false 下**必须**真的动 —— 否则上面那三个 0
    // 可能只是因为这条路径根本不碰那些端口。
    const real = harnessFor(home, { policy: 'never' })
    expectOk(await run(real.tool, ARGS, execFor()))
    expect(real.fs.markerWrites()).toHaveLength(1)
    expect(real.launchCalls).toHaveLength(1)
    // 退出排在结论之后，所以这里要先 flush 再数（否则量到的是「还没轮到退出」）。
    await flushDeferredExit()
    expect(real.exitCalls).toHaveLength(1)
  })

  it('dryRun 仍然报出「会跑哪条命令」（演练的全部价值就在这里）', async () => {
    const home = await tempDshHome()
    const h = harnessFor(home, { policy: 'never' })
    const result = await run(h.tool, { ...ARGS, dryRun: true }, execFor())
    const data = expectOk(result)
    expect(data.key['dryRun']).toBe(true)
    expect(data.key['markerWritten']).toBe(false)
    expect(String(data.key['relaunch'])).toContain('bin.js')
  })

  it('dryRun 的 nextStep **不指向错的工具**（B1：那个工具既没有 dryRun、也不会停宿主）', async () => {
    const home = await tempDshHome()
    const h = harnessFor(home, { policy: 'never' })
    const result = await run(h.tool, { ...ARGS, dryRun: true }, execFor())
    expectOk(result)
    const step = result.nextStep as
      { tool?: unknown; args?: unknown; manual?: unknown; why?: string } | undefined
    expect(step).toBeDefined()
    // 判据一（根因）：这一步**没有工具可调** —— 正确的下一步是「再调一次本工具、去掉 dryRun」。
    // 把这一支改回 `tool: dsh_check_effect_mode` 时，下面两条各自判红。
    expect(step?.tool, '演练支指向了工具 —— 那个工具没有 dryRun，也不会停任何宿主').toBeUndefined()
    expect(step?.manual).toBe(true)
    expect(step?.why).toContain('dsh_restart')
    expect(step?.why).toContain('dryRun')
    // 判据二：`change: 'config'` 是**硬编码**的（本工具根本没有 `change` 参数，演练时它
    // 不知道这次改动是哪一类）⇒ 不许再出现在这一步里。
    expect(JSON.stringify(step)).not.toContain('change')
    // 判据三（模型真正读到的那一层）：L3 里不许出现那个只读工具名。
    const text = renderText(h.tool, { ...ARGS, dryRun: true }, result)
    expect(text, '演练支的 L3 指向了不会停宿主的只读工具').not.toContain('dsh_check_effect_mode')
  })
})

// ── 6. `force` 只覆盖闸② ──────────────────────────────────────────────────

describe('dsh_restart · `force` 只覆盖闸②', () => {
  it('闸②：默认拒绝（含调用方自己的作业），force 才放行', async () => {
    const home = await tempDshHome()
    // 契约 §2.3 原话：**只**排除「调用方自己那个回合」，后台作业与定时提醒照旧全算
    // —— 包括属于调用方自己的那些。这一条正是「别漏成只查 running agents」的判据。
    const busy: Observed<readonly BusySource[]> = {
      known: true,
      value: [
        { kind: 'turn', sessionId: CALLER },
        { kind: 'job', jobId: 'job-1', ownerSession: CALLER },
      ],
    }
    const refused = harnessFor(home, { policy: 'never', busy })
    const failure = expectOk(await run(refused.tool, ARGS, execFor()))
    expect(failure.key['code']).toBe('busy')
    expect(refused.launchCalls, '闸②拒了却拉起了').toHaveLength(0)

    const forced = harnessFor(home, { policy: 'never', busy })
    const data = expectOk(await run(forced.tool, { ...ARGS, force: true }, execFor()))
    expect(data.key['forced']).toBe(true)
    expect(forced.launchCalls, 'force 没有放行闸②').toHaveLength(1)
    // 覆盖必须留痕：marker 里要有 force: true 与那条 override trace。
    expect(forced.fs.markerWrites()[0]?.text).toContain('"force": true')
  })

  it('①③④ 在 force: true 下**仍然**拒绝（签名里根本没有 force）', async () => {
    const home = await tempDshHome()
    const cases: Array<{ label: string; code: string; options: HarnessOptions }> = [
      {
        label: '闸① 冷却窗口内',
        code: 'restart-loop',
        options: { history: { known: true, value: [NOW - 1_000] } },
      },
      {
        label: '闸③ bundle 表解析不了',
        code: 'bad-composition',
        options: { bundles: { known: false, reason: 'no readable profile manifest' } },
      },
      {
        label: '闸④ 拿不到启动命令',
        code: 'no-launch-command',
        options: { launch: { known: false, reason: 'no relaunch route has been verified' } },
      },
    ]
    for (const item of cases) {
      const h = harnessFor(home, { policy: 'never', ...item.options })
      const result = await run(h.tool, { ...ARGS, force: true }, execFor())
      const data = expectOk(result)
      expect(data.key['code'], `${item.label}: force 把不可绕过的闸也绕过了`).toBe(item.code)
      expect(h.fs.markerWrites(), `${item.label}: 被拒却写了 marker`).toHaveLength(0)
      expect(h.launchCalls, `${item.label}: 被拒却拉起了`).toHaveLength(0)
      // 拒绝是**设计的一部分**：`ok: true`（工具完成了它的判定），但结论是「不许做」。
      expect(result.ok, `${item.label}: 闸门拒绝应当是 ok:true（拒绝不是失败）`).toBe(true)
    }
  })

  it('闸门拒绝**不是**失败：`ok: true` + 带动作的 nextStep + 原样报出 remedy', async () => {
    const home = await tempDshHome()
    const h = harnessFor(home, {
      history: { known: true, value: [NOW - 1_000] },
    })
    const result = await run(h.tool, ARGS, execFor())
    const data = expectOk(result)
    expect(data.verdict).toContain('restart-loop')
    expect(result.nextStep, '拒绝必须给出下一步（否则模型只能干等）').toBeDefined()
    const step = result.nextStep as { manual?: unknown; why?: string }
    expect(step.manual).toBe(true)
    expect(step.why).toBeTruthy()
  })

  it('闸②的 remedy **可兑现**（B3）：不许让模型「等那些跑完」——它观察不到阻塞者何时结束', async () => {
    const home = await tempDshHome()
    const busy: Observed<readonly BusySource[]> = {
      known: true,
      value: [{ kind: 'job', jobId: 'job-1', ownerSession: 'session-other' }],
    }
    const h = harnessFor(home, { policy: 'never', busy })
    const result = await run(h.tool, ARGS, execFor())
    const data = expectOk(result)
    expect(data.key['code']).toBe('busy')
    const why = String((result.nextStep as { why?: string } | undefined)?.why)
    // 判据一：把「等」交给**人**（本插件 8 个工具里没有一个是作业/回合/定时提醒的观察面）。
    expect(why).toContain('ask the user')
    // 判据二：可兑现的那半必须留着 —— force 真的会打断它们。
    expect(why).toContain('force: true')
    expect(why).toContain('interrupts them')
    // 判据三（根因）：旧话术必须消失 —— 模型照着「等」做只能盲重试，且分不清撞的是哪道闸。
    expect(why, 'remedy 让模型去「等」一个它观察不到的量').not.toContain('wait for those to finish')
    // 阻塞者的**类别**要说出来（job / turn / schedule 是它看得见的三类标签）。
    expect(why).toContain('background jobs')
    expect(why).toContain('schedules')
  })

  it('闸②取不到忙闲时的 remedy 同样可兑现（同族第二处）：不许「等服务可读」', async () => {
    const home = await tempDshHome()
    const h = harnessFor(home, {
      policy: 'never',
      busy: { known: false, reason: 'services missing' },
    })
    const result = await run(h.tool, ARGS, execFor())
    const data = expectOk(result)
    expect(data.key['code']).toBe('busy')
    const why = String((result.nextStep as { why?: string } | undefined)?.why)
    expect(why).toContain('ask the user')
    expect(why, '「服务可读了没有」不是模型能观察的量 —— 它只能盲重试').not.toContain(
      'retry once the agent and job services are readable',
    )
  })

  it('拉起失败：verdict 与 why 不许打架（S3：宿主还在跑，不是「去把它起回来」）', async () => {
    const home = await tempDshHome()
    const h = harnessFor(home, {
      policy: 'never',
      relaunch: { ok: false, reason: 'schtasks exited with code 1' },
    })
    const failure = expectFail(await run(h.tool, ARGS, execFor()))
    expect(failure.kind).toBe('command-failed')
    expect(failure.data.verdict, 'L1 没说清宿主还在跑').toContain('this host keeps running')
    const why = String((failure.nextStep as { why?: string } | undefined)?.why)
    // ⚠️ 根因：宿主**还在跑** ⇒ 下一步不是「把它起回来」（那与 L1 打架，模型会转述成
    // 「宿主已经没在跑了」），而是「什么时候方便再起」。
    expect(why, 'why 与 L1 打架').toContain('it is still running')
    expect(why).not.toContain('start the host again yourself')
  })
})

// ── 6b. 载体：没有回归路线的宿主在**动手之前**被拒 ─────────────────────────

/**
 * 2026-10-15 真机缺陷的根因判据：桌面宿主上 `dsh_restart` **拼得出一条命令**
 * （拼的还是另一个 profile），于是闸④放行、宿主退出、没人把它拉回来。
 *
 * 这一节的每一条都建在「**载体**这一维有没有被建模」上 —— 所以断言的是**计数**
 * （写 / 拉起 / 退出各为 0），不是「有没有报错」：拒绝**不是**失败（`ok: true`），
 * 于是「拒绝了但已经动手」在只看返回值时完全看不出来（本仓坑 40 的同族）。
 */
describe('dsh_restart · 载体：桌面宿主在动手之前被拒（零写 / 零拉起 / 零退出）', () => {
  it('桌面端 ⇒ no-relaunch-route；三条根因事实各有一断，且 L1 / L2 / L3 三层都说得清', async () => {
    const home = await tempDshHome()
    const desktop = carrierOf('desktop-host', 'win32')
    const h = harnessFor(home, { policy: 'never', carrier: desktop })
    const result = await run(h.tool, ARGS, execFor())
    // 闸门拒绝**不是**失败：工具这次的操作完成了（它正确地判了「不该做」）。
    expect(result.ok, '闸门拒绝应当是 ok:true').toBe(true)
    const data = expectOk(result)

    expect(data.key['gate']).toBe('launch-command')
    expect(data.key['code']).toBe('no-relaunch-route')
    // L2 的载体那一行是模型对上拒绝码的唯一依据。
    expect(data.key['carrier']).toBe('desktop-host')

    // 根因事实：**三条各有一断**。少了任何一条，「拒绝了却已经动手」都会漏过去。
    expect(h.fs.markerWrites(), '桌面端却写了 marker').toHaveLength(0)
    expect(h.launchCalls, '桌面端却拉起了新进程 —— 那正是真机缺陷的那一半').toHaveLength(0)
    expect(h.exitCalls, '桌面端却调了退出通道').toHaveLength(0)
    // 顺序：闸门全过才轮到审批门 ⇒ 这一格连档位都不该读。
    expect(h.requestCalls, '闸④拒了却弹了审批窗').toHaveLength(0)
    expect(h.policyCalls, '闸④拒了却读了审批档').toHaveLength(0)

    // L1 点名桌面那一档（逐字来自 `relaunchRefusalFor` 的唯一出处）。
    expect(data.verdict).toContain('Desktop')
    expect(data.verdict).toContain('no plugin-facing channel')
    // L3 是**人**的动作：桌面端只有壳能重启，而壳的入口是托盘。
    const step = result.nextStep as { manual?: unknown; why?: string } | undefined
    expect(step?.manual).toBe(true)
    expect(step?.why).toContain('tray')

    // L2（模型真正读的那一层）里看得见载体。
    const text = renderText(h.tool, ARGS, result)
    expect(text, 'L2 里看不见载体 —— 模型对不上 no-relaunch-route 的成因').toContain(
      'carrier: desktop-host',
    )
    // `audit` 里给复核的是**可无损落 JSON** 的投影（不是活的观测对象）。
    expect(data.audit['carrier']).toEqual(carrierAuditOf(desktop))
    // evidence 带上了三行机器码（人复核「凭什么判成这一档」）。
    const evidence = data.audit['evidence'] as string[]
    expect(evidence.some((line) => line.startsWith('carrier: '))).toBe(true)
    expect(evidence.some((line) => line.startsWith('rule: '))).toBe(true)
  })

  it('`unknown` 与 `cli × linux` / `darwin` 同样拒绝，且三档「人能做什么」彼此可分', async () => {
    const home = await tempDshHome()
    const cases: ReadonlyArray<{
      label: string
      carrier: CarrierObservation
      marker: string
      /** L3 必须含的那句 —— 每档**自己的** remedy（三档措辞的唯一出处是 `relaunchRefusalFor`）。 */
      why: string
      /** L3 里**不许**出现的那几句：串档就是把「人能做什么」压成了同一句。 */
      notWhy: readonly string[]
    }> = [
      {
        label: '认不出来',
        carrier: carrierOf('unknown', 'win32'),
        marker: 'could not be identified',
        why: 'does not guess',
        notWhy: ['tray', 'has been measured'],
      },
      {
        label: 'cli × linux',
        carrier: carrierOf('cli', 'linux'),
        marker: 'linux',
        why: 'has been measured',
        notWhy: ['tray', 'does not guess'],
      },
      {
        label: 'cli × darwin',
        carrier: carrierOf('cli', 'darwin'),
        marker: 'darwin',
        why: 'has been measured',
        notWhy: ['tray', 'does not guess'],
      },
    ]
    for (const item of cases) {
      // 前置：这张表本身必须真的没有路线。
      expect(relaunchRouteFor(item.carrier), `${item.label}: 路线表与用例不一致`).toBe('none')
      const h = harnessFor(home, { policy: 'never', carrier: item.carrier })
      const result = await run(h.tool, ARGS, execFor())
      const data = expectOk(result)
      expect(data.key['code'], `${item.label}: 拒绝码不是 no-relaunch-route`).toBe(
        'no-relaunch-route',
      )
      expect(data.verdict, `${item.label}: 文案串档了`).toContain(item.marker)
      expect(h.fs.markerWrites(), `${item.label}: 被拒却写了 marker`).toHaveLength(0)
      expect(h.launchCalls, `${item.label}: 被拒却拉起了`).toHaveLength(0)
      expect(h.exitCalls, `${item.label}: 被拒却退出了`).toHaveLength(0)
      // L3：非 Windows 那两档的**唯一**判据落点。此前只有库层用例逐字比对了 `relaunchRefusalFor`，
      // 「库层那两句 → 工具层 `nextStep.why`」这一跳对这两档是空的（桌面档有，见上面那条）。
      // ⇒ 非 Windows 用户撞到拒绝时，拿到的那句「怎么办」从来没被断过。
      //
      // ⚠️ 本用例在**任意平台**都成立，故**不用** `withPlatform`：平台取自显式传入的载体观测
      // （`carrierOf`），而 `launchCommand` 那一跳在路线为 `none` 时根本不会被执行（闸④先拒）
      // —— 坑 25 管的是「按**真实** `process.platform` 分岔」的断言，这条不属那一族。
      const step = result.nextStep as { manual?: unknown; why?: string } | undefined
      expect(step?.manual, `${item.label}: 三档都必须是人的动作`).toBe(true)
      const why = String(step?.why ?? '')
      expect(why, `${item.label}: why 没接上 remedy`).toContain(item.why)
      for (const forbidden of item.notWhy) {
        expect(why, `${item.label}: why 串到别档（出现了 ${forbidden}）`).not.toContain(forbidden)
      }
    }
  })

  it('反空转：同一组端口换成 `cli × win32` ⇒ 写 / 拉起 / 退出各一次（否则上面那些 0 可能只是「这条路什么都不做」）', async () => {
    const home = await tempDshHome()
    const h = harnessFor(home, { policy: 'never', carrier: carrierOf('cli', 'win32') })
    const result = await run(h.tool, ARGS, execFor())
    const data = expectOk(result)
    expect(data.key['carrier']).toBe('cli')
    // `cli` 是默认路径、没有信息量 ⇒ L2 里**不印**（照 `restartEnabled` 只在为假时印的先例）。
    expect(renderText(h.tool, ARGS, result)).not.toContain('carrier: cli')
    expect(h.fs.markerWrites()).toHaveLength(1)
    expect(h.launchCalls).toHaveLength(1)
    await flushDeferredExit()
    expect(h.exitCalls).toEqual([0])
  })

  it('dryRun 也一样被拒（演练走的是同一个入口 —— 它**不是**后门）', async () => {
    const home = await tempDshHome()
    const h = harnessFor(home, { policy: 'never', carrier: carrierOf('desktop-host', 'win32') })
    const data = expectOk(await run(h.tool, { ...ARGS, dryRun: true }, execFor()))
    expect(data.key['code']).toBe('no-relaunch-route')
    expect(data.key['stage']).toBe('gates')
    expect(h.fs.markerWrites()).toHaveLength(0)
    expect(h.launchCalls).toHaveLength(0)
    expect(h.exitCalls).toHaveLength(0)
  })

  it('载体来自 `deps`（装配点注入）而不是工具自己现探：换掉 deps 的载体，同一个工具对象给出另一个结论', async () => {
    const home = await tempDshHome()
    const config = configFor(home, { enableRestart: volatileOf(true) })
    const ports = harnessFor(home, { policy: 'never' }).ports
    const host: RestartHost = {
      ports,
      approval: { policyOf: () => 'never', request: async () => 'allowed-once' },
      launch: { relaunch: async () => ({ ok: true, detail: 'stub' }) },
      exit: { exit: () => () => undefined },
    }
    // ⚠️ 显式对象构造（坑 40）：替身被静默丢掉时「没生效」与「生效了」在绿的时候一样。
    const desktopTool = createRestartTool({
      ...depsFor(config, { carrier: carrierOf('desktop-host', 'win32') }),
      restart: host,
    })
    const cliTool = createRestartTool({
      ...depsFor(config, { carrier: carrierOf('cli', 'win32') }),
      restart: host,
    })
    // 反空转的第一步：两个工具对象**必须给出不同结论**，否则「载体被读到了」没被证明。
    expect(expectOk(await run(desktopTool, ARGS, execFor())).key['code']).toBe('no-relaunch-route')
    expect(expectOk(await run(cliTool, ARGS, execFor())).key['code']).toBeUndefined()
  })

  it('**每一条**返回路径的 `audit` 都带载体投影（下界：7 条互不相同的路径 + 一次 JSON 往返）', async () => {
    // 为什么是「每一条」：`audit` 不进模型文本，它唯一的消费者是**事后复核的人**。
    // 只覆盖成功那一格时，「被拒了为什么」在 `audit` 里查不到 —— 而这个工具的拒绝
    // **会**由载体决定。下界写的是「至少 7 条路径」，且每条都断言投影**在场**。
    const home = await tempDshHome()
    const paths: ReadonlyArray<{ label: string; options: HarnessOptions; args: unknown }> = [
      { label: '成功（闸门全过 + 拉起 + 退出）', options: { policy: 'never' }, args: ARGS },
      {
        label: '闸④ 拒绝（桌面端）',
        options: { policy: 'never', carrier: carrierOf('desktop-host', 'win32') },
        args: ARGS,
      },
      {
        label: '闸① 拒绝',
        options: { policy: 'never', history: { known: true, value: [NOW - 1_000] } },
        args: ARGS,
      },
      { label: 'dryRun', options: { policy: 'never' }, args: { ...ARGS, dryRun: true } },
      { label: '审批档读不出来', options: { policy: undefined }, args: ARGS },
      { label: '端口抛异常', options: { portThrows: 'busy' }, args: ARGS },
      {
        label: '总闸关着',
        options: { policy: 'never', config: { enableRestart: volatileOf(false) } },
        args: ARGS,
      },
    ]
    const seen: string[] = []
    for (const item of paths) {
      const h = harnessFor(home, item.options)
      const result = await run(h.tool, item.args, execFor())
      const data = (result as unknown as { data: { audit: Record<string, unknown> } }).data
      seen.push(item.label)
      expect(data.audit['carrier'], `${item.label}: audit 里没有载体投影`).toBeDefined()
      // 宿主边界：`audit` 要能无损落 JSON（`profile` 取不到时那个键整个不印）。
      expect(
        JSON.parse(JSON.stringify(data.audit)),
        `${item.label}: audit 过不了 JSON 往返`,
      ).toEqual(data.audit)
    }
    // 下界自证：这七条**必须**真的都跑过（否则循环里少一条也没人发现）。
    expect(seen).toHaveLength(paths.length)
    expect(new Set(seen).size, '用例标签重复 ⇒ 覆盖面比看起来小').toBe(paths.length)
  })
})

// ── 7. 沙箱被拒要可诊断 ────────────────────────────────────────────────────

describe('dsh_restart · 文件沙箱拒绝要可诊断', () => {
  it('FS_SANDBOX_DENIED ⇒ 结构化失败，且说清「要 danger-full-access」', async () => {
    const home = await tempDshHome()
    const fs = makeFs({
      failWriteWith: {
        code: 'FS_SANDBOX_DENIED',
        message: 'FS_SANDBOX_DENIED: cannot write outside the writable roots',
      },
    })
    const h = harnessFor(home, { policy: 'never', fs })
    const failure = expectFail(await run(h.tool, ARGS, execFor()))
    expect(failure.kind).toBe('not-configured')
    expect(failure.data.verdict).toContain('FS_SANDBOX_DENIED')
    expect(failure.data.verdict).toContain('file sandbox')
    expect(String((failure.nextStep as { why?: string } | undefined)?.why)).toContain(
      'danger-full-access',
    )
    // 沙箱拒了 ⇒ 绝不许拉起（否则就是「没有 marker 的重启」）。
    expect(h.launchCalls).toHaveLength(0)
    expect(h.exitCalls).toHaveLength(0)
  })

  it('非沙箱的写失败 ⇒ 因果是「写 marker 失败」，不是「闸门检查出错」（S6）', async () => {
    const home = await tempDshHome()
    const fs = makeFs({
      failWriteWith: { code: 'FS_IO_ERROR', message: 'FS_IO_ERROR: the disk went away' },
    })
    const h = harnessFor(home, { policy: 'never', fs })
    const failure = expectFail(await run(h.tool, ARGS, execFor()))
    expect(failure.kind).toBe('internal')
    // ⚠️ 根因：四道闸**全过**了（走到写那一步才炸）⇒ 不许说「闸门检查出错」。
    expect(failure.data.verdict, '写失败被归因到闸门检查上了').not.toContain('gate check')
    expect(failure.data.verdict).toContain('marker write failed')
    // ⚠️ 也不许断言「什么都没写」：端口契约只要求「失败要抛」，**没有原子性承诺**
    // ⇒ 部分落盘是可能的。能确定的是「没有拉起」。
    expect(failure.data.verdict, '写失败却断言「什么都没写」—— 那是端口没承诺的事').not.toContain(
      'nothing was written',
    )
    expect(failure.data.verdict).toContain('nothing was relaunched')
    // 根因事实：写失败 ⇒ 零拉起、零退出。
    expect(h.launchCalls).toHaveLength(0)
    expect(h.exitCalls).toHaveLength(0)
    expect(h.fs.markerWrites()).toHaveLength(0)
  })
})

// ── 8. `decideRecovery` 的两个 `none` 必须分开 ─────────────────────────────

describe('dsh_restart · 重启历史：absent 与 consumed 必须给出不同的取值', () => {
  it('absent ⇒ 空历史；consumed ⇒ 仍是**一条**重启记录（合并它 = 静默丢掉一次冷却）', async () => {
    const absent = makeFs()
    const absentHistory = await restartHistoryFrom(absent.port, 'C:/home')
    expect(absentHistory).toEqual({ known: true, value: [] })

    const consumed = makeFs({ seed: markerText({ state: 'consumed' }) })
    const consumedHistory = await restartHistoryFrom(consumed.port, 'C:/home')
    expect(consumedHistory.known).toBe(true)
    expect(consumedHistory.known && consumedHistory.value).toEqual([NOW])
    // 防空转：两者必须**取值不同** —— 把 `switch (action)` 写成不看 `reason` 就会在这里红。
    expect(JSON.stringify(consumedHistory)).not.toBe(JSON.stringify(absentHistory))

    // `armed` 那份同样是历史（还没消费 ≠ 没发生过）。
    const armed = makeFs({ seed: markerText() })
    const armedHistory = await restartHistoryFrom(armed.port, 'C:/home')
    expect(armedHistory).toEqual({ known: true, value: [NOW] })
  })

  it('读不到 / 格式坏 / 版本不认识 ⇒ known:false（**不是**空历史：那会把「取不到」印成「没重启过」）', async () => {
    const cases: Array<{ label: string; seed: string }> = [
      { label: '格式坏', seed: 'not json at all' },
      { label: '版本不认识', seed: markerText({ version: 99 }) },
    ]
    for (const item of cases) {
      const history = await restartHistoryFrom(makeFs({ seed: item.seed }).port, 'C:/home')
      expect(history.known, `${item.label}: 被当成了「没有重启历史」`).toBe(false)
      expect(JSON.stringify(history)).not.toBe(JSON.stringify({ known: true, value: [] }))
    }
    // 读失败（端口抛）同样不是空历史。
    const throwing: RestartFsPort = {
      read: async () => {
        throw new Error('FS_PERMISSION_DENIED')
      },
      write: async () => undefined,
    }
    expect((await restartHistoryFrom(throwing, 'C:/home')).known).toBe(false)
  })
})

// ── 9. 顺序：先过闸门，再问审批 ────────────────────────────────────────────

describe('dsh_restart · 顺序：闸门全过之后才轮到审批门', () => {
  it('闸③ / 闸④ 拒绝时，审批替身**零调用**', async () => {
    const home = await tempDshHome()
    const cases: Array<{ label: string; options: HarnessOptions }> = [
      { label: '闸③', options: { bundles: { known: false, reason: 'unreadable' } } },
      { label: '闸④', options: { launch: { known: false, reason: 'unknown route' } } },
      { label: '闸①', options: { history: { known: false, reason: 'unreadable' } } },
      { label: '闸②', options: { busy: { known: false, reason: 'services missing' } } },
    ]
    for (const item of cases) {
      // 档位是 `ask` —— 若实现「先问审批」，这里就会弹窗。
      const h = harnessFor(home, { policy: 'ask', ...item.options })
      expectOk(await run(h.tool, ARGS, execFor()))
      expect(h.requestCalls, `${item.label} 拒绝时却弹了审批窗（顺序反了）`).toHaveLength(0)
      expect(h.policyCalls, `${item.label} 拒绝时却读了审批档`).toHaveLength(0)
    }
  })
})

// ── 10. 拉起命令可复核 ─────────────────────────────────────────────────────

describe('dsh_restart · 拉起的命令可复核', () => {
  it('`key.relaunch` 是**目标命令**；`/tr` 只指向启动器，两者都在 key 里能对上', async () => {
    const home = await tempDshHome()
    const h = harnessFor(home, { policy: 'never' })
    const result = await run(h.tool, ARGS, execFor())
    const data = expectOk(result)
    const relaunch = String(data.key['relaunch'])
    expect(relaunch).toContain('bin.js')
    expect(relaunch).toContain('--profile web')
    // 新宿主必须看到**同一个** home（计划任务不继承本进程的环境变量）。
    expect(relaunch).toContain(home)
    expect(h.launchCalls).toHaveLength(1)
    // ⚠️ 交给拉起端口的**不是**那条目标命令，而是启动器调用（2026-10-17 起）：
    // 目标命令进了脚本文件，`/tr` 只指它 —— 这样引号不过 `schtasks` 的存储/重放两跳。
    const tr = String(h.launchCalls[0]?.commandLine)
    expect(tr).toContain('wscript.exe')
    expect(tr).toContain('relaunch.vbs')
    expect(tr, '目标命令不该再出现过 /tr 里').not.toContain('bin.js')
    // 渲染文本里也要有（L2 才是模型真正读的那一层）。
    expect(renderText(h.tool, ARGS, result)).toContain('bin.js')
  })

  it('落盘的启动器脚本：设 home → 进工作目录 → 起宿主，且**不含**说明性文字', async () => {
    const home = await tempDshHome()
    const h = harnessFor(home, { policy: 'never' })
    await run(h.tool, ARGS, execFor())
    const script = h.fs.writes.find((entry) => entry.path.endsWith('relaunch.vbs'))
    expect(script, '启动器脚本没落盘 —— `/tr` 指的就是它').toBeDefined()
    const vbs = String(script?.text)
    expect(h.launchCalls[0]?.commandLine).toContain(String(script?.path))
    // 目标命令行逐字进脚本（VBS 里 `"` 写成 `""`，所以比较的是去转义后的形状）。
    expect(vbs).toContain(`set ""DSH_HOME=${home}""`)
    expect(vbs).toContain('cd /d C:/repo')
    expect(vbs).toContain('node bin.js --profile web')
    // 隐藏执行：窗口样式 0（这是**没有可见控制台**的那一刀）。
    expect(vbs).toContain('sh.Run target, 0, False')
    // WMI moniker 必须是无路径形态：写成 `winmgmts:\\.\root\cimv2` 时 TS 会把 `\r`
    // 解释成回车，生成出一条坏 moniker（lint 的 no-useless-escape 抓过一次）。
    expect(vbs).toContain('GetObject("winmgmts:")')
    expect(vbs, 'moniker 里带反斜杠 = 踩了 TS 转义').not.toMatch(/winmgmts:\\/u)
    expect(vbs, 'moniker 里混进了真回车').not.toMatch(/winmgmts:[\r\n]/u)
    // 脚本第一步就写日志 —— 脚本写坏 = 静默不启动，靠这份日志分开「没跑」与「跑了失败」。
    expect(vbs).toContain('Say "launcher started')
    expect(vbs, '启动器里掺了给人看的括注').not.toContain('(cwd')
    expect(vbs, '启动器里出现了给人看的 home 括注').not.toContain('home ')
  })

  it('等待是**上限**：进脚本的是 capMs 与旧进程号，不再是命令行里的 `ping -n`', async () => {
    const home = await tempDshHome()
    const h = harnessFor(home, { policy: 'never' })
    await run(h.tool, { ...ARGS, delayMs: 30_000 }, execFor())
    expect(h.launchCalls[0]?.delayMs).toBe(30_000)
    const vbs = String(h.fs.writes.find((entry) => entry.path.endsWith('relaunch.vbs'))?.text)
    expect(vbs).toContain('capMs = 30000')
    expect(vbs).toContain(`oldPid = ${String(process.pid)}`)
    expect(vbs, '固定睡眠应已被 PID 等待取代').toContain('Do While waited < capMs')
    expect(String(h.launchCalls[0]?.commandLine)).not.toContain('ping')
    expect(h.launchCalls[0]?.budgetMs).toBeGreaterThan(0)
  })
})

// ── 11. 接线：走完整入口 ───────────────────────────────────────────────────

describe('dsh_restart · 接线断言（坑 42）', () => {
  it('走完整入口一遍：真实 marker 读写 → 拉起 → 退出，且顺序被钉住', async () => {
    const home = await tempDshHome()
    const fs = makeFs()
    // 用**真的** `restartHistoryFrom`（它读的就是这份 fs），而不是再给一个常量历史。
    const h = harnessFor(home, { policy: 'never', fs })
    const wired: RestartPorts = {
      ...h.ports,
      restartHistory: async () => await restartHistoryFrom(fs.port, home),
    }
    // 这一条走的是「开关**开**着」的完整链路（默认关那一格见第 22 节），所以显式打开。
    // 载体同样显式给（闸④ 的第一问；不给就走 fail-closed 的 `UNKNOWN_CARRIER`）。
    const deps = depsFor(configFor(home, { enableRestart: volatileOf(true) }), {
      carrier: carrierOf('cli', 'win32'),
    })
    const tool = createRestartTool({
      ...deps,
      restart: {
        ports: wired,
        approval: { policyOf: () => 'never', request: async () => 'allowed-once' },
        launch: {
          relaunch: async (request) => {
            h.launchCalls.push(request)
            h.writesAtLaunch.push(fs.markerWrites().length)
            return { ok: true, detail: 'stub' }
          },
        },
        exit: {
          exit: () => (code: number) => {
            h.writesAtExit.push(fs.markerWrites().length)
            h.exitCalls.push(code)
          },
        },
      },
    })

    const result = await run(tool, ARGS, execFor())
    const data = expectOk(result)
    expect(data.key['stage']).toBe('exit')
    expect(fs.markerWrites()).toHaveLength(1)
    // 顺序是判据：拉起与退出**被调用时**，marker 已经写完（各 1 次）。
    expect(h.writesAtLaunch).toEqual([1])
    expect(h.exitCalls, '退出排在结论之前 ⇒ 真机上 verdict 不会落盘').toEqual([])
    // 结论已到（`execute` resolve）而退出还没发生 ⇒ 退出必然排在下一 tick。
    await flushDeferredExit()
    expect(h.writesAtExit).toEqual([1])
    expect(h.exitCalls).toEqual([0])
    // 落盘的那份 marker 真的是一份能被读回来的 marker（不是「看着写了」）。
    const written = fs.content() ?? ''
    expect(written).toContain('"version": 1')
    expect(written).toContain('"state": "armed"')
    expect(await restartHistoryFrom(fs.port, home)).toEqual({ known: true, value: [NOW] })
  })
})

// ── 12. 拉起端口：计划任务（显式钉平台） ───────────────────────────────────

describe('dsh_restart · 计划任务拉起（平台显式钉住）', () => {
  it('win32：/create（含那条命令行）→ /run，两条都 exit 0 才算成功', async () => {
    const calls: RunCommandOptions[] = []
    const spawn: SpawnImpl = async (options) => {
      calls.push(options)
      return { code: 0, stdout: '', stderr: '', timedOut: false, aborted: false }
    }
    const request: RelaunchRequest = {
      command: 'node',
      args: ['bin.js', '--profile', 'web'],
      cwd: 'C:/repo',
      commandLine: 'cmd /c set "DSH_HOME=C:/home" && ping -n 11 127.0.0.1 & node bin.js',
      delayMs: 10_000,
      budgetMs: 5_000,
    }
    // ⚠️ **构造 + 执行**整段都在 withPlatform 里（本仓刚在 CI 上踩过：只包构造等于没钉）。
    const result = await withPlatform(
      'win32',
      async () => await relaunchViaTaskScheduler(spawn, request),
    )
    expect(result.ok).toBe(true)
    expect(calls.map((call) => call.command)).toEqual(['schtasks', 'schtasks'])
    expect(calls[0]?.args).toContain('/create')
    expect(calls[0]?.args).toContain(request.commandLine)
    expect(calls[1]?.args).toEqual(['/run', '/tn', 'dsh-plugin-debugging-restart'])
    expect(calls.every((call) => call.timeoutMs === request.budgetMs)).toBe(true)
  })

  it('win32：非零退出 / spawn 失败 / 超时 ⇒ 可诊断的失败（不抛）', async () => {
    const cases: Array<{ label: string; answer: CommandResult; expect: string }> = [
      {
        label: '非零退出',
        answer: {
          code: 1,
          stdout: '',
          stderr: 'ERROR: access denied',
          timedOut: false,
          aborted: false,
        },
        expect: 'access denied',
      },
      {
        label: 'spawn 失败',
        answer: {
          code: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          aborted: false,
          spawnError: 'spawn: ENOENT',
        },
        expect: 'ENOENT',
      },
      {
        label: '超时',
        answer: { code: null, stdout: '', stderr: '', timedOut: true, aborted: false },
        expect: 'timed out',
      },
    ]
    const request: RelaunchRequest = {
      command: 'node',
      args: [],
      cwd: 'C:/repo',
      commandLine: 'node bin.js',
      delayMs: 0,
      budgetMs: 5_000,
    }
    for (const item of cases) {
      const spawn: SpawnImpl = async () => item.answer
      const result = await withPlatform(
        'win32',
        async () => await relaunchViaTaskScheduler(spawn, request),
      )
      expect(result.ok, `${item.label}: 竟然成功了`).toBe(false)
      expect(result.ok === false && result.reason, `${item.label}: 失败原因不可诊断`).toContain(
        item.expect,
      )
    }
  })

  it('别的平台：没有已实测的路线 ⇒ 不拉起、不抛（并说出是哪个平台）', async () => {
    let spawned = 0
    const spawn: SpawnImpl = async () => {
      spawned += 1
      return { code: 0, stdout: '', stderr: '', timedOut: false, aborted: false }
    }
    const result = await withPlatform(
      'linux',
      async () =>
        await relaunchViaTaskScheduler(spawn, {
          command: 'node',
          args: [],
          cwd: '/repo',
          commandLine: 'node bin.js',
          delayMs: 0,
          budgetMs: 5_000,
        }),
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('linux')
    expect(spawned, 'linux 上竟然起了子进程').toBe(0)
  })

  it('闸④ 的取值面也按「平台 × 载体」分：win32 定得出命令，别的平台判「拿不到」（构造 + 执行都在钉住的平台里）', async () => {
    const config = configFor('C:/home', { profile: 'web' })
    // ⚠️ 第二参是**载体观测**（不是平台）：平台由 `carrierOf(..., platform)` 注入 ⇒
    // 下面两条断言的是「平台 × 载体」这张表，而不是「函数的第二个参数恰好是什么」。
    const win = await withPlatform('win32', () =>
      launchCommandFrom(config, carrierOf('cli', 'win32')),
    )
    expect(win.known).toBe(true)
    expect(win.known && win.value.args).toContain('--profile')

    const linux = await withPlatform('linux', () =>
      launchCommandFrom(config, carrierOf('cli', 'linux')),
    )
    expect(linux.known, 'linux 上竟然定出了启动命令 —— 那条路线没有实测过').toBe(false)
    expect(linux.known === false && linux.reason).toContain('linux')

    // 纵深防御（2026-10-16）：桌面宿主连命令都不给 —— 而且**与进程平台无关**
    // （桌面端在任何平台上都没有插件可用的重启通道）。
    for (const platform of ['win32', 'darwin'] as const) {
      const desktop = await withPlatform(platform, () =>
        launchCommandFrom(config, carrierOf('desktop-host', platform)),
      )
      expect(desktop.known, `${platform}: 桌面宿主竟然定出了启动命令`).toBe(false)
      if (desktop.known) throw new Error('期望 known: false')
      expect(desktop.reason, `${platform}: 桌面端那一句没带出来`).toContain('Desktop')
    }
  })

  it('预算已耗尽（budgetMs = 0）⇒ 直接失败，不起子进程', async () => {
    let spawned = 0
    const spawn: SpawnImpl = async () => {
      spawned += 1
      return { code: 0, stdout: '', stderr: '', timedOut: false, aborted: false }
    }
    const result = await withPlatform(
      'win32',
      async () =>
        await relaunchViaTaskScheduler(spawn, {
          command: 'node',
          args: [],
          cwd: 'C:/repo',
          commandLine: 'node bin.js',
          delayMs: 0,
          budgetMs: 0,
        }),
    )
    expect(result.ok).toBe(false)
    expect(spawned).toBe(0)
  })
})

// ── 13. 忙闲收集：三个来源一个都不许漏 ─────────────────────────────────────

describe('dsh_restart · 闸②的忙闲收集覆盖 turn / job / schedule', () => {
  /** 一个结构化的宿主上下文替身。 */
  function busyCtx(
    options: {
      agents?: boolean
      jobs?: boolean
      waterfall?: boolean
      /**
       * `workspace/session-activity` 的监听者数。
       *
       * 默认 1（有提供方）；`0` = 组合里没有监听者；`null` = **连监听者表都读不出来**
       * （不提供 `events`）。后两格都必须判 `known:false` —— 这正是复核抓到的那个缺口。
       */
      activityListeners?: number | null
      /** `agents.list()` 的返回值（默认两个会话，一个 running）。 */
      liveAgents?: readonly Record<string, unknown>[]
      /** `jobs.list()` 的返回值（默认一个在跑的无属主作业）。 */
      jobRecords?: readonly Record<string, unknown>[]
      /** 让 waterfall **答空**（用来钉「有监听者 + 确实没有活动 ⇒ known:true」）。 */
      emptyActivity?: boolean
    } = {},
  ): unknown {
    const includeAgents = options.agents !== false
    const includeJobs = options.jobs !== false
    const includeWaterfall = options.waterfall !== false
    const listenerCount = options.activityListeners === undefined ? 1 : options.activityListeners
    return {
      get: (name: string) => {
        if (name === 'agents' && includeAgents) {
          return {
            list: () =>
              options.liveAgents ?? [
                { id: 'session-a', status: 'running' },
                { id: 'session-b', status: 'idle' },
              ],
          }
        }
        if (name === 'jobs' && includeJobs) {
          return {
            list: () => options.jobRecords ?? [{ id: 'job-unowned', status: 'running' }],
          }
        }
        return undefined
      },
      ...(includeWaterfall
        ? {
            waterfall: async (_name: string, request: { sessionId: string }) =>
              options.emptyActivity === true
                ? []
                : request.sessionId === 'session-b'
                  ? [{ kind: 'schedule', items: [{ id: 'sched-1' }] }]
                  : [{ kind: 'job', items: [{ id: 'job-a' }] }],
          }
        : {}),
      // ⚠️ 真实形状里 `ctx.events._hooks` 就是**监听者表**（`waterfallOf` 靠它分
      // 「没组合提供方」与「提供方答空」）。夹具不给它 = 第三源恒判 known:false
      // —— 与坑 40 同族：夹具与真实形状不一致，判据测的就不是那条路。
      ...(listenerCount === null
        ? {}
        : {
            events: {
              _hooks: {
                'workspace/session-activity': Array.from({ length: listenerCount }, () => ({})),
              },
            },
          }),
    }
  }

  it('三类来源都在：回合 / 作业（含属主）/ 定时提醒 / 无属主作业', async () => {
    const observed = await busySourcesFrom(busyCtx())
    expect(observed.known).toBe(true)
    if (!observed.known) throw new Error('期望 known')
    const labels = observed.value.map((source) =>
      source.kind === 'turn'
        ? `turn:${source.sessionId}`
        : source.kind === 'job'
          ? `job:${source.jobId}${source.ownerSession === undefined ? '' : `@${source.ownerSession}`}`
          : `schedule:${source.scheduleId}@${source.ownerSession ?? ''}`,
    )
    expect(labels).toContain('turn:session-a')
    expect(labels).toContain('job:job-a@session-a')
    expect(labels).toContain('schedule:sched-1@session-b')
    expect(labels).toContain('job:job-unowned')
  })

  it('无属主作业按 C6 过滤 `status`：跑完的（completed）**不算忙**，running / stopping 才算', async () => {
    // 这是「合法重启被永久拒到用户手填 force」那条真缺陷的护栏：`jobs.list()` 返回**全部**
    // 记录（删除只发生在 remove 族），跑完的会一直留着。
    const observed = await busySourcesFrom(
      busyCtx({
        jobRecords: [
          { id: 'job-running', status: 'running' },
          { id: 'job-stopping', status: 'stopping' },
          { id: 'job-done', status: 'completed' },
          { id: 'job-killed', status: 'killed' },
          { id: 'job-failed', status: 'failed' },
        ],
      }),
    )
    expect(observed.known).toBe(true)
    if (!observed.known) throw new Error('期望 known')
    const jobIds = observed.value.flatMap((source) => (source.kind === 'job' ? [source.jobId] : []))
    expect(jobIds).toContain('job-running')
    expect(jobIds).toContain('job-stopping')
    // 防空转：这三条**必须**被滤掉，否则上面两条对「一个不过滤的实现」也是绿的。
    expect(jobIds, '跑完的作业被当成忙 —— 合法重启会被永久拒').not.toContain('job-done')
    expect(jobIds).not.toContain('job-killed')
    expect(jobIds).not.toContain('job-failed')
  })

  it('subagent 后代经 `agents.list()` 就可见（复核那条「对闸②不可见」**已证伪**）', async () => {
    // 复核当时是推断。宿主源码（`[已核]`）：`dsh-agent` 的注册表服务名就是 `agents`，
    // `list()` 返回**全部** `store.values()`（不按 owner 过滤）；`dsh-subagent` 建后代走
    // `ctx.agents.create({ parentAgent })`，所以后代在同一个 store 里；后代的 `status`
    // 在回合内就是 'running'（`dsh-agent-loop` 的 `get status()`）—— 与 `dsh-subagent`
    // 自己算 `runningDescendants` 用的是**同一个判据**。
    const observed = await busySourcesFrom(
      busyCtx({
        // 只有那个 subagent 后代在跑；其余会话都是 idle。
        liveAgents: [
          { id: 'session-parent', status: 'idle' },
          { id: 'session-child', status: 'running' },
        ],
        jobRecords: [],
        emptyActivity: true,
      }),
    )
    expect(observed.known).toBe(true)
    if (!observed.known) throw new Error('期望 known')
    const labels = observed.value.map((source) =>
      source.kind === 'turn' ? `turn:${source.sessionId}` : source.kind,
    )
    expect(labels, '正在跑的 subagent 后代没有被计成阻塞者').toContain('turn:session-child')
  })

  it('第三源是三值的：没有监听者 / 监听者表读不出来 ⇒ known:false；有监听者但答空 ⇒ known:true', async () => {
    // 「没组合那个提供方」与「确实没有活动」必须分得开（复核抓到的缺口）。
    const noListener = await busySourcesFrom(busyCtx({ activityListeners: 0 }))
    expect(noListener.known, '没有监听者却被当成「不忙」').toBe(false)
    expect(JSON.stringify(noListener)).not.toBe(JSON.stringify({ known: true, value: [] }))

    const unreadable = await busySourcesFrom(busyCtx({ activityListeners: null }))
    expect(unreadable.known, '监听者表读不出来却被当成「不忙」').toBe(false)

    // 反面：**有**监听者、但答案确实是空的 ⇒ known:true + 空来源（不是 known:false）。
    const empty = await busySourcesFrom(
      busyCtx({
        liveAgents: [{ id: 'session-idle', status: 'idle' }],
        jobRecords: [],
        emptyActivity: true,
      }),
    )
    expect(empty.known, '有监听者却被当成「没有提供方」').toBe(true)
    expect(empty.known && empty.value).toEqual([])
  })

  it('三个服务面缺任何一个 ⇒ known:false（fail-closed，不是「不忙」）', async () => {
    const cases: Array<{ label: string; ctx: unknown }> = [
      { label: '没有 agents', ctx: busyCtx({ agents: false }) },
      { label: '没有 jobs', ctx: busyCtx({ jobs: false }) },
      { label: '没有 waterfall', ctx: busyCtx({ waterfall: false }) },
    ]
    for (const item of cases) {
      const observed = await busySourcesFrom(item.ctx)
      expect(observed.known, `${item.label}: 被当成了「不忙」`).toBe(false)
      expect(JSON.stringify(observed)).not.toBe(JSON.stringify({ known: true, value: [] }))
    }
  })

  it('真实 cordis 形状下也分得开：真 ctx 有监听者 ⇒ known:true；换一个 ctx 注册 ⇒ 读得到', async () => {
    // ⚠️ 上面那些用的都是**手搓夹具**（坑 40 的另一种形态：夹具与真实形状不一致时，
    // 判据测的不是那条路）。这一条用**真的** `@deepseek-ai/cordis` 的 `Context`：
    // 在**子 ctx** 上注册监听者，再从**父 ctx** 读 `_hooks` —— 这正是宿主里
    // 「提供方在自己的 ctx 上注册、我们在插件 ctx 上数」的那个形状。
    const root = new Context()
    // `provide`（不是 `set`）：`set` 只能改一个**已经被 provide 过**的服务（实测报
    // `cannot set property "agents" without provide`）。
    root.provide('agents', { list: () => [{ id: 'session-a', status: 'idle' }] })
    root.provide('jobs', { list: () => [] })
    // `workspace/session-activity` 不在基座 `Events` 里（它由宿主包做模块增强）⇒
    // 按**结构面**注册 —— 宿主里那几个提供方自己也是这么挂的。
    const provider = root.extend() as unknown as {
      on(
        name: string,
        listener: (
          request: unknown,
          next: () => Promise<readonly unknown[]>,
        ) => Promise<readonly unknown[]>,
      ): unknown
    }
    provider.on('workspace/session-activity', async (_request, next) => await next())

    const observed = await busySourcesFrom(root)
    expect(observed.known, '真实 cordis 形状下把「有监听者」读成了「没有提供方」').toBe(true)
    expect(observed.known && observed.value).toEqual([])

    // 反面：**没有**任何监听者的真 ctx ⇒ known:false（同一个读数不能恒真）。
    const bare = new Context()
    bare.provide('agents', { list: () => [] })
    bare.provide('jobs', { list: () => [] })
    const none = await busySourcesFrom(bare)
    expect(none.known, '真 ctx 上没有任何监听者却判 known:true').toBe(false)
  })
})

// ── 14. 退出通道与审批服务：结构面 ─────────────────────────────────────────

describe('dsh_restart · appExit 与审批服务的结构面', () => {
  it('appExit 取不到 ⇒ undefined（绝不退回 process.exit）；形状不对也一样', () => {
    expect(appExitOf({ get: () => undefined })).toBeUndefined()
    expect(appExitOf({ get: () => 'not a function' })).toBeUndefined()
    expect(appExitOf({})).toBeUndefined()
    const channel = (): void => undefined
    expect(appExitOf({ get: () => channel })).toBe(channel)
  })

  it('审批档位：读不到 / 不是闭集里的值 / 抛异常 ⇒ 一律 undefined（fail-closed）', () => {
    const agent = { session: {} }
    expect(approvalPolicyOf({ get: () => undefined }, agent)).toBeUndefined()
    expect(approvalPolicyOf({ get: () => ({}) }, agent)).toBeUndefined()
    expect(
      approvalPolicyOf({ get: () => ({ effectivePolicy: () => 'sometimes' }) }, agent),
    ).toBeUndefined()
    expect(
      approvalPolicyOf(
        {
          get: () => ({
            effectivePolicy: () => {
              throw new Error('boom')
            },
          }),
        },
        agent,
      ),
    ).toBeUndefined()
    expect(approvalPolicyOf({ get: () => ({ effectivePolicy: () => 'ask' }) }, agent)).toBe('ask')
    expect(approvalPolicyOf({ get: () => ({ effectivePolicy: () => 'never' }) }, agent)).toBe(
      'never',
    )
    // agent 上没有 session ⇒ 读不出档位（不是「没有档位 = 随便做」）。
    expect(
      approvalPolicyOf({ get: () => ({ effectivePolicy: () => 'never' }) }, {}),
    ).toBeUndefined()
  })

  it('审批请求：抛异常 / 返回非闭集值 ⇒ unavailable（fail-closed）；闭集值原样透传', async () => {
    const agent = { session: {} }
    expect(await approvalRequestOf({ get: () => undefined }, agent, 'why')).toBe('unavailable')
    expect(
      await approvalRequestOf(
        {
          get: () => ({
            request: async () => {
              throw new Error('outside an open turn')
            },
          }),
        },
        agent,
        'why',
      ),
    ).toBe('unavailable')
    expect(
      await approvalRequestOf({ get: () => ({ request: async () => 'maybe' }) }, agent, 'why'),
    ).toBe('unavailable')
    expect(
      await approvalRequestOf(
        { get: () => ({ request: async () => 'allowed-once' }) },
        agent,
        'why',
      ),
    ).toBe('allowed-once')
  })
})

// ── 15. 描述层与 L2 ───────────────────────────────────────────────────────

describe('dsh_restart · 描述与 L2', () => {
  it('描述承载**四件必须说清的事** + 行动类的代价段（骨架形状由红线 B20a 全量覆盖）', async () => {
    const text = composeDescription(RESTART_DESCRIPTION)
    // 四件必须说清的事（判据是「模型看不到会不会做错决定」）。
    // ⚠️ 措辞从 `cannot reach another instance` 压成 `not another instance`（2026-10-16）：
    // 事实没变（重启只作用于本进程所在的宿主），腾出来的字符给了边界段的**第四件**事实。
    expect(text).toContain('not another instance')
    expect(text).toContain('ask prompts, never auto-runs')
    expect(text).toContain('file sandbox')
    expect(text, '描述没说桌面端不能重启 —— 那是真机缺陷的根因').toMatch(
      /Desktop hosts are refused/u,
    )
    // 行动类工具**必写** cost 段 —— B20a 只判「写了但为空」的闭集形状，
    // 判不了「行动类必须有 cost」这个角色规则（与 hot-reload 同一条角色判据）。
    expect(RESTART_DESCRIPTION.cost, '行动类工具必须写代价段').toBeTruthy()
  })

  it('描述必须点明「只在 Windows 上可用」（防模型在非 Windows 上白白调用一次）', () => {
    const text = composeDescription(RESTART_DESCRIPTION)
    // ⚠️ 这条事实的**唯一**机器判据 —— 变异实测：把它从描述里去掉，别处**一条都不红**。
    // 它防的是**白白调用一次**：本工具只有 Windows 计划任务这一条已实测的拉起路线，
    // `launchCommandFrom` 与 `relaunchViaTaskScheduler` 两处在非 win32 上都会拒绝
    // （reason 原话 `no relaunch route has been verified on ${process.platform}`）。
    // 模型该在**调用之前**就知道这件事（坑 7：描述写不好 = 插件不存在），
    // 而不是撞一次拒绝再回头 —— 那正是「描述层少了路由信号」的代价。
    expect(text, '描述没说「只在 Windows 上可用」—— 模型会在别的平台上白调一次').toContain(
      'Windows only',
    )
    // 反空转：它必须在 **boundary 段**里（那是「执行前必须知道、且调用结果里学不到」的段），
    // 不许被挪到别处 —— 只断合成后的 `text` 对「四段随便写哪都行」也绿。
    expect(RESTART_DESCRIPTION.boundary).toContain('Windows only')
    // 同一段里的另外三件事实还在（不自动跑 / 桌面端被拒 / 写动作还要过文件沙箱）。
    expect(RESTART_DESCRIPTION.boundary).toContain('ask prompts, never auto-runs')
    expect(RESTART_DESCRIPTION.boundary).toContain('file sandbox')
    expect(RESTART_DESCRIPTION.boundary, '桌面端那一档没进边界段').toContain(
      'Desktop hosts are refused',
    )
  })

  it('描述**调用前**就给出桌面端的路由信号：L1 里那句拒绝码在描述层有对应的措辞', () => {
    // 根因：真机那次是「模型**调用之后**才发现这条路走不通」—— 而那时宿主已经退出。
    // 所以描述层必须让它在**调用之前**就知道。判据取「描述层那一句」与「判据层那一档」
    // 的**语义对应**（不逐字比：两边一个给人看路由、一个给人看机器码）。
    const text = composeDescription(RESTART_DESCRIPTION)
    const desktopRefusal = relaunchRefusalFor(carrierOf('desktop-host', 'win32'))
    expect(desktopRefusal.reason).toContain('Desktop')
    expect(text, '描述没提桌面端，而闸④会拒它 ⇒ 模型必然白调一次').toMatch(
      /Desktop hosts are refused/u,
    )
  })

  it('`keyText` 能喂空对象（守卫合成的兜底就是 `{}`），且不给默认值', () => {
    expect(keyText({} as never)).toEqual([])
    expect(keyText({ stage: 'gates', dryRun: false, markerWritten: false } as never)).toEqual([
      'stage: gates',
    ])
  })

  it('载体在 L2 里**只在不是 `cli` 时**印（照 `restartEnabled` 只在为假时印的先例）', () => {
    // 下界：两格**必须**给出不同结论，否则「只在不是 cli 时印」这条判据是空转的。
    expect(keyText({ stage: 'gates', carrier: 'desktop-host' } as never)).toContain(
      'carrier: desktop-host',
    )
    expect(keyText({ stage: 'gates', carrier: 'unknown' } as never)).toContain('carrier: unknown')
    expect(keyText({ stage: 'gates', carrier: 'cli' } as never)).toEqual(['stage: gates'])
  })
})

// ── 16. appExit 缺失：**动手之前**就拒绝（MUST-1） ─────────────────────────

describe('dsh_restart · appExit 缺失：动手之前就拒绝', () => {
  it('零写零拉起零退出，且 verdict **不出现**「the restart was not started」那种相反陈述', async () => {
    const home = await tempDshHome()
    // ⚠️ **必须真的传 `exitChannel`**：这个选项以前从没有用例传过 ⇒ 那条分支**从未被执行**
    // （复核原话）。显式给 `undefined` = 「宿主没提供退出通道」那一格。
    const h = harnessFor(home, { policy: 'never', exitChannel: undefined })
    const failure = expectFail(await run(h.tool, ARGS, execFor()))

    expect(failure.kind).toBe('not-configured')
    // 判据一（根因，不是症状）：拉起**一次都没发生**、marker **一次都没写**。
    // 把 bug 改回去（先拉起、后取 appExit）时，这两条各判红一次。
    expect(h.fs.markerWrites(), 'appExit 取不到却写了 marker').toHaveLength(0)
    expect(h.launchCalls, 'appExit 取不到却拉起了 —— 那正是双宿主那一半').toHaveLength(0)
    expect(h.exitCalls, 'appExit 取不到却退出了').toHaveLength(0)
    // 判据二（文本）：verdict 不许说「没开始」。改回旧顺序时它会变回
    // 'the restart was not started: …' —— 而那时拉起**已经发生** ⇒ 说假话。
    expect(failure.data.verdict).not.toContain('the restart was not started')
    expect(failure.data.verdict).toContain('nothing was written and nothing was relaunched')
    expect(failure.data.verdict).toContain('appExit')
    // 先决条件在审批门**之前**判：这一格连审批窗都不该弹。
    expect(h.requestCalls, '先决条件不过却弹了审批窗').toHaveLength(0)
    expect(h.policyCalls, '先决条件不过却读了审批档').toHaveLength(0)
  })

  it('dryRun 也报出这条先决条件（演练的全部价值就是「这次会不会成」）', async () => {
    const home = await tempDshHome()
    const h = harnessFor(home, { policy: 'never', exitChannel: undefined })
    const failure = expectFail(await run(h.tool, { ...ARGS, dryRun: true }, execFor()))
    expect(failure.data.verdict).toContain('appExit')
    expect(h.fs.markerWrites()).toHaveLength(0)
    expect(h.launchCalls).toHaveLength(0)
  })

  it('通道在场时行为不变（反空转：上面那两条不是因为这条路径根本不碰 exit）', async () => {
    const home = await tempDshHome()
    const h = harnessFor(home, { policy: 'never' })
    expectOk(await run(h.tool, ARGS, execFor()))
    expect(h.fs.markerWrites()).toHaveLength(1)
    expect(h.launchCalls).toHaveLength(1)
    // 退出排在结论之后 ⇒ flush 之后再数，否则量到的是「还没轮到退出」。
    await flushDeferredExit()
    expect(h.exitCalls).toEqual([0])
  })
})

// ── 17. 命令行长度上限（EXTRA-2，文档值） ─────────────────────────────────

describe('dsh_restart · 拉起的命令行长度上限（schtasks /tr 的文档值）', () => {
  it('超长 ⇒ 结构化拒绝，且**零写零拉起**（动手之前拒）', async () => {
    // ⚠️ 触发点变了（2026-10-17）：`/tr` 现在只指启动器脚本，目标命令进了脚本文件 ——
    // 所以让 `/tr` 超限的唯一办法是把 **`dshHome` 拉长**（启动器路径在它下面）。
    // 这正是现实中的成因：`$DSH_HOME` 太深。
    const home = `C:/${'h'.repeat(SCHTASKS_TR_MAX_CHARS)}`
    const h = harnessFor(home, {
      policy: 'never',
      launch: {
        known: true,
        value: {
          command: 'node',
          args: ['bin.js'],
          cwd: 'C:/repo',
        },
      },
    })
    const failure = expectFail(await run(h.tool, ARGS, execFor()))
    expect(failure.kind).toBe('not-configured')
    expect(failure.data.verdict).toContain('nothing was written and nothing was relaunched')
    expect(failure.data.verdict).toContain(String(SCHTASKS_TR_MAX_CHARS))
    // 模型要能看见**哪条行**超了：超的是交给 `/tr` 的那条启动器调用（2026-10-17 起
    // 目标命令走脚本文件，不占 `/tr`），所以它必须进 `key` —— 否则模型无从下手去缩短。
    expect(String(failure.data.key['launcherCommand']).length).toBeGreaterThan(
      SCHTASKS_TR_MAX_CHARS,
    )
    expect(h.fs.markerWrites(), '命令行超限却写了 marker').toHaveLength(0)
    expect(h.launchCalls, '命令行超限却拉起了').toHaveLength(0)
    expect(h.exitCalls).toHaveLength(0)
  })

  it('win32：边界逐字钉住 —— 正好 261 放行、262 拒绝，且超限时**不起子进程**', async () => {
    const recorder = recordingSpawn(() => cmdResult())
    const makeRequest = (length: number): RelaunchRequest => ({
      command: 'node',
      args: [],
      cwd: 'C:/repo',
      commandLine: 'x'.repeat(length),
      delayMs: 0,
      budgetMs: 5_000,
    })
    // ⚠️ **构造 + 执行**整段都在 withPlatform 里（坑 25 的隐蔽变体）。
    const atLimit = await withPlatform(
      'win32',
      async () =>
        await relaunchViaTaskScheduler(recorder.spawn, makeRequest(SCHTASKS_TR_MAX_CHARS)),
    )
    expect(atLimit.ok, '正好在上限上却被拒 —— 边界不是「大于等于就拒」').toBe(true)
    const callsAfterLimit = recorder.calls.length
    expect(callsAfterLimit).toBe(2)

    const overLimit = await withPlatform(
      'win32',
      async () =>
        await relaunchViaTaskScheduler(recorder.spawn, makeRequest(SCHTASKS_TR_MAX_CHARS + 1)),
    )
    expect(overLimit.ok).toBe(false)
    expect(overLimit.ok === false && overLimit.reason).toContain(String(SCHTASKS_TR_MAX_CHARS))
    expect(recorder.calls.length, '超限还起了子进程').toBe(callsAfterLimit)
  })
})

// ── 18. 命令行里的 cmd 元字符必须加引号（EXTRA-1） ────────────────────────

describe('dsh_restart · 命令行对 cmd 元字符加引号', () => {
  it('路径里**没有空格但有 `&`** ⇒ 那条 argv 必须带引号（否则 cmd 在那里断开、错起一条命令）', async () => {
    const home = await tempDshHome()
    const h = harnessFor(home, {
      policy: 'never',
      launch: {
        known: true,
        value: {
          command: 'C:/R&D/node.exe',
          args: ['C:/R&D/bin.js'],
          cwd: 'C:/R&D',
        },
      },
    })
    const data = expectOk(await run(h.tool, ARGS, execFor()))
    const line = String(data.key['relaunch'])
    // 判据是**引号真的在**：把 bug 改回去（只按空格/制表/引号判）时这三段全是裸的 ⇒ 判红。
    expect(line).toContain('"C:/R&D/node.exe"')
    expect(line).toContain('"C:/R&D/bin.js"')
    expect(line).toContain('cd /d "C:/R&D"')
    // 交出去的是启动器调用；那条目标行逐字进了脚本文件（`"` 在 VBS 里写成 `""`）。
    const vbs = String(h.fs.writes.find((entry) => entry.path.endsWith('relaunch.vbs'))?.text)
    expect(vbs).toContain('""C:/R&D/node.exe""')
    expect(vbs).toContain('""C:/R&D/bin.js""')
    expect(vbs).toContain('cd /d ""C:/R&D""')
  })

  it('其余元字符（`|` `^` `<` `>` `(` `)`）与空白同样加引号', async () => {
    const home = await tempDshHome()
    const h = harnessFor(home, {
      policy: 'never',
      launch: {
        known: true,
        value: {
          command: 'node',
          args: ['a|b', 'c^d', 'e<f', 'g>h', 'i(j)', 'k l', 'm\tn'],
          cwd: 'C:/repo',
        },
      },
    })
    const data = expectOk(await run(h.tool, ARGS, execFor()))
    const line = String(data.key['relaunch'])
    for (const raw of ['a|b', 'c^d', 'e<f', 'g>h', 'i(j)', 'k l', 'm\tn']) {
      expect(line, `${raw} 没被加引号`).toContain(`"${raw}"`)
    }
    // 反空转：不含元字符的普通参数**不许**被无谓地加引号（否则这条判据对「一律加引号」也绿）。
    expect(line).toContain('& node')
  })
})

// ── 19. 兜底分支的 `key.stage` 按调用点报（低危 1） ────────────────────────

describe('dsh_restart · 兜底分支的 stage 按调用点报', () => {
  it('marker 写完之后炸 ⇒ stage 是 `relaunch`，且 L1 说「已开始」而不是「没开始」（B2）', async () => {
    const home = await tempDshHome()
    const h = harnessFor(home, { policy: 'never', relaunchThrows: true })
    const result = await run(h.tool, ARGS, execFor())
    const failure = expectFail(result)
    expect(failure.kind).toBe('internal')
    // 顺序是判据：抛之前 marker 已经写完（拉起替身被调用过，且在写之后）。
    expect(h.fs.markerWrites()).toHaveLength(1)
    expect(h.launchCalls).toHaveLength(1)
    expect(failure.data.key['stage'], '兜底把「marker 已写完」报成了「还没动手」').toBe('relaunch')
    // ⚠️ **B2 的根因判据**：这一刻 marker 已在盘上、拉起请求已发出 ⇒ L1 **不许**再说
    // 「the restart was not started」（那是 stage-blind 的假话）。把兜底那句改回恒定文案，
    // 下面两条各自判红。
    expect(failure.data.verdict).not.toContain('the restart was not started')
    expect(failure.data.verdict).toContain('the restart was started')
    expect(failure.data.verdict, 'L1 没说清 marker 在盘上').toContain('marker is on disk')
    // L2 也不许跟着失明：`key` 必须带 marker 已落盘这一格，而且**模型真正读的那一层**
    // （渲染出来的 L2）里也要看得见 —— 只断原始 `key` 就漏掉了渲染层。
    expect(failure.data.key['markerWritten'], 'key 里没有 marker 事实 —— L1/L2 一起失明').toBe(true)
    expect(renderText(h.tool, ARGS, result), 'L2 里看不见 marker 已落盘').toContain(
      'markerWritten: true',
    )
  })

  it('退出通道抛异常 ⇒ **结论照样交付**，而异常**不吞**（同一族的第二格，已按新语义改写）', async () => {
    const home = await tempDshHome()
    // 退出通道自己抛。旧语义下这会被 `execute` 的 catch 收敛成结构化 `internal`；
    // 新语义下结论必须先交付（否则真机上 verdict 落不了盘），所以**结构化失败这条路已经不存在**。
    const h = harnessFor(home, {
      policy: 'never',
      exitChannel: () => {
        throw new Error('the exit channel exploded')
      },
    })
    // 挂一个临时的未捕获异常监听：退出排进 `setImmediate` 之后，这个抛不再有任何
    // 收口点（`execute` 已返回），**必须让它响** —— 吞掉就是「宿主退出失败却一声不吭」。
    const escaped: unknown[] = []
    const onUncaught = (error: unknown): void => {
      escaped.push(error)
    }
    process.on('uncaughtException', onUncaught)
    try {
      const result = await run(h.tool, ARGS, execFor())
      // ① 结论照样是成功的那句（marker 已写、拉起已排 —— 这三件确实发生了）。
      const data = expectOk(result)
      expect(data.key['stage']).toBe('exit')
      expect(data.key['markerWritten']).toBe(true)
      expect(data.verdict, '结论必须说清重启已启动').toContain('the restart is under way')
      // ② 退出确实被调用过（顺序仍在结论之后）。
      expect(h.exitCalls, '退出排在结论之前').toEqual([])
      await flushDeferredExit()
      // ③ 异常浮出来了，且是宿主退出失败那一条 —— 不是被静默吞掉。
      expect(escaped.length, '退出通道的异常被吞了 ⇒ 宿主会不退出而没人知道').toBeGreaterThan(0)
      expect(String(escaped[0])).toContain('the exit channel exploded')
      // ④ 宿主退不掉时的**恢复路径**在设计上已经存在：marker 仍是 armed，
      //    下次启动会读到它并如实报「这次重启没走完」（`decideRecovery` 那条）。
      //    这条不断言在内部（那是 task-58 的范围），这里只钉住「marker 还在」。
      const written = h.fs.content() ?? ''
      expect(written, '退出失败时 marker 必须留在盘上供下次启动发现').toContain('"state": "armed"')
    } finally {
      process.off('uncaughtException', onUncaught)
    }
  })

  it('还没动手就炸 ⇒ stage 仍是 `gates`（同一个字段两格必须分得开）', async () => {
    const home = await tempDshHome()
    const h = harnessFor(home, { portThrows: 'history' })
    const failure = expectFail(await run(h.tool, ARGS, execFor()))
    expect(failure.kind).toBe('internal')
    expect(failure.data.key['stage']).toBe('gates')
    expect(h.fs.markerWrites()).toHaveLength(0)
    // 反空转：**动手之前**那一格**必须**说「没写」，且 `key` 里不许出现 marker 已落盘
    // —— 否则上面两条对「所有 stage 都说已开始」也绿。
    // （这一格走的是计划层的 `failed`，措辞是「the restart was not planned: … nothing was written」。）
    expect(failure.data.verdict).toContain('nothing was written')
    expect(failure.data.verdict, '还没动手就说「已开始」').not.toContain('the restart was started')
    expect(failure.data.key['markerWritten']).toBeUndefined()
  })
})

// ── 20. `at` 坏掉的 marker 不许静默绕过闸①（低危 2） ──────────────────────

describe('dsh_restart · marker 的 `at` 解析不出来 ⇒ 历史不可信', () => {
  it('consumed / armed 两种状态都是 `known:false`（压成 `[]` = 静默绕过 60 秒冷却）', async () => {
    for (const state of ['consumed', 'armed'] as const) {
      const fs = makeFs({ seed: markerText({ at: 'not-a-timestamp', state }) })
      const history = await restartHistoryFrom(fs.port, 'C:/home')
      expect(history.known, `${state}: 坏掉的 at 被当成了「没有重启过」`).toBe(false)
      expect(JSON.stringify(history)).not.toBe(JSON.stringify({ known: true, value: [] }))
    }
    // 反空转：同一个状态、`at` 正常时**必须**是 known:true 且带那个时刻。
    const ok = makeFs({ seed: markerText({ state: 'consumed' }) })
    expect(await restartHistoryFrom(ok.port, 'C:/home')).toEqual({ known: true, value: [NOW] })
  })
})

// ── 21. subagent 族「不单独枚举」的**结构性**护栏 ─────────────────────────

describe('dsh_restart · subagent 族由 `agents.list()` 覆盖（不重复枚举）', () => {
  it('`busySourcesFrom` 里没有 `subagent` 分支，也没有按 `parentSession` / `origin` 过滤', () => {
    // 这条护栏守的是**结构**，不是取值：上面那条「后代可见」的用例证明的是**取值**。
    // 两者合起来才是完整判据 —— 只留取值那条，别人把 `subagent` 族再枚举一遍
    // （重复计数、evidence 里同一个会话两个标签）时它照样是绿的。
    const source = readFileSync(join(REPO_ROOT, 'src', 'tools', 'dsh_restart.ts'), 'utf8')
    const body = source.slice(
      source.indexOf('export async function busySourcesFrom'),
      source.indexOf('/** 取一个忙来源的标识'),
    )
    expect(body.length, '锚点没找到 —— 下面两条是空转').toBeGreaterThan(500)
    expect(body, '`subagent` 族被重复枚举了（它已由 agents.list() 覆盖）').not.toContain(
      "kind === 'subagent'",
    )
    expect(body, '按 lineage 过滤会把 agents.list() 已经算进来的后代又排除掉').not.toContain(
      'parentSession',
    )
    expect(body).not.toContain('origin')
  })
})

// ── 22. 总闸 `enableRestart`（默认关） ──────────────────────────────────────

/**
 * 维护者 2026-10-15 拍板：`dsh_restart` 是本仓唯一会杀宿主、而跨 web / desktop / 多平台
 * 的重启行为很难彻底完善的工具 ⇒ 给它一个配置开关，**默认关**。
 *
 * ## 这一节钉住四条
 *
 * 1. **默认关本身**（`resolveConfig` 在「用户什么都没配」时给出的就是 `false`）
 *    —— 它是产品决定，所以得像红线一样被钉住，否则哪天「顺手把默认改成 true」
 *    不会有任何东西变红。
 * 2. **零写 marker / 零拉起 / 零调退出**，三条**各有一断**。缺一条就是
 *    「拒绝了却已经动手」那种静默坏（`planRestart` 那一格是**会写 marker** 的）。
 * 3. **反空转**：同一组端口把开关打开 ⇒ 三个计数**恰好各一次** ——
 *    否则那三个 0 可能只是因为这条路径根本不碰那些端口。
 * 4. **不许改成「关着就不注册」**：模型看到「这个插件不提供 `dsh_restart`」会去
 *    另想办法重启（甚至直接让用户手动重启）⇒ 风险不降反升且不可控。
 */
describe('dsh_restart · 总闸 enableRestart（默认关 ⇒ 结构化拒绝，不是人间蒸发）', () => {
  it('「用户什么都没配」时 `resolveConfig` 给出的 `enableRestart` 就是 `false`（默认关本身）', () => {
    // 三种「什么都没配」都要断：完全 undefined、空对象、以及只配了别的字段。
    for (const config of [undefined, {}, { dshHome: 'C:/x', profile: 'web', port: 0 }]) {
      expect(
        resolveConfig(config).enableRestart.get(),
        '默认不是关 —— 那要让每个读它的人自己猜',
      ).toBe(false)
    }
    // 反空转：显式给 `true` **必须**被认（否则上面那三条会因「这个字段根本读不到」而恒真）。
    // ⚠️ 喂的是**活引用**（与 `apply()` 收到的形状同形）。
    expect(resolveConfig({ enableRestart: volatileOf(true) }).enableRestart.get()).toBe(true)
    expect(resolveConfig({ enableRestart: volatileOf(false) }).enableRestart.get()).toBe(false)
  })

  it('「默认关」只有**一个**字面量出处：schema 与 `resolveConfig` 的兜底都引用它', () => {
    // 变异实测抓到的真缺陷（2026-10-15）：原先两处各写一个 `false` ⇒ 把 schema 那一处
    // 改回 `true`，`resolveConfig` 不跟着变，于是「默认关」这个**拍板的产品决定**
    // 在两处悄悄分叉，而上面那条判据**照样全绿**（它只量 `resolveConfig` 那一侧）。
    // ⇒ 这条钉住「同一个字面量只有一个出处，且两处都引用它」。
    const stripped = stripComments(readFileSync(join(REPO_ROOT, 'src', 'config.ts'), 'utf8'))
    const literals = stripped
      .split('\n')
      .map((line, index) => ({ line: line.trim(), at: index + 1 }))
      .filter((item) => /(?:^|[^\w.])(?:true|false)\b/u.test(item.line))
    expect(
      literals.length,
      `默认值的字面量出现了 ${String(literals.length)} 处：${JSON.stringify(literals)}`,
    ).toBe(1)
    expect(literals[0]?.line, '那唯一一处必须是那个常量声明').toContain(
      'RESTART_ENABLED_BY_DEFAULT',
    )
    // 一次声明 + schema `.default(...)` 一处 + `resolveConfig` 兜底一处 = 3。
    // 少一处就是又长出一份副本（正是上面那个静默分叉的形状）。
    expect((stripped.match(/RESTART_ENABLED_BY_DEFAULT/gu) ?? []).length).toBe(3)
  })

  it('**没有缓存**：同一个活引用换掉值之后，同一个工具对象下一次调用必须看到开启', async () => {
    // 需求是「丝滑关开、不用重启」（靠 schema 的 `.volatile()`：宿主不重启插件、
    // 只把新值提交进那个引用）。⇒ 工具这一侧**必须每次调用现读 `.get()`**：
    // 一旦有人把值缓存下来（apply 期拍成常量、或注册期算一次），
    // 用户改了开关却要重启才生效 —— 而界面上还写着「no restart」，那是一次骗人。
    const home = await tempDshHome()
    // 宿主那侧的那个引用：换**它的值**，引用本身不变（cosmokit 的原话
    // 「keep the reference, or capture its value for one operation only」）。
    const live = {
      value: false,
      get(): boolean {
        return live.value
      },
    }

    // ⚠️ 显式对象构造 + 断言替身被接上（坑 40）。
    // 载体也要显式给：这一条断言的是「开关拨开之后**真的会动手**」，而闸④ 的第一问
    // 在 `UNKNOWN_CARRIER` 上会先拒 —— 不给的话下面那条「写了一次」会红在载体上，
    // 看起来却像开关没生效。
    const deps = depsFor(resolveConfig({ dshHome: home, enableRestart: live as never }), {
      carrier: carrierOf('cli', 'win32'),
    })
    // `Harness` 只导出计数器与工具（它**不**导出 `restart` 那一面），所以宿主面另造一份。
    const hostOf = (fs: FsRecorder): RestartHost => ({
      ports: harnessFor(home, { policy: 'never', fs }).ports,
      approval: { policyOf: () => 'never', request: async () => 'allowed-once' },
      launch: { relaunch: async () => ({ ok: true, detail: 'stub' }) },
      exit: { exit: () => () => undefined },
    })
    const firstFs = makeFs()
    const tool = createRestartTool({ ...deps, restart: hostOf(firstFs) })
    // 反空转：先证明这个工具在「关」这一档**真的会拒**（否则第二条断言是空转）。
    expect(deps.config.enableRestart.get()).toBe(false)
    expectFail(await run(tool, ARGS, execFor()))
    expect(firstFs.writes, '关着却写了 marker').toHaveLength(0)

    // 宿主在不重新挂载插件的情况下换掉那个值 —— 工具对象**一个字都没重建**。
    live.value = true
    expect(deps.config.enableRestart.get(), '替身没被接上 ⇒ 这条判据在空转').toBe(true)

    // 换一个**记调用**的 marker 替身，断言它真被调用过（坑 40 的另一半）。
    const watched = makeFs()
    expectOk(await run(createRestartTool({ ...deps, restart: hostOf(watched) }), ARGS, execFor()))
    expect(
      watched.markerWrites(),
      '换掉开关值之后仍被拒 ⇒ 读取链把它缓存了（宿主说 no restart，这边却要重启）',
    ).toHaveLength(1)
  })

  it('关 ⇒ 零写 marker / 零拉起 / 零调退出（三条各有一断），且返回值过了守卫', async () => {
    const home = await tempDshHome()
    const h = harnessFor(home, { policy: 'never', config: { enableRestart: volatileOf(false) } })

    const result = await run(h.tool, ARGS, execFor())
    // 先断「没抛、形状合法」，再断三个 0 —— 顺序反了的话，「execute 抛了」会被当成
    // 「零写零拉起零退出通过」。
    expect(toolResultProblem(result), '关着时的返回值形状非法').toBeUndefined()
    expect(ensureToolResult(result), '没过守卫').toBe(result)
    // 三条各有断言：「拒绝了却已经动手」是静默坏，而 planRestart 那一格**会写 marker**。
    expect(h.fs.markerWrites(), '被配置禁用却写了 marker').toHaveLength(0)
    expect(h.launchCalls, '被配置禁用却拉起了新进程').toHaveLength(0)
    expect(h.exitCalls, '被配置禁用却调了退出通道').toHaveLength(0)
    // 连参数与审批门都不许碰（闸门前置 ⇒ 这两个计数也必须是 0）。
    expect(h.requestCalls, '被配置禁用还去弹审批窗').toHaveLength(0)
  })

  it('反空转：同一组端口把开关打开 ⇒ 写 / 拉起 / 退出恰好各一次', async () => {
    const home = await tempDshHome()
    const h = harnessFor(home, { policy: 'never', config: { enableRestart: volatileOf(true) } })
    expectOk(await run(h.tool, ARGS, execFor()))
    expect(h.fs.markerWrites()).toHaveLength(1)
    expect(h.launchCalls).toHaveLength(1)
    await flushDeferredExit()
    expect(h.exitCalls, '开着的那条路没退出 ⇒ 上面三个 0 可能只是「这条路什么都不做」').toEqual([0])
  })

  it('拒绝走既有的 `fail(...)` 形状：顶层恰好三键、kind 是闭枚举里的一格、key 说清是配置挡的', async () => {
    const home = await tempDshHome()
    const h = harnessFor(home, { policy: 'never', config: { enableRestart: volatileOf(false) } })
    const failure = expectFail(await run(h.tool, ARGS, execFor()))

    // 同形（不是第四种结果形状）：`fail` 那一族的顶层就是 `{ ok, error, data, nextStep? }`。
    expect(TOOL_ERROR_KINDS, '用了闭枚举之外的 kind').toContain(failure.kind)
    // 「这一格是配置挡的」必须能从 L2 读出来：只报 `stage: gates` 会让模型与
    // 「被四道闸拒」分不开（两者的下一步完全不同）。
    expect(failure.data.key['restartEnabled']).toBe(false)
    expect(failure.data.key['stage']).toBe('gates')
    // 开启途径必须**指向真实存在的 UI**（2026-10-15 改：旧文本给的是「组合里那一条的
    // 包名 + 改完重启」，维护者指出有歧义；现在卡片已落地并真机验过，所以指到那张卡片）。
    const why = String((failure.nextStep as { why?: string } | undefined)?.why)
    expect(why).toContain(RESTART_CONFIG_FIELD)
    expect(
      (failure.nextStep as { manual?: unknown } | undefined)?.manual,
      '只有人能改插件配置',
    ).toBe(true)
    // ⚠️ **开启途径必须指向真实存在的 UI**（2026-10-15 反转了这条的方向）：
    // 旧版这里断言「**不许**出现 settings card」——当时本仓确实没有设置卡片。
    // 现在**有了**（`dsh.client` 落地、槽 `plugins.bundle.config` 里注册过，真机验过
    // occupants 里有 `dsh-plugin-debugging` 且 active），而且那张卡片拨开即生效。
    // ⇒ 判据的**方向反过来**：必须点到那张卡片，**并且不许再要求重启** ——
    // 旧文本的 `then restart the host` 与卡片自己的「改动立即生效，不需要重启」直接打架。
    expect(why, '开启途径没有指向真实存在的设置卡片').toMatch(/Plugins page/iu)
    expect(
      why,
      '又写「然后重启宿主」—— 那张卡片拨开即生效（`.volatile()`，真机验过），这句会与卡片文案打架',
    ).not.toMatch(/restart the host/iu)
    // 「不解释原因」（维护者原话：明确简洁告知怎么打开，不用写什么原因）。
    expect(failure.data.verdict).not.toContain('default is off because')
    // 简洁：不许铺陈成一篇解释。
    expect(
      failure.data.verdict.split('. ').length,
      'verdict 超过两句 —— 简洁被破',
    ).toBeLessThanOrEqual(2)
  })

  it('关着时模型可见文本逐字含「被挡住 + 怎么打开」，且**不解释原因**', async () => {
    const home = await tempDshHome()
    const h = harnessFor(home, { policy: 'never', config: { enableRestart: volatileOf(false) } })
    const args = { ...ARGS, dryRun: true }
    const result = await run(h.tool, args, execFor())
    const text = renderText(h.tool, args, result)
    const { verdict, l3 } = splitRender(text)

    // 明确：说清了「现在被配置挡住了」，且字段名逐字出现（L1 与 L3 各一处）。
    expect(verdict).toContain(RESTART_TOOL)
    expect(verdict).toContain(RESTART_CONFIG_FIELD)
    expect(l3).toContain(RESTART_CONFIG_FIELD)
    // L2 那一行是「模型能不能与闸门拒绝分得开」的唯一依据。
    expect(text).toContain('restartEnabled: false')
    // dryRun 也一样被挡（演练**不是**后门：那一条最容易被漏，而它同样会走真实的路）。
    // ⚠️ 措辞用 `switched off`（2026-10-15 改文本：旧版 `turned off ... (default false)` 啰嗦，
    // 维护者要求「先简单陈述开关没打开」）。这里断的是**语义**，不是某句话的原文。
    expect(verdict).toMatch(/switched off|turned off/iu)
  })

  it('不许改成「关着就不注册」：工具必须始终在注册表里', () => {
    // 注册处是 `src/tools/index.ts` 那一处；「关着就 return」会让工具静默消失。
    const source = readFileSync(join(REPO_ROOT, 'src', 'tools', 'index.ts'), 'utf8')
    const start = source.indexOf('createRestartTool(')
    expect(start, '锚点没找到 —— 下面这条是空转').toBeGreaterThan(-1)
    const around = source.slice(Math.max(0, start - 400), start)
    expect(around, '注册处按配置开关跳过了注册 ⇒ 模型看不到这个工具，会另想办法重启').not.toMatch(
      /enableRestart/u,
    )
    // 反空转：开关字段名在**工具那一侧**确实存在（否则上面那条会因「压根没人读它」而恒真）。
    const toolSource = readFileSync(join(REPO_ROOT, 'src', 'tools', 'dsh_restart.ts'), 'utf8')
    expect(toolSource).toContain('config.enableRestart')
  })
})
