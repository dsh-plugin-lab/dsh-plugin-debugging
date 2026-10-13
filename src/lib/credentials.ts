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
 * ## 真实形状是**合体键**，不是嵌套两层
 *
 * 本机实测（`$DSH_HOME/.credentials.yaml`）与宿主源码（`dsh-credentials-local`）都指向同一件事：
 * 记录住在顶层 `records:` 段里，键就是 `<scope>/<id>` 本身，例如
 * `client-connection/browser-session`；写入侧是 `document.setIn(["records", key], record)`，
 * 而 `parseCredentialsDocument()` 只接受顶层 `version` / `refs` / `records` 三个键
 * —— 顶层 `client-connection:` 会被它**直接拒绝**，所以「嵌套两层」的形状在这个版本不可能存在。
 * 判据必须是**合体键**；把嵌套当形状会一直判「不存在」（静默坏，缺 C）。
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
  /** `records:` 段里有没有 `client-connection/<id>` 条目（合体键的段名部分）。 */
  clientConnectionPresent: boolean
  /** `records:` 段里有没有 `client-connection/browser-session` 这一条。 */
  browserSessionPresent: boolean
  /** `browser-session` 所在行号（1 起）；只在存在时有值。**不是**它的内容。 */
  line?: number
}

/** 记录所在的顶层段名（真实形状里唯一的家）。 */
const RECORDS_KEY = 'records'
/** `client-connection` 段名（合体键的斜杠前半段）。 */
const CLIENT_CONNECTION_SCOPE = 'client-connection'
/** 合体键本体：**一个键**，不是两层。 */
const BROWSER_SESSION_KEY = 'client-connection/browser-session'

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

  let recordsIndent: number | undefined
  let clientConnectionPresent = false
  let browserSessionPresent = false
  let line: number | undefined

  const lines = text.split(/\r?\n/u)
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? ''
    const trimmed = raw.trim()
    // 注释与空行不参与层级判断：`# records:` 不是段。
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const indent = raw.length - raw.trimStart().length
    const key = keyOf(trimmed)
    if (key === undefined) continue

    if (indent === 0) {
      // 顶层只认段名；合体键在顶层出现不属于任何段（`refs:` 段里的同名键也不算条目）。
      recordsIndent = key === RECORDS_KEY ? indent : undefined
      continue
    }
    if (recordsIndent === undefined || indent <= recordsIndent) continue
    if (key === BROWSER_SESSION_KEY) {
      clientConnectionPresent = true
      browserSessionPresent = true
      line = index + 1
      break
    }
    if (key.startsWith(`${CLIENT_CONNECTION_SCOPE}/`)) clientConnectionPresent = true
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
 * 一段凭证键（宿主的 `KEY_SEGMENT_PATTERN`）：小写字母开头，只含小写字母 / 数字 / 连字符。
 */
const KEY_SEGMENT = '[a-z][a-z0-9-]*'

/**
 * 一行 `key:` 的键名判定。
 *
 * 认两种形状：
 * - 普通段名（`records:` / `refs:` 这类）；
 * - **合体键** `<scope>/<id>`（真实文件里 `client-connection/browser-session:` 就是这种）。
 *
 * **最多一个 `/`**：宿主的 `parseCredentialKey` 只认两段（`segments.length !== 2` 直接抛），
 * 所以 `a/b/c:` 不是合法条目，不该被算进来。
 */
const KEY_LINE = new RegExp(`^([A-Za-z0-9_.-]+|${KEY_SEGMENT}/${KEY_SEGMENT})\\s*:`, 'u')

/**
 * 取一行 `key:` 的键名；不是「键行」时返回 `undefined`。
 *
 * 遇到列表项（`- `）不算键行 —— 列表里的 `- client-connection/browser-session:` 不是条目。
 *
 * @param trimmed 去掉首尾空白的一行。
 */
function keyOf(trimmed: string): string | undefined {
  if (trimmed.startsWith('- ')) return undefined
  const match = KEY_LINE.exec(trimmed)
  return match?.[1]
}
