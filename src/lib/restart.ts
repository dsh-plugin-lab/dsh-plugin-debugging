/**
 * `dsh_restart` 的**安全半** —— marker 的编解码、四道闸的判定、恢复判定。
 *
 * ## 这一层为什么是纯逻辑
 *
 * 四道闸的判据与 marker 的编解码都是**纯函数**，IO 一律经 {@link RestartFsPort} 与
 * {@link RestartPorts} 注入 —— 「取不到忙闲状态时必须 fail-closed」这类判据因此可以直接
 * 用替身写死，不必起真宿主。
 *
 * **拉起新进程、让本进程退出、投 notice、删 marker 的落地执行都不在这一层**（那是工具半边
 * 的活，且语义要先经维护者拍板）。这一层只回答两件事：**能不能做**、**留下什么痕迹**。
 *
 * ## 三值纪律：`缺席` ≠ `空`，`取不到` ≠ `没有问题`
 *
 * - marker 读不到分三类：`absent`（文件不在）/ `unreadable`（读失败）/ `unsupported-version`
 *   （在、但不是我们认识的格式）。**后两类绝不许压成 `absent`** —— 压了就是「把取不到印成
 *   没有」，恢复会静默地什么都不做，而人看到的是一次「正常」启动。
 * - 四道闸的每一个观测都是 {@link Observed}：`known: false` 一律按**拒绝**处理，理由各写各的。
 *   闸②那条是硬要求（HOST-CONTRACTS §2.3：服务不可用 ⇒ `{known:false, idle:false}` = 拒绝）。
 *
 * ## 四道闸与唯一的逃生口（SHAPE §6.1）
 *
 * | 闸 | 何时拒绝 | `code` |
 * |---|---|---|
 * | ① 重启循环熔断 | 冷却窗口内已经重启过 | `restart-loop` |
 * | ② 别的会话在飞 | 除「调用方自己那个回合」外还有会话 / 作业 / 定时提醒在跑（**唯一有 `force` 逃生口**） | `busy` |
 * | ③ bundle 表解析不了 | profile 的 bundles 读不出 / 不是 JSON | `bad-composition` |
 * | ④ 拿不到启动命令 | 定不出「怎么把宿主拉起来」——**不猜** | `no-launch-command` |
 *
 * `force` **只覆盖闸②**，且**真的覆盖了**才留痕（写进 marker 的 `force` 与 `trace`）。
 * ①③④ 的判据签名里**根本没有 `force`** —— 「不可绕过」在这里是结构性的，不是一句约定：
 * 想让它绕过就得先改判据的**形参**，改不动的是「顺手加一行 `|| force`」。
 *
 * ## 命名空间那一段为什么必须是字符串字面量
 *
 * marker 落点是 `$DSH_HOME/<包名>/restart/marker.json`。红线 B10 的白名单（形态 A）判的是
 * 「**紧跟 home 的第一个路径段**逐字等于包名」，而首段写成变量时判据**保守判红**（正典表
 * 第 43 条的已知限度）。所以 {@link restartMarkerPath} 里那一段是字面量，并配一条
 * 「该字面量 == `package.json` 的 name」的自证（见 `test/tools/restart.test.ts`）。
 *
 * ⚠️ **本文件自己不碰 `node:fs`**：写动作只发生在注入的端口上。这一条不是洁癖 ——
 * 本卡实测过（临时探针 + B10 真实扫描）：**只要 import 了 `node:fs` 的写 API，
 * 即使路径首段逐字等于包名，B10 照样判红**（`judgeFsWriteUsage` 管的是「用没用 fs 写 API」，
 * 与路径无关；白名单只放宽了另一条**路径**判据 `judgeHostDataWrites`）。
 */
import { join } from 'node:path'

/** marker 的格式版本（写出去的那一个）。**只许加字段，不许改语义** —— 改语义等于把版本门推倒。 */
export const MARKER_VERSION = 1

/**
 * 认得的 marker 格式版本。
 *
 * 新读旧**可以响亮拒绝**、旧读新只能静默降级 —— 这个不对称本身就是设计（决策笔记 §五）。
 * 所以「不在这个集合里」必须是一条**结构化失败**，不许被压成「没有 marker」。
 */
export const SUPPORTED_MARKER_VERSIONS: readonly number[] = [1]

/**
 * 闸①的冷却窗口（毫秒）。
 *
 * 60_000 不是拍的：SHAPE §6.1 的待实测表第 7 条记着**两个独立参考实现都落在 60 秒**
 * （`dsh-desktop-auto-restart` 硬编码 60 秒并发冷却：`dsh-restart` 的 `watchdogCooldownMs`
 * 默认 60000）。⇒ 本仓取 60 秒**有据可依**，不必先验后定。
 *
 * ⚠️ **它是一个导出常量，没有任何「按调用覆盖」的入口**：{@link judgeRestartLoop} 的签名里
 * 既没有 `force`、也没有超时/窗口参数 —— 想改冷却就得改这个常量（维护者 2026-10-14 确认）。
 * 这条是**有意**的：闸①判的是「这件事根本做不成」，不是「用户知情后的选择」。
 */
export const RESTART_COOLDOWN_MS = 60_000

/**
 * marker 的**消费状态**。
 *
 * `armed` = 这次重启还没被消费掉（新进程起来后该去恢复、投 notice，然后转成 `consumed`）；
 * `consumed` = 已经处理过了，剩下的只是一条**审计记录**。
 *
 * ## 为什么是「状态迁移」而不是「删除」
 *
 * 宿主 `fs` 的缝上**没有删除**（`task-31` 真机探针 + 源码双向确认：`delete` / `remove` /
 * `unlink` / `rm` / `rmdir` 一个都不是函数）。维护者 2026-10-14 裁决：**改用状态迁移** ——
 * 它只需要 `writeText`（已实测可用）、**不新增依赖面**、可幂等重放，而且**留痕**
 * （「上次重启什么时候、消费过没有」本身就是审计价值）。
 * 被否决的两条：用 `ctx.shell` 跑 `rm`（更脆、新依赖面）；`editText` 清空当墓碑
 * （marker 会变 `malformed` ⇒ 恢复判 `refuse` ⇒ **把恢复卡死**）。
 */
export type MarkerState = 'armed' | 'consumed'

/**
 * marker 的内容（SHAPE §6.1 / 决策笔记 §三）。
 *
 * `force` 用**可选**而不是 `force: boolean`：`{force: false}` 与「压根没这个键」是两件事
 * （前者是「这次不是覆盖」，后者是「这份 marker 没有覆盖这一栏」）。
 * 三值纪律同样管这里 —— 所以本仓写 marker 时**只在真覆盖过时才放这个键**。
 */
export interface RestartMarker {
  /** 格式版本；不在 {@link SUPPORTED_MARKER_VERSIONS} 里 ⇒ 结构化失败。 */
  version: number
  /** 为什么重启（工具参数 `reason` 逐字）。 */
  reason: string
  /** 写 marker 的时刻（ISO 8601 / UTC）。 */
  at: string
  /**
   * 重启后要**等回来**的会话名单（运行期键形如 `session-<uuid>`）。
   *
   * 它是「等哪些会话」，**不是**「怎么把它们拉起来」：Web profile 没有 `--resume`，
   * resume 的真触发者是客户端重开会话（HOST-CONTRACTS §2.4 的 C9 / C10）。
   */
  sessions: string[]
  /**
   * 消费状态；**缺席 = `armed`**（见 {@link markerState}）。
   *
   * 「缺席」为什么等价于 `armed` 而不是「未知」：`state` 是 `task-32` 新增的字段，
   * 而**它之前的 marker 只可能是在写完全没消费过的那一次**（`task-28` 里根本没有消费这一步）
   * —— 所以缺席只有一种历史含义。而且这个默认方向是**保守**的：把老 marker 当 `armed`
   * 最多多做一次恢复；反过来（当 `consumed`）会**静默丢掉一次恢复**。
   */
  state?: MarkerState
  /** **只在闸②被真覆盖过时**存在。 */
  force?: true
  /** 事件轨迹（英文短句）；覆盖与消费都必须在这里留痕。 */
  trace: string[]
}

/**
 * 取 marker 的消费状态（**缺席 = `armed`**，理由见 {@link RestartMarker.state}）。
 *
 * @param marker marker。
 */
export function markerState(marker: RestartMarker): MarkerState {
  return marker.state ?? 'armed'
}

/** 一次文本读取的结果：**「文件不在」与「读失败」是两件事**。 */
export type TextRead =
  | { status: 'text'; text: string }
  | { status: 'absent' }
  | { status: 'unreadable'; reason: string }

/**
 * marker 的 IO 端口（**唯一的 IO 注入点**）。
 *
 * ## 抛不抛（`task-31` 报的措辞不一致，这里改成与实现一致）
 *
 * **`read` 不抛**：读不到就落在 {@link TextRead} 的三值里（`absent` / `unreadable`）——
 * 它对「文件不在」与「读失败」必须分开，而且调用方就是靠这个分界决定「要不要恢复」。
 * **`write` 失败要抛**：本层不吞异常，由入口 {@link planRestart} 收敛成结构化失败
 * （写不出去却报「已就绪」是最坏的一种静默坏）。
 *
 * ## 为什么只有两个方法（没有 `remove`）
 *
 * 宿主 `fs` 的缝上没有删除能力（`task-31` 实测），**端口不该假装能做**。
 * 「消费掉 marker」因此是**状态迁移**：把 `state` 从 `armed` 改成 `consumed` 再写回去
 * （{@link consumeRestartMarker}），走的就是 `write`。
 */
export interface RestartFsPort {
  read(path: string): Promise<TextRead>
  /** 写不抛的实现是错的：失败必须冒到 {@link planRestart} 的兜底里。 */
  write(path: string, text: string): Promise<void>
}

/**
 * marker 的绝对路径：`$DSH_HOME/<包名>/restart/marker.json`。
 *
 * ⚠️ **紧跟 `dshHome` 的那一段必须是字符串字面量**：B10 的白名单只认字面量，
 * 写成 `join(dshHome, OWN_NAMESPACE, …)` 会被保守判红（正典表第 43 条）。
 * 改包名要同批改这一行 —— `test/tools/restart.test.ts` 有一条自证盯着「字面量 == `name`」。
 *
 * @param dshHome 宿主数据目录（`$DSH_HOME`）。
 */
export function restartMarkerPath(dshHome: string): string {
  return join(dshHome, 'dsh-plugin-debugging', 'restart', 'marker.json')
}

/**
 * 把 marker 序列化成落盘文本。
 *
 * 三个细节都是有意的：
 * ① **键序固定、`version` 在最前** —— 读的人第一眼就能判格式版本；
 * ② **可选键缺席就不写**（`state` / `force`）—— `缺席 ≠ 显式 false`，且往返要无损；
 * ③ 末尾补一个换行 —— 文件是给人看的，`diff` / `cat` 都受益。
 *
 * @param marker marker。
 */
export function serializeMarker(marker: RestartMarker): string {
  const ordered: Record<string, unknown> = {
    version: marker.version,
    reason: marker.reason,
    at: marker.at,
    sessions: [...marker.sessions],
    ...(marker.state === undefined ? {} : { state: marker.state }),
    ...(marker.force === true ? { force: true } : {}),
    trace: [...marker.trace],
  }
  return `${JSON.stringify(ordered, null, 2)}\n`
}

/** 解析一份 marker 文本的结果（三值：认识 / 版本不认识 / 格式坏）。 */
export type MarkerParse =
  | { status: 'ok'; marker: RestartMarker }
  | { status: 'unsupported-version'; version: unknown }
  | { status: 'malformed'; reason: string }

/**
 * 解析一份 marker 文本。
 *
 * **绝不抛**。三条分支的边界要划准：
 * - **有 `version` 但不是数字** ⇒ `malformed`（这份东西根本不是我们写的格式）；
 * - **是数字但不在支持集** ⇒ `unsupported-version`（我们写的，但来自另一个格式版本）；
 * - 其余字段缺 / 类型不对 ⇒ `malformed`。
 *
 * @param text marker 文件的全文。
 */
export function parseMarker(text: string): MarkerParse {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { status: 'malformed', reason: `the marker is not valid JSON (${messageOf(error)})` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { status: 'malformed', reason: 'the marker must be a JSON object' }
  }
  const record = parsed as Record<string, unknown>
  const version = record['version']
  if (typeof version !== 'number') {
    return { status: 'malformed', reason: 'the marker has no numeric "version" field' }
  }
  if (!SUPPORTED_MARKER_VERSIONS.includes(version)) {
    // 在、但版本不认识 —— **结构化失败**，绝不是「没有 marker」。
    return { status: 'unsupported-version', version }
  }
  const reason = record['reason']
  if (typeof reason !== 'string') return { status: 'malformed', reason: '"reason" must be a string' }
  const at = record['at']
  if (typeof at !== 'string') return { status: 'malformed', reason: '"at" must be a string' }
  const sessions = record['sessions']
  if (!Array.isArray(sessions)) {
    return { status: 'malformed', reason: '"sessions" must be an array' }
  }
  const trace = record['trace']
  if (!Array.isArray(trace)) return { status: 'malformed', reason: '"trace" must be an array' }
  const state = record['state']
  if (state !== undefined && state !== 'armed' && state !== 'consumed') {
    return { status: 'malformed', reason: '"state", when present, must be "armed" or "consumed"' }
  }
  const force = record['force']
  if (force !== undefined && force !== true) {
    return { status: 'malformed', reason: '"force", when present, must be true' }
  }
  return {
    status: 'ok',
    marker: {
      version,
      reason,
      at,
      sessions: sessions.filter(isString),
      ...(state === undefined ? {} : { state }),
      ...(force === true ? { force: true as const } : {}),
      trace: trace.filter(isString),
    },
  }
}

/** 读 marker 的结果：**五值**（缺席 / 认识 / 版本不支持 / 格式坏 / 读失败）。 */
export type MarkerRead =
  | { status: 'absent' }
  | { status: 'ok'; marker: RestartMarker }
  | { status: 'unsupported-version'; version: unknown }
  | { status: 'malformed'; reason: string }
  | { status: 'unreadable'; reason: string }

/**
 * 读 marker。**绝不抛**。
 *
 * @param fs marker 的 IO 端口。
 * @param dshHome 宿主数据目录。
 */
export async function readRestartMarker(fs: RestartFsPort, dshHome: string): Promise<MarkerRead> {
  let read: TextRead
  try {
    read = await fs.read(restartMarkerPath(dshHome))
  } catch (error) {
    // 故意**不**降级成 `absent`：读失败与「文件不在」是两件事，压在一起就是「取不到印成没有」。
    return { status: 'unreadable', reason: messageOf(error) }
  }
  if (read.status === 'absent') return { status: 'absent' }
  if (read.status === 'unreadable') return { status: 'unreadable', reason: read.reason }
  return parseMarker(read.text)
}

/**
 * 写 marker（**必须在拉起新进程之前完成** —— 顺序是判据，见 SHAPE §6.1 的流程图）。
 *
 * 失败会抛：调用方 {@link planRestart} 把它收敛成结构化失败，并且**不拉起任何东西**。
 *
 * @param fs marker 的 IO 端口。
 * @param dshHome 宿主数据目录。
 * @param marker marker。
 * @returns 实际写到的路径（进 `key` / `audit` 用）。
 */
export async function writeRestartMarker(
  fs: RestartFsPort,
  dshHome: string,
  marker: RestartMarker,
): Promise<string> {
  const path = restartMarkerPath(dshHome)
  await fs.write(path, serializeMarker(marker))
  return path
}

/**
 * **消费** marker —— 「校验通过之后」调（读到就消费会把半处理的 marker 提前标掉，
 * 那之后再也认不出它还没恢复完；决策笔记 §六）。
 *
 * 实现是**状态迁移**而不是删除（宿主 `fs` 没有删除，见 {@link MarkerState}）：
 * 把 `state` 改成 `consumed`、往 `trace` 追加一条留痕，然后写回同一个路径。
 * 它是**幂等**的：对一份已经 `consumed` 的 marker 再调一次，写回去的还是 `consumed`。
 *
 * 失败**抛**（由调用方收敛）—— 写不回去却报「已消费」会让下一次启动重复恢复。
 *
 * @param fs marker 的 IO 端口。
 * @param dshHome 宿主数据目录。
 * @param marker 要消费的那份 marker（通常是刚读回来并校验过的那一份）。
 * @param now 现在（毫秒纪元）；只为留痕与测试注入。
 * @returns 实际写回去的那份 marker（已带 `state: 'consumed'`）。
 */
export async function consumeRestartMarker(
  fs: RestartFsPort,
  dshHome: string,
  marker: RestartMarker,
  now: number,
): Promise<RestartMarker> {
  const consumed = markerAfterConsumption(marker, now)
  await fs.write(restartMarkerPath(dshHome), serializeMarker(consumed))
  return consumed
}

/**
 * 造一份「已消费」的 marker（**纯函数**，不碰 IO）。
 *
 * 三件事：`state` 置成 `consumed`、`at` **原样保留**（那是「这次重启发生在什么时候」，
 * 是审计事实，不是「这份文件最后一次被改的时间」）、`trace` 追加一条带时刻的留痕。
 *
 * @param marker 原 marker。
 * @param now 现在（毫秒纪元）。
 */
export function markerAfterConsumption(marker: RestartMarker, now: number): RestartMarker {
  const stamp = new Date(now).toISOString()
  return {
    ...marker,
    state: 'consumed',
    trace: [...marker.trace, `consumed at ${stamp}`],
  }
}

/** 四道闸的标识（顺序即判定顺序）。 */
export type GateId = 'restart-loop' | 'busy-session' | 'composition' | 'launch-command'

/** 拒绝码 —— **闭集**，与 SHAPE §6.1 的表一一对应。 */
export type RefusalCode = 'restart-loop' | 'busy' | 'bad-composition' | 'no-launch-command'

/**
 * 一个观测的三值形状。
 *
 * 这不是「可有可无的包装」：它是 `取不到` 与 `取到了、值是空」这两件事在类型上的分界。
 * 压成一个 `T | undefined` 就等于把三值压成两值，而压出来的那一格会静默地判成「没问题」。
 */
export type Observed<T> = { known: true; value: T } | { known: false; reason: string }

/** 一道闸放行。 */
export interface GatePass {
  gate: GateId
  passed: true
  /** 一句英文事实（进 L2 / `audit`）。 */
  detail: string
  /**
   * **只有闸②**可能带：这次是显式覆盖过的（真要写进 marker 的留痕）。
   *
   * 它同时是「有没有发生覆盖」的开关 —— 没有它就没有 `force: true`、也没有 `blockedSessions`。
   */
  overrideTrace?: string
  /** 被覆盖打断的**会话**（marker 的等待名单来源；数据，不是从 `overrideTrace` 里回读字符串）。 */
  blockedSessions?: readonly string[]
}

/** 一道闸拒绝：**哪个闸 + 为什么 + 怎么解**三件都要有。 */
export interface GateRefusal {
  gate: GateId
  passed: false
  code: RefusalCode
  /** 为什么（英文，会逐字进 `data.verdict`）。 */
  verdict: string
  /** 怎么解（英文，进 `nextStep.why`）。 */
  remedy: string
  /** 这条拒绝涉及的对象（阻塞者 / 解析失败的来源），进 L2 与 `audit`。 */
  evidence: readonly string[]
  /** 建议下一步要调的工具（闸③指路 `dsh_dump_config`）。 */
  suggestedTool?: string
  /** 没有工具可调、要用户自己做点什么（闸④）。 */
  manual?: true
}

/** 一道闸的判定。 */
export type GateDecision = GatePass | GateRefusal

/**
 * 归一化会话 id。
 *
 * 运行期键是 `session-<uuid>`，而调用方常传裸 uuid（HOST-CONTRACTS §2.3）——
 * 不补前缀就会把「调用方自己」当成「别人」，于是每一次重启都被自己的会话拒掉。
 * 形状不合法时返回空串，由调用方**据此判失败**（不猜）。
 *
 * @param raw 原始 id。
 */
export function normalizeSessionId(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  const value = trimmed.startsWith('session-') ? trimmed : `session-${trimmed}`
  return /^session-[A-Za-z0-9._-]+$/u.test(value) ? value : ''
}

/** 闸①的输入。 */
export interface RestartLoopInput {
  /** 已知的历史重启时刻（毫秒纪元）。空数组 = 读过、没有。 */
  history: Observed<readonly number[]>
  /** 现在（毫秒纪元）。**只读一次**，免得同一棵树两次读给出不同结论。 */
  now: number
}

/**
 * 闸①：重启循环熔断。
 *
 * 签名里没有 `force` —— 这是**结构性**的「不可绕过」。
 *
 * @param input 历史与当前时刻。
 */
export function judgeRestartLoop(input: RestartLoopInput): GateDecision {
  if (!input.history.known) {
    return {
      gate: 'restart-loop',
      passed: false,
      code: 'restart-loop',
      verdict: `refused by the restart-loop gate: the restart history could not be read (${input.history.reason}), so a restart loop cannot be ruled out`,
      remedy:
        'fix whatever keeps the restart history unreadable, then call again; this tool never treats "unknown" as "no restart has happened yet"',
      evidence: [input.history.reason],
    }
  }
  const cutoff = input.now - RESTART_COOLDOWN_MS
  const recent = input.history.value
    .filter((time) => Number.isFinite(time) && time <= input.now && time > cutoff)
    .sort((a, b) => b - a)
  const latest = recent[0]
  const cooldownSeconds = Math.round(RESTART_COOLDOWN_MS / 1000)
  if (latest === undefined) {
    return {
      gate: 'restart-loop',
      passed: true,
      detail: `no restart within the last ${String(cooldownSeconds)}s`,
    }
  }
  const ageSeconds = Math.max(0, Math.round((input.now - latest) / 1000))
  return {
    gate: 'restart-loop',
    passed: false,
    code: 'restart-loop',
    verdict: `refused by the restart-loop gate: this host was restarted ${String(ageSeconds)}s ago, inside the ${String(cooldownSeconds)}s cooldown, so restarting again could start a loop`,
    remedy: `wait until the cooldown has passed and call again; if the host is genuinely wedged, restart it outside this tool`,
    evidence: [`last restart ${String(ageSeconds)}s ago`],
  }
}

/**
 * 一个「忙」的来源。
 *
 * ## 为什么不是「一串会话 id」
 *
 * 契约（HOST-CONTRACTS §2.3 的忙判定语义）只把**调用方自己那个会话的回合**排除，
 * **后台作业与定时提醒照旧全算 —— 包括调用方自己的那些**。
 * 一串裸 id 表达不了这件事：那样一个属于调用方的作业会被当成「自己」而被排除，
 * 而方向恰好是危险的那一边（少算一个阻塞者 = 打断一件没人知道在跑的事）。
 */
export type BusySource =
  /** 某个会话正在跑一个回合。 */
  | { kind: 'turn'; sessionId: string }
  /** 一个在跑的作业（后台任务）；`ownerSession` 是它的属主（可缺）。 */
  | { kind: 'job'; jobId: string; ownerSession?: string }
  /** 一个已武装的定时提醒；`ownerSession` 是它的属主（可缺）。 */
  | { kind: 'schedule'; scheduleId: string; ownerSession?: string }

/** 闸②的输入。 */
export interface BusySessionInput {
  /** 当前忙的来源（**含调用方自己**；判据只排除「调用方自己的回合」）。 */
  busy: Observed<readonly BusySource[]>
  /** 发起本次调用的会话（裸 uuid 或 `session-<uuid>` 都行）。 */
  callingSession: string
  /** 显式覆盖 —— **只对这一道闸有效**。 */
  force: boolean
}

/**
 * 闸②：别的会话在飞。
 *
 * 四条边界，每条都有它自己的理由：
 * 1. **取不到忙闲状态 ⇒ 拒绝**（fail-closed）。不是洁癖：判成「不忙」会去打断别人的回合，
 *    而那是**不可逆**的；
 * 2. **只排除「调用方自己的那个回合」** —— 调用方主动重启，它自己那一次不算受害者；
 *    但**属于它的作业 / 定时提醒照旧算忙**（契约 §2.3：后台任务与定时提醒全算，含调用方自己的）；
 * 3. **`force` 不能覆盖「取不到」** —— 覆盖的前提是「用户知道自己要打断谁」，
 *    连谁在飞都不知道时，`force` 不是一个知情的选择；
 * 4. **认不出来的东西当阻塞者**（安全优先）：归一化不了的会话 id 不丢，留下。
 *
 * @param input 忙闲观测、调用方会话、是否覆盖。
 */
export function judgeBusySession(input: BusySessionInput): GateDecision {
  if (!input.busy.known) {
    return {
      gate: 'busy-session',
      passed: false,
      code: 'busy',
      verdict: `refused by the busy-session gate: the busy state could not be determined (${input.busy.reason}), and this tool does not treat an unknown busy state as idle`,
      // ⚠️ 原话是「等 agent / job 服务可读了再试」—— 而「服务可读了没有」**不是模型能观察的量**
      // （本插件 8 个工具里没有一个是服务探针）⇒ 模型只能盲重试，再被同一道闸拒。
      // 改法：把不可观察的那半交给人，留下可兑现的「先让人把它弄可读」。
      remedy:
        'the busy state could not be determined in this composition; ask the user to make the agent and job services readable, then call again, because interrupting a running turn cannot be undone and this tool never treats an unknown busy state as idle',
      evidence: [input.busy.reason],
    }
  }
  const self = normalizeSessionId(input.callingSession)
  if (self === '') {
    return {
      gate: 'busy-session',
      passed: false,
      code: 'busy',
      verdict:
        'refused by the busy-session gate: the calling session id could not be normalized, so this tool cannot tell the caller apart from the sessions it would interrupt',
      // 与工具壳的「没有 session id」那条同族：**模型无法选择自己在哪个会话**，
      // 所以「换一个合法 id 的会话再调」对它不是可执行的动作，交给人。
      remedy:
        'ask the user to start the restart from a session with a valid session id; this tool cannot choose the session it runs in',
      evidence: [input.callingSession],
    }
  }
  const isCallerTurn = (source: BusySource): boolean =>
    source.kind === 'turn' && (normalizeSessionId(source.sessionId) || source.sessionId) === self
  const blocked = [...new Set(input.busy.value.filter((source) => !isCallerTurn(source)).map(busyLabel))].sort()
  if (blocked.length === 0) {
    return {
      gate: 'busy-session',
      passed: true,
      detail: 'nothing other than the caller turn is busy',
    }
  }
  const listed = blocked.join(', ')
  const waiting = [
    ...new Set(
      input.busy.value
        .filter((source) => !isCallerTurn(source))
        .flatMap((source) =>
          source.kind === 'turn'
            ? [normalizeSessionId(source.sessionId) || source.sessionId]
            : source.ownerSession === undefined
              ? []
              : [normalizeSessionId(source.ownerSession) || source.ownerSession],
        )
        .filter((id) => id !== '' && id !== self),
    ),
  ].sort()
  if (input.force) {
    return {
      gate: 'busy-session',
      passed: true,
      detail: `${String(blocked.length)} other active source(s) would be interrupted (${listed}) — overridden by force`,
      overrideTrace: `force override: ${String(blocked.length)} active source(s) were interrupted (${listed})`,
      blockedSessions: waiting,
    }
  }
  return {
    gate: 'busy-session',
    passed: false,
    code: 'busy',
    verdict: `refused by the busy-session gate: ${String(blocked.length)} other active source(s) would be interrupted (${listed}), and interrupting a running turn cannot be undone`,
    // ⚠️ 原话是「等那些跑完再调」—— 但阻塞者是 `job:<id>` / `turn:session-<uuid>` /
    // `schedule:<id>`，而本插件 8 个工具里**没有任何一个**能列后台作业、看别的会话的回合、
    // 看定时提醒 ⇒ 模型观察不到它们何时结束，只能盲重试；而盲重试会再被闸②拒、或撞上闸①
    // 的 60 秒冷却，且模型分不清是哪一道。⇒ 把「等」交给人，只留可兑现的那半。
    remedy:
      'those blockers are other sessions (turns), background jobs or schedules, and this tool cannot watch them finish; ask the user whether to wait or to interrupt them, and calling again with force: true interrupts them',
    evidence: blocked,
  }
}

/**
 * 一个忙来源的短标签（进 `evidence` / `detail`，所以是英文、无空格）。
 *
 * @param source 忙来源。
 */
function busyLabel(source: BusySource): string {
  switch (source.kind) {
    case 'turn':
      return `turn:${normalizeSessionId(source.sessionId) || source.sessionId}`
    case 'job':
      return `job:${source.jobId}`
    case 'schedule':
      return `schedule:${source.scheduleId}`
  }
}

/** 闸③的输入。 */
export interface CompositionInput {
  /** profile 的 bundle 表解析结果。`known: false` = 解析不了。 */
  bundles: Observed<readonly string[]>
}

/**
 * 闸③：bundle 表解析不了。
 *
 * 解析不了就不许重启 —— 一个载入不了组合的宿主比现在这个更糟，而 `dsh_dump_config`
 * 正是「看清组合到底解析成什么」的那个工具（指路而不是让模型自己猜）。
 *
 * @param input bundle 表观测。
 */
export function judgeComposition(input: CompositionInput): GateDecision {
  if (!input.bundles.known) {
    return {
      gate: 'composition',
      passed: false,
      code: 'bad-composition',
      verdict: `refused by the composition gate: the profile bundle table could not be parsed (${input.bundles.reason}), so this tool cannot tell what the restarted host would load`,
      remedy:
        'run dsh_dump_config to see what the composition actually resolves to, fix the profile, then call again',
      evidence: [input.bundles.reason],
      suggestedTool: 'dsh_dump_config',
    }
  }
  return {
    gate: 'composition',
    passed: true,
    detail: `${String(input.bundles.value.length)} bundle(s) parsed`,
  }
}

/** 一条启动命令。 */
export interface LaunchCommand {
  /** 可执行文件（绝对路径或 PATH 上的名字）。 */
  command: string
  args: readonly string[]
  /** 工作目录。 */
  cwd: string
}

/** 闸④的输入。 */
export interface LaunchCommandInput {
  /** 启动命令的解析结果。`known: false` = 定不出来。 */
  launch: Observed<LaunchCommand>
}

/**
 * 闸④：拿不到启动命令。
 *
 * 「拿不到」与「拿到了但是空的」都拒绝，理由同一条：**不猜**。
 * 猜错的代价是进程没了、也没人把它拉回来 —— 那是这套东西里唯一不可逆的失败。
 *
 * @param input 启动命令观测。
 */
export function judgeLaunchCommand(input: LaunchCommandInput): GateDecision {
  const nothing = (why: string): GateRefusal => ({
    gate: 'launch-command',
    passed: false,
    code: 'no-launch-command',
    verdict: `refused by the launch-command gate: ${why}, and this tool does not guess how to bring the host back up`,
    remedy: 'start the host again yourself, or fix the launch configuration so it can be determined',
    evidence: [why],
    manual: true,
  })
  if (!input.launch.known) return nothing(input.launch.reason)
  if (input.launch.value.command.trim() === '') {
    return nothing('the resolved launch command is empty')
  }
  return {
    gate: 'launch-command',
    passed: true,
    detail: `launch command resolved (${input.launch.value.command})`,
  }
}

/** `planRestart` 的请求面（工具参数 → 这里的映射由工具半边做）。 */
export interface RestartRequest {
  /** `$DSH_HOME`（marker 落点的第一段）。 */
  dshHome: string
  /** 为什么重启（逐字进 marker）。 */
  reason: string
  /** 发起本次调用的会话。 */
  callingSession: string
  /** 显式覆盖闸②。 */
  force: boolean
  /** 只演练、不落盘。 */
  dryRun: boolean
}

/**
 * `planRestart` 的 IO 端口 —— **本层唯一的取数面**。
 *
 * 真实实现由工具半边接到宿主服务上（`agents.list` 的 `status` / `jobs.list` /
 * `workspace/session-activity` / profile 的 `package.json` / `process.argv`）。
 * 每个方法都**不该抛**；抛了由 {@link planRestart} 收敛成结构化失败。
 */
export interface RestartPorts {
  /** marker 的读写端口。 */
  fs: RestartFsPort
  /** 闸①：历史重启时刻（毫秒纪元）。 */
  restartHistory(): Promise<Observed<readonly number[]>>
  /** 闸②：当前忙的来源（会话回合 / 后台作业 / 定时提醒，**含调用方自己的**）。 */
  busySessions(): Promise<Observed<readonly BusySource[]>>
  /** 闸③：profile 的 bundle 表。 */
  bundles(): Promise<Observed<readonly string[]>>
  /** 闸④：启动命令。 */
  launchCommand(): Promise<Observed<LaunchCommand>>
  /** 现在（毫秒纪元）；只为测试注入。 */
  now(): number
}

/** 四道闸全过、marker 已按 `dryRun` 处理。 */
export interface RestartPlanReady {
  kind: 'ready'
  /** 这次是演练（没有落盘）。 */
  dryRun: boolean
  /**
   * marker 真的落盘了吗。
   *
   * **工具半边的顺序判据**：只有它为 `true` 才允许拉起新进程；为 `false`（演练）时
   * 不许拉起、也不许让本进程退出。这就是 SHAPE §6.1 那句「写 marker 必须在拉起之前」
   * 在接口上的落点 —— 不是一句注释。
   */
  markerWritten: boolean
  marker: RestartMarker
  markerPath: string
  /** 拉起新进程要用的命令（本层不执行）。 */
  launch: LaunchCommand
  /** 模型读到的 L1。 */
  verdict: string
}

/** 被某一道闸拒绝。 */
export interface RestartPlanRefused {
  kind: 'refused'
  /** 是哪一道闸。 */
  gate: GateId
  code: RefusalCode
  verdict: string
  remedy: string
  evidence: readonly string[]
  /** 它之前已经过了的闸（拒绝时「走到了哪一步」比「四道闸」更准）。 */
  gatesPassed: readonly GateId[]
  suggestedTool?: string
  manual?: true
}

/** 本层自己的意外（**不是**闸门拒绝）。 */
export interface RestartPlanFailed {
  kind: 'failed'
  verdict: string
  detail: string
}

/** `planRestart` 的结果。 */
export type RestartPlan = RestartPlanReady | RestartPlanRefused | RestartPlanFailed

/**
 * 四道闸 + marker 落盘的**唯一入口**。
 *
 * 判据函数被测**不等于**接进了入口（本仓坑 42 的接线断言就是治这个的），所以
 * 测试里凡涉及「拒绝」与「放行」的用例都从这里进。
 *
 * 顺序：闸① → 闸② → 闸③ → 闸④ → 建 marker →（`dryRun` 则止步）→ 写 marker。
 * **任一闸不过即拒绝，且一次都不许写** —— 留下半份 marker 会让下一次启动去恢复一个
 * 从未发生的重启。
 *
 * **绝不抛**（B24 的承载条件）：端口抛异常也收敛成 {@link RestartPlanFailed}。
 *
 * @param request 请求面。
 * @param ports IO 端口。
 */
export async function planRestart(request: RestartRequest, ports: RestartPorts): Promise<RestartPlan> {
  try {
    if (request.dshHome.trim() === '') {
      return {
        kind: 'failed',
        verdict:
          'the restart was not planned: no $DSH_HOME is known, so the marker has nowhere to go',
        detail: 'dshHome is empty',
      }
    }
    const now = ports.now()

    const loop = judgeRestartLoop({ history: await ports.restartHistory(), now })
    if (!loop.passed) return refusalFrom(loop, [])

    const busyDecision = judgeBusySession({
      busy: await ports.busySessions(),
      callingSession: request.callingSession,
      force: request.force,
    })
    if (!busyDecision.passed) return refusalFrom(busyDecision, ['restart-loop'])

    const composition = judgeComposition({ bundles: await ports.bundles() })
    if (!composition.passed) return refusalFrom(composition, ['restart-loop', 'busy-session'])

    const launchObservation = await ports.launchCommand()
    const launchDecision = judgeLaunchCommand({ launch: launchObservation })
    if (!launchDecision.passed) {
      return refusalFrom(launchDecision, ['restart-loop', 'busy-session', 'composition'])
    }
    const launch = launchObservation.known ? launchObservation.value : undefined
    if (launch === undefined || launch.command.trim() === '') {
      // 判据刚说它过了 —— 走到这里说明判据与取值不一致。响亮失败，不猜（两层必须同意同一套规则）。
      return {
        kind: 'failed',
        verdict:
          'the restart was not planned: the launch-command gate passed an observation that carries no command',
        detail: 'launch-command judge and reader disagree',
      }
    }

    const blockers = blockingSessions(busyDecision, request.callingSession)
    const sessions = [
      ...new Set([normalizeSessionId(request.callingSession), ...blockers].filter((id) => id !== '')),
    ].sort()
    const marker = buildRestartMarker({
      reason: request.reason,
      now,
      sessions,
      gates: [
        'restart-loop=pass',
        'busy-session=pass',
        'composition=pass',
        'launch-command=pass',
      ],
      ...(busyDecision.overrideTrace === undefined
        ? {}
        : { overrideTrace: busyDecision.overrideTrace }),
    })
    const markerPath = restartMarkerPath(request.dshHome)

    if (request.dryRun) {
      return {
        kind: 'ready',
        dryRun: true,
        markerWritten: false,
        marker,
        markerPath,
        launch,
        verdict: `gates=4/4 passed · marker=${markerPath} · dry run: nothing was written`,
      }
    }
    // ⚠️ **写失败必须单独收敛**（S6 的因果修正）：写已经发出去了，而端口契约只要求
    // 「失败要抛」、**没有原子性承诺**（见 {@link RestartFsPort.write}）⇒ 部分落盘是可能的。
    // 所以这一格**不许**说「什么都没写」，也不许把它归到「闸门检查出错」上。
    try {
      await writeRestartMarker(ports.fs, request.dshHome, marker)
    } catch (error) {
      return {
        kind: 'failed',
        verdict: `the restart was not started: the marker write failed (${messageOf(error)}), so nothing was relaunched and the marker may be absent or incomplete on disk`,
        detail: messageOf(error),
      }
    }
    return {
      kind: 'ready',
      dryRun: false,
      markerWritten: true,
      marker,
      markerPath,
      launch,
      verdict: `gates=4/4 passed · marker=${markerPath} · marker written before any launch; this half does not start the process, so no new pid exists yet`,
    }
  } catch (error) {
    // 走到这里说明**还没轮到写 marker**（写那一步有自己的 catch 在上面）——
    // 于是「什么都没写」在这一格是**结构性成立**的，不再是审查员指出的那句推断。
    return {
      kind: 'failed',
      verdict: `the restart was not planned: an unexpected error stopped the restart before the marker was written (${messageOf(error)}), so nothing was written`,
      detail: messageOf(error),
    }
  }
}

/**
 * 建一份 marker。
 *
 * `overrideTrace` **没有真覆盖就不许传** —— 有它才有 `force: true`，两者同进同出，
 * 于是「`force` 命中必须留痕」是结构性的：不可能出现「记了覆盖却没留痕」的 marker。
 *
 * @param input 内容。
 */
export function buildRestartMarker(input: {
  reason: string
  now: number
  sessions: readonly string[]
  /** 四道闸的轨迹。 */
  gates: readonly string[]
  /** 闸②被真覆盖时的留痕（只在真覆盖时传）。 */
  overrideTrace?: string
}): RestartMarker {
  const trace = [
    ...input.gates,
    ...(input.overrideTrace === undefined ? [] : [input.overrideTrace]),
    `waiting for ${String(input.sessions.length)} session(s) to come back`,
  ]
  return {
    version: MARKER_VERSION,
    reason: input.reason,
    at: new Date(input.now).toISOString(),
    sessions: [...new Set(input.sessions)].sort(),
    // 写出去的一律是 `armed`（显式写出，不靠「缺席 = armed」那个兼容默认）——
    // 默认是给**老 marker** 用的读侧规则，不是省一个字段的理由。
    state: 'armed' as const,
    ...(input.overrideTrace === undefined ? {} : { force: true as const }),
    trace,
  }
}

/** 恢复判定的结果。 */
export type RecoveryDecision =
  /**
   * 无事可做。**两种原因必须分得开**（防空转：它们的渲染/取值不同）：
   * `absent` = 根本没有 marker；`consumed` = 有，但已经处理过了（还带着那份审计记录）。
   */
  | { action: 'none'; reason: 'absent' }
  | { action: 'none'; reason: 'consumed'; marker: RestartMarker; verdict: string }
  | {
      action: 'recover'
      marker: RestartMarker
      /** 要等回来的会话名单。 */
      sessions: readonly string[]
      /** 这次是覆盖过的（下一次启动仍应把这件事说出去）。 */
      overridden: boolean
      verdict: string
    }
  | {
      action: 'refuse'
      code: 'unsupported-version' | 'malformed' | 'unreadable'
      verdict: string
      remedy: string
      evidence: readonly string[]
    }

/**
 * 恢复判定：**启动时**拿着一次 marker 读取的结果，决定接下来做什么。
 *
 * ⚠️ 这里只有判定，**没有落地执行**（真正「等会话 → 投 notice → 消费 marker」在工具半边）。
 * 判定的核心是一条三值纪律：**「读到了但没懂」不是「没有」**——
 * 压成 `none` 就等于静默放弃恢复，而人看到的只是一次「正常」启动。
 *
 * 三个「`none` 邻居」的边界要划准（`task-32`）：
 * - **`absent`** ⇒ `none`（没有待办）；
 * - **`consumed`** ⇒ `none`，但**带上那份 marker 与一句话**（「已经处理过了」是审计事实，
 *   与「什么都没有」不是一回事）；
 * - **`unsupported-version` / `malformed` / `unreadable`** ⇒ **`refuse`**，绝不是 `none`。
 *
 * @param read 一次 marker 读取。
 */
export function decideRecovery(read: MarkerRead): RecoveryDecision {
  switch (read.status) {
    case 'absent':
      return { action: 'none', reason: 'absent' }
    case 'ok': {
      if (markerState(read.marker) === 'consumed') {
        return {
          action: 'none',
          reason: 'consumed',
          marker: read.marker,
          verdict:
            'a restart marker was found but it has already been consumed, so this startup has nothing to recover',
        }
      }
      return {
        action: 'recover',
        marker: read.marker,
        sessions: read.marker.sessions,
        overridden: read.marker.force === true,
        verdict: `a restart marker was found: wait for ${String(read.marker.sessions.length)} session(s) to come back, deliver the notice, then consume the marker`,
      }
    }
    case 'unsupported-version':
      return {
        action: 'refuse',
        code: 'unsupported-version',
        verdict: `a restart marker exists but its format version (${String(read.version)}) is not supported, so this tool will not guess what it means`,
        remedy:
          'inspect the marker, then either update the plugin or delete the marker and restart by hand; it is left in place on purpose',
        evidence: [String(read.version)],
      }
    case 'malformed':
      return {
        action: 'refuse',
        code: 'malformed',
        verdict: `a restart marker exists but cannot be parsed (${read.reason}), so this tool will not guess what it means`,
        remedy: 'inspect the marker and delete it once you know what happened; it is left in place on purpose',
        evidence: [read.reason],
      }
    case 'unreadable':
      return {
        action: 'refuse',
        code: 'unreadable',
        verdict: `a restart marker may exist but could not be read (${read.reason}), so this tool cannot tell whether a restart is pending`,
        remedy: 'fix whatever keeps the marker unreadable and start again; an unreadable marker is not an absent one',
        evidence: [read.reason],
      }
  }
}

/**
 * 把一道拒绝的判定转成计划里的拒绝（只搬字段，不改语义）。
 *
 * @param decision 拒绝判定。
 * @param gatesPassed 它之前过了的闸。
 */
function refusalFrom(decision: GateRefusal, gatesPassed: readonly GateId[]): RestartPlanRefused {
  return {
    kind: 'refused',
    gate: decision.gate,
    code: decision.code,
    verdict: decision.verdict,
    remedy: decision.remedy,
    evidence: decision.evidence,
    gatesPassed,
    ...(decision.suggestedTool === undefined ? {} : { suggestedTool: decision.suggestedTool }),
    ...(decision.manual === undefined ? {} : { manual: decision.manual }),
  }
}

/**
 * 从闸②的判定里取回「除调用方外还有谁在忙」。
 *
 * 只在闸②放行之后调：放行时要么没人忙（`blockers` 缺席），要么是覆盖过的一次
 * （`blockers` 带着被打断的会话）。**数据是判据给的，不从渲染文本里回读。**
 *
 * @param decision 闸②的判定。
 * @param callingSession 调用方会话。
 */
function blockingSessions(decision: GatePass, callingSession: string): readonly string[] {
  const self = normalizeSessionId(callingSession)
  return (decision.blockedSessions ?? []).filter((id) => id !== '' && id !== self)
}

/**
 * 判断一个值是不是字符串（数组字段过滤用）。
 *
 * @param value 任意值。
 */
function isString(value: unknown): value is string {
  return typeof value === 'string'
}

/**
 * 取一句话错误描述（**绝不抛**）。
 *
 * @param error 任意异常。
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
