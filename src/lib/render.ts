/**
 * 工具结果的模型可见渲染。
 *
 * `output.render` 的返回值就是**模型读到的东西**，所以这里必须把结构化的
 * `ok` / `data` / `error` / `nextStep` 全部摊成文字 —— 只丢一个 JSON 串会让模型
 * 看不出哪一段是结论、哪一段是建议。
 *
 * 长度上限是有意的：诊断输出可能整篇很大（实测 `--dump-config-schema` 有 3.2 万行）。
 * 让它整个进上下文既贵又没用，截断并**明说被截断**比默默塞满更好。
 */
import type { NextStep, ToolResult } from './errors.js'

/** 模型可见的一段文本；形状与宿主的 `TextBlock` 一致（避免多引一个包）。 */
export interface TextBlockLike {
  type: 'text'
  text: string
}

/** 渲染文本的长度上限（字符）。 */
export const RENDER_MAX_CHARS = 6_000

/** 可选的「一句话结论」：由各工具提供，把最重要的判定提到首行。 */
export type ResultSummary = (data: unknown) => string | undefined

/**
 * 渲染一个工具结果。
 *
 * @param toolName 工具名（放在首行，便于模型在长对话里认出这段属于谁）。
 * @param value 工具的规范返回值。
 * @param summarize 可选的一句话结论；只在成功时用。
 */
export function renderToolResult(
  toolName: string,
  value: unknown,
  summarize?: ResultSummary,
): TextBlockLike[] {
  return [{ type: 'text', text: renderToolResultText(toolName, value, summarize) }]
}

/**
 * 渲染成文本（便于直接断言）。
 *
 * @param toolName 工具名。
 * @param value 工具的规范返回值。
 * @param summarize 可选的一句话结论；只在成功时用。
 */
export function renderToolResultText(
  toolName: string,
  value: unknown,
  summarize?: ResultSummary,
): string {
  const result = asToolResult(value)
  if (result === undefined) {
    return truncate(`[${toolName}]\n${stableJson(value)}`)
  }
  if (result.ok) {
    // 结论前置：结构化 `data` 是**原始记录**，模型第一眼要的是判定本身
    // —— 尤其当 data 里带着长证据（如 hmr 探测的 evidence 行）时。
    const summary = summarize?.(result.data)
    return truncate(
      [
        `[${toolName}] ok`,
        summary ?? '',
        stableJson(result.data),
        nextStepLine(result.nextStep),
      ]
        .filter((part) => part !== '')
        .join('\n'),
    )
  }
  return truncate(
    [
      `[${toolName}] failed (${result.error.kind})`,
      result.error.message,
      `hint: ${result.error.hint}`,
      nextStepLine(result.nextStep),
    ]
      .filter((part) => part !== '')
      .join('\n'),
  )
}

/**
 * 拼 nextStep 那一行。
 *
 * @param nextStep 下一步建议。
 */
function nextStepLine(nextStep: NextStep | undefined): string {
  if (nextStep === undefined) return ''
  const call =
    nextStep.tool === undefined
      ? ''
      : ` ${nextStep.tool}(${nextStep.args === undefined ? '' : JSON.stringify(nextStep.args)})`
  return `nextStep:${call} — ${nextStep.why}`
}

/**
 * 尽力把值看成工具结果。
 *
 * @param value 任意值。
 */
function asToolResult(value: unknown): ToolResult<unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record['ok'] === true) return value as ToolResult<unknown>
  if (record['ok'] === false) return value as ToolResult<unknown>
  return undefined
}

/**
 * 稳定缩进的 JSON（键序按插入序，够用且可读）。
 *
 * @param value 任意 JSON 值。
 */
function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * 截断到上限，并**明说**被截断。
 *
 * @param text 原文。
 */
function truncate(text: string): string {
  if (text.length <= RENDER_MAX_CHARS) return text
  return `${text.slice(0, RENDER_MAX_CHARS)}\n… (output truncated; see the structured data field for the full value)`
}
