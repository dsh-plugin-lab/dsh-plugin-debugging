/**
 * `resolvePort` 的四段优先级 —— **这是 2026-10-17 那次根因修复的判据**。
 *
 * ## 修的是什么
 *
 * 原先只有三段，第三段读 `process.env.DSH_WEB_URL`，注释写着「宿主启动时会把自己的地址
 * 放进 `DSH_WEB_URL`」。那条假设是错的：`DSH_WEB_URL` 由 `dsh-web-app` 注册进 `shellEnv`，
 * **只注入到宿主派生的子进程**，宿主自己的 `process.env` 从来没有它（`[已核]` 装好的
 * `dsh-web-app/lib/index.js` 里 `shellEnv.register({ variables: { DSH_WEB_URL } })`）。
 *
 * 所以那条来源在宿主进程内**永不命中**。后果不是「少一条来源」：没配 `port` 的机器上
 * `dsh_check_auth` 会报「no port could be determined」**并建议去设 `DSH_WEB_URL` ——
 * 而那在这种载体上是死路**。本机实测过那次失败。
 *
 * 权威来源是进程内的 `ctx.webServer.port`（`@deepseek-ai/dsh-host-webserver` 的
 * `WebServer` 服务，`get port()` 的注释写明它会回填 OS 分配的端口）。
 *
 * ## 这些判据的形状
 *
 * 每一条都**只给一种来源**，并断言「取自那一条、且 `source` 报对了」——
 * 因为「结果对但来源报错」与「来源对但结果取自别处」都是错的，而只看端口号分不开它们。
 */
import { describe, expect, it } from 'vitest'

import { resolvePort } from '../../src/tools/shared.ts'

const URL_3080 = { DSH_WEB_URL: 'http://127.0.0.1:3080' }

describe('resolvePort · 四段优先级', () => {
  it('① 显式参数最优先：四条来源都给，取参数那条', () => {
    expect(resolvePort(1111, 2222, URL_3080, 3333)).toEqual({
      port: 1111,
      source: 'tool-argument',
    })
  })

  it('② 其次才是配置：配置与宿主端口都给，取配置那条', () => {
    // 配置优先于「我自己在监听什么」是**有意的**：配置那条是跨实例观察的唯一手段
    // （拿别人的端口去探别人），不能被自己进程的端口盖掉。
    expect(resolvePort(undefined, 2222, URL_3080, 3333)).toEqual({
      port: 2222,
      source: 'plugin-config',
    })
  })

  it('③ 宿主实际监听端口：这条就是 2026-10-17 补上的那条', () => {
    expect(resolvePort(undefined, undefined, {}, 3333)).toEqual({
      port: 3333,
      source: 'host:webServer',
    })
  })

  it('③ 压过环境变量：两者都给时取宿主端口（它是进程内的权威事实）', () => {
    expect(resolvePort(undefined, undefined, URL_3080, 3333)).toEqual({
      port: 3333,
      source: 'host:webServer',
    })
  })

  it('④ 环境变量兜底：只有它时才用它（子进程形态仍有意义）', () => {
    expect(resolvePort(undefined, undefined, URL_3080, undefined)).toEqual({
      port: 3080,
      source: 'env:DSH_WEB_URL',
    })
  })

  it('四段都没有 ⇒ undefined（不猜，也不退回某个常量）', () => {
    expect(resolvePort(undefined, undefined, {}, undefined)).toBeUndefined()
  })
})

describe('resolvePort · 拒绝无效值（不是「有就给」）', () => {
  it('0 / 负数 / 非整数一律当成没有，继续往下一条来源走', () => {
    // 0 是「用户没填」的哨兵语义，绝不能当成端口；负数与非整数同理。
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(resolvePort(bad, bad, {}, bad), `把 ${String(bad)} 当成了端口`).toBeUndefined()
      // 而且坏值不许**短路**掉后面的好来源（否则一条脏配置会遮住宿主端口）。
      expect(resolvePort(bad, bad, {}, 3333)).toEqual({ port: 3333, source: 'host:webServer' })
    }
  })

  it('安全整数之外的大数也不收（避免拼出不可能的端口）', () => {
    expect(resolvePort(undefined, undefined, {}, Number.MAX_SAFE_INTEGER + 2)).toBeUndefined()
  })
})

describe('resolvePort · 环境变量那条的边界（说明它为什么不可靠）', () => {
  it('URL 里没有显式端口时按 scheme 补（http⇒80 / https⇒443）', () => {
    expect(
      resolvePort(undefined, undefined, { DSH_WEB_URL: 'http://example.com' }, undefined),
    ).toEqual({ port: 80, source: 'env:DSH_WEB_URL' })
    expect(
      resolvePort(undefined, undefined, { DSH_WEB_URL: 'https://example.com' }, undefined),
    ).toEqual({ port: 443, source: 'env:DSH_WEB_URL' })
  })

  it('URL 是垃圾 ⇒ 当成没有（不抛、不猜）', () => {
    expect(
      resolvePort(undefined, undefined, { DSH_WEB_URL: 'not a url' }, undefined),
    ).toBeUndefined()
    expect(resolvePort(undefined, undefined, { DSH_WEB_URL: '' }, undefined)).toBeUndefined()
  })
})
