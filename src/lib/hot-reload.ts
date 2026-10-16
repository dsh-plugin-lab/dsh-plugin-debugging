/**
 * 热重载的**机制层** —— 按 [ARCHITECTURE.md](../../docs/ARCHITECTURE.md) §5 记的 8 步算法，顺序即判据（真机证据见 [HOST-CONTRACTS.md](../../docs/HOST-CONTRACTS.md) §1）。
 *
 * ## 为什么单独一层，且不 import Cordis
 *
 * 与 `lib/loader.ts` 同一个理由：算法要能**脱离宿主单测**。所以这里定义一组**端口**
 * （`ReloadHost` / `ReloadEntryPort` / `ClosurePort`），算法只调端口；真实实现在
 * `reloadHostFrom(ctx)` 里用**结构化访问**绑上宿主对象（不 import Cordis）。
 * 单测喂假端口，于是「import 期失败时一次都没 dispose」这种断言可以直接写。
 *
 * ## 顺序就是判据（§2.1 / §6.6）
 *
 * ```
 * 定位 entry → 提取本地闭包 → 备份缓存 → 只清那批 → 先 import →
 * 再 dispose 旧 fiber → 挂载新的 → 失败分支
 * ```
 *
 * **「先 import 后 dispose」不许调换**：真机实验A 里 import 期失败那条路径的步骤序列中
 * **根本没有 dispose-old**，这正是「旧 fiber 从未被碰过」的原因（§6.6 判据 1）。
 * 代码里因此把 import 单独放在 dispose **之前**的 try 块里，而不是包在一起。
 *
 * ## 三条已实测的实现陷阱（§6.6 T1–T4）
 *
 * - **T1**：`internal.loadCache` 的 ctor 是 `LoadCache`、**`instanceof Map === false`**
 *   （原型链 `[LoadCache, SafeMap]`，所在 realm 与插件不同）。所以这里**只调缓存对象自己的**
 *   `get` / `set` / `delete`，**不碰 `Map.prototype`** —— 参考实现那手
 *   `Map.prototype.delete.call` 在本机未必成立。
 * - **T2**：`internal.resolveSync` 对 **URL 形式**的 name 会失败（报 `Cannot find package 'undefined'`）
 *   → 先判 `file://`，再回落 `new URL(name, baseUrl)`。
 * - **T4**：entry 匹配要**两个字段都试 + URL 归一** —— `entry.id` 实际是 `include:<id>`，
 *   `entry.options.name` 是 `file://` URL。只比 id 会得到**假阴性**（看着像「树里没有这个 entry」）。
 *
 * ## 边界（§2.2，必须由输出说清）
 *
 * 插件在 cordis 之外拿的裸资源（`setInterval` / 裸 socket / `process.on` / 文件句柄 / worker）
 * **不归 effect 管，dispose 旧 fiber 不会释放 → 静默泄漏**。工具无法检测它们，
 * 所以只在**描述层的边界段**明说一次（SHAPE §2：恒定知识写一次，不进每次输出）。
 *
 * ## v1.1 契约迁移（SHAPE §4.1）
 *
 * 旧契约里每条失败带 `message` + `hint`（散文建议）。现在 `hint` 删了，它拆成两处：
 * - `message` **不变**：这次**操作**为什么没做成（操作视角），进 `error.message`；
 * - `verdict`（新）：**结论**（世界视角），进 `data.verdict`，就是模型读到的 L1。
 *
 * 所以本文件里每条失败都必须写一句实质 `verdict` —— 模型看不到 `error.message`
 * （渲染不打印它），失败的「所以呢」只能由 `verdict` 承载。
 */
import { fail, messageOf, ok, asRecord, asFunction, asString, isAborted, toToolError, type JsonValue, type NextStep, type ToolResult } from './errors.js'
import { loaderFrom, iterate } from './loader.js'

/** 定位 entry 的三种方式（§2.3；三者择一）。 */
export type ReloadTargetKind = 'entryId' | 'module' | 'serverName'

/** 已定出来的目标。 */
export interface ReloadTarget {
  kind: ReloadTargetKind
  value: string
}

/** 工具参数（`dryRun` 不参与定位）。 */
export interface ReloadArgs {
  entryId?: string
  module?: string
  serverName?: string
  dryRun?: boolean
}

/** 目标的**解析**结果：要么定出一个，要么是一条可直接返回的失败说明。 */
export interface TargetParse {
  target?: ReloadTarget
  failure?: ReloadFailure
}

/** 失败原因：**机制层自己的闭枚举**，与工具的 `ToolErrorKind` 解耦（工具负责映射）。 */
export type ReloadFailureReason =
  | 'bad-target'
  | 'no-match'
  | 'ambiguous'
  | 'no-internal'
  | 'not-reloadable'
  | 'import-failed'
  | 'apply-failed'
  | 'cancelled'
  | 'timeout'

/**
 * 一条失败。
 *
 * 两个字段角色不同，**不是同一句的两个副本**（SHAPE §4.1 的字段角色表）：
 * - `message` = **这次操作**为什么没做成（操作视角）→ `error.message`；
 * - `verdict` = **结论**（世界视角）→ `data.verdict`，也就是模型读到的 L1。
 *
 * 两者都必须英文（B14 扫 `src/**`）。`verdict` 必须**实质**：只写 `failed` 等于
 * 让模型只看得到头行的 `failed (<kind>)`。
 */
export interface ReloadFailure {
  reason: ReloadFailureReason
  message: string
  verdict: string
}

/**
 * 一个模块缓存端口。
 *
 * ## 为什么不是 `get/set/delete`（这是真机红的根因，已确证到行）
 *
 * Node 24 的 `LoadCache` 不是普通 Map —— 它的**每个方法都多一个 `type` 参数**，
 * 且第二个参数**必须是字符串**（实测 `internal/modules/esm/module_map` 的原函数体）：
 *
 * ```js
 * get(url, type = kImplicitTypeAttribute) { validateString(type, 'type'); return super.get(url)?.[type] }
 * set(url, type = kImplicitTypeAttribute, job) { validateString(type, 'type'); cachedJobsForUrl[type] = job; … }
 * delete(url, type = kImplicitTypeAttribute) { const cached = super.get(url); if (cached) cached[type] = undefined }
 * ```
 *
 * 所以 `set(url, slot)` 会把 **job 当成 type** 传进去 → `validateString` 抛
 * `The "type" argument must be of type string. Received an instance of ModuleJob`。
 * 这正是真机上 import 期失败被吞成 `internal` 的原因：回滚缓存那一步自己先炸了。
 *
 * → 端口因此**按语义**定义（读回 / 放回 / 清掉），把「type 是什么」留给适配层去发现与**验证**
 * （`write` 返回是否成功，是**真的回读校验过**，不是「我调过了」）。
 */
export interface ModuleCachePort {
  /**
   * 读一个 URL 上现存的全部 job（真机上是 `{ javascript: ModuleJob }` 那个槽里的值）。
   *
   * **绝不抛**：读不到就返回空数组。
   */
  read(url: string): unknown[]
  /**
   * 把一条 job 放回该 URL。
   *
   * **绝不抛**，且必须**回读验证**再返回 `true` —— 返回 `false` 表示这条没放回去，
   * 调用方据此把「回滚没走完」如实说出去，而不是假装成功。
   */
  write(url: string, job: unknown): boolean
  /** 让该 URL 上的缓存失效。**绝不抛**。 */
  clear(url: string): void
}

/** 闭包遍历还需要「这个 URL 的子模块是谁」。 */
export interface ClosurePort extends ModuleCachePort {
  children(url: string): Promise<string[]>
}

/**
 * 目标 entry 的句柄 —— 算法只通过这些原语碰树。
 *
 * 把 dispose / mount / rollback 拆成独立方法（而不是一个 `swap()`）是**有意的**：
 * 只有拆开，「import 期失败时没有调用过 dispose」才是一条可断言的判据。
 */
export interface ReloadEntryPort {
  readonly entryId: string
  /** `entry.options.name`（真机上通常是 `file://` URL）。 */
  readonly moduleName: string
  /** `entry.options.config.serverName`（MCP 行才有）。 */
  readonly serverName?: string
  /** `entry.fiber !== undefined`。为假 = import 期就没起来。 */
  readonly hasFiber: boolean
  /** 旧 runtime 的 fiber 个数（`hasFiber` 为假时是 0）。 */
  readonly oldFiberCount: number
  /** 当前相位（观测用，取不到就是 undefined）。 */
  readonly fiberState?: number
  /** 模块名能不能热重载：空、或 `cordis:` 前缀不行。 */
  readonly reloadable: boolean
  /** 第 6 步：dispose 旧 fiber。 */
  disposeOld(): Promise<void>
  /** 第 7 步：用新插件值挂载。apply 期抛错要冒到这里。 */
  mountFresh(plugin: unknown): Promise<void>
  /** 回滚：摘掉刚挂上的新 fiber。 */
  removeFresh(): Promise<void>
  /** 回滚：把**旧插件值**重新实例化。 */
  remountOld(): Promise<void>
  /** `entry.fiber === undefined` 那条路径：清完缓存后重新 init。 */
  refresh(): Promise<void>
}

/** 宿主侧全部能力（真实实现在 `reloadHostFrom`）。 */
export interface ReloadHost {
  /** T1：`loader.internal` 是否可用。 */
  internalAvailable(): boolean
  /** 模块缓存端口；`internal` 缺失时返回 `undefined`。 */
  cache(): ClosurePort | undefined
  /** 按 URL 解析 entry 的模块（T2）。 */
  resolveEntryUrl(entry: ReloadEntryPort): Promise<string>
  /** 第 5 步：`loader.import` + `unwrapExports`。 */
  importFresh(url: string): Promise<unknown>
  /** 树里**全部**候选 entry（匹配含 T4 的两个字段 + URL 归一）。 */
  candidates(): ReloadEntryPort[]
}

/** 闭包里最多列几个 URL（输出会进模型上下文，长列表是纯噪音）。 */
export const MAX_LISTED_MODULES = 40

/** 子串兜底匹配的最小长度：太短会匹配到一屏东西。 */
export const MIN_SUBSTRING_MATCH = 3

/** 是不是「给了且不是空白」。空串按**没给**处理 —— 模型常把可选参数填成 `""`。 */
function isNonEmpty(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * 把用户给的目标值归一成**匹配用的那个值**。
 *
 * 只有一处归一：`entryId` 上的 `include:` 前缀。为什么必须有它 ——
 * **`dsh_diagnose_plugin_load` 报出来的就是 `include:<id>`**，而匹配键那边用的是
 * `bareId(entry.id)`。不剥前缀，就等于「诊断的输出喂不回重载的输入」，
 * 报出来是 `no-match`，看着像「树里没有这个 entry」（真机上 verifier 就是这么撞的）。
 *
 * **URL 形态不剥**：`file:///C:/…` 的第一个冒号在 scheme 里，剥了就成了垃圾。
 * 所以判据是「不含 `://`」。
 *
 * @param kind 目标种类。
 * @param raw 用户给的原值。
 */
function normalizeTargetValue(kind: ReloadTargetKind, raw: string): string {
  const value = raw.trim()
  if (kind !== 'entryId') return value
  if (value.includes('://')) return value
  return bareId(value)
}

/**
 * 把工具参数解析成**恰好一个**目标。
 *
 * 不给、或给多于一者都**不猜** —— 返回一条结构化失败。猜的代价是重载错的插件，
 * 那是写侧工具最不能接受的一种失败（树被改坏且模型以为成功）。
 *
 * @param args 工具参数。
 */
export function parseReloadTarget(args: ReloadArgs): TargetParse {
  const given: ReloadTarget[] = []
  if (isNonEmpty(args.entryId)) {
    given.push({ kind: 'entryId', value: normalizeTargetValue('entryId', args.entryId) })
  }
  if (isNonEmpty(args.module)) {
    given.push({ kind: 'module', value: normalizeTargetValue('module', args.module) })
  }
  if (isNonEmpty(args.serverName)) {
    given.push({ kind: 'serverName', value: normalizeTargetValue('serverName', args.serverName) })
  }

  if (given.length === 0) {
    return {
      failure: {
        reason: 'bad-target',
        message: 'no target was given: exactly one of entryId, module, or serverName is required',
        verdict:
          'nothing was reloaded: no target was given, and this tool does not guess which plugin you meant',
      },
    }
  }
  if (given.length > 1) {
    const kinds = given.map((item) => item.kind).join(', ')
    return {
      failure: {
        reason: 'bad-target',
        message: `more than one target was given (${kinds}); they are alternatives, not filters`,
        verdict: `nothing was reloaded: more than one target was given (${kinds}); they are alternatives, not filters, so this tool cannot tell which one you meant`,
      },
    }
  }
  const only = given[0]
  return only === undefined ? {} : { target: only }
}

/**
 * 归一化一个匹配键：小写，并把 `-` / `_` / `.` 视为同一分隔符。
 *
 * @param value 原始键。
 */
export function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[-_.]+/gu, '-')
}

/**
 * 去掉 loader 的分组前缀（`include:` / `cordis:` …）。
 *
 * @param id 原始 entry id。
 */
export function bareId(id: string): string {
  const index = id.indexOf(':')
  return index === -1 ? id : id.slice(index + 1)
}

/**
 * 从一个模块名里抽出「用户嘴里的那个包名」。
 *
 * `entry.options.name` 在真机上是 `file://` URL，所以要能从中回推：
 * URL 末段（去扩展名）、以及 `node_modules/` 边界后的包名（scoped 名要连上 scope）。
 *
 * @param moduleName `entry.options.name`。
 */
export function moduleKeys(moduleName: string): string[] {
  const keys = new Set<string>()
  if (moduleName === '') return []
  keys.add(moduleName)

  const withoutScheme = moduleName.startsWith('file://') ? moduleName.slice('file://'.length) : moduleName
  const path = withoutScheme.replace(/^\/+/u, '')
  const last = path.split('/').pop()
  if (last !== undefined && last !== '') {
    keys.add(last)
    const dot = last.lastIndexOf('.')
    if (dot > 0) keys.add(last.slice(0, dot))
  }

  const marker = 'node_modules/'
  const index = path.lastIndexOf(marker)
  if (index !== -1) {
    const segments = path.slice(index + marker.length).split('/')
    const first = segments[0]
    if (first !== undefined && first !== '') {
      // scoped 包名要连上 scope 段：`@scope/pkg` 是**一个**包，不是两个。
      const isScoped = first.startsWith('@')
      const length = isScoped ? 2 : 1
      if (segments.length >= length) keys.add(segments.slice(0, length).join('/'))
    }
  }
  return [...keys]
}

/**
 * 一个 entry 的全部候选匹配键（T4）。
 *
 * `entryId` 走 {@link bareId}，模块名走 {@link moduleKeys} —— 两个字段都进集合，
 * 所以「按 id 查」「按包名查」「按 name 查」都能命中同一个 entry。
 *
 * @param entry 目标 entry。
 */
export function candidateKeys(entry: ReloadEntryPort): string[] {
  const keys = new Set<string>()
  keys.add(normalizeKey(bareId(entry.entryId)))
  keys.add(normalizeKey(entry.entryId))
  for (const key of moduleKeys(entry.moduleName)) keys.add(normalizeKey(key))
  if (entry.serverName !== undefined && entry.serverName !== '') {
    keys.add(normalizeKey(entry.serverName))
  }
  return [...keys].filter((key) => key !== '')
}

/** 匹配结果：命中列表（0 / 1 / 多个都要能让调用方分辨）。 */
export interface MatchOutcome {
  /** 精确命中的 entry。 */
  exact: ReloadEntryPort[]
  /** 没有精确命中时的子串命中。 */
  loose: ReloadEntryPort[]
}

/**
 * 在候选里找目标。
 *
 * 两轮：先**精确**（归一化后相等），再**子串**（≥3 字符）。分开是为了让
 * 「精确唯一命中」不受子串噪音影响 —— 否则一个短包名会把无关 entry 拖进来。
 *
 * **归一放在这里**（而不是只放在 `parseReloadTarget`）：机制层可能被直接调用
 * （测试、将来别的入口），而「`include:<id>` 匹配不上」是个**假阴性** ——
 * 看着像「树里没有这个 entry」。两边都归一，从哪个入口进来都一样。
 *
 * @param entries 全部候选。
 * @param target 目标。
 */
export function matchEntries(
  entries: readonly ReloadEntryPort[],
  target: ReloadTarget,
): MatchOutcome {
  const needle = normalizeKey(normalizeTargetValue(target.kind, target.value))
  const exact: ReloadEntryPort[] = []
  const loose: ReloadEntryPort[] = []
  for (const entry of entries) {
    const keys = candidateKeys(entry)
    if (keys.includes(needle)) {
      exact.push(entry)
      continue
    }
    if (needle.length >= MIN_SUBSTRING_MATCH && keys.some((key) => key.includes(needle))) {
      loose.push(entry)
    }
  }
  return { exact, loose }
}

/** 一行候选描述（用于「没命中 / 多个命中」的 message）。 */
export function describeCandidate(entry: ReloadEntryPort): string {
  const server = entry.serverName === undefined ? '' : `, serverName: ${entry.serverName}`
  return `${entry.entryId} (module: ${entry.moduleName}${server})`
}

/**
 * 收集要一起重新求值的**本地**模块闭包（§2.1 第 2 步）。
 *
 * 只收 entry 自己那一份：有 `node_modules/<pkg>` 边界时只留该包下的，
 * 否则丢掉任何 `node_modules` 子树 —— 依赖不会因为插件自己的代码改动而变，
 * 但清掉它们会把无关插件一起拖进来（§2.1 第 4 步的「不清整棵树」）。
 *
 * `node:` 内置模块永远跳过。
 *
 * @param cache 模块缓存端口。
 * @param entryUrl entry 的模块 URL。
 */
export async function collectClosure(cache: ClosurePort, entryUrl: string): Promise<string[]> {
  const packageRoot = packageRootOf(entryUrl)
  const files = new Set<string>()
  const seen = new Set<string>()

  const walk = async (url: string): Promise<void> => {
    if (seen.has(url)) return
    seen.add(url)
    if (url.startsWith('node:')) return
    if (packageRoot !== undefined) {
      if (!url.startsWith(packageRoot)) return
    } else if (url.includes('/node_modules/')) {
      return
    }
    files.add(url)
    for (const child of await cache.children(url)) await walk(child)
  }

  await walk(entryUrl)
  return [...files]
}

/**
 * 一条 URL 所属包的根目录（`node_modules/<name>` 边界，含 scoped 名）。
 *
 * @param url 模块 URL。
 */
export function packageRootOf(url: string): string | undefined {
  const marker = '/node_modules/'
  const index = url.lastIndexOf(marker)
  if (index === -1) return undefined
  const head = url.slice(0, index + marker.length)
  const segments = url.slice(index + marker.length).split('/')
  const first = segments[0]
  if (first === undefined || first === '') return undefined
  const length = first.startsWith('@') && segments.length > 1 ? 2 : 1
  return head + segments.slice(0, length).join('/')
}

/** 缓存备份：**回滚的唯一依据**（§2.1 第 3 步）。 */
export interface CacheBackup {
  /** 每个 URL + 它在缓存里现存的 job（真机上一个 URL 通常只有一条）。 */
  entries: Array<{ url: string; jobs: unknown[] }>
}

/**
 * 备份并清除这批 URL 的缓存项（§2.1 第 3–4 步，合并成一次遍历）。
 *
 * 只碰传入的这批 —— 「清多了会把无关插件一起拖进来」。
 *
 * @param cache 模块缓存端口。
 * @param urls 闭包里的 URL。
 */
export function backupAndClear(cache: ModuleCachePort, urls: readonly string[]): CacheBackup {
  const entries: Array<{ url: string; jobs: unknown[] }> = []
  for (const url of urls) {
    const jobs = cache.read(url)
    if (jobs.length === 0) continue
    entries.push({ url, jobs })
    cache.clear(url)
  }
  return { entries }
}

/**
 * 把备份放回缓存（import 期失败 / apply 期回滚都走它）。
 *
 * **绝不抛**，并如实返回「是不是全部放回去了」：
 * 这条路径本身跑在失败处理里，它再抛就会把**真正的原因**盖掉
 * （真机上就是这么把一个 import 语法错变成了 `internal` + Node 内部文案）。
 *
 * @param cache 模块缓存端口。
 * @param backup 备份。
 * @returns 是否**每一条都**成功放回。
 */
export function restoreCache(cache: ModuleCachePort, backup: CacheBackup): boolean {
  let complete = true
  for (const { url, jobs } of backup.entries) {
    for (const job of jobs) {
      if (!cache.write(url, job)) complete = false
    }
  }
  return complete
}

/**
 * 重载成功后落进工具 `data` 的**机制报告**。
 *
 * 它是 `key` / `audit` 两种投影的共同原料（工具层负责切），所以这里字段齐全。
 * **没有 `why`**：旧契约里那句话是「这次会怎么走」的解释，而新契约把它拆成两处 ——
 * 恒定知识（cordis 外资源会泄漏）进描述层边界段写一次，本次特有的动作进 `nextStep.why`。
 * 留一个没有消费者的字段就是「一处两事实」。
 */
export interface ReloadData {
  target: ReloadTarget
  entry: { entryId: string; moduleName: string; serverName?: string }
  dryRun: boolean
  moduleUrl: string
  /** 闭包里的模块数。 */
  moduleCount: number
  /** 实际被清出缓存的条数（备份里有多少条）。 */
  modulesCleared: number
  /** 闭包 URL（**只列前 {@link MAX_LISTED_MODULES} 条**）。 */
  modules: string[]
  modulesTruncated: boolean
  /** 旧 fiber 有没有被碰过 —— import 期失败分支的核心判据。 */
  oldFiberTouched: boolean
  oldFiberCount: number
  oldFiberState: number | null
  newFiberState: number | null
  rolledBack: boolean
  /** 结论（L1）。 */
  verdict: string
}

/**
 * `data.key` 的投影（L2）：**下一个决定可能要用到的**原料。
 *
 * 判据是 SHAPE §5 那句「模型看不到它，会不会做出不同的下一步？」——
 * 对写侧工具就是这三件：换的是哪个 entry、清了几格缓存、**要不要收拾**
 * （`oldFiberTouched` / `rolledBack`）。
 *
 * 字段**可缺省**是有意的：失败可能在「还没定出 entry」时就发生（`no-match` / 多目标），
 * 那时 key 是 `{}` —— 不许拿默认值（`rolledBack: false` 之类）去冒充「事实是安全的」。
 */
export interface ReloadKey {
  entry?: { entryId: string; moduleName: string; serverName?: string }
  dryRun?: boolean
  moduleUrl?: string
  moduleCount?: number
  modulesCleared?: number
  oldFiberTouched?: boolean
  oldFiberCount?: number
  oldFiberState?: number | null
  newFiberState?: number | null
  rolledBack?: boolean
}

/** 机制层的返回：要么报告，要么一条失败（失败也可带部分报告，供排查）。 */
export type ReloadOutcome =
  | { ok: true; data: ReloadData }
  | { ok: false; failure: ReloadFailure; data?: Partial<ReloadData> }

/** 一次调用的外部约束。 */
export interface ReloadRunOptions {
  dryRun: boolean
  signal?: AbortSignal | undefined
  /** 截止判据（沿用 `lib/timeouts.ts` 的 `createDeadline`）。 */
  expired: () => boolean
}

/**
 * 跑完 8 步算法。
 *
 * **绝不抛**：任何异常都在这里收敛成 `ok: false`。写侧工具抛异常最糟 ——
 * 树可能已经被改了一半，而调用方只看到一条栈。
 *
 * @param host 宿主侧能力。
 * @param target 目标。
 * @param options 外部约束。
 */
export async function hotReload(
  host: ReloadHost,
  target: ReloadTarget,
  options: ReloadRunOptions,
): Promise<ReloadOutcome> {
  // 第 1 步 —— 定位 entry。定位不到**什么都不动**。
  const entries = host.candidates()
  const match = matchEntries(entries, target)
  const hits = match.exact.length > 0 ? match.exact : match.loose
  if (hits.length === 0) {
    const listed = entries.slice(0, 8).map(describeCandidate).join('; ')
    return {
      ok: false,
      failure: {
        reason: 'no-match',
        message: `no loader entry matched ${target.kind} "${target.value}" among ${String(entries.length)} entries`,
        verdict:
          entries.length === 0
            ? `nothing was reloaded: no entry could be matched, and the loader tree came back empty — check the package name and that the host context exposes a loader`
            : `nothing was reloaded: no entry matched ${target.kind} "${target.value}" among ${String(entries.length)} entries — use an exact entryId from dsh_diagnose_plugin_load (first few: ${listed})`,
      },
    }
  }
  if (hits.length > 1) {
    const listed = hits.slice(0, 8).map(describeCandidate).join('; ')
    return {
      ok: false,
      failure: {
        reason: 'ambiguous',
        message: `${String(hits.length)} entries matched ${target.kind} "${target.value}"; this tool does not guess which one you meant`,
        verdict: `nothing was reloaded: ${String(hits.length)} entries matched ${target.kind} "${target.value}", so this tool cannot tell which one you meant — pass the exact entryId instead (candidates: ${listed})`,
      },
    }
  }
  const entry = hits[0]
  if (entry === undefined) {
    return {
      ok: false,
      failure: {
        reason: 'no-match',
        message: `no loader entry matched ${target.kind} "${target.value}"`,
        verdict: `nothing was reloaded: no loader entry matched ${target.kind} "${target.value}"`,
      },
    }
  }

  const base = baseReport(entry, target, options.dryRun)

  if (!entry.reloadable) {
    return {
      ok: false,
      failure: {
        reason: 'not-reloadable',
        message: `entry "${entry.entryId}" has no reloadable module name (module is "${entry.moduleName}")`,
        verdict: `nothing was reloaded: entry "${entry.entryId}" has no reloadable module name, so it cannot be swapped in place — a restart is the only way`,
      },
      data: base,
    }
  }

  // T1：`internal` 拿不到就没有模块缓存访问权 —— 这不是配置问题，是宿主能力问题。
  if (!host.internalAvailable()) {
    return {
      ok: false,
      failure: {
        reason: 'no-internal',
        message:
          'this host exposes no internal module loader access, so module caches cannot be busted and code cannot be re-imported in place',
        verdict:
          'nothing was reloaded: this host exposes no internal module loader access, so the module cache cannot be busted in place — a restart is the only way',
      },
      data: base,
    }
  }

  if (isAborted(options.signal)) {
    return {
      ok: false,
      failure: {
        reason: 'cancelled',
        message: 'the caller cancelled this hot reload before the module cache was touched',
        verdict:
          'nothing was reloaded: the caller cancelled this call before any cache entry was cleared or any fiber was touched',
      },
      data: base,
    }
  }
  if (options.expired()) {
    return {
      ok: false,
      failure: {
        reason: 'timeout',
        message: 'the tool budget ran out before the hot reload could start',
        verdict:
          'nothing was reloaded: the tool budget ran out before the reload started, so the running tree is exactly as it was',
      },
      data: base,
    }
  }

  // T2：解析 entry 的模块 URL。
  let moduleUrl: string
  try {
    moduleUrl = await host.resolveEntryUrl(entry)
  } catch (error) {
    return {
      ok: false,
      failure: {
        reason: 'not-reloadable',
        message: `cannot resolve the module URL for entry "${entry.entryId}": ${messageOf(error)}`,
        verdict: `nothing was reloaded: the module URL for entry "${entry.entryId}" could not be resolved, so the code on disk was never imported`,
      },
      data: base,
    }
  }

  const cache = host.cache()
  if (cache === undefined) {
    return {
      ok: false,
      failure: {
        reason: 'no-internal',
        message: 'the internal module loader exposes no loadCache, so the module closure cannot be collected',
        verdict:
          'nothing was reloaded: the internal module loader exposes no loadCache, so the module closure cannot be collected — a restart is the only way',
      },
      data: { ...base, moduleUrl },
    }
  }

  // 第 2 步 —— 提取本地闭包（只读）。
  let files: string[]
  try {
    files = await collectClosure(cache, moduleUrl)
  } catch (error) {
    return {
      ok: false,
      failure: {
        reason: 'not-reloadable',
        message: `cannot walk the module closure of "${moduleUrl}": ${messageOf(error)}`,
        verdict: `nothing was reloaded: the module closure of "${moduleUrl}" could not be walked, so nothing was cleared and no fiber was touched`,
      },
      data: { ...base, moduleUrl },
    }
  }

  const listed = files.slice(0, MAX_LISTED_MODULES)
  const withClosure: Partial<ReloadData> = {
    ...base,
    moduleUrl,
    moduleCount: files.length,
    modules: listed,
    modulesTruncated: files.length > listed.length,
  }

  // dryRun：到这里为止全是**只读**的（entries / resolve / 闭包遍历），树一格没动。
  if (options.dryRun) {
    return {
      ok: true,
      data: {
        ...(withClosure as ReloadData),
        modulesCleared: 0,
        verdict: dryRunVerdict(entry, files.length),
      },
    }
  }

  // 第 3–4 步 —— 备份 + 只清那批。
  const backup = backupAndClear(cache, files)
  const cleared: Partial<ReloadData> = { ...withClosure, modulesCleared: backup.entries.length }

  // 第 5 步 —— **先 import**。新代码成功之前绝不碰旧 fiber。
  let fresh: unknown
  try {
    fresh = await host.importFresh(moduleUrl)
  } catch (error) {
    // import 期失败：旧 fiber 从未被碰过，把缓存放回再报错。
    // ⚠️ 放回失败**不影响**这条结论（旧 fiber 确实没被碰）—— 但要说出去，
    // 因为它意味着那份模块下次会被重新求值。**绝不让它盖掉 import 的真原因**。
    const restored = restoreCache(cache, backup)
    return {
      ok: false,
      failure: {
        reason: 'import-failed',
        message: `the new code failed to import: ${messageOf(error)}`,
        verdict: restored
          ? 'the running entry was never touched — nothing to undo; fix the import error on disk and call again'
          : 'the running entry was never touched — nothing to undo; fix the import error and call again, ' +
            'but note that the module cache could not be fully restored, so restart the host when convenient',
      },
      data: { ...(cleared as ReloadData), oldFiberTouched: false, rolledBack: false },
    }
  }

  if (isAborted(options.signal)) {
    const restored = restoreCache(cache, backup)
    return {
      ok: false,
      failure: {
        reason: 'cancelled',
        message: 'the caller cancelled this hot reload after the module cache had been cleared',
        verdict: restored
          ? 'the reload was abandoned mid-way: the caller gave up on purpose, the module cache was put back, and the running entry was never touched'
          : 'the reload was abandoned mid-way: the caller gave up on purpose and the running entry was never touched, but the module cache could not be fully restored — restart the host when convenient',
      },
      data: cleared as ReloadData,
    }
  }

  // 第 6–7 步 —— 再 dispose 旧 fiber、挂载新的。两步同一个 try：
  // dispose 成功而挂载失败时，回滚必须连「摘掉新 fiber」一起做。
  let oldFiberTouched = false
  try {
    if (!entry.hasFiber) {
      // fiber 从未起来过：缓存已经清了，重新 init 就会吃到新代码。
      oldFiberTouched = false
      await entry.refresh()
    } else {
      await entry.disposeOld()
      oldFiberTouched = true
      await entry.mountFresh(fresh)
    }
  } catch (error) {
    // apply 期失败：从备份回滚，并把**旧版本重新实例化**。
    const rolledBack = await rollback(entry, cache, backup, oldFiberTouched)
    return {
      ok: false,
      failure: {
        reason: 'apply-failed',
        message: `the new code failed while being applied: ${messageOf(error)}`,
        verdict: rolledBack
          ? 'the previous code was put back and is active again — fix the apply-time error and call again'
          : 'rollback did not complete: the previous code is not confirmed active, so the running tree may be half-swapped — restart the host to get back to a known state',
      },
      data: { ...(cleared as ReloadData), oldFiberTouched, rolledBack },
    }
  }

  const state = entry.fiberState ?? null
  return {
    ok: true,
    data: {
      ...(cleared as ReloadData),
      oldFiberTouched,
      newFiberState: state,
      rolledBack: false,
      verdict: successVerdict(entry, backup.entries.length, oldFiberTouched),
    },
  }
}

/**
 * apply 期失败的回滚：摘新 fiber → 重挂旧插件 → 放回缓存。
 *
 * 三步都**尽力而为**：任何一步再抛都不能盖掉原始失败（那会让模型看到错的原因）。
 *
 * @param entry 目标 entry。
 * @param cache 模块缓存端口。
 * @param backup 备份。
 * @param oldFiberTouched 旧 fiber 是否已经被 dispose 过（决定要不要重挂）。
 * @returns 回滚是否**完整**走完。
 */
async function rollback(
  entry: ReloadEntryPort,
  cache: ModuleCachePort,
  backup: CacheBackup,
  oldFiberTouched: boolean,
): Promise<boolean> {
  let complete = true
  try {
    await entry.removeFresh()
  } catch {
    complete = false
  }
  if (oldFiberTouched) {
    try {
      await entry.remountOld()
    } catch {
      complete = false
    }
  }
  // restoreCache 自己绝不抛，返回的是「是否全部放回」。
  if (!restoreCache(cache, backup)) complete = false
  return complete
}

/**
 * 造报告骨架（失败路径也要能带回已查到的事实）。
 *
 * @param entry 目标 entry。
 * @param target 目标。
 * @param dryRun 是否干跑。
 */
function baseReport(entry: ReloadEntryPort, target: ReloadTarget, dryRun: boolean): ReloadData {
  return {
    target,
    entry: {
      entryId: entry.entryId,
      moduleName: entry.moduleName,
      ...(entry.serverName === undefined ? {} : { serverName: entry.serverName }),
    },
    dryRun,
    moduleUrl: '',
    moduleCount: 0,
    modulesCleared: 0,
    modules: [],
    modulesTruncated: false,
    oldFiberTouched: false,
    oldFiberCount: entry.oldFiberCount,
    oldFiberState: entry.fiberState ?? null,
    newFiberState: null,
    rolledBack: false,
    verdict: '',
  }
}

/**
 * 成功时的一句话结论（L1）。
 *
 * **不带 `verdict: ` 前缀**：渲染层已经用 `verdict: ` 起行（SHAPE §3.1），
 * 留着前缀就会出现 `verdict: verdict: entry=…`。
 *
 * @param entry 目标 entry。
 * @param cleared 清掉的模块数。
 * @param oldFiberTouched 旧 fiber 有没有被 dispose 过。
 */
function successVerdict(entry: ReloadEntryPort, cleared: number, oldFiberTouched: boolean): string {
  return (
    `entry=${entry.entryId} · swapped=${String(cleared)} modules · ` +
    `oldFiberTouched=${String(oldFiberTouched)} · rolledBack=false`
  )
}

/**
 * 干跑时的一句话结论。
 *
 * @param entry 目标 entry。
 * @param count 闭包里的模块数。
 */
function dryRunVerdict(entry: ReloadEntryPort, count: number): string {
  return `entry=${entry.entryId} · wouldSwap=${String(count)} modules · dryRun=true (nothing was touched)`
}

/**
 * 信号是否已取消。
 *
 * @param signal 调用方信号。
 */
// `isAborted` / `asRecord` / `asFunction` / `asString` 的唯一实现在 errors.ts
// （2026-10-16 审计 A3 / A4 收敛，本文件原有四份已删）。

/**

/**
 * 把机制的失败原因映射成工具的闭枚举 `kind`。
 *
 * 映射集中一处，是为了让「机制层不知道工具的 kind 集合」这条分层成立，
 * 同时 `kind` 的选择仍然只有一个落点可审。
 *
 * @param reason 机制层原因。
 */
export function kindForReason(
  reason: ReloadFailureReason,
): 'not-found' | 'not-configured' | 'cancelled' | 'timeout' | 'reload-failed' {
  switch (reason) {
    case 'bad-target':
    case 'no-match':
    case 'ambiguous':
      return 'not-found'
    case 'no-internal':
    case 'not-reloadable':
      return 'not-configured'
    case 'cancelled':
      return 'cancelled'
    case 'timeout':
      return 'timeout'
    default:
      // import / apply 两档都归 `reload-failed`：树**没被换成功**，而
      // `verdict` 与 `key` 里说清了旧 fiber 有没有被碰、有没有回滚 —— 那才是模型要读的。
      return 'reload-failed'
  }
}

/**
 * 把机制层结果转成工具结果（含 `nextStep`）。
 *
 * `data` 顶层恰好三键，**成功与失败同形**（B21）：
 * - `verdict` ← `failure.verdict`（失败）或 `outcome.data.verdict`（成功）；
 * - `key`     ← 要模型决策的原料（`ReloadKey`）；
 * - `audit`   ← 其余（给人复核，不进模型文本）。
 *
 * @param outcome 机制层结果。
 */
export function outcomeToToolResult(outcome: ReloadOutcome): ToolResult<ReloadKey> {
  if (outcome.ok) {
    return ok(
      { verdict: outcome.data.verdict, key: keyOf(outcome.data), audit: auditOf(outcome.data) },
      reloadNextStep(outcome.data),
    )
  }
  const failure = outcome.failure
  return fail(
    { kind: kindForReason(failure.reason), message: failure.message },
    {
      verdict: failure.verdict,
      key: keyOf(outcome.data),
      audit: auditOf(outcome.data),
    },
    verifyNextStep(outcome.data),
  )
}

/**
 * 把机制报告投影成 `key`（L2）：**下一个决定可能要用到的**。
 *
 * 为什么只这几项：SHAPE §5 的判据 —— 模型看不到它会不会做出不同的下一步？
 * 「换的是哪个 entry」「清了几格缓存」「**要不要收拾**（旧 fiber 有没有被碰、有没有回滚）」
 * 会；闭包 URL 列表（最多 40 条）不会 → 它进 `audit`。
 *
 * **不许拿默认值冒充事实**：`data` 缺省时（还没定出 entry 的失败）返回 `{}`，
 * 而不是 `{ rolledBack: false }` —— 后者会让「不知道」看起来像「安全」。
 *
 * @param data 机制层已经算好的报告（失败路径上可以有）。
 */
function keyOf(data: Partial<ReloadData> | undefined): ReloadKey {
  if (data === undefined) return {}
  const key: ReloadKey = {}
  if (data.entry !== undefined) key.entry = data.entry
  if (data.dryRun !== undefined) key.dryRun = data.dryRun
  // 空串 = 这次没解析出模块 URL，印出来只是一条空行（噪声）——不当成事实。
  if (data.moduleUrl !== undefined && data.moduleUrl !== '') key.moduleUrl = data.moduleUrl
  if (data.moduleCount !== undefined) key.moduleCount = data.moduleCount
  if (data.modulesCleared !== undefined) key.modulesCleared = data.modulesCleared
  if (data.oldFiberTouched !== undefined) key.oldFiberTouched = data.oldFiberTouched
  if (data.oldFiberCount !== undefined) key.oldFiberCount = data.oldFiberCount
  if (data.oldFiberState !== undefined) key.oldFiberState = data.oldFiberState
  if (data.newFiberState !== undefined) key.newFiberState = data.newFiberState
  if (data.rolledBack !== undefined) key.rolledBack = data.rolledBack
  return key
}

/**
 * 造 `audit`（给人复核；不进模型文本，所以列出全部原始记录）。
 *
 * 闭包 URL 列表住在这里：它最多 40 条，模型拿着也做不了下一个决定。
 *
 * @param data 机制层报告。
 */
function auditOf(data: Partial<ReloadData> | undefined): JsonValue {
  if (data === undefined) return {}
  return {
    ...(data.target === undefined ? {} : { target: data.target as unknown as JsonValue }),
    ...(data.moduleUrl === undefined ? {} : { moduleUrl: data.moduleUrl }),
    ...(data.moduleCount === undefined ? {} : { moduleCount: data.moduleCount }),
    ...(data.modules === undefined ? {} : { modules: data.modules }),
    ...(data.modulesTruncated === undefined ? {} : { modulesTruncated: data.modulesTruncated }),
    ...(data.oldFiberCount === undefined ? {} : { oldFiberCount: data.oldFiberCount }),
    ...(data.oldFiberState === undefined ? {} : { oldFiberState: data.oldFiberState }),
  }
}

/**
 * 成功后的下一步：让调用方**自己去看**新 fiber 到没到 active。
 *
 * @param data 报告。
 */
function reloadNextStep(data: ReloadData): NextStep {
  return {
    tool: 'dsh_diagnose_plugin_load',
    args: { package: data.entry.moduleName },
    why: 'confirm the new fiber reached active — this tool reports what it did, not what the host ended up with',
  }
}

/**
 * 失败后的下一步：旧 fiber 应该还在（import 期）或被放回（apply 期），去看一眼。
 *
 * @param data 可能的报告片段。
 */
function verifyNextStep(data: Partial<ReloadData> | undefined): NextStep {
  const moduleName = data?.entry?.moduleName
  return {
    tool: 'dsh_diagnose_plugin_load',
    ...(moduleName === undefined ? {} : { args: { package: moduleName } }),
    why:
      'check the observed fiber phase for this entry: on an import failure the old fiber should still be active, ' +
      'and after a rollback the previous version should be back',
  }
}

/**
 * 把任意异常收敛成工具失败（兜底分支用，保证 `execute` 绝不抛）。
 *
 * 这条兜底是**唯一**允许产出 `internal` 的路径（B24 用它证明「异常不会漏出去」）。
 * 它必须给出实质 `verdict`：模型看不到 `error.message`，只看到这一行 ——
 * 而这里的诚实答案恰恰是「我不知道走到哪一步了」（本模块的算法正常路径绝不抛，
 * 所以一旦抛出来，说明是本插件自己的 bug，树有多少被改动**无法从这个错误推断**）。
 *
 * `key` 是 `{}`：**没有任何可靠的可供决策的观测** —— 不拿 `rolledBack: false`
 * 之类的默认值冒充「树是安全的」。
 *
 * @param error 捕获到的异常。
 */
export function reloadInternalFailure(error: unknown): ToolResult<ReloadKey> {
  const toolError = toToolError(error, 'hot reload')
  return fail(toolError, {
    verdict:
      'this call failed before it could report an outcome, so how far the swap got is unknown — do not retry blindly; check the observed phase of the entry first',
    key: {},
    audit: { internalError: toolError.message },
  })
}

/* ------------------------------------------------------------------ *
 * 宿主适配层：结构化访问，不 import Cordis
 * ------------------------------------------------------------------ */

/** 把原始 entry 挂在端口对象上的私有键（只在本模块内可见）。 */
const RAW = Symbol('hotReloadRawEntry')

/** 带原始 entry 的端口。 */
interface BoundEntry extends ReloadEntryPort {
  [RAW]: unknown
}

/** 取一个对象的记录视图；数组/函数/null 都算不合格。 */
// （isAborted 等类型守卫的正典在 errors.ts；iterate 的唯一实现在 loader.ts ——
//  2026-10-16 审计 A2 收敛，本文件原有的一份逐字副本已删。）

/** 读一个属性；getter 抛错时当作没有。 */
function safeGet(target: unknown, key: string): unknown {
  const record = asRecord(target)
  if (record === undefined) return undefined
  try {
    return record[key]
  } catch {
    return undefined
  }
}

/**
 * 取 `loader.internal`（T1）。
 *
 * 拿不到就是宿主没给这条路 —— 调用方据此报 `no-internal` 并建议重启，
 * **不是**抛异常（写侧工具抛异常最难收拾）。
 *
 * @param loader loader 服务。
 */
function internalOf(loader: unknown): Record<string, unknown> | undefined {
  return asRecord(safeGet(loader, 'internal'))
}

/**
 * 真机 `LoadCache` 认识的模块 type。
 *
 * 实测（2026-10-13，本机 `0.2.1-alpha.2`，node **24.18.0**）：槽字典的键就是
 * `['javascript']`，且 `Object.getPrototypeOf(slot) === null`。
 *
 * **但这里不把 `'javascript'` 写死成唯一答案** —— 它是**候选表**，
 * 真正用哪个由 {@link cachePortOf} 里那次**回读校验**决定（见 `write`）。
 * 写死一个值意味着宿主换 type 名就静默失效，而回读校验不会。
 */
const MODULE_TYPES = ['javascript', 'commonjs', 'module'] as const

/**
 * 从一个 URL 的缓存槽里取出 ModuleJob。
 *
 * Node 22/23 直接存 job；24+（本机 v2）存 `{ [type]: ModuleJob }` 的形状。
 * 两种都要认 —— 认不出的形状返回 `undefined`，由调用方当「没读到」处理，**不抛**。
 *
 * @param slot 缓存槽。
 */
function moduleJobOf(slot: unknown): Record<string, unknown> | undefined {
  const record = asRecord(slot)
  if (record === undefined) return undefined
  if ('linked' in record || 'url' in record) return record
  const direct = record['javascript'] ?? record['commonjs'] ?? record['module']
  const candidate = direct ?? Object.values(record)[0]
  return asRecord(candidate)
}

/**
 * 把 `internal.loadCache` 包成 {@link ClosurePort}。
 *
 * ## 关键：`set` 的第二个参数是 `type`，不是值
 *
 * 真机 `LoadCache.set(url, type, job)` 会对 `type` 做 `validateString`。
 * 传 `(url, job)` 就是本轮真机红的根因（job 被当成 type）。
 * 所以 `write` **先挑一个 type，写进去，再回读确认** —— 校验过的成功才算成功。
 *
 * ## 只调对象自己的方法
 *
 * `instanceof Map === false`（实测：原型链 `[LoadCache, SafeMap]` 就断了，
 * `SafeMap.prototype` 的原型是 `null`），所以 `Map.prototype.*.call` 那条参考实现的路子
 * 在本机**不成立** —— 这里一次都不碰 `Map.prototype`。
 *
 * @param internal `loader.internal`。
 */
function cachePortOf(internal: Record<string, unknown>): ClosurePort | undefined {
  const cache = safeGet(internal, 'loadCache')
  const get = asFunction(safeGet(cache, 'get'))
  const set = asFunction(safeGet(cache, 'set'))
  const remove = asFunction(safeGet(cache, 'delete'))
  if (cache === undefined || cache === null || get === undefined || set === undefined || remove === undefined) {
    return undefined
  }

  /** 按已知 type 逐个读；`get(url, type)` 在真机上返回该 type 的 job。 */
  const readOne = (url: string, type: string): unknown => {
    try {
      return get.call(cache, url, type)
    } catch {
      return undefined
    }
  }

  /**
   * 一个参数的 `get(url)`。
   *
   * 两种形状下都返回**job**：Node 24 走默认 type 取 `slot[type]`；22/23 是裸 job。
   * 但它在真机上**取不到 type 名**，所以只在按 type 读全空时用作兜底。
   */
  const readImplicit = (url: string): unknown => {
    try {
      return get.call(cache, url)
    } catch {
      return undefined
    }
  }

  const port: ClosurePort = {
    read: (url) => {
      const jobs: unknown[] = []
      for (const type of MODULE_TYPES) {
        const job = readOne(url, type)
        if (job !== undefined && job !== null) jobs.push(job)
      }
      if (jobs.length > 0) return jobs
      const implicit = readImplicit(url)
      return implicit === undefined || implicit === null ? [] : [implicit]
    },

    write: (url, job) => {
      // 挑一个 type 写进去，然后**回读确认**。校验不过就试下一个 ——
      // 这样换 type 名不会静默失效，而「写不进去」也不会被谎报成成功。
      for (const type of MODULE_TYPES) {
        try {
          set.call(cache, url, type, job)
        } catch {
          continue
        }
        if (readOne(url, type) === job) return true
      }
      // 兜底：隐式 type（Node 22/23 的裸 job 形状，或 type 不在候选表里）。
      try {
        set.call(cache, url, MODULE_TYPES[0], job)
        return readImplicit(url) === job
      } catch {
        return false
      }
    },

    clear: (url) => {
      // 真机 `delete(url, type)` 是**逐 type 置 undefined**（不是删键），
      // 所以要按已知的 type 各清一次；再补一次隐式 type。
      for (const type of MODULE_TYPES) {
        try {
          remove.call(cache, url, type)
        } catch {
          // 这个 type 清不动不影响别的 type。
        }
      }
      try {
        remove.call(cache, url)
      } catch {
        // 隐式 type 那条清不动就到此为止 —— clear 的契约是不抛。
      }
    },

    children: async (url) => {
      const job = moduleJobOf(port.read(url)[0])
      if (job === undefined) return []
      let linked: unknown
      try {
        linked = await (job['linked'] as Promise<unknown> | undefined)
      } catch {
        // 模块**刚抛过**时 `linked` 可能是个已拒绝的 promise —— 当作没有子模块。
        return []
      }
      const urls: string[] = []
      for (const request of iterate(linked)) {
        const child = asString(safeGet(request, 'url'))
        if (child !== undefined) urls.push(child)
      }
      return urls
    },
  }
  return port
}

/**
 * 把宿主的活 entry 绑成一个 {@link ReloadEntryPort}。
 *
 * @param raw 宿主 entry 对象。
 */
function bindEntry(raw: unknown): BoundEntry | undefined {
  const record = asRecord(raw)
  if (record === undefined) return undefined
  const options = asRecord(safeGet(record, 'options'))
  const entryId = asString(safeGet(options, 'id')) ?? asString(safeGet(record, 'id'))
  if (entryId === undefined || entryId === '') return undefined
  const moduleName = asString(safeGet(options, 'name')) ?? ''
  const serverName = asString(safeGet(safeGet(options, 'config'), 'serverName'))

  const fiber = safeGet(record, 'fiber')
  const fiberRecord = asRecord(fiber)
  const runtime = asRecord(safeGet(fiberRecord, 'runtime'))

  // `runtime.fibers` 是宿主自己的 `DisposableList`（§6.6 实测 len=1，**不是数组**），
  // 所以同样按 Symbol.iterator 取；取不到就退化成「就这一个 fiber」。
  const runtimeFibers: unknown[] = []
  for (const item of iterate(safeGet(runtime, 'fibers'))) runtimeFibers.push(item)
  const oldFibers = runtimeFibers.length > 0 ? runtimeFibers : fiber === undefined ? [] : [fiber]

  const oldPlugin = safeGet(runtime, 'callback')
  let created: unknown[] = []

  const disposeFibers = async (fibers: readonly unknown[]): Promise<void> => {
    await Promise.all(
      fibers.map(async (item) => {
        const dispose = asFunction(safeGet(item, 'dispose'))
        if (dispose !== undefined) await (dispose.call(item) as Promise<void>)
      }),
    )
  }

  /** 在一个旧 fiber 的上下文里挂一个插件值，并把 entry 指向新 fiber。 */
  const mountOn = async (plugin: unknown, old: unknown): Promise<unknown> => {
    const parent = safeGet(old, 'parent')
    const registry = safeGet(parent, 'registry')
    const pluginFn = asFunction(safeGet(registry, 'plugin'))
    if (pluginFn === undefined) throw new Error('the fiber has no registry.plugin to mount through')
    const config = safeGet(old, '_config')
    const createdFiber = pluginFn.call(registry, plugin, config, undefined)
    // 新 fiber 要接管同一个 entry：entry.fiber 指向它，未来的 update 才找得到人。
    try {
      ;(createdFiber as Record<string, unknown>)['entry'] = safeGet(old, 'entry')
      const entry = safeGet(createdFiber, 'entry')
      if (entry !== undefined && entry !== null) {
        ;(entry as Record<string, unknown>)['fiber'] = createdFiber
      }
    } catch {
      // 只读属性：挂载照常进行，只是 entry 指针没改。
    }
    return createdFiber
  }

  const port: BoundEntry = {
    [RAW]: raw,
    entryId,
    moduleName,
    ...(serverName === undefined ? {} : { serverName }),
    hasFiber: fiberRecord !== undefined,
    oldFiberCount: oldFibers.length,
    ...(typeof safeGet(fiberRecord, 'state') === 'number'
      ? { fiberState: safeGet(fiberRecord, 'state') as number }
      : {}),
    reloadable: moduleName !== '' && !moduleName.startsWith('cordis:'),

    disposeOld: async () => {
      await disposeFibers(oldFibers)
    },

    mountFresh: async (plugin) => {
      created = []
      for (const old of oldFibers) created.push(await mountOn(plugin, old))
      // 等新 fiber settle：apply 期抛错必须在这里冒出来，否则回滚分支永远不会走到。
      await Promise.all(
        created.map(async (item) => {
          const awaitFn = asFunction(safeGet(item, 'await'))
          if (awaitFn !== undefined) await (awaitFn.call(item) as Promise<void>)
        }),
      )
    },

    removeFresh: async () => {
      await disposeFibers(created)
      created = []
    },

    remountOld: async () => {
      created = []
      for (const old of oldFibers) created.push(await mountOn(oldPlugin, old))
    },

    refresh: async () => {
      const refreshFn = asFunction(safeGet(record, 'refresh'))
      if (refreshFn === undefined) throw new Error('this entry has no refresh()')
      await (refreshFn.call(record) as Promise<void>)
    },
  }
  return port
}

/**
 * 把活的宿主 `ctx` 绑成一个 {@link ReloadHost}。
 *
 * 与 `loaderFrom` 同一个范式：**只做结构化访问、不 import Cordis**，
 * 于是本文件可以脱离宿主单测，而真实实现只在这里绑一次。
 *
 * @param ctx 宿主上下文。
 */
export function reloadHostFrom(ctx: unknown): ReloadHost {
  const loader = (): unknown => loaderFrom(ctx)

  return {
    internalAvailable: () => {
      const internal = internalOf(loader())
      return internal !== undefined && asFunction(safeGet(internal, 'import')) !== undefined
    },

    cache: () => {
      const internal = internalOf(loader())
      return internal === undefined ? undefined : cachePortOf(internal)
    },

    candidates: () => {
      const entriesFn = asFunction(safeGet(loader(), 'entries'))
      if (entriesFn === undefined) return []
      let raw: unknown
      try {
        raw = entriesFn.call(loader())
      } catch {
        return []
      }
      const ports: ReloadEntryPort[] = []
      for (const item of iterate(raw)) {
        const port = bindEntry(item)
        if (port !== undefined) ports.push(port)
      }
      return ports
    },

    resolveEntryUrl: async (entry) => {
      const raw = (entry as BoundEntry)[RAW]
      const name = entry.moduleName
      // T4：真机上 `entry.options.name` **本身就是 `file://` URL**。
      if (name.startsWith('file://')) return name

      const internal = internalOf(loader())
      const baseUrl =
        asString(safeGet(safeGet(safeGet(safeGet(raw, 'parent'), 'tree'), 'ctx'), 'baseUrl')) ?? ''
      const specifier = name === '' ? entry.entryId : name

      // T2：`resolveSync` 对 URL 形式的 name 会失败；失败就回落 `new URL(name, baseUrl)`。
      const resolveSync = asFunction(safeGet(internal, 'resolveSync'))
      if (resolveSync !== undefined && baseUrl !== '') {
        try {
          const resolved = resolveSync.call(internal, baseUrl, { specifier, attributes: {} })
          const url = asString(safeGet(resolved, 'url'))
          if (url !== undefined) return url
        } catch {
          // 继续往下回落
        }
      }
      const resolve = asFunction(safeGet(internal, 'resolve'))
      if (resolve !== undefined && baseUrl !== '') {
        try {
          const resolved = await (resolve.call(internal, specifier, baseUrl, {}) as Promise<unknown>)
          const url = asString(safeGet(resolved, 'url'))
          if (url !== undefined) return url
        } catch {
          // 继续往下回落
        }
      }
      try {
        return new URL(specifier, baseUrl).href
      } catch {
        throw new Error(`cannot resolve module "${specifier}" against base URL "${baseUrl}"`)
      }
    },

    importFresh: async (url) => {
      const current = loader()
      const importFn = asFunction(safeGet(current, 'import'))
      if (importFn === undefined) throw new Error('the loader service has no import()')
      const namespace = await (importFn.call(current, url, undefined) as Promise<unknown>)
      const unwrap = asFunction(safeGet(current, 'unwrapExports'))
      return unwrap === undefined ? namespace : unwrap.call(current, namespace)
    },
  }
}
