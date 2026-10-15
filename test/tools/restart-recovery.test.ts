/**
 * `src/lib/restart-recovery.ts` 的判据 —— **不依赖真机**，全部用注入端口。
 *
 * 这一份要钉住的不是「功能跑通了」，而是五件容易写成假绿的事：
 *
 * 1. **两个 `action:'none'` 走不同的分支**（`absent` / `consumed`）—— 合并它们就是把
 *    「已消费」静默当成「没有 marker」；
 * 2. **读到了但没懂 ⇒ 绝不静默**：`unreadable` / `malformed` / `unsupported-version`
 *    各一条，且都留了痕（反空转：`absent` 那条**不**留痕）；
 * 3. **唤醒失败 ⇒ 保留 marker**，且下次启动**还会再试**（断言的是盘上那份没被改，不是
 *    「返回值看起来对」—— 活跃坑 37）；
 * 4. **顺序**：全部唤醒并投递成功之后才写回 `consumed`（事件序列，不是时间戳）；
 * 5. **接线**：`apply` 真的挂上了它（活跃坑 42）—— 判据函数被测 ≠ 接进了入口。
 *
 * ## 为什么用注入端口而不是真宿主
 *
 * 「投递了几次」「写了几次」「谁先谁后」这三件事，只有**数调用**才证明得了；返回值相同
 * 证明不了。所以替身记下每一次唤醒、每一次写，并维护一条**共享的事件序列**（顺序判据靠它）。
 *
 * ## 这一份里没有平台分支
 *
 * 恢复半不读 `process.platform`（唤醒、投递、写 marker 都与平台无关），所以这里不需要
 * `withPlatform`。真正有平台分支的是拉起那一半（`schtasks` 只在 Windows 上有已实测路线），
 * 那在 `task-30` 的壳里。**如果将来本模块长出平台分支，判据必须把「构造 + 执行」整段
 * 一起包进 `withPlatform`**（活跃坑 25 的隐蔽变体：只包构造 = 本机绿、CI 红）。
 */
import { readFileSync } from 'node:fs'

import { describe, expect, it, vi } from 'vitest'

import { apply } from '../../src/index.ts'
import {
  boundNoticeSummary,
  buildRecoveryNotice,
  createRecoveryChannel,
  createRecoveryPorts,
  NOTICE_SOURCE_KIND,
  NOTICE_SUMMARY_MAX_CHARS,
  noticeMessageOf,
  RECOVERY_STARTUP_DELAY_MS,
  RECOVERY_WAKE_ATTEMPTS,
  recoverRestart,
  recoveryLogOf,
  runStartupRecovery,
  STATE_TOOL,
  type NoticeMessage,
  type RecoveryNotice,
  type RecoveryOutcome,
  type RecoveryPorts,
  type WakeOutcome,
} from '../../src/lib/restart-recovery.ts'
import {
  MARKER_VERSION,
  parseMarker,
  restartMarkerPath,
  serializeMarker,
  type RestartFsPort,
  type RestartMarker,
  type TextRead,
} from '../../src/lib/restart.ts'

/** marker 写下的时刻（`at`）。 */
const AT = '2026-10-14T06:00:00.000Z'

/** 一个固定时刻：比 `at` 晚 **12 秒**，让「停机多久」可复现。 */
const NOW = Date.parse('2026-10-14T06:00:12.000Z')

/** 一个固定的 `$DSH_HOME`（判据只看拼接后的路径）。 */
const HOME = 'C:/dsh-home'

/** 造一份合法的 marker。 */
function markerFixture(overrides: Partial<RestartMarker> = {}): RestartMarker {
  return {
    version: MARKER_VERSION,
    reason: 'the plugin code changed',
    at: AT,
    sessions: ['session-a'],
    state: 'armed',
    trace: ['restart-loop=pass'],
    ...overrides,
  }
}

/** 一个**记调用**的 marker IO 替身；写会改掉读得到的内容（状态迁移类判据靠这一点）。 */
interface FsRecorder {
  port: RestartFsPort
  reads: string[]
  writes: { path: string; text: string }[]
  /** 盘上现在是什么（`undefined` = 文件不在）。 */
  stored(): string | undefined
}

/**
 * 造一个 IO 替身。
 *
 * @param seed `text` = 文件内容；`absent` = 文件不在；`unreadable` = 读失败（**两者不同**）。
 * @param events 共享事件序列（顺序判据靠它）；每次写记一条 `consume`。
 */
function makeFs(
  seed: { text?: string; absent?: boolean; unreadable?: boolean } = {},
  events: string[] = [],
): FsRecorder {
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
      events.push('consume')
    },
  }
  return { port, reads, writes, stored: () => stored }
}

/** 判据夹具：端口 + 全部可观测的调用记录。 */
interface Harness {
  ports: RecoveryPorts
  fs: FsRecorder
  /** 每次唤醒尝试记一条（重试次数靠它数）。 */
  wakeCalls: string[]
  /** 每次投递的那条 notice。 */
  notices: RecoveryNotice[]
  /** 唤醒与消费的**共享**事件序列（顺序判据靠它）。 */
  events: string[]
  logs: string[]
}

/**
 * 造一组端口替身。
 *
 * @param options `marker` 是初始盘上内容；`wake` 决定每次唤醒尝试的结果。
 */
function harness(
  options: {
    marker?: { text?: string; absent?: boolean; unreadable?: boolean }
    wake?: (sessionId: string, callIndex: number) => WakeOutcome | Promise<WakeOutcome>
    now?: number
  } = {},
): Harness {
  const events: string[] = []
  const logs: string[] = []
  const wakeCalls: string[] = []
  const notices: RecoveryNotice[] = []
  const fs = makeFs(options.marker ?? {}, events)
  const ports: RecoveryPorts = {
    fs: fs.port,
    channel: {
      wakeAndNotify: async (sessionId, notice): Promise<WakeOutcome> => {
        wakeCalls.push(sessionId)
        notices.push(notice)
        events.push(`wake:${sessionId}`)
        return await (options.wake?.(sessionId, wakeCalls.length) ?? { ok: true })
      },
    },
    log: (line) => logs.push(line),
    now: () => options.now ?? NOW,
    // **立即返回**：判据不真等 —— 重试次数是数出来的，不是等出来的。
    sleep: async () => undefined,
  }
  return { ports, fs, wakeCalls, notices, events, logs }
}

/** 断言结论是 `idle`。 */
function mustIdle(outcome: RecoveryOutcome): Extract<RecoveryOutcome, { kind: 'idle' }> {
  if (outcome.kind !== 'idle') throw new Error(`期望 idle，实际：${JSON.stringify(outcome)}`)
  return outcome
}

/** 断言结论是 `refused`。 */
function mustRefuse(outcome: RecoveryOutcome): Extract<RecoveryOutcome, { kind: 'refused' }> {
  if (outcome.kind !== 'refused') throw new Error(`期望 refused，实际：${JSON.stringify(outcome)}`)
  return outcome
}

/** 断言结论是 `recovered`。 */
function mustRecover(outcome: RecoveryOutcome): Extract<RecoveryOutcome, { kind: 'recovered' }> {
  if (outcome.kind !== 'recovered') {
    throw new Error(`期望 recovered，实际：${JSON.stringify(outcome)}`)
  }
  return outcome
}

/** 断言结论是 `pending`。 */
function mustPending(outcome: RecoveryOutcome): Extract<RecoveryOutcome, { kind: 'pending' }> {
  if (outcome.kind !== 'pending') throw new Error(`期望 pending，实际：${JSON.stringify(outcome)}`)
  return outcome
}

describe('lib/restart-recovery · 两个 none 分支必须分开', () => {
  it('`absent` 与 `consumed` 走**不同**的分支：取值不同、唤醒零次、写零次', async () => {
    const absent = harness({ marker: { absent: true } })
    const absentOutcome = mustIdle(await recoverRestart({ dshHome: HOME }, absent.ports))

    const consumedMarker = markerFixture({ state: 'consumed' })
    const consumed = harness({ marker: { text: serializeMarker(consumedMarker) } })
    const consumedOutcome = mustIdle(await recoverRestart({ dshHome: HOME }, consumed.ports))

    // 两者 `action` 都是 none —— 但**取值/渲染必须不同**（防空转：否则「已消费」没被测到）。
    expect(absentOutcome.reason).toBe('absent')
    expect(consumedOutcome.reason).toBe('consumed')
    expect(JSON.stringify(absentOutcome)).not.toBe(JSON.stringify(consumedOutcome))

    // 审计价值：已消费那份**带着原 marker**（说得出「上次重启是什么时候」）。
    if (consumedOutcome.reason !== 'consumed') throw new Error('期望 consumed')
    expect(consumedOutcome.marker.at).toBe(AT)
    // 反空转的另一半：`absent` 那份**不带** marker（否则「带 marker」是恒真的）。
    expect('marker' in absentOutcome).toBe(false)

    // 两条分支都不许唤醒、不许写。
    expect(absent.wakeCalls).toEqual([])
    expect(consumed.wakeCalls).toEqual([])
    expect(absent.fs.writes).toEqual([])
    expect(consumed.fs.writes).toEqual([])
    expect(absent.logs).toEqual([])
  })
})

describe('lib/restart-recovery · 读到了但没懂 ⇒ 绝不静默', () => {
  it('`unreadable` / `malformed` / `unsupported-version` 各一条：refused + 留痕 + 不消费', async () => {
    const cases: Array<[string, { text?: string; unreadable?: boolean }]> = [
      ['unreadable', { unreadable: true }],
      ['malformed', { text: '{ this is not json' }],
      [
        'unsupported-version',
        { text: JSON.stringify({ version: 99, reason: 'r', at: AT, sessions: [], trace: [] }) },
      ],
    ]
    const seen: RecoveryOutcome[] = []
    for (const [expectedCode, seed] of cases) {
      const host = harness({ marker: seed })
      const outcome = mustRefuse(await recoverRestart({ dshHome: HOME }, host.ports))

      expect(outcome.code, `${expectedCode} 这条没被照出来`).toBe(expectedCode)
      // 结构化报告三件：为什么、怎么解、证据。
      expect(outcome.verdict.length).toBeGreaterThan(0)
      expect(outcome.remedy.length).toBeGreaterThan(0)
      expect(outcome.evidence.length).toBeGreaterThan(0)

      // **留痕**：这是 refuse 分支唯一能被人看见的地方（marker 原地不动）。
      expect(host.logs.length, `${expectedCode} 静默了 —— 读不到被当成了没有`).toBeGreaterThan(0)
      expect(host.logs.join('\n')).toContain(expectedCode)

      // 不唤醒、不消费：marker 留在盘上给人工看。
      expect(host.wakeCalls).toEqual([])
      expect(host.fs.writes).toEqual([])
      seen.push(outcome)
    }
    // 三条**互不相同**（不是同一份渲染换个码）。
    expect(new Set(seen.map((item) => (item.kind === 'refused' ? item.code : ''))).size).toBe(3)
    expect(new Set(seen.map((item) => item.verdict)).size).toBe(3)
  })

  it('反空转：`absent` 那条**不**留痕（否则上面「留痕」是恒真的）', async () => {
    const absent = harness({ marker: { absent: true } })
    mustIdle(await recoverRestart({ dshHome: HOME }, absent.ports))
    expect(absent.logs).toEqual([])
  })

  it('`$DSH_HOME` 为空 ⇒ 结构化失败（**不是**「没有 marker」），且留痕', async () => {
    const host = harness()
    const outcome = await recoverRestart({ dshHome: '   ' }, host.ports)
    expect(outcome.kind).toBe('failed')
    // 连 marker 都没读（不知道去哪读）—— 不许静默当成 absent。
    expect(host.fs.reads).toEqual([])
    expect(host.logs.length).toBeGreaterThan(0)
  })
})

describe('lib/restart-recovery · 唤醒失败 ⇒ 保留 marker，下次再试', () => {
  it('全部失败：不消费、盘上那份**一个字都没改**，且再跑一次还会再试一轮', async () => {
    const host = harness({
      marker: { text: serializeMarker(markerFixture()) },
      wake: () => ({ ok: false, reason: 'the session is not there yet' }),
    })

    const first = mustPending(await recoverRestart({ dshHome: HOME }, host.ports))
    // **根因事实**（不是「没报错」）：marker 没被标已消费。
    expect(first.markerConsumed).toBe(false)
    expect(host.fs.writes).toEqual([])
    const onDisk = parseMarker(host.fs.stored() ?? '')
    expect(onDisk.status).toBe('ok')
    if (onDisk.status !== 'ok') throw new Error('期望解析成功')
    expect(onDisk.marker.state).not.toBe('consumed')

    expect(first.failures).toEqual([
      {
        sessionId: 'session-a',
        reason: 'the session is not there yet',
        attempts: RECOVERY_WAKE_ATTEMPTS,
      },
    ])
    expect(host.wakeCalls).toHaveLength(RECOVERY_WAKE_ATTEMPTS)
    // 每次失败都留痕（「等不到」是正常分支，但**不许**安静）。
    expect(host.logs.length).toBeGreaterThanOrEqual(RECOVERY_WAKE_ATTEMPTS)

    // 下次启动**还会再试**：同一组端口再跑一次 ⇒ 又试了一整轮。
    const second = mustPending(await recoverRestart({ dshHome: HOME }, host.ports))
    expect(second.markerConsumed).toBe(false)
    expect(host.wakeCalls).toHaveLength(RECOVERY_WAKE_ATTEMPTS * 2)
    expect(host.fs.writes).toEqual([])
  })

  it('部分成功也**整份保留**（硬要求）：成功的那个被投递过，失败的下次还会被再试', async () => {
    const armed = markerFixture({ sessions: ['session-a', 'session-b'] })
    const host = harness({
      marker: { text: serializeMarker(armed) },
      wake: (sessionId) =>
        sessionId === 'session-b' ? { ok: false, reason: 'gone' } : { ok: true },
    })

    const outcome = mustPending(await recoverRestart({ dshHome: HOME }, host.ports))
    expect(outcome.woken).toEqual(['session-a'])
    expect(outcome.failures.map((item) => item.sessionId)).toEqual(['session-b'])
    // 整份 marker 保留 —— 代价是下次会给 a 再投一条（信息性 notice，可接受）。
    expect(host.fs.writes).toEqual([])
    expect(host.fs.stored()).toBe(serializeMarker(armed))
  })

  it('重试到第 N 次成功 ⇒ 算成功（重试不是装饰）', async () => {
    let calls = 0
    const host = harness({
      marker: { text: serializeMarker(markerFixture()) },
      wake: () => {
        calls += 1
        return calls < 3 ? { ok: false, reason: 'not ready' } : { ok: true }
      },
    })
    const outcome = mustRecover(await recoverRestart({ dshHome: HOME }, host.ports))
    expect(outcome.woken).toEqual(['session-a'])
    expect(host.wakeCalls).toHaveLength(3)
  })
})

describe('lib/restart-recovery · notice 只放事实 + 指针', () => {
  it('含四件事实与一个指针；**不含**任何「请继续」话术', () => {
    const notice = buildRecoveryNotice(markerFixture(), NOW)

    expect(notice.text).toContain(AT) // 什么时候**请求**的重启
    expect(notice.text).toContain('about 12s after that request') // 距那次请求多久
    expect(notice.text).toContain('the plugin code changed') // 为什么
    expect(notice.text).toContain('consumed') // marker 的下场
    expect(notice.text).toContain(STATE_TOOL) // 指针：要看现状调哪个工具
    // ⚠️ S5：**不许把「请求重启的时刻」印成「已重启」**。写 marker 在拉起之前，
    // 新进程还要等 delayMs（默认 10s）⇒ 旧话术的「down for about Xs」系统性高估停机。
    // 把文案改回旧的那两句，下面两条各自判红。
    expect(notice.text, 'notice 把「请求重启」印成了「已重启」').not.toContain('was restarted at')
    expect(notice.text, 'notice 把延迟窗口算进了停机时长').not.toContain('down for about')
    // ⚠️ O4：指针必须点明那个工具的**必填参数**（`change` 是 required，四选一）。
    expect(notice.text, '指针没给必填参数 —— 模型会带空参数去调').toContain(
      `${STATE_TOOL} with the kind of change`,
    )
    // ⚠️ O5：重复投递要如实说出来（部分唤醒失败 ⇒ 整份 marker 保留 ⇒ 下次再投一次）。
    expect(notice.text, '重复投递没说 —— 模型会以为重启了两次').toContain(
      'delivered more than once',
    )

    // 决策笔记明确否决「请继续」：命令式续跑话术一个都不许有。
    const imperative = /\b(continue|resume|carry on|proceed|keep going)\b/iu
    expect(notice.text).not.toMatch(imperative)
    // 自证这条正则不是恒真（否则「不许出现」是空转）。
    expect('please continue where you left off').toMatch(imperative)
    expect('resume the task').toMatch(imperative)
  })

  it('不塞状态快照：正文里没有任何「字段=值」式的现状读数', () => {
    const notice = buildRecoveryNotice(markerFixture(), NOW)
    const snapshot = /\b(agents|plugins|bundles|sessions|hmr|mode|profile|loaded)\s*=/iu
    expect(notice.text).not.toMatch(snapshot)
    // 自证：这种读数真的会被认出来。
    expect('agents=2 plugins=7 mode=restart-required').toMatch(snapshot)
  })

  it('覆盖过就说出来（marker 里的 force 留痕不许在恢复时消失）', () => {
    const plain = buildRecoveryNotice(markerFixture(), NOW)
    const forced = buildRecoveryNotice(markerFixture({ force: true }), NOW)
    expect(forced.text).toContain('forced')
    expect(forced.text).not.toBe(plain.text)
    // 反空转：没覆盖过的那份**不许**背这句。
    expect(plain.text).not.toContain('forced')
  })

  it('`at` 解析不出来 ⇒ **不编**停机时长，而是把「推不出来」写成事实并原样带出时间戳', () => {
    const notice = buildRecoveryNotice(markerFixture({ at: 'not-a-timestamp' }), NOW)
    expect(notice.text).toContain('could not be derived')
    expect(notice.text).not.toContain('after that request')
    // 原样带出去，人才查得到（不许吞掉那个看不懂的值）。
    expect(notice.text).toContain('not-a-timestamp')
  })

  it('C31：notice 不许断言 marker「已消费」—— 投出去的那一刻消费还没发生', () => {
    // 真机实测过的那一格：marker 留在 `armed`，而投出去的 `summary` 写着
    // `host restarted at <at> - marker consumed` ⇒ 通知与盘上状态不符。
    // `summary` 是客户端折叠行上唯一能被人看见的那一句，所以它**不许**下这个断言。
    const notice = buildRecoveryNotice(markerFixture(), NOW)
    expect(notice.summary, 'summary 断言了「已消费」').not.toMatch(/\bconsumed\b/iu)
    expect(notice.summary).toContain('restart recovery')
    // S5：`summary` 里也不许写「已重启」（它只是「请求重启的时刻」）。
    expect(notice.summary, 'summary 把「请求重启」印成了「已重启」').toContain('requested at')
    // 正文里那句「下场」必须是**条件句**：消费以「全部唤醒成功」为前提。
    expect(notice.text).toMatch(/\bonly if\b/iu)
    expect(notice.text).toContain('stays armed')
    // 自证这条判据不是恒真：旧的逐字文案必须被认出来。
    expect(`restart requested at ${AT} - marker consumed`).toMatch(/\bconsumed\b/iu)
  })

  it('C31 端到端：唤醒失败（marker 留盘）时投出去的那条 notice 同样不含「已消费」', async () => {
    // 这条守的是**根因**：`buildRecoveryNotice` 是纯函数，上面那条只证明它本身干净；
    // 这里证明**真的走到 pending 分支时**投出去的就是那一份（顺序：notice 在 consume 之前）。
    const host = harness({
      marker: { text: serializeMarker(markerFixture()) },
      wake: () => ({ ok: false, reason: 'the session is not there yet' }),
    })
    const outcome = mustPending(await recoverRestart({ dshHome: HOME }, host.ports))
    expect(outcome.markerConsumed).toBe(false)
    expect(host.fs.writes, 'pending 却写了 marker').toEqual([])
    expect(host.notices.length).toBeGreaterThan(0)
    for (const notice of host.notices) {
      expect(notice.summary, 'pending 时投出的 notice 说 marker 已消费').not.toMatch(
        /\bconsumed\b/iu,
      )
      expect(notice.text).not.toMatch(/marker is consumed as the last step/iu)
    }
  })

  it('`summary` 非空、单行、≤120（C22：否则人看不见它是一行 notice）', () => {
    const notice = buildRecoveryNotice(markerFixture(), NOW)
    expect(notice.summary.trim().length).toBeGreaterThan(0)
    expect(notice.summary).not.toContain('\n')
    expect(notice.summary.length).toBeLessThanOrEqual(NOTICE_SUMMARY_MAX_CHARS)
    // 短的那条**不**被截（自证截断不是恒真）。
    expect(notice.summary.endsWith('...')).toBe(false)
    expect(boundNoticeSummary('short one')).toBe('short one')
  })

  it('超长 `at` ⇒ summary 被截到 ≤120 而不是溢出（宿主会把它放折叠行上）', () => {
    const long = buildRecoveryNotice(markerFixture({ at: 'x'.repeat(500) }), NOW)
    expect(long.summary.trim().length).toBeGreaterThan(0)
    expect(long.summary.length).toBeLessThanOrEqual(NOTICE_SUMMARY_MAX_CHARS)
    expect(long.summary.endsWith('...')).toBe(true)
    // 边界：刚好 120 不动、121 才截。
    expect(boundNoticeSummary('y'.repeat(NOTICE_SUMMARY_MAX_CHARS))).toHaveLength(
      NOTICE_SUMMARY_MAX_CHARS,
    )
    expect(boundNoticeSummary('y'.repeat(NOTICE_SUMMARY_MAX_CHARS + 1))).toHaveLength(
      NOTICE_SUMMARY_MAX_CHARS,
    )
  })

  it('投递形状：user 角色 + content 文本 + source `form:notice` 与非空 summary', () => {
    const notice: RecoveryNotice = { text: 'facts only', summary: 'one line' }
    const message: NoticeMessage = noticeMessageOf(notice, 'fixed-id')

    expect(message.role).toBe('user')
    expect(message.id).toBe('fixed-id')
    expect(message.content).toEqual([{ type: 'text', text: 'facts only' }])
    expect(message.source).toEqual({
      kind: NOTICE_SOURCE_KIND,
      form: 'notice',
      summary: 'one line',
    })
    // 自证：`form` 不是别的值（客户端按它选渲染器）。
    expect(message.source.form).not.toBe('snapshot')
  })
})

describe('lib/restart-recovery · 顺序与消费', () => {
  it('全部唤醒并投递成功之后才写回 `consumed`（事件序列里 consume 在最后）', async () => {
    const host = harness({
      marker: {
        text: serializeMarker(markerFixture({ sessions: ['session-a', 'session-b'] })),
      },
    })
    const outcome = mustRecover(await recoverRestart({ dshHome: HOME }, host.ports))

    expect(host.events).toEqual(['wake:session-a', 'wake:session-b', 'consume'])
    expect(outcome.woken).toEqual(['session-a', 'session-b'])
    expect(outcome.markerConsumed).toBe(true)
    expect(host.fs.writes).toHaveLength(1)
    expect(host.fs.writes[0]?.path).toBe(restartMarkerPath(HOME))
    // 投出去的就是那条 notice（不是另造一份）。
    expect(outcome.notice).toEqual(host.notices[0])

    // 盘上那份真的成了 `consumed`，且 `at` **原样**（审计事实不是文件修改时间）。
    const onDisk = parseMarker(host.fs.stored() ?? '')
    if (onDisk.status !== 'ok') throw new Error('期望解析成功')
    expect(onDisk.marker.state).toBe('consumed')
    expect(onDisk.marker.at).toBe(AT)
  })

  it('名单去重：手改过的 marker 里重复的 id 只唤醒一次', async () => {
    const host = harness({
      marker: {
        text: serializeMarker(markerFixture({ sessions: ['session-a', 'session-a'] })),
      },
    })
    const outcome = mustRecover(await recoverRestart({ dshHome: HOME }, host.ports))
    expect(host.wakeCalls).toEqual(['session-a'])
    expect(outcome.woken).toEqual(['session-a'])
  })

  it('名单为空 ⇒ 没有可唤醒的，仍然消费（「这次重启已被处理」是事实）', async () => {
    const host = harness({ marker: { text: serializeMarker(markerFixture({ sessions: [] })) } })
    const outcome = mustRecover(await recoverRestart({ dshHome: HOME }, host.ports))
    expect(host.wakeCalls).toEqual([])
    expect(outcome.woken).toEqual([])
    expect(host.fs.writes).toHaveLength(1)
  })

  it('端口抛异常 ⇒ 收敛成 `failed`、绝不抛出去、且**不消费** marker', async () => {
    const host = harness({ marker: { text: serializeMarker(markerFixture()) } })
    const throwing: RecoveryPorts = {
      ...host.ports,
      channel: {
        wakeAndNotify: async () => {
          throw new Error('the agent service exploded')
        },
      },
    }
    const outcome = await recoverRestart({ dshHome: HOME }, throwing)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') throw new Error('期望 failed')
    expect(outcome.verdict).toContain('not touched')
    expect(host.fs.writes).toEqual([])
    expect(host.logs.length).toBeGreaterThan(0)
  })

  it('**写回**失败 ⇒ 兜底不许说「marker 没被动过」（写已经发出去了，部分落盘是可能的）', async () => {
    // 同族第三处：兜底那句 `the marker was not touched` 原先**恒定地**盖住了这一格 ——
    // 而 `consumeRestartMarker` 的写已经发出去了，端口契约只承诺「失败要抛」、
    // 没有原子性承诺。把三态判据改回一句恒定的「没动过」，这条判红。
    const host = harness({ marker: { text: serializeMarker(markerFixture()) } })
    const failing: RecoveryPorts = {
      ...host.ports,
      fs: {
        read: host.fs.port.read,
        write: async () => {
          throw Object.assign(new Error('the marker write exploded'), { code: 'FS_IO_ERROR' })
        },
      },
    }
    const outcome = await recoverRestart({ dshHome: HOME }, failing)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') throw new Error('期望 failed')
    // 根因事实：真的走到了写那一步（否则下面那条「没说没动过」可能只是因为没轮到写）。
    expect(host.wakeCalls).toEqual(['session-a'])
    expect(outcome.verdict).toContain('writing the marker back')
    expect(outcome.verdict, '写失败被说成了「marker 没被动过」').not.toContain('not touched')
  })
})

describe('lib/restart-recovery · 接线（走完整入口跑两遍）', () => {
  it('第一遍：marker 在 → 恢复 → 标已消费；第二遍：`none(consumed)` 且**零次**唤醒', async () => {
    const host = harness({ marker: { text: serializeMarker(markerFixture()) } })

    const first = mustRecover(await recoverRestart({ dshHome: HOME }, host.ports))
    expect(first.markerConsumed).toBe(true)
    expect(host.wakeCalls).toEqual(['session-a'])
    expect(host.fs.writes).toHaveLength(1)

    const second = mustIdle(await recoverRestart({ dshHome: HOME }, host.ports))
    expect(second.reason).toBe('consumed')
    // **零次**唤醒 —— 这一条才证明「已消费」真的挡住了第二次恢复。
    expect(host.wakeCalls).toHaveLength(1)
    expect(host.fs.writes).toHaveLength(1)
  })
})

describe('lib/restart-recovery · 宿主适配（结构面，不 import 宿主包）', () => {
  const NOTICE: RecoveryNotice = { text: 'facts', summary: 'one line' }

  it('`{agent}` ⇒ 立刻 followup；消息形状是 user + `form:notice` + 非空 summary', async () => {
    const messages: NoticeMessage[] = []
    const ctx = {
      get: (name: string) =>
        name === 'sessionController'
          ? {
              resolveAgent: async (id: string) => ({
                agent: { id, followup: (message: NoticeMessage) => messages.push(message) },
              }),
            }
          : undefined,
    }

    const outcome = await createRecoveryChannel(ctx).wakeAndNotify('session-a', NOTICE)

    expect(outcome).toEqual({ ok: true })
    expect(messages).toHaveLength(1)
    expect(messages[0]?.role).toBe('user')
    expect(messages[0]?.content[0]?.text).toBe('facts')
    expect(messages[0]?.source).toEqual({
      kind: NOTICE_SOURCE_KIND,
      form: 'notice',
      summary: 'one line',
    })
    // 宿主 `createUserMessage` 也会自己造 id；手搓的那条同样要有（C21 的探针就是这么过的）。
    expect((messages[0]?.id ?? '').length).toBeGreaterThan(0)
  })

  it('`{error}` ⇒ 失败，且 reason 带稳定 code（按 `{error}` 分支判，不靠 try/catch）', async () => {
    const ctx = {
      get: () => ({
        resolveAgent: async () => ({
          error: { code: 'session/not-found', message: 'no such session' },
        }),
      }),
    }
    const outcome = await createRecoveryChannel(ctx).wakeAndNotify('session-ghost', NOTICE)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('期望失败')
    expect(outcome.reason).toContain('session/not-found')
    expect(outcome.reason).toContain('no such session')
  })

  it('`sessionController` 取不到 ⇒ 失败并明说「还没就绪」（C26：apply 的第一刻就是 undefined）', async () => {
    const outcome = await createRecoveryChannel({ get: () => undefined }).wakeAndNotify(
      'session-a',
      NOTICE,
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('期望失败')
    expect(outcome.reason).toContain('not available')
  })

  it('既没有 `agent` 也没有 `error` ⇒ 失败（**不猜**）', async () => {
    const ctx = { get: () => ({ resolveAgent: async () => ({}) }) }
    const outcome = await createRecoveryChannel(ctx).wakeAndNotify('session-a', NOTICE)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('期望失败')
    expect(outcome.reason).toContain('neither an agent nor an error')
  })

  it('缺 `followup` / `resolveAgent` 抛 / `followup` 抛 / 返回非对象 ⇒ 都收敛成失败，不冒出去', async () => {
    const cases: Array<[string, unknown]> = [
      ['no-followup', { get: () => ({ resolveAgent: async () => ({ agent: {} }) }) }],
      [
        'resolve-throws',
        {
          get: () => ({
            resolveAgent: async () => {
              throw new Error('resolve blew up')
            },
          }),
        },
      ],
      [
        'followup-throws',
        {
          get: () => ({
            resolveAgent: async () => ({
              agent: {
                followup: () => {
                  throw new Error('followup blew up')
                },
              },
            }),
          }),
        },
      ],
      ['non-object', { get: () => ({ resolveAgent: async () => 'nope' }) }],
    ]

    const outcomes: string[] = []
    for (const [, ctx] of cases) {
      const outcome = await createRecoveryChannel(ctx as never).wakeAndNotify('session-a', NOTICE)
      expect(outcome.ok).toBe(false)
      outcomes.push(outcome.ok ? '' : outcome.reason)
    }
    expect(outcomes).toEqual([
      'the resolved agent has no followup method',
      'resolveAgent threw: resolve blew up',
      'followup threw: followup blew up',
      'resolveAgent returned a non-object result (string)',
    ])
  })

  it('留痕口：有 `ctx.logger` 就走它；没有就退回 `console`（**绝不做成空操作**）', () => {
    const lines: string[] = []
    const withLogger = {
      logger: (name: string) => ({
        info: (line: string) => lines.push(`${name}:${line}`),
      }),
    }
    recoveryLogOf(withLogger)('hello')
    expect(lines).toEqual([`${NOTICE_SOURCE_KIND}:hello`])

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      recoveryLogOf({})('fallback line')
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain('fallback line')
    } finally {
      warn.mockRestore()
    }
  })
})

describe('apply 接线（活跃坑 42：判据被测 ≠ 接进了入口）', () => {
  /** 一个「宿主在场」的上下文替身：真的能读 marker、真的能 resolveAgent。 */
  interface FakeHost {
    ctx: unknown
    messages: NoticeMessage[]
    writes: string[]
    disposers: (() => void)[]
    stored(): string
  }

  /**
   * 造一个宿主替身。
   *
   * @param seed `text` 是盘上初始内容；`absent` 让 `readText` 报 `FS_NOT_FOUND`（= 文件不在）。
   */
  function fakeHost(seed: { text?: string; absent?: boolean } = {}): FakeHost {
    const messages: NoticeMessage[] = []
    const writes: string[] = []
    const disposers: (() => void)[] = []
    let stored = seed.text ?? serializeMarker(markerFixture())
    const notFound = (): Error => Object.assign(new Error('FS_NOT_FOUND'), { code: 'FS_NOT_FOUND' })
    const fsService = {
      resolve: async (path: string) => path,
      readText: async () => {
        if (seed.absent === true) throw notFound()
        return stored
      },
      writeText: async (_target: unknown, text: string) => {
        writes.push(text)
        stored = text
      },
    }
    const controller = {
      resolveAgent: async (id: string) => ({
        agent: { id, followup: (message: NoticeMessage) => messages.push(message) },
      }),
    }
    const ctx = {
      get: (name: string) =>
        name === 'fs' ? fsService : name === 'sessionController' ? controller : undefined,
      effect: (execute: () => () => void) => {
        const disposer = execute()
        disposers.push(disposer)
        return () => {
          disposer()
        }
      },
    }
    return { ctx, messages, writes, disposers, stored: () => stored }
  }

  /** 把微任务队列跑干净（恢复链全是 await，成功路径上没有定时器）。 */
  async function flushMicrotasks(times = 20): Promise<void> {
    for (let index = 0; index < times; index += 1) await Promise.resolve()
  }

  it('定时器到点后：读 marker → 唤醒 → 投 notice → 标已消费；**到点之前零副作用**', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const host = fakeHost()
      apply(host.ctx as never, { dshHome: HOME })

      // 延迟不是装饰：还没到点时一次唤醒、一次写都没有。
      expect(host.messages).toHaveLength(0)
      expect(host.writes).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(RECOVERY_STARTUP_DELAY_MS)
      await flushMicrotasks()

      expect(host.messages).toHaveLength(1)
      expect(host.writes).toHaveLength(1)
      const onDisk = parseMarker(host.stored())
      if (onDisk.status !== 'ok') throw new Error('期望解析成功')
      expect(onDisk.marker.state).toBe('consumed')
      expect(onDisk.marker.at).toBe(AT)
      // 走的是**真实适配器**：留痕落在宿主 logger 缺席时的 console 兜底上。
      expect(String(warn.mock.calls.at(-1)?.[0])).toContain('marked the marker consumed')
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it('disposer 收好了：卸载之后定时器不再跑（否则热重载会留下第二代插件的幽灵）', async () => {
    vi.useFakeTimers()
    try {
      const host = fakeHost()
      apply(host.ctx as never, { dshHome: HOME })
      expect(host.disposers).toHaveLength(1)

      host.disposers[0]?.()
      await vi.advanceTimersByTimeAsync(RECOVERY_STARTUP_DELAY_MS * 3)
      await flushMicrotasks()

      expect(host.messages).toHaveLength(0)
      expect(host.writes).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('marker 不在（`FS_NOT_FOUND`）⇒ 安静：不唤醒、不写、不留痕（正常启动不许有噪音）', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const host = fakeHost({ absent: true })
      apply(host.ctx as never, { dshHome: HOME })
      await vi.advanceTimersByTimeAsync(RECOVERY_STARTUP_DELAY_MS)
      await flushMicrotasks()

      expect(host.messages).toHaveLength(0)
      expect(host.writes).toHaveLength(0)
      // 反空转：同一套替身换成「文件在」时**必须**有动静（否则上面那条是恒真的）。
      expect(warn).not.toHaveBeenCalled()

      const present = fakeHost()
      apply(present.ctx as never, { dshHome: HOME })
      await vi.advanceTimersByTimeAsync(RECOVERY_STARTUP_DELAY_MS)
      await flushMicrotasks()
      expect(present.messages).toHaveLength(1)
      expect(present.writes).toHaveLength(1)
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it('宿主缺席（`ctx` 没有 `effect`）时 `apply` 不抛 —— 冒烟测试那条契约不能被恢复半破坏', () => {
    expect(() => apply({ get: () => undefined } as never)).not.toThrow()
    expect(() => apply({ get: () => undefined } as never, { dshHome: HOME })).not.toThrow()
  })
})

describe('lib/restart-recovery · 端口装配', () => {
  it('`runStartupRecovery` **绝不 reject**：上下文代理每次都抛也收敛成结构化结论', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const hostile = {
        get: () => {
          throw new Error('the context proxy exploded')
        },
      }
      // 取服务失败 ⇒ `read` 报 unreadable ⇒ **refused**（不是 absent、也不是 reject）。
      const outcome = await runStartupRecovery(hostile, HOME)
      expect(outcome.kind).toBe('refused')
      if (outcome.kind !== 'refused') throw new Error('期望 refused')
      expect(outcome.code).toBe('unreadable')
      expect(outcome.evidence.join(' ')).toContain('exploded')
      // 而且**留了痕**（拿不到宿主 logger 时退回 console，不许静默）。
      expect(String(warn.mock.calls.at(-1)?.[0])).toContain('unreadable')
    } finally {
      warn.mockRestore()
    }
  })

  it('`createRecoveryPorts` 不缓存服务：每次唤醒都现取（C26 的 apply 期 undefined）', async () => {
    let lookups = 0
    const host = {
      get: (name: string) => {
        lookups += 1
        if (name !== 'sessionController') return undefined
        return { resolveAgent: async () => ({ agent: { followup: () => undefined } }) }
      },
    }
    const ports = createRecoveryPorts(host)
    const notice: RecoveryNotice = { text: 't', summary: 's' }
    await ports.channel.wakeAndNotify('session-a', notice)
    const afterFirst = lookups
    await ports.channel.wakeAndNotify('session-a', notice)
    // 第二次仍然重新取服务（不缓存实例）。
    expect(lookups).toBeGreaterThan(afterFirst)
  })
})

describe('lib/restart-recovery · 投递来源字面量自证', () => {
  const source = readFileSync(new URL('../../src/lib/restart-recovery.ts', import.meta.url), 'utf8')
  const manifest = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { name?: string }

  it('`NOTICE_SOURCE_KIND` 逐字等于 `package.json` 的 `name`', () => {
    const match = /export const NOTICE_SOURCE_KIND = '([^']+)'/u.exec(source)
    expect(
      match,
      "找不到「export const NOTICE_SOURCE_KIND = '…'」—— 客户端按这个 kind 归因",
    ).not.toBeNull()
    expect(manifest.name, 'package.json 没有 name —— 这条自证会退化成恒真').toBeTruthy()
    expect(match?.[1]).toBe(manifest.name)
  })

  it('自证不是空转：换成变量时同一条正则必须认不出来', () => {
    expect(
      /export const NOTICE_SOURCE_KIND = '([^']+)'/u.test(
        'export const NOTICE_SOURCE_KIND = PLUGIN_NAME',
      ),
    ).toBe(false)
  })

  it('本文件自己不 import `node:fs` —— 写动作只发生在注入端口上', () => {
    // 与 `src/lib/restart.ts` 的同名判据同族：只要 import 了 fs 写 API，B10 就判红。
    expect(/\bfrom\s+['"]node:fs/u.test(source)).toBe(false)
    expect(/\bfrom\s+['"]node:fs/u.test("import { readFile } from 'node:fs/promises'")).toBe(true)
  })
})
