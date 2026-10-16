/**
 * `src/lib/restart-fs.ts` 的判据 —— **不依赖真机**（宿主 `fs` 服务用结构替身）。
 *
 * 这一份要钉住的是三件容易写成假绿的事：
 *
 * 1. **三值不许压成两值**：`text` / `absent` / `unreadable` 必须互不相同；
 *    `absent` 只许来自 `FS_NOT_FOUND`，**其余一切错误码**（沙箱拒绝、权限、IO 错）都归 `unreadable`。
 * 2. **服务缺席 ≠ `absent`** —— 那是「不可用」，上层要能据此给结构化失败。
 * 3. **宿主 `fs` 的缝上没有删除** —— `remove` 必须**响亮**拒绝，不许假装删掉了（静默撒谎更坏）。
 *
 * 另有三条「形状」判据：绝不 import `node:fs`、路径字面量不许在本层再写一份、
 * 以及**走完整入口**的接线用例（`planRestart` + 真 port 的写→读回闭环）。
 */
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  createRestartFsPort,
  hostFsUnavailableReason,
  type ContextLike,
  type HostFsLike,
} from '../../src/lib/restart-fs.ts'
import {
  consumeRestartMarker,
  decideRecovery,
  markerState,
  planRestart,
  readRestartMarker,
  restartMarkerPath,
  type LaunchCommand,
  type RestartMarker,
  type RestartPorts,
  type RestartRequest,
} from '../../src/lib/restart.ts'
import { carrierOf } from './helpers.ts'

/** 一次宿主服务调用（记方法名与实参）。 */
interface HostCall {
  method: string
  args: unknown[]
}

/** 宿主 `fs` 的结构替身。 */
interface FakeHostFs {
  service: HostFsLike
  calls: HostCall[]
  /** 已写入的内容，键是 `resolve` 给出的 targetKey。 */
  store: Map<string, string>
  /** 预置一个文件（模拟「已经在那儿」）。 */
  seed(path: string, text: string): void
}

/** 造一个宿主 `fs` 替身：写进内存、读回内存，并按配置抛错。 */
function makeHostFs(
  options: {
    /** 这些路径的读抛 `FS_NOT_FOUND`（= 文件不在）。 */
    absent?: string[]
    /** 路径 → 错误码：读这些路径时抛**别的**错误（沙箱拒绝 / 权限 / IO）。 */
    readErrors?: Record<string, string>
    /** 路径 → 错误码：`resolve` 就抛。 */
    resolveErrors?: Record<string, string>
    /** 这些路径的 `writeText` 抛 `FS_NOT_OBSERVED`（模拟「要求先观察」的后端）。 */
    notObserved?: string[]
    /** 为真时 `FS_NOT_OBSERVED` **每次都抛**（读也救不了）——用来证明不许静默成功。 */
    alwaysNotObserved?: boolean
  } = {},
): FakeHostFs {
  const calls: HostCall[] = []
  const store = new Map<string, string>()
  const key = (target: unknown): string =>
    typeof target === 'object' && target !== null && 'targetKey' in target
      ? String((target as { targetKey: unknown }).targetKey)
      : String(target)
  const service: HostFsLike = {
    resolve: async (path) => {
      calls.push({ method: 'resolve', args: [path] })
      const code = options.resolveErrors?.[path]
      if (code !== undefined) throw Object.assign(new Error(`resolve failed: ${path}`), { code })
      return { targetKey: path, displayPath: path }
    },
    readText: async (target) => {
      calls.push({ method: 'readText', args: [key(target)] })
      const path = key(target)
      const stored = store.get(path)
      if (stored !== undefined) return stored
      const code = options.readErrors?.[path] ?? 'FS_NOT_FOUND'
      throw Object.assign(new Error(`cannot read "${path}"`), { code })
    },
    writeText: async (target, content, expected, signal, sandboxPolicy) => {
      const path = key(target)
      calls.push({
        method: 'writeText',
        args: [path, content, expected, signal, sandboxPolicy],
      })
      // 「要求先观察」的后端：头一次（或每一次）拒写。
      const demandsObservation =
        options.alwaysNotObserved === true || options.notObserved?.includes(path) === true
      const seen = calls.filter(
        (call) => call.method === 'writeText' && call.args[0] === path,
      ).length
      const observed = calls.some((call) => call.method === 'readText' && call.args[0] === path)
      if (demandsObservation && (options.alwaysNotObserved === true || !observed || seen === 1)) {
        throw Object.assign(
          new Error(`cannot overwrite existing "${path}" without reading it first`),
          {
            code: 'FS_NOT_OBSERVED',
          },
        )
      }
      store.set(path, content)
      return { operation: 'create' }
    },
  }
  return { service, calls, store, seed: (path, text) => store.set(path, text) }
}

/** 一个只有 `fs` 的上下文替身。 */
function ctxWith(service: unknown): ContextLike {
  return { get: (name) => (name === 'fs' ? service : undefined) }
}

/** 造一份合法的 marker（消费用例用）。 */
function markerForTest(): RestartMarker {
  return {
    version: 1,
    reason: 'a restart is required',
    at: '2026-10-14T06:00:00.000Z',
    sessions: ['session-a'],
    state: 'armed',
    trace: ['restart-loop=pass'],
  }
}

/** 宿主 `fs` 服务不可用时：`ctx.get` 直接没有。 */
const NO_GETTER: ContextLike = {}

const HOME = 'C:/dsh-home'
const LAUNCH: LaunchCommand = { command: 'node', args: ['bin.js', 'web'], cwd: 'C:/repo' }
const NOW = Date.UTC(2026, 9, 14, 6, 0, 0)

/** 四道闸全绿的其它端口（fs 单独给）。 */
function portsWith(fs: RestartPorts['fs']): RestartPorts {
  return {
    fs,
    restartHistory: async () => ({ known: true, value: [] }),
    busySessions: async () => ({ known: true, value: [] }),
    bundles: async () => ({ known: true, value: ['dsh-plugin-debugging'] }),
    launchCommand: async () => ({ known: true, value: LAUNCH }),
    now: () => NOW,
  }
}

const REQUEST: RestartRequest = {
  dshHome: HOME,
  reason: 'the plugin code changed and only a restart picks it up',
  callingSession: 'aaaa-1111',
  force: false,
  dryRun: false,
  // 闸④ 的第一问（载体）：本文件测的是 **fs 端口**，所以显式给「有回归路线」那一格。
  carrier: carrierOf('cli', 'win32'),
}

describe('lib/restart-fs · 三值：text / absent / unreadable 互不相同', () => {
  it('`FS_NOT_FOUND` 才落 absent；别的错误码一律 unreadable，且把原码带出来', async () => {
    const host = makeHostFs({
      absent: ['C:/dsh-home/dsh-plugin-debugging/restart/marker.json'],
      readErrors: { 'C:/dsh-home/dsh-plugin-debugging/restart/denied.json': 'FS_SANDBOX_DENIED' },
    })
    const port = createRestartFsPort(ctxWith(host.service))

    // ① 有内容
    host.seed('C:/dsh-home/dsh-plugin-debugging/restart/marker.json', '{"v":1}')
    const present = await port.read('C:/dsh-home/dsh-plugin-debugging/restart/marker.json')
    expect(present).toEqual({ status: 'text', text: '{"v":1}' })

    // ② 文件不在（FS_NOT_FOUND）
    const absent = await port.read('C:/dsh-home/dsh-plugin-debugging/restart/other.json')
    expect(absent).toEqual({ status: 'absent' })

    // ③ 读失败（沙箱拒绝）—— **不是** absent
    const denied = await port.read('C:/dsh-home/dsh-plugin-debugging/restart/denied.json')
    expect(denied.status).toBe('unreadable')
    if (denied.status !== 'unreadable') throw new Error('期望 unreadable')
    expect(denied.reason).toContain('FS_SANDBOX_DENIED')

    // 防空转：三者必须**互不相同**（否则「三值」只是同一格的三个名字）。
    const readAgain = await port.read('C:/dsh-home/dsh-plugin-debugging/restart/marker.json')
    const absentAgain = await port.read('C:/dsh-home/dsh-plugin-debugging/restart/other.json')
    const deniedAgain = await port.read('C:/dsh-home/dsh-plugin-debugging/restart/denied.json')
    expect(JSON.stringify(readAgain)).not.toBe(JSON.stringify(absentAgain))
    expect(JSON.stringify(absentAgain)).not.toBe(JSON.stringify(deniedAgain))
    expect(JSON.stringify(readAgain)).not.toBe(JSON.stringify(deniedAgain))
  })

  it('`resolve` 自己抛（例如取消）也算读不到，不许落 absent', async () => {
    const host = makeHostFs({ resolveErrors: { 'C:/x.json': 'FS_ABORTED' } })
    const port = createRestartFsPort(ctxWith(host.service))
    const result = await port.read('C:/x.json')
    expect(result.status).toBe('unreadable')
    if (result.status !== 'unreadable') throw new Error('期望 unreadable')
    expect(result.reason).toContain('FS_ABORTED')
  })
})

describe('lib/restart-fs · 服务缺席 = 不可用，不是「没有 marker」', () => {
  it('`ctx.get("fs")` 拿不到 ⇒ read 报 unreadable（**不是** absent），且给出可判定的原因', async () => {
    const port = createRestartFsPort(ctxWith(undefined))
    const result = await port.read('C:/dsh-home/dsh-plugin-debugging/restart/marker.json')
    expect(result.status).toBe('unreadable')
    expect(result.status).not.toBe('absent')
    if (result.status !== 'unreadable') throw new Error('期望 unreadable')
    expect(result.reason).toContain('not registered')

    // 上层据此**早失败**的口子：非空 = 一定读不到。
    expect(hostFsUnavailableReason(ctxWith(undefined))).toBeDefined()
    // 反空转：服务在场且形状对 ⇒ 原因为 undefined（否则上面那条是恒真的）。
    const host = makeHostFs()
    expect(hostFsUnavailableReason(ctxWith(host.service))).toBeUndefined()
  })

  it('服务在、但形状不对（缺方法）同样算不可用 —— 不猜', async () => {
    const partial = { resolve: async () => ({}) }
    const reason = hostFsUnavailableReason(ctxWith(partial))
    expect(reason).toBeDefined()
    expect(reason).toContain('readText')
    const port = createRestartFsPort(ctxWith(partial))
    expect((await port.read('C:/x.json')).status).toBe('unreadable')
  })

  it('连 `ctx.get` 都没有的上下文 ⇒ 不可用，不抛', async () => {
    expect(hostFsUnavailableReason(NO_GETTER)).toBeDefined()
    const port = createRestartFsPort(NO_GETTER)
    expect((await port.read('C:/x.json')).status).toBe('unreadable')
  })

  it('写失败**抛**（上层收敛成结构化失败），绝不静默吞掉', async () => {
    const port = createRestartFsPort(ctxWith(undefined))
    await expect(port.write('C:/x.json', 'body')).rejects.toThrow(/fs service/im)
  })
})

describe('lib/restart-fs · 端口里没有删除（宿主缝上没有这个能力）', () => {
  it('本层**一次都不调**删除类方法：给替身装上它们，再断言零调用', async () => {
    // 判据只断言**本层的行为**。**宿主「没有删除」这条事实由真机探针作证**（`task-31`），
    // 不靠这个夹具 —— 拿自己的替身当宿主的证据正是本仓点名的假绿形状。
    const host = makeHostFs()
    const attempted: string[] = []
    const withDelete = host.service as unknown as Record<string, unknown>
    for (const method of ['delete', 'remove', 'unlink', 'rm', 'rmdir']) {
      withDelete[method] = async () => {
        attempted.push(method)
      }
    }
    const port = createRestartFsPort(ctxWith(withDelete))
    const path = 'C:/dsh-home/dsh-plugin-debugging/restart/marker.json'
    // 「消费」走的是写、不是删 —— 走一遍完整读改写。
    await port.write(path, 'armed')
    await port.read(path)
    await consumeRestartMarker(port, HOME, markerForTest(), NOW)

    expect(attempted, '本层调了删除方法 —— 宿主缝上没有它，能调通也不该调').toEqual([])
    // 而且端口上**根本没有** remove 这个成员（形状上就不可做）。
    expect('remove' in port).toBe(false)
    expect(Object.keys(port).sort()).toEqual(['read', 'write'])
  })
})

describe('lib/restart-fs · FS_NOT_OBSERVED：读一次再重试，重试仍失败就抛', () => {
  it('后端要求先观察 ⇒ 先读一次、重试成功（计数断言：读 1 次、写 2 次）', async () => {
    const path = 'C:/dsh-home/dsh-plugin-debugging/restart/marker.json'
    const host = makeHostFs({ notObserved: [path] })
    host.seed(path, 'old')
    const port = createRestartFsPort(ctxWith(host.service))

    await port.write(path, 'new')

    const reads = host.calls.filter((call) => call.method === 'readText')
    const writes = host.calls.filter((call) => call.method === 'writeText')
    expect(reads, '没有先读一次 —— FS_NOT_OBSERVED 没被处理').toHaveLength(1)
    expect(writes, '没有重试写').toHaveLength(2)
    expect(host.store.get(path)).toBe('new')
    // 本层传的 expected 始终是 undefined（无条件覆盖，不引 createIfAbsent）。
    expect(writes.every((call) => call.args[2] === undefined)).toBe(true)
  })

  it('读也救不了 ⇒ **原样抛出**，绝不静默当成写成功', async () => {
    const path = 'C:/dsh-home/dsh-plugin-debugging/restart/marker.json'
    const host = makeHostFs({ alwaysNotObserved: true })
    host.seed(path, 'old')
    const port = createRestartFsPort(ctxWith(host.service))

    await expect(port.write(path, 'new')).rejects.toThrow(
      /without reading it first|FS_NOT_OBSERVED/im,
    )
    // 根因事实：内容**没被改写**（不是「没报错所以成功」）。
    expect(host.store.get(path)).toBe('old')
  })
})

describe('lib/restart-fs · 沙箱策略与调用面', () => {
  it('`sandboxPolicy` 原样透传给 `writeText` 的第 5 个实参；省略时传 undefined', async () => {
    const host = makeHostFs()
    const policy = { mode: 'danger-full-access', workspaceRoot: 'C:/repo' }
    const port = createRestartFsPort(ctxWith(host.service), { sandboxPolicy: policy })
    await port.write('C:/dsh-home/dsh-plugin-debugging/restart/marker.json', 'body')

    const write = host.calls.find((call) => call.method === 'writeText')
    expect(write, '一次 writeText 都没发生 —— 替身没接上').toBeDefined()
    expect(write?.args[4]).toBe(policy)

    const plain = makeHostFs()
    await createRestartFsPort(ctxWith(plain.service)).write('C:/x.json', 'body')
    expect(plain.calls.find((call) => call.method === 'writeText')?.args[4]).toBeUndefined()
  })

  it('IO 只经宿主 fs：序列是 resolve → readText / resolve → writeText，**且不枚举目录**', async () => {
    const host = makeHostFs()
    const port = createRestartFsPort(ctxWith(host.service))
    await port.read('C:/dsh-home/dsh-plugin-debugging/restart/marker.json')
    await port.write('C:/dsh-home/dsh-plugin-debugging/restart/marker.json', 'body')
    expect(host.calls.map((call) => call.method)).toEqual([
      'resolve',
      'readText',
      'resolve',
      'writeText',
    ])
    // 别去枚举目录（本仓刚有成员在 `$DSH_HOME/dsh-plugin-debugging` 上递归扫描挂死过）。
    expect(host.calls.some((call) => call.method === 'listDir')).toBe(false)
  })
})

describe('lib/restart-fs · 接线：走完整入口 planRestart 的写→读回', () => {
  it('四道闸全绿 ⇒ marker 落到宿主 fs 上，且能用 readRestartMarker + decideRecovery 读回来', async () => {
    const host = makeHostFs()
    const port = createRestartFsPort(ctxWith(host.service))
    const plan = await planRestart(REQUEST, portsWith(port))
    expect(plan.kind).toBe('ready')
    if (plan.kind !== 'ready') throw new Error(`期望 ready，实际 ${JSON.stringify(plan)}`)
    expect(plan.markerWritten).toBe(true)

    // 写真的发生在**宿主 fs**上（不是返回值里编出来的）。
    const path = restartMarkerPath(HOME)
    expect(host.store.has(path)).toBe(true)
    expect(plan.markerPath).toBe(path)

    // 读回闭环：适配器 → restart.ts 的解析 → 恢复判定。
    const read = await readRestartMarker(port, HOME)
    expect(read.status).toBe('ok')
    const decision = decideRecovery(read)
    expect(decision.action).toBe('recover')
    if (decision.action !== 'recover') throw new Error('期望 recover')
    expect(decision.sessions).toEqual(plan.marker.sessions)

    // 消费闭环（`task-32`）：写 armed → 消费 → 再判 ⇒ none(consumed)。
    const consumed = await consumeRestartMarker(port, HOME, plan.marker, NOW)
    expect(markerState(consumed)).toBe('consumed')
    const after = decideRecovery(await readRestartMarker(port, HOME))
    expect(after.action).toBe('none')
    if (after.action !== 'none') throw new Error('期望 none')
    expect(after.reason).toBe('consumed')
  })

  it('服务缺席时走完整入口：marker 写不出去 ⇒ 结构化失败，且**绝不**报成「没写过」', async () => {
    const plan = await planRestart(REQUEST, portsWith(createRestartFsPort(ctxWith(undefined))))
    expect(plan.kind).toBe('failed')
    if (plan.kind !== 'failed') throw new Error('期望 failed')
    expect(plan.verdict).toContain('not registered')
    // 而且「读」那边也不是 absent —— 否则恢复会静默跳过。
    const read = await readRestartMarker(createRestartFsPort(ctxWith(undefined)), HOME)
    expect(read.status).toBe('unreadable')
  })
})

describe('lib/restart-fs · 形状自证', () => {
  const moduleSource = readFileSync(new URL('../../src/lib/restart-fs.ts', import.meta.url), 'utf8')
  const portSource = readFileSync(new URL('../../src/lib/restart.ts', import.meta.url), 'utf8')

  it('两个模块都不 import node:fs（那会直接踩 B10，与路径无关）', () => {
    const pattern = /\bfrom\s+['"]node:fs/u
    expect(pattern.test(moduleSource), 'restart-fs.ts import 了 node:fs').toBe(false)
    expect(pattern.test(portSource), 'restart.ts import 了 node:fs').toBe(false)
    // 自证正则不是恒真。
    expect(pattern.test("import { readFile } from 'node:fs/promises'")).toBe(true)
  })

  it('路径字面量只有一处：本层不许再写一份命名空间', () => {
    expect(moduleSource).not.toContain('dsh-plugin-debugging')
    expect(moduleSource).not.toContain('marker.json')
    // 而落点那一行在 restart.ts 里恰好出现一次。
    const matches = portSource.match(
      /join\(dshHome,\s*'([^']+)',\s*'restart',\s*'marker\.json'\)/gu,
    )
    expect(matches, 'restart.ts 里找不到（或找到了不止一处）落点字面量').toHaveLength(1)
  })
})
