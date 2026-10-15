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
  listenerScanAttempts,
  listListeners,
  parseListenerScan,
  parseLsofListeners,
  parseNetstatListeners,
  parseSsListeners,
  WINDOWS_FALLBACK_COMMAND,
  type ListenerCandidate,
  type ListenerScanResult,
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
import type { CommandResult, RunCommandOptions, SpawnImpl } from '../../src/lib/exec.ts'

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

/**
 * 造工具：`spawn` 给一段 socket 表输出（**默认 win32 形状**），探针给签名答复。
 *
 * ⚠️ **执行必须在钉住的平台上跑**（活跃坑 25 的隐蔽变体）：解析按**当前平台**选分支，
 * 而这些夹具喂的是 win32 形状的表 —— 不钉 ⇒ 本机（Windows）绿、CI（ubuntu）红。
 * 本 PR 首次推送在 CI 上真踩：同一段 `port|pid|name|startedAt` 被按 `ss` 解析 ⇒ 0 行
 * ⇒ `unavailable` ⇒ 工具报 `not-configured`。
 *
 * **钉的是「构造 + 执行」整段**，不是只包构造 —— 只包构造、让 `execute` 落在平台恢复
 * 之后，等于没包（`diagnose` 那边就是这么错的）。要喂别的平台的表，显式传 `platform`。
 */
function toolWith(options: {
  table?: string
  result?: CommandResult
  probe?: SignatureFetch
  platform?: NodeJS.Platform
}): ToolDefinition {
  const spawn = recordingSpawn(() => options.result ?? cmdResult({ stdout: options.table ?? '' }))
  const base = depsFor(configFor('C:\\fake-home'), { spawn: spawn.spawn })
  // ⚠️ **不许**把 `signatureFetch` 塞进 `depsFor(...)` 的 overrides：那个形参类型里没有它，
  // 而对象展开**不受多余属性检查**约束 ⇒ 它会被静默丢掉、探针退回**真的全局 fetch**，
  // 于是判据会去敲本机真实端口（本机 3080 上就有一个活宿主，实测真的返回了签名！）。
  const tool = createListInstancesTool(
    options.probe === undefined ? base : { ...base, signatureFetch: options.probe },
  )
  const platform = options.platform ?? 'win32'
  return {
    ...tool,
    execute: (args, exec) => withPlatform(platform, () => tool.execute(args, exec)),
  }
}

/** win32 的 socket 表（`port|pid|name|startedAt`）。 */
function winTable(): string {
  return ['3080|111|node|2026-01-01T00:00:00.000Z', '4000|222|other|'].join('\r\n')
}

/**
 * 跑一次「列出全部监听者」并**原样**拿回扫描结果。
 *
 * 为什么单独一条：这层判据要看的正是 `probed` / `candidates` / `unidentified` 三者，
 * 经工具层再回来时它们已经被折叠进渲染文案与 `key` 了 —— 折叠过的那份盯不住
 * 「三值有没有塌」。要钉工具层的接线时用 `createListInstancesTool` 那几条。
 *
 * ⚠️ **调用必须在钉住的平台上**（坑 25）：方案是按 `process.platform` 现读的。
 *
 * @param spawn 注入的 spawn 替身。
 */
async function listListenersWith(spawn: SpawnImpl): Promise<ListenerScanResult> {
  return await listListeners({ spawn, timeoutMs: 1_000 })
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

  it('给了 port 但探不到 ⇒ **不许**说「N listening port(s) were found」（那条路根本没扫）', async () => {
    // ⚠️ 给了 `port` 时 `scan.status='skipped'`、socket 表命令一次都不跑 ⇒ 那个端口上有没有
    // 人在听**根本没读**，旧文案却断言「1 listening port(s) were found」——那是编的。
    const stub = probeStub(() => ({ status: 0, body: '' }), new Error('connect ECONNREFUSED'))
    const tool = toolWith({ probe: stub.fetch })
    const data = expectOk(await run(tool, { port: 9999 }))
    expect((data.key['scan'] as Record<string, unknown>)['status']).toBe('skipped')
    // 下界：真的探了那一个端口（否则「探不到」也是空转）。
    expect(stub.urls).toEqual(['http://127.0.0.1:9999/'])
    expect(data.verdict).toContain('the port you passed could not be probed')
    expect(data.verdict).not.toContain('were found')
    expect(data.verdict).toContain('unknown rather than absent')
  })

  it('扫到了、但零监听 ⇒ 说「没找到」，不说「每个探测都失败了」（0 次探测）', async () => {
    // 空 stdout + 退出码 0 = 可信的「一个监听都没有」⇒ `scanned` + 零候选。
    // 旧文案这时印的是「0 listening port(s) were found but every probe failed」——
    // 一次探测都没发生，「every probe failed」是空话。
    const stub = probeStub(() => ({ status: 200, body: 'hi' }))
    const tool = toolWith({ table: '', probe: stub.fetch })
    const data = expectOk(await run(tool, {}))
    expect((data.key['scan'] as Record<string, unknown>)['status']).toBe('scanned')
    expect((data.key['instances'] as unknown[]).length).toBe(0)
    // 下界：零候选 ⇒ 一个请求都不该发（「0 次探测」是这条判据的事实基础）。
    expect(stub.urls).toEqual([])
    expect(data.verdict).toContain('no listening port was found')
    expect(data.verdict).not.toContain('every probe failed')
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

  it('`unknown` 的**原因**必须印在 L2：分得出「没人听」与「服务在、body 读不出来」', async () => {
    // ⚠️ 这两个都是 `unknown`，但对下一步完全不同：前者去查那个端口上的进程，
    // 后者说明**有服务在答**、只是不像 DSH。只印 `instance: … unknown` 时模型分不出。
    const refused = toolWith({
      table: '3080|111|node|',
      probe: probeStub(() => ({ status: 0, body: '' }), new Error('connect ECONNREFUSED')).fetch,
    })
    const refusedText = renderText(refused, {}, await run(refused, {}))
    expect(refusedText).toContain('detail=')
    expect(refusedText).toContain('ECONNREFUSED')

    const bodyBroken = toolWith({
      table: '3080|111|node|',
      probe: (async () => ({
        status: 401,
        text: async () => {
          throw new Error('body stream broke')
        },
      })) as SignatureFetch,
    })
    const bodyBrokenText = renderText(bodyBroken, {}, await run(bodyBroken, {}))
    expect(bodyBrokenText).toContain('the response body could not be read')
    // 防空转：两者的 L2 必须真的不同（否则「一律印同一句」也会全绿）。
    expect(bodyBrokenText).not.toBe(refusedText)
  })
})

describe(`${LIST_INSTANCES_TOOL} · 接线：判据走完整入口`, () => {
  it('三值结论真的经 `execute` 走到渲染里（不是只测一个内部函数）', async () => {
    // ⚠️ **必须钉住平台**（活跃坑 25）：socket 表是按**当前平台**解析的，而这条喂的是
    // win32 形状的文本。不钉 ⇒ 本机（Windows）按 win32 解析得绿，CI（ubuntu）按 `ss`
    // 解析同一段文本得到 0 行 ⇒ `unavailable` ⇒ **本机绿、CI 红**（本 PR 首次推送真踩）。
    await withPlatform('win32', async () => {
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
      expect(renderText(other, {}, await run(other, {}))).toContain(
        'instance: 127.0.0.1:3080 other',
      )
      expect(renderText(other, {}, await run(other, {}))).not.toContain(
        'instance: 127.0.0.1:3080 dsh',
      )
    })
  })
})

describe(`${LIST_INSTANCES_TOOL} · scan 的三态（scanned / skipped / unavailable）`, () => {
  it('没给 port：真读 socket 表 ⇒ `scanned`，并逐个探', async () => {
    // 同上：喂的是 win32 形状的表，所以平台必须显式钉住（坑 25）。
    await withPlatform('win32', async () => {
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
      expect(instances.map((item) => item['authority'])).toEqual([
        '127.0.0.1:3080',
        '127.0.0.1:4000',
      ])
      expect(instances.map((item) => item['verdict'])).toEqual(['dsh', 'other'])
    })
  })

  // ⚠️ **用例超时要放宽到断言之上**：旧实现会耗掉 ~13 s，若用例自己在 5 s（vitest 默认）
  // 就被掐死，那这条判据就只是「红了」，**没断言到根因**（坑 37 的形状：变红了但没测到东西）。
  // 放宽之后，红/绿由下面那句 `elapsed < 6000` 决定。
  it(
    '⚠️ 挂住的候选**不许让整次调用回不来**（每条探测独立上限 + 有界并发）',
    { timeout: 25_000 },
    async () => {
      // 真机分布（2026-10-14 实测）：37 个回环监听端口里 **9 个**「接受连接但永不回话」
      // （1042 / 8588 / 8590 / 9012 / 14013 / 14016 / 14019 / 14022 / 14023）。
      //
      // 原写法「串行 + 每条拿 `budgetFor(budget, deadline)`（剩余总预算）」的真机症状是
      // **整次调用回不来**（观察到的就是 15 s 传输超时），因为第一个挂住的端口把剩余预算吃光。
      //
      // ⚠️ 所以判据要断言的**是「回得来」**（耗时），而不是「后面的候选还在」——
      // 后者在小预算下即使旧实现也成立（第一跳耗掉 1 s，剩下的仍够探第二个），
      // 拿它当判据会**假绿**（本判据的第一版就是这么写的，变异跑出来是绿的）。
      const stub: SignatureFetch = (url, init) =>
        url.includes('5000')
          ? Promise.resolve({ status: 401, text: () => Promise.resolve(DSH_UNAUTHORIZED_BODY) })
          : new Promise((_resolve, reject) => {
              init.signal.addEventListener('abort', () => {
                reject(new Error('transport-timeout'))
              })
            })

      // 三个候选：两个挂住、一个答签名。真机上的比例比这更糟（9/37 挂）。
      const table = ['3080|111|node|', '4000|222|other|', '5000|333|node|'].join('\r\n')
      const tool = toolWith({ table, probe: stub })

      const started = Date.now()
      const data = expectOk(await run(tool, {}))
      const elapsed = Date.now() - started

      // ① 三个都探了、顺序不变（并发也要保序）。
      const instances = data.key['instances'] as Record<string, unknown>[]
      expect(instances.map((item) => item['authority'])).toEqual([
        '127.0.0.1:3080',
        '127.0.0.1:4000',
        '127.0.0.1:5000',
      ])
      // ② 挂住的两个如实是 `unknown`（不是 other、更不是「没有」），答话的那个被认领。
      expect(instances.map((item) => item['verdict'])).toEqual(['unknown', 'unknown', 'dsh'])

      // ③ **根因事实**：有 2 个挂住的候选时，整次调用仍必须在**远小于预算**的时间里回来。
      //    修好的实现：一波并发、每条 2 s 上限 ⇒ ~2 s。
      //    旧实现：串行，第一个就吃掉 ~13 s ⇒ 必然越过这个界（真机上就是传输超时）。
      expect(elapsed).toBeLessThan(6000)
    },
  )

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

describe(`${LIST_INSTANCES_TOOL} · win32 兜底：Get-NetTCPConnection 不可用时退到 netstat -ano`, () => {
  // ⚠️ 这一族的判据**必须**用 `withPlatform('win32', …)` 把「构造 + 执行」整段包住
  // （坑 25 的隐蔽变体：只包构造、让 `execute` 落在平台恢复之后 = 等于没包）。
  // 本机就是 Windows，所以**本机全绿推不出 CI 绿** —— linux 模拟那一轮才是另一半证据。

  /** Windows `netstat -ano` 的真实输出形状（真机摘录，双栈 + UDP + 非监听态混在里面）。 */
  function windowsNetstatTable(): string {
    return [
      '',
      'Active Connections',
      '',
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:3080            0.0.0.0:0              LISTENING       111',
      '  TCP    [::]:3080               [::]:0                 LISTENING       111',
      '  TCP    127.0.0.1:4000          0.0.0.0:0              LISTENING       222',
      '  TCP    10.0.0.5:5231           10.0.0.8:443            ESTABLISHED     333',
      '  UDP    0.0.0.0:500            *:*                                    4600',
      '',
    ].join('\r\n')
  }

  it('方案里有两档：PowerShell 在前，`netstat -ano` 在后（顺序即优先级）', () => {
    const attempts = listenerScanAttempts('win32')

    expect(attempts.map((attempt) => attempt.command)).toEqual([
      'powershell.exe',
      WINDOWS_FALLBACK_COMMAND,
    ])
    expect(attempts[1]?.args).toEqual(['-ano'])
    // 两档的解析器**不同**：第一档吃 `port|pid|name|startedAt`，第二档吃 Windows 的 socket 表。
    // 写成同一个解析器就会出现「PowerShell 的表被 netstat 解析器读成 0 行」这种静默少列。
    expect(attempts[0]?.parse(winTable()).candidates).toHaveLength(2)
    expect(attempts[1]?.parse(windowsNetstatTable()).candidates).toHaveLength(3)
  })

  it('Windows 的行认得出来（状态在第 4 列、**末列是 pid**）⇒ 端口与 pid 都拿到', () => {
    const parsed = parseNetstatListeners(windowsNetstatTable())

    // 3 条 LISTENING 行（双栈的 3080 各一条 + 4000）。ESTABLISHED / UDP / `Active Connections` 都不认。
    // rows = 1 行表头 + 3 行监听行。
    expect(parsed.rows).toBe(4)
    expect(parsed.candidates).toEqual([
      { port: 3080, pid: 111 },
      { port: 3080, pid: 111 },
      { port: 4000, pid: 222 },
    ])
    // `-o` 这一档读得到 pid ⇒ 不计入 unidentified；读不到的是**进程名与启动时间**，
    // 所以候选里**不留** `(unknown)` 之类的占位串（那会读成「名字真叫 (unknown)」）。
    expect(parsed.unidentified).toBe(0)
    expect(parsed.candidates.every((item) => item.processName === undefined)).toBe(true)
  })

  it('`[::]:port` 与 `0.0.0.0:port` 两种写法都命中（IPv6 字面量的冒号不该把匹配带偏）', () => {
    const onlyV6 = parseNetstatListeners(
      '  Proto  Local Address          Foreign Address        State           PID\r\n' +
        '  TCP    [::]:3080               [::]:0                 LISTENING       111\r\n',
    )
    const onlyV4 = parseNetstatListeners(
      '  Proto  Local Address          Foreign Address        State           PID\r\n' +
        '  TCP    0.0.0.0:3080            0.0.0.0:0              LISTENING       111\r\n',
    )

    expect(onlyV6.candidates).toEqual([{ port: 3080, pid: 111 }])
    expect(onlyV4.candidates).toEqual([{ port: 3080, pid: 111 }])
  })

  it('⚠️ 对端地址里的端口**不许**被当成监听端口（只取本地地址那一列）', () => {
    // 这条是「扫全行找 :port」那个写法的否证：Windows 的对端是 `10.0.0.8:443`，
    // 换成一条对端恰好占着目标端口的行，扫全行的写法就会报出一个根本不监听的端口。
    const parsed = parseNetstatListeners(
      '  Proto  Local Address          Foreign Address        State           PID\r\n' +
        '  TCP    0.0.0.0:22              10.0.0.8:3080            LISTENING       999\r\n',
    )

    expect(parsed.rows).toBe(2)
    expect(parsed.candidates).toEqual([{ port: 22, pid: 999 }])
  })

  it('漏了 `-o`（`netstat -an`，没有 pid 那一列）⇒ 端口仍在、记 unidentified（四态不许塌）', () => {
    const parsed = parseNetstatListeners(
      '  Proto  Local Address          Foreign Address        State\r\n' +
        '  TCP    0.0.0.0:3080            0.0.0.0:0              LISTENING\r\n',
    )

    // 「知道有东西在听、读不到是谁」不是「没人听」——
    // 压成「没人听」就是本仓反复记的那一族反向结论。
    expect(parsed.candidates).toEqual([{ port: 3080 }])
    expect(parsed.unidentified).toBe(1)
    expect(parsed.rows).toBe(2)
  })

  it('**darwin 那张表的行为一个字没变**（`-ano` 这一档不许把原判据吃掉）', () => {
    const darwin = [
      'Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)',
      'tcp4       0      0  127.0.0.1.3080         *.*                    LISTEN',
      'tcp6       0      0  ::1.4000               *.*                    LISTEN',
    ].join('\r\n')

    const parsed = parseNetstatListeners(darwin)

    // darwin 的 `netstat` 不给 pid ⇒ 两档里**只有**这一档计入 unidentified。
    expect(parsed.candidates).toEqual([{ port: 3080 }, { port: 4000 }])
    expect(parsed.unidentified).toBe(2)
    expect(parsed.rows).toBe(3)
    // 反向也钉住：Windows 的行**不许**混进 darwin 的判据（状态值差一个 `ING`）。
    expect(
      parseNetstatListeners(windowsNetstatTable()).candidates.every((c) => c.pid !== undefined),
    ).toBe(true)
  })

  it('主命令成功 ⇒ **兜底一次都不跑**（白跑一条只是白花一次进程预算）', async () => {
    await withPlatform('win32', async () => {
      const { spawn, calls } = recordingSpawn(() => cmdResult({ stdout: winTable() }))

      const scan = await listListenersWith(spawn)

      expect(scan.probed).toBe(true)
      expect(scan.candidates.map((item) => item.port)).toEqual([3080, 4000])
      expect(calls.map((call) => call.command)).toEqual(['powershell.exe'])
    })
  })

  it('主命令不可用（起不了进程 / 非零退出）⇒ 走兜底且**结果可用**', async () => {
    await withPlatform('win32', async () => {
      const spawnError = recordingSpawn((options) =>
        options.command === 'powershell.exe'
          ? cmdResult({ code: null, spawnError: 'spawn: ENOENT' })
          : cmdResult({ stdout: windowsNetstatTable() }),
      )
      const nonZero = recordingSpawn((options) =>
        options.command === 'powershell.exe'
          ? cmdResult({ code: 1, stderr: 'The term Get-NetTCPConnection is not recognized' })
          : cmdResult({ stdout: windowsNetstatTable() }),
      )

      const first = await listListenersWith(spawnError.spawn)
      const second = await listListenersWith(nonZero.spawn)

      for (const scan of [first, second]) {
        expect(scan.probed).toBe(true)
        // 根因事实：兜底看得见「有人在听」——那正是原缺口把结论说反的地方。
        expect(scan.candidates.map((item) => item.port)).toEqual([3080, 4000])
        expect(scan.unidentified).toBe(0)
      }
      // 两档都真被跑到过（不是「第一条失败就放弃」）。
      expect(spawnError.calls.map((call) => call.command)).toEqual([
        'powershell.exe',
        WINDOWS_FALLBACK_COMMAND,
      ])
      expect(nonZero.calls.map((call) => call.command)).toEqual([
        'powershell.exe',
        WINDOWS_FALLBACK_COMMAND,
      ])
    })
  })

  it('主命令读得出表（只是端口不是 3080）⇒ 第一档就可信，兜底**不跑**', async () => {
    await withPlatform('win32', async () => {
      // 真机上最常见的情形：PowerShell 正常返回表，只是列出的端口都不是目标。
      const { spawn, calls } = recordingSpawn(() =>
        cmdResult({ stdout: ['49724|1|node|', '4000|2|node|'].join('\r\n') }),
      )

      const scan = await listListenersWith(spawn)

      // 「列全部」**没有**目标端口这个概念：这一档读懂了就是读懂了 ⇒ 直接用它。
      expect(calls.map((call) => call.command)).toEqual(['powershell.exe'])
      expect(scan.probed).toBe(true)
      expect(scan.candidates.map((item) => item.port)).toEqual([49724, 4000])
    })
  })

  it('两档都不可用 ⇒ `probed=false`，**不是**「没人听」（三值不许塌成两值）', async () => {
    await withPlatform('win32', async () => {
      const { spawn, calls } = recordingSpawn(() =>
        cmdResult({ code: null, spawnError: 'spawn: ENOENT' }),
      )

      const scan = await listListenersWith(spawn)

      expect(calls).toHaveLength(2)
      expect(scan.probed).toBe(false)
      expect(scan.candidates).toEqual([])
      expect(scan.unidentified).toBe(0)
      expect(scan.detail.startsWith('win32:')).toBe(true)
    })
  })

  it('兜底这一档到**工具层**：PowerShell 缺模块时 `dsh_list_instances` 仍能认领到 DSH', async () => {
    // 这条是本缺口的**根因断言**（坑 37 的纪律：断的是事实，不是症状）：
    // 改前这里会是 `unavailable` + 「no DSH host was found」——而 3080 上的宿主正在跑。
    await withPlatform('win32', async () => {
      const spawn = recordingSpawn((options) =>
        options.command === 'powershell.exe'
          ? cmdResult({ code: 1, stderr: 'Get-NetTCPConnection: not recognized' })
          : cmdResult({ stdout: windowsNetstatTable() }),
      )
      const tool = createListInstancesTool({
        ...depsFor(configFor('C:\\fake-home'), { spawn: spawn.spawn }),
        signatureFetch: probeStub((url) =>
          url.includes('3080')
            ? { status: 401, body: DSH_UNAUTHORIZED_BODY }
            : { status: 200, body: 'hi' },
        ).fetch,
      })

      const data = expectOk(await run(tool, {}))

      expect((data.key['scan'] as Record<string, unknown>)['status']).toBe('scanned')
      const instances = data.key['instances'] as Record<string, unknown>[]
      expect(instances.map((item) => item['authority'])).toEqual([
        '127.0.0.1:3080',
        '127.0.0.1:4000',
      ])
      expect(instances.map((item) => item['verdict'])).toEqual(['dsh', 'other'])
      expect(data.verdict).toContain('found 1 DSH host')
      expect(data.verdict).not.toContain('no DSH host was found')
    })
  })

  it('兜底这一档的候选也带 pid（`-o` 比 darwin 那一档多一样，D′ 认领时用得上）', async () => {
    await withPlatform('win32', async () => {
      const spawn = recordingSpawn((options) =>
        options.command === 'powershell.exe'
          ? cmdResult({ code: null, spawnError: 'spawn: ENOENT' })
          : cmdResult({ stdout: windowsNetstatTable() }),
      )
      const tool = createListInstancesTool({
        ...depsFor(configFor('C:\\fake-home'), { spawn: spawn.spawn }),
        signatureFetch: probeStub(() => ({ status: 200, body: 'hi' })).fetch,
      })

      const data = expectOk(await run(tool, {}))
      const instances = data.key['instances'] as Record<string, unknown>[]

      expect(instances.map((item) => item['pid'])).toEqual([111, 222])
      // 进程名读不到 ⇒ 键**不出现**（不是 `null`、也不是 `(unknown)` 占位）。
      expect(instances.every((item) => item['processName'] === undefined)).toBe(true)
    })
  })
})

describe(`${LIST_INSTANCES_TOOL} · 有界与取消`, () => {
  it('候选超过上限 ⇒ 只探上限个，并**明说截断了**（不静默丢）', async () => {
    // 喂的仍是 win32 形状（`port|pid|name|startedAt`）⇒ 平台要钉住（坑 25）。
    await withPlatform('win32', async () => {
      const many = Array.from({ length: 60 }, (_, index) => `${String(1000 + index)}|1|node|`)
      const stub = probeStub(() => ({ status: 200, body: 'hi' }))
      const tool = toolWith({ table: many.join('\n'), probe: stub.fetch })
      const data = expectOk(await run(tool, {}))
      const scan = data.key['scan'] as Record<string, unknown>
      expect(scan['truncated']).toBe(true)
      expect((data.key['instances'] as unknown[]).length).toBe(48)
      expect(stub.urls.length).toBe(48)
      // ⚠️ **截断了就绝不许说「没有 DSH」**（真机端到端实测逼出来的：本机 3080 在跑，
      // 而工具当时报的正是 `no DSH host was found` —— 把「没查完」印成「没有」）。
      expect(String(data.verdict)).not.toContain('no DSH host was found')
      expect(String(data.verdict)).toContain('never examined')
    })
  })

  it('⚠️ 双栈重复要**去重**、候选要**按端口升序**（否则真 DSH 会被截断挡在外面）', async () => {
    await withPlatform('win32', async () => {
      // 真机形状（2026-10-14 实测）：`Get-NetTCPConnection` 对双栈监听**同一端口返回两行**
      // （IPv4 + IPv6），且整体是**降序**（49724 → 135）。本机 63 行只有 52 个唯一端口，
      // 而真正在跑的 DSH（3080）排在**下标 58** ⇒ 不去重、不排序时它永远进不了候选，
      // 工具就会报「no DSH host was found」—— 而它此刻正在服务。
      const rows = [
        '49724|1|node|',
        '49724|1|node|', // 双栈重复
        '4000|2|node|',
        '4000|2|node|', // 双栈重复
        '3080|3|node|', // 真 DSH，在原始（降序）顺序里排最后
      ]
      const stub = probeStub((url) =>
        url.includes('3080')
          ? { status: 401, body: DSH_UNAUTHORIZED_BODY }
          : { status: 200, body: 'hi' },
      )
      const tool = toolWith({ table: rows.join('\r\n'), probe: stub.fetch })
      const data = expectOk(await run(tool, {}))
      const instances = data.key['instances'] as Record<string, unknown>[]
      // ① **去重**：5 行 ⇒ 3 个候选（不去重就是 5 个）。
      // ② **升序**：3080 排第一（不排序就是原始降序 49724 → 4000 → 3080）。
      expect(instances.map((item) => item['authority'])).toEqual([
        '127.0.0.1:3080',
        '127.0.0.1:4000',
        '127.0.0.1:49724',
      ])
      // ③ 于是它真的被认领到（这正是这个工具存在的理由）。
      expect(instances.map((item) => item['verdict'])).toEqual(['dsh', 'other', 'other'])
      expect(String(data.verdict)).toContain('found 1 DSH host')
    })
  })

  it('探针抛异常 ⇒ 那个候选是 `unknown`，整次调用**仍然成功**（绝不 throw）', async () => {
    await withPlatform('win32', async () => {
      const tool = toolWith({
        table: winTable(),
        probe: probeStub(() => ({ status: 200, body: '' }), new Error('boom')).fetch,
      })
      const data = expectOk(await run(tool, {}))
      const instances = data.key['instances'] as Record<string, unknown>[]
      expect(instances.map((item) => item['verdict'])).toEqual(['unknown', 'unknown'])
    })
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
    await withPlatform('win32', async () => {
      const tool = toolWith({
        table: '3080|111|node|',
        probe: probeStub(() => ({ status: 401, body: DSH_UNAUTHORIZED_BODY })).fetch,
      })
      const result = (await run(tool, {})) as unknown as Record<string, unknown>
      expect(Object.keys(result).sort()).toEqual(['data', 'nextStep', 'ok'])
      const data = result['data'] as Record<string, unknown>
      expect(Object.keys(data).sort()).toEqual(['audit', 'key', 'verdict'])
    })
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
