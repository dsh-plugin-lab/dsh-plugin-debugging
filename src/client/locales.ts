/**
 * 卡片文案字典（**中英双语，跟随界面语言切换**）。
 *
 * 形状照 `dsh-zhihu-search/src/client/locales.ts` 的骨架：命名空间合并进
 * `LocaleNamespaceMap`，key 因此有类型约束 —— 拼错或漏译都是**编译错误**，而不是运行时的空白。
 * 注册走 `register` 的 **typed 形态**（`ns, dicts`），它要求 `Record<BuiltInLocaleId, …>`；
 * `LOCALE_IDS` 恰好是 `["zh", "en"]` 两项 ⇒ 双语是这套 API 的**原生形状**，不是让步。
 *
 * ✅ **这里可以有 CJK**（维护者 2026-10-15 拍板：界面跟随中英文切换）。
 * 判据 B14（「`src/**` 的字符串字面量不许 CJK」）守的是**模型可见**字符串 ——
 * 而界面文案**到不了模型**，所以它**排除 `src/client/`**（判据里有注释说明理由）。
 * ⚠️ 反过来说：**这一条不能被误用成「所有中文都能进 `src/**`」** —— 工具的 `data` 文本字段、
 * `message`、`nextStep.why`、render 文本仍**必须英文**，那条判据在别处照样判红。
 */

import type { BuiltInLocaleId } from '@deepseek-ai/dsh-client-locale'
import type { LocaleNamespaceMap } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * 字典命名空间。
 *
 * 与槽的分派 key **同名但是两件事**：分派 key 是**包名**（描述「哪个 bundle 的配置」），
 * 这个命名空间只标识本卡片的文案归属，由注册时的 `locale:` 座位用。
 * 两者今天恰好同串，改一处不该顺手改另一处 —— 谁都不是谁的真源。
 */
export const LOCALE_NS = 'dsh-plugin-debugging'

/** 本卡片全部文案的 key。`enableRestartInstallHint` 已并入 `enableRestartHint`（合成一行）。 */
export type RestartToggleLocaleKey =
  | 'readOnly'
  | 'enableRestartLabel'
  | 'enableRestartOn'
  | 'enableRestartOff'
  | 'enableRestartHint'
  | 'save'
  | 'saving'
  | 'saveRejected'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-plugin-debugging': RestartToggleLocaleKey
  }
}

/**
 * 中文文案 —— 三行，与参照仓那张卡片同形状：**标题 + 状态行（随开关变）+ 说明行**。
 *
 * ⚠️ **写给人看的，不是照着实现写的**（维护者 2026-10-15 指出「四道闸」「仍然注册着」这类
 * 措辞是黑话后重写）：用户在这张卡片上要决定的是「要不要让 Agent 能重启我的宿主」，
 * 他关心**后果**，不关心注册、调用、四道闸这些机制词 —— 读不懂的说明等于没写。
 * ⚠️ **「会话会中断，随后自动接回来」这句曾经被禁止**，理由是「那个恢复只验过一次、且**时序未验**」
 * （实测那次隔了很久才到）⇒ 写上去就是「说了但兑现不了」。
 * **2026-10-16 解禁（前提变了，不是决定被推翻）**：时序已经真机验过 ——
 * `AGENTS.md` 状态段记着闭环两次（marker 被恢复半真消费 + 「重启后立刻恢复」的时序 `103s`），
 * 而 2026-10-15 那次事故现场还有一条独立读数：notice 投递与 marker 被消费相差 **11 ms**
 * （`restart-recovery.ts` 的顺序：先唤醒投递、全部成功才写回 `consumed`）⇒ 恢复是**自动发生**的事实。
 * 旧的「不许写」由此作废；**但仍不许承诺它做不到的事**（不写「保证成功」「一定会回来」这类绝对话）。
 *
 * **为什么说明行不提「首次安装要重启一次」**（2026-10-15 维护者追问后删）：
 * 能读到这张卡片，就说明那次重启**已经发生过** —— 它描述的是读者**无法采取行动**的过去事；
 * 而且它约束的是**安装形态**，不是这个开关。那句话的真源在
 * [README.md](../../README.md) 的安装段（读者是**装插件的人**），此处再写一遍就是「一处一事实」被破。
 */
const zh: Record<RestartToggleLocaleKey, string> = {
  readOnly: '这个连接不允许改设置。',
  enableRestartLabel: '允许 Agent 重启宿主',
  // 状态行只留**后果**，不复述标题 —— 标题已经说了「允许重启」，再写一遍「Agent 可以重启」是同义反复。
  // 两半都要有：**中断**（用户要知道代价）与**随后自动恢复**（否则读成「对话就此没了」而不敢开）。
  enableRestartOn: '重启会中断对话，随后自动恢复并继续。',
  enableRestartOff: '对话不会中断。',
  // 末句追加「仅 Web（Windows）」（维护者 2026-10-16 拍板，方案 D）。
  // 为什么落在**这一行**而不是标题或状态行：本行**无条件渲染**（`index.tsx` 里没有 `shown ?`），
  // 而状态行只在开关为「开」时才显示那句话 —— 桌面端用户进来看到的是**默认关**的那一支，
  // 限制写在那里等于对他不可见。
  // 为什么一句话盖住三档：真实判据是 `relaunchRouteFor` 的 `cli × win32`（`src/lib/carrier.ts`），
  // 桌面宿主（结构上没有通道）与 Linux/macOS（没有**已实现**的拉起路线）在**用户视角是同一件事**
  // ——「你这台机器上这个开关没用」。卡片是给人看的三行说明、不是判据表：三档的区分留在运行时
  // 拒绝输出（那里模型要读懂成因），这里只报「能不能用」。
  enableRestartHint: '改动立即生效，不需要重启。仅 Web（Windows）。',
  save: '保存',
  saving: '保存中…',
  saveRejected: '保存失败：配置在别处被改过了。请重新打开这个页面再试。',
}

/**
 * 英文文案 —— 与中文那份**逐条对应**（维护者要的是双语跟随切换，不是两份各自发挥）。
 *
 * 说明行的形状照参照仓那张卡片（`Takes effect next request; no restart.`）：只讲**这个开关**，
 * 不讲安装形态 —— 后者归 [README.md](../../README.md)。
 */
const en: Record<RestartToggleLocaleKey, string> = {
  readOnly: 'This connection does not allow writing settings.',
  enableRestartLabel: 'Let the Agent restart this Host',
  // 状态行只留后果，不复述标题（理由同中文那份）。
  // 与中文那份**逐条对应**：两半都在 —— `interrupts`（代价）+ `resumes them`（会自动接回来）。
  enableRestartOn: 'A restart interrupts conversations, then resumes them.',
  enableRestartOff: 'Conversations are unaffected.',
  // 末句逐条对应中文那份（含追加的「Web only (Windows)」）——理由与「为什么落在这一行」都在中文那份。
  enableRestartHint: 'Takes effect immediately; no restart needed. Web only (Windows).',
  save: 'Save',
  saving: 'Saving…',
  saveRejected:
    'Could not save: the configuration changed elsewhere. Please reopen this page and try again.',
}

/**
 * 本卡片注册的全部语言（typed 形态要的就是这张表）。
 *
 * 取值范围见 `dsh-client-locale` 的 `LOCALE_IDS` —— 它恰好是 `["zh", "en"]` 两项，
 * 所以这张表**必须是两个键**，少一个就编译不过（那正是我们要的：漏译不许静默）。
 */
export const RESTART_TOGGLE_LOCALES: Record<
  BuiltInLocaleId,
  Record<RestartToggleLocaleKey, string>
> = { zh, en }

/** 供上层复用的命名空间表类型。 */
export type { LocaleNamespaceMap }
