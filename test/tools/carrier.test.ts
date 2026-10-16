/**
 * `lib/carrier.ts` 的判据 —— **五条规则 × 一张路线表 × 三档拒绝文案**。
 *
 * 这一层是「载体」的唯一判定点，而它的结论会导致**拒绝**（闸④ / dump 类工具），
 * 所以每条分支都要有**下界**：断言它真的命中了那条规则、证据非空、
 * 而且**不同的输入真的给出不同结论**（否则「五条规则」可能只是同一条在空转）。
 *
 * 平台一律**注入**（`observeCarrier({platform})`）而不是伪装 `process.platform`：
 * 本层不读全局，所以两条平台分支在任何机器上都被真跑到（坑 25）。
 */
import { describe, expect, it } from 'vitest'

import {
  carrierAuditOf,
  isReservedDesktopProfile,
  observeCarrier,
  relaunchRefusalFor,
  relaunchRouteFor,
  RESERVED_DESKTOP_PROFILE,
  UNKNOWN_CARRIER,
  type CarrierKind,
} from '../../src/lib/carrier.ts'

/** 桌面宿主的入口形状（**形状**判据，不绑任何机器的绝对路径）。 */
const DESKTOP_ENTRY =
  'C:\\Program Files\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js'

/** 普通命令行启动的入口。 */
const CLI_ENTRY =
  'C:\\Users\\someone\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'

describe('carrier · 五条判据各自真的命中（且互不空转）', () => {
  it('① `profileContext.name === "desktop"` ⇒ desktop-host（**权威**，压倒入口形状）', () => {
    // 入口故意写成 bin.js：这条用例钉的是**判据顺序** —— 顺序反了，桌面宿主会被印成 cli，
    // 而 cli 在 win32 上会给出 task-scheduler（= 一次必然失败的拉起）。
    const observation = observeCarrier({
      argv: ['node', CLI_ENTRY],
      env: {},
      platform: 'win32',
      profileContext: { name: RESERVED_DESKTOP_PROFILE },
    })
    expect(observation.kind).toBe('desktop-host')
    expect(observation.rule).toBe('profile-context-desktop')
    expect(observation.profile).toBe('desktop')
    expect(observation.evidence.length, '证据行数为 0 ⇒ 这条判据没法复核').toBeGreaterThanOrEqual(2)
  })

  it('② 入口形状命中 `app.asar` / `dsh-desktop-host` ⇒ desktop-host（与 ① 互为独立来源）', () => {
    for (const entry of [
      DESKTOP_ENTRY,
      '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/lib/index.js',
      'C:\\x\\app.asar\\y.js',
    ]) {
      const observation = observeCarrier({ argv: ['node', entry], env: {}, platform: 'darwin' })
      expect(observation.kind, `入口形状没认出来：${entry}`).toBe('desktop-host')
      expect(observation.rule).toBe('desktop-host-entry')
      // profileContext 缺席 ⇒ profile 是「取不到」，不是 ''（三值纪律）。
      expect(observation.profile).toBeUndefined()
    }
  })

  it('③ `argv[1]` 是 `bin.js` ⇒ cli', () => {
    const observation = observeCarrier({ argv: ['node', CLI_ENTRY], env: {}, platform: 'win32' })
    expect(observation.kind).toBe('cli')
    expect(observation.rule).toBe('bin-js-entry')
  })

  it('④ 有非空 `profileContext.name`、入口不叫 bin.js ⇒ 仍是 cli', () => {
    const observation = observeCarrier({
      argv: ['node', 'C:\\x\\some-other-launcher.mjs'],
      env: {},
      platform: 'win32',
      profileContext: { name: 'tui' },
    })
    expect(observation.kind).toBe('cli')
    expect(observation.rule).toBe('profile-context-present')
    expect(observation.profile).toBe('tui')
  })

  it('⑤ 什么都认不出来 ⇒ unknown（**不是** cli）', () => {
    const observation = observeCarrier({ argv: ['node'], env: {}, platform: 'win32' })
    expect(observation.kind).toBe('unknown')
    expect(observation.rule).toBe('unrecognized')
    expect(observation.profile).toBeUndefined()
    // 反空转：它与 ③ 的输入只差一个 argv[1]，结论必须**不同**。
    expect(observation.kind).not.toBe(observeCarrier({ argv: ['node', CLI_ENTRY] }).kind)
  })

  it('`profileContext` 形状不认识（宿主换版本）⇒ 按「取不到」处理，不抛', () => {
    for (const profileContext of [undefined, null, 'desktop', 42, {}, { name: '' }, { name: 7 }]) {
      const observation = observeCarrier({
        argv: ['node', 'C:\\x\\app.asar\\y.js'],
        env: {},
        platform: 'win32',
        profileContext,
      })
      // 入口形状仍然认得出来 ⇒ kind 不塌；而 profile 必须是「取不到」。
      expect(observation.kind).toBe('desktop-host')
      expect(
        observation.profile,
        `形状 ${JSON.stringify(profileContext)} 被猜成了 profile`,
      ).toBeUndefined()
    }
  })

  it('`DSH_CLIENT_VERSION` 只作**佐证**：它单独出现不改变 kind', () => {
    const withEnv = observeCarrier({
      argv: ['node', CLI_ENTRY],
      env: { DSH_CLIENT_VERSION: '0.2.0-rc.2' },
      platform: 'win32',
    })
    expect(withEnv.kind).toBe('cli')
    expect(withEnv.evidence.join('\n')).toContain('DSH_CLIENT_VERSION')
    const without = observeCarrier({ argv: ['node', CLI_ENTRY], env: {}, platform: 'win32' })
    expect(without.evidence.join('\n')).not.toContain('DSH_CLIENT_VERSION')
  })
})

describe('carrier · 回归路线表（只看表，不看命令拼不拼得出来）', () => {
  const cases: readonly { kind: CarrierKind; platform: string; route: string }[] = [
    { kind: 'cli', platform: 'win32', route: 'task-scheduler' },
    { kind: 'cli', platform: 'linux', route: 'none' },
    { kind: 'cli', platform: 'darwin', route: 'none' },
    { kind: 'desktop-host', platform: 'win32', route: 'none' },
    { kind: 'desktop-host', platform: 'darwin', route: 'none' },
    { kind: 'unknown', platform: 'win32', route: 'none' },
    { kind: 'unknown', platform: 'linux', route: 'none' },
  ]

  it('七格全断（两条平台分支在任何机器上都被真跑到）', () => {
    for (const item of cases) {
      const route = relaunchRouteFor({
        kind: item.kind,
        profile: undefined,
        platform: item.platform,
        rule: 'unrecognized',
        evidence: [],
      })
      expect(route, `${item.kind} × ${item.platform}`).toBe(item.route)
    }
  })

  it('下界：`task-scheduler` 这一格**真的会被给出**（否则上面那七条可能全是 none 的恒真）', () => {
    const reachable = cases.filter((item) => item.route === 'task-scheduler')
    expect(
      reachable.length,
      '没有任何输入能得到 task-scheduler ⇒ 上一条判据在空转',
    ).toBeGreaterThan(0)
    // 而且它**只**在 cli × win32 上出现（桌面端在 win32 上也必须是 none）。
    expect(reachable.every((item) => item.kind === 'cli' && item.platform === 'win32')).toBe(true)
  })

  it('`UNKNOWN_CARRIER` 在任何平台上都不是 task-scheduler（不把不知道印成有能力）', () => {
    expect(UNKNOWN_CARRIER.kind).toBe('unknown')
    expect(relaunchRouteFor(UNKNOWN_CARRIER)).toBe('none')
    expect(relaunchRouteFor({ ...UNKNOWN_CARRIER, platform: 'win32' })).toBe('none')
  })
})

describe('carrier · 三档拒绝文案（彼此可分、非空、不承诺做不到的事）', () => {
  const desktop = observeCarrier({ argv: ['node', DESKTOP_ENTRY], env: {}, platform: 'win32' })
  const cliLinux = observeCarrier({ argv: ['node', CLI_ENTRY], env: {}, platform: 'linux' })
  const unknown = observeCarrier({ argv: ['node'], env: {}, platform: 'win32' })

  it('每一档的 reason / remedy 都非空', () => {
    for (const observation of [desktop, cliLinux, unknown]) {
      const refusal = relaunchRefusalFor(observation)
      expect(refusal.reason.length, `${observation.kind}: reason 为空`).toBeGreaterThan(0)
      expect(refusal.remedy.length, `${observation.kind}: remedy 为空`).toBeGreaterThan(0)
    }
  })

  it('三档的 reason 彼此**不同**（压成一句就是把三值压成两值）', () => {
    const reasons = [desktop, cliLinux, unknown].map((item) => relaunchRefusalFor(item).reason)
    expect(new Set(reasons).size).toBe(3)
  })

  it('桌面端的 remedy 必须点名**人的动作**（退出 App 再启动），且不提工具', () => {
    const refusal = relaunchRefusalFor(desktop)
    expect(refusal.reason).toContain('Desktop')
    expect(refusal.remedy).toContain('tray')
    // 插件没有通道 ⇒ 不许把人指向一个不存在的工具动作。
    expect(refusal.remedy).not.toContain('dsh_restart')
  })

  it('非 win32 那一档把平台名带出来（不是一句无信息量的常量）', () => {
    expect(relaunchRefusalFor(cliLinux).reason).toContain('linux')
    const darwin = relaunchRefusalFor(
      observeCarrier({ argv: ['node', CLI_ENTRY], platform: 'darwin' }),
    )
    expect(darwin.reason).toContain('darwin')
    expect(darwin.reason).not.toBe(relaunchRefusalFor(cliLinux).reason)
  })

  it('认不出来那一档不许声称任何路线', () => {
    const refusal = relaunchRefusalFor(unknown)
    expect(refusal.reason).toContain('could not be identified')
    expect(refusal.reason).not.toContain('task scheduler was measured')
  })
})

describe('carrier · 保留 profile 名', () => {
  it('只认 `desktop`（大小写与空白归一），别的一律不是', () => {
    for (const value of ['desktop', 'Desktop', 'DESKTOP', ' desktop ']) {
      expect(isReservedDesktopProfile(value), `${value} 应当算保留名`).toBe(true)
    }
    for (const value of ['web', 'tui', '', 'desktop2', 'my-desktop', 'headless']) {
      expect(isReservedDesktopProfile(value), `${value} 不该算保留名`).toBe(false)
    }
  })

  it('常量与 `package.json` 无关、就是 CLI 那一侧的字面量（漂了这条会红）', () => {
    expect(RESERVED_DESKTOP_PROFILE).toBe('desktop')
  })
})

describe('carrier · `carrierAuditOf` 的投影（三值纪律 × 宿主无损 JSON 边界）', () => {
  it('profile 取不到时**整个键不印**（不是 `undefined`、也不是冒充的 `""`）', () => {
    const unknownProfile = observeCarrier({
      argv: ['node', DESKTOP_ENTRY],
      env: {},
      platform: 'linux',
    })
    const audit = carrierAuditOf(unknownProfile)
    expect('profile' in audit, '`profile: undefined` 过不了宿主那条边界（B26）').toBe(false)
    const knownProfile = carrierAuditOf(
      observeCarrier({ argv: ['node', CLI_ENTRY], profileContext: { name: 'web' } }),
    )
    expect(knownProfile.profile).toBe('web')
  })

  it('投影可无损落 JSON（往返后深度相等 —— `undefined` / 非有限数都会在这里露出来）', () => {
    for (const observation of [
      observeCarrier({
        argv: ['node', CLI_ENTRY],
        env: { DSH_CLIENT_VERSION: '1.0.0' },
        platform: 'win32',
        profileContext: { name: 'web' },
      }),
      observeCarrier({ argv: ['node'], env: {}, platform: 'win32' }),
      UNKNOWN_CARRIER,
      observeCarrier({ argv: ['node', DESKTOP_ENTRY], platform: 'darwin' }),
    ]) {
      const audit = carrierAuditOf(observation)
      expect(JSON.parse(JSON.stringify(audit))).toEqual(audit)
    }
  })

  it('evidence 是**拷贝**（改投影不会改到观测本身）', () => {
    const observation = observeCarrier({ argv: ['node', CLI_ENTRY], platform: 'win32' })
    const audit = carrierAuditOf(observation)
    audit.evidence.push('injected')
    expect(observation.evidence).not.toContain('injected')
  })
})
