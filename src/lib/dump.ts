/**
 * `dsh --dump-config` / `--dump-config-schema` 的调用与解析。
 *
 * 三条实测结论决定了本文件的结构（0.2.1-alpha.2，本机 pid 34216，2026-10-12 实测）：
 *
 * 1. **`--dump-config` 退出码恒 0** —— 它不做 schema 校验，所以**不能当门禁**。
 *    但它仍然把组合期错写到 **stderr**（实测：`patch: name mismatch … skipping`）。
 *    → 结论「配置有没有坏」不能看退出码，要看 stderr + schema 的 diagnostics。
 * 2. **`--dump-config-schema` 退出码 1 = 有 error**；`diagnostics` 数组在它的 **stdout** 里
 *    （JSON 的 `diagnostics` 字段），每项形如 `{ level, path?, message }`。
 * 3. **`path` 是组合树里的位置，形如 `/181`** —— 它指的是组合结果里**第 N 个顶层条目**
 *    （1 起）。实测 `/181`→`agent-preset-registry`、`/182..184`→`preset-standard|ptc|minimal`，
 *    正是 SKILL §3.8 说的已知误报（`unrecognized Loader tree carrier` 落在 preset 行上）。
 *    所以「这个 error 是不是误报」**必须先把 path 解析成 entry id** 才能判。
 */
import type { CommandResult, SpawnImpl } from './exec.js'

/** `--dump-config` 的组合树里一个顶层条目。 */
export interface ComposedEntry {
  /** 1 起的序号 —— 与 diagnostics 的 `path`（`/N`）同一套编号。 */
  index: number
  id: string
  name?: string
  disabled?: string
  lineNumber: number
}

/** schema dump 里的一条诊断。 */
export interface DumpDiagnostic {
  level: string
  path?: string
  message: string
}

/** 诊断的分类：决定它值不值得模型动手。 */
export type DiagnosticClass =
  /** 真 error：指向的不是 preset 那种已知误报。 */
  | 'error'
  /** 已知误报：`unrecognized Loader tree carrier` 落在 preset 行上（SKILL §3.8）。 */
  | 'known-false-positive'
  /** 组合期错：某个 patch 行被 `skipping` 整条丢弃 —— 这条**永远是真的**。 */
  | 'composition-error'
  /** schema 投影期的 warning：不影响这次运行。 */
  | 'projection-warning'

/** 带分类的诊断。 */
export interface ClassifiedDiagnostic extends DumpDiagnostic {
  classification: DiagnosticClass
  /** `path` 解析出的 entry id（解析得到时）。 */
  entryId?: string
}

/** 一次 dump 调用的结果。 */
export interface DumpInvocation {
  flag: '--dump-config' | '--dump-config-schema'
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
  spawnError?: string
}

/** 怎么启动 dsh。 */
export interface DshLaunch {
  command: string
  /** 放在用户参数之前的固定参数（例如 `bin.js` 的路径）。 */
  prefix: readonly string[]
}

/**
 * 推断「怎么再起一个 dsh 进程」。
 *
 * 优先复用**当前正在跑的宿主**的入口：本插件活在 dsh 进程里，`process.argv[1]`
 * 就是那个 `lib/bin.js`。用 `process.execPath` + 它，等于「用同一个 node 跑同一个 CLI」，
 * 不必依赖 PATH 上的 `dsh` 是 `.cmd` 还是 `.ps1`（Windows 上 `spawn` 不解析 `.cmd`，
 * 这条差异会让工具在别人机器上静默失效）。
 *
 * 退路是 PATH 上的 `dsh`。
 *
 * @param argv 进程参数，默认 `process.argv`。
 * @param execPath node 可执行文件路径，默认 `process.execPath`。
 */
export function resolveDshLaunch(
  argv: readonly string[] = process.argv,
  execPath: string = process.execPath,
): DshLaunch {
  const entry = argv[1]
  if (typeof entry === 'string' && /(?:^|[\\/])bin\.js$/u.test(entry)) {
    return { command: execPath, prefix: [entry] }
  }
  return { command: 'dsh', prefix: [] }
}

/**
 * 跑一次 dump。
 *
 * **不抛**：失败收敛成结果字段。
 *
 * @param launch 怎么启动 dsh。
 * @param profile profile 名。
 * @param flag 要跑哪个 dump。
 * @param deps 可注入的 spawn 与预算。
 */
export async function runDump(
  launch: DshLaunch,
  profile: string,
  flag: DumpInvocation['flag'],
  deps: { spawn: SpawnImpl; timeoutMs: number; signal?: AbortSignal | undefined },
): Promise<DumpInvocation> {
  const result: CommandResult = await deps.spawn({
    command: launch.command,
    args: [...launch.prefix, '--profile', profile, flag],
    timeoutMs: deps.timeoutMs,
    signal: deps.signal,
  })
  return {
    flag,
    exitCode: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    aborted: result.aborted,
    ...(result.spawnError === undefined ? {} : { spawnError: result.spawnError }),
  }
}

/**
 * 解析组合树里的顶层条目。
 *
 * **只数顶格（`- id:` 在行首）的行** —— 实测 diagnostics 的 `/N` 编号正是这一套
 * （`/181` ↔ 第 181 个顶格条目）。缩进的 `- id:` 属于嵌套 group，不计入。
 *
 * @param configText `--dump-config` 的 stdout。
 */
export function parseComposedEntries(configText: string): ComposedEntry[] {
  const entries: ComposedEntry[] = []
  let current: ComposedEntry | undefined
  const lines = configText.split(/\r?\n/u)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const idMatch = /^- id:\s*(\S+)\s*$/u.exec(line)
    if (idMatch?.[1] !== undefined) {
      current = { index: entries.length + 1, id: idMatch[1], lineNumber: index + 1 }
      entries.push(current)
      continue
    }
    if (current === undefined) continue
    // 遇到下一个顶层条目或下一层注释块（`# == <bundle>`）就收尾。
    if (line.startsWith('# ==')) {
      current = undefined
      continue
    }
    const nameMatch = /^\s+name:\s*(.+?)\s*$/u.exec(line)
    if (nameMatch?.[1] !== undefined && current.name === undefined) {
      current.name = stripQuotes(nameMatch[1])
      continue
    }
    const disabledMatch = /^\s+disabled:\s*(.+?)\s*$/u.exec(line)
    if (disabledMatch?.[1] !== undefined && current.disabled === undefined) {
      current.disabled = disabledMatch[1]
    }
  }
  return entries
}

/**
 * 把 diagnostics 的 `path`（`/N`）解析成 entry id。
 *
 * @param path 形如 `/181`；`undefined` 或形状不符时返回 `undefined`。
 * @param entries 组合树条目。
 */
export function entryIdForPath(path: string | undefined, entries: readonly ComposedEntry[]): string | undefined {
  if (path === undefined) return undefined
  const match = /^\/(\d+)$/u.exec(path.trim())
  if (match?.[1] === undefined) return undefined
  const index = Number.parseInt(match[1], 10)
  return entries.find((entry) => entry.index === index)?.id
}

/**
 * 从 schema dump 的 stdout 里取 `diagnostics` 数组。
 *
 * 该数组嵌在 schema JSON 的深处，所以按名字递归找。JSON 解析失败时返回空数组
 * （调用方会用 stderr 的文本行兜底，两条路都断了才算「没有诊断」）。
 *
 * @param schemaText `--dump-config-schema` 的 stdout。
 */
export function parseDiagnosticsFromSchemaText(schemaText: string): DumpDiagnostic[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(schemaText)
  } catch {
    return []
  }
  const found = findDiagnostics(parsed, 0)
  if (found === undefined) return []
  const result: DumpDiagnostic[] = []
  for (const item of found) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const message = record['message']
    if (typeof message !== 'string') continue
    const level = typeof record['level'] === 'string' ? record['level'] : 'unknown'
    const path = typeof record['path'] === 'string' ? record['path'] : undefined
    result.push({ level, message, ...(path === undefined ? {} : { path }) })
  }
  return result
}

/**
 * 从 stderr 的文本行里取诊断。
 *
 * **两种形状都要认**（都是本机 0.2.1-alpha.2 实测出来的）：
 * - 带严重级：`dsh: error: [/181] unrecognized Loader tree carrier…`、
 *   `dsh: warning: patch: name mismatch …`（`--dump-config-schema` 的 stderr）；
 * - **不带严重级、只带来源**：`dsh: [C:\…\cordis.patch.yml] patch: name mismatch …, skipping`
 *   （`--dump-config` 的 stderr）。
 *
 * 第二种是本条兜底存在的**唯一**理由：SKILL §3.8 说 `--dump-config` 不做 schema 校验、
 * 退出码恒 0，所以「配置坏没坏」在那条命令上**只有 stderr 能回答**。只认第一种形状
 * 会把组合期错整条漏掉 —— 而它恰恰是「插件装了却没启用」的第一类原因。
 *
 * @param stderr 进程的 stderr。
 */
export function parseDiagnosticsFromStderr(stderr: string): DumpDiagnostic[] {
  const result: DumpDiagnostic[] = []
  for (const rawLine of stderr.split(/\r?\n/u)) {
    const line = rawLine.trim()
    const graded = /^dsh:\s*(error|warning):\s*(?:\[([^\]]+)\]\s*)?(.*)$/u.exec(line)
    if (graded !== null) {
      const message = (graded[3] ?? '').trim()
      if (message === '') continue
      result.push({
        level: graded[1] ?? 'unknown',
        message,
        ...(graded[2] === undefined ? {} : { path: graded[2] }),
      })
      continue
    }
    // 无严重级、带来源标签。组合期错（`patch: …`）在这里按 error 处理：
    // 它会让整条配置行被 `skipping` 丢弃，性质比 warning 重。
    const sourced = /^dsh:\s*\[([^\]]+)\]\s*(.+)$/u.exec(line)
    if (sourced === null) continue
    const message = (sourced[2] ?? '').trim()
    if (message === '') continue
    result.push({
      level: message.startsWith('patch: ') ? 'error' : 'warning',
      message,
      path: sourced[1] ?? '',
    })
  }
  return result
}

/**
 * 给一条诊断分类，并把 `path` 解析成 entry id。
 *
 * 判定顺序是有意的：**组合期错优先**（它永远是真的，且会让一整行消失），
 * 然后才是 preset 的已知误报。
 *
 * @param diagnostic 一条诊断。
 * @param entries 组合树条目（用于解析 path）。
 */
export function classifyDiagnostic(
  diagnostic: DumpDiagnostic,
  entries: readonly ComposedEntry[],
): ClassifiedDiagnostic {
  const entryId = entryIdForPath(diagnostic.path, entries)
  const classification = classify(diagnostic, entryId)
  return {
    ...diagnostic,
    classification,
    ...(entryId === undefined ? {} : { entryId }),
  }
}

/**
 * 分类规则本体。
 *
 * @param diagnostic 一条诊断。
 * @param entryId path 解析出的 entry id。
 */
function classify(diagnostic: DumpDiagnostic, entryId: string | undefined): DiagnosticClass {
  if (diagnostic.message.startsWith('patch: ')) return 'composition-error'
  if (diagnostic.message.includes('unrecognized Loader tree carrier')) {
    // SKILL §3.8 点名的官方误报：`preset-*` 行的 `config.plugins` 报这个。
    // 实测 0.2.1-alpha.2 上它还落在 `agent-preset-registry` 上，一并归入。
    if (entryId !== undefined && (entryId.startsWith('preset-') || entryId === 'agent-preset-registry')) {
      return 'known-false-positive'
    }
    return 'error'
  }
  if (diagnostic.level === 'warning') return 'projection-warning'
  return 'error'
}

/**
 * 在任意 JSON 里递归找名为 `diagnostics` 的数组。
 *
 * @param value 任意 JSON 值。
 * @param depth 当前深度（防病态嵌套）。
 */
function findDiagnostics(value: unknown, depth: number): unknown[] | undefined {
  if (depth > 12 || typeof value !== 'object' || value === null) return undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDiagnostics(item, depth + 1)
      if (found !== undefined) return found
    }
    return undefined
  }
  const record = value as Record<string, unknown>
  const direct = record['diagnostics']
  if (Array.isArray(direct)) return direct
  for (const item of Object.values(record)) {
    const found = findDiagnostics(item, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * 去掉 YAML 标量外层的引号。
 *
 * @param value 原始标量文本。
 */
function stripQuotes(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'")
  }
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}
