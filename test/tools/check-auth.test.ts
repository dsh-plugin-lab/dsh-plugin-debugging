/**
 * `dsh_check_auth` 的行为红线 + 新契约的形状断言 + 凭证形状的回归守卫。
 *
 * 这个工具存在的**唯一**理由就是把「连接被拒」与「401」分开，所以那两条是本文件
 * 最重要的断言 —— 它们各自对应一个完全相反的下一步。
 *
 * 分四块：
 *
 * 1. **行为**：两档核心区分（`not-running` / `auth`）+ 其余可达 kind（按新契约取数，
 *    `hint` 已不存在）。**401 那条另有本文件的头号判据**：本工具**不发送凭据**，
 *    所以它拿到的 401 是匿名 401 —— 判定与下一步**不许**随「凭证文件里有没有条目」变
 *    （旧文案正是拿凭据解释它，已删）；
 * 2. **形状**（SHAPE §2.1 / §3.1 / §4.1）：四段描述、三层文本、`data` 恰好三键、
 *    `nextStep` 必须带动作、恒定块不许进输出、`audit` 不许进模型文本；
 * 3. **凭证形状**（缺 C 的回归守卫）：`records:` 段下的**合体键**
 *    `client-connection/browser-session` 才算条目 —— 本文件原先用的**嵌套夹具**
 *    是宿主**读不了**的形状（顶层 `client-connection:` 会被 `parseCredentialsDocument`
 *    拒绝），于是那条断言报 `true` 才是骗人。夹具改真，并补构造性反例；
 * 4. **B24**（`execute` 全路径不抛）：注入会抛的替身，断言返回的仍是**过守卫**的
 *    合法结果（恒等），且替身**真的被调用过**（否则判据空转，活跃坑 18）。
 *
 * 安全：夹具里的秘密一律是**假值**；本文件不读、不打印、不落盘任何真实密钥。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import {
  createCheckAuthTool,
  CHECK_AUTH_DESCRIPTION,
  CHECK_AUTH_TOOL,
} from '../../src/tools/dsh_check_auth.ts'
import { composeDescription } from '../../src/tools/describe.ts'
import { ensureToolResult, TOOL_ERROR_KINDS, toolResultProblem } from '../../src/lib/errors.ts'
import type { SpawnImpl } from '../../src/lib/exec.ts'
import type { FetchImpl } from '../../src/lib/http.ts'
import {
  configFor,
  depsFor,
  execWith,
  expectFail,
  expectOk,
  expectParameterDescriptionsNotBlank,
  expectSynthesizedDescription,
  renderText,
  run,
  splitRender,
  tempDshHome,
  writeText,
} from './helpers.ts'

/** 一个「按状态码应答」的 fetch。 */
function fetchWithStatus(status: number, location?: string): FetchImpl {
  return async () => ({
    status,
    headers: {
      get: (name: string) => (name === 'location' && location !== undefined ? location : null),
    },
  })
}

/** 一个「连不上」的 fetch（模拟 Node 把 ECONNREFUSED 包在 cause 上）。 */
const refusingFetch: FetchImpl = async () => {
  const error = new TypeError('fetch failed')
  ;(error as { cause?: unknown }).cause = Object.assign(new Error('connect ECONNREFUSED'), {
    code: 'ECONNREFUSED',
  })
  throw error
}

/** 一个「只有被 abort 才结束」的 fetch（模拟真实 fetch，用来证明取消/超时透传到 IO）。 */
function hangingFetch(seen?: AbortSignal[]): FetchImpl {
  return (_url, init) => {
    seen?.push(init.signal)
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        reject(init.signal.reason ?? new Error('aborted'))
      })
    })
  }
}

/**
 * 假秘密：43 字符 base64url（照真实 `payload.secret` 的长度与字母表），内容显然不是真值。
 */
const FAKE_SECRET = 'A'.repeat(43)

/**
 * **真实形状**的凭证文件（宿主 `parseCredentialsDocument` 只认顶层
 * `version` / `refs` / `records`；条目是 `records:` 段下的**合体键**）。
 *
 * 行号是判据的一部分（`line` 要指向真那一行）：
 * 1 `version`、2 `refs`、3 `refs` 里的条目、4 `records`、**5 合体键**。
 */
const REAL_SHAPE = [
  'version: 1',
  'refs:',
  '  DEEPSEEK_API_KEY: fake-ref-value',
  'records:',
  '  client-connection/browser-session:',
  '    kind: grant',
  `    payload: { version: 1, secret: ${FAKE_SECRET} }`,
  '  deepseek-account-platform/default:',
  '    kind: api-key',
  '    key: fake-key-value',
  '',
].join('\n')

/**
 * 在 **401** 那条路上取 `key.credentials`（凭证块的家就在那里）。
 *
 * @param text 凭证文件内容；`undefined` = 不写文件（文件不存在）。
 */
async function credentialsUnder401(text: string | undefined): Promise<Record<string, unknown>> {
  const dshHome = await tempDshHome()
  if (text !== undefined) await writeText(join(dshHome, '.credentials.yaml'), text)
  const tool = createCheckAuthTool(depsFor(configFor(dshHome), { fetch: fetchWithStatus(401) }))

  const failure = expectFail(await run(tool, { port: 3080 }))
  const credentials = failure.data.key['credentials'] as Record<string, unknown> | undefined
  // 401 的观测事实必须有唯一的家：`data.key.credentials`（不再靠 hint 转述）。
  expect(credentials, '401 分支没有把凭证块放进 data.key').toBeDefined()
  return credentials ?? {}
}

describe('dsh_check_auth', () => {
  it('工具名与契约一致', () => {
    expect(CHECK_AUTH_TOOL).toBe('dsh_check_auth')
  })

  describe('形状：描述层（SHAPE §2.1 冻结）', () => {
    it('四段骨架：合成器与声明一致（B20a 照不到的那一半）+ 本工具的参数闭集', () => {
      const tool = createCheckAuthTool(depsFor(configFor('/tmp/nowhere')))

      // 合成器与声明必须一致 —— 防止有人手写字符串绕过骨架。
      // ⚠️ 这条 **B20a 照不到**（它的 `shape.text` 是从声明重新合成的，不读 `tool.description`）
      // —— `expectSynthesizedDescription` 是全仓唯一实现（helpers.ts）。
      expectSynthesizedDescription(tool, composeDescription(CHECK_AUTH_DESCRIPTION))
      // 骨架的其余判据（段非空 / 行数与字符上界 / 连接符）由红线 B20a 对闭集全量覆盖，
      // 这里不再逐字重抄（一处一事实；本用例只留本工具特有的参数闭集）。

      // ⚠️ `defineTool` 把参数编译成了 JSON schema（`{ type, properties }`），所以要点进
      // `properties` 才看得到每个参数的描述（活跃坑 18；下界判定在 helpers.ts 的
      // `expectParameterDescriptionsNotBlank`）。**精确闭集是本工具的契约**：加/删参数同批改。
      const parameters = tool.parameters as {
        properties?: Record<string, { description?: string }>
      }
      const props = parameters.properties ?? {}
      const names = Object.keys(props)
      expect(names, '一个参数都没读到 —— 判据空转').toEqual(['port', 'host'])
      expectParameterDescriptionsNotBlank(tool)
    })

    it('搬走的恒定知识**只能**在描述层出现一次（旧的凭证 note 不再进输出）', () => {
      const text = composeDescription(CHECK_AUTH_DESCRIPTION)
      // 「不读秘密」是**说过头**：401 那条路确实会读 `.credentials.yaml` 判条目在不在
      // （只取布尔与行号），所以措辞必须是「不读秘密的**值**」。把 `values` 去掉 → 判红。
      expect(text).toContain('no secret values read')
      expect(text).toContain('cookies are bound to host:port')
      // 旧 `credentials.note` 那句逐字不许再出现在任何一段描述里（它已不存在于输出层）。
      expect(text).not.toContain('does not read values or sign cookies')
    })

    it('描述层不许把 401 说成「authority 变了」（本工具发不出凭据）', () => {
      const text = composeDescription(CHECK_AUTH_DESCRIPTION)

      // 上界（断语义、不断词）：凡把 **401 与 authority 连起来**的那一行，都必须把结论
      // **限定给浏览器页面**。理由就是 L1 的理由：本工具的探测不带凭据，它那条 401 是
      // 匿名 401，推不出「authority 变了」；只有「带着 cookie 的页面」才适用这条机制。
      // 旧文案 `A 401 usually means the authority changed: cookies are bound to host:port.`
      // 没有这层限定 —— 把它改回去，这条必须红（本轮变异实测：红在这条断言上）。
      const linking = text
        .split('\n')
        .filter((line) => line.includes('401') && line.includes('authority'))
      expect(linking.length, '描述里没有一行同时提到 401 与 authority —— 判据空转').toBeGreaterThan(
        0,
      )
      for (const line of linking) {
        expect(line, `这一行把 401 与 authority 连起来了，却没限定给浏览器页面：${line}`).toContain(
          'page',
        )
      }

      // 下界：边界段必须点明「不发送凭据」这条事实 —— 没有它，「不说错」可能只是没说。
      expect(text).toContain('signed or sent')
    })
  })

  describe('成功路径', () => {
    it('200 → 服务在、认证通过；authority 与端口来源都在 key 里', async () => {
      const dshHome = await tempDshHome()
      const tool = createCheckAuthTool(depsFor(configFor(dshHome), { fetch: fetchWithStatus(200) }))

      const result = await run(tool, { port: 3080 })
      const data = expectOk(result)
      // 下一个决定要用的标识符必须在 `key` 里（B17 的取值面就是 L1/L2）。
      expect(data.key['authority']).toBe('127.0.0.1:3080')
      expect(data.key['url']).toBe('http://127.0.0.1:3080/')
      expect((data.key['probe'] as Record<string, unknown>)['kind']).toBe('ok')
      const resolved = data.key['resolved'] as Record<string, unknown>
      expect(resolved['port']).toBe(3080)
      expect(resolved['portSource']).toBe('tool-argument')
      expect(resolved['dshHomeSource']).toBe('config')
      // 成功路径上不读凭证文件 —— 那不是本次结论的原料（§5 的判据）。
      expect(data.key['credentials']).toBeUndefined()
      // L1 是实质句子（含「所以呢」），不是 `ok` 之类的空壳。
      expect(data.verdict).toContain('is up')
      expect(data.verdict).toContain('authentication is not what is failing here')
      // 「没有动作就不出现」：认证通过时 L3 整行不出现（不留裸结论占位）。
      expect(result.nextStep).toBeUndefined()

      const text = renderText(tool, {}, result)
      const parts = splitRender(text)
      expect(parts.head).toBe(`[${CHECK_AUTH_TOOL}] ok`)
      expect(parts.l2).toContain('authority: 127.0.0.1:3080')
      expect(parts.verdict).toBe(data.verdict)
      expect(text).not.toContain('nextStep:')
    })

    it('303（token 交换成功）算 ok，并带回 Location', async () => {
      const dshHome = await tempDshHome()
      const tool = createCheckAuthTool(
        depsFor(configFor(dshHome), { fetch: fetchWithStatus(303, 'http://127.0.0.1:3080/') }),
      )

      const data = expectOk(await run(tool, { port: 3080 }))
      const probe = data.key['probe'] as Record<string, unknown>
      expect(probe['kind']).toBe('ok')
      expect(probe['location']).toBe('http://127.0.0.1:3080/')
    })

    it('500 也算「服务在」：重点是排除「没启动」，并派一步去查宿主在干什么', async () => {
      const dshHome = await tempDshHome()
      const tool = createCheckAuthTool(depsFor(configFor(dshHome), { fetch: fetchWithStatus(500) }))

      const result = await run(tool, { port: 3080 })
      const data = expectOk(result)
      expect((data.key['probe'] as Record<string, unknown>)['kind']).toBe('http-error')
      expect(data.verdict).toContain('"not running" is ruled out')
      const step = result.nextStep as { tool?: string; why?: string } | undefined
      expect(step?.tool).toBe('dsh_diagnose_plugin_load')
      // 目标工具报的是**加载 / 监听 / 启动日志**，它不回答「这个服务在服务什么」——
      // 承诺「find out what it is actually serving」是**说了但兑现不了**。
      // 它能兑现的是「那个端口上是哪个进程」。
      expect(step?.why).toContain('what process is on that port')
      expect(step?.why).not.toContain('actually serving')
    })

    it('端口能从 DSH_WEB_URL 里定出来（config.port 为 0 时不猜端口）', async () => {
      const dshHome = await tempDshHome()
      const tool = createCheckAuthTool(
        depsFor(configFor(dshHome), {
          fetch: fetchWithStatus(200),
          env: { DSH_WEB_URL: 'http://127.0.0.1:4444' },
        }),
      )

      const data = expectOk(await run(tool, {}))
      expect(data.key['authority']).toBe('127.0.0.1:4444')
      // 「这个端口是宿主自己在 env 里告诉我们的」，不是我们猜的 3080。
      const resolved = data.key['resolved'] as Record<string, unknown>
      expect(resolved['port']).toBe(4444)
      expect(resolved['portSource']).toBe('env:DSH_WEB_URL')
    })
  })

  describe('错误路径（每条可达 kind）', () => {
    it('auth：401 —— 服务在、认证没过（本工具的核心区分之一）', async () => {
      const dshHome = await tempDshHome()
      const tool = createCheckAuthTool(depsFor(configFor(dshHome), { fetch: fetchWithStatus(401) }))

      const result = await run(tool, { port: 3080 })
      const failure = expectFail(result)
      expect(failure.kind).toBe('auth')
      expect(TOOL_ERROR_KINDS).toContain(failure.kind)
      expect(failure.message).toContain('401')
      expect(failure.message).toContain('not "not running"')
      // 失败分支也有实质 L1（`error.message` 不进模型文本，判定只能靠它）。
      // ⚠️ 判据点的是「服务在、要鉴权」这个事实，不是旧文案里那句「answered 401 even though …」。
      expect(failure.data.verdict).toContain('requires authentication (401)')
      expect(failure.data.verdict).not.toBe('failed')

      // 观测事实的家：`data.key.credentials`（四个字段全在）。
      const credentials = failure.data.key['credentials'] as Record<string, unknown>
      expect(credentials).toBeDefined()
      expect(typeof credentials['exists']).toBe('boolean')
      expect(typeof credentials['clientConnectionPresent']).toBe('boolean')
      expect(typeof credentials['browserSessionPresent']).toBe('boolean')
      expect(typeof credentials['file']).toBe('string')

      // 旧 hint 已删：error 只有 kind / message，那句 browser-session 摘要不在任何模型可见处。
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('期望失败')
      // 两次转型：`ToolError` 是 interface（不带隐式索引签名），直接转 Record 过不了检查。
      const rawError = result.error as unknown as Record<string, unknown>
      expect(Object.keys(rawError).sort()).toEqual(['kind', 'message'])
      const text = renderText(tool, {}, result)
      expect(text).not.toContain('browser-session entry')
      expect(JSON.stringify(result)).not.toContain('browser-session entry')
      // audit 里留着给人复核的原始 detail（不进模型文本）。
      expect(failure.data.audit['probe']).toBeDefined()
      expect(text).not.toContain('this is not "not running"')
    })

    it('not-running：ECONNREFUSED —— 宿主没启动（本工具的核心区分之二）', async () => {
      const dshHome = await tempDshHome()
      const tool = createCheckAuthTool(depsFor(configFor(dshHome), { fetch: refusingFetch }))

      const result = await run(tool, { port: 3080 })
      const failure = expectFail(result)
      expect(failure.kind).toBe('not-running')
      expect(failure.data.verdict).toContain('nothing is listening on 127.0.0.1:3080')
      // 与 401 相反的那一步：去查宿主到底起没起（而不是换凭证）。
      const step = result.nextStep as { tool?: string; args?: Record<string, unknown> } | undefined
      expect(step?.tool).toBe('dsh_diagnose_plugin_load')
      expect(step?.args?.['port']).toBe(3080)
      // 这条路不读凭证文件（不是本次结论的原料）。
      expect(failure.data.key['credentials']).toBeUndefined()
    })

    it('not-configured：定不出端口（三条来源都没有）', async () => {
      const dshHome = await tempDshHome()
      const tool = createCheckAuthTool(depsFor(configFor(dshHome), { fetch: fetchWithStatus(200) }))

      const result = await run(tool, {})
      const failure = expectFail(result)
      expect(failure.kind).toBe('not-configured')
      expect(failure.data.verdict).toContain('no port could be determined')
      expect((failure.data.key['resolved'] as Record<string, unknown>)['portSource']).toBe('none')
      // 什么都没探测：`authority` / `probe` 整条不出现（不给假值冒充）。
      expect(failure.data.key['authority']).toBeUndefined()
      expect(failure.data.key['probe']).toBeUndefined()
    })

    it('cancelled：调用方在探测前就取消了', async () => {
      const dshHome = await tempDshHome()
      const controller = new AbortController()
      controller.abort()
      const tool = createCheckAuthTool(depsFor(configFor(dshHome), { fetch: fetchWithStatus(200) }))

      const result = await run(tool, { port: 3080 }, execWith(controller.signal))
      const failure = expectFail(result)
      expect(failure.kind).toBe('cancelled')
      expect(failure.data.verdict).toContain('cancelled')
      // manual 支：没有工具可派（重试同一个调用是白费）。
      expect((result.nextStep as { manual?: boolean })?.manual).toBe(true)
    })

    it('timeout：传输层先于工具预算超时', async () => {
      const dshHome = await tempDshHome()
      const config = configFor(dshHome, { timeoutMs: 1_000 })
      const tool = createCheckAuthTool(depsFor(config, { fetch: hangingFetch() }))

      const result = await run(tool, { port: 3080 })
      const failure = expectFail(result)
      expect(failure.kind).toBe('timeout')
      expect(failure.message).toContain('timed out')
      expect(failure.data.verdict).toContain('timed out')
      const step = result.nextStep as { tool?: string; args?: Record<string, unknown> } | undefined
      expect(step?.tool).toBe(CHECK_AUTH_TOOL)
      expect(step?.args).toEqual({ port: 3080, host: '127.0.0.1' })

      // ⚠️ `timeoutMs` 是**插件配置字段**，不是本工具的参数（`defineTool` 的 `timeoutMs`
      // 注册期就定死，工具 schema 送到模型前只保留 name/description/parameters）⇒
      // 「让模型去调大 timeoutMs」是**它永远做不到**的指引。这条判据断的是根因：
      // 这句话必须把动作指给**人**，而不是指给模型。
      const why = (result.nextStep as { why?: string } | undefined)?.why ?? ''
      expect(why, 'why 为空 —— 判据在空转').not.toBe('')
      expect(why).toContain('human')
      expect(why, '超时分支又让模型去调大预算了（模型做不到这件事）').not.toMatch(
        /raise timeoutMs/u,
      )
    })

    /**
     * **本文件最重要的一条新判据**：未发送凭据时，401 **不得**被解释成凭据问题。
     *
     * 语义（不是词表）：`dsh_check_auth` 的探测**不带凭据**，所以 401 是**匿名 401**
     * （服务在、要鉴权），对「存的凭据还有没有效 / authority 对不对」**零信息**。
     * 因此「同一份 401 探测 + 不同的凭证文件」必须给出**逐字相同**的判定与下一步 ——
     * 只要结论随凭据变，就是在拿凭据解释一条它根本没参与的探测（旧文案正是如此：
     * `… answered 401 even though a browser-session grant is stored, so the authority is
     * the likely mismatch …`）。
     *
     * 两条一起才是完整判据（坑 18 / 37）：
     * ① **根因**：结论不随凭据变（把旧文案改回去 → 逐字不同 → 红）；
     * ② **下界**：结论必须**明说自己答不了**凭据问题 —— 否则「写死一句与凭据无关的空话」
     *    也能满足 ①。
     */
    it('401 的判定与凭据无关：条目在 / 不在都给同一句，且明说「答不了凭据问题」', async () => {
      const withGrantHome = await tempDshHome()
      await writeText(join(withGrantHome, '.credentials.yaml'), REAL_SHAPE)
      const withGrant = createCheckAuthTool(
        depsFor(configFor(withGrantHome), { fetch: fetchWithStatus(401) }),
      )
      const withoutGrantHome = await tempDshHome()
      const withoutGrant = createCheckAuthTool(
        depsFor(configFor(withoutGrantHome), { fetch: fetchWithStatus(401) }),
      )

      const first = await run(withGrant, { port: 3080 })
      const second = await run(withoutGrant, { port: 3080 })
      const failureA = expectFail(first)
      const failureB = expectFail(second)

      // 下界（坑 18）：两份都要真走到 401，而且**观测到的凭据确实不同** ——
      // 否则「两句话相同」可能只是两次都没读到文件的空转。
      expect(failureA.kind).toBe('auth')
      expect(failureB.kind).toBe('auth')
      expect(
        (failureA.data.key['credentials'] as Record<string, unknown>)['browserSessionPresent'],
      ).toBe(true)
      expect(
        (failureB.data.key['credentials'] as Record<string, unknown>)['browserSessionPresent'],
      ).toBe(false)

      // ① 根因判据：判定与下一步都**不许**随凭据变。
      expect(failureA.data.verdict, '401 的 L1 随凭据变了 —— 等于拿凭据解释匿名 401').toBe(
        failureB.data.verdict,
      )
      const whyA = (first.nextStep as { why?: string } | undefined)?.why
      const whyB = (second.nextStep as { why?: string } | undefined)?.why
      expect(whyA, '401 的 nextStep 随凭据变了').toBe(whyB)

      // ② 下界：判定必须自己说清「这条 401 答不了凭据问题」，而不是含糊或编一个结论。
      expect(failureA.data.verdict).toContain('requires authentication (401)')
      expect(failureA.data.verdict).toContain('sends no credentials')
      expect(failureA.data.verdict).toContain('cannot tell')
      // 下一步指向**真能区分的那条路**（浏览器），不是旧文案那条编出来的「去改 authority」。
      expect(whyA).toContain('browser')
      expect(whyA).not.toContain('make the authority match')
    })
  })

  describe('signal 与超时纪律', () => {
    it('调用方取消能到达 IO 层：取消时探测结束且结论是 cancelled', async () => {
      const dshHome = await tempDshHome()
      const controller = new AbortController()
      const seen: AbortSignal[] = []
      const tool = createCheckAuthTool(depsFor(configFor(dshHome), { fetch: hangingFetch(seen) }))

      const pending = run(tool, { port: 3080 }, execWith(controller.signal))
      // 等底层 fetch 把信号登记下来，再取消调用方。
      await Promise.resolve()
      controller.abort()

      const error = expectFail(await pending)
      expect(error.kind).toBe('cancelled')
      // 透传的不是同一个对象（我们套了一层 controller 以便自己超时），但必须联动。
      expect(seen).toHaveLength(1)
      expect(seen[0]?.aborted).toBe(true)
    })

    it('传下去的 redirect 是 manual（否则 303 会被跟成 200，无法区分）', async () => {
      const dshHome = await tempDshHome()
      const seen: string[] = []
      const spyFetch: FetchImpl = async (_url, init) => {
        seen.push(init.redirect)
        return { status: 200 }
      }
      const tool = createCheckAuthTool(depsFor(configFor(dshHome), { fetch: spyFetch }))

      await run(tool, { port: 3080 })
      expect(seen).toEqual(['manual'])
    })
  })

  describe('形状：三层文本与 data（§3.1 / §4.1）', () => {
    it('`data` 顶层**恰好**三键：成功与失败都同形（B21）', async () => {
      const okHome = await tempDshHome()
      const success = await run(
        createCheckAuthTool(depsFor(configFor(okHome), { fetch: fetchWithStatus(200) })),
        { port: 3080 },
      )
      expect(success.ok).toBe(true)
      if (!success.ok) throw new Error('期望成功')
      expect(Object.keys(success.data).sort()).toEqual(['audit', 'key', 'verdict'])
      expect(toolResultProblem(success)).toBeUndefined()

      const failHome = await tempDshHome()
      const failure = await run(
        createCheckAuthTool(depsFor(configFor(failHome), { fetch: fetchWithStatus(401) })),
        { port: 3080 },
      )
      expect(failure.ok).toBe(false)
      if (failure.ok) throw new Error('期望失败')
      expect(Object.keys(failure.data).sort()).toEqual(['audit', 'key', 'verdict'])
      expect(toolResultProblem(failure)).toBeUndefined()
    })

    it('`nextStep` 出现时**必须带动作**（B18a），且 `why` 不许等于 L1（B18b）', async () => {
      const dshHome = await tempDshHome()
      const tool = createCheckAuthTool(depsFor(configFor(dshHome), { fetch: fetchWithStatus(401) }))

      const result = await run(tool, { port: 3080 })
      const step = result.nextStep as { tool?: string; manual?: boolean; why: string } | undefined
      expect(step).toBeDefined()
      const hasTool = typeof step?.tool === 'string' && step.tool !== ''
      const hasManual = step?.manual === true
      expect(hasTool !== hasManual).toBe(true) // 两支恰有其一
      const data = expectFail(result).data
      expect(step?.why).not.toBe(data.verdict)

      // manual 支在文本里不印空括号、不印 `—`。
      const parts = splitRender(renderText(tool, {}, result))
      expect(parts.l3).not.toBe('')
      expect(parts.l3?.startsWith('(')).toBe(false)
      expect(parts.head).toBe(`[${CHECK_AUTH_TOOL}] failed (auth)`)
    })

    it('模型文本只有 头行 / verdict / L2 / nextStep —— 没有整块 JSON，也没有 audit（B22）', async () => {
      const dshHome = await tempDshHome()
      const tool = createCheckAuthTool(depsFor(configFor(dshHome), { fetch: fetchWithStatus(401) }))
      const result = await run(tool, { port: 3080 })
      const text = renderText(tool, {}, result)

      expect(text).not.toContain('\n  "')
      // 哨兵自检：把哨兵埋进 `audit` 深处，渲染结果里一个字符都不许出现。
      const sentinel = 'SENTINEL_B22_9f3a1c'
      const raw = result as unknown as { data?: Record<string, unknown> }
      const patched = {
        ...(result as unknown as Record<string, unknown>),
        data: { ...(raw.data ?? {}), audit: { probe: { detail: sentinel } } },
      }
      const patchedText = renderText(tool, {}, patched)
      expect(patchedText).toContain('verdict:') // 渲染确实跑了
      expect(patchedText).not.toContain(sentinel)
    })

    it('B16 自检：两份 fixture（输入与环境都换）没有共同的 ≥40 字符行', async () => {
      // 「200 且没有凭证文件」与「401 且真实形状凭证文件」：输入与环境都不同。
      const firstHome = await tempDshHome()
      const first = createCheckAuthTool(
        depsFor(configFor(firstHome), { fetch: fetchWithStatus(200) }),
      )
      const firstResult = await run(first, { port: 3080 })

      const secondHome = await tempDshHome()
      await writeText(join(secondHome, '.credentials.yaml'), REAL_SHAPE)
      const second = createCheckAuthTool(
        depsFor(configFor(secondHome), { fetch: fetchWithStatus(401) }),
      )
      const secondResult = await run(second, { port: 3080 })

      const candidates = (tool: ToolDefinition, value: unknown): string[] => {
        const parts = splitRender(renderText(tool, {}, value))
        return [parts.verdict ?? '', ...parts.l2].filter((line) => line.length >= 40)
      }
      const left = candidates(first, firstResult)
      const right = candidates(second, secondResult)

      // 下界：两份都必须真的吐出候选行，否则「交集为空」是空转。
      expect(left.length, '第一份 fixture 一条 ≥40 字符的行都没有 —— 判据空转').toBeGreaterThan(0)
      expect(right.length, '第二份 fixture 一条 ≥40 字符的行都没有 —— 判据空转').toBeGreaterThan(0)
      const shared = left.filter((line) => right.includes(line))
      expect(shared, `两份 fixture 印出了逐字相同的长行：${shared.join(' | ')}`).toEqual([])
    })

    it('渲染永远有输出：形状不合法的值退化成一行，不抛', async () => {
      const dshHome = await tempDshHome()
      const tool = createCheckAuthTool(depsFor(configFor(dshHome), { fetch: fetchWithStatus(200) }))
      const text = renderText(tool, {}, { nonsense: true })
      expect(text).toBe(`[${CHECK_AUTH_TOOL}] {"nonsense":true}`)
    })

    it('守卫合成的兜底（`key` 是 `{}`）必须可渲染，且降级值看得出来', async () => {
      const dshHome = await tempDshHome()
      const tool = createCheckAuthTool(depsFor(configFor(dshHome), { fetch: fetchWithStatus(200) }))

      // 造一个**形状非法**的返回值（`data.verdict` 是空串）→ 守卫合成兜底（`key: {}`）。
      const malformed = { ok: true, data: { verdict: '', key: {}, audit: {} } }
      const fallback = ensureToolResult(malformed)

      // ⚠️ 下界（活跃坑 18 / 37）：自证这**真的是**兜底 —— 幂等（它自己过了守卫），
      // 且**不等于**输入（输入被换掉了）。否则下面「渲染它当然不抛」是恒真的。
      expect(fallback, '守卫没换掉这个值 —— 下面测的就不是兜底路径').not.toBe(malformed)
      expect(ensureToolResult(fallback), '兜底自己没过守卫').toBe(fallback)
      expect(fallback.ok).toBe(false)

      // 渲染层**绝不抛**（`render.ts` §3.1）：这条路径的崩溃永远发生在「本来就已经出错」的时刻。
      let text = ''
      expect(() => {
        text = renderText(tool, {}, fallback)
      }, '守卫合成的兜底把渲染层打崩了').not.toThrow()
      expect(text).toContain('verdict:')
      // 降级值必须让「兜底发生了」**看得出来** —— 静默省略这一行等于把事实藏起来。
      expect(text).toContain('resolved: unknown (the guard synthesized this result)')
    })
  })

  /**
   * B24：**`execute` 全路径不抛**（SHAPE §10）。
   *
   * 为什么这是契约的承载条件而不是风格：宿主只把**抛出的异常**当失败。一旦异常
   * 穿出 `execute`，模型收到的是宿主的 `Error: <message>` —— 我们全部的失败形状
   * （`verdict` / `key` / `audit`）当场失效，**而且没有任何红线会报警**。
   */
  describe('B24：execute 全路径不抛（意外异常收敛成结构合法的失败）', () => {
    it('注入的替身抛异常时，execute **返回**一个过守卫的合法结果（恒等，不是被合成的兜底）', async () => {
      const dshHome = await tempDshHome()

      // ⚠️ **非空判据挂在哪一环，是这条用例的关键**（活跃坑 18：注入没生效会让判据假绿）。
      //
      // 本工具的 `execute` 全路径**不碰 `spawn`**（`grep spawn src/tools/dsh_check_auth.ts` = 0 处：
      // 它只用 `env` / `fetch` / 文件 / 纯函数），所以「会抛的 spawn」在这条路径上
      // **恒被调用 0 次** —— 注入生效与注入失效**完全同形**，拿它当唯一替身就是空转。
      // 真正能把异常送出 `execute` 的一环是 `resolvePort` 读 `env.DSH_WEB_URL`（`fetch`
      // 那条路由 `lib/http.ts` 自己收敛）。所以：spawn 替身按卡片注入（它同时钉住
      // 「本工具不起子进程」这条边界），**非空判据挂在 `env` 上**。
      let envReads = 0
      let spawnCalls = 0
      const env = Object.defineProperty({} as NodeJS.ProcessEnv, 'DSH_WEB_URL', {
        get() {
          envReads += 1
          throw new Error('the environment port exploded')
        },
        enumerable: true,
      })
      const spawn: SpawnImpl = async () => {
        spawnCalls += 1
        throw new Error('the spawn replacement exploded')
      }
      const tool = createCheckAuthTool(
        depsFor(configFor(dshHome), { fetch: fetchWithStatus(200), env, spawn }),
      )

      // 不许抛 —— 抛了的话这里就是一个 rejected promise，用例直接红。
      const raw = await run(tool, {})

      // 下界：替身必须**真的被调用过**。0 次 = 注入没生效 ⇒ 这条判据在空转（活跃坑 18）。
      expect(
        envReads + spawnCalls,
        '注入的替身一次都没被调用 —— 注入没生效，这条判据会假绿',
      ).toBeGreaterThan(0)
      expect(envReads, 'env 替身没被读到，异常根本没机会穿出 execute').toBeGreaterThan(0)

      // 判据是**恒等**：这个值真的过了守卫，而不是守卫合成的兜底（活跃坑 37）。
      expect(ensureToolResult(raw)).toBe(raw)
      expect(raw.ok).toBe(false)
      if (raw.ok) throw new Error('期望失败')
      // 失败形状必须完整 —— 宿主那条裸 `Error:` 路上这三个键一个都没有。
      expect(Object.keys(raw.data).sort()).toEqual(['audit', 'key', 'verdict'])
      expect(toolResultProblem(raw)).toBeUndefined()
      expect(raw.error.kind).toBe('internal')
      expect(TOOL_ERROR_KINDS).toContain(raw.error.kind)
      // 真原因进了 `message`，不是被吞掉（坑 37 的反面：症状消失 ≠ 根因修好）。
      expect(raw.error.message).toContain('exploded')
      expect(raw.error.message).toContain('probing whether the host is up and authenticated')
      // L1 是**实质句子**：说清「这次没完成」，且「这不是关于认证的结论」。
      expect(raw.data.verdict).not.toBe('failed')
      expect(raw.data.verdict).toContain('nothing was probed')
      expect(raw.data.verdict).toContain('failure of this plugin')
      // 这条路上什么都没观测到：`key` / `audit` 就是空对象（不给假值冒充）。
      expect(raw.data.key).toEqual({})
      expect(raw.data.audit).toEqual({})
      // 没有动作可做 —— 硬编一步只会是「裸结论伪装成下一步」（B18a）。
      expect(raw.nextStep).toBeUndefined()
    })
  })

  describe('凭证形状（缺 C 的回归守卫）：只有 records 段里的合体键才算条目', () => {
    it('401 报告凭证条目是否存在（v1 不读值）—— 夹具是宿主的真实形状', async () => {
      const credentials = await credentialsUnder401(REAL_SHAPE)

      expect(credentials['exists']).toBe(true)
      expect(credentials['clientConnectionPresent']).toBe(true)
      expect(credentials['browserSessionPresent']).toBe(true)
      // 合体键在 `records:` 段里的真实行号（旧嵌套夹具是第 2 行、且宿主根本读不了）。
      expect(credentials['line']).toBe(5)
      // 返回值里不能出现任何秘密（夹具里是假值，且扫描器只回布尔与行号）。
      const serialized = JSON.stringify(credentials)
      expect(serialized).not.toContain(FAKE_SECRET.slice(0, 10))
      expect(serialized).not.toContain('fake-ref-value')
      expect(serialized).not.toContain('fake-key-value')
    })

    it('401 + 条目不在（文件根本没有）→ `key.credentials` 照实报 exists=false', async () => {
      const dshHome = await tempDshHome()
      const tool = createCheckAuthTool(depsFor(configFor(dshHome), { fetch: fetchWithStatus(401) }))

      const failure = expectFail(await run(tool, { port: 3080 }))
      expect((failure.data.key['credentials'] as Record<string, unknown>)['exists']).toBe(false)
    })

    /**
     * 构造性反例：这些形状**都不算**条目（应判 false）。
     *
     * 每一条都是「看着像有 browser-session」的诱饵 —— 老实现的正则不含 `/`，
     * 所以真实形状反而报 false；而这一组保证修好之后**不许**矫枉过正。
     */
    const NOT_AN_ENTRY: ReadonlyArray<{ label: string; text: string }> = [
      {
        label: '旧夹具那种嵌套形状（顶层 client-connection:，宿主读不了）',
        text: ['client-connection:', '  browser-session:', '    secret: deadbeef', ''].join('\n'),
      },
      {
        label: '`refs:` 段里的同名合体键',
        text: ['version: 1', 'refs:', '  client-connection/browser-session: fake-ref', ''].join(
          '\n',
        ),
      },
      {
        label: '注释行里的合体键',
        text: ['version: 1', 'records:', '  # client-connection/browser-session:', ''].join('\n'),
      },
      {
        label: '列表项里的合体键',
        text: ['version: 1', 'records:', '  - client-connection/browser-session:', ''].join('\n'),
      },
      {
        label: '三段键 client-connection/browser/session（宿主只认两段）',
        text: [
          'version: 1',
          'records:',
          '  client-connection/browser/session:',
          '    kind: grant',
          '',
        ].join('\n'),
      },
      {
        label: '与 records 同缩进的合体键（层级不成立）',
        text: ['version: 1', 'records:', 'client-connection/browser-session:', ''].join('\n'),
      },
    ]

    for (const item of NOT_AN_ENTRY) {
      it(`不算条目：${item.label}`, async () => {
        const credentials = await credentialsUnder401(item.text)
        expect(credentials['exists']).toBe(true)
        expect(credentials['browserSessionPresent']).toBe(false)
        expect(credentials['clientConnectionPresent']).toBe(false)
      })
    }
  })
})
