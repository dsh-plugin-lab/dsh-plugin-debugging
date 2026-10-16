/**
 * profile 身份的**优先级判据** —— 那次真机缺陷的回归护栏。
 *
 * ## 它守的是什么
 *
 * 2026-10-15 的真机事故：桌面宿主的 `DSH_PROFILE` 是从启动 Electron 的 shell **继承**来的
 * `web`，而 `resolveConfig` 当时的口径是 `config?.profile || env.DSH_PROFILE || 'web'`
 * ⇒ `dsh_restart` 拼出了一条 `dsh --profile web` 的计划任务，把一个**桌面端用户**
 * 送到另一个 profile 上，并且恢复半的成果也落在了那个错实例里。
 *
 * 真源是 `profileContext.name`（启动器在建树之前 provide）。这条优先级一旦被改回去，
 * 上面那件事就会**原样复发**，而界面上看不出任何差别 —— 所以它必须是一条判据。
 *
 * ## 为什么与 `carrier.test.ts` 分开
 *
 * 那一份守「载体怎么判」，这一份守「判出来的 profile 怎么进配置」。
 * 两者合起来才是完整的因果链；分开写是因为它们连被测对象都不同（纯函数 vs 装配）。
 */
import { describe, expect, it } from 'vitest'

import { DEFAULT_PROFILE, resolveConfig } from '../../src/config.ts'
import { observeCarrier, RESERVED_DESKTOP_PROFILE } from '../../src/lib/carrier.ts'

describe('resolveConfig · profile 身份的优先级', () => {
  it('**运行时真源优先于环境变量** —— 真机缺陷的回归断言', () => {
    // 事故现场的三个值，逐字照搬：环境里是 web、运行时是 desktop。
    const resolved = resolveConfig(
      undefined,
      { DSH_PROFILE: 'web' },
      {
        profile: RESERVED_DESKTOP_PROFILE,
      },
    )
    expect(
      resolved.profile,
      '真源被环境变量盖住了 ⇒ `dsh_restart` 会去起另一个 profile（真机事故原样复发）',
    ).toBe('desktop')
  })

  it('用户显式写的配置仍然压过运行时真源', () => {
    const resolved = resolveConfig(
      { profile: 'tui' },
      { DSH_PROFILE: 'web' },
      { profile: 'desktop' },
    )
    expect(resolved.profile).toBe('tui')
  })

  it('真源取不到时退回环境变量，再退回 `web`（兼容链没断）', () => {
    expect(resolveConfig(undefined, { DSH_PROFILE: 'web' }, { profile: undefined }).profile).toBe(
      'web',
    )
    // 空串 = **取不到**（不是「显式选了空 profile」）—— 三值纪律在这一格同样成立。
    expect(resolveConfig(undefined, { DSH_PROFILE: 'web' }, { profile: '' }).profile).toBe('web')
    // 第三参整个省略时也必须能用（`apply()` 之外的调用点与单测直接调它）。
    expect(resolveConfig(undefined, { DSH_PROFILE: 'tui' }).profile).toBe('tui')
    expect(resolveConfig(undefined, {}).profile).toBe(DEFAULT_PROFILE)
  })

  it('反空转：四个输入给出的**不是**同一个答案（否则上面那几条可能恒真）', () => {
    const answers = [
      resolveConfig(undefined, { DSH_PROFILE: 'web' }, { profile: 'desktop' }).profile,
      resolveConfig({ profile: 'tui' }, {}, { profile: 'desktop' }).profile,
      resolveConfig(undefined, { DSH_PROFILE: 'web' }, {}).profile,
      resolveConfig(undefined, {}).profile,
    ]
    expect(
      new Set(answers).size,
      `四个输入只给出 ${String(new Set(answers).size)} 种答案`,
    ).toBeGreaterThan(1)
  })
})

describe('resolveConfig · 与载体观测同源（两半用同一套词）', () => {
  it('`observeCarrier` 给出的 profile 直接喂进 `resolveConfig` 就是生效 profile', () => {
    // 这条钉的是「装配线没有在两处各写一套判断」：`src/index.ts` 就是这么接的。
    const carrier = observeCarrier({
      argv: ['node', 'C:\\x\\app.asar\\y\\index.js'],
      env: {},
      platform: 'win32',
      profileContext: { name: RESERVED_DESKTOP_PROFILE },
    })
    expect(carrier.kind).toBe('desktop-host')
    // 同一个进程的环境里**同时**有那个会骗人的 `DSH_PROFILE`。
    const resolved = resolveConfig(undefined, { DSH_PROFILE: 'web' }, { profile: carrier.profile })
    expect(resolved.profile).toBe(RESERVED_DESKTOP_PROFILE)
  })
})
