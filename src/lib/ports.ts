/**
 * 进程识别 —— **按端口**查，不用命令行子串。
 *
 * 为什么这是硬规矩（SKILL §3.5）：用 `*bin.js*` 之类的命令行子串过滤会**误匹配派生 shell**
 * （宿主为每个终端派生一个字进程，它的命令行里带着父进程的脚本路径），
 * 于是「找到多个宿主进程」这种假象会让你去杀错东西。按端口查监听者没有这个问题。
 */
import type { SpawnImpl } from './exec.js'

/** 一个监听者。 */
export interface PortListener {
  pid: number
  processName: string
  /** 进程启动时间（ISO 8601）；读不到（权限不足等）时为 `undefined`。 */
  startedAt?: string
}

/** 按端口查询的结果。 */
export interface PortLookupResult {
  port: number
  /** 端口上是否有监听者。 */
  listening: boolean
  listeners: PortListener[]
  /**
   * 探测本身是否**跑成功**。
   *
   * `false` 表示「没查到」不是「没有」—— 非 Windows、或缺 PowerShell 时是这种。
   * 这个区分很重要：把「查不了」当成「没启动」会让工具给出反向结论。
   */
  probed: boolean
  /** 一句可读说明。 */
  detail: string
}

/** 查监听端口用的 shell。本机是 Windows，用系统自带的 Windows PowerShell。 */
export const PORT_LOOKUP_SHELL = 'powershell.exe'

/**
 * 造查询脚本。
 *
 * 输出每行 `pid|processName|startedAt`，让一次进程调用拿全所需字段 ——
 * 分多次调用既慢，又会在两次调用之间让「进程表变了」成为可能。
 *
 * @param port 目标端口。
 */
export function portLookupScript(port: number): string {
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    `$pids=@(Get-NetTCPConnection -LocalPort ${String(port)} -State Listen | Select-Object -ExpandProperty OwningProcess -Unique)`,
    'foreach($p in $pids){',
    '$proc=Get-Process -Id $p',
    "$started=''",
    "try{ $started=$proc.StartTime.ToString('o') }catch{}",
    `Write-Output ("{0}|{1}|{2}" -f $p,$proc.ProcessName,$started)`,
    '}',
  ].join('; ')
}

/**
 * 解析脚本输出。
 *
 * @param stdout 脚本的标准输出。
 */
export function parsePortLookup(stdout: string): PortListener[] {
  const listeners: PortListener[] = []
  for (const rawLine of stdout.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (line === '') continue
    const [pidText, processName = '', startedAt = ''] = line.split('|')
    const pid = Number.parseInt(pidText ?? '', 10)
    if (!Number.isSafeInteger(pid) || pid <= 0) continue
    listeners.push({
      pid,
      processName: processName === '' ? '(unknown)' : processName,
      ...(startedAt === '' ? {} : { startedAt }),
    })
  }
  return listeners
}

/**
 * 查一个端口上的监听者。
 *
 * **不抛**：探测失败收敛成 `probed: false`。
 *
 * @param port 目标端口。
 * @param deps 可注入的 spawn 与预算。
 */
export async function lookupPort(
  port: number,
  deps: { spawn: SpawnImpl; timeoutMs: number; signal?: AbortSignal | undefined },
): Promise<PortLookupResult> {
  if (process.platform !== 'win32') {
    return {
      port,
      listening: false,
      listeners: [],
      probed: false,
      detail: `v1 only looks up listeners on Windows (current platform: ${process.platform})`,
    }
  }

  const result = await deps.spawn({
    command: PORT_LOOKUP_SHELL,
    args: ['-NoProfile', '-NonInteractive', '-Command', portLookupScript(port)],
    timeoutMs: deps.timeoutMs,
    signal: deps.signal,
  })

  if (result.spawnError !== undefined) {
    return { port, listening: false, listeners: [], probed: false, detail: result.spawnError }
  }
  if (result.aborted) {
    return { port, listening: false, listeners: [], probed: false, detail: 'the caller cancelled the port lookup' }
  }
  if (result.timedOut) {
    return { port, listening: false, listeners: [], probed: false, detail: 'the port lookup timed out' }
  }

  const listeners = parsePortLookup(result.stdout)
  return {
    port,
    listening: listeners.length > 0,
    listeners,
    probed: true,
    detail:
      listeners.length > 0
        ? `${String(listeners.length)} listener(s) on port ${String(port)}`
        : `no listener on port ${String(port)}`,
  }
}
