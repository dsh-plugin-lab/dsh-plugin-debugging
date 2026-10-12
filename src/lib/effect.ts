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
      note: '组合树里没有可用的 hmr 行 —— 此时 reload() 是空操作，热生效一律降级为重启',
    }
  }
  return {
    present: true,
    disabled,
    evidence,
    note:
      disabled === 'yes'
        ? '组合树里有 hmr 行，但它被静态禁用了 —— 视同没挂'
        : disabled === 'conditional'
          ? '组合树里有 hmr 行，但它的 disabled 是运行时表达式（按 profileContext 决定）——按可用处理，但结论带条件'
          : '组合树里有 hmr 行且未被禁用',
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
    return `${reason}${mode === 'hot' ? '；该 profile 挂着 hmr，热生效成立' : ''}`
  }
  if (baseline === 'hot') {
    return `${reason}；但该 profile 没有可用的 hmr，reload() 是空操作 —— 所以热生效降级为必须重启`
  }
  return `${reason}；但该 profile 没有可用的 hmr，客户端不会自动换入 —— 需要重新构建后刷新页面`
}

/**
 * 每种改动的原理说明（SKILL §一「为什么」列）。
 *
 * @param input 判定输入。
 */
function baselineReason(input: EffectInput): string {
  switch (input.change) {
    case 'config':
      return 'loader 每次变更都重读配置、按行比较、只重建变化的行'
    case 'bundle-added':
      return input.alreadyInDependencies === true
        ? '该包已经在 dependencies 里，只改选择时 loader 报 restart-required'
        : '全新安装走 reload()'
    case 'host-code':
      return '进程启动只装载一次模块，依赖变化还会改模块图'
    case 'client-code':
      return '浏览器侧独立加载，与宿主模块缓存无关'
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
