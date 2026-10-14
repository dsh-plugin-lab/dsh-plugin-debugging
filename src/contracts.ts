/**
 * 契约层：跨模块共享的**类型**，不含实现。
 *
 * 存在的理由只有一个：让「技能半边」与「工具半边」能在不碰对方文件的前提下并行开发。
 * 两份实现只共享这里的形状，谁都不许往这里塞逻辑。
 */
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
  /** 要探测的宿主端口；`0` = 自己按监听端口推断。 */
  port: number
}
