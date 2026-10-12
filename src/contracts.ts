/**
 * 契约层：跨模块共享的**类型**，不含实现。
 *
 * 存在的理由只有一个：让「技能半边」与「工具半边」能在不碰对方文件的前提下并行开发。
 * 两份实现只共享这里的形状，谁都不许往这里塞逻辑。
 */

/** 技能注册的结果。注册失败**不是**插件的失败 —— 工具半边照常工作。 */
export interface SkillReport {
  /** 是否成功把自己的技能注册进宿主注册表。 */
  ok: boolean
  /** 注册成的技能名（`ok` 为真时有值）。 */
  name?: string
  /** 正文字节数：用来把「注册成了但正文是空的」这种静默失败照出来。 */
  contentBytes?: number
  /** 失败的结构化原因（`ok` 为假时有值）。 */
  error?: SkillError
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

/** 配置项补齐默认值后的形状：工具半边只认这个，不再关心「有没有配」。 */
export interface ResolvedConfig {
  /** DSH_HOME 目录（绝对路径）。 */
  dshHome: string
  /**
   * `dshHome` 是怎么来的：`config` = 用户在插件配置里写了；`env` = 环境变量 `DSH_HOME`；
   * `default` = 我们按宿主的默认值推的 `<homedir>/.dsh`。
   *
   * **必须带出去给用户看**：诊断工具最怕「看着成功其实读错了目录」，读默认目录这件事
   * 本身要成为可见证据，而不是隐藏假设。
   */
  dshHomeSource: 'config' | 'env' | 'default'
  /** profile 名：用于拼 `<dshHome>/profiles/<profile>`。 */
  profile: string
  /** 要探测的宿主端口；`0` = 自己按监听端口推断。 */
  port: number
  /** 单个外部命令 / 请求的超时（毫秒）。 */
  timeoutMs: number
}
