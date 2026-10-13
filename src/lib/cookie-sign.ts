/**
 * browser-session cookie 的**自签**（W4）。
 *
 * ## 为什么它能成立
 *
 * 宿主验证 cookie 只依赖两样东西：**`.credentials.yaml` 里那份持久签名密钥**，与
 * **authority（`host:port`）**。launch token 只是首次进入的敲门砖，不参与验证
 * （SKILL §3.4）。所以拿到密钥就能自己签 —— 这正是 `dsh_sign_cookie` 的全部依据。
 *
 * ## 算法照抄宿主，不自创（`0.2.1-alpha.2`，`dsh-client-connection/lib/index.js`）
 *
 * | 步 | 宿主出处 |
 * |---|---|
 * | 密钥 = `records` 段合体键 `client-connection/browser-session` → `payload.secret` | `:13-21`（`storedSecret`） |
 * | cookie 名 = `dsh-auth-` + `base64url(sha256(authority))` | `cookieName:329-331` |
 * | payload = `{version:1, authority, issuedAt, expiresAt}` | `encodeCookie` 的调用点 `:447-452` |
 * | 值 = `v1.<base64url(JSON)>.` + `base64url(HMAC-SHA256(secret, body))` | `encodeCookie:348-351` |
 *
 * `base64url` = 标准 base64 换 `+/` 为 `-_` 并去尾部 `=`（`encodeBase64Url:279-281`）。
 *
 * ## 一条被实测钉住的反直觉点：authority 取自**连接地址**，不是请求头
 *
 * 宿主算 audience 的那条路（`requestAudience:301-310`）读的是 **`Host` 请求头**。
 * 而 `fetch`（undici）**静默忽略显式设置的 `Host` 头**，所以走 `fetch` 时它由
 * TCP 目标决定。实测（2026-10-13，本机 `0.2.1-alpha.2` + 127.0.0.1:3080）：用
 * `node:http` 显式发 `Host: localhost:3080` 拿到 **401**，而 authority 仍按
 * `127.0.0.1:3080` 算 —— 与 cookie 不匹配。
 * ⇒ **cookie 的 authority 必须与实际连的地址逐字一致**，改 `Host` 头改不动它。
 *
 * ## 为什么密钥绝不进返回值
 *
 * 这个函数产出的是**凭证**。工具层只把「有没有签出来」「绑在哪个 authority」放进
 * `key`，cookie 本体走 `presentationMeta` 那条人通道 —— 但**本仓今天还没接那条**，
 * 所以工具**只报签发成功与否**，cookie 由调用方自己持有。见 `dsh_sign_cookie.ts`。
 */
import { createHash, createHmac } from 'node:crypto'

/** 记录所在的顶层段名。 */
const RECORDS_KEY = 'records'
/** 合体键本体：一个键，不是两层（见 `lib/credentials.ts` 的形状说明）。 */
const BROWSER_SESSION_KEY = 'client-connection/browser-session'
/** 宿主写死的 secret 长度（`SECRET_BYTES`，`dsh-client-connection/lib/index.js:269`）。 */
const SECRET_BYTES = 32
/** cookie payload 版本（`COOKIE_PAYLOAD_VERSION`，`:272`）。 */
const PAYLOAD_VERSION = 1
/** cookie 名的固定前缀（`COOKIE_PREFIX`，`:271`）。 */
const COOKIE_PREFIX = 'dsh-auth-'
/** 宿主默认 cookie 寿命（天）。`cookieMaxAgeDays` 的默认值 30（SKILL §3.3 已实测）。 */
export const DEFAULT_COOKIE_MAX_AGE_DAYS = 30
const DAY_MILLISECONDS = 1440 * 60 * 1e3

/** 取密钥失败的原因（闭集，便于工具分叉出不同的下一步）。 */
export type SecretProblem = 'missing' | 'malformed'

/** 从 `.credentials.yaml` 文本里取出 browser-session 的签名密钥。 */
export interface ExtractedSecret {
  /** 解码后的密钥字节（**敏感**：绝不进日志、绝不进模型可见文本）。 */
  secret: Buffer
}

/** base64url 编码（宿主 `encodeBase64Url` 的同构实现）。 */
export function encodeBase64Url(value: Buffer | string): string {
  return Buffer.from(value)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

/** base64url 解码；非法输入返回 `undefined`（宿主的 `decodeBase64Url:282-287` 加一道重编码自检）。 */
export function decodeBase64Url(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]*$/u.test(value) || value.length % 4 === 1) return undefined
  const padding = '='.repeat((4 - (value.length % 4)) % 4)
  const decoded = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
  // 重编码自检：挡住「看起来像 base64url 但不是」的串。
  return encodeBase64Url(decoded) === value ? decoded : undefined
}

/**
 * 从凭证文件文本里取 `client-connection/browser-session` 的 `payload.secret`。
 *
 * **只认真实形状**：顶层 `records:` 段下的**合体键**一行，往下到 `secret:`。
 * 嵌套两层（顶层 `client-connection:` 再往下）在宿主 `parseCredentialsDocument`
 * 那里会被**直接拒绝**，所以那种形状不存在 —— 判它「缺失」是对的（见 `lib/credentials.ts`）。
 *
 * @param text `.credentials.yaml` 全文。
 * @returns 密钥字节；取不到时给出**原因**而不是抛。
 */
export function extractBrowserSessionSecret(
  text: string,
): { ok: true; value: ExtractedSecret } | { ok: false; problem: SecretProblem } {
  const lines = text.split(/\r?\n/u)
  let recordsIndent: number | undefined
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? ''
    const trimmed = raw.trim()
    // 注释与空行不参与层级判断。
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const indent = raw.length - raw.trimStart().length
    if (indent === 0) {
      recordsIndent = trimmed.startsWith(`${RECORDS_KEY}:`) ? indent : undefined
      continue
    }
    if (recordsIndent === undefined || indent <= recordsIndent) continue
    if (trimmed !== `${BROWSER_SESSION_KEY}:`) continue

    const raw_secret = readPayloadSecret(lines, index + 1, indent)
    if (raw_secret === undefined) return { ok: false, problem: 'malformed' }
    const decoded = decodeBase64Url(raw_secret)
    if (decoded === undefined || decoded.byteLength !== SECRET_BYTES) {
      return { ok: false, problem: 'malformed' }
    }
    return { ok: true, value: { secret: decoded } }
  }
  return { ok: false, problem: 'missing' }
}

/**
 * 从合体键那一行往下读到 `payload.secret`。
 *
 * @param lines 全文行数组。
 * @param from  起始行下标（合体键的下一行）。
 * @param ownerIndent 合体键的缩进；遇到缩进不大于它的行就停。
 */
function readPayloadSecret(lines: string[], from: number, ownerIndent: number): string | undefined {
  for (let index = from; index < lines.length; index += 1) {
    const raw = lines[index] ?? ''
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const indent = raw.length - raw.trimStart().length
    // 退出这条记录（下一个同级或更外层的键）。
    if (indent <= ownerIndent) return undefined
    const match = /^secret:\s*(.+)$/u.exec(trimmed)
    if (match !== null && indent > ownerIndent) {
      const value = (match[1] ?? '').trim()
      return value === '' ? undefined : value
    }
  }
  return undefined
}

/** cookie 的 payload（宿主 `decodeCookie:368` 校验的就是这四个字段）。 */
export interface CookiePayload {
  version: typeof PAYLOAD_VERSION
  authority: string
  issuedAt: number
  expiresAt: number
}

/**
 * cookie 名：`dsh-auth-` + `base64url(sha256(authority))`。
 *
 * @param authority `host:port`，必须与实际连的地址**逐字**一致。
 */
export function cookieName(authority: string): string {
  return COOKIE_PREFIX + encodeBase64Url(createHash('sha256').update(authority).digest())
}

/**
 * 签一个 cookie 值。
 *
 * @param secret 密钥字节。
 * @param payload cookie 载荷。
 */
export function encodeCookie(secret: Buffer, payload: CookiePayload): string {
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'))
  const signature = createHmac('sha256', secret).update(body).digest()
  return `v1.${body}.${encodeBase64Url(signature)}`
}

/**
 * 一步签发：名 + 值 + 载荷。
 *
 * @param secret 密钥字节。
 * @param authority `host:port`，逐字匹配。
 * @param issuedAt 签发时刻（ms）；测试可注入。
 * @param maxAgeDays 寿命（天）；必须是正安全整数。
 */
export function signCookie(
  secret: Buffer,
  authority: string,
  issuedAt: number,
  maxAgeDays: number = DEFAULT_COOKIE_MAX_AGE_DAYS,
): { name: string; value: string; payload: CookiePayload } {
  const maxAgeMilliseconds = maxAgeDays * DAY_MILLISECONDS
  const payload: CookiePayload = {
    version: PAYLOAD_VERSION,
    authority,
    issuedAt,
    expiresAt: issuedAt + maxAgeMilliseconds,
  }
  return { name: cookieName(authority), value: encodeCookie(secret, payload), payload }
}

/**
 * 拼出可以直接贴进 `Cookie:` 头的那一段。
 *
 * @param name cookie 名。
 * @param value cookie 值。
 */
export function cookieHeader(name: string, value: string): string {
  return `${name}=${value}`
}

/**
 * host 侧完整 `Set-Cookie` 属性的复刻（`sessionCookie:341-344`）。
 *
 * 只在**人工把 cookie 塞进浏览器**时需要 —— 那个场景要有 Max-Age / Expires 才不会被
 * 当成会话 cookie 立刻丢掉。给 `Cookie:` 头用时**不要**带这些属性。
 *
 * @param name cookie 名。
 * @param value cookie 值。
 * @param payload 载荷（取 `expiresAt` 算 `Expires`）。
 * @param secure 监听是否用 TLS；`true` 时追加 `Secure`（宿主按**该监听自己的协议**决定，
 *   不看 `publicUrl` 也不看转发头 —— `:432-435`）。
 */
export function setCookieAttribute(
  name: string,
  value: string,
  payload: CookiePayload,
  secure: boolean,
): string {
  const maxAgeSeconds = Math.floor((payload.expiresAt - payload.issuedAt) / 1e3)
  const base = `${name}=${value}; Max-Age=${String(maxAgeSeconds)}; Path=/; Expires=${new Date(
    payload.expiresAt,
  ).toUTCString()}; HttpOnly; SameSite=Strict`
  return secure ? `${base}; Secure` : base
}
