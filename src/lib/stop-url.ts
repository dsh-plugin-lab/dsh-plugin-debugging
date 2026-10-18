/**
 * 停止窗口的「已发布地址」—— 把**本进程**带 launch token 的 Web 地址交给那个可见窗口。
 *
 * ## 为什么需要一条文件通道（而不是把地址塞进参数）
 *
 * 停止窗口是**另一个进程**，由计划任务在两代宿主之间拉起（`assets/stop-window.ps1`）。
 * 它必须**跨重启存活**（宿主重启时它就停在 `restarting` 面板上等新宿主），于是：
 *
 * | 通道 | 为什么不行 |
 * |---|---|
 * | 命令行 / 环境变量 | 只在窗口**被创建**那一刻能传；窗口是单例，宿主重启不会再拉一个新的 ⇒ 显示的永远是上一代的 token |
 * | 管道 | 同上，且要启动器常驻 |
 * | **文件（本层）** | 新宿主每次启动都能重写它，窗口下一轮就读到新的 ⇒ **重启后地址自动更新** |
 *
 * ## 代价（如实写，不粉饰）
 *
 * **launch token 会短暂落在磁盘上**。宿主自己的 token 是进程内 `randomBytes(32)`、从不落盘
 * （`dsh-client-connection` 的 `processLaunchToken`），本层是这条性质的**唯一例外**。缓解：
 *
 * 1. **pid 门控**：文件里带 `pid=`，窗口只在它等于**当前绑定的那个宿主**时才显示；
 *    旧文件因此天然失效，不会出现「印着一串看起来权威、点开是 401」的地址。
 * 2. **退出即回收**：宿主 dispose 时把内容改写成 `pid=0`（端口层的 fs 端口没有删除能力 ——
 *    `task-32` 实测宿主 `ctx.fs` 根本没有 `delete`／`unlink`），token 当场从磁盘上消失。
 *    内核直接杀掉宿主（窗口关窗那条路）时不会走到这里，那一份残留仍是 `pid=<死掉的 pid>`，
 *    对任何窗口都不生效。
 *
 * ## 服务怎么取
 *
 * `webApp.getAdvertisedUrl()` 给根地址，`connection.authenticatedUrl(root)` 追加 token。
 * 两个都是**可选服务**：拿不到就返回 `undefined`（窗口显示「还没有地址」），
 * **绝不拼一个不带 token 的地址冒充**——那正是用户点开吃 401 的那种假货。
 *
 * @param ctx 宿主上下文（结构面，本层不 import cordis）。
 */
export interface StopUrlContextLike {
  get?: (name: string) => unknown
}

/** 宿主 `webApp` 服务的注册名（`ctx.provide('webApp', …)`）。 */
const WEB_APP_SERVICE = 'webApp'

/** 宿主 `connection` 服务的注册名（`HostConnectionService` 的 `super(ctx, 'connection')`）。 */
const CONNECTION_SERVICE = 'connection'

/** 宿主 `webServer` 服务的注册名（`get port()` 是**实际监听**端口）。 */
const WEB_SERVER_SERVICE = 'webServer'

/**
 * 本进程的 Web 根地址 + launch token；任一环缺席即 `undefined`。
 *
 * **不带 token 就不返回**：调用方（窗口）把「没有地址」显示成一句话，比显示一个必定 401 的
 * 链接诚实得多。
 *
 * @param ctx 宿主上下文。
 */
export function stopWindowUrlOf(ctx: StopUrlContextLike): string | undefined {
  const getter = ctx.get
  if (typeof getter !== 'function') return undefined

  const webApp = getter.call(ctx, WEB_APP_SERVICE) as
    | { getAdvertisedUrl?: () => unknown }
    | undefined
  const root = typeof webApp?.getAdvertisedUrl === 'function' ? webApp.getAdvertisedUrl() : undefined
  if (typeof root !== 'string' || root === '') return undefined

  const connection = getter.call(ctx, CONNECTION_SERVICE) as
    | { authenticatedUrl?: (base: string) => unknown }
    | undefined
  const url =
    typeof connection?.authenticatedUrl === 'function'
      ? connection.authenticatedUrl(root)
      : undefined
  if (typeof url !== 'string' || url === '') return undefined
  return url
}

/**
 * 宿主**实际监听**的端口；没在监听 / 服务不在场即 `undefined`。
 *
 * 与 `src/tools/index.ts` 的 `webServerPortOf` 同一份事实，但那一处是工具层的私有闭包；
 * 本层要在启动期用一次，所以在这里给一个同名语义的公开实现，工具层复用**这一个**
 * （`src/tools/index.ts` 已改为从本文件导入，避免两份实现漂移）。
 *
 * `0` 是非正数、不是一个端口：`webServer` 在 `listen` 之前 `port` 就是 `undefined`，
 * 而 schema 上的 `0` 是「用户没填」的哨兵 —— 两者都不许进文件名（见 `restart.ts`
 * 的 `requireResolvedPort`）。
 *
 * @param ctx 宿主上下文。
 */
export function listeningPortOf(ctx: StopUrlContextLike): number | undefined {
  const getter = ctx.get
  if (typeof getter !== 'function') return undefined
  const server = getter.call(ctx, WEB_SERVER_SERVICE) as { port?: unknown } | undefined
  const port = server?.port
  return typeof port === 'number' && Number.isSafeInteger(port) && port > 0 ? port : undefined
}

/**
 * 把「一次发布」序列化成落盘文本。
 *
 * 两行、`key=value`，与停止窗口读它的方式一一对应（那一边是纯 ASCII 的 PowerShell，
 * 不引 JSON 解析）。**`url` 缺席时也要写这一格**：空值让窗口显示「还没有地址」，
 * 而不是让它去猜上一行是不是结尾。
 *
 * @param pid 发布者（宿主）的 pid —— 窗口据此判这份地址属不属于当前绑定的宿主。
 * @param url 带 token 的完整地址；`undefined` = 本次不发布（回收时也用它）。
 */
export function serializeStopWindowUrl(pid: number, url: string | undefined): string {
  return `pid=${String(pid)}\r\nurl=${url ?? ''}\r\n`
}
