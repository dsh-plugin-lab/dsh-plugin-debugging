/**
 * `dsh_hot_reload` 的红线 —— **不依赖真机**，全部用注入端口。
 *
 * 这一份的重点不是「跑通了」，而是把 §6.6 真机实验A 坐实的那几条**承诺**变成可回归的判据：
 *
 * - **import 期失败时旧 fiber 从未被碰** —— 断言 `disposeOld` / `mountFresh` **一次都没被调用**。
 *   这是整个算法最要紧的一条：真机实验A 的步骤序列里那条路径**根本没有 dispose-old**。
 * - **apply 期失败要回滚** —— 断言 `removeFresh` + `remountOld` 被调用（旧版本**真的**被重新实例化）。
 * - **dryRun 不动树** —— 断言缓存一次没删、fiber 一次没碰。
 * - **T4 的匹配** —— 只比 `entry.id` 是假阴性（真机上 id 是 `include:<x>`、name 是 `file://` URL）。
 *
 * 为什么值得这么细：写侧工具最坏的一种失败是「**树被改坏，而模型以为成功**」。
 * 所以每条分支都要钉住「有没有碰树、碰了什么」。
 */
import { describe, expect, it } from 'vitest'

import {
  backupAndClear,
  bareId,
  collectClosure,
  hotReload,
  matchEntries,
  moduleKeys,
  normalizeKey,
  packageRootOf,
  parseReloadTarget,
  restoreCache,
  kindForReason,
  outcomeToToolResult,
  type ClosurePort,
  type ReloadEntryPort,
  type ReloadHost,
  type ReloadTarget,
} from '../../src/lib/hot-reload.ts'
import {
  createHotReloadTool,
  HOT_RELOAD_TOOL,
  summarizeHotReload as summarizeReloadForTest,
} from '../../src/tools/dsh_hot_reload.ts'
import { TOOL_ERROR_KINDS } from '../../src/lib/errors.ts'
import { configFor, depsFor, execWith, expectFail, expectOk, run, tempDshHome } from './helpers.ts'

const ENTRY_URL = 'file:///repo/pkg-a/lib/index.js'
const DEP_URL = 'file:///repo/pkg-a/lib/dep.js'
const OUTSIDE_URL = 'file:///repo/pkg-a/node_modules/other/lib/index.js'

/** 造一个可控的 entry 端口，并记下每次碰树。 */
function makeEntry(overrides: Partial<ReloadEntryPort> = {}): {
  entry: ReloadEntryPort
  calls: string[]
} {
  const calls: string[] = []
  const entry: ReloadEntryPort = {
    entryId: 'include:pkg-a',
    moduleName: ENTRY_URL,
    hasFiber: true,
    oldFiberCount: 1,
    fiberState: 2,
    reloadable: true,
    disposeOld: async () => {
      calls.push('disposeOld')
    },
    mountFresh: async () => {
      calls.push('mountFresh')
    },
    removeFresh: async () => {
      calls.push('removeFresh')
    },
    remountOld: async () => {
      calls.push('remountOld')
    },
    refresh: async () => {
      calls.push('refresh')
    },
    ...overrides,
  }
  return { entry, calls }
}

/** 造一个可控的缓存端口。 */
function makeCache(
  children: Record<string, string[]> = { [ENTRY_URL]: [DEP_URL] },
  seeded: string[] = [ENTRY_URL, DEP_URL],
): { port: ClosurePort; calls: string[]; has: (url: string) => boolean } {
  const store = new Map<string, unknown>()
  for (const url of seeded) store.set(url, { slot: url })
  const calls: string[] = []
  const port: ClosurePort = {
    get: (url) => store.get(url),
    set: (url, value) => {
      calls.push(`set:${url}`)
      store.set(url, value)
    },
    delete: (url) => {
      calls.push(`delete:${url}`)
      store.delete(url)
    },
    children: async (url) => children[url] ?? [],
  }
  return { port, calls, has: (url) => store.has(url) }
}

/** 造一个宿主端口。 */
function makeHost(
  options: {
    entries?: ReloadEntryPort[]
    cache?: ClosurePort
    internalAvailable?: boolean
    importFresh?: (url: string) => Promise<unknown>
  } = {},
): ReloadHost {
  const entries = options.entries ?? []
  return {
    internalAvailable: () => options.internalAvailable ?? true,
    cache: () => options.cache,
    candidates: () => entries,
    resolveEntryUrl: async (entry) => entry.moduleName,
    importFresh: options.importFresh ?? (async () => ({ plugin: 'fresh' })),
  }
}

const TARGET: ReloadTarget = { kind: 'entryId', value: 'include:pkg-a' }

/** 跑一次（默认非干跑、未取消、预算未到）。 */
async function runReload(
  host: ReloadHost,
  target: ReloadTarget = TARGET,
  overrides: { dryRun?: boolean; signal?: AbortSignal; expired?: () => boolean } = {},
) {
  return hotReload(host, target, {
    dryRun: overrides.dryRun ?? false,
    signal: overrides.signal,
    expired: overrides.expired ?? (() => false),
  })
}

describe('lib/hot-reload · 参数解析（三者择一）', () => {
  it('给一个就定出一个', () => {
    expect(parseReloadTarget({ entryId: 'x' }).target).toEqual({ kind: 'entryId', value: 'x' })
    expect(parseReloadTarget({ module: 'y' }).target).toEqual({ kind: 'module', value: 'y' })
    expect(parseReloadTarget({ serverName: 'z' }).target).toEqual({
      kind: 'serverName',
      value: 'z',
    })
  })

  it('一个都不给 → 结构化失败（不猜）', () => {
    const parsed = parseReloadTarget({})
    expect(parsed.target).toBeUndefined()
    expect(parsed.failure?.reason).toBe('bad-target')
  })

  it('给多于一个 → 结构化失败（不猜哪个是你想要的）', () => {
    const parsed = parseReloadTarget({ entryId: 'x', module: 'y' })
    expect(parsed.target).toBeUndefined()
    expect(parsed.failure?.reason).toBe('bad-target')
  })

  it('空串按「没给」算（模型常把可选参数填成 ""）', () => {
    expect(parseReloadTarget({ entryId: '   ' }).failure?.reason).toBe('bad-target')
    expect(parseReloadTarget({ entryId: '   ' }).target).toBeUndefined()
    expect(parseReloadTarget({ entryId: ' x ' }).target?.value).toBe('x')
  })
})

describe('lib/hot-reload · 匹配（T4：两个字段 + URL 归一）', () => {
  const entry = makeEntry().entry

  it('裸 id 命中（去掉 include: 前缀）', () => {
    expect(matchEntries([entry], { kind: 'entryId', value: 'pkg-a' }).exact).toHaveLength(1)
  })

  it('带全前缀的 id 也命中', () => {
    expect(matchEntries([entry], { kind: 'entryId', value: 'include:pkg-a' }).exact).toHaveLength(1)
  })

  it('用 file:// URL 形式的模块名命中 —— 这是「只比 id 会假阴性」的那一半', () => {
    expect(matchEntries([entry], { kind: 'module', value: ENTRY_URL }).exact).toHaveLength(1)
  })

  it('从 URL 里回推出的包名也命中（用户嘴里的那个名字）', () => {
    // 有 node_modules 边界时，包名能从 URL 回推。
    const installed = 'file:///repo/node_modules/pkg-a/lib/index.js'
    const keys = moduleKeys(installed)
    expect(keys).toContain('pkg-a')
    expect(keys).toContain('index')
    expect(packageRootOf(installed)).toBe('file:///repo/node_modules/pkg-a')

    // 源码树里的 entry（URL 里没有 node_modules 边界）**回推不出包名** ——
    // 这时 `pkg-a` 只能靠 **entryId 字段**命中，这正是 T4「两个字段都要试」的由来。
    expect(moduleKeys(ENTRY_URL)).not.toContain('pkg-a')
    expect(matchEntries([entry], { kind: 'module', value: 'pkg-a' }).exact).toHaveLength(1)
  })

  it('归一化：- / _ / . 等价，且大小写不敏感', () => {
    expect(normalizeKey('Pkg_A.B')).toBe('pkg-a-b')
    const scoped = makeEntry({ entryId: 'include:x', moduleName: 'umetask_http' }).entry
    expect(matchEntries([scoped], { kind: 'module', value: 'umetask-http' }).exact).toHaveLength(1)
  })

  it('serverName 也能当键', () => {
    const mcp = makeEntry({
      entryId: 'include:mcp',
      moduleName: 'mcp-client',
      serverName: 'umetask_http',
    }).entry
    expect(matchEntries([mcp], { kind: 'serverName', value: 'umetask-http' }).exact).toHaveLength(1)
  })

  it('精确命中优先：短子串不会把精确命中挤成歧义', () => {
    const exact = makeEntry({ entryId: 'include:plugin', moduleName: 'a' }).entry
    const noisy = makeEntry({ entryId: 'include:plugin-long', moduleName: 'abc' }).entry
    const outcome = matchEntries([noisy, exact], { kind: 'entryId', value: 'plugin' })
    // 两者都会被子串匹配到，但**精确**只有一个 —— 精确非空时调用方只看 exact。
    expect(outcome.exact).toHaveLength(1)
    expect(outcome.loose).toHaveLength(1)
  })

  it('精确无命中才用子串兜底，且阈值 3 字符', () => {
    const entryLong = makeEntry({ entryId: 'include:my-long-plugin', moduleName: 'x' }).entry
    expect(matchEntries([entryLong], { kind: 'entryId', value: 'long' }).loose).toHaveLength(1)
    // 2 字符不做子串匹配（会匹配到一屏东西）
    expect(matchEntries([entryLong], { kind: 'entryId', value: 'lo' }).loose).toHaveLength(0)
  })

  it('两个 entry 都精确命中时**不猜**（调用方要能看出歧义）', () => {
    const a = makeEntry({ entryId: 'include:dup', moduleName: 'x' }).entry
    const b = makeEntry({ entryId: 'include:dup', moduleName: 'y' }).entry
    expect(matchEntries([a, b], { kind: 'entryId', value: 'dup' }).exact).toHaveLength(2)
  })
})

describe('lib/hot-reload · 闭包与缓存', () => {
  it('只收 entry 自己那个包下的模块，跳过 node_modules 子树', async () => {
    const cache = makeCache({ [ENTRY_URL]: [DEP_URL, OUTSIDE_URL], [DEP_URL]: [] })
    const files = await collectClosure(cache.port, ENTRY_URL)
    expect(files).toContain(ENTRY_URL)
    expect(files).toContain(DEP_URL)
    expect(files).not.toContain(OUTSIDE_URL)
  })

  it('packageRootOf 认 scoped 包名（@scope/pkg 是**一个**包）', () => {
    expect(packageRootOf('file:///r/node_modules/@s/p/lib/i.js')).toBe(
      'file:///r/node_modules/@s/p',
    )
    expect(packageRootOf('file:///r/node_modules/plain/lib/i.js')).toBe(
      'file:///r/node_modules/plain',
    )
    expect(packageRootOf('file:///r/src/index.js')).toBeUndefined()
  })

  it('备份 = 只有真的在缓存里的那些；清完能原样放回', () => {
    const cache = makeCache({}, [ENTRY_URL])
    const backup = backupAndClear(cache.port, [ENTRY_URL, DEP_URL])
    expect(backup.entries).toHaveLength(1)
    expect(cache.has(ENTRY_URL)).toBe(false)
    restoreCache(cache.port, backup)
    expect(cache.has(ENTRY_URL)).toBe(true)
  })
})

describe('lib/hot-reload · 8 步算法', () => {
  it('成功：清缓存 → import → dispose 旧 → 挂新的（顺序即判据）', async () => {
    const { entry, calls } = makeEntry()
    const cache = makeCache()
    const order: string[] = []
    const host = makeHost({
      entries: [entry],
      cache: cache.port,
      importFresh: async () => {
        order.push('import')
        return { plugin: 'fresh' }
      },
    })
    // 把「碰树」的顺序也记下来，才能断言 import 在 dispose 之前。
    entry.disposeOld = async () => {
      order.push('disposeOld')
      calls.push('disposeOld')
    }
    entry.mountFresh = async () => {
      order.push('mountFresh')
      calls.push('mountFresh')
    }

    const outcome = await runReload(host)

    expect(outcome.ok).toBe(true)
    expect(order).toEqual(['import', 'disposeOld', 'mountFresh'])
    if (outcome.ok) {
      expect(outcome.data.modulesCleared).toBe(2)
      expect(outcome.data.rolledBack).toBe(false)
      expect(outcome.data.oldFiberTouched).toBe(true)
      expect(outcome.data.verdict).toContain('swapped=2 modules')
    }
  })

  it('import 期失败：旧 fiber **一次都没被碰**，缓存放回', async () => {
    const { entry, calls } = makeEntry()
    const cache = makeCache()
    // 记住 import 之前缓存是被清过的 —— 失败后必须放回。
    let clearedDuringImport = false
    const host = makeHost({
      entries: [entry],
      cache: cache.port,
      importFresh: async () => {
        clearedDuringImport = !cache.has(ENTRY_URL)
        throw new Error('boom at import time')
      },
    })

    const outcome = await runReload(host)

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.failure.reason).toBe('import-failed')
      expect(outcome.failure.message).toContain('never touched')
      expect(outcome.data?.oldFiberTouched).toBe(false)
      expect(outcome.data?.rolledBack).toBe(false)
    }
    // **核心断言**：树一格没动。
    expect(calls).toEqual([])
    // 而且缓存确实被清过（证明清缓存发生在 import 前），失败后又放回了。
    expect(clearedDuringImport).toBe(true)
    expect(cache.has(ENTRY_URL)).toBe(true)
    expect(cache.has(DEP_URL)).toBe(true)
  })

  it('apply 期失败：回滚被调用，旧版本被**重新实例化**', async () => {
    const { entry, calls } = makeEntry()
    const cache = makeCache()
    const host = makeHost({ entries: [entry], cache: cache.port })
    entry.mountFresh = async () => {
      calls.push('mountFresh')
      throw new Error('boom in apply')
    }

    const outcome = await runReload(host)

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.failure.reason).toBe('apply-failed')
      expect(outcome.data?.rolledBack).toBe(true)
      expect(outcome.data?.oldFiberTouched).toBe(true)
    }
    // 顺序也要对：摘新 → 重挂旧。
    expect(calls).toEqual(['disposeOld', 'mountFresh', 'removeFresh', 'remountOld'])
    expect(cache.has(ENTRY_URL)).toBe(true)
  })

  it('fiber 从未起来（import 期就失败过）：走 refresh，不 dispose', async () => {
    const { entry, calls } = makeEntry({ hasFiber: false, oldFiberCount: 0, fiberState: undefined })
    const host = makeHost({ entries: [entry], cache: makeCache().port })

    const outcome = await runReload(host)

    expect(outcome.ok).toBe(true)
    expect(calls).toEqual(['refresh'])
  })

  it('dryRun：闭包照收，但**缓存一格没删、fiber 一次没碰**', async () => {
    const { entry, calls } = makeEntry()
    const cache = makeCache()
    const host = makeHost({ entries: [entry], cache: cache.port })

    const outcome = await runReload(host, TARGET, { dryRun: true })

    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.data.dryRun).toBe(true)
      expect(outcome.data.moduleCount).toBe(2)
      expect(outcome.data.modulesCleared).toBe(0)
      expect(outcome.data.verdict).toContain('dryRun=true')
    }
    expect(cache.calls).toEqual([])
    expect(calls).toEqual([])
  })

  it('定位不到 → no-match，且**什么都不动**', async () => {
    const cache = makeCache()
    const host = makeHost({ entries: [], cache: cache.port })

    const outcome = await runReload(host)

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.failure.reason).toBe('no-match')
    expect(cache.calls).toEqual([])
  })

  it('多个命中 → ambiguous，且**什么都不动**', async () => {
    const a = makeEntry({ entryId: 'include:dup' })
    const b = makeEntry({ entryId: 'include:dup' })
    const cache = makeCache()
    const host = makeHost({ entries: [a.entry, b.entry], cache: cache.port })

    // 目标要真的指向这两个 entry（否则测的是 no-match，不是歧义）。
    const outcome = await runReload(host, { kind: 'entryId', value: 'dup' })

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.failure.reason).toBe('ambiguous')
    expect(cache.calls).toEqual([])
  })

  it('loader.internal 拿不到 → no-internal（建议重启），不碰树', async () => {
    const { entry, calls } = makeEntry()
    const host = makeHost({ entries: [entry], internalAvailable: false })

    const outcome = await runReload(host)

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.failure.reason).toBe('no-internal')
      expect(outcome.failure.hint).toContain('restart')
    }
    expect(calls).toEqual([])
  })

  it('internal 有但没有 loadCache → no-internal', async () => {
    const { entry, calls } = makeEntry()
    const host = makeHost({ entries: [entry], cache: undefined })

    const outcome = await runReload(host)

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.failure.reason).toBe('no-internal')
    expect(calls).toEqual([])
  })

  it('cordis: 内建 entry 不可热重载 → not-reloadable，不碰树', async () => {
    const { entry, calls } = makeEntry({ moduleName: 'cordis:group', reloadable: false })
    const host = makeHost({ entries: [entry], cache: makeCache().port })

    const outcome = await runReload(host)

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.failure.reason).toBe('not-reloadable')
    expect(calls).toEqual([])
  })

  it('已经被取消 → cancelled，且**在碰树之前**就返回', async () => {
    const { entry, calls } = makeEntry()
    const cache = makeCache()
    const controller = new AbortController()
    controller.abort()
    const host = makeHost({ entries: [entry], cache: cache.port })

    const outcome = await runReload(host, TARGET, { signal: controller.signal })

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.failure.reason).toBe('cancelled')
    expect(calls).toEqual([])
    expect(cache.calls).toEqual([])
  })

  it('预算已耗尽 → timeout，且不碰树', async () => {
    const { entry, calls } = makeEntry()
    const host = makeHost({ entries: [entry], cache: makeCache().port })

    const outcome = await runReload(host, TARGET, { expired: () => true })

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.failure.reason).toBe('timeout')
    expect(calls).toEqual([])
  })

  it('闭包列超过上限时截断，但仍报总数', async () => {
    const many = Array.from({ length: 60 }, (_v, i) => `file:///repo/pkg-a/lib/m${String(i)}.js`)
    const { entry } = makeEntry()
    const cache = makeCache({ [ENTRY_URL]: many })
    const host = makeHost({ entries: [entry], cache: cache.port })

    const outcome = await runReload(host)

    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.data.moduleCount).toBe(61)
      expect(outcome.data.modules).toHaveLength(40)
      expect(outcome.data.modulesTruncated).toBe(true)
    }
  })
})

describe('lib/hot-reload · 失败原因 → 闭枚举 kind', () => {
  it('每种原因都映射到一个**已存在或已加**的 kind', () => {
    const mapping = {
      'bad-target': 'not-found',
      'no-match': 'not-found',
      ambiguous: 'not-found',
      'no-internal': 'not-configured',
      'not-reloadable': 'not-configured',
      'import-failed': 'reload-failed',
      'apply-failed': 'reload-failed',
      cancelled: 'cancelled',
      timeout: 'timeout',
    } as const
    for (const [reason, expected] of Object.entries(mapping)) {
      const kind = kindForReason(reason as never)
      expect(kind).toBe(expected)
      // 映射出来的 kind 必须在闭枚举里 —— 否则 ensureToolResult 会把它判成形状非法。
      expect(TOOL_ERROR_KINDS).toContain(kind)
    }
  })

  it('import-failed 与 apply-failed 都归 reload-failed，而**不是** internal', () => {
    expect(kindForReason('import-failed')).toBe('reload-failed')
    expect(kindForReason('apply-failed')).toBe('reload-failed')
  })
})

describe('lib/hot-reload · 结果 → 工具结果', () => {
  it('成功带上指回只读工具的 nextStep', () => {
    const result = outcomeToToolResult({
      ok: true,
      data: {
        target: TARGET,
        entry: { entryId: 'e', moduleName: 'pkg-a' },
        dryRun: false,
        moduleUrl: ENTRY_URL,
        moduleCount: 1,
        modulesCleared: 1,
        modules: [ENTRY_URL],
        modulesTruncated: false,
        oldFiberTouched: true,
        oldFiberCount: 1,
        oldFiberState: 2,
        newFiberState: 2,
        rolledBack: false,
        verdict: 'v',
        why: 'w',
      },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.nextStep?.tool).toBe('dsh_diagnose_plugin_load')
      expect(result.nextStep?.args).toEqual({ package: 'pkg-a' })
    }
  })

  it('失败也带 nextStep（去核对旧 fiber 还在不在）', () => {
    const result = outcomeToToolResult({
      ok: false,
      failure: { reason: 'import-failed', message: 'm', hint: 'h' },
      data: { entry: { entryId: 'e', moduleName: 'pkg-a' } },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('reload-failed')
      expect(result.nextStep?.tool).toBe('dsh_diagnose_plugin_load')
    }
  })
})

describe('dsh_hot_reload · 工具层', () => {
  /** 造工具 + 依赖。 */
  async function makeTool(host: ReloadHost): Promise<ReturnType<typeof createHotReloadTool>> {
    const dshHome = await tempDshHome()
    return createHotReloadTool({ ...depsFor(configFor(dshHome)), reload: host })
  }

  it('工具名与契约一致', () => {
    expect(HOT_RELOAD_TOOL).toBe('dsh_hot_reload')
  })

  it('成功路径：data 带 entry / 模块数 / 结论', async () => {
    const { entry } = makeEntry()
    const tool = await makeTool(makeHost({ entries: [entry], cache: makeCache().port }))

    const data = expectOk(await run(tool, { entryId: 'pkg-a' }))
    expect((data['entry'] as Record<string, unknown>)['entryId']).toBe('include:pkg-a')
    expect(data['modulesCleared']).toBe(2)
    expect(data['rolledBack']).toBe(false)
    expect(String(data['verdict'])).toContain('swapped=2 modules')
  })

  it('一个目标都不给 → not-found，且不碰宿主', async () => {
    const { entry, calls } = makeEntry()
    const tool = await makeTool(makeHost({ entries: [entry], cache: makeCache().port }))

    const error = expectFail(await run(tool, {}))
    expect(error.kind).toBe('not-found')
    expect(error.message).toContain('no target was given')
    expect(calls).toEqual([])
  })

  it('给两个目标 → not-found（不猜）', async () => {
    const { entry } = makeEntry()
    const tool = await makeTool(makeHost({ entries: [entry], cache: makeCache().port }))

    const error = expectFail(await run(tool, { entryId: 'a', module: 'b' }))
    expect(error.kind).toBe('not-found')
    expect(error.message).toContain('more than one target')
  })

  it('dryRun 走通且不动树', async () => {
    const { entry, calls } = makeEntry()
    const cache = makeCache()
    const tool = await makeTool(makeHost({ entries: [entry], cache: cache.port }))

    const data = expectOk(await run(tool, { entryId: 'pkg-a', dryRun: true }))
    expect(data['dryRun']).toBe(true)
    expect(cache.calls).toEqual([])
    expect(calls).toEqual([])
  })

  it('exec.signal 透传：已取消的调用得到 cancelled', async () => {
    const { entry, calls } = makeEntry()
    const controller = new AbortController()
    controller.abort()
    const tool = await makeTool(makeHost({ entries: [entry], cache: makeCache().port }))

    const error = expectFail(await run(tool, { entryId: 'pkg-a' }, execWith(controller.signal)))
    expect(error.kind).toBe('cancelled')
    expect(calls).toEqual([])
  })

  it('loader.internal 缺失 → not-configured + 建议重启', async () => {
    const { entry } = makeEntry()
    const tool = await makeTool(makeHost({ entries: [entry], internalAvailable: false }))

    const error = expectFail(await run(tool, { entryId: 'pkg-a' }))
    expect(error.kind).toBe('not-configured')
    expect(error.hint).toContain('restart')
  })

  it('import 期失败 → reload-failed，且 message 说清「旧 entry 没被碰」', async () => {
    const { entry, calls } = makeEntry()
    const tool = await makeTool(
      makeHost({
        entries: [entry],
        cache: makeCache().port,
        importFresh: async () => {
          throw new Error('syntax error on disk')
        },
      }),
    )

    const error = expectFail(await run(tool, { entryId: 'pkg-a' }))
    expect(error.kind).toBe('reload-failed')
    expect(error.message).toContain('never touched')
    expect(calls).toEqual([])
  })

  it('apply 期失败 → reload-failed，hint 说清旧版本已放回', async () => {
    const { entry } = makeEntry()
    entry.mountFresh = async () => {
      throw new Error('boom in apply')
    }
    const tool = await makeTool(makeHost({ entries: [entry], cache: makeCache().port }))

    const error = expectFail(await run(tool, { entryId: 'pkg-a' }))
    expect(error.kind).toBe('reload-failed')
    expect(error.hint).toContain('put back')
  })

  it('宿主端口自己抛异常时，execute **也不抛**，收敛成结构化失败', async () => {
    const tool = await makeTool({
      internalAvailable: () => {
        throw new Error('host exploded')
      },
      cache: () => undefined,
      candidates: () => [],
      resolveEntryUrl: async () => ENTRY_URL,
      importFresh: async () => undefined,
    })

    const error = expectFail(await run(tool, { entryId: 'pkg-a' }))
    expect(TOOL_ERROR_KINDS).toContain(error.kind)
  })

  it('每个结果都带 nextStep', async () => {
    const { entry } = makeEntry()
    const tool = await makeTool(makeHost({ entries: [entry], cache: makeCache().port }))

    const success = await run(tool, { entryId: 'pkg-a' })
    expect(success.nextStep?.tool).toBe('dsh_diagnose_plugin_load')
    const failed = await run(tool, {})
    expect(failed.nextStep?.tool).toBe('dsh_diagnose_plugin_load')
  })
})

describe('dsh_hot_reload · 一句话结论', () => {
  it('成功给出 swapped 与 rolledBack', () => {
    const text = summarizeReloadForTest({
      entry: { entryId: 'include:e', moduleName: 'pkg-a' },
      dryRun: false,
      modulesCleared: 3,
      rolledBack: false,
      oldFiberTouched: true,
      newFiberState: 2,
    })
    expect(text).toContain('swapped=3 modules')
    expect(text).toContain('rolledBack=false')
  })

  it('import 期失败额外点出 oldFiberUntouched（决定有没有东西要收拾）', () => {
    const text = summarizeReloadForTest({
      entry: { entryId: 'include:e', moduleName: 'pkg-a' },
      dryRun: false,
      modulesCleared: 3,
      rolledBack: false,
      oldFiberTouched: false,
      newFiberState: null,
    })
    expect(text).toContain('oldFiberUntouched=true')
  })

  it('干跑给 dryRun 结论', () => {
    const text = summarizeReloadForTest({
      entry: { entryId: 'include:e', moduleName: 'pkg-a' },
      dryRun: true,
      moduleCount: 7,
    })
    expect(text).toContain('wouldSwap=7 modules')
    expect(text).toContain('dryRun=true')
  })

  it('形状不对 → undefined（渲染退回纯 JSON，而不是抛）', () => {
    expect(summarizeReloadForTest(null)).toBeUndefined()
    expect(summarizeReloadForTest({})).toBeUndefined()
    expect(summarizeReloadForTest({ entry: {} })).toBeUndefined()
  })
})

describe('lib/hot-reload · 纯助手', () => {
  it('bareId 去掉第一个冒号前的分组前缀', () => {
    expect(bareId('include:x')).toBe('x')
    expect(bareId('plain')).toBe('plain')
  })
})
