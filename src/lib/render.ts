/**
 * 工具结果的模型可见渲染（SHAPE §3.1 冻结）。
 *
 * `output.render` 的返回值就是**模型读到的东西**。新契约下模型看到的只有三段：
 *
 * ```
 * [dsh_x] ok                              ← 或：[dsh_x] failed (<kind>)
 * verdict: <data.verdict 逐字>
 * <L2 第一行，来自 table.key(data)>
 * nextStep: <tool>(<args JSON>) — <why>   ← 或（manual 支）：nextStep: <why>
 * ```
 *
 * 为什么不再整块打印 JSON：诊断输出可能很大（实测 `--dump-config-schema` 有 3.2 万行），
 * 而**最需要证据的那次（插件被整条丢弃）恰是最可能被截断的那次**。所以模型需要细节时走
 * **路径**（L2 给出日志路径 / 目录），它自己有读文件的工具。
 *
 * 三条纪律（都在 §3.1 里，这里只留指针）：
 * - `audit` **不进**这段文本（B22 用哨兵断言）—— 渲染只读 `data.verdict` 与 `table.key(data)`。
 * - L3 只在 `nextStep` 存在时出现；`manual` 支不印 `—`、不印空括号。
 * - 截断要**明说并给总数**（官方的 `truncated` + `total` 判例）。
 */
import type { NextStep, ToolData, ToolResult } from './errors.js'
import { toolResultProblem } from './errors.js'

/** 模型可见的一段文本；形状与宿主的 `TextBlock` 一致（避免多引一个包）。 */
export interface TextBlockLike {
  type: 'text'
  text: string
}

/** L2 的默认行数上限。 */
export const DEFAULT_MAX_KEY_LINES = 15

/**
 * 一个工具声明的输出表：**L2 从哪来**。
 *
 * L1 不在这张表里 —— 它就是 `data.verdict` 逐字（SHAPE §4.1 把 L1 定为必填）。
 * 为什么不在表里再放一个 `verdict(data)` 生成器：那是「L1 有两个家」，而且
 * `ensureToolResult` 合成的兜底失败**没有专属输出表**，多一个生成器那条路径就印不出判定行。
 *
 * `key` 返回的行**顺序即输出顺序**，只放本次非默认、且下一个决定可能要用到的。
 * 返回值里非字符串 / 空串的条目会被丢掉（渲染不抛，永远有输出）。
 */
export interface RenderTable<T> {
  /** L2：逐行文本，顺序即输出顺序。 */
  key(data: ToolData<T>): readonly string[]
  /** L2 的行数上限；超出时截断并**明说**还剩几条。默认 15。 */
  maxKeyLines?: number
}

/** 渲染成宿主要的 `TextBlock[]`。 */
export function renderToolResult<T>(
  toolName: string,
  value: unknown,
  table: RenderTable<T>,
): TextBlockLike[] {
  return [{ type: 'text', text: renderToolResultText(toolName, value, table) }]
}

/**
 * 渲染成文本（便于直接断言）。
 *
 * @param toolName 工具名（放在首行，便于模型在长对话里认出这段属于谁）。
 * @param value 工具的规范返回值。
 * @param table 该工具的输出表（L2 的投影函数）。
 */
export function renderToolResultText<T>(
  toolName: string,
  value: unknown,
  table: RenderTable<T>,
): string {
  // 规则 4：形状不合法的值退化成**一行**（保持「永远有输出」）。
  // 用与 `ensureToolResult` 同一个判据 —— 两处必须同意同一套规则。
  if (toolResultProblem(value) !== undefined) return `[${toolName}] ${compactJson(value)}`

  const result = value as ToolResult<unknown>
  const data = result.data as ToolData<T>
  const lines = [
    `[${toolName}] ${result.ok ? 'ok' : `failed (${result.error.kind})`}`,
    // L1 逐字来自 data.verdict（校验已保证它非空）。
    `verdict: ${data.verdict}`,
  ]
  lines.push(...truncateKeyLines(keyLines(data, table), keyCap(table)))
  const step = nextStepLine(result.nextStep)
  if (step !== '') lines.push(step)
  return lines.join('\n')
}

/**
 * 取 L2 的行（丢掉非字符串与空串）。
 *
 * @param data 三层记录。
 * @param table 输出表。
 */
function keyLines<T>(data: ToolData<T>, table: RenderTable<T>): string[] {
  const raw: unknown = table.key(data)
  if (!Array.isArray(raw)) return []
  return raw.filter((line): line is string => typeof line === 'string' && line !== '')
}

/**
 * 定 L2 的行数上限。
 *
 * @param table 输出表。
 */
function keyCap<T>(table: RenderTable<T>): number {
  const declared = table.maxKeyLines
  if (declared === undefined) return DEFAULT_MAX_KEY_LINES
  return Number.isSafeInteger(declared) && declared > 0 ? declared : DEFAULT_MAX_KEY_LINES
}

/**
 * 截断 L2，并**明说**被截断、还剩几条（官方 `truncated` + `total` 判例）。
 *
 * 函数名保持 `truncate…` 前缀是有意的：红线 B10 用「本仓 `render.ts` 里的本地 `truncate`
 * 不是 `node:fs` 的 `truncate`」自证它按 import 来源判定、不误报同名本地助手。
 *
 * @param lines L2 全文。
 * @param max 行数上限（已归一化为正整数）。
 */
function truncateKeyLines(lines: readonly string[], max: number): string[] {
  if (lines.length <= max) return [...lines]
  const hidden = lines.length - max
  return [
    ...lines.slice(0, max),
    `${String(hidden)} more line(s) not shown — the full record is in the session log`,
  ]
}

/**
 * 拼 nextStep 那一行（两支的逐字形状）。
 *
 * @param nextStep 下一步建议。
 */
function nextStepLine(nextStep: NextStep | undefined): string {
  if (nextStep === undefined) return ''
  // manual 支：只有 why —— 不印 `—`、不印空括号（旧形状 `nextStep: — <why>` 的空指代必须消失）。
  // 用 `in` 收窄（直接读 `.manual` 在联合类型上不可见）。
  if ('manual' in nextStep) return `nextStep: ${nextStep.why}`
  const args = nextStep.args === undefined ? '' : compactJson(nextStep.args)
  return `nextStep: ${nextStep.tool}(${args}) — ${nextStep.why}`
}

/**
 * 单行 JSON（形状不合法时的那一行用；JSON 转义保证它不含换行）。
 *
 * @param value 任意值。
 */
function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
