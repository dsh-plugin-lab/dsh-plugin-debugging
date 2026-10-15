/**
 * `dsh_sign_cookie` 的行为红线 + **凭证绝不外泄**的守卫。
 *
 * 这个工具的特殊性：**它是本仓唯一会经手秘密的**。所以本文件最要紧的不是「能不能签出来」
 * （那是算法，照抄宿主），而是三条边界：
 *
 * 1. **cookie 值与密钥绝不进返回值** —— `data` 里一个都不许有，`audit` 里也不许有
 *    （`audit` 会被 spill 写到磁盘，凭证进去 = 凭证落盘）。
 * 2. **算法逐字照抄宿主** —— cookie 名、`v1.<body>.<sig>` 的形状、base64url 变体，
 *    任何一处自己发明都会导致「签出来的东西宿主不认」。
 * 3. **失败分支不许谎称签过** —— `key` 里那些签发字段**缺席**，不是填占位值。
 *
 * 安全：夹具里的密钥一律 `randomBytes(32)` 现造，只活在临时目录，跑完即删。
 * 本文件不读、不打印、不落盘任何真实密钥。
 */
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createHash, createHmac } from 'node:crypto'

import {
  createSignCookieTool,
  SIGN_COOKIE_DESCRIPTION,
  SIGN_COOKIE_TOOL,
} from '../../src/tools/dsh_sign_cookie.ts'
import {
  cookieHeader,
  cookieName,
  decodeBase64Url,
  encodeBase64Url,
  extractBrowserSessionSecret,
  signCookie,
} from '../../src/lib/cookie-sign.ts'
import { composeDescription } from '../../src/tools/describe.ts'
import {
  configFor,
  depsFor,
  expectFail,
  expectOk,
  renderText,
  run,
  tempDshHome,
  writeText,
} from './helpers.ts'

/** 一份「有 browser-session 密钥」的凭证文件文本（密钥现造，不是常量）。 */
function credentialsWithGrant(secret?: string): string {
  return [
    'version: 1',
    'refs:',
    'records:',
    '  client-connection/browser-session:',
    '    kind: grant',
    '    payload:',
    '      version: 1',
    `      secret: ${secret ?? encodeBase64Url(randomBytes(32))}`,
    '  other-thing/other-id:',
    '    kind: grant',
    '',
  ].join('\n')
}

/** 建一份临时 `$DSH_HOME` 并写好凭证文件。 */
async function homeWithCredentials(body: string | undefined): Promise<string> {
  const home = await tempDshHome()
  if (body !== undefined) await writeText(join(home, '.credentials.yaml'), body)
  return home
}

describe(SIGN_COOKIE_TOOL, () => {
  describe('算法：逐字照抄宿主（`0.2.1-alpha.2`，dsh-client-connection）', () => {
    it('cookie 名 = `dsh-auth-` + base64url(sha256(authority))', () => {
      const authority = '127.0.0.1:3080'
      const expected =
        'dsh-auth-' +
        Buffer.from(createHash('sha256').update(authority).digest())
          .toString('base64')
          .replaceAll('+', '-')
          .replaceAll('/', '_')
          .replace(/=+$/u, '')
      expect(cookieName(authority)).toBe(expected)
    })

    it('值 = `v1.<base64url(JSON)>.<base64url(HMAC-SHA256)>`，三段齐全', () => {
      const secret = randomBytes(32)
      const signed = signCookie(secret, '127.0.0.1:3080', 1_000_000, 30)
      const parts = signed.value.split('.')
      expect(parts).toHaveLength(3)
      expect(parts[0]).toBe('v1')
      // body 解出来必须正好是那四个字段（宿主 `decodeCookie:368` 就校验这四个）。
      const payload = JSON.parse(
        decodeBase64Url(parts[1] ?? '')?.toString('utf8') ?? '{}',
      ) as Record<string, unknown>
      expect(Object.keys(payload).sort()).toEqual(['authority', 'expiresAt', 'issuedAt', 'version'])
      expect(payload['version']).toBe(1)
      expect(payload['authority']).toBe('127.0.0.1:3080')
      // 签名是对 **body 串**签的，不是对 JSON 签的 —— 签错对象宿主一样不认。
      const expectedSig = encodeBase64Url(
        createHmac('sha256', secret)
          .update(parts[1] ?? '')
          .digest(),
      )
      expect(parts[2]).toBe(expectedSig)
    })

    it('base64url：无 padding、且 `+/` 换成了 `-_`', () => {
      // 0xFB 0xFF 在标准 base64 里是 `+/`，是最容易漏转换的两个字节。
      const raw = Buffer.from([0xfb, 0xff, 0xfe])
      const encoded = encodeBase64Url(raw)
      expect(encoded).not.toContain('+')
      expect(encoded).not.toContain('/')
      expect(encoded).not.toContain('=')
      expect(decodeBase64Url(encoded)?.equals(raw)).toBe(true)
      // 重编码自检：非 base64url 串必须被拒（宿主 `decodeBase64Url:282-287` 同样拒）。
      expect(decodeBase64Url('not base64url!')).toBeUndefined()
    })

    it('有效期 = 签发时刻 + 30 天（宿主默认，不滑动）', () => {
      const signed = signCookie(randomBytes(32), 'h:1', 1_000_000)
      expect(signed.payload.expiresAt - signed.payload.issuedAt).toBe(30 * 24 * 60 * 60 * 1e3)
    })

    it('换一个 authority 就换一个 cookie 名（cookie 绑 authority）', () => {
      expect(cookieName('127.0.0.1:3080')).not.toBe(cookieName('127.0.0.1:3081'))
      expect(cookieName('localhost:3080')).not.toBe(cookieName('127.0.0.1:3080'))
    })

    it('`cookieHeader` 就是 `名=值` 一段（`Cookie:` 头要的就是这个形状）', () => {
      const signed = signCookie(randomBytes(32), '127.0.0.1:3080', 1_000_000)
      expect(cookieHeader(signed.name, signed.value)).toBe(`${signed.name}=${signed.value}`)
      // 头里**不许**混进 `Path` / `HttpOnly` 这些 `Set-Cookie` 属性 ——
      // 那套属性是给浏览器存盘用的，发 `Cookie:` 头时带上会让服务端认不出。
      expect(cookieHeader(signed.name, signed.value)).not.toContain('Path=')
    })
  })

  describe('密钥提取：只认真实形状', () => {
    it('合体键（`records:` 段下的一行）→ 取出 32 字节', () => {
      const secret = randomBytes(32)
      const result = extractBrowserSessionSecret(credentialsWithGrant(encodeBase64Url(secret)))
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.secret.equals(secret)).toBe(true)
    })

    it('顶层 `client-connection:` 再往下（宿主会拒的形状）→ 判缺失，不判存在', () => {
      // `parseCredentialsDocument()` 只接受顶层 version/refs/records 三个键，
      // 所以嵌套两层的文件在真机上根本读不出来 —— 判它「有密钥」是骗人。
      const nested = [
        'version: 1',
        'client-connection:',
        '  browser-session:',
        '    kind: grant',
        '    payload:',
        `      secret: ${encodeBase64Url(randomBytes(32))}`,
        '',
      ].join('\n')
      const result = extractBrowserSessionSecret(nested)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.problem).toBe('missing')
    })

    it('`refs:` 段里的同名键**不算**条目（那是引用不是记录）', () => {
      const body = [
        'version: 1',
        'refs:',
        '  client-connection/browser-session: something',
        'records:',
        '  other/thing:',
        '    kind: grant',
        '',
      ].join('\n')
      expect(extractBrowserSessionSecret(body).ok).toBe(false)
    })

    it('密钥不是 32 字节 → 判 malformed（不是 missing）', () => {
      const result = extractBrowserSessionSecret(
        credentialsWithGrant(encodeBase64Url(randomBytes(16))),
      )
      expect(result.ok).toBe(false)
      // 两者下一步不同：missing = 去浏览器登录一次；malformed = 文件坏了，要先查文件。
      if (!result.ok) expect(result.problem).toBe('malformed')
    })

    it('`#` 注释行不参与层级判断（`# records:` 不是段）', () => {
      const body = [
        '# records:',
        'records:',
        '  client-connection/browser-session:',
        '    kind: grant',
        '    payload:',
        `      secret: ${encodeBase64Url(randomBytes(32))}`,
        '',
      ].join('\n')
      expect(extractBrowserSessionSecret(body).ok).toBe(true)
    })
  })

  describe('成功路径', () => {
    it('签出来了：authority / cookie 名 / 到期时刻都在 `key` 里', async () => {
      const secret = randomBytes(32)
      const home = await homeWithCredentials(credentialsWithGrant(encodeBase64Url(secret)))
      const tool = createSignCookieTool(
        depsFor(configFor(home, { port: 3080 }), { now: () => 1_000_000 }),
      )

      const data = expectOk(await run(tool, { port: 3080, host: '127.0.0.1' }))

      expect(data.key['authority']).toBe('127.0.0.1:3080')
      expect(data.key['cookieName']).toBe(cookieName('127.0.0.1:3080'))
      expect(data.key['issuedAt']).toBe(1_000_000)
      expect(Number(data.key['expiresAt'])).toBe(1_000_000 + 30 * 24 * 60 * 60 * 1e3)
    })

    it('`host` 逐字进 authority（默认值 127.0.0.1）', async () => {
      const home = await homeWithCredentials(credentialsWithGrant())
      const tool = createSignCookieTool(depsFor(configFor(home, { port: 3080 })))

      expect(expectOk(await run(tool, { port: 3080 })).key['authority']).toBe('127.0.0.1:3080')
      expect(expectOk(await run(tool, { port: 3080, host: 'localhost' })).key['authority']).toBe(
        'localhost:3080',
      )
    })

    it('`maxAgeDays` 能改寿命，省略时用宿主默认 30', async () => {
      const home = await homeWithCredentials(credentialsWithGrant())
      const tool = createSignCookieTool(depsFor(configFor(home, { port: 3080 }), { now: () => 0 }))

      const seven = expectOk(await run(tool, { port: 3080, maxAgeDays: 7 }))
      expect(Number(seven.key['expiresAt']) - Number(seven.key['issuedAt'])).toBe(
        7 * 24 * 60 * 60 * 1e3,
      )
      const thirty = expectOk(await run(tool, { port: 3080 }))
      expect(Number(thirty.key['expiresAt']) - Number(thirty.key['issuedAt'])).toBe(
        30 * 24 * 60 * 60 * 1e3,
      )
    })

    it('成功路径的 L1 是**陈述**：不许指路去拿一个拿不到的值（A4）', async () => {
      const home = await homeWithCredentials(credentialsWithGrant())
      const tool = createSignCookieTool(depsFor(configFor(home, { port: 3080 })))

      const data = expectOk(await run(tool, { port: 3080 }))
      // 病句一「去读宿主已经设好的那个 cookie」：模型没有读浏览器 cookie 的途径，
      // 而且宿主若已给过有效 cookie，本工具本就不必调。
      expect(data.verdict).not.toContain('read it from the cookie the host already set')
      // 病句二「用同一把密钥自己签」：密钥刻意不进任何返回值 ⇒ 模型签不了。
      expect(data.verdict).not.toContain('sign it yourself')
      // 说清「值不回到这个通道」，并点明谁才拿得到。
      expect(data.verdict).toContain('not returned to this channel')
      expect(data.verdict).toContain('call the signer directly')
    })

    it('成功路径的下一步不许指向 `dsh_check_auth` 去「确认 cookie 被接受」（A4）', async () => {
      const home = await homeWithCredentials(credentialsWithGrant())
      const tool = createSignCookieTool(depsFor(configFor(home, { port: 3080 })))

      const result = await run(tool, { port: 3080 })
      // `dsh_check_auth` 的参数只有 port / host，它的探测**不发任何凭据** ⇒
      // 「confirm the signed cookie is accepted」能力上不可能；而 cookie 值压根没返回，
      // 「把 authority 当 Cookie 头值发出去」本身也不成立（cookie 头是 `name=value`）。
      expect(Object.hasOwn(result.nextStep ?? {}, 'tool')).toBe(false)
      expect(result.nextStep).toHaveProperty('manual', true)
      expect(result.nextStep?.why).toContain('never leaves the signing side')
      expect(result.nextStep?.why).not.toContain('Cookie header value')
    })
  })

  describe('⚠️ 凭证绝不外泄（本工具存在的全部理由）', () => {
    it('`data` 整棵树里没有 cookie 值，也没有密钥', async () => {
      const secret = randomBytes(32)
      const secretText = encodeBase64Url(secret)
      const home = await homeWithCredentials(credentialsWithGrant(secretText))
      const tool = createSignCookieTool(depsFor(configFor(home, { port: 3080 })))

      const result = await run(tool, { port: 3080 })
      const serialized = JSON.stringify(result)

      // 密钥本身、以及能反推出签名的那三个字段，都不许出现。
      expect(serialized).not.toContain(secretText)
      expect(serialized).not.toContain(secret.toString('base64'))
      expect(serialized).not.toContain(secret.toString('base64url'))
      // `v1.` 开头的那个串就是 cookie 值本体。
      expect(serialized).not.toContain('v1.')
      // cookie **名**不是秘密，可以在（宿主自己也把它算作可公开的标识）。
      expect(serialized).toContain(cookieName('127.0.0.1:3080'))
    })

    it('`audit` 里没有 cookie 也没有密钥（它会被 spill 写到磁盘）', async () => {
      const secretText = encodeBase64Url(randomBytes(32))
      const home = await homeWithCredentials(credentialsWithGrant(secretText))
      const tool = createSignCookieTool(depsFor(configFor(home, { port: 3080 })))

      const data = expectOk(await run(tool, { port: 3080 }))
      const audit = JSON.stringify(data.audit)
      expect(audit).not.toContain(secretText)
      expect(audit).not.toContain('v1.')
      // 审计只留「读了哪个文件」这种不含值的事实。
      expect(audit).toContain('.credentials.yaml')
    })

    it('模型可见文本里没有 cookie 值', async () => {
      const home = await homeWithCredentials(credentialsWithGrant())
      const tool = createSignCookieTool(depsFor(configFor(home, { port: 3080 })))

      const result = await run(tool, { port: 3080 })
      const rendered = (tool.output.render as (a: unknown, v: unknown) => unknown[])({}, result)
      const text = JSON.stringify(rendered)
      expect(text).not.toContain('v1.')
      // 但要看得见「签成了、绑在哪、到什么时候」。
      expect(text).toContain('127.0.0.1:3080')
    })
  })

  describe('失败路径：每条都带 verdict，且不谎称签过', () => {
    it('凭证文件不存在 → `not-found`，下一步指向浏览器登录一次', async () => {
      const home = await homeWithCredentials(undefined)
      const tool = createSignCookieTool(depsFor(configFor(home, { port: 3080 })))

      const failed = expectFail(await run(tool, { port: 3080 }))
      expect(failed.kind).toBe('not-found')
      expect(failed.data.verdict).toContain('no cookie was signed')
      expect(failed.nextStep).toBeDefined()
    })

    it('文件在但没有那条 grant → `not-found`（不是 internal）', async () => {
      const home = await homeWithCredentials(
        ['version: 1', 'records:', '  other/thing:', '    kind: grant', ''].join('\n'),
      )
      const tool = createSignCookieTool(depsFor(configFor(home, { port: 3080 })))

      const failed = expectFail(await run(tool, { port: 3080 }))
      // 重调同一个调用拿不到新信息 ⇒ 这是**确定性**拒绝，`not-found` 才是对的 kind。
      expect(failed.kind).toBe('not-found')
      expect(failed.data.verdict).toContain('no cookie was signed')
    })

    it('密钥格式不对 → `internal`，并说清「别重试」', async () => {
      const home = await homeWithCredentials(credentialsWithGrant(encodeBase64Url(randomBytes(16))))
      const tool = createSignCookieTool(depsFor(configFor(home, { port: 3080 })))

      const failed = expectFail(await run(tool, { port: 3080 }))
      expect(failed.kind).toBe('internal')
      expect(failed.data.verdict).toContain('no cookie was signed')
    })

    it('端口定不出来 → `not-configured`，且 `key` 里没有 authority', async () => {
      const home = await homeWithCredentials(credentialsWithGrant())
      // `port: 0` + 空 env ⇒ `resolvePort` 返回 undefined ⇒ authority 连拼都拼不出。
      const tool = createSignCookieTool(depsFor(configFor(home, { port: 0 }), { env: {} }))

      const failed = expectFail(await run(tool, {}))
      expect(failed.kind).toBe('not-configured')
      expect(failed.data.key['authority']).toBeUndefined()
      expect(failed.data.key['cookieName']).toBeUndefined()
      expect(failed.data.key['expiresAt']).toBeUndefined()
      // 但「读了哪份配置」这一样必须还在。
      expect(failed.data.key['resolved']).toBeDefined()
      // 不许套工具名：那会让模型逐字重调、拿到同一个不动点（死路）。
      // `NextStep` 是联合类型，两支各有各的字段 —— 判「没有 tool 那一支」得判形状，
      // 不能直接读 `.tool`（那是另一支的字段，TS 会拦；运行时读也只是 undefined）。
      expect(failed.nextStep).toBeDefined()
      expect(Object.hasOwn(failed.nextStep ?? {}, 'tool')).toBe(false)
      expect(failed.nextStep).toHaveProperty('manual', true)
    })

    it('`maxAgeDays` 不是正整数 → 拒绝，且不签', async () => {
      const home = await homeWithCredentials(credentialsWithGrant())
      const tool = createSignCookieTool(depsFor(configFor(home, { port: 3080 })))

      for (const bad of [0, -1]) {
        const failed = expectFail(await run(tool, { port: 3080, maxAgeDays: bad }))
        // `internal` =「本插件自己的意外 / bug」—— 而这里明明是**输入无效**。
        // 用 `internal` 会让首行印成 `failed (internal)`、正文却说输入不是正整数：自相矛盾（S5）。
        expect(failed.kind).not.toBe('internal')
        expect(failed.kind).toBe('not-configured')
        expect(failed.data.verdict).toContain('no cookie was signed')
        expect(failed.data.verdict).toContain('maxAgeDays')
        expect(failed.data.key['expiresAt']).toBeUndefined()
      }

      // 头行逐字：不许是 `failed (internal)`（那是 S5 的原始症状）。
      const badArgs = { port: 3080, maxAgeDays: 0 }
      const text = renderText(tool, badArgs, await run(tool, badArgs))
      expect(text).toContain(`[${SIGN_COOKIE_TOOL}] failed (not-configured)`)
      expect(text).not.toContain('failed (internal)')
      // ⚠️ **小数那条由宿主在参数校验层就拒**（实测报 `"maxAgeDays" must be an integer`），
      // 比我们自己的检查更早一道 ⇒ 它**进不到** `execute`，也就没有 verdict 可断言。
      // 这条断言记的是「那道防线存在」，不是「我们的校验拦住了它」。
      await expect(
        tool.execute({ port: 3080, maxAgeDays: 1.5 }, {
          signal: new AbortController().signal,
        } as never),
      ).rejects.toThrow()
    })

    it('每条失败分支都不谎称签过（`expiresAt` 一律缺席，不是 0）', async () => {
      const cases = [
        await homeWithCredentials(undefined),
        await homeWithCredentials('version: 1\nrecords:\n'),
        await homeWithCredentials(credentialsWithGrant(encodeBase64Url(randomBytes(16)))),
      ]
      for (const home of cases) {
        const tool = createSignCookieTool(depsFor(configFor(home, { port: 3080 })))
        const failed = expectFail(await run(tool, { port: 3080 }))
        expect(failed.data.key['expiresAt']).toBeUndefined()
        expect(failed.data.key['cookieName']).toBeUndefined()
      }
    })
  })

  describe('B24：`execute` 全路径不抛', () => {
    it('注入会抛的替身 → 收敛成 `internal` 失败，不是异常', async () => {
      const home = await tempDshHome()
      // `env` 用 Proxy 造「一读就抛」—— `resolvePort` 读它时会把整个工具带崩。
      // 替身**真的被读到**（不是空转）：`port: 0` 让它必须去翻 env。
      const deps = depsFor(configFor(home, { port: 0 }), {
        env: new Proxy({} as NodeJS.ProcessEnv, {
          get() {
            throw new Error('env exploded')
          },
        }),
      })
      const tool = createSignCookieTool(deps)

      const failed = expectFail(await run(tool, {}))
      // 契约的承载条件：**抛出去**的话宿主会包成裸 `Error: <message>`，
      // `verdict` / `key` / `audit` 全部消失 —— 收敛成 `internal` 才是对的。
      expect(failed.kind).toBe('internal')
      // 失败分支也必须有 L1（错误消息不进模型文本，这是它唯一的判定行）。
      expect(failed.data.verdict).toContain('nothing was signed')
      expect(failed.data.verdict).toContain('failure of this plugin')
      // 顶层仍然是合法的工具结果，没有第四个键。
      expect(Object.keys(failed.data).sort()).toEqual(['audit', 'key', 'verdict'])
    })
  })

  describe('形状（SHAPE §2.1 / §4.1）', () => {
    it('描述四段齐全、行数与字符数在上限内', () => {
      const text = composeDescription(SIGN_COOKIE_DESCRIPTION)
      // 4 行 = what / useWhen / boundary 两行。`composeDescription` 先滤空段再
      // 用 `\n` 连（见 describe.ts 的注释），所以 boundary 内那个换行也占一行。
      expect(text.split('\n')).toHaveLength(4)
      expect(text.split('\n').length).toBeLessThanOrEqual(4)
      expect(text.length).toBeLessThanOrEqual(240)
    })

    it('每个参数都有非空描述（读 `parameters.properties`，不是顶层遍历）', () => {
      const tool = createSignCookieTool(depsFor(configFor('/tmp/none', { port: 3080 })))
      const params = tool.parameters as { properties?: Record<string, { description?: string }> }
      const names = Object.keys(params.properties ?? {})
      expect(names).toEqual(['port', 'host', 'maxAgeDays', 'dshHome'])
      let total = 0
      for (const name of names) {
        const description = params.properties?.[name]?.description ?? ''
        expect(description.trim(), `参数 ${name} 的描述为空`).not.toBe('')
        total += description.length
      }
      expect(total).toBeGreaterThan(0)
      // S5 的配套：描述里要说清下界，否则模型很容易给出 0（参数名只暗示「天数」）。
      expect(params.properties?.['maxAgeDays']?.description ?? '').toContain('positive')
    })

    it('`data` 恰好三键（顶层不许有第四个）', async () => {
      const home = await homeWithCredentials(credentialsWithGrant())
      const tool = createSignCookieTool(depsFor(configFor(home, { port: 3080 })))
      const result = (await run(tool, { port: 3080 })) as unknown as Record<string, unknown>

      expect(Object.keys(result).sort()).toEqual(['data', 'nextStep', 'ok'])
      const data = result['data'] as Record<string, unknown>
      expect(Object.keys(data).sort()).toEqual(['audit', 'key', 'verdict'])
    })
  })

  describe('跨实例（D′ 第②块）：dshHome 参数', () => {
    it('读的是**参数那个** home 的密钥：配置 home 里没有凭据也照样签得出来', async () => {
      // 判据落在**真路径解析**上：配置 home 是空的（读它必然 not-found），凭据只在参数 home 里。
      // 所以「签成功」这件事本身证明它读的是参数那一份 —— 不是靠断言某个字段。
      const configuredHome = await tempDshHome()
      const otherHome = await homeWithCredentials(credentialsWithGrant())
      const tool = createSignCookieTool(depsFor(configFor(configuredHome, { port: 3080 })))

      const data = expectOk(await run(tool, { port: 3080, dshHome: otherHome }))
      expect(data.key['cookieName']).toBeDefined()
      const resolved = data.key['resolved'] as Record<string, unknown>
      expect(resolved['dshHome']).toBe(otherHome)
      // 三值纪律：参数来的值不许印成 config / default。
      expect(resolved['dshHomeSource']).toBe('tool-argument')
      // 审计里那个「读了哪个文件」的事实也必须指向参数 home（它是复核材料）。
      expect(String(data.audit['file'])).toContain(otherHome)
    })

    it('反向：把凭据放在**配置** home 里、参数指一个空 home ⇒ 必须 not-found（判据不恒真）', async () => {
      const configuredHome = await homeWithCredentials(credentialsWithGrant())
      const emptyHome = await tempDshHome()
      const tool = createSignCookieTool(depsFor(configFor(configuredHome, { port: 3080 })))

      const failed = expectFail(await run(tool, { port: 3080, dshHome: emptyHome }))
      expect(failed.kind).toBe('not-found')
      const resolved = failed.data.key['resolved'] as Record<string, unknown>
      expect(resolved['dshHome']).toBe(emptyHome)
      expect(resolved['dshHomeSource']).toBe('tool-argument')
    })
  })
})
