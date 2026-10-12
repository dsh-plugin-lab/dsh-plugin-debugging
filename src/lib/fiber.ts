/**
 * fiber 状态的**纯投影** —— 把「插件到底加载成功没有」从推断变成观测。
 *
 * ## 这是内部 primitive，不是公开契约
 *
 * 本文件复刻的是**宿主自己启动审计**用的那套判定：`dsh-app-boot` 的
 * `inactiveEntries()`（运行时真源 `…\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-app-boot\lib\index.js`，
 * 0.2.1-alpha.2，常量在 `:3980-3983`、判定在 `:4043-4107`），以及
 * `dsh-host-plugin-inventory` 的 `FIBER_STATE` / `FIBER_PHASE`（同版本 `lib/index.js:51-67`、
 * `readPluginInventory` 本体 `:121-135`）。
 *
 * **它读的是宿主内部结构（`entry.fiber` / `fiber.state` / `fiber._error`），
 * 不是任何一方承诺的公开 API。** 版本一变这里就很可能失效。
 * 所以本文件的调用方**必须**按「读不到就降级」处理 —— 失效时是降级，不是报错。
 * 本文件自身不碰 IO：输入是一个已经被读出来的 entry 形状，输出是一档判定。
 *
 * ## 三档语义（逐字复刻，含第四第五种）
 *
 * | 宿主里的形状 | 本文件的 phase | 取到的诊断 |
 * |---|---|---|
 * | `entry.disabled` 求值**抛错** | `failed` | 抛出的异常（宿主标 `phase: 'disabled expression failed'`） |
 * | `entry.disabled` 为真 | `disabled` | 无（宿主直接跳过，不算失败） |
 * | `entry.fiber === undefined` | `failed` | **`failed to import`** ← 模块加载期就崩 |
 * | `fiber.state === 3` (`FIBER_FAILED`) | `failed` | `fiber._error` / `await fiber.await()` |
 * | `fiber.state === 0` (`FIBER_PENDING`) | `pending` | 缺哪些 service（`Object.keys(fiber.inject)` 里 `fiber.ctx.get(s) === undefined` 的） |
 * | `fiber.state === 2` (`FIBER_ACTIVE`) | `active` | 无 |
 * | 其它 state（1 loading / 4 disposed / 5 unloading） | `failed` | `fiber state <N>` |
 *
 * ## 最凶的一种，以及为什么不能只看 `state === 3`
 *
 * **import 期就失败的 entry，`entry.fiber` 是 `undefined`**（verifier 实测；
 * 见 AGENTS.md 活跃坑第 19 条）：宿主对它报 `failed to import`，而
 * `FIBER_PHASE[undefined]` 会得到 `null` —— 用那张映射表**看不出来**。
 * 只看 `state === 3` 会把「模块一加载就崩」这一类**整条漏掉**，而它恰恰是
 * 「插件装了却毫无输出」最常见的一种。所以 `fiber === undefined` 独立成一档。
 *
 * ## 一个必须说清的边界：判据只在树**稳定后**成立
 *
 * verifier 的同一份探针显示：`apply()` 期读到的是
 * `{"loading":2,"null":145,"pending":1,"active":40}`，settled 之后才是
 * `{"active":162,"null":29}` —— 也就是说**挂载进行中时，`fiber === undefined`
 * 是正常的**（还没轮到它），并不等于 import 失败。
 * 宿主的 `inactiveEntries()` 只在启动审计那一刻被调用，所以它的语义成立；
 * 本工具的调用时点（模型调工具）通常远在 settled 之后，但**热重载/`--patch` 刚插进来的行**
 * 可能仍在挂载中。故调用方必须把这一条写进输出，别让「刚插进来」被读成「崩了」。
 */

/**
 * `fiber.state` 的取值（镜像宿主的跨包 const enum）。
 *
 * 宿主有两处同值定义：`dsh-app-boot` 只定义了自己用到的四个（`:3980-3983`），
 * `dsh-host-plugin-inventory` 定义了完整六个（`lib/index.js:51-58`）。这里取完整那套。
 */
export const FIBER_STATE = {
  PENDING: 0,
  LOADING: 1,
  ACTIVE: 2,
  FAILED: 3,
  DISPOSED: 4,
  UNLOADING: 5,
} as const

/**
 * `fiber.state` → 宿主对外报的 phase（镜像 `dsh-host-plugin-inventory\lib\index.js:60-67`）。
 *
 * `DISPOSED` 映射成 `null` 是**宿主自己的选择**（已销毁不算一个 phase）。
 * 注意本函数**不**用它判 import 失败 —— 那条路的 `state` 是 `undefined`，
 * 查这张表只会得到 `null`，看起来像「没问题」。
 */
export const FIBER_PHASE: Readonly<Record<number, string | null>> = {
  [FIBER_STATE.PENDING]: 'pending',
  [FIBER_STATE.LOADING]: 'loading',
  [FIBER_STATE.ACTIVE]: 'active',
  [FIBER_STATE.FAILED]: 'failed',
  [FIBER_STATE.DISPOSED]: null,
  [FIBER_STATE.UNLOADING]: 'unloading',
}

/** 观测到的相位。 */
export type FiberPhase = 'active' | 'failed' | 'pending' | 'disabled' | 'unknown'

/**
 * 一个 entry 的极简形状 —— **由调用方（`lib/loader.ts`）从宿主结构里读出来**。
 *
 * 只放判定需要的字段，宿主那二十来个字段一个都不带进来：
 * 形状越小，宿主改结构时这里越不容易跟着崩。
 */
export interface LoaderEntrySnapshot {
  /** Loader 树里的 entry id（宿主 `entry.options.id`）。 */
  entryId: string
  /** 模块名（宿主 `entry.options.name`），用于和包名对上。 */
  moduleName: string
  /** `entry.disabled` 求值为真。 */
  disabled: boolean
  /** `entry.disabled` 求值**抛错**时的原文（宿主把它当成一种失败）。 */
  disabledExpressionError?: string
  /** `entry.fiber !== undefined`。**`false` 在稳定期意味着 import 失败**。 */
  hasFiber: boolean
  /** `fiber.state`；`hasFiber` 为假时不存在。 */
  fiberState?: number
  /** 失败原因（`fiber._error` 或 `await fiber.await()` 的拒绝值）；读不到就没有。 */
  fiberError?: string
  /** `Object.keys(fiber.inject)` —— 这个 fiber 声明的服务依赖。 */
  inject: readonly string[]
  /** `inject` 里**当前解析得到**的那些（宿主判据是 `fiber.ctx.get(s) !== undefined`）。 */
  presentServices: readonly string[]
}

/** 一个 entry 的判定结果。 */
export interface FiberObservation {
  phase: FiberPhase
  /** 失败原因；只在 `phase === 'failed'` 且拿得到时有值。 */
  error?: string
  /** 缺哪些 service；只在 `phase === 'pending'` 时有值（**可能是空数组**）。 */
  missingInject?: string[]
  /** 原始 `fiber.state`，原样带出去便于人工复核（`hasFiber` 为假时不存在）。 */
  fiberState?: number
  /** 判定的依据一句话 —— 让读的人知道这一档是怎么来的。 */
  basis: string
}

/**
 * 投影一个 entry 的相位。
 *
 * 判定顺序**逐字照抄** `dsh-app-boot\lib\index.js:4043-4107`：
 * 先 `disabled`（求值抛错 → 失败；为真 → 跳过），再 `fiber === undefined` → import 失败，
 * 再按 `state` 分 `ACTIVE` / `FAILED` / `PENDING` / 其它。
 * 顺序不能换：宿主也是先跳过 disabled 的，把 disabled 行报成「failed」会制造假警报。
 *
 * @param entry 从宿主结构里读出来的 entry 形状。
 */
export function projectFiberPhase(entry: LoaderEntrySnapshot): FiberObservation {
  if (entry.disabledExpressionError !== undefined) {
    return {
      phase: 'failed',
      error: entry.disabledExpressionError,
      basis: 'disabled 表达式求值抛错（宿主标 phase: "disabled expression failed"）',
    }
  }
  if (entry.disabled) {
    return { phase: 'disabled', basis: 'entry.disabled 为真 —— 宿主直接跳过，不算失败' }
  }
  if (!entry.hasFiber) {
    return {
      phase: 'failed',
      error: 'failed to import',
      basis: 'entry.fiber === undefined —— 模块加载期就失败（注意：挂载进行中也会如此，见文件头边界）',
    }
  }

  const state = entry.fiberState
  if (state === FIBER_STATE.ACTIVE) {
    return { phase: 'active', ...(state === undefined ? {} : { fiberState: state }), basis: 'fiber.state === 2 (ACTIVE)' }
  }
  if (state === FIBER_STATE.FAILED) {
    return {
      phase: 'failed',
      ...(entry.fiberError === undefined ? {} : { error: entry.fiberError }),
      fiberState: state,
      basis:
        entry.fiberError === undefined
          ? 'fiber.state === 3 (FAILED)，但没能取到失败原因'
          : 'fiber.state === 3 (FAILED)，原因取自 fiber 自身的记录',
    }
  }
  if (state === FIBER_STATE.PENDING) {
    const missingInject = entry.inject.filter((service) => !entry.presentServices.includes(service))
    return {
      phase: 'pending',
      missingInject,
      fiberState: state,
      basis:
        missingInject.length === 0
          ? 'fiber.state === 0 (PENDING)，且声明的 service 都在 —— 挂载尚未轮到它'
          : `fiber.state === 0 (PENDING)，等 service：${missingInject.join(', ')}`,
    }
  }
  return {
    phase: 'failed',
    ...(state === undefined ? {} : { fiberState: state }),
    error: `fiber state ${String(state)}`,
    basis: '既非 ACTIVE / FAILED / PENDING —— 与宿主一样按失败处理（loading / disposed / unloading 会走到这里）',
  }
}

/**
 * 相位严重级：**数值越小越坏**。
 *
 * 定在这里而不是留给调用方各写一份：一个包在树里有几行是**常态**
 * （宿主自己就有 `…/tools` 这种子路径行），而「报 active 而另一行崩了」
 * 是这类工具最误导的一种输出。排序判据集中一处，才不会有人漏掉。
 */
export const FIBER_PHASE_SEVERITY: Readonly<Record<FiberPhase, number>> = {
  failed: 0,
  pending: 1,
  unknown: 2,
  disabled: 3,
  active: 4,
}

/** 一条「entry + 它的相位」；索引与取最坏值都走这个形状。 */
export interface IndexedObservation {
  entry: LoaderEntrySnapshot
  observation: FiberObservation
}

/**
 * 取最坏的那一档（严重级升序；同级按 entryId 定序，保证结果确定）。
 *
 * 为什么**不把这个顺序塞进 `indexByIdentifier`**：那个索引是 Loader 树的**原始投影**，
 * 按 loader 顺序返回是诚实的（树的顺序本身也是信息，重排就等于替调用方藏了东西）。
 * 「该看哪一行」是**消费决策**，归这里 —— 调用方显式调一次，就不会有人
 * 误以为索引已经替它排好了。
 *
 * tie-break 用 entryId 是有意的：同一严重级下不能让结果取决于 loader 的偶然顺序，
 * 否则同一棵树两次读可能给出不同结论。
 *
 * @param rows 同一个包命中的多行。
 * @returns 最坏的那一行；空数组返回 `undefined`。
 */
export function worstOf(rows: readonly IndexedObservation[]): IndexedObservation | undefined {
  return [...rows].sort((left, right) => {
    const bySeverity =
      FIBER_PHASE_SEVERITY[left.observation.phase] -
      FIBER_PHASE_SEVERITY[right.observation.phase]
    if (bySeverity !== 0) return bySeverity
    if (left.entry.entryId === right.entry.entryId) return 0
    return left.entry.entryId < right.entry.entryId ? -1 : 1
  })[0]
}

/**
 * 把一批 entry 投影成相位表，并按包名建索引。
 *
 * 为什么按包名索引：工具拿到的输入是包名（`dsh-zhihu-search`），
 * 而 Loader 的 entry 认的是模块名（`entry.options.name`）—— 两者通常相同，
 * 但也可能带子路径（宿主自己有 `@deepseek-ai/dsh-plugin-manager/tools` 这种）。
 * 所以匹配用「完全相等 或 entry 模块名以 `<包名>/` 开头」两条，
 * 且**返回全部命中**而不是第一条：一个包在同一棵树里可能有不止一行。
 *
 * **返回顺序 = Loader 顺序（不重排）**；要「该看哪一行」用 {@link worstOf}。
 *
 * @param entries 已读出的 entry 快照。
 */
export function indexByIdentifier(entries: readonly LoaderEntrySnapshot[]): Map<string, IndexedObservation[]> {
  const index = new Map<string, IndexedObservation[]>()
  for (const entry of entries) {
    const observation = projectFiberPhase(entry)
    for (const key of identifierKeys(entry.moduleName)) {
      const bucket = index.get(key)
      const row = { entry, observation }
      if (bucket === undefined) index.set(key, [row])
      else bucket.push(row)
    }
  }
  return index
}

/**
 * 一个模块名可能被哪个包名查到。
 *
 * `@deepseek-ai/dsh-plugin-manager/tools` 应当既能用全名查到，也能用
 * `@deepseek-ai/dsh-plugin-manager` 查到 —— 后者才是用户嘴里的「那个包」。
 *
 * @param moduleName 宿主 entry 的模块名。
 */
function identifierKeys(moduleName: string): string[] {
  const keys = [moduleName]
  const slash = moduleName.indexOf('/', moduleName.startsWith('@') ? moduleName.indexOf('/') + 1 : 0)
  if (slash > 0) keys.push(moduleName.slice(0, slash))
  return keys
}
