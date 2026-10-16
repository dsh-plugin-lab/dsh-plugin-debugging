/**
 * `RestartFsPort` 的**宿主实现** —— 走宿主的 `ctx.fs` 服务，**不碰 `node:fs`**。
 *
 * ## 为什么必须走宿主服务（`task-28` 实测的阻断 + `task-31` 实测的解法）
 *
 * 红线 B10 里有两半：`judgeFsWriteUsage`（**来源**判据：src/ 里用没用 `node:fs` 写 API）与
 * `judgeHostDataWrites`（**路径**判据）。维护者拍板的「`$DSH_HOME/<包名>/` 可写」（形态 A）
 * 只放宽了**路径**那一半 —— `task-28` 用探针实测过：`src/` 里只要 import 了 `node:fs` 的写 API，
 * **即使路径首段逐字等于包名，B10 照样判红**。⇒ 真实适配器不能落在本仓自己身上。
 *
 * 解法不是放宽红线，而是**换写的人**：宿主的 `ctx.fs` 服务（`@deepseek-ai/dsh-fs` 的
 * `FileSystem`，注册名就是 `fs`）在写。这与本仓既有的 `ctx.get('spillStore')` 同族 ——
 * 「宿主在写」，所以不经 B10 的来源判据。
 *
 * ## `task-31` 的真机实测（隔离 bench、web profile 默认档、`0.2.1-alpha.2`）
 *
 * | 实测 | 读数 |
 * |---|---|
 * | 本插件这一层（根层兄弟行）`ctx.get('fs')` | **可达**，但 **apply 期拿不到**（`undefined`）→ **+1s** 才拿到 ⇒ **每次现取、不缓存** |
 * | 负对照 `ctx.fs` 直取属性 | **抛** `cannot get property "fs" without inject`（判据不恒真） |
 * | 实例 | `ctor = SandboxedFileSystem`、`sandboxMode = 'workspace-write'` |
 * | 写 `$DSH_HOME/<包名>/restart/…`（**不带** sandboxPolicy） | ❌ `FS_SANDBOX_DENIED`（workspace-write 的根是会话 cwd + 临时目录，`$DSH_HOME` 不在里面） |
 * | 同一个写（**显式** `{mode:'danger-full-access', workspaceRoot}`） | ✅ 成功（`operation: 'create'`），读回逐字相符 |
 * | 读一个不存在的文件 | 抛 `FsError`，`code = 'FS_NOT_FOUND'` |
 * | `stat` 一个不存在的目标 | 返回 `undefined` |
 * | 服务方法面 | `resolve` / `stat` / `lstat` / `readText` / `writeText` / `editText` / `listDir` / `contains` / `processPath` / `fileUrl` |
 * | 有没有删除 | **没有** —— `delete` / `remove` / `unlink` / `rm` / `rmdir` 一个都不是函数（`task-32` 据此把端口里的 `remove` 整个去掉了） |
 * | 缺父目录时写 | 后端自己 `mkdir -p`（`writeFileAtomic` 的文档原话：missing parent directories are created）⇒ **本层不需要、也没有 mkdir** |
 *
 * ## ⚠️ 一处**更正**（`task-32` 的第二支探针实测，推翻了 `task-31` 的推断）
 *
 * `task-31` 我报过「不带 `expected` 时 `writeText` 走 `createIfAbsent`，文件已存在会抛
 * `FS_NOT_OBSERVED`」——**那是错的**。真机连测四步（同一路径）：
 *
 * | 步骤 | 读数 |
 * |---|---|
 * | ① 不带 `expected`，文件**不存在** | ✅ `operation: 'create'` |
 * | ② 不带 `expected`，文件**已存在** | ✅ **`operation: 'update'`** —— 无条件覆盖，**不抛** |
 * | ③ 显式 `{kind:'createIfAbsent'}`，文件已存在 | ❌ `FS_NOT_OBSERVED`（后端**自己的** no-replace 守卫） |
 * | ④ 先读一次、再显式 `createIfAbsent` | ❌ **仍然** `FS_NOT_OBSERVED`（`createIfAbsent` 的语义就是「不许覆盖」，与观察无关） |
 *
 * 结论：**省略 `expected` 就是「无条件 create-or-overwrite」**（与 `dsh-fs` 的 `types.d.ts`
 * 原话一致：「Omitting the intent from `writeText` means unconditional create-or-overwrite」）。
 * `FS_NOT_OBSERVED` 只会由**显式传了 `createIfAbsent`** 的一方引来 —— 那个 intent 是
 * `dsh-tool-fs` 经 `fs/write-intent` waterfall 算出来的；**本插件直接调 `ctx.fs`，不走那条路**。
 * ⇒ marker 的改写（含「消费」那次）天然是幂等的，**不需要预先读一次**。
 *
 * 但本层仍然**防一手**（不是白防）：万一将来换成一个「要求先观察过」的后端，
 * {@link createRestartFsPort} 会在 `FS_NOT_OBSERVED` 上**读一次再重试同一次无条件写**；
 * 重试仍失败就**原样抛出**（绝不吞成「写成功」）。
 *
 * ⚠️ **沙箱策略由调用方给**：本层把 {@link RestartFsOptions.sandboxPolicy} **原样透传**给
 * `writeText` 的第五个参数。**默认不替调用方决定**（省略 = 用宿主自己 resolve 的档位），
 * 因为「用什么档位写」是一次**审批语义**的决策，属于 `task-30` 的壳，不属于这一层。
 *
 * ## 三值纪律（本层最要紧的一条）
 *
 * `absent`（文件不在）与 `unreadable`（读不到 / 服务不在 / 其它 IO 错）**绝不许合并**：
 * 前者是「没有待恢复的 marker」，后者是「不知道有没有」—— 合并就是「把取不到印成没有」，
 * 于是一次本该恢复的重启被静默跳过。所以本层**只认** `FS_NOT_FOUND` 是 `absent`，
 * **其余一切**（`FS_PERMISSION_DENIED` / `FS_SANDBOX_DENIED` / `FS_IO_ERROR` / 形状不认识……）
 * 一律 `unreadable`，且把原始 `code` 带进 `reason`。
 */
import type { RestartFsPort, TextRead } from './restart.js'
import { systemErrorCode } from './errors.js'

/** 宿主 `fs` 服务在 Cordis 上的注册名（`FileSystem` 的 `super(ctx, 'fs')`）。 */
const HOST_FS_SERVICE = 'fs'

/** 唯独这个码算「文件不在」；其余一律「读不到」。 */
const FS_NOT_FOUND = 'FS_NOT_FOUND'

/** 「宿主要求先观察过这个目标」——只在有人显式传 `createIfAbsent` 时才出现。 */
const FS_NOT_OBSERVED = 'FS_NOT_OBSERVED'

/**
 * 宿主 `fs` 服务的**最小结构面**。
 *
 * 刻意**不** import `@deepseek-ai/dsh-fs`：那是宿主安装树里的包，从本仓的解析上下文
 * 拿不到（本仓活跃坑 19 的同族：profile 的 `node_modules` 里没有宿主内层包）。
 * 结构化访问 + 只声明本层真正用到的方法，宿主换版本时表现为降级而不是崩。
 */
export interface HostFsLike {
  /** 把路径解析成稳定目标；可能做 IO（所以是异步）。 */
  resolve(path: string): Promise<unknown>
  /** 读整个文本文件；不存在时抛 `FS_NOT_FOUND`。 */
  readText(target: unknown, signal?: AbortSignal): Promise<string>
  /** 原子写；`sandboxPolicy` 是**每次调用**的沙箱档位。 */
  writeText(
    target: unknown,
    content: string,
    expected?: unknown,
    signal?: AbortSignal,
    sandboxPolicy?: unknown,
  ): Promise<unknown>
}

/** 本层需要的上下文面（`ctx.get` 在单测替身里可能不存在）。 */
export interface ContextLike {
  get?: (name: string) => unknown
}

/** `createRestartFsPort` 的选项。 */
export interface RestartFsOptions {
  /**
   * 逐次透传给宿主 `writeText` 的沙箱策略。
   *
   * **省略 = 用宿主自己 resolve 的档位**（在 `workspace-write` 的 profile 下，
   * 写 `$DSH_HOME` 会被 `FS_SANDBOX_DENIED` 拒掉 —— 这是**实测**，不是推测）。
   * 「要不要提档、提档怎么征得用户同意」是审批语义，由 `task-30` 的壳决定。
   */
  sandboxPolicy?: unknown
}

/**
 * 取宿主 `fs` 服务；**拿不到、或形状不认识**都返回 `undefined`（不猜）。
 *
 * @param ctx 宿主上下文（可以是单测替身）。
 */
function hostFsOf(ctx: ContextLike): HostFsLike | undefined {
  const getter = ctx.get
  if (typeof getter !== 'function') return undefined
  const service = getter.call(ctx, HOST_FS_SERVICE)
  if (service === null || typeof service !== 'object') return undefined
  const candidate = service as Record<string, unknown>
  // 三个必需方法都必须是函数：服务在、但形状不对（宿主换版本）同样算「不可用」，
  // 而不是「调用时再炸」——后者会让「不可用」在更晚、更难查的地方才现形。
  for (const method of ['resolve', 'readText', 'writeText']) {
    if (typeof candidate[method] !== 'function') return undefined
  }
  return service as HostFsLike
}

/**
 * 宿主 `fs` 服务**不可用**的原因；可用时返回 `undefined`。
 *
 * 给上层一个**早失败**的口子：`undefined` 之外的任何值都意味着「这次一定读不到 marker」，
 * 上层据此给结构化失败（`not-configured` 一类），而**不是**静默当成「没有 marker」。
 *
 * @param ctx 宿主上下文。
 */
export function hostFsUnavailableReason(ctx: ContextLike): string | undefined {
  if (typeof ctx.get !== 'function') {
    return 'this context exposes no service getter, so the host fs service cannot be reached'
  }
  const service = ctx.get(HOST_FS_SERVICE)
  if (service === null || service === undefined) {
    return 'the host fs service is not registered in this composition'
  }
  if (typeof service !== 'object') {
    return `the host fs service is not a service object (got ${typeof service})`
  }
  const missing = ['resolve', 'readText', 'writeText'].filter(
    (method) => typeof (service as Record<string, unknown>)[method] !== 'function',
  )
  if (missing.length > 0) {
    return `the host fs service is missing ${missing.join(', ')}`
  }
  return undefined
}

/**
 * 取一个异常的稳定码（宿主 `FsError` 的 `code`；其它异常没有）。
 *
 * 实现直接用 `errors.ts` 的正典 `systemErrorCode`（多读 `cause` 那一半 ——
 * node:fs 的错误常包在 cause 里；本地原有一份只读顶层的弱化副本已删，
 * 与 2026-10-16 审计 A6 揪出的 `list_instances` 同族）。
 *
 * @param error 任意异常。
 */
function errorCodeOf(error: unknown): string | undefined {
  return systemErrorCode(error)
}

/**
 * 把任意异常写成一句英文事实（`code` 优先 —— 它是稳定判据，message 会随版本变）。
 *
 * @param error 任意异常。
 */
function reasonOf(error: unknown): string {
  const code = errorCodeOf(error)
  const message = error instanceof Error ? error.message : String(error)
  // ⚠️ 与 restart-recovery.ts 的 describeError 形状相似但**不同义**：
  // 这里的 message 兜底是 messageOf 语义（Error.message / String），
  // 那边是多级兜底（message → name → 'unknown error'）—— 最后一行的
  // `${code}: ${message}` 拼接相同只是巧合，别按同语义收拢（审计 A7 判定）。
  return code === undefined ? message : `${code}: ${message}`
}

/**
 * 造一个走宿主 `ctx.fs` 的 {@link RestartFsPort}。
 *
 * **每次调用现取服务**（apply 期拿不到，实测见文件头）—— 不缓存、不闭包捕获实例。
 *
 * 路径**一律作为实参进来**：本层不构造任何路径，落点的唯一出处是
 * `src/lib/restart.ts` 的 `restartMarkerPath`（「一处一事实」）。
 *
 * @param ctx 宿主上下文。
 * @param options 选项（目前只有沙箱策略透传）。
 */
export function createRestartFsPort(ctx: ContextLike, options: RestartFsOptions = {}): RestartFsPort {
  /** 读一个文件；**只把 `FS_NOT_FOUND` 当缺席**。 */
  const read = async (path: string): Promise<TextRead> => {
    const fs = hostFsOf(ctx)
    if (fs === undefined) {
      // 服务缺席**不是**「文件不在」—— 这是本层最要紧的一格。
      return {
        status: 'unreadable',
        reason: hostFsUnavailableReason(ctx) ?? 'the host fs service is unavailable',
      }
    }
    let target: unknown
    try {
      target = await fs.resolve(path)
    } catch (error) {
      return { status: 'unreadable', reason: reasonOf(error) }
    }
    try {
      return { status: 'text', text: await fs.readText(target) }
    } catch (error) {
      if (errorCodeOf(error) === FS_NOT_FOUND) return { status: 'absent' }
      // 其余一切都不是「不在」：形状不认识也不许猜（认不出来就报「读不到」）。
      return { status: 'unreadable', reason: reasonOf(error) }
    }
  }

  /**
   * 写一个文件。
   *
   * 两点是有意的：
   * ① **不传 `expected`** ⇒ 宿主的语义是「无条件 create-or-overwrite」（实测：同一个路径
   *    第二次写回的是 `operation: 'update'`，**不抛**）。marker 的改写（含「消费」那次）
   *    因此天然幂等，**不需要预先读一次**。
   * ② 万一后端**要求先观察过**（只有显式 `createIfAbsent` 才会引来 `FS_NOT_OBSERVED`），
   *    就**读一次再重试同一次无条件写**；重试仍失败**原样抛出** —— 绝不吞成「写成功」。
   */
  const write = async (path: string, text: string): Promise<void> => {
    const fs = hostFsOf(ctx)
    if (fs === undefined) {
      throw new Error(hostFsUnavailableReason(ctx) ?? 'the host fs service is unavailable')
    }
    const target = await fs.resolve(path)
    try {
      await fs.writeText(target, text, undefined, undefined, options.sandboxPolicy)
    } catch (error) {
      if (errorCodeOf(error) !== FS_NOT_OBSERVED) throw error
      // 读一次（= 记下观察），再重试。读失败就让它抛：那是更真实的障碍。
      await fs.readText(target)
      await fs.writeText(target, text, undefined, undefined, options.sandboxPolicy)
    }
  }

  return { read, write }
}
