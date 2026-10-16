/**
 * `src/lib/restart.ts` 的判据 —— **不依赖真机**，全部用注入端口。
 *
 * 这一份要钉住的不是「功能跑通了」，而是四件容易写成假绿的事：
 *
 * 1. **四道闸各拒绝一次，且拒绝时说清「哪个闸 + 为什么 + 怎么解」**（SHAPE §6.1 的验收条款）；
 * 2. **`force` 只覆盖闸②** —— ①③④ 在 `force: true` 下仍必须拒绝（最能抓「force 被实现成
 *    万能钥匙」这一种真实错实现）；
 * 3. **三值纪律**：忙闲状态取不到时 **fail-closed**；marker 的「读到但没懂」**不许**读成
 *    「没有 marker」；marker 里「没有 `force` 键」与「`force: false`」也不是一件事；
 * 4. **接线**：判据函数被测 **不等于** 接进了入口（本仓坑 42）—— 所以凡是「拒绝」与「放行」
 *    的用例都从 `planRestart` 这个**唯一入口**进，另配「端口抛异常也不许抛出去」。
 *
 * ## 为什么写文件系统的替身而不是真文件
 *
 * `dryRun` 那条判据说的是「**零次写调用**」，而「返回值看起来对」证明不了它 ——
 * 只有数调用次数才证明得了。所以替身记下每一次 `read` / `write` / `remove`。
 * 配套的**反空转**用例：同一组端口在 `dryRun: false` 下必须**恰好写一次** ——
 * 否则「零次写」可能只是因为这条路径根本不碰写端口。
 */
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'

import { describe, expect, it } from 'vitest'

import {
  carrierAuditOf,
  relaunchRefusalFor,
  relaunchRouteFor,
  type CarrierObservation,
} from '../../src/lib/carrier.ts'
import {
  consumeRestartMarker,
  decideRecovery,
  judgeBusySession,
  judgeLaunchCommand,
  judgeRestartLoop,
  MARKER_VERSION,
  markerAfterConsumption,
  markerState,
  normalizeSessionId,
  parseMarker,
  planRestart,
  readRestartMarker,
  RESTART_COOLDOWN_MS,
  restartMarkerPath,
  serializeMarker,
  SUPPORTED_MARKER_VERSIONS,
  type BusySource,
  type LaunchCommand,
  type Observed,
  type RestartFsPort,
  type RestartMarker,
  type RestartPlan,
  type RestartPlanReady,
  type RestartPlanRefused,
  type RestartPorts,
  type RestartRequest,
  type TextRead,
} from '../../src/lib/restart.ts'
import { carrierOf, withPlatform } from './helpers.ts'

/** 一个**记调用**的 marker IO 替身 —— 判据数的是调用次数，不是返回值。 */
interface FsRecorder {
  port: RestartFsPort
  reads: string[]
  writes: { path: string; text: string }[]
}

/**
 * 造一个 IO 替身。**写会改掉读得到的内容**（状态迁移类判据要靠这一点）。
 *
 * @param seed `text` = 文件内容；`absent` = 文件不在；`unreadable` = 读失败（两者**不同**）。
 */
function makeFs(seed: { text?: string; absent?: boolean; unreadable?: boolean } = {}): FsRecorder {
  const reads: string[] = []
  const writes: { path: string; text: string }[] = []
  let stored = seed.absent === true ? undefined : seed.text
  const port: RestartFsPort = {
    read: async (path): Promise<TextRead> => {
      reads.push(path)
      if (seed.unreadable === true) {
        return { status: 'unreadable', reason: 'EACCES: permission denied' }
      }
      if (stored === undefined) return { status: 'absent' }
      return { status: 'text', text: stored }
    },
    write: async (path, text) => {
      writes.push({ path, text })
      stored = text
    },
  }
  return { port, reads, writes }
}

/** 一个固定时刻（毫秒纪元），让闸①的判定可复现。 */
const NOW = Date.UTC(2026, 9, 14, 6, 0, 0)
const HOME = 'C:/dsh-home'
const LAUNCH: LaunchCommand = { command: 'node', args: ['bin.js', 'web'], cwd: 'C:/repo' }

/** 端口替身的覆盖面。 */
interface PortOverrides {
  history?: Observed<readonly number[]>
  busy?: Observed<readonly BusySource[]>
  bundles?: Observed<readonly string[]>
  launch?: Observed<LaunchCommand>
  now?: number
  marker?: { text?: string; absent?: boolean; unreadable?: boolean }
}

/** 一个「会话正在跑回合」。 */
function turn(sessionId: string): BusySource {
  return { kind: 'turn', sessionId }
}

/** 一个「后台作业在跑」（契约 §2.3：它照旧算忙，**属于调用方的也算**）。 */
function job(jobId: string, ownerSession?: string): BusySource {
  return ownerSession === undefined ? { kind: 'job', jobId } : { kind: 'job', jobId, ownerSession }
}

/** 造一组**默认四道闸全绿**的端口。 */
function portsFor(overrides: PortOverrides = {}): { ports: RestartPorts; fs: FsRecorder } {
  const fs = makeFs(overrides.marker ?? {})
  const ports: RestartPorts = {
    fs: fs.port,
    restartHistory: async () => overrides.history ?? { known: true, value: [] },
    busySessions: async () => overrides.busy ?? { known: true, value: [] },
    bundles: async () => overrides.bundles ?? { known: true, value: ['dsh-plugin-debugging'] },
    launchCommand: async () => overrides.launch ?? { known: true, value: LAUNCH },
    now: () => overrides.now ?? NOW,
  }
  return { ports, fs }
}

/** 载体：这一份的**默认**是「命令行 × win32」= 唯一有已实测回归路线的那一格。 */
const CLI_WIN32: CarrierObservation = carrierOf('cli', 'win32')

const REQUEST: RestartRequest = {
  dshHome: HOME,
  reason: 'the plugin code changed and only a restart picks it up',
  callingSession: 'aaaa-1111-bbbb',
  force: false,
  dryRun: false,
  // 闸④ 的第一问。默认给「有路线」那一格 —— 于是下面那些**不是**测载体的用例
  // 走的仍是既有判据（忘了给就会在闸④上响亮地红，而不是悄悄换一条路）。
  carrier: CLI_WIN32,
}

/** 断言被闸门拒绝（与 `test/tools/helpers.ts` 的 `expectFail` 同形）。 */
function mustRefuse(plan: RestartPlan): RestartPlanRefused {
  if (plan.kind !== 'refused') throw new Error(`期望被闸门拒绝，实际：${JSON.stringify(plan)}`)
  return plan
}

/** 断言四道闸全过。 */
function mustReady(plan: RestartPlan): RestartPlanReady {
  if (plan.kind !== 'ready') throw new Error(`期望四道闸全过，实际：${JSON.stringify(plan)}`)
  return plan
}

/** 一条拒绝必须自带的三件：哪个闸、为什么、怎么解。 */
function expectRefusalShape(plan: RestartPlanRefused): void {
  expect(plan.verdict.length, '拒绝的 verdict 必须说明为什么').toBeGreaterThan(0)
  expect(plan.remedy.length, '拒绝的 remedy 必须说明怎么解').toBeGreaterThan(0)
  expect(plan.gate.length, '拒绝必须点名是哪一道闸').toBeGreaterThan(0)
}

describe('lib/restart · marker 编解码（往返无损 / 三值纪律）', () => {
  it('往返无损：isDeepStrictEqual（不用 toEqual —— 它忽略 undefined 属性）', () => {
    const withForce: RestartMarker = {
      version: MARKER_VERSION,
      reason: 'a restart is required',
      at: '2026-10-14T06:00:00.000Z',
      sessions: ['session-a', 'session-b'],
      state: 'armed',
      force: true,
      trace: ['busy-session=pass', 'force override: 1 running session(s) were interrupted'],
    }
    const withoutForce: RestartMarker = {
      version: MARKER_VERSION,
      reason: 'a restart is required',
      at: '2026-10-14T06:00:00.000Z',
      sessions: [],
      trace: [],
    }
    const consumed: RestartMarker = {
      version: MARKER_VERSION,
      reason: 'a restart is required',
      at: '2026-10-14T06:00:00.000Z',
      sessions: ['session-a'],
      state: 'consumed',
      trace: ['consumed at 2026-10-14T06:05:00.000Z'],
    }

    for (const marker of [withForce, withoutForce, consumed]) {
      const back = parseMarker(serializeMarker(marker))
      expect(back.status).toBe('ok')
      if (back.status !== 'ok') throw new Error('期望解析成功')
      expect(isDeepStrictEqual(back.marker, marker)).toBe(true)
    }
    // `state` 缺席的那份**往返后依然缺席**（不是被补成 'armed'）—— 缺席 ≠ 显式值。
    const noState = parseMarker(serializeMarker(withoutForce))
    if (noState.status !== 'ok') throw new Error('期望解析成功')
    expect('state' in noState.marker).toBe(false)

    // 自证这条断言不是恒真：`{}` 与 `{ force: undefined }` 在深度相等下**不是**同一件事
    // （B26 的教训：这正是 `toEqual` 会放过、宿主与 `isDeepStrictEqual` 不放过的形状）。
    expect(isDeepStrictEqual({ version: 1 }, { version: 1, force: undefined })).toBe(false)
    // 而且「没有 force 键」这件事真的被保住了 —— 不是被解析器补成了 undefined。
    expect('force' in noState.marker).toBe(false)
    expect(Object.keys(noState.marker)).not.toContain('force')
  })

  it('`state` 缺席 = armed（老 marker 只有那一种历史含义）；显式值原样保留', () => {
    // 老 marker（`task-32` 之前写的）没有 `state`，那时根本没有「消费」这一步。
    const legacy: RestartMarker = {
      version: MARKER_VERSION,
      reason: 'r',
      at: '2026-10-14T06:00:00.000Z',
      sessions: [],
      trace: [],
    }
    expect(markerState(legacy)).toBe('armed')
    expect(markerState({ ...legacy, state: 'armed' })).toBe('armed')
    expect(markerState({ ...legacy, state: 'consumed' })).toBe('consumed')
    // 自证不是恒真：两种显式值必须给出**不同**结论。
    expect(markerState({ ...legacy, state: 'armed' })).not.toBe(
      markerState({ ...legacy, state: 'consumed' }),
    )
  })

  it('`initiator` 参与往返；**缺席往返后依然缺席**（缺席 ≠ 空串）', () => {
    const withInitiator: RestartMarker = {
      version: MARKER_VERSION,
      reason: 'r',
      at: '2026-10-14T06:00:00.000Z',
      sessions: ['session-a', 'session-b'],
      initiator: 'session-a',
      trace: [],
    }
    const back = parseMarker(serializeMarker(withInitiator))
    if (back.status !== 'ok') throw new Error('期望解析成功')
    expect(isDeepStrictEqual(back.marker, withInitiator)).toBe(true)

    // 本字段之前写的 marker 没有它 ⇒ 往返后**依然没有这个键**。
    // 「缺席」承载着语义（不知道谁发起的 ⇒ `reason` 谁都不发），补成 `''` 就把它压成了第三种形态。
    const legacy: RestartMarker = {
      version: MARKER_VERSION,
      reason: 'r',
      at: '2026-10-14T06:00:00.000Z',
      sessions: ['session-a'],
      trace: [],
    }
    const legacyBack = parseMarker(serializeMarker(legacy))
    if (legacyBack.status !== 'ok') throw new Error('期望解析成功')
    expect('initiator' in legacyBack.marker).toBe(false)
  })

  it('`initiator` 是空串 / 非字符串 ⇒ malformed（空串不是「缺席」）', () => {
    const base = { version: 1, reason: 'r', at: 't', sessions: ['session-a'], trace: [] }
    for (const bad of ['', 7, null]) {
      expect(
        parseMarker(JSON.stringify({ ...base, initiator: bad })).status,
        `initiator=${JSON.stringify(bad)} 被放过了`,
      ).toBe('malformed')
    }
    // 自证不是恒真：合法值必须**过**（否则上面那条可以靠「一律 malformed」蒙对）。
    expect(parseMarker(JSON.stringify({ ...base, initiator: 'session-a' })).status).toBe('ok')
  })

  it('序列化的第一个键是 version（读的人第一眼就能判格式版本）', () => {
    const keys = Object.keys(JSON.parse(serializeMarker(parseOk())) as Record<string, unknown>)
    expect(keys[0]).toBe('version')
  })

  it('未知版本 ⇒ unsupported-version（**不是** malformed、更不是「没有」）', () => {
    const parsed = parseMarker(
      JSON.stringify({ version: 99, reason: 'r', at: 't', sessions: [], trace: [] }),
    )
    expect(parsed.status).toBe('unsupported-version')
    if (parsed.status !== 'unsupported-version') throw new Error('期望 unsupported-version')
    expect(parsed.version).toBe(99)
    expect(SUPPORTED_MARKER_VERSIONS).toContain(MARKER_VERSION)
  })

  it('格式坏 ⇒ malformed，且每种坏法各有一条（缺 version / 非 JSON / force 不是 true / state 非法 / sessions 不是数组）', () => {
    expect(parseMarker('not json at all').status).toBe('malformed')
    expect(
      parseMarker(JSON.stringify({ reason: 'r', at: 't', sessions: [], trace: [] })).status,
    ).toBe('malformed')
    expect(
      parseMarker(
        JSON.stringify({ version: 1, reason: 'r', at: 't', sessions: [], force: false, trace: [] }),
      ).status,
    ).toBe('malformed')
    expect(
      parseMarker(
        JSON.stringify({
          version: 1,
          reason: 'r',
          at: 't',
          sessions: [],
          state: 'half',
          trace: [],
        }),
      ).status,
    ).toBe('malformed')
    expect(
      parseMarker(JSON.stringify({ version: 1, reason: 'r', at: 't', sessions: 'x', trace: [] }))
        .status,
    ).toBe('malformed')
  })

  it('读 marker：`文件不在`（absent）与`读失败`（unreadable）是两件事，不许合并', async () => {
    const absent = await readRestartMarker(makeFs({ absent: true }).port, HOME)
    expect(absent.status).toBe('absent')

    const broken = await readRestartMarker(makeFs({ unreadable: true }).port, HOME)
    expect(broken.status).toBe('unreadable')
    expect(broken.status).not.toBe('absent')

    const port = jestLikeThrowingRead()
    const threw = await readRestartMarker(port, HOME)
    expect(threw.status).toBe('unreadable')
    expect(threw.status).not.toBe('absent')
  })
})

describe('lib/restart · 闸① 重启循环熔断', () => {
  it('冷却窗口内重启过 ⇒ 拒绝（走完整入口），且一次都不写', async () => {
    const { ports, fs } = portsFor({ history: { known: true, value: [NOW - 5_000] } })
    const refused = mustRefuse(await planRestart(REQUEST, ports))
    expect(refused.gate).toBe('restart-loop')
    expect(refused.code).toBe('restart-loop')
    expectRefusalShape(refused)
    expect(refused.verdict).toContain('restart-loop')
    expect(refused.gatesPassed).toEqual([])
    expect(fs.writes).toEqual([])
  })

  it('边界：刚好等于冷却窗口 ⇒ 放行；窗口内 1ms ⇒ 拒绝', async () => {
    const outside = portsFor({ history: { known: true, value: [NOW - RESTART_COOLDOWN_MS] } })
    expect((await planRestart({ ...REQUEST, dryRun: true }, outside.ports)).kind).toBe('ready')

    const inside = portsFor({ history: { known: true, value: [NOW - RESTART_COOLDOWN_MS + 1] } })
    expect((await planRestart({ ...REQUEST, dryRun: true }, inside.ports)).kind).toBe('refused')
  })

  it('历史取不到 ⇒ 也拒绝（不把「取不到」当成「没重启过」）', () => {
    const decision = judgeRestartLoop({
      history: { known: false, reason: 'the restart log is unreadable' },
      now: NOW,
    })
    expect(decision.passed).toBe(false)
    if (decision.passed) throw new Error('期望拒绝')
    expect(decision.code).toBe('restart-loop')
  })
})

describe('lib/restart · 闸③ bundle 表 / 闸④ 启动命令', () => {
  it('bundle 表解析不了 ⇒ 拒绝，并指路 dsh_dump_config', async () => {
    const { ports, fs } = portsFor({
      bundles: { known: false, reason: 'the profile package.json is not valid JSON' },
    })
    const refused = mustRefuse(await planRestart(REQUEST, ports))
    expect(refused.gate).toBe('composition')
    expect(refused.code).toBe('bad-composition')
    expectRefusalShape(refused)
    expect(refused.suggestedTool).toBe('dsh_dump_config')
    expect(refused.gatesPassed).toEqual(['restart-loop', 'busy-session'])
    expect(fs.writes).toEqual([])
  })

  it('拿不到启动命令 ⇒ 拒绝（不猜），并标成 manual', async () => {
    const { ports, fs } = portsFor({
      launch: { known: false, reason: 'argv[1] is not a startable entry' },
    })
    const refused = mustRefuse(await planRestart(REQUEST, ports))
    expect(refused.gate).toBe('launch-command')
    expect(refused.code).toBe('no-launch-command')
    expectRefusalShape(refused)
    expect(refused.manual).toBe(true)
    expect(refused.verdict).toContain('does not guess')
    expect(fs.writes).toEqual([])
  })

  it('「解析出来了但是空命令」同样拒绝（拿到了 ≠ 拿到了有用的）', async () => {
    const { ports } = portsFor({
      launch: { known: true, value: { command: '   ', args: [], cwd: '' } },
    })
    const refused = mustRefuse(await planRestart(REQUEST, ports))
    expect(refused.code).toBe('no-launch-command')
  })
})

/**
 * 闸④ 的**第一问是路线**（2026-10-15 真机缺陷的根因）。
 *
 * 这一节钉四件：
 * 1. **桌面端在动手之前被拒**，而且是**零写**（数调用次数，不看返回值）；
 * 2. **`cli × linux` 也拒绝** —— 平台分支由 `carrierOf(..., 'linux')` **注入**，
 *    所以这条在任何机器上都被真跑到（坑 25：不许按真实平台分支）；
 * 3. **`unknown` 拒绝**（不许把「不知道」当成「有路线」）；
 * 4. **两档拒绝码分得开**：路线有、命令空 ⇒ 仍是 `no-launch-command`。
 *    （四条合起来才是「先问路线、再问命令」这个顺序的判据；只测前三条时，
 *    一个「永远返回 no-relaunch-route」的实现也是绿的。）
 */
describe('lib/restart · 闸④ 先问路线：没有回归路线的载体在动手前被拒', () => {
  /** 三格「没有路线」的载体：桌面 / 非 win32 的命令行 / 认不出来。 */
  const noRoute: ReadonlyArray<{ label: string; carrier: CarrierObservation }> = [
    { label: '桌面宿主', carrier: carrierOf('desktop-host', 'win32') },
    { label: 'cli × linux', carrier: carrierOf('cli', 'linux') },
    { label: 'cli × darwin', carrier: carrierOf('cli', 'darwin') },
    { label: '认不出来', carrier: carrierOf('unknown', 'win32') },
  ]

  it('每一格都 ⇒ no-relaunch-route + manual + 零写 marker（走完整入口）', async () => {
    for (const item of noRoute) {
      // 前置：这张表本身必须真的没有路线，否则下面断的是别的东西。
      expect(relaunchRouteFor(item.carrier), `${item.label}: 路线表与用例不一致`).toBe('none')
      const { ports, fs } = portsFor()
      const plan = await planRestart({ ...REQUEST, carrier: item.carrier, dryRun: false }, ports)
      const refused = mustRefuse(plan)
      expect(refused.gate, `${item.label}: 不是闸④`).toBe('launch-command')
      expect(refused.code, `${item.label}: 拒绝码不是 no-relaunch-route`).toBe('no-relaunch-route')
      expect(refused.manual, `${item.label}: 没标成「要人来做」`).toBe(true)
      expectRefusalShape(refused)
      // 根因事实：**一次都没写**（不是「返回值看起来没写」）。
      expect(fs.writes, `${item.label}: 被拒却写了 marker`).toEqual([])
      // verdict / remedy 逐字来自那三档文案的唯一出处。
      const refusal = relaunchRefusalFor(item.carrier)
      expect(refused.verdict, `${item.label}: verdict 没带上那一档的原话`).toContain(refusal.reason)
      expect(refused.remedy, `${item.label}: remedy 不是那一档的`).toBe(refusal.remedy)
      // evidence 至少含三行机器码（复核「凭什么判成这一档」）。
      expect(refused.evidence.some((line) => line.startsWith('carrier: '))).toBe(true)
      expect(refused.evidence.some((line) => line.startsWith('platform: '))).toBe(true)
      expect(refused.evidence.some((line) => line.startsWith('rule: '))).toBe(true)
      // 防空转：桌面那一档必须点名 Desktop，linux 那一档必须把平台名带出来。
      expect(refused.verdict, `${item.label}: 文案串档了`).toContain(
        item.carrier.kind === 'desktop-host'
          ? 'Desktop'
          : item.carrier.kind === 'unknown'
            ? 'could not be identified'
            : item.carrier.platform,
      )
    }
  })

  it('四格的 verdict 两两不同（压成一句就是把三值压成两值）', () => {
    const refusals = noRoute.map((item) =>
      judgeLaunchCommand({ launch: { known: true, value: LAUNCH }, carrier: item.carrier }),
    )
    const verdicts = refusals.map((decision) => (decision.passed ? '' : decision.verdict))
    expect(new Set(verdicts).size, '四格给出了同一句 —— 三档文案被压平了').toBe(4)
    expect(new Set(verdicts).has('')).toBe(false)
  })

  it('桌面端：命令**拼得出来也照样拒绝** —— 路线先于命令（真机缺陷的那条路径）', () => {
    const desktop = carrierOf('desktop-host', 'win32')
    // 命令是完好的（真机上它就是「拼得出来」的）——判据必须**不看它**就拒。
    const refused = judgeLaunchCommand({
      launch: { known: true, value: { command: 'node', args: ['bin.js'], cwd: 'C:/repo' } },
      carrier: desktop,
    })
    expect(refused.passed).toBe(false)
    if (refused.passed) throw new Error('期望拒绝')
    expect(refused.code).toBe('no-relaunch-route')
    // 反空转：同一份命令换成有路线的载体 ⇒ **必须放行**（否则上面那条可能只是恒拒）。
    const allowed = judgeLaunchCommand({
      launch: { known: true, value: { command: 'node', args: ['bin.js'], cwd: 'C:/repo' } },
      carrier: CLI_WIN32,
    })
    expect(allowed.passed, 'cli × win32 也被拒了 —— 判据成了恒拒').toBe(true)
  })

  it('cli × win32：路线有 ⇒ 空命令才是 no-launch-command（两档码必须分得开）', async () => {
    const empty = portsFor({ launch: { known: true, value: { command: '  ', args: [], cwd: '' } } })
    const refused = mustRefuse(await planRestart(REQUEST, empty.ports))
    expect(refused.code).toBe('no-launch-command')
    expect(refused.gate).toBe('launch-command')

    // 反空转：同一条路径上少一个 `known: true` ⇒ 同样是 `no-launch-command`（不是路线那一档）。
    const unknown = portsFor({
      launch: { known: false, reason: 'argv[1] is not a startable entry' },
    })
    const refused2 = mustRefuse(await planRestart(REQUEST, unknown.ports))
    expect(refused2.code).toBe('no-launch-command')
    expect(refused2.evidence).toEqual(['argv[1] is not a startable entry'])
  })

  it('`withPlatform` 显式声明：路线的平台来自**载体观测**，不是进程的 `process.platform`', async () => {
    // 伪装成 linux、但载体观测说的是 cli × win32 ⇒ 闸④（路线）**放行**，
    // 而取值面（`process.platform`）拒绝 ⇒ 落到第二档 `no-launch-command`。
    // 这一条把「两层必须同意同一套规则」钉住了：只看其中一层都会得到另一个结论。
    const observed = await withPlatform('linux', async () =>
      planRestart({ ...REQUEST, carrier: CLI_WIN32, dryRun: true }, portsFor().ports),
    )
    // 取值面是注入端口给的常量（`LAUNCH`），所以这里预期 4/4 放行 —— 它证明的正是
    // 「闸④路线那一问读的是 `carrier.platform`，与进程平台无关」。
    expect(observed.kind, '路线那一问读了 process.platform 而不是载体观测').toBe('ready')
    // 反空转：同一个进程平台下，把载体观测换成 linux ⇒ 路线那一问就拒。
    const refused = await withPlatform('linux', async () =>
      planRestart(
        { ...REQUEST, carrier: carrierOf('cli', 'linux'), dryRun: true },
        portsFor().ports,
      ),
    )
    expect(refused.kind).toBe('refused')
    if (refused.kind !== 'refused') throw new Error('期望拒绝')
    expect(refused.code).toBe('no-relaunch-route')
  })

  it('`carrierAuditOf` 的投影与 `planRestart` 的 evidence 说的是同一件事（同一份观测）', () => {
    const desktop = carrierOf('desktop-host', 'win32')
    const decision = judgeLaunchCommand({ launch: { known: false, reason: 'x' }, carrier: desktop })
    if (decision.passed) throw new Error('期望拒绝')
    const audit = carrierAuditOf(desktop)
    expect(decision.evidence).toContain(`carrier: ${audit.kind}`)
    expect(decision.evidence).toContain(`platform: ${audit.platform}`)
    expect(decision.evidence).toContain(`rule: ${audit.rule}`)
    // 「可无损落 JSON」这条边界同样管 evidence（宿主会逐值校验）。
    expect(JSON.parse(JSON.stringify(decision.evidence))).toEqual(decision.evidence)
  })
})

describe('lib/restart · 四条拒绝的理由互不相同（防空转）', () => {
  it('四道闸各拒一次：gate 与 verdict 两两不同', async () => {
    const cases: Array<[string, PortOverrides]> = [
      ['restart-loop', { history: { known: true, value: [NOW - 1_000] } }],
      ['busy', { busy: { known: true, value: [turn('session-other')] } }],
      ['bad-composition', { bundles: { known: false, reason: 'no manifest' } }],
      ['no-launch-command', { launch: { known: false, reason: 'no entry' } }],
    ]
    const seen: RestartPlanRefused[] = []
    for (const [expectedCode, overrides] of cases) {
      const { ports } = portsFor(overrides)
      const refused = mustRefuse(await planRestart(REQUEST, ports))
      expect(refused.code, `${expectedCode} 这条没被照出来`).toBe(expectedCode)
      expectRefusalShape(refused)
      seen.push(refused)
    }
    expect(new Set(seen.map((item) => item.gate)).size).toBe(4)
    expect(new Set(seen.map((item) => item.verdict)).size).toBe(4)
    expect(new Set(seen.map((item) => item.remedy)).size).toBe(4)
  })
})

describe('lib/restart · force 只覆盖闸②（不是万能钥匙）', () => {
  it('force: true 之下，闸①③④ **仍然拒绝**', async () => {
    const cases: Array<[string, PortOverrides]> = [
      ['restart-loop', { history: { known: true, value: [NOW - 1_000] } }],
      ['bad-composition', { bundles: { known: false, reason: 'no manifest' } }],
      ['no-launch-command', { launch: { known: false, reason: 'no entry' } }],
    ]
    for (const [expectedCode, overrides] of cases) {
      const { ports, fs } = portsFor(overrides)
      const plan = await planRestart({ ...REQUEST, force: true }, ports)
      const refused = mustRefuse(plan)
      expect(refused.code, `${expectedCode} 被 force 放过了 —— force 成了万能钥匙`).toBe(
        expectedCode,
      )
      expect(fs.writes).toEqual([])
    }
  })

  it('force 覆盖「确实有人忙」⇒ 放行，且 marker 里留痕（force: true + trace）', async () => {
    const { ports, fs } = portsFor({ busy: { known: true, value: [turn('session-other')] } })
    const ready = mustReady(await planRestart({ ...REQUEST, force: true }, ports))
    expect(ready.markerWritten).toBe(true)
    expect(ready.marker.force).toBe(true)
    expect(ready.marker.trace.some((line) => /force override/u.test(line))).toBe(true)

    // 留痕真的**落到了盘上**（不只在返回值里）
    expect(fs.writes).toHaveLength(1)
    const written = parseMarker(fs.writes[0]?.text ?? '')
    expect(written.status).toBe('ok')
    if (written.status !== 'ok') throw new Error('期望解析成功')
    expect(written.marker.force).toBe(true)
    expect(written.marker.trace.some((line) => /force override/u.test(line))).toBe(true)
    // 被打断的会话也在名单里（重启后要等它们回来）
    expect(ready.marker.sessions).toEqual(['session-aaaa-1111-bbbb', 'session-other'])
  })

  it('force 给了但没人忙 ⇒ **不算覆盖**：marker 里没有 force 键（缺席 ≠ false）', async () => {
    const { ports, fs } = portsFor()
    const ready = mustReady(await planRestart({ ...REQUEST, force: true }, ports))
    expect('force' in ready.marker).toBe(false)
    const written = parseMarker(fs.writes[0]?.text ?? '')
    if (written.status !== 'ok') throw new Error('期望解析成功')
    expect('force' in written.marker).toBe(false)
    expect(written.marker.trace.some((line) => /force override/u.test(line))).toBe(false)
  })

  it('force **不能**覆盖「忙闲状态取不到」—— 覆盖的前提是知道要打断谁', async () => {
    const { ports } = portsFor({
      busy: { known: false, reason: 'the agent service is unavailable' },
    })
    const refused = mustRefuse(await planRestart({ ...REQUEST, force: true }, ports))
    expect(refused.code).toBe('busy')
    expect(refused.verdict).toContain('could not be determined')
  })
})

describe('lib/restart · 闸② fail-closed 与「自己的会话不算忙」', () => {
  it('忙闲状态取不到 ⇒ fail-closed（不许当成「不忙」）', async () => {
    const { ports, fs } = portsFor({
      busy: { known: false, reason: 'the agent service is unavailable' },
    })
    const refused = mustRefuse(await planRestart(REQUEST, ports))
    expect(refused.gate).toBe('busy-session')
    expect(refused.code).toBe('busy')
    expectRefusalShape(refused)
    expect(refused.evidence).toEqual(['the agent service is unavailable'])
    expect(fs.writes).toEqual([])

    // 反空转：同一个入口、只把「取不到」换成「取到了、没人忙」⇒ 必须放行。
    const idle = portsFor({ busy: { known: true, value: [] } })
    expect((await planRestart({ ...REQUEST, dryRun: true }, idle.ports)).kind).toBe('ready')
  })

  it('自己的会话不算忙：只有自己忙 ⇒ 过；另有别人忙 ⇒ 拒（两种情形结论必须不同）', async () => {
    const self = 'aaaa-1111-bbbb'
    const selfRuntime = `session-${self}`

    const onlySelf = portsFor({ busy: { known: true, value: [turn(selfRuntime)] } })
    const selfPlan = await planRestart(
      { ...REQUEST, callingSession: self, dryRun: true },
      onlySelf.ports,
    )

    const others = portsFor({
      busy: { known: true, value: [turn(selfRuntime), turn('session-other')] },
    })
    const otherPlan = await planRestart(
      { ...REQUEST, callingSession: self, dryRun: true },
      others.ports,
    )

    // 防空转的第一步：两种情形的判定**必须不同**，否则「排除自己」根本没被测到。
    expect(selfPlan.kind, '只有自己忙时被拒了 —— 判据没把自己排掉').toBe('ready')
    expect(otherPlan.kind).toBe('refused')

    const refused = mustRefuse(otherPlan)
    expect(refused.evidence).toEqual(['turn:session-other'])
    expect(refused.evidence).not.toContain(`turn:${selfRuntime}`)
    expect(refused.evidence).not.toContain(self)
  })

  it('只排除「调用方自己那个回合」：**属于调用方的后台作业照旧算忙**（契约 §2.3）', async () => {
    const self = 'aaaa-1111-bbbb'
    const selfRuntime = `session-${self}`

    // 契约原话：只把「调用方自己那个会话」从 running / 排队里排除；
    // **后台任务与定时提醒照旧全算（含调用方自己的）**。
    const ownJob = portsFor({
      busy: { known: true, value: [turn(selfRuntime), job('job-7', self)] },
    })
    const refused = mustRefuse(
      await planRestart({ ...REQUEST, callingSession: self, dryRun: true }, ownJob.ports),
    )
    expect(refused.code).toBe('busy')
    expect(refused.evidence).toEqual(['job:job-7'])

    // 反空转：同一条用例里，把那个作业去掉 ⇒ 必须放行（否则上面那条可能只是恒拒）。
    const alone = portsFor({ busy: { known: true, value: [turn(selfRuntime)] } })
    expect(
      (await planRestart({ ...REQUEST, callingSession: self, dryRun: true }, alone.ports)).kind,
    ).toBe('ready')
  })

  it('两种 id 形态都能对上自己：调用方传裸 uuid / 忙列表里是运行期键，两个方向都排除', async () => {
    const self = 'aaaa-1111-bbbb'
    const runtimeKey = `session-${self}`

    // 方向一：调用方裸 uuid、忙列表是运行期键
    const a = portsFor({ busy: { known: true, value: [turn(runtimeKey)] } })
    expect(
      (await planRestart({ ...REQUEST, callingSession: self, dryRun: true }, a.ports)).kind,
    ).toBe('ready')

    // 方向二：调用方是运行期键、忙列表是裸 uuid
    const b = portsFor({ busy: { known: true, value: [turn(self)] } })
    expect(
      (await planRestart({ ...REQUEST, callingSession: runtimeKey, dryRun: true }, b.ports)).kind,
    ).toBe('ready')

    // 非法 id ⇒ 判失败（不许猜「这是不是调用方」）
    expect(normalizeSessionId('')).toBe('')
    expect(normalizeSessionId('has space')).toBe('')
    expect(
      judgeBusySession({
        busy: { known: true, value: [] },
        callingSession: 'has space',
        force: false,
      }).passed,
    ).toBe(false)
  })
})

describe('lib/restart · dryRun 零副作用（数调用次数，不看返回值）', () => {
  it('dryRun ⇒ 写端口一次都没被调用；同一组端口在非演练下**必须**恰好写一次', async () => {
    const dry = portsFor()
    const ready = mustReady(await planRestart({ ...REQUEST, dryRun: true }, dry.ports))
    expect(ready.dryRun).toBe(true)
    expect(ready.markerWritten).toBe(false)
    // 根因事实：写端口零调用（不是「返回值一样」）。
    expect(dry.fs.writes).toEqual([])
    expect(dry.fs.reads).toEqual([])

    // 反空转：换 dryRun: false，同一组端口必须**恰好写一次**且写在本包命名空间的那个路径上 ——
    // 否则上面那个 `toEqual([])` 可能只是因为这条路径压根不碰写端口。
    const live = portsFor()
    const planned = mustReady(await planRestart({ ...REQUEST, dryRun: false }, live.ports))
    expect(live.fs.writes).toHaveLength(1)
    expect(live.fs.writes[0]?.path).toBe(restartMarkerPath(HOME))
    expect(planned.markerPath).toBe(restartMarkerPath(HOME))
    expect(planned.markerWritten).toBe(true)
  })

  it('演练也照样把四道闸走完（拒绝时同样零写）', async () => {
    const { ports, fs } = portsFor({ history: { known: true, value: [NOW - 1] } })
    const refused = mustRefuse(await planRestart({ ...REQUEST, dryRun: true }, ports))
    expect(refused.code).toBe('restart-loop')
    expect(fs.writes).toEqual([])
  })
})

describe('lib/restart · 接线：走完整入口 planRestart', () => {
  it('四道闸全绿 ⇒ 写一次 marker，且写出的东西能原样读回（内容不是只在返回值里）', async () => {
    const { ports, fs } = portsFor()
    const ready = mustReady(await planRestart(REQUEST, ports))

    expect(ready.verdict.startsWith('gates=4/4 passed')).toBe(true)
    expect(ready.markerPath).toBe(restartMarkerPath(HOME))
    expect(ready.launch).toEqual(LAUNCH)
    expect(fs.writes).toHaveLength(1)
    expect(fs.writes[0]?.path).toBe(ready.markerPath)
    expect(ready.marker.sessions).toEqual(['session-aaaa-1111-bbbb'])
    expect(ready.marker.reason).toBe(REQUEST.reason)
    // 发起者**单独记**（`sessions` 排过序，光看那个数组分不出谁发起的）——
    // 它是「`reason` 只发给谁」的唯一依据，缺了这一步恢复半就只能谁都不发。
    expect(ready.marker.initiator).toBe('session-aaaa-1111-bbbb')

    const written = parseMarker(fs.writes[0]?.text ?? '')
    expect(written.status).toBe('ok')
    if (written.status !== 'ok') throw new Error('期望解析成功')
    expect(isDeepStrictEqual(written.marker, ready.marker)).toBe(true)

    // 「写 marker 必须在拉起之前」在接口上的落点：只有它为 true 才允许拉起。
    expect(ready.markerWritten).toBe(true)
    // 而且本层**不**产生 pid（拉起在工具半边）—— 这一点写在输出里，别让模型以为进程已经换了。
    expect(ready.verdict).toContain('no new pid')
  })

  it('入口绝不抛（B24 的承载条件）：端口抛异常、dshHome 为空，都收敛成结构化失败', async () => {
    const { ports, fs } = portsFor()
    const throwing: RestartPorts = {
      ...ports,
      busySessions: async () => {
        throw new Error('the agent service exploded')
      },
    }
    const failed = await planRestart(REQUEST, throwing)
    expect(failed.kind).toBe('failed')
    if (failed.kind !== 'failed') throw new Error('期望结构化失败')
    expect(failed.verdict).toContain('nothing was written')
    expect(fs.writes).toEqual([])

    const emptyHome = portsFor()
    const noHome = await planRestart({ ...REQUEST, dshHome: '   ' }, emptyHome.ports)
    expect(noHome.kind).toBe('failed')
    expect(emptyHome.fs.writes).toEqual([])
  })
})

describe('lib/restart · 恢复判定（三值纪律）', () => {
  it('marker 不在 ⇒ none(absent)；在且认识 ⇒ recover（带名单）', async () => {
    const absent = await readRestartMarker(makeFs({ absent: true }).port, HOME)
    const absentDecision = decideRecovery(absent)
    expect(absentDecision.action).toBe('none')
    if (absentDecision.action !== 'none') throw new Error('期望 none')
    expect(absentDecision.reason).toBe('absent')

    const marker = parseOk()
    const read = await readRestartMarker(makeFs({ text: serializeMarker(marker) }).port, HOME)
    const decision = decideRecovery(read)
    expect(decision.action).toBe('recover')
    if (decision.action !== 'recover') throw new Error('期望 recover')
    expect(decision.sessions).toEqual(marker.sessions)
    expect(decision.overridden).toBe(false)
  })

  it('**已消费**的 marker ⇒ none(consumed)，且与「文件不在」走**不同**的分支', async () => {
    const consumedMarker: RestartMarker = { ...parseOk(), state: 'consumed' }
    const read = await readRestartMarker(
      makeFs({ text: serializeMarker(consumedMarker) }).port,
      HOME,
    )
    const consumed = decideRecovery(read)
    const absent = decideRecovery(await readRestartMarker(makeFs({ absent: true }).port, HOME))

    // 两者 action 都是 none —— 但**取值/渲染必须不同**（防空转：否则「已消费」没被测到）。
    expect(consumed.action).toBe('none')
    expect(absent.action).toBe('none')
    expect(JSON.stringify(consumed)).not.toBe(JSON.stringify(absent))
    if (consumed.action !== 'none' || absent.action !== 'none') throw new Error('期望 none')
    if (consumed.reason !== 'consumed' || absent.reason !== 'absent') {
      throw new Error('期望两种 none 的原因不同')
    }
    expect(consumed.reason).not.toBe(absent.reason)
    // 审计价值：已消费那份**带着原 marker**，说得出「上次重启是什么时候」。
    expect(consumed.marker.at).toBe(consumedMarker.at)
  })

  it('老 marker 没有 `state` 键 ⇒ 当成 **armed**（沿用同一条默认），仍判 recover', async () => {
    const legacy = JSON.stringify({
      version: MARKER_VERSION,
      reason: 'r',
      at: '2026-10-14T06:00:00.000Z',
      sessions: ['session-a'],
      trace: [],
    })
    const read = await readRestartMarker(makeFs({ text: legacy }).port, HOME)
    const decision = decideRecovery(read)
    expect(decision.action).toBe('recover')
  })

  it('未知版本 / 格式坏 / 读失败 ⇒ **refuse**，绝不是 none（别把取不到印成没有）', async () => {
    const unsupported = await readRestartMarker(
      makeFs({
        text: JSON.stringify({ version: 99, reason: 'r', at: 't', sessions: [], trace: [] }),
      }).port,
      HOME,
    )
    const unsupportedDecision = decideRecovery(unsupported)
    expect(unsupportedDecision.action).toBe('refuse')
    expect(unsupportedDecision.action).not.toBe('none')

    const malformed = await readRestartMarker(makeFs({ text: '{ broken' }).port, HOME)
    expect(decideRecovery(malformed).action).toBe('refuse')

    const unreadable = await readRestartMarker(makeFs({ unreadable: true }).port, HOME)
    const unreadableDecision = decideRecovery(unreadable)
    expect(unreadableDecision.action).toBe('refuse')
    if (unreadableDecision.action !== 'refuse') throw new Error('期望 refuse')
    expect(unreadableDecision.code).toBe('unreadable')
    expect(unreadableDecision.remedy.length).toBeGreaterThan(0)
  })

  it('覆盖过的 marker 在恢复时仍说得出来（force 留痕能被看到）', async () => {
    const marker: RestartMarker = {
      version: MARKER_VERSION,
      reason: 'r',
      at: '2026-10-14T06:00:00.000Z',
      sessions: ['session-a'],
      force: true,
      trace: ['force override: 1 running session(s) were interrupted (session-a)'],
    }
    const read = await readRestartMarker(makeFs({ text: serializeMarker(marker) }).port, HOME)
    const decision = decideRecovery(read)
    if (decision.action !== 'recover') throw new Error('期望 recover')
    expect(decision.overridden).toBe(true)
  })
})

describe('lib/restart · 消费 = 状态迁移（宿主 fs 没有删除）', () => {
  it('`consumeRestartMarker` 写回同一路径、state 变 consumed、at 原样、trace 留痕', async () => {
    const marker = parseOk()
    const fs = makeFs()
    const consumed = await consumeRestartMarker(fs.port, HOME, marker, NOW)

    expect(consumed.state).toBe('consumed')
    // `at` 是「这次重启发生在什么时候」——**不许**被改写成「文件最后被改的时刻」。
    expect(consumed.at).toBe(marker.at)
    expect(consumed.trace.length).toBe(marker.trace.length + 1)
    expect(consumed.trace.at(-1)).toContain('consumed at')

    // 真的写回了**同一个路径**（不是别处，也不是没写）。
    expect(fs.writes).toHaveLength(1)
    expect(fs.writes[0]?.path).toBe(restartMarkerPath(HOME))
    const written = parseMarker(fs.writes[0]?.text ?? '')
    if (written.status !== 'ok') throw new Error('期望解析成功')
    expect(written.marker.state).toBe('consumed')
    // 幂等：再消费一次，写回去的还是 consumed。
    const twice = markerAfterConsumption(consumed, NOW)
    expect(twice.state).toBe('consumed')
    expect(markerState(twice)).toBe('consumed')
  })

  it('走完整入口：写(armed) → 读 → 消费 → 再读 ⇒ decideRecovery 返回 none(consumed)', async () => {
    const { ports, fs } = portsFor()
    const plan = mustReady(await planRestart(REQUEST, ports))
    expect(plan.marker.state).toBe('armed')

    const before = decideRecovery(await readRestartMarker(ports.fs, HOME))
    expect(before.action).toBe('recover')

    const consumed = await consumeRestartMarker(ports.fs, HOME, plan.marker, NOW)
    expect(consumed.state).toBe('consumed')

    const after = decideRecovery(await readRestartMarker(ports.fs, HOME))
    expect(after.action).toBe('none')
    if (after.action !== 'none') throw new Error('期望 none')
    expect(after.reason).toBe('consumed')
    expect(fs.writes).toHaveLength(2)
  })
})

/**
 * B10 白名单（形态 A）的**字面量自证**。
 *
 * 判据读的是「紧跟 `home` 的第一个路径段」这个**文本**，所以首段写成变量时它保守判红；
 * 于是包名改了而字面量没跟着改，就是一次静默的漂移。这条用例把它钉住。
 */
describe('lib/restart · B10 命名空间字面量自证', () => {
  const source = readFileSync(new URL('../../src/lib/restart.ts', import.meta.url), 'utf8')
  const manifest = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { name?: string }

  it('restartMarkerPath 里的命名空间字面量 == package.json 的 name', () => {
    const match = /join\(dshHome,\s*'([^']+)',\s*'restart',\s*'marker\.json'\)/u.exec(source)
    expect(
      match,
      "找不到「join(dshHome, '…', 'restart', 'marker.json')」—— 白名单判据读的就是这一行",
    ).not.toBeNull()
    expect(manifest.name, 'package.json 没有 name —— 这条自证会退化成恒真').toBeTruthy()
    expect(match?.[1]).toBe(manifest.name)
  })

  it('自证不是空转：首段换成变量时，同一条正则必须认不出来', () => {
    const pattern = /join\(dshHome,\s*'([^']+)',\s*'restart',\s*'marker\.json'\)/u
    expect(pattern.test("return join(dshHome, OWN_NAMESPACE, 'restart', 'marker.json')")).toBe(
      false,
    )
  })

  it('本文件自己不 import node:fs —— 写动作只发生在注入端口上', () => {
    // 本卡实测：src/ 里只要 import 了 node:fs 的写 API，B10 就判红，**与路径无关**。
    // 所以这一层把 IO 全部推给端口。若将来把真实适配器搬进本文件，这条会**响亮**地红 ——
    // 那正是它该红的时刻（届时要同批改 B10，而不是让这条静默失效）。
    // 判据只看 **import 语句**：正文注释里为了解释这条约束必须能提到 node:fs。
    expect(/\bfrom\s+['"]node:fs/u.test(source)).toBe(false)
    // 自证这条正则不是恒真：同样的形态出现在别处时它必须认出来。
    expect(/\bfrom\s+['"]node:fs/u.test("import { readFile } from 'node:fs/promises'")).toBe(true)
  })
})

/** 造一份合法的 marker（测试内部用）。 */
function parseOk(): RestartMarker {
  return {
    version: MARKER_VERSION,
    reason: 'a restart is required',
    at: '2026-10-14T06:00:00.000Z',
    sessions: ['session-a'],
    trace: ['restart-loop=pass'],
  }
}

/** 一个「读就抛」的端口 —— 用来证明端口的契约之外也兜得住。 */
function jestLikeThrowingRead(): RestartFsPort {
  return {
    read: async () => {
      throw new Error('the disk went away')
    },
    write: async () => undefined,
  }
}
