/**
 * 「端口来自宿主自己」的**集成判据** —— 走完整入口，不是只测 `resolvePort`。
 *
 * ## 为什么必须另有一份（坑 42 的形状）
 *
 * `resolve-port.test.ts` 只证明「函数按优先级挑」。它证明不了**工具真的把宿主端口取进来
 * 了** —— 那需要一条「替身 → deps → 工具 → 输出里的 `portSource`」的完整路径。
 * 少了这一份，`webServerPortOf` 可以整段不接线而全绿。
 *
 * ## 这条修的是什么（2026-10-17）
 *
 * 本仓原先假定宿主会把地址放进 `DSH_WEB_URL` 环境变量。**那条假设是错的**：该变量由
 * `dsh-web-app` 注册进 `shellEnv`，只注入到宿主派生的**子进程**，宿主自己的 `process.env`
 * 从来没有它 ⇒ 那条来源在宿主进程内永不命中。后果：没配 `port` 的机器上
 * `dsh_check_auth` / `dsh_sign_cookie` / `dsh_restart` 全部定不出端口，而前两者的错误
 * 文案还建议去设 `DSH_WEB_URL`（死路）。
 *
 * 权威来源是 `ctx.webServer.port`（`@deepseek-ai/dsh-host-webserver` 的 `WebServer` 服务，
 * 注释写明会回填 OS 分配的端口）。这几条判据钉住「接上了」与「报对了来源」。
 */
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { createCheckAuthTool } from '../../src/tools/dsh_check_auth.ts'
import { createSignCookieTool } from '../../src/tools/dsh_sign_cookie.ts'
import type { FetchImpl } from '../../src/lib/http.ts'
import { configFor, depsFor, expectOk, run, tempDshHome } from './helpers.ts'

/** 一个返回固定状态码的 fetch 替身（不联网）。 */
function fetchWithStatus(status: number): FetchImpl {
  return async () => ({ status, headers: { get: () => null } })
}

/**
 * 跑一次并取出 `key.resolved` 那一块。
 *
 * 走 `expectOk` 而不是手工读 `result.data`：成功路径的判据必须落在**已过守卫**的值上
 * （坑 37 —— 断言一个没经过 `ensureToolResult` 的对象，等于没断言它被交付过）。
 */
async function resolvedOf(
  tool: Parameters<typeof run>[0],
  args: unknown,
): Promise<Record<string, unknown>> {
  const data = expectOk(await run(tool, args))
  const resolved = data.key['resolved']
  if (typeof resolved !== 'object' || resolved === null) {
    throw new Error(`key 里没有 resolved 块 —— 拿到的是 ${JSON.stringify(data.key)}`)
  }
  return resolved as Record<string, unknown>
}

describe('端口来自宿主自己（ctx.webServer.port），不靠环境变量', () => {
  it('check_auth：**不配 port、不给环境变量**，只要宿主在监听就探得动，且来源报 host:webServer', async () => {
    const dshHome = await tempDshHome()
    const tool = createCheckAuthTool(
      depsFor(configFor(dshHome), {
        // 宿主说自己在监听 3080 —— 这就是 `ctx.webServer.port` 的替身。
        hostPort: () => 3080,
        env: {}, // 明确：没有 DSH_WEB_URL
        fetch: fetchWithStatus(200),
      }),
    )
    const resolved = await resolvedOf(tool, {})
    expect(resolved['port'], '端口没取到宿主那条').toBe(3080)
    expect(resolved['portSource']).toBe('host:webServer')
  })

  it('⚑ 反空转：把 hostPort 拿掉 ⇒ 同一组输入定不出端口（否则上一条测的不是它）', async () => {
    const dshHome = await tempDshHome()
    const tool = createCheckAuthTool(
      depsFor(configFor(dshHome), { env: {}, fetch: fetchWithStatus(200) }),
    )
    const data = await run(tool, {})
    // 失败形状必须点出「定不出端口」，而不是静静地报一个别的结论。
    expect(JSON.stringify(data)).toContain('no port could be determined')
  })

  it('sign_cookie 同样吃到宿主端口（它是另一个消费者，别只修一个）', async () => {
    // 这条故意不造凭证文件：它走的是「没有凭证 ⇒ not-found」那条失败路径，
    // 而 `resolved` 块在**成功与失败两种形状里都在** —— 那正是它该被断言的位置
    // （端口解析发生在读凭证之前，所以失败不该把证据一起丢掉）。
    const dshHome = await tempDshHome()
    const tool = createSignCookieTool(
      depsFor(configFor(dshHome), { hostPort: () => 3080, env: {} }),
    )
    const raw = await run(tool, {})
    expect(raw.ok).toBe(false)
    if (raw.ok) throw new Error('期望失败')
    expect(raw.error.kind).toBe('not-found')
    const key = raw.data.key as Record<string, unknown>
    const resolved = key['resolved'] as Record<string, unknown>
    expect(resolved['port'], '端口没取到宿主那条').toBe(3080)
    expect(resolved['portSource']).toBe('host:webServer')
  })

  it('配置里的 port 仍然压过宿主端口（跨实例观察不能被自己盖掉）', async () => {
    const dshHome = await tempDshHome()
    const tool = createCheckAuthTool(
      depsFor(configFor(dshHome, { port: 4444 }), {
        hostPort: () => 3080,
        env: {},
        fetch: fetchWithStatus(200),
      }),
    )
    const resolved = await resolvedOf(tool, {})
    expect(resolved['port']).toBe(4444)
    expect(resolved['portSource']).toBe('plugin-config')
  })
})

describe('装配处真的把 webServer 接进了 deps（否则上面那些判据都靠替身空转）', () => {
  const source = readFileSync(new URL('../../src/tools/index.ts', import.meta.url), 'utf8')
  const library = readFileSync(new URL('../../src/lib/stop-url.ts', import.meta.url), 'utf8')

  it('取的是 `webServer.port`，而不是 `host` 或 `protocol`', () => {
    // 实现住在 `lib/stop-url.ts` 的 `listeningPortOf`（启动期发布地址那一半也要读同一格，
    // 见那个文件的文件头）；工具层只转发。判据因此点进**实现**，不在装配处找字符串 ——
    // 否则「谁搬了实现」会被读成「谁破坏了接线」。
    //
    // ⚠️ 同一个文件里还有 `stopWindowUrlOf`，它**合法地**要 `getAdvertisedUrl`（根地址）
    // ⇒ 反面判据必须只作用于 `listeningPortOf` 的正文，不能对整个文件下结论。
    const start = library.indexOf('export function listeningPortOf')
    expect(start, '找不到 listeningPortOf').toBeGreaterThan(-1)
    const rest = library.slice(start)
    const end = rest.indexOf('\n}')
    expect(end, 'listeningPortOf 的正文没闭合').toBeGreaterThan(-1)
    const body = rest.slice(0, end)

    expect(body).toContain('WEB_SERVER_SERVICE')
    expect(body).toContain('port')
    // 反面：拿 `getAdvertisedUrl()` 或 `host` 都是错的 —— 前者受 `--public-url` 影响、
    // 后者是绑定地址不是端口。这条防止「接了、但接错了那一格」。
    expect(body, '接错成 advertisedUrl 了').not.toContain('getAdvertisedUrl')
    expect(body, '接错成 host 了').not.toContain('.host')
    expect(body, '接错成 protocol 了').not.toContain('.protocol')
    // 装配处仍必须是**转发到那一格**，而不是自己另写一份（那一份会与实现漂）。
    expect(source).toContain('listeningPortOf(')
    expect(source, '工具层又自己读了一遍端口（两份实现会漂）').not.toContain(
      "getter.call(ctx, 'webServer')",
    )
  })

  it('那条读的是**可选服务**，没写进 inject —— 否则 CLI/桌面载体会挂成 PENDING', () => {
    expect(library).toMatch(/get\?:/u)
    const agentRules = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8')
    // `inject` 只列硬依赖；`webServer` 只在 web 载体上存在，写进去会让别的载体整插件 PENDING。
    expect(agentRules).not.toContain("inject = ['tools', 'webServer']")
  })
})
