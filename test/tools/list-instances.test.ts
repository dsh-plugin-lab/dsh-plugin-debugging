/**
 * `dsh_list_instances` —— 发现工具的判据（D′ 第①块）。
 *
 * 三条纪律决定这个文件的结构：
 *
 * 1. **不发真请求、不跑真命令**：`spawn` 与签名探针都从注入点进（本仓 test/AGENTS 的规矩）。
 * 2. **平台必须显式钉住**（活跃坑 25）：本机 Windows、CI ubuntu —— 每条依赖平台分支的用例
 *    都用 `withPlatform` 声明它测哪条，三条分支在任意机器上都被真跑到。
 * 3. **三值不许压成两值**：`dsh` / `other` / `unknown` 三者互不重叠，而
 *    `scan.status` 的 `scanned` / `skipped` / `unavailable` 同样三者互不重叠。
 */
import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import {
  createListInstancesTool,
  DSH_UNAUTHORIZED_BODY,
  LIST_INSTANCES_TOOL,
  type SignatureFetch,
} from '../../src/tools/dsh_list_instances.ts'
import {
  parseListenerScan,
  parseLsofListeners,
  parseNetstatListeners,
  parseSsListeners,
  type ListenerCandidate,
} from '../../src/lib/ports.ts'
import {
  composeDescription,
  DESCRIPTION_MAX_CHARS,
  DESCRIPTION_MAX_LINES,
} from '../../src/tools/describe.ts'
import {
  cmdResult,
  configFor,
  depsFor,
  expectFail,
  expectOk,
  recordingSpawn,
  renderText,
  run,
  splitRender,
  withPlatform,
} from './helpers.ts'
import type { CommandResult, RunCommandOptions } from '../../src/lib/exec.ts'

/** 造一个「按脚本回答」的签名探针替身，并记录每次请求的 URL。 */
function probeStub(
  answer: (
    url: string,
  ) => { status: number; body: string } | Promise<{ status: number; body: string }>,
  failure?: unknown,
): { fetch: SignatureFetch; urls: string[] } {
  const urls: string[] = []
  return {
    urls,
    fetch: async (url) => {
      urls.push(url)
      if (failure !== undefined) throw failure
      const result = await answer(url)
      return { status: result.status, text: async () => result.body }
    },
  }
}

/** 造工具：`spawn` 给一段 socket 表输出，探针给签名答复。 */
function toolWith(options: {
  table?: string
  result?: CommandResult
  probe?: SignatureFetch
}): ToolDefinition {
  const spawn = recordingSpawn(() => options.result ?? cmdResult({ stdout: options.table ?? '' }))
  const base = depsFor(configFor('C:\\fake-home'), { spawn: spawn.spawn })
  // ⚠️ **不许**把 `signatureFetch` 塞进 `depsFor(...)` 的 overrides：那个形参类型里没有它，
  // 而对象展开**不受多余属性检查**约束 ⇒ 它会被静默丢掉、探针退回**真的全局 fetch**，
  // 于是判据会去敲本机真实端口（本机 3080 上就有一个活宿主，实测真的返回了签名！）。
  return createListInstancesTool(
    options.probe === undefined ? base : { ...base, signatureFetch: options.probe },
  )
}

/** win32 的 socket 表（`port|pid|name|startedAt`）。 */
function winTable(): string {
  return ['3080|111|node|2026-01-01T00:00:00.000Z', '4000|222|other|'].join('\r\n')
}

describe(`${LIST_INSTANCES_TOOL} · 专有签名：三值互不重叠`, () => {
  it('401 + 逐字签名 ⇒ dsh；别的 401（body 不同）⇒ other；连不上 ⇒ unknown', async () => {
    const dsh = toolWith({
      table: winTable(),
      probe: probeStub(() => ({ status: 401, body: DSH_UNAUTHORIZED_BODY })).fetch,
    })
    const other = toolWith({
      table: winTable(),
      probe: probeStub(() => ({ status: 401, body: 'unauthorized' })).fetch,
    })
    const refused = new Error('connect ECONNREFUSED')
    const unknown = toolWith({
      table: winTable(),
      probe: probeStub(() => ({ status: 0, body: '' }), refused).fetch,
    })

    const runs = [await run(dsh, {}), await run(other, {}), await run(unknown, {})]
    const verdicts = runs.map(
      (result) =>
        ((expectOk(result).key['instances'] as Record<string, unknown>[])[0] ?? {})['verdict'],
    )
    // 三者**互不相同** —— 防空转：把它们压成一个的话这里立刻红。
    expect(new Set(verdicts).size).toBe(3)
    expect(verdicts).toEqual(['dsh', 'other', 'unknown'])
  })

  it('**别的服务的 401 不许被判成 DSH**（这是「401 就算」那个错法的正面反例）', async () => {
    const tool = toolWith({
      table: '3080|111|node|',
      probe: probeStub(() => ({ status: 401, body: 'unauthorized' })).fetch,
    })
    const data = expectOk(await run(tool, {}))
    const instances = data.key['instances'] as Record<string, unknown>[]
    expect(instances[0]?.['verdict']).toBe('other')
    expect(instances[0]?.['detail']).toContain('not the DSH signature')
    // 一个都没认领到 ⇒ 不许出现「找到了」这种话。
    expect(data.verdict).toContain('no DSH host was found')
  })

  it('**没探到**不许说成「没有 DSH」：全是 unknown 时 L1 明说这是 unknown', async () => {
    const tool = toolWith({
      table: '3080|111|node|',
      probe: probeStub(() => ({ status: 0, body: '' }), new Error('connect ECONNREFUSED')).fetch,
    })
    const data = expectOk(await run(tool, {}))
    expect(data.verdict).toContain('every probe failed')
    expect(data.verdict).toContain('unknown rather than absent')
    expect(data.verdict).not.toContain('no DSH host was found')
  })

  it('认领成功时 L1 给出 authority，并说清**只给 authority、不给 home**', async () => {
    const tool = toolWith({
      table: '3080|111|node|',
      probe: probeStub(() => ({ status: 401, body: DSH_UNAUTHORIZED_BODY })).fetch,
    })
    const data = expectOk(await run(tool, {}))
    expect(data.verdict).toContain('127.0.0.1:3080')
    expect(data.verdict).toContain('never a DSH_HOME')
    expect(data.verdict).toContain('dsh_check_auth')
  })

  it('nextStep 指向 dsh_check_auth，且它的参数值在 L2 里看得见（B17 的口径）', async () => {
    const tool = toolWith({
      table: '3080|111|node|',
      probe: probeStub(() => ({ status: 401, body: DSH_UNAUTHORIZED_BODY })).fetch,
    })
    const result = await run(tool, {})
    const step = expectOk(result).key === undefined ? undefined : result.nextStep
    expect(step !== undefined && 'tool' in step ? step.tool : undefined).toBe('dsh_check_auth')
    const l2 = splitRender(renderText(tool, {}, result)).l2.join('\n')
    expect(l2).toContain('127.0.0.1:3080')
    expect(l2).toContain('3080')
  })

  it('**只探回环**：请求的 URL 只有 127.0.0.1（不碰监听地址上的别的接口）', async () => {
    const stub = probeStub(() => ({ status: 200, body: 'hi' }))
    const tool = toolWith({ table: winTable(), probe: stub.fetch })
    await run(tool, {})
    expect(stub.urls.length).toBeGreaterThan(0)
    for (const url of stub.urls) expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/u)
  })

  it('body 读不出来 ⇒ **unknown**（判据不完整时不许猜成 other）', async () => {
    const tool = toolWith({
      table: '3080|111|node|',
      probe: (async () => ({
        status: 401,
        text: async () => {
          throw new Error('body stream broke')
        },
      })) as SignatureFetch,
    })
    const data = expectOk(await run(tool, {}))
    const instances = data.key['instances'] as Record<string, unknown>[]
    expect(instances[0]?.['verdict']).toBe('unknown')
  })
})

describe(`${LIST_INSTANCES_TOOL} · 接线：判据走完整入口`, () => {
  it('三值结论真的经 `execute` 走到渲染里（不是只测一个内部函数）', async () => {
    const dsh = toolWith({
      table: '3080|111|node|',
      probe: probeStub(() => ({ status: 401, body: DSH_UNAUTHORIZED_BODY })).fetch,
    })
    const rendered = renderText(dsh, {}, await run(dsh, {}))
    expect(rendered).toContain(`[${LIST_INSTANCES_TOOL}] ok`)
    expect(rendered).toContain('instance: 127.0.0.1:3080 dsh')
    // 三值里的另外两值在渲染里长得**不一样**（防空转）。
    const other = toolWith({
      table: '3080|111|node|',
      probe: probeStub(() => ({ status: 200, body: 'ok' })).fetch,
    })
    expect(renderText(other, {}, await run(other, {}))).toContain('instance: 127.0.0.1:3080 other')
    expect(renderText(other, {}, await run(other, {}))).not.toContain(
      'instance: 127.0.0.1:3080 dsh',
    )
  })
})

describe(`${LIST_INSTANCES_TOOL} · scan 的三态（scanned / skipped / unavailable）`, () => {
  it('没给 port：真读 socket 表 ⇒ `scanned`，并逐个探', async () => {
    const tool = toolWith({
      table: winTable(),
      probe: probeStub((url) =>
        url.includes('3080')
          ? { status: 401, body: DSH_UNAUTHORIZED_BODY }
          : { status: 200, body: 'hi' },
      ).fetch,
    })
    const data = expectOk(await run(tool, {}))
    const scan = data.key['scan'] as Record<string, unknown>
    expect(scan['status']).toBe('scanned')
    const instances = data.key['instances'] as Record<string, unknown>[]
    expect(instances.map((item) => item['authority'])).toEqual(['127.0.0.1:3080', '127.0.0.1:4000'])
    expect(instances.map((item) => item['verdict'])).toEqual(['dsh', 'other'])
  })

  it('给了 port：**不扫** ⇒ `skipped`，而且 socket 表命令一次都不跑', async () => {
    const spawn = recordingSpawn(() => cmdResult({ stdout: winTable() }))
    const stub = probeStub(() => ({ status: 401, body: DSH_UNAUTHORIZED_BODY }))
    const tool = createListInstancesTool({
      ...depsFor(configFor('C:\\fake-home'), { spawn: spawn.spawn }),
      signatureFetch: stub.fetch,
    })
    const data = expectOk(await run(tool, { port: 9999 }))
    expect((data.key['scan'] as Record<string, unknown>)['status']).toBe('skipped')
    expect(spawn.calls).toHaveLength(0)
    expect(stub.urls).toEqual(['http://127.0.0.1:9999/'])
    // `skipped` **不是** `unavailable`：它是成功路径（我们主动不扫）。
    expect(data.verdict).toContain('found 1 DSH host(s)')
  })

  it('给了 port 但那个端口不是 DSH ⇒ other（逃生口也有反例）', async () => {
    const tool = toolWith({
      probe: probeStub(() => ({ status: 404, body: 'nope' })).fetch,
    })
    const data = expectOk(await run(tool, { port: 3080 }))
    const instances = data.key['instances'] as Record<string, unknown>[]
    expect(instances[0]?.['verdict']).toBe('other')
    expect(instances[0]?.['status']).toBe(404)
  })

  it('扫不了 + 没给 port ⇒ **失败**，且说清「不知道」而不是「没有」', async () => {
    const tool = toolWith({
      // stdout 非空、stderr 空、一行都没认清 ⇒ 每条尝试都不可信 ⇒ probed:false。
      result: cmdResult({ stdout: 'this is not a socket table\n' }),
    })
    const failed = expectFail(await run(tool, {}))
    expect(failed.kind).toBe('not-configured')
    expect(failed.data.verdict).toContain('unknown rather than empty')
    expect(failed.data.verdict).toContain('pass a port to check one directly')
    expect((failed.data.key['scan'] as Record<string, unknown>)['status']).toBe('unavailable')
  })

  it('扫不了但**给了** port ⇒ 仍然答得出来（那正是这个参数的用处）', async () => {
    const tool = toolWith({
      result: cmdResult({ stdout: 'this is not a socket table\n' }),
      probe: probeStub(() => ({ status: 401, body: DSH_UNAUTHORIZED_BODY })).fetch,
    })
    const data = expectOk(await run(tool, { port: 3080 }))
    expect(data.verdict).toContain('found 1 DSH host(s)')
    expect((data.key['scan'] as Record<string, unknown>)['status']).toBe('skipped')
  })
})

describe(`${LIST_INSTANCES_TOOL} · 平台（三条分支都必须被真跑到）`, () => {
  it('win32：脚本里**没有** `-LocalPort`（那正是「列全部」），且输出多带 port 字段', async () => {
    await withPlatform('win32', async () => {
      const spawn = recordingSpawn(() => cmdResult({ stdout: winTable() }))
      const tool = createListInstancesTool(
        depsFor(configFor('C:\\fake-home'), { spawn: spawn.spawn }),
      )
      await run(tool, {})
      const script = spawn.calls[0]?.args.join(' ') ?? ''
      expect(script).toContain('Get-NetTCPConnection -State Listen')
      expect(script).not.toContain('-LocalPort')
      // 输出字段顺序 `port|pid|name|startedAt` —— 解析器与它成对。
      expect(script).toContain('{0}|{1}|{2}|{3}')
      const parsed = parseListenerScan(winTable())
      expect(parsed.candidates).toEqual([
        { port: 3080, pid: 111, processName: 'node', startedAt: '2026-01-01T00:00:00.000Z' },
        { port: 4000, pid: 222, processName: 'other' },
      ])
    })
  })

  it('win32：pid 读不出来 ⇒ 端口仍在，且**计入 unidentified**（不是「没有」）', () => {
    const parsed = parseListenerScan(['3080|||'].join('\r\n'))
    expect(parsed.candidates).toEqual([{ port: 3080 }])
    expect(parsed.unidentified).toBe(1)
  })

  it('linux：`ss -ltnp` 列出**全部**监听行（不过滤端口），端口取本地地址那一列', async () => {
    await withPlatform('linux', async () => {
      const table = [
        'State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process',
        'LISTEN 0      128    0.0.0.0:3080        0.0.0.0:*         users:(("node",pid=111,fd=20))',
        'LISTEN 0      128    127.0.0.1:4000      0.0.0.0:*',
      ].join('\n')
      const spawn = recordingSpawn(() => cmdResult({ stdout: table }))
      const tool = createListInstancesTool(depsFor(configFor('/fake-home'), { spawn: spawn.spawn }))
      const data = expectOk(await run(tool, {}))
      expect(spawn.calls[0]?.command).toBe('ss')
      expect(spawn.calls[0]?.args).toEqual(['-ltnp'])
      const parsed = parseSsListeners(table)
      expect(parsed.candidates).toEqual([
        { port: 3080, pid: 111, processName: 'node' },
        { port: 4000 },
      ])
      expect(parsed.unidentified).toBe(1)
      // 到工具层：两条候选都在（读不到 pid 的那条照样要探签名 —— D′ 只需要 authority）。
      expect((data.key['instances'] as Record<string, unknown>[]).length).toBe(2)
    })
  })

  it('linux：对端地址里有 `:port` 也**不许**被当成监听端口（结构内下标那条纪律）', () => {
    const table = [
      'State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process',
      'LISTEN 0      128    0.0.0.0:22         1.2.3.4:3080      users:(("sshd",pid=999,fd=3))',
    ].join('\n')
    const parsed = parseSsListeners(table)
    // 报出来的端口必须是 22（本地那一列），不是对端的 3080。
    expect(parsed.candidates.map((item: ListenerCandidate) => item.port)).toEqual([22])
  })

  it('darwin：`lsof -nP -iTCP -sTCP:LISTEN`（不带 `:<port>`），去掉端口过滤', async () => {
    await withPlatform('darwin', async () => {
      const table = [
        'COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
        'node      111 me     23u  IPv4 0x1234      0t0  TCP 127.0.0.1:3080 (LISTEN)',
        'python    222 me      4u  IPv6 0x5678      0t0  TCP *:4000 (LISTEN)',
      ].join('\n')
      const spawn = recordingSpawn(() => cmdResult({ stdout: table }))
      const tool = createListInstancesTool(depsFor(configFor('/fake-home'), { spawn: spawn.spawn }))
      await run(tool, {})
      expect(spawn.calls[0]?.command).toBe('lsof')
      expect(spawn.calls[0]?.args).toEqual(['-nP', '-iTCP', '-sTCP:LISTEN'])
      expect(parseLsofListeners(table).candidates).toEqual([
        { port: 3080, pid: 111, processName: 'node' },
        { port: 4000, pid: 222, processName: 'python' },
      ])
    })
  })

  it('darwin 兜底 `netstat -an`：**不给 pid** ⇒ 端口仍在、记为 unidentified（四态不许压成两值）', async () => {
    await withPlatform('darwin', async () => {
      const table = [
        'Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)',
        'tcp4       0      0  127.0.0.1.3080         *.*                    LISTEN',
        'tcp6       0      0  ::1.4000               *.*                    LISTEN',
      ].join('\n')
      const parsed = parseNetstatListeners(table)
      expect(parsed.candidates).toEqual([{ port: 3080 }, { port: 4000 }])
      expect(parsed.unidentified).toBe(2)
      // 走到工具层：lsof 认不出（喂的是 netstat 的表）⇒ 第一次尝试不可信、第二次顶上。
      const results: CommandResult[] = [
        cmdResult({ stdout: 'not lsof output\n' }),
        cmdResult({ stdout: table }),
      ]
      let index = 0
      const spawn = recordingSpawn(() => results[index++] ?? cmdResult({}))
      const tool = createListInstancesTool(depsFor(configFor('/fake-home'), { spawn: spawn.spawn }))
      const data = expectOk(await run(tool, {}))
      expect((data.key['scan'] as Record<string, unknown>)['unidentified']).toBe(2)
      expect(spawn.calls[1]?.command).toBe('netstat')
    })
  })
})

describe(`${LIST_INSTANCES_TOOL} · 有界与取消`, () => {
  it('候选超过上限 ⇒ 只探上限个，并**明说截断了**（不静默丢）', async () => {
    const many = Array.from({ length: 40 }, (_, index) => `${String(1000 + index)}|1|node|`)
    const stub = probeStub(() => ({ status: 200, body: 'hi' }))
    const tool = toolWith({ table: many.join('\n'), probe: stub.fetch })
    const data = expectOk(await run(tool, {}))
    const scan = data.key['scan'] as Record<string, unknown>
    expect(scan['truncated']).toBe(true)
    expect((data.key['instances'] as unknown[]).length).toBe(24)
    expect(stub.urls.length).toBe(24)
  })

  it('探针抛异常 ⇒ 那个候选是 `unknown`，整次调用**仍然成功**（绝不 throw）', async () => {
    const tool = toolWith({
      table: winTable(),
      probe: probeStub(() => ({ status: 200, body: '' }), new Error('boom')).fetch,
    })
    const data = expectOk(await run(tool, {}))
    const instances = data.key['instances'] as Record<string, unknown>[]
    expect(instances.map((item) => item['verdict'])).toEqual(['unknown', 'unknown'])
  })

  it('调用方已取消 ⇒ `cancelled` 失败，且**一个请求都不发**', async () => {
    const stub = probeStub(() => ({ status: 200, body: 'hi' }))
    const tool = toolWith({ table: winTable(), probe: stub.fetch })
    const controller = new AbortController()
    controller.abort()
    const failed = expectFail(await run(tool, {}, { signal: controller.signal } as never))
    expect(failed.kind).toBe('cancelled')
    expect(stub.urls).toEqual([])
  })
})

describe(`${LIST_INSTANCES_TOOL} · 形状（SHAPE §2.1 / §4.1）`, () => {
  it('描述四段骨架：行数 ≤4、字符 ≤240，且**明说给不出 home**', () => {
    const text = composeDescription({
      what: 'Lists live DSH hosts on this machine.',
      useWhen: 'Use to find instances; pass a result to dsh_check_auth.',
      boundary:
        'Returns an authority (host:port) only, never a DSH_HOME.\n' +
        'Loopback only; could not probe is not the same as not DSH.',
    })
    expect(text.split('\n').length).toBeLessThanOrEqual(DESCRIPTION_MAX_LINES)
    expect(text.length).toBeLessThanOrEqual(DESCRIPTION_MAX_CHARS)
    // 「给不出 home」是维护者的硬要求：描述里必须有这一句，否则就是在骗模型。
    expect(text).toContain('never a DSH_HOME')
  })

  it('每个参数都有非空描述（读 `parameters.properties`，不是顶层遍历）', () => {
    const tool = createListInstancesTool(depsFor(configFor('C:\\fake-home')))
    const params = tool.parameters as { properties?: Record<string, { description?: string }> }
    const names = Object.keys(params.properties ?? {})
    expect(names).toEqual(['port'])
    for (const name of names) {
      expect(params.properties?.[name]?.description ?? '').not.toBe('')
    }
  })

  it('`data` 恰好三键（顶层不许有第四个）', async () => {
    const tool = toolWith({
      table: '3080|111|node|',
      probe: probeStub(() => ({ status: 401, body: DSH_UNAUTHORIZED_BODY })).fetch,
    })
    const result = (await run(tool, {})) as unknown as Record<string, unknown>
    expect(Object.keys(result).sort()).toEqual(['data', 'nextStep', 'ok'])
    const data = result['data'] as Record<string, unknown>
    expect(Object.keys(data).sort()).toEqual(['audit', 'key', 'verdict'])
  })

  it('形状不合法的返回值也**渲染得出来**（守卫合成的 `key={}` 不许抛）', () => {
    const tool = createListInstancesTool(depsFor(configFor('C:\\fake-home')))
    const rendered = renderText(tool, {}, { ok: true, data: { verdict: 'v', key: {}, audit: {} } })
    expect(rendered).toContain('scan: unknown (the guard synthesized this result)')
  })
})

/** 工具名与闭集一致（B9 的名字就在这个常量上）。 */
describe(`${LIST_INSTANCES_TOOL} · 名字`, () => {
  it('注册用的名字与导出常量一致', () => {
    const tool = createListInstancesTool(depsFor(configFor('C:\\fake-home')))
    expect(tool.name).toBe(LIST_INSTANCES_TOOL)
  })
})

/** 未使用的形参占位（`RunCommandOptions` 只用于类型收窄）。 */
export type _Unused = RunCommandOptions
