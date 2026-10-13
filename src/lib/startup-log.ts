/**
 * `$DSH_HOME/logs/startup-*.log` 的解析（**纯函数：不读盘，内容由调用方传入**）。
 *
 * ## 为什么要有它
 *
 * 那个日志不是 JSON，是 **`util.inspect(...)` 的输出**（`dsh/lib/bin.js` 的
 * `reportStartupFailure`，参数 `depth:null, showHidden:true, customInspect:false`）：
 * 键没有引号、`[length]: N` 是**伪字段**、多行 error 内嵌、字符串带 `\n` 转义。
 * 所以只能**行导向 + 容错**地解析，不能 `JSON.parse`。
 *
 * ## 三个「不许压成两值」的地方（都是本仓踩过的坑）
 *
 * 1. **解析失败 ≠ 没有失败条目**。整份日志读到了、但四个锚点一个都没命中时，
 *    必须 `parse.ok === false`（判红）；把它当成「日志里没有失败插件」是本项目
 *    头号禁忌（AGENTS 活跃坑 18：最危险的静默失败是让判据自己看起来通过了）。
 * 2. **某段合法缺席 ≠ 某段在但没解出来**。`Failed plugins (N):` 只在 N>0 时打印
 *    （`dsh-app-boot` 的 `startupDiagnostic`），所以「没有这一段」= 没有失败插件；
 *    「有这一段却解不出 N 条」才进 `gaps`。
 * 3. **读不到 ≠ 没有**。读文件失败走 `parse.readError`（未知），不参与 `ok` 的判定。
 *
 * ## 计数为什么要交叉核对
 *
 * 真机那份日志的锚点是 **headline=2 / Failed=1 / waiting=11 / entries=12**：
 * `2` 是**未激活的 required 条目**数（`webserver` 失败 + `connection` 等待），
 * `1` 才是失败的个数。**别把 2 当成「失败插件个数」** —— 所以 `requiredNotActivated`
 * 与 `failed.length` 是两个字段，且 `gaps` 里有一条专门核对它们。
 *
 * ## 缩进是**相对**的
 *
 * 段标题的缩进由它在 `inspect` 输出里的嵌套深度决定（真机那份里 `Failed plugins (N):`
 * 在缩进 2、条目在 4、`Package:` 在 6）。这里不写死数字，而是**以标题行的缩进为基准**
 * 取偏移 —— 宿主换个包装层也不会整段解错。
 */

/** 认出来的段（`sections` 的取值）。 */
export type StartupLogSection = 'header' | 'failed' | 'pending' | 'entries' | 'startup' | 'messages'

/** 一份日志的解析结论。 */
export interface StartupLogParse {
  /**
   * 解析成功（四个锚点里至少命中一个）。
   *
   * `false` **必须判红**：它是「这份日志存在、但里面的段一个都没认出来」，
   * 与「日志里没有失败条目」是两件完全不同的事（活跃坑 18）。
   */
  ok: boolean
  /** 实际认出来的段。 */
  sections: StartupLogSection[]
  /**
   * 部分解析的缺口（非空 = 有的段没解全）。**每一条都由标记推出，不许猜**。
   *
   * 形状：`<缺口名> (declared N, parsed M)`，例如 `failed-count (declared 1, parsed 0)`。
   */
  gaps: string[]
  /** `ok === false` 时的一句话原因（英文）。 */
  reason?: string
  /** 读文件失败的原因（英文）。有它时 `ok === false` 的语义是**未知**，不是「格式不认识」。 */
  readError?: string
  /** 内容看起来被截断（写盘中途被杀 / 超过字节上限）。**这不是解析失败**。 */
  truncated?: boolean
}

/** 一条失败插件（`Failed plugins (N):` 段）。 */
export interface StartupFailure {
  /** entry id（`webserver` 这种）。 */
  id: string
  /** 宿主把它算进了未激活的 required 条目。 */
  required: boolean
  /** 包名 —— 只有这个字段能把 id 与「装了哪个包」对上。 */
  module?: string
  /** 续行块首行（已剥掉 `Error: ` 前缀）。**这是唯一能导向「端口被占」那类根因的原料。** */
  error?: string
  /** 续行块的其余行（原文，给人工复核）。 */
  stack?: string
}

/** 一条等待服务的插件（`Plugins waiting for services (N):` 段）。 */
export interface StartupPending {
  /** entry id（**不是**服务名，也不是包名）。 */
  id: string
  required: boolean
  /** 缺哪些服务。 */
  missing: string[]
  /** 右列恰为字面量 `unknown` —— 宿主不知道缺什么，**不是**缺一个叫 unknown 的服务。 */
  missingUnknown?: boolean
}

/** 一条 entry（`[entries]` 块）。 */
export interface StartupEntry {
  id: string
  /** 包名（等待表里没有这一项，所以这个块不可替代）。 */
  module?: string
  required: boolean
  fiberState?: number
  /** 宿主给的结果档位；别的一律 `unknown`（不猜）。 */
  kind: 'failed' | 'pending' | 'unknown'
  missing?: string[]
  /** 有没有 `error:` 字段。 */
  hasError: boolean
}

/** 一条组合期消息（`[startup].messages`）。 */
export interface StartupMessage {
  /** 消息来源（`root` / `web-server` 这种）。 */
  name?: string
  /** `warn` / `error`。 */
  type?: string
  /** 第一个参数的文本（字符串原样；`Error` 取 `Error: ` 之后的第一行）。 */
  text?: string
}

/** 一份日志解析出来的全部事实。 */
export interface StartupLogReport {
  timestamp?: string
  dshVersion?: string
  nodeVersion?: string
  platform?: string
  arch?: string
  profile?: string
  /** `[startup].configurationPath`。 */
  configurationPath?: string
  /** headline 原文（`startup failed: 2 required plugins did not activate`）。 */
  headline?: string
  /** headline 里的数字 = **未激活的 required 条目**数（**不是**失败插件个数）。 */
  requiredNotActivated?: number
  failed: StartupFailure[]
  pending: StartupPending[]
  entries: StartupEntry[]
  messages: StartupMessage[]
}

/** 解析一份日志的结果（`parse` 是结论，`report` 是事实）。 */
export interface StartupLogParseResult {
  parse: StartupLogParse
  report: StartupLogReport
}

/** 整份日志的锚点：四个里**一个都不命中** = 解析失败。 */
const ANCHORS = [
  'startup failed:',
  'Failed plugins (',
  'Plugins waiting for services (',
  '[entries]: [',
]

/**
 * 解析一份启动日志的内容。**绝不抛**。
 *
 * @param text 文件内容（调用方读盘；超字节上限时已由调用方截断）。
 * @param options 调用方的补充事实（是否因超上限而截断）。
 */
export function parseStartupLog(
  text: string,
  options: { truncatedBySize?: boolean } = {},
): StartupLogParseResult {
  const lines = text.split(/\r?\n/u)
  const sections: StartupLogSection[] = []
  const gaps: string[] = []
  const report: StartupLogReport = { failed: [], pending: [], entries: [], messages: [] }

  let headlineFound = false
  let failedDeclared: number | undefined
  let pendingDeclared: number | undefined
  let entryLength: number | undefined

  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''

    const headlineAt = line.indexOf('startup failed:')
    // 只在**活的 `error:` 字段行**上认 headline：`inspect` 的输出里还有一份 `error.message`
    // 的**转义字符串副本**（`    [message]: 'dsh: startup failed: 2 …\n' +`），它也含有这句话。
    // 认副本的后果是：真 headline 被改坏时判据被副本救活 → 缺口看不见（假绿，本轮实测踩到）。
    // 认不出来的代价是可见的（走 `headline-missing` 缺口），不是静默的。
    const onLiveErrorLine = /^\s*error: .*startup failed:/u.test(line)
    if (!headlineFound && headlineAt >= 0 && onLiveErrorLine) {
      const match = /startup failed: (\d+) required plugins? did not activate/u.exec(line)
      if (match !== null) {
        headlineFound = true
        report.headline = line.slice(headlineAt).trim()
        report.requiredNotActivated = Number(match[1])
      }
      index += 1
      continue
    }

    const failedHeader = /^(\s*)Failed plugins \((\d+)\):$/u.exec(line)
    if (failedHeader !== null) {
      pushSection(sections, 'failed')
      failedDeclared = Number(failedHeader[2])
      index = readFailedSection(lines, index + 1, indentOf(failedHeader[1] ?? ''), report.failed)
      continue
    }

    const pendingHeader = /^(\s*)Plugins waiting for services \((\d+)\):$/u.exec(line)
    if (pendingHeader !== null) {
      pushSection(sections, 'pending')
      pendingDeclared = Number(pendingHeader[2])
      index = readPendingSection(lines, index + 1, indentOf(pendingHeader[1] ?? ''), report.pending)
      continue
    }

    const entriesHeader = /^(\s*)\[entries\]: \[$/u.exec(line)
    if (entriesHeader !== null) {
      pushSection(sections, 'entries')
      const read = readEntriesSection(lines, index + 1, indentOf(entriesHeader[1] ?? ''), report.entries)
      entryLength = read.length
      index = read.next
      continue
    }

    const startupHeader = /^(\s*)\[startup\]: \{$/u.exec(line)
    if (startupHeader !== null) {
      pushSection(sections, 'startup')
      const read = readStartupSection(lines, index + 1, indentOf(startupHeader[1] ?? ''), report)
      if (read.sawMessages) pushSection(sections, 'messages')
      index = read.next
      continue
    }

    const headerField =
      /^ {2}(timestamp|dshVersion|nodeVersion|platform|arch|profile): (.*),$/u.exec(line)
    if (headerField !== null) {
      assignHeader(report, headerField[1] ?? '', unquote(headerField[2] ?? ''))
      pushSection(sections, 'header')
      index += 1
      continue
    }

    // 别的行（栈、伪字段、宿主以后新增的段）一律跳过：它们不构成缺口 ——
    // 缺口只由**认出来的段**与它自己声明的计数推出（见文件头的第 2 条）。
    index += 1
  }

  const anchored = ANCHORS.some((anchor) => text.includes(anchor))
  // 截断检测：报告以 `inspect(单个对象) + "\n"` 收尾，所以合法文件必以 `}` 结尾。
  // 结尾不是 `}` = 写盘中途被杀（`bin.js` 在 writeFile 之前进程就没了）。
  const truncated = options.truncatedBySize === true || !text.trimEnd().endsWith('}')

  // ── 缺口：**每条都由标记推出，不许猜** ────────────────────────────────────
  //
  // 为什么要这么多条交叉核对：只做「计数对不对」的话，**把某一段的标题改掉**会让那一段
  // 静默消失（另外三个锚点照样命中 → `ok=true`、也没有计数差），而它的信息就此丢掉
  // —— 那正是活跃坑 18 的形状（判据自己看起来通过了）。下面四条各自堵住一段。
  if (headlineFound && !sections.includes('failed') && !sections.includes('pending')) {
    gaps.push(
      'no-inactive-section (the headline counts inactive required plugins, but neither list is present)',
    )
  }
  // ① 段在、headline 却不在：这两段只会作为**同一条诊断消息**的一部分被打印出来。
  if (!headlineFound && (sections.includes('failed') || sections.includes('pending'))) {
    gaps.push('headline-missing (the failed/waiting lists are present, but the startup-failed headline is not)')
  }
  // ② headline 的 required 数必须等于两张表里 required 条目之和
  //    （真机那份：2 = webserver(failed) + connection(pending)）。
  if (
    report.requiredNotActivated !== undefined &&
    (sections.includes('failed') || sections.includes('pending'))
  ) {
    const requiredInTables =
      report.failed.filter((item) => item.required).length +
      report.pending.filter((item) => item.required).length
    if (requiredInTables !== report.requiredNotActivated) {
      gaps.push(
        `required-inactive-count (headline ${String(report.requiredNotActivated)}, lists ${String(requiredInTables)})`,
      )
    }
  }
  // ③ 两张表里的 id 必须在 `[entries]` 里出现 —— 它是同一条 `failures` 列表的机器可读副本。
  const tableIds = [...report.failed.map((item) => item.id), ...report.pending.map((item) => item.id)]
  if (tableIds.length > 0) {
    const entryIds = new Set(report.entries.map((entry) => entry.id))
    const absent = tableIds.filter((id) => !entryIds.has(id))
    if (absent.length > 0) {
      gaps.push(
        `entries-ids (${String(absent.length)} id(s) from the failed/waiting lists are absent from the entries block: ${absent.join(', ')})`,
      )
    }
  }
  if (
    sections.includes('failed') &&
    failedDeclared !== undefined &&
    report.failed.length !== failedDeclared
  ) {
    gaps.push(`failed-count (declared ${String(failedDeclared)}, parsed ${String(report.failed.length)})`)
  }
  if (
    sections.includes('pending') &&
    pendingDeclared !== undefined &&
    report.pending.length !== pendingDeclared
  ) {
    gaps.push(
      `pending-count (declared ${String(pendingDeclared)}, parsed ${String(report.pending.length)})`,
    )
  }
  if (
    sections.includes('entries') &&
    entryLength !== undefined &&
    report.entries.length !== entryLength
  ) {
    gaps.push(
      `entries-count (declared ${String(entryLength)}, parsed ${String(report.entries.length)})`,
    )
  }
  if (sections.includes('entries') && report.requiredNotActivated !== undefined) {
    const requiredInEntries = report.entries.filter(
      (entry) => entry.required && entry.kind !== 'unknown',
    ).length
    if (requiredInEntries !== report.requiredNotActivated) {
      gaps.push(
        `required-count (headline ${String(report.requiredNotActivated)}, entries ${String(requiredInEntries)})`,
      )
    }
  }

  const parse: StartupLogParse = { ok: anchored, sections, gaps }
  if (truncated) parse.truncated = true
  if (!anchored) {
    parse.reason = truncated
      ? 'could not parse this startup log: the file looks truncated and no known section was recognised'
      : 'could not parse this startup log: none of the known sections (the startup-failed headline, the failed-plugin list, the waiting-services list, or the entries block) were recognised'
  }
  return { parse, report }
}

/**
 * 造一份「读不到」的解析结果。
 *
 * 它**不是**解析失败：`parse.ok === false` 且 `parse.readError` 非空 ——
 * 「读不到」是未知，与「格式不认识」对下一步的决定不同（活跃坑 18 的同族）。
 *
 * @param readError 读文件失败的一句话（英文）。
 */
export function unreadableStartupLog(readError: string): StartupLogParseResult {
  return {
    parse: { ok: false, sections: [], gaps: [], reason: readError, readError },
    report: { failed: [], pending: [], entries: [], messages: [] },
  }
}

/** 读一个段之前先看一眼：这一行是不是**另一个段/块的开头**。 */
const BLOCK_START =
  /^\s*(\[entries\]: \[|\[startup\]: \{|\[stack\]:|\[message\]:|\[cause\]:|\[errors\]:|\[length\]:|Failed plugins \(\d+\):|Plugins waiting for services \(\d+\):)/u

/**
 * 读 `Failed plugins (N):` 段。
 *
 * 真机形状（相对缩进）：条目 `<id>[ (required)]` 在 `base+2`，`Package: <pkg>` 在
 * `base+4`，其后的续行块（`Error:` 只是首行常见前缀，**不是分隔符**）在 `base+4` 及更深。
 *
 * @param lines 全部行。
 * @param start 段体第一行的下标。
 * @param base 段标题的缩进。
 * @param out 收条目。
 * @returns 下一段开始的下标。
 */
function readFailedSection(
  lines: readonly string[],
  start: number,
  base: number,
  out: StartupFailure[],
): number {
  let index = start
  let current: StartupFailure | undefined
  let detail: string[] = []
  const flush = (): void => {
    if (current === undefined) return
    const first = detail[0]
    if (first !== undefined) {
      current.error = stripErrorPrefix(first)
      const rest = detail.slice(1).join('\n')
      if (rest !== '') current.stack = rest
    }
    out.push(current)
    current = undefined
    detail = []
  }
  while (index < lines.length) {
    const line = lines[index] ?? ''
    const content = line.trim()
    const indent = indentOf(line)
    if (content === '') {
      index += 1
      continue
    }
    if (indent <= base || BLOCK_START.test(line)) break
    if (indent === base + 2) {
      flush()
      const required = content.endsWith(' (required)')
      current = {
        id: required ? content.slice(0, -' (required)'.length) : content,
        required,
      }
      index += 1
      continue
    }
    if (indent >= base + 4) {
      if (content.startsWith('Package: ')) {
        if (current !== undefined) current.module = content.slice('Package: '.length).trim()
      } else {
        detail.push(content)
      }
      index += 1
      continue
    }
    break
  }
  flush()
  return index
}

/**
 * 读 `Plugins waiting for services (N):` 段。
 *
 * 表头行（`Plugin` + `Missing services`）必须**先跳过**，否则永远差 1（假红）。
 * 右列**恰为字面量 `unknown`** 时是宿主的 `outcome.missing.join(', ') || "unknown"`
 * —— 那是「不知道缺什么」，不是「缺一个叫 unknown 的服务」。
 *
 * @param lines 全部行。
 * @param start 段体第一行的下标。
 * @param base 段标题的缩进。
 * @param out 收条目。
 * @returns 下一段开始的下标。
 */
function readPendingSection(
  lines: readonly string[],
  start: number,
  base: number,
  out: StartupPending[],
): number {
  let index = start
  let sawTableHeader = false
  while (index < lines.length) {
    const line = lines[index] ?? ''
    const content = line.trim()
    const indent = indentOf(line)
    if (content === '') {
      index += 1
      continue
    }
    if (indent <= base || BLOCK_START.test(line)) break
    // 表格之后跟着的是 StartupError 自己的栈（缩进更深）—— 段到此结束。
    if (indent !== base + 2) break
    if (!sawTableHeader && content.startsWith('Plugin') && content.includes('Missing services')) {
      sawTableHeader = true
      index += 1
      continue
    }
    const columns = /^(\S.*?)\s{2,}(.*)$/u.exec(content)
    if (columns === null) {
      // 切不出两列：**不猜**，也不当成一条。计数对不上会进 `gaps`。
      index += 1
      continue
    }
    const label = columns[1] ?? ''
    const required = label.endsWith(' (required)')
    const right = (columns[2] ?? '').trim()
    const missing =
      right === '' ? [] : right.split(',').map((name) => name.trim()).filter((name) => name !== '')
    out.push({
      id: required ? label.slice(0, -' (required)'.length) : label,
      required,
      missing: right === 'unknown' ? [] : missing,
      ...(right === 'unknown' ? { missingUnknown: true } : {}),
    })
    index += 1
  }
  return index
}

/**
 * 读 `[entries]: [` 块。
 *
 * 它有两个不可替代的价值：**只有它带 `module`（= 包名）**（等待表只有 id），
 * 以及它的 `[length]: N` 是可以用来自校验的断言。
 *
 * @param lines 全部行。
 * @param start 块体第一行的下标。
 * @param base 块标题（`[entries]: [`）的缩进。
 * @param out 收条目。
 * @returns 下一段开始的下标与块声明的条数。
 */
function readEntriesSection(
  lines: readonly string[],
  start: number,
  base: number,
  out: StartupEntry[],
): { next: number; length: number | undefined } {
  let index = start
  let current: StartupEntry | undefined
  let inOutcome = false
  let inMissing = false
  let length: number | undefined
  while (index < lines.length) {
    const line = lines[index] ?? ''
    const content = line.trim()
    const indent = indentOf(line)
    if (content === '') {
      index += 1
      continue
    }
    if (indent <= base) break
    if (indent === base + 2) {
      if (content === '{') {
        current = { id: '', required: false, kind: 'unknown', hasError: false }
        out.push(current)
        inOutcome = false
        inMissing = false
      } else if (content === '},' || content === '}') {
        current = undefined
        inOutcome = false
        inMissing = false
      } else {
        const declared = /^\[length\]: (\d+),?$/u.exec(content)
        if (declared !== null) length = Number(declared[1])
      }
      index += 1
      continue
    }
    if (inMissing) {
      if (current !== undefined) {
        current.missing = [...(current.missing ?? []), ...parseStringArray(content)]
      }
      if (content.includes(']')) inMissing = false
      index += 1
      continue
    }
    if (indent === base + 4) {
      const outcome = /^outcome: \{(.*)\}$/u.exec(content)
      if (outcome !== null) {
        applyOutcomeInline(current, outcome[1] ?? '')
        inOutcome = false
        index += 1
        continue
      }
      if (content === 'outcome: {') {
        inOutcome = true
        index += 1
        continue
      }
      if (!inOutcome && current !== undefined) {
        const id = /^id: (.*),$/u.exec(content)
        if (id !== null) {
          current.id = unquote(id[1] ?? '')
          index += 1
          continue
        }
        const module = /^module: (.*),$/u.exec(content)
        if (module !== null) {
          current.module = unquote(module[1] ?? '')
          index += 1
          continue
        }
        const required = /^required: (true|false),$/u.exec(content)
        if (required !== null) {
          current.required = required[1] === 'true'
          index += 1
          continue
        }
        const fiberState = /^fiberState: (.+),$/u.exec(content)
        if (fiberState !== null) {
          const value = Number(fiberState[1])
          if (Number.isFinite(value)) current.fiberState = value
          index += 1
          continue
        }
      }
      index += 1
      continue
    }
    if (inOutcome && current !== undefined) {
      const kind = /^kind: '(\w+)',$/u.exec(content)
      if (kind !== null) {
        current.kind = toEntryKind(kind[1] ?? '')
        index += 1
        continue
      }
      if (content === 'missing: [') {
        current.missing = []
        inMissing = true
        index += 1
        continue
      }
      const missing = /^missing: \[ (.*) \]$/u.exec(content)
      if (missing !== null) {
        current.missing = parseStringArray(missing[1] ?? '')
        index += 1
        continue
      }
      if (content.startsWith('error:')) {
        current.hasError = true
        index += 1
        continue
      }
    }
    index += 1
  }
  return { next: index, length }
}

/**
 * 读 `[startup]: {` 块（`configurationPath` 与组合期 `messages`）。
 *
 * 这个块**只进 `audit`**：活的那份组合期错由 `dsh_dump_config` 从**当前**组合树给出，
 * 而这里的是「上一次致命启动」的快照 —— 两份都进 `key` 会让模型在「哪个更新」上做无据判断。
 *
 * @param lines 全部行。
 * @param start 块体第一行的下标。
 * @param base 块标题的缩进。
 * @param report 收 `configurationPath` 与 `messages`。
 * @returns 下一段开始的下标与「见到 messages 段了没有」。
 */
function readStartupSection(
  lines: readonly string[],
  start: number,
  base: number,
  report: StartupLogReport,
): { next: number; sawMessages: boolean } {
  let index = start
  let sawMessages = false
  let inMessages = false
  let current: StartupMessage | undefined
  let inArgs = false
  while (index < lines.length) {
    const line = lines[index] ?? ''
    const content = line.trim()
    const indent = indentOf(line)
    if (content === '') {
      index += 1
      continue
    }
    if (indent <= base) break
    if (content.startsWith('configurationPath: ')) {
      report.configurationPath = unquote(content.slice('configurationPath: '.length).replace(/,$/u, ''))
      index += 1
      continue
    }
    if (content === 'messages: [') {
      sawMessages = true
      inMessages = true
      index += 1
      continue
    }
    if (!inMessages) {
      index += 1
      continue
    }
    if (indent === base + 2 && content === ']') {
      inMessages = false
      current = undefined
      index += 1
      continue
    }
    if (content === '{') {
      current = {}
      report.messages.push(current)
      inArgs = false
      index += 1
      continue
    }
    if (content === '},' || content === '}') {
      current = undefined
      inArgs = false
      index += 1
      continue
    }
    if (current !== undefined) {
      const name = /^name: (.*),$/u.exec(content)
      if (name !== null) {
        current.name = unquote(name[1] ?? '')
        index += 1
        continue
      }
      const type = /^type: (.*),$/u.exec(content)
      if (type !== null) {
        current.type = unquote(type[1] ?? '')
        index += 1
        continue
      }
      if (content === 'args: [') {
        inArgs = true
        index += 1
        continue
      }
      const inline = /^args: \[ (.*) \]$/u.exec(content)
      if (inline !== null) {
        const text = firstArgText(inline[1] ?? '')
        // 赋不到就不赋：挂一个值为 `undefined` 的自有属性会让整个工具返回值
        // 不是 lossless JSON，宿主直接拒收（见 HOST-CONTRACTS「tool 输出的 JSON 边界」）。
        if (text !== undefined) current.text = text
        inArgs = false
        index += 1
        continue
      }
      if (inArgs && current.text === undefined) {
        const text = firstArgText(content)
        if (text !== undefined) current.text = text
        index += 1
        continue
      }
    }
    index += 1
  }
  return { next: index, sawMessages }
}

/**
 * 取一个 `args` 元素的文本。
 *
 * 三种形态都出现过（真机那份里都有）：字符串，与 `Error` 对象。Error 取
 * `Error: ` 之后的第一行（`Error: HMR is disposed` → `HMR is disposed`）。
 *
 * **两种引号都必须认**：`util.inspect` 在字符串**含单引号但不含双引号**时改用双引号
 * （真机里 `workspace 'w' filtered session 's' …` 就是这一支）。只认单引号的那版会让
 * 这条消息**取不到文本** —— 而它在 `audit` 里，于是不是「少一条消息」，是整条挂着一个
 * 值为 `undefined` 的自有属性 ⇒ 宿主以「value is not lossless JSON」**拒收整个返回值**，
 * 工具直接不可用。
 *
 * @param content 已 trim 的行内容。
 */
function firstArgText(content: string): string | undefined {
  const text = content.replace(/,$/u, '').replace(/ \+$/u, '').trim()
  if (text.startsWith('Error: ')) return text.slice('Error: '.length).split('\n')[0]
  const single = /^'((?:[^'\\]|\\.)*)'/u.exec(text)
  if (single !== null) return unescapeInspect(single[1] ?? '').split('\n')[0]
  const double = /^"((?:[^"\\]|\\.)*)"/u.exec(text)
  if (double !== null) return unescapeInspect(double[1] ?? '').split('\n')[0]
  return undefined
}

/**
 * 解析单行 `outcome: { … }`。
 *
 * @param entry 当前条目。
 * @param body 花括号内的内容。
 */
function applyOutcomeInline(entry: StartupEntry | undefined, body: string): void {
  if (entry === undefined) return
  const kind = /kind: '(\w+)'/u.exec(body)
  if (kind !== null) entry.kind = toEntryKind(kind[1] ?? '')
  const missing = /missing: \[ (.*) \]/u.exec(body)
  if (missing !== null) entry.missing = parseStringArray(missing[1] ?? '')
  if (body.includes('error:')) entry.hasError = true
}

/**
 * `outcome.kind` → 本仓的闭集（宿主只推 `failed` / `pending`，别的一律 `unknown`）。
 *
 * @param raw 原始 kind。
 */
function toEntryKind(raw: string): StartupEntry['kind'] {
  if (raw === 'failed') return 'failed'
  if (raw === 'pending') return 'pending'
  return 'unknown'
}

/**
 * 解析 inspect 的字符串数组：`[ 'a', 'b', [length]: 2 ]`。
 *
 * `[length]:` 是伪字段，**不是元素** —— 只取带引号的项天然把它排除掉。
 *
 * @param body 中括号内的内容。
 */
function parseStringArray(body: string): string[] {
  const items: string[] = []
  const pattern = /'((?:[^'\\]|\\.)*)'/gu
  let match: RegExpExecArray | null
  while ((match = pattern.exec(body)) !== null) items.push(unescapeInspect(match[1] ?? ''))
  return items
}

/**
 * 剥掉 `Error: ` 前缀（剥不掉就原样）。
 *
 * **不要**断言首行必以 `Error: ` 开头：宿主在 `failureDetail` 里会拼上
 * `<phase>: ` 前缀（本机没有这种样本）。
 *
 * @param line 续行块首行。
 */
function stripErrorPrefix(line: string): string {
  return line.startsWith('Error: ') ? line.slice('Error: '.length) : line
}

/**
 * 把 header 字段写进报告（只认已知字段，别的一律不猜）。
 *
 * @param report 报告。
 * @param name 字段名。
 * @param value 已去引号的值。
 */
function assignHeader(report: StartupLogReport, name: string, value: string): void {
  if (name === 'timestamp') report.timestamp = value
  else if (name === 'dshVersion') report.dshVersion = value
  else if (name === 'nodeVersion') report.nodeVersion = value
  else if (name === 'platform') report.platform = value
  else if (name === 'arch') report.arch = value
  else if (name === 'profile') report.profile = value
}

/**
 * 段名去重地记一笔（`sections` 的语义是「认出了哪些段」）。
 *
 * @param sections 已认出的段。
 * @param section 段名。
 */
function pushSection(sections: StartupLogSection[], section: StartupLogSection): void {
  if (!sections.includes(section)) sections.push(section)
}

/**
 * 一行的缩进宽度。
 *
 * @param line 原始行。
 */
function indentOf(line: string): number {
  const match = /^ */u.exec(line)
  return match === null ? 0 : match[0].length
}

/**
 * 去掉 `util.inspect` 的字符串引号与转义。
 *
 * @param raw 原始片段（可能带首尾引号）。
 */
function unquote(raw: string): string {
  const text = raw.trim()
  if (text.length < 2 || !text.startsWith("'") || !text.endsWith("'")) return text
  return unescapeInspect(text.slice(1, -1))
}

/**
 * 反转 `util.inspect` 的字符串转义（`\n` / `\t` / `\\` / `\'`）。
 *
 * @param body 已去引号的字符串体。
 */
function unescapeInspect(body: string): string {
  let out = ''
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] ?? ''
    if (char !== '\\') {
      out += char
      continue
    }
    const next = body[index + 1]
    index += 1
    if (next === undefined) out += '\\'
    else if (next === 'n') out += '\n'
    else if (next === 't') out += '\t'
    else if (next === 'r') out += '\r'
    else out += next
  }
  return out
}
