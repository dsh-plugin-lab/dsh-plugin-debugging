/**
 * 读宿主 Loader 树 —— **唯一的 IO 层**，且**只读、绝不抛**。
 *
 * 与 `lib/fiber.ts` 的分工：那边是**纯投影**（一个 entry 形状 → 一档判定，零 IO），
 * 这边只负责「把宿主那棵活树的字段安全地抄成一个纯形状」。
 * 分开的好处是：判定语义可以脱离宿主直接单测，而这里的所有失败都收敛成
 * `{ ok: false, reason }`，由调用方决定降级。
 *
 * ## 这是内部 primitive，不是公开契约
 *
 * 读的是 `ctx.get('loader')` → `loader.entries()` → `entry.fiber.state` 这条链
 * （verifier 实测：插件侧可见、**无需声明 `inject`**；见 AGENTS.md 活跃坑第 19 条）。
 * 宿主自己启动审计（`dsh-app-boot` 的 `inactiveEntries()`，0.2.1-alpha.2 `lib/index.js:4043-4107`）
 * 走的就是同一条链 —— 但它是**宿主内部**的实现，不是给插件用的 API。
 *
 * **因此本文件的每一个字段读取都必须容错**：宿主换个字段名、把 `fiber` 挪走、
 * 甚至不装 loader，结果都必须是「降级成推断」，**不是**抛异常。
 *
 * ## 为什么不 `import '@deepseek-ai/dsh-host-plugin-inventory'`
 *
 * verifier 实测（同文件 §4 Q3）：裸名 import 报 `ERR_MODULE_NOT_FOUND` ——
 * 那个包装在宿主的**内层** `node_modules`，插件的解析路径里一条都没有它。
 * 绝对路径能 import 成，但等于把宿主安装位置写死，跨机器必崩。
 * 所以这里自己投影，只取判定要用的几行。
 */
import { FIBER_STATE, type LoaderEntrySnapshot } from './fiber.js'
import { asFunction, asRecord, asString, messageOf } from './errors.js'

/** 读 Loader 的结果：要么拿到快照，要么带一个**可展示的原因**降级。 */
export interface LoaderReadResult {
  ok: boolean
  /** `ok` 为假时，为什么没读到（会原样进工具输出，所以要说人话）。 */
  reason?: string
  /** `ok` 为真时的 entry 快照（可能为空数组 = 树里一行都没有）。 */
  entries: LoaderEntrySnapshot[]
}

/**
 * 从宿主上下文里取 loader 服务。
 *
 * 用 `ctx.get('loader')` 而不是 `ctx.loader`：本插件**没有**声明 `inject: ['loader']`，
 * 而 `ctx.get` 是那种「没有就返回 undefined」的探询式访问（本仓 `src/index.ts` 的
 * `optionalService` 是同一个写法）。写成属性访问会在缺服务时抛。
 *
 * @param ctx 宿主上下文（可能是单测替身）。
 */
export function loaderFrom(ctx: unknown): unknown {
  const get = asFunction(asRecord(ctx)?.['get'])
  if (get === undefined) return undefined
  try {
    return get.call(ctx, 'loader')
  } catch {
    return undefined
  }
}

/**
 * 把一个 loader 服务读成 entry 快照数组。
 *
 * **绝不抛**：任何一步出问题都返回 `ok: false` + 原因。
 *
 * @param loader `ctx.get('loader')` 的返回值。
 */
export function readLoaderEntries(loader: unknown): LoaderReadResult {
  if (loader === undefined || loader === null) {
    return { ok: false, reason: 'the host has no loader service (ctx.get(\'loader\') returned nothing)', entries: [] }
  }
  const entriesFn = asFunction(asRecord(loader)?.['entries'])
  if (entriesFn === undefined) {
    return { ok: false, reason: 'the loader service has no entries() — the host structure changed', entries: [] }
  }

  let raw: unknown
  try {
    raw = entriesFn.call(loader)
  } catch (error) {
    return { ok: false, reason: `loader.entries() threw: ${messageOf(error)}`, entries: [] }
  }
  if (raw === undefined || raw === null) {
    return { ok: false, reason: 'loader.entries() returned nothing', entries: [] }
  }

  const snapshots: LoaderEntrySnapshot[] = []
  let index = 0
  for (const entry of iterate(raw)) {
    const snapshot = snapshotEntry(entry, index)
    index += 1
    if (snapshot !== undefined) snapshots.push(snapshot)
  }
  return { ok: true, entries: snapshots }
}

/**
 * 把一个宿主 entry 抄成纯形状。
 *
 * `undefined` = 这个 entry 连 id 都读不出来，跳过它比编一个强。
 *
 * @param entry 宿主 entry。
 * @param index 在树里的位置，用于兜底 id。
 */
export function snapshotEntry(entry: unknown, index: number): LoaderEntrySnapshot | undefined {
  const record = asRecord(entry)
  if (record === undefined) return undefined
  const options = asRecord(record['options'])
  if (options === undefined) return undefined

  const entryId = asString(options['id']) ?? asString(record['id']) ?? `#${String(index)}`
  const moduleName = asString(options['name']) ?? asString(record['name']) ?? entryId

  // `entry.disabled` 是个 getter（宿主允许它求值抛错，并把抛错当成一种启动失败）。
  let disabled = false
  let disabledExpressionError: string | undefined
  try {
    disabled = record['disabled'] === true
  } catch (error) {
    disabledExpressionError = messageOf(error)
  }

  const fiber = (() => {
    try {
      return record['fiber']
    } catch {
      return undefined
    }
  })()

  if (fiber === undefined || fiber === null) {
    return {
      entryId,
      moduleName,
      disabled,
      ...(disabledExpressionError === undefined ? {} : { disabledExpressionError }),
      hasFiber: false,
      inject: [],
      presentServices: [],
    }
  }

  const fiberRecord = asRecord(fiber)
  const inject = keysOf(fiberRecord?.['inject'])
  const fiberCtx = asRecord(fiberRecord?.['ctx'])
  const presentServices = inject.filter((service) => {
    const get = asFunction(fiberCtx?.['get'])
    if (get === undefined) return false
    try {
      return get.call(fiberCtx, service) !== undefined
    } catch {
      return false
    }
  })

  const state = asNumber(fiberRecord?.['state'])
  // 失败原因：只读 `_error`，**不** `await fiber.await()`。
  // 宿主自己会 await 拿拒绝值，但那是启动审计、可以等；工具调用不能挂在一个
  // 可能永不 settle 的 fiber 上 —— 那会让「宿主先超时」这条纪律失效。
  const fiberError = state === FIBER_STATE.FAILED ? errorTextOf(fiberRecord?.['_error']) : undefined

  return {
    entryId,
    moduleName,
    disabled,
    ...(disabledExpressionError === undefined ? {} : { disabledExpressionError }),
    hasFiber: true,
    ...(state === undefined ? {} : { fiberState: state }),
    ...(fiberError === undefined ? {} : { fiberError }),
    inject,
    presentServices,
  }
}

/**
 * 迭代一个可迭代对象；不可迭代时退化成空 —— **唯一实现**（2026-10-16 审计 A2 收敛：
 * `hot-reload.ts` 的写侧遍历同用这一份，import 方向本就单向 hot-reload → loader，无环）。
 *
 * **不能借 `asRecord` 去取 `Symbol.iterator`**：那个帮手刻意拒绝数组
 * （它要的是「纯记录」语义），而 `loader.entries()` 返回的**正是一个数组**。
 * 走 `asRecord` 会让每棵树都读出空 —— 而且看起来像「宿主没有 entry」，
 * 是最坏的一种静默错。这里直接在任意对象上取那个符号。
 *
 * 用手工迭代而不是 `Array.from`：后者在迭代器半路抛错时会把**已经读到的部分**
 * 一起丢掉，而诊断工具宁可拿「前一半」也不要「零」。
 *
 * @param value 候选可迭代对象。
 */
export function* iterate(value: unknown): Generator<unknown> {
  if (typeof value !== 'object' || value === null) return
  const iteratorFn = (value as { [Symbol.iterator]?: unknown })[Symbol.iterator]
  if (typeof iteratorFn !== 'function') return
  let iterator: Iterator<unknown>
  try {
    iterator = (iteratorFn as () => Iterator<unknown>).call(value)
  } catch {
    return
  }
  for (;;) {
    let step: IteratorResult<unknown>
    try {
      step = iterator.next()
    } catch {
      return
    }
    if (step.done === true) return
    yield step.value
  }
}

/**
 * 取一个对象的键。
 *
 * @param value 任意值。
 */
function keysOf(value: unknown): string[] {
  const record = asRecord(value)
  return record === undefined ? [] : Object.keys(record)
}

/**
 * 把失败原因压成一句话。
 *
 * @param value 任意值（Error / 字符串 / 别的）。
 */
function errorTextOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.message
  return messageOf(value)
}

/**
}

/** 是不是对象（非数组、非 null）。 */
// `asRecord` / `asFunction` / `asString` 的唯一实现在 errors.ts（2026-10-16 审计 A3 收敛）。

/** 取数值。 */
function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
