/**
 * 「生效三档」的判定（SKILL §一），**纯函数**，不碰 IO。
 *
 * SKILL 的原表：
 * | 改了什么 | 生效方式 |
 * |---|---|
 * | 配置 / patch / 启用状态 / 卸载 | 热生效 |
 * | 新装 bundle（已在 `dependencies` 里 → 重启） | 热生效 |
 * | 已装插件宿主端代码 / 改插件依赖 | 必须重启 |
 * | 客户端代码 / 界面 | HMR 自动换入；未挂则构建 + 刷新 |
 *
 * **关键前提**（SKILL §一 的加注）：`reload()` 在没有 `hmr` 服务时是**空操作**，
 * 此时任何「热生效」都退化成 `restart-required`。
 * 所以判定的第二步必须先探测 hmr，再决定要不要降级 —— 不做这一步的工具会在
 * 没挂 hmr 的 profile 上**假装热生效**（`headless` / `sdk` / `acp` 默认就没挂）。
 */

/** 「改了什么」的闭枚举。 */
export type EffectChangeKind =
  /** 配置 / patch / 启用状态 / 卸载。 */
  | 'config'
  /** 新装 bundle。 */
  | 'bundle-added'
  /** 已装插件的**宿主端代码**，或改了插件依赖。 */
  | 'host-code'
  /** 客户端代码 / 界面。 */
  | 'client-code'

/** 生效方式。 */
export type EffectMode =
  /** 热生效：loader 重读配置即可。 */
  | 'hot'
  /** HMR 自动换入（客户端侧）。 */
  | 'hmr'
  /** 客户端需要重新构建 + 刷新（没挂 hmr 时的客户端路径）。 */
  | 'client-rebuild'
  /** 必须重启进程。 */
  | 'restart-required'

/** hmr 探测结果。 */
export interface HmrProbe {
  /** 组合树里有没有 hmr 行。 */
  present: boolean
  /**
   * 那一行是不是被禁用。
   *
   * `conditional` = `disabled:` 是一个 `!!js` 表达式（实测 web profile 上正是
   * `!!js '!ctx.get(''profileContext'')'`）—— 静态看是「按上下文决定」，
   * 不能当成确定可用，也不能当成确定不可用。
   */
  disabled: 'no' | 'yes' | 'conditional'
  /** 证据行（原样摘录，便于模型自己复核）。 */
  evidence: string[]
  /** 一句可读说明。 */
  note: string
}

/** 判定输入。 */
export interface EffectInput {
  change: EffectChangeKind
  /** 仅 `bundle-added` 用：该包是否**已经**在 profile 的 `dependencies` 里。 */
  alreadyInDependencies?: boolean
  /** 该 profile 的 hmr 是否**真的可用**（`present && disabled !== 'yes'`）。 */
  hmrUsable: boolean
}

/** 判定结果。 */
export interface EffectDecision {
  change: EffectChangeKind
  /** 只看 SKILL §一 原表（不看 hmr）的答案。 */
  baseline: EffectMode
  /** 结合 hmr 探测后的最终答案。 */
  mode: EffectMode
  /** 是否因为 hmr 缺席而发生了降级。 */
  downgraded: boolean
  /** 为什么 —— 模型真正读的是这句。 */
  why: string
  hmrUsable: boolean
}

/**
 * 探测组合树里的 hmr。
 *
 * 判据用**行**而不是「文本里出现过 `dsh-hmr`」：后者会把 `node_modules` 路径、
 * 注释里的提及也算成命中，于是「没挂 hmr」被判成「挂了」，工具开始假装热生效。
 *
 * @param configText `dsh --profile <p> --dump-config` 的 stdout。
 */
export function probeHmr(configText: string): HmrProbe {
  const lines = configText.split(/\r?\n/u)
  const evidence: string[] = []
  let present = false
  let disabled: HmrProbe['disabled'] = 'no'

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (!/^- id:\s*hmr\s*$/u.test(line)) continue
    evidence.push(line)
    present = true
    // 走这一行的块：到下一个顶层条目或下一个 `# ==` 注释块为止。
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const inner = lines[cursor] ?? ''
      if (/^- id:/u.test(inner) || inner.startsWith('# ==')) break
      const nameMatch = /^\s+name:\s*(.+?)\s*$/u.exec(inner)
      if (nameMatch?.[1] !== undefined) {
        evidence.push(inner)
        if (!nameMatch[1].includes('dsh-hmr')) present = false
        continue
      }
      const disabledMatch = /^\s+disabled:\s*(.+?)\s*$/u.exec(inner)
      if (disabledMatch?.[1] !== undefined) {
        evidence.push(inner)
        disabled = classifyDisabled(disabledMatch[1])
      }
    }
    break
  }

  if (!present) {
    return {
      present: false,
      disabled: 'no',
      evidence,
      note: 'no usable hmr row in the composed tree — reload() is a no-op there, so every live verdict downgrades to a restart',
    }
  }
  return {
    present: true,
    disabled,
    evidence,
    note:
      disabled === 'yes'
        ? 'the composed tree has an hmr row, but it is statically disabled — treated as not mounted'
        : disabled === 'conditional'
          ? 'the composed tree has an hmr row whose disabled is a runtime expression (decided by profileContext) — treated as usable, but the verdict carries that condition'
          : 'the composed tree has an hmr row and it is not disabled',
  }
}

/**
 * 判定一份改动需要什么才能生效。
 *
 * @param input 改动种类 + hmr 可用性。
 */
export function decideEffectMode(input: EffectInput): EffectDecision {
  const baseline = baselineMode(input)
  const mode = downgrade(baseline, input.hmrUsable)
  const downgraded = mode !== baseline
  return {
    change: input.change,
    baseline,
    mode,
    downgraded,
    hmrUsable: input.hmrUsable,
    why: buildWhy(input, baseline, mode, downgraded),
  }
}

/**
 * SKILL §一 原表的答案。
 *
 * @param input 判定输入。
 */
function baselineMode(input: EffectInput): EffectMode {
  switch (input.change) {
    case 'config':
      return 'hot'
    case 'bundle-added':
      // 全新装走 reload()；**已在 dependencies 里**只改选择则报 restart-required。
      return input.alreadyInDependencies === true ? 'restart-required' : 'hot'
    case 'host-code':
      return 'restart-required'
    case 'client-code':
      return 'hmr'
  }
}

/**
 * 按 hmr 可用性降级。
 *
 * @param baseline 原表答案。
 * @param hmrUsable hmr 是否可用。
 */
function downgrade(baseline: EffectMode, hmrUsable: boolean): EffectMode {
  if (hmrUsable) return baseline
  // 无 hmr ⇒ reload() 是空操作 ⇒ 任何「热生效」都必须重启。
  if (baseline === 'hot') return 'restart-required'
  // 客户端那条路 SKILL 自己给了退路：未挂 hmr 时「构建 + 刷新」，不是重启。
  if (baseline === 'hmr') return 'client-rebuild'
  return baseline
}

/**
 * 拼可读理由。
 *
 * ## 收尾句的判据是「**实际结论**」，不是 `mode` 一个字（2026-10-13 修，W2-A2）
 *
 * 原实现是 `mode === 'hot' ? HOT_WITH_HMR : CLIENT_WITH_HMR` —— 只看 `mode`，**没看这一档
 * 到底是不是降级**。于是 **hmr 可用 + `host-code`**（或 `bundle-added` 且已在
 * `dependencies`）时，判定是 `restart-required`，收尾句却说「hmr 挂了，客户端会换入」
 * —— **判定对了、解释反了**。
 *
 * 为什么这种错特别值得单独修：判错会被断言抓住，**解释反了只有人读得出来**；
 * 而它躺着的位置正是 `audit`（定义就是「给人复核的」，SHAPE §5）—— 复核者会被它带偏。
 * 所以三条收尾句各自绑到**它成立的那个结论**上：`hot` 说重读、`hmr` 说客户端换入、
 * `restart-required` 说重启**并说明 hmr 在这一档为什么帮不上忙**。
 *
 * @param input 判定输入。
 * @param baseline 原表答案。
 * @param mode 最终答案。
 * @param downgraded 是否降级。
 */
function buildWhy(
  input: EffectInput,
  baseline: EffectMode,
  mode: EffectMode,
  downgraded: boolean,
): string {
  const reason = baselineReason(input)
  if (!downgraded) {
    if (mode === 'hot') return `${reason}; ${HOT_WITH_HMR}`
    if (mode === 'hmr') return `${reason}; ${CLIENT_WITH_HMR}`
    // 走到这里只剩 `restart-required`：它**不是**降级（原表本来就要重启，例如
    // host-code / 已在 dependencies 里的 bundle），所以 hmr 在不在都一样 ——
    // 客户端那句说明在这一档是反话，不许再挂上去。
    return `${reason}; ${input.hmrUsable ? RESTART_DESPITE_HMR : RESTART_ONLY_PATH}`
  }
  if (baseline === 'hot') {
    // 这句是本工具存在的理由：**「loader 会重读配置」缺的不是能力，而是触发者**。
    // 实测（2026-10-13，无 hmr 的隔离实例）：改 patch 文件 70 秒 / 21 个采样点零反应，
    // stderr 为空；重启后立刻读到新值。而 watch patch 文件的正是 hmr
    // （`…\dsh-hmr\lib\index.js:718` 的 `watchConfig(filename, …)`，被 watch 的是 patch 文件）。
    return (
      `${reason}; but there is no usable hmr in this profile — nothing watches the patch files, ` +
      'so the change is not re-read and a restart is required'
    )
  }
  return (
    `${reason}; but there is no usable hmr in this profile, so the client will not swap the ` +
    'asset in — rebuild, then refresh the page'
  )
}

/** 有 hmr 且不降级时，`hot` 那一支的解释。 */
const HOT_WITH_HMR =
  'hmr is mounted in this profile and it is what watches the patch files, so the change is re-read live'

/** 有 hmr 且不降级时，客户端那一支的解释。 */
const CLIENT_WITH_HMR = 'hmr is mounted in this profile, so the client swaps the asset in'

/**
 * **hmr 可用、但这一档本来就要重启**时的收尾句。
 *
 * 要点：说明 hmr 的能力边界（它换的是配置行与客户端资源），而不是暗示它会替你做这件事。
 */
const RESTART_DESPITE_HMR =
  'hmr cannot apply this change live: it re-reads config rows and swaps client assets, but it ' +
  'cannot change the host module graph or the bundle selection — a restart is required'

/** 没有 hmr、且这一档本来就要重启时的收尾句（连同 hmr 也帮不上忙一起说清）。 */
const RESTART_ONLY_PATH =
  'no live path applies this change, and there is no usable hmr in this profile either — a restart is required'

/**
 * 每种改动的原理说明（SKILL §一「为什么」列）。
 *
 * @param input 判定输入。
 */
function baselineReason(input: EffectInput): string {
  switch (input.change) {
    case 'config':
      // 刻意**不**写成「loader 每次变更都重读配置」——那句会让人以为重读是自动发生的，
      // 而实测的真相是：重读要有触发者，触发者住在 hmr 里（见 buildWhy 的注释）。
      return 'the loader re-reads config and rebuilds only the rows that changed, once something signals a reload'
    case 'bundle-added':
      return input.alreadyInDependencies === true
        ? 'the package is already in dependencies; flipping the selection reports restart-required'
        : 'a fresh install goes through reload()'
    case 'host-code':
      return 'the process loads modules once at startup, and a dependency change alters the module graph'
    case 'client-code':
      return 'the browser loads its bundle independently of the host module cache'
  }
}

/**
 * 判 `disabled:` 那一行的语义。
 *
 * @param rawValue `disabled:` 后面的原文。
 */
function classifyDisabled(rawValue: string): HmrProbe['disabled'] {
  const value = rawValue.trim()
  if (value === 'true') return 'yes'
  if (value === 'false') return 'no'
  if (value.startsWith('!!js')) return 'conditional'
  return 'conditional'
}
