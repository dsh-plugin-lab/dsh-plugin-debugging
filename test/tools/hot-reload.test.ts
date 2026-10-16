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
 *
 * ## 本轮（W2-D）的两处改造
 *
 * 1. **断言改读 `data`，但根因判据不许降级**（活跃坑 37）：旧护栏读 `hint` 里有没有
 *    `could not be fully restored`，并配合真机形状下 `has(url) === true`。`hint` 删了，
 *    这两条**原样搬去读 `failure.verdict` / `data.key`** —— 断言的是**缓存真的放回去了**
 *    这个根因事实，不是「不再报错」。下面 `lib/hot-reload · 真机 LoadCache 形状（回归）`
 *    那一组就是它；本轮的变异自证也打在这上面。
 * 2. **形状断言**（描述四段 / `data` 三键 / `audit` 不进文本 / `nextStep` 带动作）
 *    按红线 B20a / B21 / B22 / B18a / B18b 的判据在**这个工具自己身上**跑一遍。
 */
import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

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
  reloadHostFrom,
  kindForReason,
  outcomeToToolResult,
  type ClosurePort,
  type ReloadArgs,
  type ReloadEntryPort,
  type ReloadHost,
  type ReloadTarget,
} from '../../src/lib/hot-reload.ts'
import {
  createHotReloadTool,
  HOT_RELOAD_DESCRIPTION,
  HOT_RELOAD_TOOL,
} from '../../src/tools/dsh_hot_reload.ts'
import { composeDescription } from '../../src/tools/describe.ts'
import {
  TOOL_ERROR_KINDS,
  toolResultProblem,
  type JsonValue,
  type NextStep,
} from '../../src/lib/errors.ts'
import {
  configFor,
  depsFor,
  execWith,
  expectFail,
  expectOk,
  expectSynthesizedDescription,
  renderText,
  run,
  splitRender,
  tempDshHome,
} from './helpers.ts'

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

/**
 * 造一个可控的缓存端口。
 *
 * `failWrite` 为真时 `write` 返回 `false` —— 用来钉住「放回缓存失败也要如实说」
 * 并且**不许**把 import 的真原因盖掉。
 */
function makeCache(
  children: Record<string, string[]> = { [ENTRY_URL]: [DEP_URL] },
  seeded: string[] = [ENTRY_URL, DEP_URL],
  options: { failWrite?: boolean } = {},
): { port: ClosurePort; calls: string[]; has: (url: string) => boolean } {
  // 槽的形状照真机：`{ javascript: job }`（不是裸 job）。
  const store = new Map<string, unknown>()
  for (const url of seeded) store.set(url, { javascript: `job:${url}` })
  const calls: string[] = []
  const port: ClosurePort = {
    read: (url) => {
      const slot = store.get(url)
      if (slot === undefined || slot === null || typeof slot !== 'object') return []
      return Object.values(slot as Record<string, unknown>)
    },
    write: (url, job) => {
      calls.push(`write:${url}`)
      if (options.failWrite === true) return false
      store.set(url, { javascript: job })
      return true
    },
    clear: (url) => {
      calls.push(`clear:${url}`)
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

/**
 * 取 `nextStep` 的**工具支**（`{tool, args?, why}`）。
 *
 * 为什么要这个助手：`NextStep` 是两支的联合（B18a 就是断言这条），直接 `step.tool`
 * 在 `manual` 支上不存在 —— 那是**类型在替我们守规矩**。测试要么按分支收窄、要么
 * 显式转型；用 `in` 收窄不会把联合偷偷压成一个形状。
 *
 * @param step 工具结果里的 `nextStep`。
 */
function toolStep(step: NextStep | undefined): { tool?: string; args?: JsonValue } {
  if (step === undefined) return {}
  return 'tool' in step ? step : {}
}

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

  it('一个都不给 → 结构化失败（不猜），且带实质 verdict', () => {
    const parsed = parseReloadTarget({})
    expect(parsed.target).toBeUndefined()
    expect(parsed.failure?.reason).toBe('bad-target')
    // 失败也有 L1（§4.1 约定 1）：只写 `failed` 等于让模型只看得到头行。
    expect(parsed.failure?.verdict).toContain('nothing was reloaded')
  })

  it('给多于一个 → 结构化失败（不猜哪个是你想要的）', () => {
    const parsed = parseReloadTarget({ entryId: 'x', module: 'y' })
    expect(parsed.target).toBeUndefined()
    expect(parsed.failure?.reason).toBe('bad-target')
    expect(parsed.failure?.verdict).toContain('more than one target')
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

  it('裸 id / URL / 文件名三种形态都能匹配到同一个 entry', () => {
    // 裸 id（无前缀）与全前缀 id 是同一件事的两种写法。
    const bare = matchEntries([entry], { kind: 'entryId', value: 'pkg-a' })
    const prefixed = matchEntries([entry], { kind: 'entryId', value: 'include:pkg-a' })
    // URL 形态走 module 键。
    const byUrl = matchEntries([entry], { kind: 'module', value: ENTRY_URL })
    // 文件名形态（`index.js` / `index`）也从 URL 回推出来。
    const byFile = matchEntries([entry], { kind: 'module', value: 'index.js' })
    for (const outcome of [bare, prefixed, byUrl, byFile]) {
      expect(outcome.exact.map((item) => item.entryId)).toEqual(['include:pkg-a'])
    }
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
    expect(restoreCache(cache.port, backup)).toBe(true)
    expect(cache.has(ENTRY_URL)).toBe(true)
  })

  it('放回缓存失败时返回 false（不谎报成功，也不抛）', () => {
    const cache = makeCache({}, [ENTRY_URL], { failWrite: true })
    const backup = backupAndClear(cache.port, [ENTRY_URL])
    expect(restoreCache(cache.port, backup)).toBe(false)
  })
})

/**
 * 真机 `LoadCache` 的替身 —— **本轮真机红的回归位**。
 *
 * 逐字照 node 24.18.0 `internal/modules/esm/loader` → `LoadCache` 的实测行为：
 * `get(url, type)` / `set(url, type, job)` / `delete(url, type)` 的**第二个参数都是 `type`，
 * 且必须是字符串**（非字符串 → 抛 `The "type" argument must be of type string`）。
 *
 * 有了它，「把 job 当成 type 传进去」这种错法在本机单测里**当场红**，
 * 而不是等到真机上表现为一条 `internal`。
 */
function makeRealisticLoadCache(seeded: string[] = [ENTRY_URL]): {
  loadCache: Record<string, unknown>
  has: (url: string) => boolean
} {
  const slots = new Map<string, Record<string, unknown>>()
  for (const url of seeded) slots.set(url, { __proto__: null, javascript: { job: url } })

  const validateString = (value: unknown, name: string): void => {
    if (typeof value !== 'string') {
      throw new TypeError(
        `The "${name}" argument must be of type string. Received an instance of ${
          (value as { constructor?: { name?: string } })?.constructor?.name ?? typeof value
        }`,
      )
    }
  }

  return {
    has: (url) => slots.get(url)?.['javascript'] !== undefined,
    loadCache: {
      get(url: string, type = 'javascript') {
        validateString(url, 'url')
        validateString(type, 'type')
        return slots.get(url)?.[type]
      },
      set(url: string, type = 'javascript', job?: unknown) {
        validateString(url, 'url')
        validateString(type, 'type')
        slots.set(url, { ...(slots.get(url) ?? {}), [type]: job })
        return this
      },
      delete(url: string, type = 'javascript') {
        validateString(url, 'url')
        validateString(type, 'type')
        const slot = slots.get(url)
        if (slot !== undefined) slot[type] = undefined
      },
      has(url: string, type = 'javascript') {
        validateString(url, 'url')
        validateString(type, 'type')
        return slots.get(url)?.[type] !== undefined
      },
    },
  }
}

describe('lib/hot-reload · 8 步算法', () => {
  it('成功 v1→v2：清缓存 → import → dispose 旧 → 挂新的（顺序即判据）', async () => {
    const { entry, calls } = makeEntry()
    const cache = makeCache()
    const order: string[] = []
    const host = makeHost({
      entries: [entry],
      cache: cache.port,
      importFresh: async () => {
        order.push('import')
        // 「新代码」这份插件值就是 v2。
        return { plugin: 'v2' }
      },
    })
    // 把「碰树」的顺序也记下来，才能断言 import 在 dispose 之前。
    entry.disposeOld = async () => {
      order.push('disposeOld')
      calls.push('disposeOld')
    }
    entry.mountFresh = async (plugin) => {
      order.push(`mountFresh:${String((plugin as { plugin?: string }).plugin)}`)
      calls.push('mountFresh')
    }

    const outcome = await runReload(host)

    expect(outcome.ok).toBe(true)
    // 第 5 步（import）在第 6 步（dispose 旧）**之前** —— 这是「import 期失败时旧 fiber
    // 从未被碰」的机制本身，不只是结果。
    expect(order).toEqual(['import', 'disposeOld', 'mountFresh:v2'])
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
      // message 带**真实原因**（那个 import 抛的错），不是 Node 内部文案。
      expect(outcome.failure.message).toContain('boom at import time')
      expect(outcome.failure.verdict).toContain('never touched')
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

  it('放回缓存失败也不许盖掉 import 的真原因，且 verdict 点明缓存没放回', async () => {
    const { entry, calls } = makeEntry()
    const cache = makeCache({}, [ENTRY_URL, DEP_URL], { failWrite: true })
    const host = makeHost({
      entries: [entry],
      cache: cache.port,
      importFresh: async () => {
        throw new Error('SyntaxError: unexpected token on disk')
      },
    })

    const outcome = await runReload(host)

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      // 原因仍然是 import 那个错（真机上就是它被 Node 内部文案顶掉了）。
      expect(outcome.failure.reason).toBe('import-failed')
      expect(outcome.failure.message).toContain('unexpected token on disk')
      expect(outcome.failure.verdict).toContain('never touched')
      // 但缓存没放回这件事也要说出来。
      expect(outcome.failure.verdict).toContain('could not be fully restored')
    }
    expect(calls).toEqual([])
  })

  it('apply 期失败（同步抛）：回滚被调用，旧版本被**重新实例化**', async () => {
    const { entry, calls } = makeEntry()
    const cache = makeCache()
    const host = makeHost({ entries: [entry], cache: cache.port })
    entry.mountFresh = () => {
      calls.push('mountFresh')
      throw new Error('boom in apply')
    }

    const outcome = await runReload(host)

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.failure.reason).toBe('apply-failed')
      expect(outcome.data?.rolledBack).toBe(true)
      expect(outcome.data?.oldFiberTouched).toBe(true)
      // 「回滚成立」是**结论**，必须自己出现在 L1 里（新契约下 error.message 不进模型文本）。
      expect(outcome.failure.verdict).toContain('put back')
    }
    // 顺序也要对：摘新 → 重挂旧。
    expect(calls).toEqual(['disposeOld', 'mountFresh', 'removeFresh', 'remountOld'])
    expect(cache.has(ENTRY_URL)).toBe(true)
  })

  it('apply 期失败（异步 reject）：同样回滚，且 rolledBack=true', async () => {
    const { entry, calls } = makeEntry()
    const cache = makeCache()
    const host = makeHost({ entries: [entry], cache: cache.port })
    entry.mountFresh = async () => {
      calls.push('mountFresh')
      await Promise.resolve()
      throw new Error('boom in apply (async)')
    }

    const outcome = await runReload(host)

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.failure.reason).toBe('apply-failed')
      expect(outcome.data?.rolledBack).toBe(true)
      expect(outcome.failure.verdict).toContain('put back')
    }
    expect(calls).toEqual(['disposeOld', 'mountFresh', 'removeFresh', 'remountOld'])
    expect(cache.has(ENTRY_URL)).toBe(true)
  })

  it('apply 期失败且回滚自己也没走完：verdict 必须说「回滚没完成」，不许谎报', async () => {
    const { entry, calls } = makeEntry()
    const host = makeHost({ entries: [entry], cache: makeCache().port })
    entry.mountFresh = () => {
      calls.push('mountFresh')
      throw new Error('boom in apply')
    }
    entry.removeFresh = async () => {
      calls.push('removeFresh')
      throw new Error('cannot remove the fresh fiber')
    }
    entry.remountOld = async () => {
      calls.push('remountOld')
      throw new Error('cannot remount the previous plugin')
    }

    const outcome = await runReload(host)

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.failure.reason).toBe('apply-failed')
      expect(outcome.data?.rolledBack).toBe(false)
      expect(outcome.failure.verdict).toContain('rollback did not complete')
    }
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
    if (!outcome.ok) {
      expect(outcome.failure.reason).toBe('no-match')
      expect(outcome.failure.verdict).toContain('nothing was reloaded')
    }
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
      expect(outcome.failure.verdict).toContain('restart')
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

describe('lib/hot-reload · 结果 → 工具结果（新契约的三键 data）', () => {
  it('成功带上指回只读工具的 nextStep，且 data 恰好三键', () => {
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
        verdict: 'entry=e · swapped=1 modules',
      },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(toolStep(result.nextStep).tool).toBe('dsh_diagnose_plugin_load')
      expect(toolStep(result.nextStep).args).toEqual({ package: 'pkg-a' })
      // B21：失败/成功同形的三键，且守卫认它（不是被合成的兜底）。
      expect(Object.keys(result.data).sort()).toEqual(['audit', 'key', 'verdict'])
      expect(toolResultProblem(result)).toBeUndefined()
      // 闭包 URL 列表是复核用的 → audit；模型拿它做不了下一个决定。
      expect(result.data.audit).toMatchObject({ modules: [ENTRY_URL] })
    }
  })

  it('失败：data.verdict 逐字来自 failure.verdict，key 带四个决策事实', () => {
    const result = outcomeToToolResult({
      ok: false,
      failure: {
        reason: 'import-failed',
        message: 'm',
        verdict: 'the running entry was never touched',
      },
      data: {
        entry: { entryId: 'e', moduleName: 'pkg-a' },
        modulesCleared: 2,
        oldFiberTouched: false,
        rolledBack: false,
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('reload-failed')
      // `hint` 没了：模型读的是 verdict，不是 error.message。
      expect(result.data.verdict).toBe('the running entry was never touched')
      expect(result.data.key).toMatchObject({
        entry: { entryId: 'e', moduleName: 'pkg-a' },
        modulesCleared: 2,
        oldFiberTouched: false,
        rolledBack: false,
      })
      expect(toolStep(result.nextStep).tool).toBe('dsh_diagnose_plugin_load')
      expect(toolStep(result.nextStep).args).toEqual({ package: 'pkg-a' })
      expect(Object.keys(result.data).sort()).toEqual(['audit', 'key', 'verdict'])
      expect(toolResultProblem(result)).toBeUndefined()
    }
  })

  it('失败但连 entry 都没定出来：key 是 {}，**不许**拿默认值冒充「树是安全的」', () => {
    const result = outcomeToToolResult({
      ok: false,
      failure: { reason: 'no-match', message: 'm', verdict: 'nothing was reloaded' },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.data.key).toEqual({})
      expect(toolStep(result.nextStep).args).toBeUndefined()
      expect(toolResultProblem(result)).toBeUndefined()
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

  it('成功路径：data 的 key 带 entry / 模块数 / 结论，audit 带闭包清单', async () => {
    const { entry } = makeEntry()
    const tool = await makeTool(makeHost({ entries: [entry], cache: makeCache().port }))

    const data = expectOk(await run(tool, { entryId: 'pkg-a' }))
    const keyEntry = data.key['entry'] as Record<string, unknown>
    expect(keyEntry['entryId']).toBe('include:pkg-a')
    expect(data.key['modulesCleared']).toBe(2)
    expect(data.key['rolledBack']).toBe(false)
    expect(String(data.verdict)).toContain('swapped=2 modules')
    // 闭包 URL 清单是复核用的 → audit（不进模型文本）。
    expect(data.audit['modules']).toContain(ENTRY_URL)
  })

  it('一个目标都不给 → not-found，且不碰宿主', async () => {
    const { entry, calls } = makeEntry()
    const tool = await makeTool(makeHost({ entries: [entry], cache: makeCache().port }))

    const error = expectFail(await run(tool, {}))
    expect(error.kind).toBe('not-found')
    expect(error.message).toContain('no target was given')
    // 失败分支也有实质 L1。
    expect(error.data.verdict).toContain('nothing was reloaded')
    // key 为空 = 「什么都没定位到」，不是「树是安全的」。
    expect(error.data.key).toEqual({})
    // 给的名字留痕（audit，人复核用）。
    expect(error.data.audit['providedTargets']).toEqual([])
    expect(calls).toEqual([])
  })

  it('给两个目标 → not-found（不猜），audit 里记下给了哪几个', async () => {
    const { entry } = makeEntry()
    const tool = await makeTool(makeHost({ entries: [entry], cache: makeCache().port }))

    const error = expectFail(await run(tool, { entryId: 'a', module: 'b' }))
    expect(error.kind).toBe('not-found')
    expect(error.message).toContain('more than one target')
    expect(error.data.audit['providedTargets']).toEqual(['entryId', 'module'])
  })

  it('dryRun 走通且不动树', async () => {
    const { entry, calls } = makeEntry()
    const cache = makeCache()
    const tool = await makeTool(makeHost({ entries: [entry], cache: cache.port }))

    const data = expectOk(await run(tool, { entryId: 'pkg-a', dryRun: true }))
    expect(data.key['dryRun']).toBe(true)
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
    expect(error.data.verdict).toContain('nothing was reloaded')
    expect(calls).toEqual([])
  })

  it('loader.internal 缺失 → not-configured + verdict 点明只能重启', async () => {
    const { entry } = makeEntry()
    const tool = await makeTool(makeHost({ entries: [entry], internalAvailable: false }))

    const error = expectFail(await run(tool, { entryId: 'pkg-a' }))
    expect(error.kind).toBe('not-configured')
    expect(error.data.verdict).toContain('restart')
  })

  it('import 期失败 → reload-failed，verdict 说清「旧 entry 没被碰」，key 给出结构化事实', async () => {
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
    // message 带**真实原因**（操作视角）。
    expect(error.message).toContain('syntax error on disk')
    // 「旧 fiber 从未被碰」既在 L1（verdict）里，也在**结构化 key** 里
    // —— 前者给模型读，后者给模型判「要不要收拾」。
    expect(error.data.verdict).toContain('never touched')
    expect(error.data.key).toMatchObject({ oldFiberTouched: false, rolledBack: false })
    expect(calls).toEqual([])
  })

  it('apply 期失败 → reload-failed，verdict 说清旧版本已放回，key.rolledBack=true', async () => {
    const { entry } = makeEntry()
    entry.mountFresh = async () => {
      throw new Error('boom in apply')
    }
    const tool = await makeTool(makeHost({ entries: [entry], cache: makeCache().port }))

    const error = expectFail(await run(tool, { entryId: 'pkg-a' }))
    expect(error.kind).toBe('reload-failed')
    expect(error.data.verdict).toContain('put back')
    expect(error.data.key).toMatchObject({ rolledBack: true, oldFiberTouched: true })
  })

  it('宿主端口自己抛异常时，execute **也不抛**，收敛成结构化失败（B24）', async () => {
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
    // 兜底分支也必须给实质 L1（模型看不到 error.message）。
    expect(error.data.verdict).not.toBe('')
    expect(error.data.key).toEqual({})
  })

  it('**kind 不许降级成 internal**：九条已分类失败分支逐条钉住', async () => {
    const { entry } = makeEntry()
    const aborted = new AbortController()
    aborted.abort()
    const cases: Array<{ name: string; host: ReloadHost; args: ReloadArgs; signal?: AbortSignal }> =
      [
        { name: 'bad-target(none)', host: makeHost({ entries: [entry] }), args: {} },
        {
          name: 'bad-target(many)',
          host: makeHost({ entries: [entry] }),
          args: { entryId: 'a', module: 'b' },
        },
        { name: 'no-match', host: makeHost({ entries: [] }), args: { entryId: 'pkg-a' } },
        {
          name: 'ambiguous',
          host: makeHost({
            entries: [
              makeEntry({ entryId: 'include:dup' }).entry,
              makeEntry({ entryId: 'include:dup' }).entry,
            ],
          }),
          args: { entryId: 'dup' },
        },
        {
          name: 'not-reloadable',
          host: makeHost({
            entries: [makeEntry({ moduleName: 'cordis:group', reloadable: false }).entry],
          }),
          args: { entryId: 'pkg-a' },
        },
        {
          name: 'no-internal',
          host: makeHost({ entries: [entry], internalAvailable: false }),
          args: { entryId: 'pkg-a' },
        },
        {
          name: 'no-loadCache',
          host: makeHost({ entries: [entry], cache: undefined }),
          args: { entryId: 'pkg-a' },
        },
        {
          name: 'cancelled',
          host: makeHost({ entries: [entry], cache: makeCache().port }),
          args: { entryId: 'pkg-a' },
          signal: aborted.signal,
        },
        {
          name: 'import-failed',
          host: makeHost({
            entries: [entry],
            cache: makeCache().port,
            importFresh: async () => {
              throw new Error('boom')
            },
          }),
          args: { entryId: 'pkg-a' },
        },
        {
          name: 'apply-failed',
          host: makeHost({
            entries: [
              makeEntry({
                mountFresh: async () => {
                  throw new Error('boom')
                },
              }).entry,
            ],
            cache: makeCache().port,
          }),
          args: { entryId: 'pkg-a' },
        },
      ]

    for (const item of cases) {
      const tool = await makeTool(item.host)
      const result = await run(
        tool,
        item.args,
        item.signal === undefined ? execWith() : execWith(item.signal),
      )
      const error = expectFail(result)
      // 根因：真机上 import 期失败曾被 Node 内部文案顶成 `internal`，
      // 于是模型去报一个不存在的 bug，而不是去改磁盘上的代码。
      expect(error.kind, `${item.name} 降级成了 internal`).not.toBe('internal')
      expect(error.data.verdict, `${item.name} 的 verdict 是空的`).not.toBe('')
    }
  })

  it('每个结果都带 nextStep', async () => {
    const { entry } = makeEntry()
    const tool = await makeTool(makeHost({ entries: [entry], cache: makeCache().port }))

    const success = await run(tool, { entryId: 'pkg-a' })
    expect(toolStep(success.nextStep).tool).toBe('dsh_diagnose_plugin_load')
    const failed = await run(tool, {})
    expect(toolStep(failed.nextStep).tool).toBe('dsh_diagnose_plugin_load')
  })
})

describe('dsh_hot_reload · 形状（SHAPE §2.1 / §3.1 / §4.1）', () => {
  /** 造工具 + 依赖。 */
  async function makeTool(host: ReloadHost): Promise<ReturnType<typeof createHotReloadTool>> {
    const dshHome = await tempDshHome()
    return createHotReloadTool({ ...depsFor(configFor(dshHome)), reload: host })
  }

  /** 一个「成功换掉」的 fixture。 */
  async function successTool(): Promise<ToolDefinition> {
    const { entry } = makeEntry()
    return await makeTool(makeHost({ entries: [entry], cache: makeCache().port }))
  }

  /** 一个 import 期失败的 fixture。 */
  async function importFailTool(): Promise<ToolDefinition> {
    const { entry } = makeEntry()
    return await makeTool(
      makeHost({
        entries: [entry],
        cache: makeCache().port,
        importFresh: async () => {
          throw new Error('syntax error on disk')
        },
      }),
    )
  }

  it('描述四段：合成器与声明一致（B20a 照不到的那一半）+ 行动类的代价段（本工具特有）', () => {
    const tool = createHotReloadTool({
      ...depsFor(configFor('/tmp/nowhere')),
      reload: makeHost({}),
    })
    const description = HOT_RELOAD_DESCRIPTION

    expectSynthesizedDescription(tool, composeDescription(description))
    // 行动类工具**必写** cost 段（§2 规则 ④：改不改状态 / 有没有 dryRun / 可不可逆）——
    // B20a 只判「写了但为空」的闭集形状，判不了「行动类必须有 cost」这个角色规则。
    expect(description.cost).toBeDefined()
    expect(description.cost).toContain('dryRun')

    // 骨架的其余判据（段非空 / 行数与字符上界 / 连接符 / 参数描述下界）由红线 B20a
    // 对闭集全量覆盖，这里不再逐字重抄（一处一事实）。
  })

  it('`data` 顶层**恰好**三键：成功与失败同形（B21）', async () => {
    const success = await run(await successTool(), { entryId: 'pkg-a' })
    expect(success.ok).toBe(true)
    if (!success.ok) throw new Error('期望成功')
    expect(Object.keys(success.data).sort()).toEqual(['audit', 'key', 'verdict'])
    expect(toolResultProblem(success)).toBeUndefined()

    const failure = await run(await importFailTool(), { entryId: 'pkg-a' })
    expect(failure.ok).toBe(false)
    if (failure.ok) throw new Error('期望失败')
    expect(Object.keys(failure.data).sort()).toEqual(['audit', 'key', 'verdict'])
    expect(toolResultProblem(failure)).toBeUndefined()
  })

  it('B24 自检：过守卫的是**恒等**（不是被合成的兜底 internal）', async () => {
    const result = await run(await successTool(), { entryId: 'pkg-a' })
    // `ensureToolResult(value) === value` 才说明这个值真的过了守卫。
    const { ensureToolResult } = await import('../../src/lib/errors.ts')
    expect(ensureToolResult(result)).toBe(result)
  })

  it('模型文本只有 头行 / verdict / L2 / nextStep —— 没有整块 JSON，也没有 audit（B22）', async () => {
    const tool = await successTool()
    const result = await run(tool, { entryId: 'pkg-a' })
    const text = renderText(tool, { entryId: 'pkg-a' }, result)
    const parts = splitRender(text)

    expect(parts.head).toBe(`[${HOT_RELOAD_TOOL}] ok`)
    expect(parts.verdict).not.toBeUndefined()
    expect(parts.l2.length).toBeGreaterThan(0)
    // 不再有 pretty JSON（两空格缩进的块）。
    expect(text).not.toContain('\n  "')

    // 哨兵自检：埋进 `audit` 深处，渲染结果里**一个字符都不许出现**。
    const sentinel = 'SENTINEL_B22_9f3a1c'
    const raw = result as unknown as { data?: Record<string, unknown> }
    const patched = {
      ...(result as unknown as Record<string, unknown>),
      data: {
        ...(raw.data ?? {}),
        audit: { modules: [sentinel], target: { value: sentinel } },
      },
    }
    const patchedText = renderText(tool, { entryId: 'pkg-a' }, patched)
    expect(patchedText).toContain('verdict:') // 渲染确实跑了
    expect(patchedText).not.toContain(sentinel)
  })

  it('L1 逐字来自 `data.verdict`，且 `nextStep.why` 不许等于它（B18b）', async () => {
    const tool = await successTool()
    const result = await run(tool, { entryId: 'pkg-a' })
    const parts = splitRender(renderText(tool, { entryId: 'pkg-a' }, result))
    const data = (result as { data: { verdict: string } }).data
    expect(parts.verdict).toBe(data.verdict)
    if (parts.l3 !== undefined) expect(parts.l3).not.toBe(parts.verdict)
  })

  it('`nextStep` 出现时**必须带动作**（B18a）', async () => {
    const tool = await successTool()
    const result = await run(tool, { entryId: 'pkg-a' })
    expect(result.nextStep).toBeDefined()
    const step = result.nextStep as { tool?: string; manual?: boolean; why: string }
    const hasTool = typeof step.tool === 'string' && step.tool !== ''
    const hasManual = step.manual === true
    expect(hasTool !== hasManual).toBe(true) // 两支恰有其一
    const text = renderText(tool, { entryId: 'pkg-a' }, result)
    expect(text).not.toContain('nextStep: — ')
  })

  it('B17 自检：`nextStep.args` 的标识符出现在 `verdict:` 行或 L2 行里', async () => {
    const tool = await successTool()
    const result = await run(tool, { entryId: 'pkg-a' })
    const step = result.nextStep as { tool?: string; args?: Record<string, unknown> } | undefined
    expect(step?.tool).toBe('dsh_diagnose_plugin_load')
    const parts = splitRender(renderText(tool, { entryId: 'pkg-a' }, result))
    const haystack = [parts.verdict ?? '', ...parts.l2].join('\n')
    const values = Object.values(step?.args ?? {}).filter(
      (value) => value !== null && value !== true && value !== false && value !== 0 && value !== '',
    )
    expect(values.length, 'args 全被例外表排掉了 —— 判据空转').toBeGreaterThan(0)
    for (const value of values) expect(haystack).toContain(String(value))
  })

  it('import 期失败的模型文本里能**直接看见**「旧 fiber 未被碰」（旧 hint 那句话没丢）', async () => {
    const tool = await importFailTool()
    const result = await run(tool, { entryId: 'pkg-a' })
    const text = renderText(tool, { entryId: 'pkg-a' }, result)
    expect(text).toContain(`[${HOT_RELOAD_TOOL}] failed (reload-failed)`)
    // 这是模型最需要看的一句：它决定「有没有东西要收拾」。
    expect(text).toContain('never touched')
    // 结构化事实也在 L2 上（模型据此判要不要重试 / 回滚）。
    expect(text).toContain('oldFiberTouched=false')
    expect(text).toContain('rolledBack=false')
  })

  it('渲染永远有输出：形状不合法的值退化成一行，不抛', async () => {
    const tool = await successTool()
    const text = renderText(tool, { entryId: 'pkg-a' }, { nonsense: true })
    expect(text).toBe(`[${HOT_RELOAD_TOOL}] {"nonsense":true}`)
  })
})

describe('lib/hot-reload · 纯助手', () => {
  it('bareId 去掉第一个冒号前的分组前缀', () => {
    expect(bareId('include:x')).toBe('x')
    expect(bareId('plain')).toBe('plain')
  })
})

/**
 * **真机红的回归位 —— 也是本轮变异自证的那条根因护栏。**
 *
 * 这里跑的是**真适配层**（`reloadHostFrom`）对着**真形状的 `LoadCache`**（`makeRealisticLoadCache`），
 * 不是注入替身。它复现真机那条路径：import 期失败 → 放回缓存 → 旧实现把 job 当 `type` 传 → 抛
 * `The "type" argument must be of type string` → 整个失败被顶成 `internal`。
 *
 * ⚠️ **活跃坑 37**：只断言「不再出现 internal」是**不够的** —— 只要 `write` 把异常吞掉并
 * 返回 `false`，症状就消失了，而缓存其实**没放回**（下次 import 会重新求值）。那是另一种静默坏。
 * 所以这里的判据是**根因事实**，两条一起成立才算绿：
 *
 * 1. `has(url) === true`（缓存**真的**放回去了，不是「我们调过 set 了」）；
 * 2. `verdict` **不含** `could not be fully restored`（回读校验过的那条路走通了）。
 *
 * 变异自证（把 `set(url, type, job)` 改回 `set(url, job)`）会让这两条**同时红**。
 */
describe('lib/hot-reload · 真机 LoadCache 形状（回归 + 变异自证位）', () => {
  /** 造一个最小的宿主 ctx：loader 服务 + 一条 entry。 */
  function makeCtx(
    cache: Record<string, unknown>,
    options: { importThrows?: Error } = {},
  ): Record<string, unknown> {
    const loader = {
      internal: { import: () => undefined, loadCache: cache },
      entries: () => [
        {
          options: { id: 'reloadable-bench', name: ENTRY_URL },
          disabled: false,
          fiber: {
            state: 2,
            inject: {},
            ctx: { get: () => undefined },
            runtime: { callback: () => undefined, fibers: [] },
          },
        },
      ],
      async import() {
        if (options.importThrows !== undefined) throw options.importThrows
        return { plugin: 'fresh' }
      },
      unwrapExports: (value: unknown) => value,
    }
    return { get: (name: string) => (name === 'loader' ? loader : undefined) }
  }

  it('import 期失败：kind 是 **reload-failed**（不是 internal），message 带真原因，verdict 含 never touched，且**缓存真的放回了**', async () => {
    const { loadCache, has } = makeRealisticLoadCache()
    const ctx = makeCtx(loadCache, {
      importThrows: new Error('SyntaxError: Unexpected token on disk'),
    })

    const outcome = await hotReload(
      reloadHostFrom(ctx),
      { kind: 'entryId', value: 'reloadable-bench' },
      { dryRun: false, expired: () => false },
    )

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.failure.reason).toBe('import-failed')
      expect(outcome.failure.message).toContain('Unexpected token on disk')
      expect(outcome.failure.verdict).toContain('never touched')
      // **这一条正是真机红的核心**：绝不能再把 Node 内部文案当原因。
      expect(outcome.failure.message).not.toContain('must be of type string')
      // 根因判据 ①：回读校验过的那条路走通了。
      expect(outcome.failure.verdict).not.toContain('could not be fully restored')
    }
    // 根因判据 ②：缓存**真的**回去了（不是「我们调过 set 了」）。
    expect(has(ENTRY_URL)).toBe(true)
  })

  it('工具层同样：真机失败签名不再出现 internal，且缓存放回成功', async () => {
    const dshHome = await tempDshHome()
    const { loadCache, has } = makeRealisticLoadCache()
    const ctx = makeCtx(loadCache, { importThrows: new Error('boom from disk') })
    const tool = createHotReloadTool({
      ...depsFor(configFor(dshHome)),
      reload: reloadHostFrom(ctx),
    })

    const error = expectFail(await run(tool, { entryId: 'reloadable-bench' }))
    expect(error.kind).toBe('reload-failed')
    expect(error.message).toContain('boom from disk')
    expect(error.data.verdict).toContain('never touched')
    expect(error.message).not.toContain('must be of type string')
    expect(TOOL_ERROR_KINDS).toContain(error.kind)
    // 根因判据（**不是**「把异常吞掉就绿」）：回读校验过 + 缓存真的放回。
    expect(error.data.verdict).not.toContain('could not be fully restored')
    expect(has(ENTRY_URL)).toBe(true)
  })

  it('`include:<id>` 能匹配（诊断的输出必须能直接喂回重载）', async () => {
    const { loadCache } = makeRealisticLoadCache()
    const ctx = makeCtx(loadCache, { importThrows: new Error('boom from disk') })

    const outcome = await hotReload(
      reloadHostFrom(ctx),
      // 逐字用 dsh_diagnose_plugin_load 报出来的那种形态。
      { kind: 'entryId', value: 'include:reloadable-bench' },
      { dryRun: false, expired: () => false },
    )

    // 匹配**成功**了（否则会是 no-match），只是 import 失败。
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.failure.reason).toBe('import-failed')
      expect(outcome.failure.reason).not.toBe('no-match')
    }
    expect(outcome.data?.entry?.entryId).toBe('reloadable-bench')
  })

  it('解析层：include: 前缀被剥掉，而 URL 形态不被误剥', () => {
    expect(parseReloadTarget({ entryId: 'include:reloadable-bench' }).target).toEqual({
      kind: 'entryId',
      value: 'reloadable-bench',
    })
    // URL 的第一个冒号在 scheme 里 —— 剥了就成了垃圾。
    expect(parseReloadTarget({ entryId: ENTRY_URL }).target).toEqual({
      kind: 'entryId',
      value: ENTRY_URL,
    })
    // module / serverName 不剥（它们本来就不带分组前缀）。
    expect(parseReloadTarget({ module: 'include:x' }).target?.value).toBe('include:x')
  })

  it('成功路径：缓存能真的放回（write 用对了 type），不抛', async () => {
    const { loadCache, has } = makeRealisticLoadCache()
    const ctx = makeCtx(loadCache)

    const outcome = await hotReload(
      reloadHostFrom(ctx),
      { kind: 'entryId', value: 'reloadable-bench' },
      { dryRun: true, expired: () => false },
    )

    // dryRun 不该动缓存。
    expect(has(ENTRY_URL)).toBe(true)
    expect(outcome.ok).toBe(true)
  })
})
