/**
 * `dsh_restart` 的**恢复半** —— 新宿主启动时的那条链。
 *
 * ## 它做什么（顺序是判据）
 *
 * ```
 * 读 marker → decideRecovery → 按名单逐个唤醒 → 投 notice → **全部成功才**标已消费
 * ```
 *
 * ## 唤醒走哪条通道（`task-34` 实测确认，别再自己论证）
 *
 * `ctx.sessionController.resolveAgent(sessionId)`：对**冷会话**（只有持久化日志、本进程
 * 还没 attach）**真的会 resume**（HOST-CONTRACTS §2.4.1 的 C15），返回 `{agent}` 或
 * `{error}`；返回的 `{agent}` 可以**立刻** `followup`（C20），投递形状是 source
 * `form:'notice'`（C12 / C21）。三条配套事实决定了本文件的形状：
 *
 * - ⚠️ **本机没有 `agent/session-start`**（C12，全包 grep 0 命中）⇒ 参考实现 README 里
 *   那条投递通道**不可照抄**；可用的是 `agent.followup(UserMessage)` + `form:'notice'`。
 * - ⚠️ **不会自己回来**（C24）：启动后没有任何东西自动激活会话 ⇒ **必须显式调**
 *   `resolveAgent`，不调就一直是冷的。
 * - ⚠️ **`sessionController` 在 apply 的第一刻是 `undefined`**（C26，实测 138–157 ms 后才有）
 *   ⇒ 本层的唤醒是「延迟 + 重试」，且**每次现取服务**（不缓存）。
 * - ⚠️ **`followup` 是「唤醒」不是「显示」**（C23）：它会真的开一个 turn、模型会被调用。
 *   那是设计后果，**不是可以绕开的缺陷**。
 * - ⚠️ **notice 必须带非空 `summary`（≤120 字符）**（C22）：缺了客户端退回 opaque，
 *   人看不见它是一行 notice。
 *
 * ## 三件不许做错的事
 *
 * 1. **两个 `action:'none'` 必须分开**：`absent`（根本没有 marker）与 `consumed`（有、
 *    但已经处理过了）是两件事。合并它们就是把「已消费」静默当成「没有 marker」——
 *    审计记录消失，「上次重启是什么时候」再也答不出来（闸①的熔断也靠这份记录）。
 * 2. **读不到 ≠ 没有**：`unreadable` / `malformed` / `unsupported-version` 一律
 *    `refused` + **留痕**（日志一行）+ 结构化报告，**绝不**压成 `absent` 静默跳过。
 * 3. **唤醒失败 ⇒ 保留 marker**（不标已消费），下次启动再试。**没有**「超时之后把 marker
 *    清掉」这条路 —— 那会把证据一起删掉、永久不可恢复（`dsh-restart` 的反面教材）。
 *
 * ## 顺序：notice 在 consume 之前，所以 notice 说的是「会被消费」
 *
 * 先唤醒投递、**全部成功之后**才写回 `consumed`。于是 notice 里那句不能写成「已经消费了」
 * —— 写回失败时它就是假话。它写的是「这条 notice 投出去之后就会被标为 consumed，
 * 文件留在盘上作为审计记录、不删除」：事实一样完整，且与真实顺序一致。
 *
 * ## 代价（如实记，别当缺陷修）
 *
 * 部分会话唤醒失败时**整份 marker 都保留**（那是硬要求），于是下次启动会把 notice
 * **再投一次**给上次已经唤醒成功的会话。重复一条信息性 notice 的代价，小于
 * 「静默丢掉一次恢复」的代价 —— 而后者是不可逆的。
 */
import { randomUUID } from 'node:crypto'

import { createRestartFsPort, type ContextLike } from './restart-fs.js'
import {
  consumeRestartMarker,
  decideRecovery,
  readRestartMarker,
  type RecoveryDecision,
  type RestartFsPort,
  type RestartMarker,
} from './restart.js'

/**
 * 投递来源的 `kind`（逐字等于 `package.json` 的 `name`）。
 *
 * 客户端按 `kind` 归因，所以它必须与本包名一致；`test/tools/restart-recovery.test.ts`
 * 有一条自证盯着这个字面量（与 `restartMarkerPath` 的命名空间自证同族）。
 */
export const NOTICE_SOURCE_KIND = 'dsh-plugin-debugging'

/**
 * `summary` 的长度上限（宿主 `CONTEXT_SUMMARY_MAX_CHARS` = 120）。
 *
 * 我们**不** import 宿主那个常量：`@deepseek-ai/dsh-llm` 是宿主安装树里的包，从本仓的
 * 解析上下文拿不到（活跃坑 19 同族）。所以这里按 `[已核]` 的值再放一份，并配一条
 * 「超长输入被截到 ≤120」的判据 —— 值漂了那条判据会红。
 */
export const NOTICE_SUMMARY_MAX_CHARS = 120

/**
 * 「要看现在怎么样」该调的那个工具。
 *
 * ⚠️ 它**不再**与重启壳的 `nextStep` 同源：壳的演练支现在说的是「再调一次 `dsh_restart`、
 * 去掉 `dryRun`」（原来那个指针指向本工具、还硬编码了 `change: 'config'`，已按 B1 改掉），
 * 闸门拒绝支里只有闸③指 `dsh_dump_config`。这里的指针是**恢复半自己**的判断：
 * 重启的常见理由就是「改了宿主端代码」，起来之后该问的正是「现在生效了吗」。
 */
export const STATE_TOOL = 'dsh_check_effect_mode'

/**
 * 启动期恢复的延迟（毫秒）。
 *
 * 取值理由：`task-34` 实测 `sessionController` 在 apply 后 **138–157 ms** 才有（C26），
 * 所以秒级以下就够；取 1 秒是那个观测值的约 6 倍，给「服务起来得比探针那次慢」留余量，
 * 同时不让 notice 白等。**不是**参考实现那个 3 秒 —— 那是对 `agents.get` 的经验值
 * （C13），而 `resolveAgent` **没有就绪窗口**（C25），两者不是一回事。
 *
 * ⚠️ **别把这个数当成「服务可用窗口」的通用值**（C32）：另一套探针在同一组合里量到 `fs`
 * **2.2–2.5 s**、`sessionController` **2.4–2.8 s** 才可用，而那两个数是**从探针自己的 apply
 * 起算**的，与 C26 的基准不是同一个 ⇒ **两个窗口不能混着用**（C32 的成因仍标 `[无法判定]`）。
 * 本层的兜底因此**不是**「把 1 秒调大」，而是**重试 + 失败保留 marker**：
 * `RECOVERY_WAKE_ATTEMPTS` 次 × `RECOVERY_WAKE_RETRY_MS` 覆盖到 apply 后约 2.5 秒；
 * 真到那时还没就绪就如实报 `pending`、marker 留盘、**下次启动再试**（绝不清掉它）。
 */
export const RECOVERY_STARTUP_DELAY_MS = 1_000

/**
 * 每个会话的唤醒尝试次数上限。
 *
 * 「等不到」是**正常分支**（C10）：它只意味着这次恢复做不成，**不**意味着要把 marker
 * 清掉。重试是为了吃掉「服务还没起来」，不是为了保证成功。
 */
export const RECOVERY_WAKE_ATTEMPTS = 5

/** 两次唤醒尝试之间的等待（毫秒）。5 次 × 300 ms 覆盖到启动后约 1.5 秒。 */
export const RECOVERY_WAKE_RETRY_MS = 300

/**
 * 写 marker 时显式传给宿主 `fs.writeText` 的**文件沙箱**档位。
 *
 * **必须显式给**：默认档 `workspace-write` 下 `$DSH_HOME` 不在 writableRoots 里 ⇒ 必被
 * `FS_SANDBOX_DENIED` 拒掉（`task-31` 真机实测，见 `src/lib/restart-fs.ts` 文件头）。
 * 它只影响文件沙箱，与审批档无关 —— 两道门互不替代。
 *
 * ## 为什么这个字面量住在这里（两半都 import 它）
 *
 * 重启的**两个半边**（工具壳 `src/tools/dsh_restart.ts` 与恢复半）都要显式传它，
 * 所以它只能有**一处**字面量（一处一事实：抄两份就会出现「改了一处、另一处还按旧档」）。
 * 落点选本文件而不是 `restart-fs.ts` / `restart.ts`：那两份当时的改动范围之外，
 * 而本文件是**两个半边都 import 得到**、且**恢复半不 import 工具半**（反向依赖会成环）
 * 的那一格。
 */
export const RESTART_SANDBOX_MODE = 'danger-full-access'

/** 一条 notice 的两半：正文与折叠行上的一句话。 */
export interface RecoveryNotice {
  /** 正文（英文；进 `UserMessage` 的 content，模型与人都会看到）。 */
  text: string
  /** `form:'notice'` 的 `summary`：**非空、单行、≤120 字符**（C22）。 */
  summary: string
}

/**
 * 投递给宿主 `agent.followup` 的那条消息（**结构面**）。
 *
 * 刻意**不** import 宿主的 `createUserMessage` / `UserMessage`：那是宿主安装树里的包，
 * 从本仓的解析上下文拿不到（活跃坑 19）。形状取自 `task-34` 的实测探针（它就是这样
 * 手搓、并被宿主接受、落成持久的 user-role 消息 —— C21），以及宿主自己的
 * `modelSwitchNotice`（`dsh-agent` 的 `lib/index.js`，`createUserMessage({content, source})`）。
 */
export interface NoticeMessage {
  readonly id: string
  readonly role: 'user'
  readonly content: readonly { readonly type: 'text'; readonly text: string }[]
  readonly source: {
    readonly kind: string
    readonly form: 'notice'
    readonly summary: string
  }
}

/**
 * 造那条 `UserMessage`（**纯函数**，`id` 注入以便判据可复现）。
 *
 * @param notice notice 的两半。
 * @param id 消息 id（宿主 `createUserMessage` 也会自己造一个）。
 */
export function noticeMessageOf(notice: RecoveryNotice, id: string): NoticeMessage {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text: notice.text }],
    source: { kind: NOTICE_SOURCE_KIND, form: 'notice', summary: notice.summary },
  }
}

/**
 * 把 `summary` 截到 {@link NOTICE_SUMMARY_MAX_CHARS} 以内。
 *
 * 用 ASCII 的 `...` 而不是省略号：本仓的 `src/` 字符串一律保持 ASCII
 * （B14 只禁 CJK，但「别在模型可见字符串里引入非 ASCII」是更省事的同一条纪律）。
 *
 * @param summary 原始一句话。
 */
export function boundNoticeSummary(summary: string): string {
  if (summary.length <= NOTICE_SUMMARY_MAX_CHARS) return summary
  return `${summary.slice(0, NOTICE_SUMMARY_MAX_CHARS - 3)}...`
}

/**
 * 造这条 notice —— **只放事实 + 指针**（决策笔记 §决定那张表的第 2 行）。
 *
 * 四件事实：什么时候重启的、停机多久、为什么、marker 的下场；一个指针：要看现状调哪个工具。
 * ⚠️ **不塞状态快照**（那是「当前状态」的第二个 home，而且只是开机瞬间的值）；
 * ⚠️ **不写「请继续」**（决策笔记「替代方案与被否的理由」第 3 条明确否决：重启后该不该
 * 接着干是语义判断，工具没有足够上下文，把它留给 Agent）。
 *
 * `at` 解析不出来时**不编**停机时长，而是把「推不出来」本身写成一句事实 ——
 * 三值纪律在渲染层同样成立。
 *
 * ## marker 的下场只能写成**条件句**（C31 实测钉住的）
 *
 * 这条 notice 是在**消费之前**投出去的（顺序是判据：全部唤醒成功才标已消费），所以
 * 「marker 会不会被消费」在这一刻**还不知道**。C31 真机实测：marker 留在 `armed` 的同时，
 * 投出去的 notice 的 `summary` 仍写着 `- marker consumed` —— **通知与盘上状态不符**。
 * ⇒ 正文写成条件句（全部唤醒成功才消费，否则留盘、下次再试），而 `summary` **不许**
 * 断言消费：它是客户端折叠行上唯一能被人看见的那一句。
 *
 * @param marker 要恢复的那份 marker。
 * @param now 现在（毫秒纪元）。
 */
export function buildRecoveryNotice(marker: RestartMarker, now: number): RecoveryNotice {
  const at = Date.parse(marker.at)
  const downSeconds = Number.isFinite(at) ? Math.max(0, Math.round((now - at) / 1000)) : undefined
  const facts = [
    // ⚠️ 「请求重启的时刻」**不是**「已重启的时刻」（S5）：写 marker 在**拉起之前**，
    // 新进程还要等 `delayMs`（默认 10s）才起来。原话 `the host was restarted at …` 把两者
    // 混成一件，于是 `down for about Xs` 把「延迟窗口 + 存活时间 + 启动耗时」全算进停机
    // ⇒ **系统性高估**（而且这份 marker 也可能是「写了、拉起失败」的那种）。
    `a restart was requested at ${marker.at}`,
    downSeconds === undefined
      ? 'the time since that request could not be derived from that timestamp'
      : `this notice arrived about ${String(downSeconds)}s after that request`,
    `the recorded reason was: ${marker.reason}`,
    // 覆盖过就说得出来（`decideRecovery` 的 `overridden` 正是为此保留的）。
    ...(marker.force === true
      ? ['the restart was forced: other active work was interrupted']
      : []),
    // ⚠️ **条件句，不是既成事实**（C31）：这一刻还不知道这次恢复能不能消费掉它。
    'the restart marker is consumed only if every listed session can be woken, as the last step of this recovery; otherwise it stays armed and the next startup tries again (either way it stays on disk as an audit record, it is not deleted)',
    // 重复投递**如实说出来**（O5）：部分会话唤醒失败时整份 marker 保留（那是硬要求，
    // 见文件头「代价」一节），于是下次启动会把 notice 再投一次给上次已成功的会话。
    'this notice can be delivered more than once: if a later startup finds the marker still armed, it is sent again to every listed session',
  ]
  // ⚠️ 指针要写清那个工具的**必填参数**（O4）：`dsh_check_effect_mode` 的 `change` 是 required
  // （四选一），只印工具名会让模型带着空参数去调。
  const text = `[${NOTICE_SOURCE_KIND}] restart recovery: ${facts.join('; ')}. to see the current state, call ${STATE_TOOL} with the kind of change you made.`
  return {
    text,
    // ⚠️ **不许写 `- marker consumed`**（C31）：投出去的这一刻消费还没发生，
    // 而 marker 保留（pending）时那句话就是假的。
    // 同样地，**不许**写「已重启」——那只是「请求重启的时刻」（S5）。
    summary: boundNoticeSummary(`restart requested at ${marker.at} - restart recovery`),
  }
}

/** 一次唤醒尝试的结果。**失败要带原因**（原因进日志与结构化报告）。 */
export type WakeOutcome = { ok: true } | { ok: false; reason: string }

/**
 * 唤醒面（**唯一的宿主注入点**）。
 *
 * 一个方法而不是两个（`resolve` + `followup`）：它俩必须**紧挨着**做（C20：resolve 返回的
 * `{agent}` 可以立刻 followup，不需要等就绪窗口），拆成两步只会让调用方有机会在中间插
 * 一个 await 并把那个窗口破坏掉。
 */
export interface RecoveryChannel {
  /**
   * 唤醒一个会话并投一条 notice。
   *
   * **不抛**：`resolveAgent` 的失败按 `{error}` 分支判（C4 / C16，别靠 try/catch）、
   * `followup` 抛异常也收敛成 `{ok:false}`。
   *
   * @param sessionId 运行期键（`session-<uuid>`）。
   * @param notice 要投的那条 notice。
   */
  wakeAndNotify(sessionId: string, notice: RecoveryNotice): Promise<WakeOutcome>
}

/** 本层的 IO 端口 —— 与 `planRestart` 的 `RestartPorts` 同一种设计（纯逻辑可单测）。 */
export interface RecoveryPorts {
  /** marker 的读写端口（真实实现走宿主 `ctx.fs`）。 */
  fs: RestartFsPort
  /** 唤醒 + 投递。 */
  channel: RecoveryChannel
  /**
   * 留痕（英文短句）。
   *
   * 它是 `refuse` 分支**唯一**的可查痕迹（marker 留在盘上、结构化报告只回到调用方），
   * 所以实现方**不许**把它做成静默的空操作。
   */
  log(line: string): void
  /** 现在（毫秒纪元）；只为测试注入。 */
  now(): number
  /** 等待；只为测试注入（判据里立即返回，不真等）。 */
  sleep(ms: number): Promise<void>
}

/** 一次唤醒失败的记录。 */
export interface WakeFailure {
  sessionId: string
  /** **最后一次**尝试的原因。 */
  reason: string
  /** 实际尝试了几次。 */
  attempts: number
}

/** 恢复判定里 `refuse` 那一支的码 —— 从 `restart.ts` 的类型里取，不另抄一份闭集。 */
export type RecoveryRefusalCode = Extract<RecoveryDecision, { action: 'refuse' }>['code']

/** 启动期恢复的请求面。 */
export interface RecoveryRequest {
  /** `$DSH_HOME`（marker 落点的第一段）。 */
  dshHome: string
}

/**
 * 启动期恢复的结论。
 *
 * **`idle` 的两个 `reason` 必须分得开**：它们渲染/取值不同，且 `consumed` 带着那份
 * 审计记录（「上次重启是什么时候」）。合并它们就是本卡要防的那一种静默。
 */
export type RecoveryOutcome =
  /** 没有待办。`absent` = 根本没有 marker；`consumed` = 有，但处理过了。 */
  | { kind: 'idle'; reason: 'absent'; verdict: string }
  | { kind: 'idle'; reason: 'consumed'; marker: RestartMarker; verdict: string }
  /** 全部会话都唤醒并投递成功，marker 已标已消费。 */
  | {
      kind: 'recovered'
      marker: RestartMarker
      /** 盘上那份（已带 `state: 'consumed'`）。 */
      consumed: RestartMarker
      woken: readonly string[]
      notice: RecoveryNotice
      /** **根因事实**：marker 真的标成已消费了吗（判据断言这一格，不断言「没报错」）。 */
      markerConsumed: true
      verdict: string
    }
  /** 有会话唤醒失败 ⇒ marker **保留**，下次启动再试。 */
  | {
      kind: 'pending'
      marker: RestartMarker
      woken: readonly string[]
      failures: readonly WakeFailure[]
      markerConsumed: false
      verdict: string
    }
  /** 读到了但没懂 ⇒ **绝不静默**：留痕 + 结构化报告，marker 原地不动。 */
  | {
      kind: 'refused'
      code: RecoveryRefusalCode
      verdict: string
      remedy: string
      evidence: readonly string[]
    }
  /** 本层自己的意外（**不是**上面任何一种判定）。 */
  | { kind: 'failed'; verdict: string; detail: string }

/**
 * 启动期恢复的**唯一入口**。
 *
 * 顺序：读 marker → 判定 → （`recover` 时）逐个唤醒 + 投 notice → **全部成功才**消费。
 * **绝不抛**（启动期逻辑把宿主带崩是这套东西里最不可接受的一种失败）。
 *
 * 名单会**去重**：`parseMarker` 只过滤非字符串、不去重，而手改过的 marker 里重复的 id
 * 会让同一个会话被唤醒两次（重复一条 notice 是小事，但没理由照做）。
 *
 * @param request 请求面。
 * @param ports IO 端口。
 */
export async function recoverRestart(
  request: RecoveryRequest,
  ports: RecoveryPorts,
): Promise<RecoveryOutcome> {
  // ⚠️ **marker 写回到哪一步了**：兜底分支的结论要靠这个**事实**分岔，不许恒说
  // 「marker was not touched」——那个 catch 也盖住 `consumeRestartMarker` 抛异常那一格，
  // 而写已经发出去了、部分落盘是可能的（`RestartFsPort.write` 只承诺「失败要抛」，
  // 没有原子性承诺）。这与 `dsh_restart` 兜底那句 stage-blind 的「没开始」是**同一族**
  // 漏改落点（本卡同族自查的第三处）。
  let markerWrite: 'none' | 'attempted' | 'done' = 'none'
  try {
    if (request.dshHome.trim() === '') {
      return failed(
        'the restart recovery did not run: no $DSH_HOME is known, so the marker cannot be located',
        'dshHome is empty',
        ports,
      )
    }

    const read = await readRestartMarker(ports.fs, request.dshHome)
    const decision = decideRecovery(read)

    switch (decision.action) {
      case 'none': {
        if (decision.reason === 'absent') {
          // 安静是**对**的：这里确实什么都没有，留痕只会变成每次启动一条噪音。
          return {
            kind: 'idle',
            reason: 'absent',
            verdict: 'no restart marker is present, so this startup has nothing to recover',
          }
        }
        // ⚠️ 这一支**必须**与上面分开：marker 在、只是处理过了 —— 它仍是一条审计记录。
        return {
          kind: 'idle',
          reason: 'consumed',
          marker: decision.marker,
          verdict: decision.verdict,
        }
      }
      case 'refuse': {
        // **读到了但没懂**：留痕 + 结构化报告，marker 原地不动（给人工看）。
        ports.log(
          `restart recovery refused (${decision.code}): ${decision.verdict} — remedy: ${decision.remedy}`,
        )
        return {
          kind: 'refused',
          code: decision.code,
          verdict: decision.verdict,
          remedy: decision.remedy,
          evidence: decision.evidence,
        }
      }
      case 'recover': {
        const marker = decision.marker
        const notice = buildRecoveryNotice(marker, ports.now())
        const targets = [...new Set(decision.sessions)]
        const woken: string[] = []
        const failures: WakeFailure[] = []

        for (const sessionId of targets) {
          const outcome = await wakeWithRetries(sessionId, notice, ports)
          if (outcome.ok) woken.push(sessionId)
          else failures.push({ sessionId, reason: outcome.reason, attempts: outcome.attempts })
        }

        if (failures.length > 0) {
          // ⚠️ **不消费**：marker 留在盘上，下次启动再试。绝不「超时之后清掉」。
          for (const failure of failures) {
            ports.log(
              `restart recovery kept the marker armed: waking ${failure.sessionId} failed after ${String(failure.attempts)} attempt(s): ${failure.reason}`,
            )
          }
          return {
            kind: 'pending',
            marker,
            woken,
            failures,
            markerConsumed: false,
            verdict: `a restart marker is armed and ${String(woken.length)}/${String(targets.length)} session(s) were woken; ${String(failures.length)} could not be woken, so the marker is kept armed and the next startup will try again`,
          }
        }

        markerWrite = 'attempted'
        const consumed = await consumeRestartMarker(ports.fs, request.dshHome, marker, ports.now())
        markerWrite = 'done'
        ports.log(
          `restart recovery delivered the notice to ${String(woken.length)} session(s) and marked the marker consumed (${request.dshHome})`,
        )
        return {
          kind: 'recovered',
          marker,
          consumed,
          woken,
          notice,
          markerConsumed: true,
          verdict: `the restart notice was delivered to ${String(woken.length)} session(s) and the marker was marked consumed`,
        }
      }
    }
  } catch (error) {
    return failed(markerWriteVerdict(markerWrite, messageOf(error)), messageOf(error), ports)
  }
}

/**
 * 恢复半兜底分支的那句结论 —— **按 marker 写回的状态分岔**。
 *
 * 原话恒写 `the marker was not touched`，但那个 catch 也盖住写回失败那一格：写已经发出去了，
 * 只承诺「失败要抛」而没有原子性承诺 ⇒ 部分落盘是可能的。三态各说各的，不许拿「没动过」
 * 盖住「写失败了」。
 *
 * @param state `none` = 还没轮到写；`attempted` = 写了但没成功返回；`done` = 写成功了。
 * @param detail 原始异常的一句话描述。
 */
function markerWriteVerdict(state: 'none' | 'attempted' | 'done', detail: string): string {
  switch (state) {
    case 'done':
      return `the restart recovery marked the marker consumed and then stopped on an unexpected error (${detail}); the next startup will find it consumed`
    case 'attempted':
      return `the restart recovery failed while writing the marker back (${detail}); the marker may be armed, consumed or incomplete on disk, so the next startup may or may not deliver the notice again`
    case 'none':
      return `the restart recovery stopped on an unexpected error (${detail}); the marker was not touched, so the next startup will try again`
  }
}

/**
 * 唤醒一个会话，失败就按 {@link RECOVERY_WAKE_ATTEMPTS} 重试。
 *
 * 「等不到」是正常分支（C10）：重试只是为了吃掉「服务还没起来」，**不是**为了保证成功 ——
 * 用完次数就如实报失败，由调用方决定保留 marker（而不是在这里悄悄清掉它）。
 *
 * @param sessionId 会话运行期键。
 * @param notice 要投的 notice。
 * @param ports IO 端口。
 */
async function wakeWithRetries(
  sessionId: string,
  notice: RecoveryNotice,
  ports: RecoveryPorts,
): Promise<{ ok: true; attempts: number } | { ok: false; attempts: number; reason: string }> {
  let reason = 'not attempted'
  for (let attempt = 1; attempt <= RECOVERY_WAKE_ATTEMPTS; attempt += 1) {
    const result = await ports.channel.wakeAndNotify(sessionId, notice)
    if (result.ok) return { ok: true, attempts: attempt }
    reason = result.reason
    ports.log(
      `restart recovery: waking ${sessionId} failed on attempt ${String(attempt)}/${String(RECOVERY_WAKE_ATTEMPTS)}: ${reason}`,
    )
    if (attempt < RECOVERY_WAKE_ATTEMPTS) await ports.sleep(RECOVERY_WAKE_RETRY_MS)
  }
  return { ok: false, attempts: RECOVERY_WAKE_ATTEMPTS, reason }
}

/**
 * 收敛一次本层自己的意外（**绝不抛**）。
 *
 * @param verdict 一句英文结论（进结构化报告）。
 * @param detail 机器可读的细节。
 * @param ports IO 端口（用来留痕）。
 */
function failed(verdict: string, detail: string, ports: RecoveryPorts): RecoveryOutcome {
  ports.log(`restart recovery failed: ${detail}`)
  return { kind: 'failed', verdict, detail }
}

/**
 * 取宿主 `sessionController` 服务。
 *
 * **每次现取**（C26：apply 期是 `undefined`）—— 不缓存、不闭包捕获实例。
 * 形状不认识同样算「不可用」（宿主换版本时表现为降级，而不是调用时再炸）。
 *
 * @param ctx 宿主上下文（可以是单测替身）。
 */
function sessionControllerOf(ctx: ContextLike): { resolveAgent?: unknown } | undefined {
  const getter = ctx.get
  if (typeof getter !== 'function') return undefined
  const service = getter.call(ctx, 'sessionController')
  if (service === null || typeof service !== 'object') return undefined
  const resolveAgent = (service as Record<string, unknown>)['resolveAgent']
  if (typeof resolveAgent !== 'function') return undefined
  return service as { resolveAgent?: unknown }
}

/**
 * 造唤醒通道的**宿主适配器**（结构面访问，不 import 宿主包）。
 *
 * 一次调用 = 一次尝试：取服务 → `resolveAgent` → 按 `{error}` 分支判失败（C4 / C16）
 * → 取 `agent` → `followup(message)`。**重试在 {@link recoverRestart} 那一层**，
 * 这样「试了几次」是可观测的、测试里也不必真等。
 *
 * @param ctx 宿主上下文。
 */
export function createRecoveryChannel(ctx: ContextLike): RecoveryChannel {
  return {
    wakeAndNotify: async (sessionId, notice): Promise<WakeOutcome> => {
      const controller = sessionControllerOf(ctx)
      if (controller === undefined) {
        // C26：apply 的第一刻它确实不在 —— 这是「还没就绪」，不是「会话不存在」。
        return {
          ok: false,
          reason: 'the sessionController service is not available in this composition yet',
        }
      }
      let resolved: unknown
      try {
        resolved = await (controller.resolveAgent as (id: string) => Promise<unknown>).call(
          controller,
          sessionId,
        )
      } catch (error) {
        return { ok: false, reason: `resolveAgent threw: ${messageOf(error)}` }
      }
      if (resolved === null || typeof resolved !== 'object') {
        return {
          ok: false,
          reason: `resolveAgent returned a non-object result (${typeof resolved})`,
        }
      }
      const record = resolved as Record<string, unknown>
      // ⚠️ **按 `{error}` 分支判失败**，不靠 try/catch（C4 / C16 的硬要求）。
      if (record['error'] !== undefined) {
        return { ok: false, reason: `resolveAgent reported an error: ${describeError(record['error'])}` }
      }
      const agent = record['agent']
      if (agent === null || typeof agent !== 'object') {
        // 既没有 `error` 也没有 `agent`：**不猜**（认不出来就报失败，留给下一次启动）。
        return { ok: false, reason: 'resolveAgent returned neither an agent nor an error' }
      }
      const followup = (agent as Record<string, unknown>)['followup']
      if (typeof followup !== 'function') {
        return { ok: false, reason: 'the resolved agent has no followup method' }
      }
      try {
        // C20：resolve 返回的 `{agent}` 可以**立刻** followup，中间不插任何 await。
        ;(followup as (message: NoticeMessage) => void).call(agent, noticeMessageOf(notice, randomUUID()))
      } catch (error) {
        return { ok: false, reason: `followup threw: ${messageOf(error)}` }
      }
      return { ok: true }
    },
  }
}

/**
 * 取留痕口：优先宿主 logger（`ctx.logger('<包名>')`），取不到退回 `console.warn`。
 *
 * **退回 console 而不是静默**：这条痕迹是 `refuse` 分支唯一能被人看见的地方
 * （marker 原地不动、结构化报告只回到调用方），做成空操作就等于「静默地没恢复」。
 *
 * @param ctx 宿主上下文（可以是单测替身）。
 */
export function recoveryLogOf(ctx: unknown): (line: string) => void {
  const candidate = (ctx as { logger?: unknown } | null)?.logger
  if (typeof candidate === 'function') {
    try {
      const logger = (candidate as (name: string) => unknown).call(ctx, NOTICE_SOURCE_KIND)
      const info = (logger as { info?: unknown } | null | undefined)?.info
      if (typeof info === 'function') {
        const write = info as (message: string) => void
        return (line: string): void => {
          write.call(logger, line)
        }
      }
    } catch {
      // 落到 console：拿不到 logger 不是「不留痕」的理由。
    }
  }
  return (line: string): void => {
    console.warn(`[${NOTICE_SOURCE_KIND}] ${line}`)
  }
}

/**
 * 装配本层的 IO 端口。
 *
 * ⚠️ **不在这里取 `ctx.get('fs')` / `ctx.get('sessionController')`**：`restart-fs` 的端口
 * 每次读写时现取，通道每次唤醒时现取 —— 装配本身只绑 ctx。
 *
 * @param ctx 宿主上下文。
 */
export function createRecoveryPorts(ctx: ContextLike): RecoveryPorts {
  return {
    fs: createRestartFsPort(ctx, {
      // 写回 `$DSH_HOME/<包名>/restart/marker.json` 必须显式给档位（理由见文件头）。
      sandboxPolicy: { mode: RESTART_SANDBOX_MODE, workspaceRoot: process.cwd() },
    }),
    channel: createRecoveryChannel(ctx),
    log: recoveryLogOf(ctx),
    now: () => Date.now(),
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
}

/**
 * 启动期恢复的**装配 + 执行**（`src/index.ts` 的 `apply` 只负责调度它）。
 *
 * **绝不 reject**：它挂在 `setTimeout` 上，一个未处理的 rejection 会变成宿主启动期的
 * 幽灵错误。所以端口装配也包在里面（装配失败就退回 `console` 留痕）。
 *
 * @param ctx 宿主上下文。
 * @param dshHome 宿主数据目录。
 */
export async function runStartupRecovery(
  ctx: ContextLike,
  dshHome: string,
): Promise<RecoveryOutcome> {
  let ports: RecoveryPorts
  try {
    ports = createRecoveryPorts(ctx)
  } catch (error) {
    const detail = messageOf(error)
    console.warn(`[${NOTICE_SOURCE_KIND}] restart recovery could not be assembled: ${detail}`)
    return {
      kind: 'failed',
      verdict: `the restart recovery could not be assembled (${detail}), so the marker was not touched`,
      detail,
    }
  }
  return await recoverRestart({ dshHome }, ports)
}

/**
 * 把任意异常写成一个稳定码 + 一句话（`code` 优先 —— 它是稳定判据，message 会随版本变）。
 *
 * @param error 任意异常。
 */
function describeError(error: unknown): string {
  if (error === null || typeof error !== 'object') return String(error)
  const record = error as { code?: unknown; message?: unknown; name?: unknown }
  const code = typeof record.code === 'string' ? record.code : undefined
  const message =
    typeof record.message === 'string'
      ? record.message
      : typeof record.name === 'string'
        ? record.name
        : 'unknown error'
  return code === undefined ? message : `${code}: ${message}`
}

/**
 * 取一句话错误描述（**绝不抛**）。
 *
 * @param error 任意异常。
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
