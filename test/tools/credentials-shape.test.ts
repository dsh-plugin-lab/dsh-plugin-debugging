/**
 * 缺 C 的判据：`.credentials.yaml` 的**真实形状是合体键**，不是嵌套两层。
 *
 * ## 为什么这个文件必须有
 *
 * 旧 `keyOf()` 的正则 `^([A-Za-z0-9_.-]+)\s*:` **不含 `/`**，而真实文件里的条目键是
 * `client-connection/browser-session`（一个含 `/` 的键，住在顶层 `records:` 段下）。
 * 于是 `dsh_check_auth` 的 401 证据块**一直**在报 `clientConnectionPresent=false` /
 * `browserSessionPresent=false` —— 既有的 `test/tools/check-auth.test.ts` 之所以全绿，
 * 是因为它的夹具写的正是**错**的嵌套形状（`client-connection:` 里套 `browser-session:`）。
 *
 * ## 依据（两条独立真源）
 *
 * 1. 本机实测 `$DSH_HOME/.credentials.yaml`：第 12 行 `records:`，第 13 行
 *    `  client-connection/browser-session:`（缩进 2，**一个键**）；
 * 2. 宿主源码 `@deepseek-ai/dsh-credentials-local`：`renderRecord()` 是
 *    `document.setIn(["records", key], record)`，`key = ${scope}/${id}`；而
 *    `parseCredentialsDocument()` 只接受顶层 `version` / `refs` / `records`
 *    —— 顶层 `client-connection:` 会被**直接拒绝**，所以嵌套形状在该版本不可能存在。
 *
 * 正文里的每个形状都是**内存/临时文件构造**的，不读真机凭证（只读真机也不行：
 * 那是私密文件，判据不该依赖它）。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { readCredentialsPresence } from '../../src/lib/credentials.ts'

/** 本文件建过的临时根，测试结束统一清掉。 */
const created: string[] = []

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
})

/** 造一个临时 `$DSH_HOME`（登记以便清理）。 */
async function tempDshHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-credentials-shape-'))
  created.push(dir)
  return dir
}

/** 造一个临时 `$DSH_HOME` 并返回 `<它>/.credentials.yaml` 的路径。 */
async function tempCredentialsPath(): Promise<string> {
  return join(await tempDshHome(), '.credentials.yaml')
}

/** 写一份凭证文件。 */
async function writeCredentials(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, 'utf8')
}

/**
 * **真实形状**（照本机实测文件的骨架抄，秘密值换成假的）。
 *
 * 行号是判据的一部分（`line` 要指向真实那一行）：
 * 1 `version`、2 `refs`、3 `refs` 里的条目、4 `records`、**5 `client-connection/browser-session`**。
 */
const REAL_SHAPE = [
  'version: 1',
  'refs:',
  '  DEEPSEEK_API_KEY: fake-ref-value',
  'records:',
  '  client-connection/browser-session:',
  '    kind: grant',
  '    payload: { version: 1, secret: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA }',
  '  deepseek-account-platform/default:',
  '    kind: api-key',
  '    key: fake-key-value',
  '',
].join('\n')

describe('缺 C：合体键 client-connection/browser-session 住在 records 段里', () => {
  it('真实形状 → 两个 present + 行号指向真那一行', async () => {
    const path = await tempCredentialsPath()
    await writeCredentials(path, REAL_SHAPE)

    const presence = await readCredentialsPresence(path)

    // 旧 `keyOf()` 不含 `/`：这一条在旧代码上必然是 false（缺 C 的静默坏）。
    expect(presence.exists).toBe(true)
    expect(presence.clientConnectionPresent).toBe(true)
    expect(presence.browserSessionPresent).toBe(true)
    expect(presence.line).toBe(5)
  })

  it('只有别的 scope → 两个都 false（不许「凡 records 条目都算」）', async () => {
    const path = await tempCredentialsPath()
    await writeCredentials(
      path,
      [
        'version: 1',
        'records:',
        '  deepseek-account-platform/default:',
        '    kind: api-key',
        '',
      ].join('\n'),
    )

    const presence = await readCredentialsPresence(path)

    expect(presence.exists).toBe(true)
    expect(presence.clientConnectionPresent).toBe(false)
    expect(presence.browserSessionPresent).toBe(false)
    expect(presence.line).toBeUndefined()
  })

  it('client-connection 有别的 id（不是 browser-session）→ clientConnection=true / browserSession=false', async () => {
    const path = await tempCredentialsPath()
    await writeCredentials(
      path,
      [
        'version: 1',
        'records:',
        '  client-connection/cookie-jar:',
        '    kind: grant',
        '    payload: { version: 1, secret: AAAA }',
        '',
      ].join('\n'),
    )

    const presence = await readCredentialsPresence(path)

    expect(presence.clientConnectionPresent).toBe(true)
    expect(presence.browserSessionPresent).toBe(false)
  })

  it('嵌套形状（旧夹具那种）→ 两个都 false：那个文件宿主**根本读不了**', async () => {
    const path = await tempCredentialsPath()
    // `test/tools/check-auth.test.ts` 第 87-90 行的夹具就是这个形状。
    // 宿主只认顶层 version/refs/records —— 顶层 `client-connection:` 会被拒（unknown top-level key）。
    // 对一个宿主读不了的文件报「条目存在」，才是真正的骗人。
    await writeCredentials(
      path,
      ['client-connection:', '  browser-session:', '    secret: deadbeef', ''].join('\n'),
    )

    const presence = await readCredentialsPresence(path)

    expect(presence.exists).toBe(true)
    expect(presence.clientConnectionPresent).toBe(false)
    expect(presence.browserSessionPresent).toBe(false)
  })

  it('`refs:` 段里的合体键不算（只认 records 段内的条目）', async () => {
    const path = await tempCredentialsPath()
    await writeCredentials(
      path,
      ['version: 1', 'refs:', '  client-connection/browser-session: fake-ref-value', ''].join('\n'),
    )

    const presence = await readCredentialsPresence(path)

    expect(presence.browserSessionPresent).toBe(false)
    expect(presence.clientConnectionPresent).toBe(false)
  })

  it('注释与列表项不算条目', async () => {
    const path = await tempCredentialsPath()
    await writeCredentials(
      path,
      [
        'version: 1',
        '# records:',
        'records:',
        '  # client-connection/browser-session:',
        '  - client-connection/browser-session:',
        '',
      ].join('\n'),
    )

    const presence = await readCredentialsPresence(path)

    expect(presence.browserSessionPresent).toBe(false)
  })

  it('键比 records 更深是必须的：同缩进的「合体键」不算（层级不成立）', async () => {
    const path = await tempCredentialsPath()
    await writeCredentials(
      path,
      ['version: 1', 'records:', 'client-connection/browser-session:', ''].join('\n'),
    )

    const presence = await readCredentialsPresence(path)

    expect(presence.browserSessionPresent).toBe(false)
  })

  it('一个键里最多一个 `/`（宿主 parseCredentialKey 只认两段）', async () => {
    const path = await tempCredentialsPath()
    await writeCredentials(
      path,
      ['version: 1', 'records:', '  client-connection/browser/session:', ''].join('\n'),
    )

    const presence = await readCredentialsPresence(path)

    expect(presence.browserSessionPresent).toBe(false)
    expect(presence.clientConnectionPresent).toBe(false)
  })

  it('文件不存在 → exists=false，两个都 false', async () => {
    const path = join(await tempDshHome(), '.credentials.yaml')

    const presence = await readCredentialsPresence(path)

    expect(presence.exists).toBe(false)
    expect(presence.clientConnectionPresent).toBe(false)
    expect(presence.browserSessionPresent).toBe(false)
  })

  it('返回值里不含任何值（只有布尔与行号）', async () => {
    const path = await tempCredentialsPath()
    await writeCredentials(path, REAL_SHAPE)

    const presence = await readCredentialsPresence(path)

    const serialized = JSON.stringify(presence)
    expect(serialized).not.toContain('fake-ref-value')
    expect(serialized).not.toContain('fake-key-value')
    expect(serialized).not.toContain('AAAAA')
  })
})
