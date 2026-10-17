/**
 * 契约层：跨模块共享的**类型**，不含实现。
 *
 * 存在的理由只有一个：让「技能半边」与「工具半边」能在不碰对方文件的前提下并行开发。
 * 两份实现只共享这里的形状，谁都不许往这里塞逻辑。
 */
import type { Volatile } from '@deepseek-ai/cordis'

import type { CarrierObservation } from './lib/carrier.js'
import type { WorkloadBudgetConfig } from './lib/timeouts.js'

/** 技能注册的结果。注册失败**不是**插件的失败 —— 工具半边照常工作。 */
export interface SkillReport {
  /** 是否成功把自己的技能注册进宿主注册表（**全局层**那次）。 */
  ok: boolean
  /** 注册成的技能名（`ok` 为真时有值）。 */
  name?: string
  /** 正文字节数：用来把「注册成了但正文是空的」这种静默失败照出来。 */
  contentBytes?: number
  /** 失败的结构化原因（`ok` 为假时有值）。 */
  error?: SkillError
  /**
   * **动态 scope 注入**的结果（见 `.agents/notes/` 里那条决策）。
   *
   * 为什么需要它：发布形态下用户级技能在 **preset 层**（更近），会把全局层这次注册**跨层遮蔽**；
   * 所以本插件还额外把技能注册进**每个活跃 agent 的 preset 作用域**，与 `skill-filesystem` 同层，
   * 让 rank 250 在同层仲裁里胜出。
   *
   * 这里的计数是**插件 apply 那一刻**的：之后新开的 agent 由 `agent/created` 事件接管
   * （该事件是 **serial** 派发，处理器里**不许 await**）。
   */
  scoped?: {
    /** apply 时就已存在、且成功注册进其作用域的 agent 数。 */
    initial: number
    /** 这些注册里有几例失败（失败只记数，不影响 `ok` 与全局那次注册）。 */
    failed: number
  }
}

/** 结构化错误：机器码决定要不要重试，message 给人看，hint 是下一步。 */
export interface SkillError {
  /** 闭枚举：`missing-file` / `bad-frontmatter` / `empty-content` / `no-registry` / `internal`。 */
  kind: 'missing-file' | 'bad-frontmatter' | 'empty-content' | 'no-registry' | 'internal'
  message: string
  hint: string
}

/** 插件实例状态：`apply()` 期间建一次，供工具半边读取。 */
export interface PluginState {
  config: ResolvedConfig
  /** `null` = 技能半边还没跑过（不该出现在注册完成之后）。 */
  skill: SkillReport | null
  /**
   * 这个宿主跑在什么载体上（`apply()` 里探**一次**，三处消费者共用）。
   *
   * 为什么在这里而不是各工具自己读 env：载体是**进程级事实**，而它的结论会导致拒绝
   * （`dsh_restart` 闸④、`dsh_dump_config`、`dsh_check_effect_mode` 的 `nextStep`）。
   * 各读各的就会出现「同一个进程里两处对载体的判断不一致」——那种错没有任何判据照得到。
   * 判定逻辑与理由在 `src/lib/carrier.ts`（纯函数，可单独单测）。
   */
  carrier: CarrierObservation
}

/**
 * 配置项补齐默认值后的形状：工具半边只认这个，不再关心「有没有配」。
 *
 * **extends `WorkloadBudgetConfig`**（`lib/timeouts.ts`）而不是把两个预算字段再写一遍：
 * 「工作量 → 预算」的映射住在那边，它期望的字段名因此与本接口是**同一份类型**，
 * 改一边另一边就编译不过。这里只多一句说明，不重复定义。
 */
export interface ResolvedConfig extends WorkloadBudgetConfig {
  /** DSH_HOME 目录（绝对路径）。 */
  dshHome: string
  /**
   * `dshHome` 是怎么来的：`config` = 用户在插件配置里写了；`env` = 环境变量 `DSH_HOME`；
   * `default` = 我们按宿主的默认值推的 `<homedir>/.dsh`；`tool-argument` = **本次调用**的
   * `dshHome` 参数覆盖了上面三者（跨实例观察，见 `docs/SHAPE.md` §1.2 的 D′）。
   *
   * **必须带出去给用户看**：诊断工具最怕「看着成功其实读错了目录」，读默认目录这件事
   * 本身要成为可见证据，而不是隐藏假设。
   *
   * ⚠️ `tool-argument` 是**四值里的第四值、不是 `config` 的一种**：参数来的值印成 `config`
   * （或 `default`）会让「它在读另一个实例」这个最该被看见的事实消失 —— 三值纪律
   * （「缺席」≠「空」）的同族错误。
   */
  dshHomeSource: 'config' | 'env' | 'default' | 'tool-argument'
  /** profile 名：用于拼 `<dshHome>/profiles/<profile>`。 */
  profile: string
  /**
   * 用户在**插件配置**里写的端口；`undefined` = 没写（不是「端口 0」）。
   *
   * ## 为什么是 `undefined` 而不是 `0`（2026-10-17 改）
   *
   * 这里曾经是 `number`，默认值 `0`，语义是「自己推断」。问题在于**哨兵值跑出了边界**：
   * `resolveConfig` 的名字说「已解析」，却把一个「未解析」的 0 交给下游，于是每个消费者
   * 都必须**记得**去调 `resolvePort`，忘了就静默拿到 0。
   *
   * 后果是真机故障而不是理论风险：`dsh_restart` 用它拼出了 `launch-0.job` /
   * `stop-window-0.pid`，停止窗口去绑 0 号端口、永远找不到宿主，而当时 931 条用例 +
   * CI + lint **全绿** —— 没有任何判据问过端口是几。
   *
   * 改成 `undefined` 之后，「忘了解析」从**静默的 0** 变成**类型上的缺席**：想把它当数字用
   * 就必须先过 `resolvePort`。哨兵只留在 schema 边界（`Config.port` 的 `default(0)`），
   * 那里它才是合理的惯用法。
   */
  port?: number
  /**
   * `dsh_restart` 的总闸（**默认关**，`resolveConfig` 显式兜底成 `false`）。
   *
   * ## 为什么这里仍然是**活引用**而不是它的值
   *
   * `.volatile()` 是**宿主那一侧**的声明（`src/config.ts` 那个 `Config` 字段），
   * 作用是「改这个字段**不该**被当成一次需要重启的变更」—— 维护者 2026-10-15
   * 追加的「丝滑关开、不用重启」。
   *
   * ⚠️ **所以这里不能是它的值**：`resolveConfig` 只在 `apply()` 里跑**一次**，
   * 若在这里把它读成布尔，那个值就永远冻结了 —— 而宿主那一侧仍然「no restart」，
   * 用户改了开关却要重启才生效，界面上那句话就成了骗人的。⇒ 传引用本身，
   * 由工具**每次调用现读** `.get()`（`Volatile<T>` 就是 `{ get(): T }`，
   * cosmokit 的原话：「keep the reference, or capture its value for one operation only」）。
   *
   * 必填而不是可选：可选会让这个**已解析**的形状出现第二种（有 / 没有），
   * 每个读者都得处理 `undefined` —— 那正是「形状骗人」那一族。
   */
  enableRestart: Volatile<boolean>
}
