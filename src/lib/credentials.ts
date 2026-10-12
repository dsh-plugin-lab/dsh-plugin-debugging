/**
 * `.credentials.yaml` 的**存在性**扫描。
 *
 * v1 刻意只做一件事：判 `client-connection/browser-session` 条目**在不在**。
 * **不提取密钥、不解析完整 YAML、不自签 cookie** —— 那是 v1.1（决策 D4/D5）。
 *
 * 为什么连 YAML 解析都不做：本仓零运行时依赖，而为了判「某个键在不在」引入一个
 * YAML 库（或手写一个不完整的解析器）都不划算。这里只需要**缩进层级**这一个信息，
 * 用不到 YAML 的其它语义。
 *
 * 安全约束：本函数的返回值里**只有布尔与行号**，任何值（哪怕它不含密钥）都不会被带出去。
 */
import { readTextIfExists } from './profile.js'

/** 凭证文件的存在性报告。 */
export interface CredentialsPresence {
  /** 被扫描的文件路径（绝对路径）。 */
  file: string
  /** 文件是否存在。 */
  exists: boolean
  /** 顶层是否有 `client-connection:` 段。 */
  clientConnectionPresent: boolean
  /** `client-connection` 段内是否有 `browser-session:` 条目。 */
  browserSessionPresent: boolean
  /** `browser-session` 所在行号（1 起）；只在存在时有值。**不是**它的内容。 */
  line?: number
}

/** `client-connection` 段名。 */
const CLIENT_CONNECTION_KEY = 'client-connection'
/** 段内条目名。 */
const BROWSER_SESSION_KEY = 'browser-session'

/**
 * 扫描凭证文件，判两个键在不在。
 *
 * @param file 凭证文件路径。
 */
export async function readCredentialsPresence(file: string): Promise<CredentialsPresence> {
  const text = await readTextIfExists(file)
  if (text === undefined) {
    return { file, exists: false, clientConnectionPresent: false, browserSessionPresent: false }
  }

  let clientConnectionPresent = false
  let clientConnectionIndent: number | undefined
  let browserSessionPresent = false
  let line: number | undefined

  const lines = text.split(/\r?\n/u)
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? ''
    const trimmed = raw.trim()
    // 注释与空行不参与层级判断：`# client-connection:` 不是段。
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const indent = raw.length - raw.trimStart().length
    const key = keyOf(trimmed)
    if (key === undefined) continue

    if (indent === 0) {
      clientConnectionPresent ||= key === CLIENT_CONNECTION_KEY
      clientConnectionIndent = key === CLIENT_CONNECTION_KEY ? indent : undefined
      continue
    }
    // 只在 `client-connection` 段**之内**认 `browser-session`。
    if (clientConnectionIndent !== undefined && indent > clientConnectionIndent && key === BROWSER_SESSION_KEY) {
      browserSessionPresent = true
      line = index + 1
      break
    }
  }

  return {
    file,
    exists: true,
    clientConnectionPresent,
    browserSessionPresent,
    ...(line === undefined ? {} : { line }),
  }
}

/**
 * 取一行 `key:` 的键名；不是「键行」时返回 `undefined`。
 *
 * 只认「键 + 冒号」这一种形状（`browser-session:` / `browser-session: {…}`），
 * 遇到列表项（`- `）与嵌套值行都不算键行。
 *
 * @param trimmed 去掉首尾空白的一行。
 */
function keyOf(trimmed: string): string | undefined {
  if (trimmed.startsWith('- ')) return undefined
  const match = /^([A-Za-z0-9_.-]+)\s*:/u.exec(trimmed)
  return match?.[1]
}
