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
 * ## ⚠️ 等得到服务 ≠ 等得到「答案」：读与唤醒都必须轮询（真机没跑通那一轮的成因）
 *
 * 2026-10-14 23:50 在活宿主上真跑了一次 `dsh_restart`：工具壳那一半成立（marker 落盘、
 * 宿主退出、新宿主起来），**恢复半一条 notice 都没投**，marker 至今留在 `armed`。
 * 下面是那一轮的成因分析**落到代码上**的三条结论（每条都能按检索串复核）：
 *
 * | # | 事实 | 出处 |
 * |---|---|---|
 * | ① | **读 marker 那一路原本零重试** —— `readRestartMarker` 只被调一次，而 `ctx.get('fs')` 在 apply 期取不到，于是读到 `unreadable`、立刻 `refused` 收工；「读不到」这件事**从未被当成「还没就绪」** | 本文件 `readMarkerWithRetries` 的调用点（原为单次调用）· `restart-fs.ts` 的 `read` 在 `hostFsOf` 返回 `undefined` 时给 `unreadable` |
 * | ② | **唤醒窗口短于实测可用窗口** —— 原 `5 × 300 ms` 的最后一次尝试落在 apply 后 **2200 ms**（`1000 + 4 × 300`；注意**最后一次尝试之后不再 sleep**，文件头原先那句「约 2.5 秒」把那次不存在的等待也算进去了），而台账 C32 在同一套组合里实测 `sessionController` 要 **2400–2800 ms** 才可用 ⇒ **窗口上界落在可用窗口之内**，服务真的晚到时五次全灭 | 本文件 `wakeWithRetries` · HOST-CONTRACTS §2.4.1 的 C26 / C32 |
 * | ③ | **事后分不开「没跑 / 跑了读不到 fs / 读了唤醒失败」** —— 结论 `RecoveryOutcome` 被 `src/index.ts` 用 `void …` 丢掉；唯一的留痕走 `ctx.logger(name).info`，而宿主启动期那个 exporter **只收 `warn` / `error`**（`dsh-app-boot/lib/index.js` 的 `boot()`：`levels: { default: 2 }` 且只 push `warn` / `error`），并且 `startup-*.log` **只在启动失败时**才落盘（同一函数里只有 `StartupError` 分支带 `messages`）。真机那条路又是 `schtasks → cmd /c` 且不重定向 ⇒ **一条 INFO 留痕在任何地方都不留档** | 本文件 `recoveryLogOf` · 宿主 `dsh-app-boot/lib/index.js` 的 `boot()` |
 *
 * ⇒ 处置三条各落一处：**读路径轮询**（①）、**窗口覆盖实测上界**（②）、**落盘 receipt**（③）。
 * ⚠️ **receipt 写不出去的那一格仍是宿主的限制**：`fs` 全程不可用时盘上一个字节都动不了，
 * 那时本层只能靠 `console` / logger 的 `warn` 说一句 —— **做不到「留痕在盘上」，如实记**。
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
import { join } from 'node:path'

import { createRestartFsPort, type ContextLike } from './restart-fs.js'
import { messageOf } from './errors.js'
import { DSH_HOME_EMPTY_DETAIL } from './restart.js'
import {
  consumeRestartMarker,
  decideRecovery,
  markerState,
  readRestartMarker,
  type MarkerRead,
  type MarkerState,
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
 * 启动期恢复的延迟（毫秒）—— 从本层 apply 起算的**第一段**等待。
 *
 * ⚠️ **它不是「服务可用窗口」，只是「第一次尝试的时刻」**（真机那一轮的成因，见文件头 ①②）：
 * 取 1 秒是 C26（`sessionController` 在 apply 后 138–157 ms 才有）的约 6 倍。
 * 真正的兜底**不是**把它调大，而是**轮询**：读走 {@link RECOVERY_READ_ATTEMPTS} ×
 * {@link RECOVERY_POLL_INTERVAL_MS}，唤醒走 {@link RECOVERY_WAKE_ATTEMPTS} ×
 * {@link RECOVERY_WAKE_RETRY_MS}，两段的**末次尝试**都必须越过 C32 实测的服务可用上界
 * —— 那条不等式由 `test/tools/restart-recovery.test.ts` 钉住（数值不是抄在注释里的承诺）。
 */
export const RECOVERY_STARTUP_DELAY_MS = 1_000

/**
 * 「等宿主服务」的**总预算**（毫秒，从恢复开始起算，即 apply 后 `1_000 + 本值`）。
 *
 * 取 4 秒的理由是 C32 的**实测上界**（同一套组合里 `fs` 2.2–2.5 s、`sessionController`
 * 2.4–2.8 s）：整条链最后一个动作落在 apply 后 5 秒，比 2.8 秒留出约 2.2 秒余量。
 * ⚠️ C26 记的是 138–157 ms、**基准不同**，两个数不能混着用（C32 成因本身标 `[无法判定]`）——
 * 本值取的是**较大那个**的保守侧。
 */
export const RECOVERY_SERVICE_WINDOW_MS = 4_000

/** 读 marker 那条路两次尝试之间的等待（毫秒）。 */
export const RECOVERY_POLL_INTERVAL_MS = 250

/**
 * 读 marker 的尝试次数上限（**由窗口与间隔推导，不另抄一份**）。
 *
 * 为什么读也要重试（文件头 ①）：`ctx.get('fs')` 在 apply 期取不到（`restart-fs.ts` 的 `read`
 * 因此给 `unreadable`），而**单次**读到 `unreadable` 就 `refused` 收工，等于把「服务还没起来」
 * 印成「读不到」—— 真机那一轮就是这样一条 notice 都没投出来的。
 *
 * 为什么**按次数**而不是按时钟：这个 `sleep` / `now` 都是注入点，判据里 `sleep` 立即返回、
 * `now` 是常数 ⇒ 任何按挂钟收敛的循环在判据里**不会终止**。次数上限既可注入、也能被断言。
 */
export const RECOVERY_READ_ATTEMPTS =
  Math.ceil(RECOVERY_SERVICE_WINDOW_MS / RECOVERY_POLL_INTERVAL_MS) + 1

/**
 * 每个会话的唤醒尝试次数上限。
 *
 * 「等不到」是**正常分支**（C10）：它只意味着这次恢复做不成，**不**意味着要把 marker
 * 清掉。重试是为了吃掉「服务还没起来」，不是为了保证成功。
 *
 * 15 次的依据：2026-10-17 真机回执（`last-attempt.json`）实测 `sessionController`
 * 在宿主启动后 **>5.8 秒** 仍未就绪（历史记录 2.8 秒被打破），`6 × 800ms` 的窗口
 * 全灭（6 次全部报「service not available yet」）。新窗口取 **约 3 倍余量**：
 * 末次尝试落在 apply 后 `1_000 + (15-1) × 1_000 = 15_000 ms`。
 */
export const RECOVERY_WAKE_ATTEMPTS = 15

/**
 * 两次唤醒尝试之间的等待（毫秒）。
 *
 * ⚠️ **与次数一起看才有意义**：末次尝试落在 apply 后 `1_000 + (15-1) × 1_000 = 15_000 ms`。
 * 历史形态：`6 × 800` 末次 5_000 ms，越过当时的 C32 实测 2.8 秒上界 —— 但 2026-10-17
 * 真机实测上界被打破（>5.8 秒），窗口整段落在可用窗口之内、六次全灭 ⇒ 放宽到 15 秒。
 */
export const RECOVERY_WAKE_RETRY_MS = 1_000

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
 * `reason` 那一格：**只有发起者拿到原文**，其余收件人拿到「为什么没有」。
 *
 * 单点判定 —— 全仓只有这一处决定 `reason` 给不给（`buildRecoveryNotice` 只负责把它拼进事实表）。
 * 这样做是因为这条规则是**串话与否**的唯一开关：散成两处判定，迟早会有一处退化成「那就都发」。
 *
 * 三个分支的**文案必须彼此可分**（判据按这个钉）：发起者看到的是原文，
 * 另外两种看到的是**不同**的说明（一个是「别人发起的」，一个是「这份 marker 没记」）——
 * 把它们压成同一句就等于把三值压成两值，而压掉的那一格恰恰是「不知道」。
 *
 * @param marker 要恢复的那份 marker。
 * @param recipient 收件会话。
 * @returns 0 或 1 条事实（发起者 1 条、其余也 1 条，但内容不同）。
 */
function reasonFact(marker: RestartMarker, recipient: string): readonly string[] {
  if (marker.initiator === undefined) {
    return [
      'the recorded reason is not repeated here: this marker does not record which session requested the restart',
    ]
  }
  if (marker.initiator === recipient) {
    return [`the recorded reason was: ${marker.reason}`]
  }
  return ['the recorded reason is not repeated here: another session requested this restart']
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
 * ## `reason` **只发给发起者**（维护者 2026-10-15 拍板）
 *
 * `reason` 是**用户给自己留的便条**，不是公告：广播给「被顺手打断」的其它会话就是**串话**。
 * ⇒ 本函数**必须**知道收件人是谁，于是 `recipient` 是**必填**第三参 ——
 * 类型上堵死「造一条 notice 群发」这种写法（原来正是那样：一条 notice 循环投给所有人）。
 *
 * 三分支（三值纪律，不许压成两值）：
 * - `marker.initiator === recipient` ⇒ 逐字给出 `reason`；
 * - `initiator` 有值但**不是**收件人 ⇒ **不给** `reason`，并说明「是别人发起的」；
 * - `initiator` **缺席**（本字段之前写的 marker）⇒ **不给** `reason`，并说明「这份 marker
 *   没记是谁发起的」 —— **不许**退化成「那就发给所有人」：那正是要消除的串话。
 *
 * ⚠️ **收件人不匹配时也要给出一句事实，不能留个静默的空洞**：notice 是给模型看的，
 * 一个莫名其妙的中断如果不说「这不是你发起的」，模型会自己编一个理由。
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
 * @param recipient 这条 notice 的收件会话（`session-<uuid>`）。决定 `reason` 给不给（见上）。
 */
export function buildRecoveryNotice(
  marker: RestartMarker,
  now: number,
  recipient: string,
): RecoveryNotice {
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
    ...reasonFact(marker, recipient),
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
      /**
       * 实际投出去的 notice —— **每个会话一条**，不是一条群发。
       *
       * ⚠️ 这里原来是单数 `notice: RecoveryNotice`。`reason` 改成「只发给发起者」之后，
       * 那个形状就**说谎了**：它只能描述其中一个收件人。留一个单数槽 = 让审计记录
       * 看起来「只投了一条」，而实际每人的正文不同。
       */
      notices: readonly { readonly sessionId: string; readonly notice: RecoveryNotice }[]
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
 * 一次恢复尝试的**盘上回执**（receipt）——「这次启动到底有没有恢复」的可观测面。
 *
 * ## 为什么需要它（文件头 ③ 的实测依据）
 *
 * `RecoveryOutcome` 只回到调用方，而调用方（`src/index.ts`）用 `void …` 把它丢掉了；
 * 之前唯一的留痕是 `ctx.logger(name).info`，而宿主启动期只把 `warn` / `error` 收进
 * `startup-*.log`、且那个文件**只在启动失败时**才落盘 ⇒ 真机那条 `schtasks → cmd /c`
 * 的路上，**一条 INFO 在任何地方都不留档**。于是真机事后看到的三样东西
 * （marker 仍 `armed` / notice 0 条 / 插件 active）**同时兼容**「没跑」「跑了读不到 fs」
 * 「读了唤醒失败」三条 —— 分不开本身就是缺陷。
 *
 * ## 它答的是哪三个问题
 *
 * 读这一个文件就能分：
 * ① **有没有跑** —— 文件带本次启动的时刻戳；只有上一次的旧时间戳 ⇒ 这一轮**真的没跑**；
 * ② **跑到哪一步** —— `markerReadAttempts` 与 `markerStateAtRead` 说清读了几次、读到的是什么；
 * ③ **结果是什么** —— `outcome` / `detail` / `failures` 三件对应 `recovered` / `pending` /
 * `refused` / `failed`，**与 marker 的 `state` 互相独立**（marker 只在成功时被改，
 * 它因此答不了「失败在哪一步」）。
 *
 * ## 什么时候**不**写（刻意：正常启动不许有噪音）
 *
 * `idle` 两个分支都不写：`absent` 是「没有待办」，`consumed` 是「已经处理过了」——
 * 后者的审计价值本来就在 marker 自己身上（`consumed at …` 留痕）。
 * ⇒ **只有「动了」或「说不清」的终局才落盘**。
 */
export interface RecoveryReceipt {
  /** 回执自身的格式版本（与 marker 的 `version` 是两件事：那份被消费时改，这份被覆盖）。 */
  version: number
  /** 这一次恢复**开始**的时刻（ISO 8601）。 */
  startedAt: string
  /** 这一次恢复**结束**的时刻（ISO 8601）。 */
  finishedAt: string
  /** 终局。**不含 `idle`**（那一格刻意不落盘，见上）。 */
  outcome: 'recovered' | 'pending' | 'refused' | 'failed'
  /** 读了几次才拿到**确定答案**（含第一次）。1 = 服务一上来就在。 */
  markerReadAttempts: number
  /** 读到时 marker 的状态；读都没成功时缺席。 */
  markerStateAtRead?: MarkerState
  /** **根因事实**：这次结束时 marker 真的被标成已消费了吗。 */
  markerConsumed: boolean
  /** 唤醒失败逐条（只有 `pending` 非空）。 */
  failures?: readonly WakeFailure[]
  /** 一句话结论（英文；与 `RecoveryOutcome.verdict` 同源）。 */
  detail: string
}

/** 回执的格式版本。与 `MARKER_VERSION` 是两件事，**不共用**（marker 那份被消费时会被改写）。 */
export const RECOVERY_RECEIPT_VERSION = 1

/**
 * 回执的绝对路径：`$DSH_HOME/<包名>/restart/last-attempt.json`。
 *
 * ⚠️ **与 marker 同目录、不同文件名**，理由有两条，都不是「顺手」：
 * ① **B10 的白名单只认「紧跟 home 的首段逐字等于包名」**，所以这一段必须是**字面量**，
 *    不能写成 `join(dshHome, OWN_NAMESPACE, …)`（那会被保守判红，与 `restart.ts` 的
 *    `restartMarkerPath` 同一条纪律）；
 * ② **绝不能复用 marker 那个文件**：marker 是恢复的**输入**，往它身上追加字段会改变
 *    「读到了但没懂 / 幂等」那两条已实测语义（C28–C32 一格都不许回退）。
 *
 * @param dshHome 宿主数据目录（`$DSH_HOME`）。
 */
export function recoveryReceiptPath(dshHome: string): string {
  return join(dshHome, 'dsh-plugin-debugging', 'restart', 'last-attempt.json')
}

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
  // 回执要用的两个事实：一个「开始时刻」（证明这一轮**跑过**），一个「读了几次」。
  const startedAt = ports.now()
  let markerReadAttempts = 0
  let markerStateAtRead: MarkerState | undefined

  /** 落盘这一次尝试的回执。**绝不抛、绝不改变结论**（观测面坏了不许反过来搞坏恢复）。 */
  const writeReceipt = async (
    outcome: Exclude<RecoveryOutcome, { kind: 'idle' }>,
    failures?: readonly WakeFailure[],
  ): Promise<void> => {
    // ⚠️ `markerConsumed` 只在 `recovered` / `pending` 上有；`refused` / `failed` 那一格
    // 的答案是「**否**」而不是「不知道」—— 它们都发生在消费之前（硬要求：读不懂不动它）。
    const consumed = 'markerConsumed' in outcome && outcome.markerConsumed === true
    await writeRecoveryReceipt(request.dshHome, ports, {
      version: RECOVERY_RECEIPT_VERSION,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(ports.now()).toISOString(),
      outcome: outcome.kind,
      markerReadAttempts,
      ...(markerStateAtRead === undefined ? {} : { markerStateAtRead }),
      markerConsumed: consumed,
      ...(failures === undefined || failures.length === 0 ? {} : { failures }),
      detail: outcome.verdict,
    })
  }

  try {
    if (request.dshHome.trim() === '') {
      const outcome = failed(
        'the restart recovery did not run: no $DSH_HOME is known, so the marker cannot be located',
        DSH_HOME_EMPTY_DETAIL,
        ports,
      )
      await writeReceipt(outcome)
      return outcome
    }

    // ⚠️ **轮询读**，不是单次读（文件头 ①）：`ctx.get('fs')` 在 apply 期取不到，
    // 单次读到 `unreadable` 就收工会把「服务还没起来」印成「读不到」⇒ 真机零 notice。
    const read = await readMarkerWithRetries(request.dshHome, ports, (attempts) => {
      markerReadAttempts = attempts
    })
    const decision = decideRecovery(read)
    if (read.status === 'ok') markerStateAtRead = markerState(read.marker)

    switch (decision.action) {
      case 'none': {
        if (decision.reason === 'absent') {
          // 安静是**对**的：这里确实什么都没有，留痕只会变成每次启动一条噪音。
          // ⚠️ `absent` 是**确定答案**（服务可用、文件不在），所以上面的轮询**一次就停**，
          // 不该有任何等待 —— 正常启动的代价仍然是零。
          return {
            kind: 'idle',
            reason: 'absent',
            verdict: 'no restart marker is present, so this startup has nothing to recover',
          }
        }
        // ⚠️ 这一支**必须**与上面分开：marker 在、只是处理过了 —— 它仍是一条审计记录。
        // （这一格也**不**落 receipt：审计价值在 marker 的 `consumed at …` 上，见类型注释。）
        return {
          kind: 'idle',
          reason: 'consumed',
          marker: decision.marker,
          verdict: decision.verdict,
        }
      }
      case 'refuse': {
        // **读到了但没懂**（或读了一路都没读成）：留痕 + 结构化报告 + **盘上回执**，
        // marker 原地不动（给人工看）。这是「事后能分得开」的关键那一格。
        ports.log(
          `restart recovery refused (${decision.code}) after ${String(markerReadAttempts)} marker read attempt(s): ${decision.verdict} — remedy: ${decision.remedy}`,
        )
        const outcome: RecoveryOutcome = {
          kind: 'refused',
          code: decision.code,
          verdict: decision.verdict,
          remedy: decision.remedy,
          evidence: decision.evidence,
        }
        await writeReceipt(outcome)
        return outcome
      }
      case 'recover': {
        const marker = decision.marker
        const targets = [...new Set(decision.sessions)]
        const woken: string[] = []
        const failures: WakeFailure[] = []
        const delivered: { sessionId: string; notice: RecoveryNotice }[] = []

        for (const sessionId of targets) {
          // ⚠️ **每个收件人各造一条**（不是造一条循环投）：`reason` 只发给发起者，
          // 所以 notice 是 `(marker, now, recipient)` 的函数。见 `reasonFact`。
          const notice = buildRecoveryNotice(marker, ports.now(), sessionId)
          const outcome = await wakeWithRetries(sessionId, notice, ports)
          if (outcome.ok) {
            woken.push(sessionId)
            delivered.push({ sessionId, notice })
          } else {
            failures.push({ sessionId, reason: outcome.reason, attempts: outcome.attempts })
          }
        }

        if (failures.length > 0) {
          // ⚠️ **不消费**：marker 留在盘上，下次启动再试。绝不「超时之后清掉」。
          for (const failure of failures) {
            ports.log(
              `restart recovery kept the marker armed: waking ${failure.sessionId} failed after ${String(failure.attempts)} attempt(s): ${failure.reason}`,
            )
          }
          const outcome: RecoveryOutcome = {
            kind: 'pending',
            marker,
            woken,
            failures,
            markerConsumed: false,
            verdict: `a restart marker is armed and ${String(woken.length)}/${String(targets.length)} session(s) were woken; ${String(failures.length)} could not be woken, so the marker is kept armed and the next startup will try again`,
          }
          await writeReceipt(outcome, failures)
          return outcome
        }

        markerWrite = 'attempted'
        const consumed = await consumeRestartMarker(ports.fs, request.dshHome, marker, ports.now())
        markerWrite = 'done'
        ports.log(
          `restart recovery delivered the notice to ${String(woken.length)} session(s) and marked the marker consumed (${request.dshHome})`,
        )
        const outcome: RecoveryOutcome = {
          kind: 'recovered',
          marker,
          consumed,
          woken,
          notices: delivered,
          markerConsumed: true,
          verdict: `the restart notice was delivered to ${String(woken.length)} session(s) and the marker was marked consumed`,
        }
        await writeReceipt(outcome)
        return outcome
      }
    }
  } catch (error) {
    const outcome = failed(markerWriteVerdict(markerWrite, messageOf(error)), messageOf(error), ports)
    await writeReceipt(outcome)
    return outcome
  }
}

/**
 * 读 marker，**读不到就重试**（文件头 ① 的处置）。
 *
 * ## 只有一种读法可重试
 *
 * `absent`（文件不在）与 `ok` / `malformed` / `unsupported-version` 都是**确定答案**：
 * 服务已经可用并给出了结论 ⇒ 立刻返回，不多等一拍。**只有 `unreadable` 会重试** ——
 * 它同时覆盖「服务还没注册」与「真读不动了」两种情形，两者重试都是安全的
 * （读是纯的，且拿不到就只会一直拿不到）。
 *
 * ## 留痕只留三处（不是每次都留）
 *
 * 第一次失败、**失败之后第一次成功**、以及用光次数。三处合起来正好把
 * 「晚到了但最终读到了」与「一直读不到」在日志上分开 —— 而这正是真机分不开的那两条。
 *
 * @param dshHome 宿主数据目录。
 * @param ports IO 端口。
 * @param onAttempts 每次尝试后回调（把次数带给上层写回执；用它而不是返回值是为了不重排联合类型）。
 */
async function readMarkerWithRetries(
  dshHome: string,
  ports: RecoveryPorts,
  onAttempts: (attempts: number) => void,
): Promise<MarkerRead> {
  let last: MarkerRead = { status: 'unreadable', reason: 'the marker was never read' }
  for (let attempt = 1; attempt <= RECOVERY_READ_ATTEMPTS; attempt += 1) {
    onAttempts(attempt)
    last = await readRestartMarker(ports.fs, dshHome)
    if (last.status !== 'unreadable') {
      if (attempt > 1) {
        ports.log(
          `restart recovery: the marker became readable on read attempt ${String(attempt)}/${String(RECOVERY_READ_ATTEMPTS)}, so the host services were only late, not absent`,
        )
      }
      return last
    }
    if (attempt === 1) {
      ports.log(
        `restart recovery: the marker could not be read on the first attempt and will be retried up to ${String(RECOVERY_READ_ATTEMPTS)} time(s) within the startup window (${last.reason})`,
      )
    }
    if (attempt < RECOVERY_READ_ATTEMPTS) await ports.sleep(RECOVERY_POLL_INTERVAL_MS)
  }
  ports.log(
    `restart recovery gave up reading the marker after ${String(RECOVERY_READ_ATTEMPTS)} attempt(s) inside the startup window; the marker was left untouched and the next startup will try again (${last.status === 'unreadable' ? last.reason : 'unknown'})`,
  )
  return last
}

/**
 * 落盘一次尝试的回执。**绝不抛**：观测面坏了不许反过来把恢复搞坏。
 *
 * 写不出去只有一格 —— **`fs` 全程不可用**（`restart-fs.ts` 的 `write` 在拿不到服务时抛）。
 * 那时盘上一个字节都动不了，所以本层只能**再喊一声** `log`；「留痕在盘上」在这一格
 * **做不到**，如实说，不假装做到。
 *
 * @param dshHome 宿主数据目录。
 * @param ports IO 端口。
 * @param receipt 回执内容。
 */
async function writeRecoveryReceipt(
  dshHome: string,
  ports: RecoveryPorts,
  receipt: RecoveryReceipt,
): Promise<void> {
  try {
    await ports.fs.write(recoveryReceiptPath(dshHome), `${JSON.stringify(receipt, null, 2)}\n`)
  } catch (error) {
    ports.log(
      `restart recovery could not write its own receipt (${messageOf(error)}); the outcome above is still reported through the log line, but this attempt leaves no on-disk record`,
    )
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
 * 返回类型**收窄**到 `failed` 那一支（而不是整个 `RecoveryOutcome`）——
 * 这样调用方不必再判一次 `kind`，而「兜底一定是失败」这件事由类型守着。
 *
 * @param verdict 一句英文结论（进结构化报告）。
 * @param detail 机器可读的细节。
 * @param ports IO 端口（用来留痕）。
 */
function failed(
  verdict: string,
  detail: string,
  ports: RecoveryPorts,
): Extract<RecoveryOutcome, { kind: 'failed' }> {
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
 * ## 为什么是 `warn` 而不是 `info`（真机实测出来的，不是偏好）
 *
 * 宿主启动期那个 exporter **只收 `warn` / `error`**（`dsh-app-boot/lib/index.js` 的 `boot()`：
 * `levels: { default: 2 }` 且只 push `warn` / `error`），并且 `startup-*.log`
 * **只在启动失败时**才落盘（只有 `StartupError` 分支把 `messages` 带出去）。
 * ⇒ 走 `info` 的话，这条留痕在**任何一次正常启动里都不留档** —— 真机那条
 * `schtasks → cmd /c` 的路上更是连 stderr 都没人接。改用 `warn` 之后，它至少能进
 * 「本次启动有 warn/error」的那份 `startup-*.log`。
 * ⚠️ **这一格仍不够**：正常启动不会写那份文件，所以「留痕在盘上」那条只能靠
 * {@link RecoveryReceipt}，本函数只负责「启动失败时看得见」。
 *
 * @param ctx 宿主上下文（可以是单测替身）。
 */
export function recoveryLogOf(ctx: unknown): (line: string) => void {
  const candidate = (ctx as { logger?: unknown } | null)?.logger
  if (typeof candidate === 'function') {
    try {
      const logger = (candidate as (name: string) => unknown).call(ctx, NOTICE_SOURCE_KIND)
      const warn = (logger as { warn?: unknown } | null | undefined)?.warn
      if (typeof warn === 'function') {
        const write = warn as (message: string) => void
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
 * @param portsOverride **只给判据用的注入口**（生产路径不传）：真实端口的
 *   `sleep` 是 `setTimeout`，而读路径现在会**按 {@link RECOVERY_READ_ATTEMPTS} 轮询**
 *   ⇒ 不注入的话，测「服务全程不可用」那一条要真等整个窗口。
 *   ⚠️ 只替换 `sleep` / `now` 是不够的：`createRecoveryPorts(ctx)` 返回的 `fs` 与 `channel`
 *   都现取服务，**保留**它们才是在测真实适配器（替身只该把「等」这件事变成零）。
 */
export async function runStartupRecovery(
  ctx: ContextLike,
  dshHome: string,
  portsOverride?: Partial<RecoveryPorts>,
): Promise<RecoveryOutcome> {
  let ports: RecoveryPorts
  try {
    ports = portsOverride === undefined ? createRecoveryPorts(ctx) : { ...createRecoveryPorts(ctx), ...portsOverride }
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
  // ⚠️ 与 restart-fs.ts 的 reasonOf 形状相似但**不同义**（审计 A7 判定）：
  // 这边的 message 是多级兜底（message → name → 'unknown error'，入参还先挡了
  // null/非对象），那边的 message 兜底是 messageOf 语义 —— 最后一行拼接相同只是巧合。
  return code === undefined ? message : `${code}: ${message}`
}

// `messageOf` 的唯一实现在 errors.ts（2026-10-16 审计 A1 收敛，本文件原有一份已删）。

