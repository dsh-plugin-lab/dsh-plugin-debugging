/**
 * 进程识别 —— **按端口**查，不用命令行子串。
 *
 * 为什么这是硬规矩（SKILL §3.5）：用 `*bin.js*` 之类的命令行子串过滤会**误匹配派生 shell**
 * （宿主为每个终端派生一个字进程，它的命令行里带着父进程的脚本路径），
 * 于是「找到多个宿主进程」这种假象会让你去杀错东西。按端口查监听者没有这个问题。
 *
 * ## 三个平台、三张 socket 表
 *
 * | 平台 | 命令 | 行形状 |
 * |---|---|---|
 * | win32 | `powershell.exe` + `Get-NetTCPConnection` | 自造 `pid\|name\|startedAt` |
 * | linux | `ss -ltnp`，兜底 `ss -ltn` | `State … Local Address:Port … users:(("node",pid=N,fd=M))` |
 * | darwin | `lsof -nP -iTCP:<port> -sTCP:LISTEN`，兜底 `netstat -an` | `COMMAND PID … TCP addr:port (LISTEN)` / `tcp4 0 0 127.0.0.1.3080 *.* LISTEN` |
 *
 * **一条纪律贯穿三条分支：不按列号取值，按「值」取值。**
 * `ss` 的列会随版本加（`-e` 会多出几列）、`lsof` 的最后一列本身含空格
 * （`TCP 127.0.0.1:3080 (LISTEN)`），所以两个解析器都**先认出这一行属于哪个端口的行**，
 * 再从整行里正则取 pid —— 写死 `fields[3]` 那种写法在版本一变就静默读错列。
 */
import type { CommandResult, SpawnImpl } from './exec.js'

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
   * `false` 表示「没查到」不是「没有」—— 命令没装、形状认不出、缺 PowerShell 时是这种。
   * 这个区分很重要：把「查不了」当成「没启动」会让工具给出反向结论。
   */
  probed: boolean
  /**
   * 一句可读说明。
   *
   * **`probed: false` 时一律以平台标识开头**（`win32:` / `linux:` / `darwin:`）。
   * 那是这份说明里**唯一稳定不变**的部分 —— 判据认它，不认后面那句文案
   * （文案会随实现改，认文案就等于让判据跟着实现漂）。
   */
  detail: string
}

/** 查监听端口用的 shell。**仅 Windows 分支用**；别的平台见 {@link portLookupPlan}。 */
export const PORT_LOOKUP_SHELL = 'powershell.exe'

/** Linux 分支的主命令。 */
export const LINUX_LOOKUP_COMMAND = 'ss'
/** darwin 分支的主命令。 */
export const DARWIN_LOOKUP_COMMAND = 'lsof'
/** darwin 分支的兜底命令（不带进程信息）。 */
export const DARWIN_FALLBACK_COMMAND = 'netstat'
/**
 * win32 分支的兜底命令（`netstat -ano`）。
 *
 * 与 {@link DARWIN_FALLBACK_COMMAND} 是**同一个可执行文件**、不同参数与不同输出形状：
 * Windows 上 `Get-NetTCPConnection` 依赖 `NetTCPIP` 这个 PowerShell 模块，精简系统 /
 * Server Core / 某些容器镜像上它压根不在 —— 而 `netstat.exe` 一直都在。
 */
export const WINDOWS_FALLBACK_COMMAND = 'netstat'

/**
 * 造查询脚本（**仅 Windows 分支**）。
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
 * 解析脚本输出（**仅 Windows 分支**）。
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

/** 一张 socket 表的解析结果。 */
export interface ParsedSocketTable {
  /** 解析出 pid 与进程名的监听者（按首次出现的顺序，同 pid 只留一条）。 */
  listeners: PortListener[]
  /**
   * 端口上**确有监听、但输出里读不到 pid** 的行数。
   *
   * 这一栏是「读不到」与「没有」的**分界**：`ss -ltn`（无 `-p`）、非 root 跑 `ss -ltnp`、
   * `netstat -an` 全都落在这里。把它们压成「没人听」就是**反向结论** ——
   * 那正是本仓反复记的「把『查不了』当成『没启动』」那一族。
   */
  unidentified: number
  /**
   * **认得的**行数（**表头 + 数据行**，不限端口）。
   *
   * 判据全靠它区分两种「没查到」：输出是**一张我认得的表**（真没人听）还是
   * **根本不是这张表**（命令跑起来了但输出的形状不对，例如被喂了一段 `pid|name|start`）。
   * 没有这一栏，后者会被当成前者 —— 那是一条静默的反向结论。
   *
   * **表头也算**：`ss -ltnp` 在目标端口没人听时照样打印表头，
   * 那张 stdout 非空的空表是「读懂了、确实没人听」的**正面证据**，
   * 不算进去就会把最常见的情形误判成「输出形状不对」。
   */
  rows: number
}

/** 一个平台上的一次查询尝试（一条命令 + 它的输出解析器）。 */
export interface PortLookupAttempt {
  /** 可执行文件名。 */
  command: string
  /** 参数。 */
  args: readonly string[]
  /**
   * 输出解析器（**纯函数**）。
   *
   * 纯函数是刻意的：三条分支的解析逻辑都能单独单测，变异测试也才有着力点
   * （对着 spawn 替身做变异只能证明「命令被调了」，证明不了「列读对了」）。
   *
   * @param stdout 命令的标准输出。
   */
  parse: (stdout: string) => ParsedSocketTable
}

/** 一个平台的查询方案：按顺序试，**第一次「可信」的结果就用它**。 */
export interface PortLookupPlan {
  /** 平台标识（进 `detail`）。 */
  platform: string
  attempts: readonly PortLookupAttempt[]
}

/** `ss` 行里的 `pid=N`。`matchAll` 会克隆正则，不会动这里的 `lastIndex`。 */
const SS_PID = /\bpid=(\d+)/gu
/** `ss` 行里的 `users:(("name",…`；名字里的引号与反斜杠由 `ss` 自己转义。 */
const SS_PROCESS = /\(\("((?:[^"\\]|\\.)*)"/gu

/** `ss` 一行里「地址:端口」的那个端口值（`0.0.0.0:3080` / `[::1]:3080` 都吃）。 */
const SS_ADDR_PORT = /:(\d+)$/u

/**
 * `ss` 监听行的**本地地址**所在列下标。
 *
 * 为什么是下标而前面说「不按列号取值」—— 两件事不冲突，这里是**结构内**的下标，
 * 而且带**自校验**：`Recv-Q` / `Send-Q` 两列恒为数字，先确认它们是数字，
 * 才认这一行是我熟悉的那个形状、下标 3 就是本地地址。
 *
 * ## 为什么不能「扫全行找 `:port`」（这是实测踩到的）
 *
 * 扫全行会让**对端地址**被当成本地地址：构造一行
 * `LISTEN 0 128 0.0.0.0:22 1.2.3.4:3080 users:(...)`，扫全行会命中 `1.2.3.4:3080`
 * 并报出一个**根本不监听 3080** 的 pid。
 * 真机上 `ss -ltn` 的对端恒为 `*`、撞不上，但那只是「恰好不会发生」，
 * 而「恰好不会发生」正是静默坏掉的典型前提 —— 换个版本、换个输出模式就会翻车。
 * 自校验 + 固定结构内下标则相反：形状变了就**认不出这一行**（降级），
 * 而不是读错列（给出一个看着很真的假结论）。
 */
const SS_LOCAL_ADDRESS_INDEX = 3

/** 解析合法 pid（`0` 与负数不是监听者）。 */
function isPid(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

/** 把 `ss` 转义过的进程名还原（只去一层反斜杠转义）。 */
function unescapeSsName(name: string): string {
  return name.replace(/\\(.)/gu, '$1')
}

/**
 * 造一份空表。
 *
 * @param fields 零值字段。
 */
function emptyTable(fields: Partial<ParsedSocketTable> = {}): ParsedSocketTable {
  return { listeners: [], unidentified: 0, rows: 0, ...fields }
}

/** 纯数字（`Recv-Q` / `Send-Q` 两列恒为此形，是形状自校验的依据）。 */
function isNumericField(field: string | undefined): boolean {
  return field !== undefined && /^\d+$/u.test(field)
}

/**
 * 判断 `ss` 的一行是不是我熟悉的那个形状。
 *
 * `State Recv-Q Send-Q Local Peer [Process]`：首列状态之外，紧接着两列恒为数字。
 * 确认了这两列，才认下标 {@link SS_LOCAL_ADDRESS_INDEX} 那一列就是**本地地址**。
 *
 * @param fields 行的空白切分结果。
 */
function ssRowHasKnownShape(fields: readonly string[]): boolean {
  return fields.length > SS_LOCAL_ADDRESS_INDEX && isNumericField(fields[1]) && isNumericField(fields[2])
}

/**
 * 判断 `ss` 的一行是不是**目标端口**的行（只看**本地地址**那一列）。
 *
 * 理由与结构内下标的理由见 {@link SS_LOCAL_ADDRESS_INDEX} —— 关键是
 * **不许扫全行**：那会让对端地址被当成本地地址，报出一个并不监听该端口的 pid。
 *
 * @param fields 行的空白切分结果（**已确认形状**）。
 * @param port 目标端口。
 */
function ssRowIsOnPort(fields: readonly string[], port: number): boolean {
  const match = SS_ADDR_PORT.exec(fields[SS_LOCAL_ADDRESS_INDEX] ?? '')
  return match !== null && Number(match[1]) === port
}

/**
 * 解析 `ss -ltnp` / `ss -ltn` 的输出。
 *
 * ## 输出形状假设（全部有对应断言）
 *
 * 1. 一行一表项，空白分隔；
 * 2. 首列是状态，监听态逐字为 `LISTEN`（`-l` 保证）；首列为 `State` 的是表头
 *    （**表头计入 `rows`**：空表也是「读懂了」的正面证据）；
 * 3. **端口取本地地址那一列**，且那一列的下标由 `Recv-Q`/`Send-Q` 必须是数字来**自校验**
 *    （理由见 {@link SS_LOCAL_ADDRESS_INDEX}）；
 * 4. 进程信息形如 `users:(("node",pid=1234,fd=20))`，可出现多组（SO_REUSEPORT 的多个进程）。
 *    `pid=` 的个数与进程名不一定相等（名字被 `ss` 省略时），所以名字按下标配、
 *    配不上就退回**最后一个已知名字**，再没有才是 `(unknown)`；
 * 5. **没有 `users:` 那一段时（`ss -ltn`、或非 root 跑 `-p`）不能当成「没人听」** ——
 *    记成 `unidentified`（端口上有东西，只是读不到 pid）。
 *
 * ## 两段式（这是 `rows` 的意义所在）
 *
 * 先**认行**（这一行是不是我认识的数据行）再**匹配端口**（这一行是不是目标端口）。
 * 顺序反了会把「这张表我读懂了，只是没有目标端口的行」误判成「这张表我读不懂」——
 * 而 `ss -ltnp` 在目标端口没人听时**照样打印表头**（stdout 非空），
 * 于是那正是「Linux 上端口没被占用」这个最常见的情形会报成 `probed: false`。
 *
 * @param stdout `ss` 的标准输出。
 * @param port 目标端口。
 */
export function parseSsOutput(stdout: string, port: number): ParsedSocketTable {
  const table = emptyTable()
  const seen = new Set<number>()

  for (const rawLine of stdout.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (line === '') continue
    const fields = line.split(/\s+/u)
    const state = (fields[0] ?? '').toUpperCase()
    // 表头：本身**就是**「输出是我认识的那张表」的证据，所以计入 `rows`。
    if (state === 'STATE') {
      table.rows += 1
      continue
    }
    if (state !== 'LISTEN') continue
    // 形状不认识就不算「认得的行」—— 降级，不去猜哪一列是本地地址。
    if (!ssRowHasKnownShape(fields)) continue

    // 认行：到这一行就说明「输出是我认识的那张表」，与端口无关。
    table.rows += 1
    if (!ssRowIsOnPort(fields, port)) continue

    const pids = [...line.matchAll(SS_PID)]
      .map((match) => Number(match[1]))
      .filter(isPid)
    if (pids.length === 0) {
      table.unidentified += 1
      continue
    }
    const names = [...line.matchAll(SS_PROCESS)].map((match) => unescapeSsName(match[1] ?? ''))
    pids.forEach((pid, index) => {
      if (seen.has(pid)) return
      seen.add(pid)
      table.listeners.push({
        pid,
        processName: names[index] ?? names[names.length - 1] ?? '(unknown)',
      })
    })
  }
  return table
}

/** `lsof` 行的监听态尾标（与端口无关，用来**认行**）。 */
const LSOF_LISTEN_STATE = /\(LISTEN\)$/u
/** `lsof` 行里「本地地址:端口 + 监听态」那一段（用来**匹配端口**）。 */
const LSOF_LOCAL_PORT = /:(\d+)\s+\(LISTEN\)$/u

/**
 * 解析 `lsof -nP -iTCP:<port> -sTCP:LISTEN` 的输出。
 *
 * ## 输出形状假设（全部有对应断言）
 *
 * 1. 首行是表头（首列 `COMMAND`），跳过；
 * 2. **前两列**是进程名与 pid —— 这两列是 `lsof` 唯一稳定的左对齐列，
 *    后面几列的宽度会随内容变，所以**不按列号取别的**；
 * 3. 末列含空格（`TCP 127.0.0.1:3080 (LISTEN)`），所以判定「监听态且端口对得上」
 *    走**整行的尾部形状**，不是按空格切；
 * 4. 端口过滤由 `-iTCP:<port>` 承担，但**这里仍按值复核一遍**：
 *    万一命令被换掉、被 shell 吃掉了一个参数，宁可少报也不要**认错别人的监听者**。
 *
 * 与 {@link parseSsOutput} 同样是两段式（先认行、再匹配端口），理由见那里。
 *
 * @param stdout `lsof` 的标准输出。
 * @param port 目标端口。
 */
export function parseLsofOutput(stdout: string, port: number): ParsedSocketTable {
  const table = emptyTable()

  for (const rawLine of stdout.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (line === '') continue
    const fields = line.split(/\s+/u)
    // 表头：本身**就是**「输出是我认识的那张表」的证据，所以计入 `rows`。
    if ((fields[0] ?? '').toUpperCase() === 'COMMAND') {
      table.rows += 1
      continue
    }
    if (!LSOF_LISTEN_STATE.test(line)) continue

    // 认行：到这一行就说明「输出是我认识的那张表」，与端口无关。
    table.rows += 1
    const local = LSOF_LOCAL_PORT.exec(line)
    if (local === null || Number(local[1]) !== port) continue

    const pid = Number.parseInt(fields[1] ?? '', 10)
    if (!isPid(pid)) {
      table.unidentified += 1
      continue
    }
    const command = fields[0] ?? ''
    table.listeners.push({ pid, processName: command === '' ? '(unknown)' : command })
  }
  return table
}

/** `netstat -an` 里本地地址那一列的端口（macOS 用 `.` 分隔，如 `127.0.0.1.3080` / `*.3080`）。 */
const NETSTAT_LOCAL_PORT = /\.(\d+)$/u

/**
 * 解析 `netstat -an` 的输出（**darwin 的最后一档兜底**）。
 *
 * ## 输出形状假设（全部有对应断言）
 *
 * 1. 表头首列是 `Proto`（**计入 `rows`**）；unix 域那一段的行首不是 `tcp`，也跳过；
 * 2. 监听态在**最后一列**逐字为 `LISTEN`；
 * 3. 本地地址是**倒数第二列那一类** token（`127.0.0.1.3080` / `*.3080` / `::1.3080`），
 *    对端是 `*.*` —— 端口按值匹配（`.` 后取数字，`*` 匹配不上）；
 * 4. **`netstat` 不给 pid**，所以命中的行**一律**进 `unidentified`：
 *    「知道有人在听、不知道是谁」是如实的结论，不是失败。
 *
 * 与 {@link parseSsOutput} 同样是两段式（先认行、再匹配端口），理由见那里。
 *
 * @param stdout `netstat` 的标准输出。
 * @param port 目标端口。
 */
export function parseNetstatOutput(stdout: string, port: number): ParsedSocketTable {
  const table = emptyTable()

  for (const rawLine of stdout.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (line === '') continue
    const fields = line.split(/\s+/u)
    const proto = (fields[0] ?? '').toLowerCase()
    // 表头：本身**就是**「输出是我认识的那张表」的证据，所以计入 `rows`。
    if (proto === 'proto') {
      table.rows += 1
      continue
    }
    if (!proto.startsWith('tcp')) continue
    if (fields[fields.length - 1] !== 'LISTEN') continue

    // 认行：到这一行就说明「输出是我认识的那张表」，与端口无关。
    table.rows += 1
    const onPort = fields.some((field) => {
      const match = NETSTAT_LOCAL_PORT.exec(field)
      return match !== null && Number(match[1]) === port
    })
    if (!onPort) continue

    table.unidentified += 1
  }
  return table
}

/**
 * 把 `netstat -ano` 的「列全部」结果收敛成「**目标这一个端口**」的表。
 *
 * ## 为什么复用 {@link parseNetstatListeners} 而不是另写一份
 *
 * 两个 `netstat` 形状（Windows 的 `LISTENING` + 末列 pid / darwin 的末列 `LISTEN`）
 * 的认行与取值规则**逐条相同**，只有「目标端口在不在其中」这一步不同 ——
 * 另写一份就多一个地方会漂，而两处漂了还是**静默**的（少认一行看起来像「没人听」）。
 *
 * ## ⚠️ 为什么**不是**用命令行子串先过滤一遍
 *
 * 「问 3080」这个约束由**解析器按字段比对**承担，不是由 `findstr :3080` 之类的
 * 管道过滤承担：后者会把**对端地址**里含 `:3080` 的行也算进来（`ss` 那条纪律的同族），
 * 而本仓硬规矩是端口一律**按端口查、不用命令行子串**
 * —— `portLookupPlan` 那条 `not.toContain('bin.js')` 断言守的正是这一族。
 *
 * ## 三值语义
 *
 * `unidentified` 在这里**按目标端口重数**（不是照抄整张表的计数），与
 * {@link parseSsOutput} 的做法一致；读不到 pid 的行进 `unidentified` ⇒
 * `attemptIsTrusted` 判可信、`toResult` 给 `listening: true` + 空 listeners
 * —— 「有人听、不知道是谁」绝不会被写成「没人听」。
 *
 * @param stdout `netstat -ano` 的标准输出。
 * @param port 目标端口。
 */
function netstatListenersOnPort(stdout: string, port: number): ParsedSocketTable {
  const scan = parseNetstatListeners(stdout)
  const listeners: PortListener[] = []
  const seen = new Set<number>()
  let unidentified = 0

  for (const candidate of scan.candidates) {
    if (candidate.port !== port) continue
    if (candidate.pid === undefined) {
      // 「有人听、读不到是谁」—— 记 unidentified，不当成「没人听」。
      unidentified += 1
      continue
    }
    // 双栈监听（IPv4 + IPv6）会让同一 pid 出两行 ⇒ 同 pid 只留一条，
    // 否则「2 个监听者」是在报同一个进程的两次。
    if (seen.has(candidate.pid)) continue
    seen.add(candidate.pid)
    // `netstat` 不给进程名 ⇒ 按本层既有约定填占位（`parsePortLookup` 等四处同此）。
    listeners.push({ pid: candidate.pid, processName: '(unknown)' })
  }
  return { listeners, unidentified, rows: scan.rows }
}

/**
 * 取某个平台的查询方案。
 *
 * **返回 `undefined` 就是「这个平台没有命令」**（`aix` / `freebsd` / `sunos` …），
 * 调用方据此给 `probed: false` —— 那不是「端口上没人」，是「查不了」。
 *
 * 兜底的用意不是「主命令一定失败」，而是主命令**本身不可用**：
 * Linux 上 `ss -ltnp` 与 `ss -ltn` 是同一个二进制，所以真正救场的是
 * 「`-p` 不被支持 / 权限不足导致非零退出」那种构建；darwin 上则是
 * `lsof` 缺失（精简安装里常见）时由 `netstat -an` 顶上；
 * **win32 上是 `Get-NetTCPConnection` 缺 `NetTCPIP` 模块**（精简系统 / Server Core /
 * 某些容器镜像上压根没有）时由 `netstat -ano` 顶上 —— `netstat.exe` 一直都在。
 * ⚠️ 这不是「win32 特有的锦上添花」：`Get-NetTCPConnection` 缺模块**同时打断两条路**
 * （列全部由 {@link listenerScanAttempts} 兜、查单端口在这里兜），
 * 只补其中一条会让 `dsh_list_instances` 好了、`dsh_check_auth` / `dsh_dump_config`
 * 在同一台机器上照样瞎 —— **修一个落点 ≠ 扫一族**。
 *
 * 端口是**参数**而不是模块里的常量：它同时出现在参数表（`-iTCP:<port>`、PowerShell 脚本）
 * 与解析器里，两处必须是同一个值 —— 写死一处就会出现「问的是 3080、过滤的是 0」
 * 那种静默失配，而它**不会报错**，只会安静地报告「没人听」。
 *
 * @param platform `process.platform`（**调用时**读，不在模块加载时缓存）。
 * @param port 目标端口。
 */
export function portLookupPlan(platform: string, port: number): PortLookupPlan | undefined {
  if (platform === 'win32') {
    return {
      platform,
      attempts: [
        {
          command: PORT_LOOKUP_SHELL,
          args: ['-NoProfile', '-NonInteractive', '-Command', portLookupScript(port)],
          parse: (stdout) => {
            const listeners = parsePortLookup(stdout)
            return { listeners, unidentified: 0, rows: listeners.length }
          },
        },
        // 兜底：`-ano` 认全表、**解析器按字段比对端口**（不是命令行子串过滤 ——
        // 那会把对端地址里含 `:3080` 的行算进来，而端口一律按端口查是本仓硬规矩）。
        {
          command: WINDOWS_FALLBACK_COMMAND,
          args: ['-ano'],
          parse: (stdout) => netstatListenersOnPort(stdout, port),
        },
      ],
    }
  }
  if (platform === 'linux') {
    return {
      platform,
      attempts: [
        {
          command: LINUX_LOOKUP_COMMAND,
          args: ['-ltnp'],
          parse: (stdout) => parseSsOutput(stdout, port),
        },
        {
          command: LINUX_LOOKUP_COMMAND,
          args: ['-ltn'],
          parse: (stdout) => parseSsOutput(stdout, port),
        },
      ],
    }
  }
  if (platform === 'darwin') {
    return {
      platform,
      attempts: [
        {
          command: DARWIN_LOOKUP_COMMAND,
          args: ['-nP', `-iTCP:${String(port)}`, '-sTCP:LISTEN'],
          parse: (stdout) => parseLsofOutput(stdout, port),
        },
        {
          command: DARWIN_FALLBACK_COMMAND,
          args: ['-an'],
          parse: (stdout) => parseNetstatOutput(stdout, port),
        },
      ],
    }
  }
  return undefined
}

/**
 * 造「跑不通」的返回值（**不抛**：探测失败收敛成 `probed: false`）。
 *
 * @param port 目标端口。
 * @param platform 平台标识（`detail` 必带它）。
 * @param detail 平台标识之后的那句说明。
 */
function notProbed(port: number, platform: string, detail: string): PortLookupResult {
  return { port, listening: false, listeners: [], probed: false, detail: `${platform}: ${detail}` }
}

/**
 * 这次尝试的结果**能不能当结论用**。
 *
 * 四条分支，每条都有对应断言（顺序即优先级）：
 * 1. **命中了目标端口** → 可信（找到东西了，剩下的细节不重要）；
 * 2. 输出**为空** → 只有 `exit 0` 才可信（空表 = 真没人听）；
 *    非零退出时的空输出是「命令没跑成」，不是「没人听」；
 * 3. 有 stderr → **不可信**：权限不足的告警长这样，说「没人听」是反向结论；
 * 4. 输出非空但**一张表都没认出来** → 不可信（喂进来的不是这张表的形状）。
 *
 * @param result 一次命令的结果。
 * @param table 该次尝试解析出来的表。
 */
function attemptIsTrusted(result: CommandResult, table: ParsedSocketTable): boolean {
  if (table.listeners.length > 0 || table.unidentified > 0) return true
  if (result.stdout.trim() === '') return result.code === 0
  if (result.stderr.trim() !== '') return false
  return table.rows > 0
}

/** 一次尝试失败时留给 `detail` 的一句（模型可见，所以英文）。 */
function attemptFailure(result: CommandResult, table: ParsedSocketTable): string {
  if (result.spawnError !== undefined) return result.spawnError
  if (result.code !== 0) {
    const stderr = result.stderr.trim().split(/\r?\n/u)[0] ?? ''
    return `exit ${String(result.code)}${stderr === '' ? '' : ` (${stderr})`}`
  }
  return `unrecognised output (${String(table.rows)} table row(s) parsed)`
}

/**
 * 把一张可信的表收敛成结果。
 *
 * `unidentified > 0` 时是 **`listening: true` + `listeners: []`** ——
 * 这个组合是刻意的：它与「没人听」（`listening: false`）和「查不了」（`probed: false`）
 * 三者互不重叠，下游才不用去猜。
 *
 * @param port 目标端口。
 * @param platform 平台标识。
 * @param table 可信的表。
 */
function toResult(port: number, platform: string, table: ParsedSocketTable): PortLookupResult {
  if (table.listeners.length > 0) {
    return {
      port,
      listening: true,
      listeners: table.listeners,
      probed: true,
      detail: `${String(table.listeners.length)} listener(s) on port ${String(port)}`,
    }
  }
  if (table.unidentified > 0) {
    return {
      port,
      listening: true,
      listeners: [],
      probed: true,
      detail: `${platform}: something is bound to port ${String(port)}, but the socket table carries no process id`,
    }
  }
  return {
    port,
    listening: false,
    listeners: [],
    probed: true,
    detail: `no listener on port ${String(port)}`,
  }
}

/**
 * 查一个端口上的监听者。
 *
 * **不抛**：探测失败收敛成 `probed: false`。
 *
 * ## 「不抛」的边界（在 B24 那条红线之下钉住）
 *
 * 收敛的是「命令跑完了、结果不好」（spawnError / 超时 / 取消 / 形状认不出）。
 * **注入的 spawn 实现自己抛异常不在此列** —— 那个由**工具层**的顶层 `try/catch` 接住
 * （`execute` 全路径不抛是契约的承重条件）。本层再加一层只会把两种失败抹平成一种，
 * 所以那条边界在 `test/tools/ports-crossplatform.test.ts` 里被钉住。
 *
 * @param port 目标端口。
 * @param deps 可注入的 spawn 与预算。
 */
export async function lookupPort(
  port: number,
  deps: { spawn: SpawnImpl; timeoutMs: number; signal?: AbortSignal | undefined },
): Promise<PortLookupResult> {
  // 每次调用现读 —— 模块加载时缓存会让 `withPlatform` 这类测试助手失效。
  const platform = process.platform
  const plan = portLookupPlan(platform, port)
  if (plan === undefined) {
    return notProbed(port, platform, `no socket-table command is known on platform ${platform}`)
  }

  const failures: string[] = []
  for (const attempt of plan.attempts) {
    const result = await deps.spawn({
      command: attempt.command,
      args: attempt.args,
      timeoutMs: deps.timeoutMs,
      signal: deps.signal,
    })

    // 取消与超时**不重试**：重试等于把「调用方主动放弃」与「预算耗尽」抹平，
    // 而这两者的正确反应不同（超时可重试，取消不可重试）。
    if (result.aborted) return notProbed(port, platform, 'the caller cancelled the port lookup')
    if (result.timedOut) return notProbed(port, platform, 'the port lookup timed out')
    if (result.spawnError !== undefined) {
      failures.push(`${attempt.command}: ${result.spawnError}`)
      continue
    }

    const table = attempt.parse(result.stdout)
    if (!attemptIsTrusted(result, table)) {
      failures.push(`${attempt.command}: ${attemptFailure(result, table)}`)
      continue
    }
    return toResult(port, platform, table)
  }

  // 方案里每一条都不可信 → 「查不了」，**不是**「没人听」。
  return notProbed(port, platform, `no usable socket table (${failures.join('; ')})`)
}
// ── 「列出全部监听者」（D′ 的发现能力） ────────────────────────────────────
//
// 与 `lookupPort` **并列**，不是改它：单端口查询的既有行为（含四态语义与全部断言）
// 一个字都不许变，而「列全部」要的是另一件事 —— 找出**所有**候选端口，
// 再由上层去逐个认领谁是 DSH。
//
// 三平台各自的差别全在「怎么列出全部」，而**四态语义照旧**：
// `probed:false`（查不了）/ 没有候选（没人听）/ 候选带 pid（认得出来）/
// 候选**不带 pid**（有人听但读不到 pid ⇒ `unidentified`）。

/** 一个候选监听端口（端口必有；进程信息可能读不到）。 */
export interface ListenerCandidate {
  port: number
  pid?: number
  processName?: string
  startedAt?: string
}

/** 「列出全部监听者」的结果。 */
export interface ListenerScanResult {
  platform: string
  /** `false` = **查不了**（命令缺失 / 形状认不出 / 超时 / 取消），不是「没人听」。 */
  probed: boolean
  candidates: ListenerCandidate[]
  /**
   * **有监听、但读不到 pid** 的条数。
   *
   * 与 {@link ParsedSocketTable} 的 `unidentified` 同一个纪律：把它压成「没人听」
   * 就是反向结论 —— 而那正是本仓反复记的那一族静默坏。
   */
  unidentified: number
  detail: string
}

/** 一张「全部监听者」表的解析结果。 */
export interface ParsedListenerTable {
  candidates: ListenerCandidate[]
  unidentified: number
  /** **认得的**行数（含表头）—— 理由与 `ParsedSocketTable.rows` 逐字相同。 */
  rows: number
}

/**
 * 造「列出全部监听者」的脚本（**仅 Windows 分支**）。
 *
 * 与 {@link portLookupScript} 的两处差别，都是必需的：
 * 1. 去掉 `-LocalPort <n>` —— 这正是「列全部」；
 * 2. 输出**多带一个 `port` 字段**：单端口那次查询的调用方已经知道端口，列全部时
 *    不知道，而 `LocalPort` 必须由脚本给出（否则解析器只能瞎猜）。
 *
 * 字段顺序固定为 `port|pid|name|startedAt`：加字段是**破坏性**改动，
 * 解析器 {@link parseListenerScan} 与它成对，别只改一边。
 */
export function listenerScanScript(): string {
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    '$rows=@(Get-NetTCPConnection -State Listen)',
    '$pids=@($rows | Select-Object -ExpandProperty OwningProcess -Unique)',
    // ⚠️ **一次问完，不要逐行问**（2026-10-14 实测）：原写法在 `foreach($r in $rows)` 里对**每一行**
    // （含双栈重复，本机 63 行）各调一次 `Get-Process -Id`，是 O(行数) 次进程查询 ——
    // 本机实测 **2,110 ms**；把唯一 pid 数组**一次**交给 `Get-Process -Id` 只要 **705 ms**
    // （同一份输出、同样的 `unidentified` 判定）。`Get-Process -Id` 接受数组，这是纯优化。
    '$procs=@{}',
    'if($pids.Count -gt 0){',
    'foreach($proc in @(Get-Process -Id $pids)){',
    "$started=''",
    "try{ $started=$proc.StartTime.ToString('o') }catch{}",
    '$procs[[string]$proc.Id]=("{0}|{1}" -f $proc.ProcessName,$started)',
    '}',
    '}',
    'foreach($r in $rows){',
    '$p=$r.OwningProcess',
    '$v=$procs[[string]$p]',
    "if($null -eq $v){ $v='|' }",
    "$i=$v.IndexOf('|')",
    'Write-Output ("{0}|{1}|{2}|{3}" -f $r.LocalPort,$p,$v.Substring(0,$i),$v.Substring($i+1))',
    '}',
  ].join('; ')
}

/**
 * 解析「列出全部监听者」的脚本输出（`port|pid|name|startedAt`）。
 *
 * 形状不对的行**跳过**（不猜）：pid 读不出来时仍然保留端口 —— 那是「有人听、
 * 不知道是谁」，属于 `unidentified`，不是「没有」。
 *
 * @param stdout 脚本的标准输出。
 */
export function parseListenerScan(stdout: string): ParsedListenerTable {
  const table: ParsedListenerTable = { candidates: [], unidentified: 0, rows: 0 }
  for (const rawLine of stdout.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (line === '') continue
    const [portText, pidText = '', processName = '', startedAt = ''] = line.split('|')
    const port = Number.parseInt(portText ?? '', 10)
    if (!isPort(port)) continue
    table.rows += 1
    const pid = Number.parseInt(pidText, 10)
    if (!isPid(pid)) {
      table.unidentified += 1
      table.candidates.push({ port })
      continue
    }
    table.candidates.push({
      port,
      pid,
      processName: processName === '' ? '(unknown)' : processName,
      ...(startedAt === '' ? {} : { startedAt }),
    })
  }
  return table
}

/** 合法端口（`0` 不是可连接的监听端口）。 */
function isPort(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= 65535
}

/** `ss` 一行里本地地址那列的端口（`0.0.0.0:3080` / `[::1]:3080`）。 */
function ssPortOf(fields: readonly string[]): number | undefined {
  const match = SS_ADDR_PORT.exec(fields[SS_LOCAL_ADDRESS_INDEX] ?? '')
  const port = match === null ? Number.NaN : Number(match[1])
  return isPort(port) ? port : undefined
}

/**
 * 解析 `ss -ltnp` / `ss -ltn` 的**全部**监听行。
 *
 * 复用的是 {@link parseSsOutput} 那套「先认行、再取值」的形状判据
 * （`ssRowHasKnownShape` + 结构内下标），只是**不过滤端口**。
 *
 * @param stdout `ss` 的标准输出。
 */
export function parseSsListeners(stdout: string): ParsedListenerTable {
  const table: ParsedListenerTable = { candidates: [], unidentified: 0, rows: 0 }
  const seen = new Set<string>()
  for (const rawLine of stdout.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (line === '') continue
    const fields = line.split(/\s+/u)
    const state = (fields[0] ?? '').toUpperCase()
    if (state === 'STATE') {
      table.rows += 1
      continue
    }
    if (state !== 'LISTEN') continue
    if (!ssRowHasKnownShape(fields)) continue
    table.rows += 1
    const port = ssPortOf(fields)
    if (port === undefined) continue
    const pids = [...line.matchAll(SS_PID)]
      .map((match) => Number(match[1]))
      .filter(isPid)
    if (pids.length === 0) {
      table.unidentified += 1
      table.candidates.push({ port })
      continue
    }
    const names = [...line.matchAll(SS_PROCESS)].map((match) => unescapeSsName(match[1] ?? ''))
    pids.forEach((pid, index) => {
      const key = `${String(port)}:${String(pid)}`
      if (seen.has(key)) return
      seen.add(key)
      table.candidates.push({
        port,
        pid,
        processName: names[index] ?? names[names.length - 1] ?? '(unknown)',
      })
    })
  }
  return table
}

/**
 * 解析 `lsof -nP -iTCP -sTCP:LISTEN` 的**全部**监听行。
 *
 * 与 {@link parseLsofOutput} 同形，只是不吃端口参数（`lsof` 那一行里已经带着端口）。
 *
 * @param stdout `lsof` 的标准输出。
 */
export function parseLsofListeners(stdout: string): ParsedListenerTable {
  const table: ParsedListenerTable = { candidates: [], unidentified: 0, rows: 0 }
  for (const rawLine of stdout.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (line === '') continue
    const fields = line.split(/\s+/u)
    if ((fields[0] ?? '').toUpperCase() === 'COMMAND') {
      table.rows += 1
      continue
    }
    if (!LSOF_LISTEN_STATE.test(line)) continue
    table.rows += 1
    const local = LSOF_LOCAL_PORT.exec(line)
    const port = local === null ? Number.NaN : Number(local[1])
    if (!isPort(port)) continue
    const pid = Number.parseInt(fields[1] ?? '', 10)
    if (!isPid(pid)) {
      table.unidentified += 1
      table.candidates.push({ port })
      continue
    }
    const command = fields[0] ?? ''
    table.candidates.push({ port, pid, processName: command === '' ? '(unknown)' : command })
  }
  return table
}

/**
 * `netstat -an` 里**本地地址**那一列的列号（`Proto Recv-Q Send-Q Local Foreign (state)`）。
 *
 * 为什么是结构内下标而不是「扫全行找 `:port`」：与 `ss` 那条纪律逐字同一个理由 ——
 * 扫全行会让**对端地址**被当成监听端口（实测踩过：本机夹具里 `Foreign` 那一列
 * 恰好是另一个端口，扫全行就会报出一个根本不监听的端口）。
 */
const NETSTAT_LOCAL_INDEX = 3

/** `netstat -an` 一行里本地地址那一列的端口（`127.0.0.1.3080` / `*.3080`）。 */
function netstatPortOf(fields: readonly string[]): number | undefined {
  if (fields.length <= NETSTAT_LOCAL_INDEX) return undefined
  const match = NETSTAT_LOCAL_PORT.exec(fields[NETSTAT_LOCAL_INDEX] ?? '')
  const port = match === null ? Number.NaN : Number(match[1])
  return isPort(port) ? port : undefined
}

// ── Windows 那张表（`netstat -ano`） ───────────────────────────────────────
//
// 两种 `netstat` 的行形状**完全不同**，所以「状态在哪一列」也完全不同：
//
//   darwin : tcp4 0 0 127.0.0.1.3080 *.* LISTEN            ← 状态在**末列**
//   Windows: TCP 0.0.0.0:135 0.0.0.0:0 LISTENING 1044      ← 状态在**第 4 列**，末列是 pid
//
// ⇒ 只认末列会把 **Windows 的每一行都丢掉**，而丢弃 = 「找不到任何监听者」
// ⇒ 兜底等于没有。所以解析器必须**同时**认这两种。
//
// 下面三条纪律与 `ss` / darwin 那两条逐字同一个理由：
// 1. **不扫全行找端口**：Windows 的对端地址也带 `:port`（`10.0.0.8:443`），
//    扫全行会把**别的进程的端口**报成监听端口 —— 那正是静默给出假结论的形状；
// 2. 本地地址取**结构内**下标，且那张表的形状**自校验**（proto + 状态列 + pid 列）；
// 3. 形状认不出就**降级**（这一行不计入 `rows`），不去猜哪一列是什么。

/** `netstat -ano` 的 proto 列逐字值（Windows 印 `TCP`/`UDP`，darwin 印 `tcp4`/`tcp6`）。 */
const WINDOWS_NETSTAT_PROTO = 'TCP'
/** `netstat -ano` 的监听态逐字值（darwin 那个是 `LISTEN`，**少一个 `ING`**）。 */
const WINDOWS_NETSTAT_LISTEN_STATE = 'LISTENING'
/** `netstat -ano` 一行里**本地地址**那一列的下标（`Proto Local Foreign State PID`）。 */
const WINDOWS_NETSTAT_LOCAL_INDEX = 1
/** 同一张表里**状态**那一列的下标。 */
const WINDOWS_NETSTAT_STATE_INDEX = 3
/** 同一张表里 **pid** 那一列的下标（`netstat -an` 不带 `-o` 时这一列不存在）。 */
const WINDOWS_NETSTAT_PID_INDEX = 4
/** `netstat -ano` 一行里本地地址那一列的端口（`0.0.0.0:135` / `[::]:135`，冒号分隔）。 */
const WINDOWS_NETSTAT_LOCAL_PORT = /:(\d+)$/u

/**
 * `netstat -ano` 一行里本地地址那一列的端口。
 *
 * 与 {@link netstatPortOf} 同一个纪律（**只取本地地址那一列**），只是分隔符不同。
 *
 * @param fields 行的空白切分结果（**已确认是 Windows 那张表的监听行**）。
 */
function windowsNetstatPortOf(fields: readonly string[]): number | undefined {
  const match = WINDOWS_NETSTAT_LOCAL_PORT.exec(fields[WINDOWS_NETSTAT_LOCAL_INDEX] ?? '')
  const port = match === null ? Number.NaN : Number(match[1])
  return isPort(port) ? port : undefined
}

/**
 * 判断一行是不是 **Windows `netstat`** 的监听行（形状自校验）。
 *
 * 认下的条件是两条，缺一即降级：proto 列逐字为 `TCP`（darwin 印的是 `tcp4`/`tcp6`）、
 * **状态列**逐字为 `LISTENING`。
 *
 * ⚠️ 判的是**状态列**而不是末列：`netstat -ano` 的末列是 pid（`LISTENING 1044`），
 * 按末列判会把 Windows 的每一行都丢掉 —— 而丢掉 = 「找不到任何监听者」= 兜底形同虚设。
 *
 * pid 列**不参与**认行：`-ano` 有它、`-an`（漏了 `-o`）没有，两种都必须读得出来，
 * 所以 pid 的有无是**取值时**的分支，不是**认行时**的条件。
 *
 * @param fields 行的空白切分结果。
 */
function windowsNetstatRowIsListening(fields: readonly string[]): boolean {
  if (fields[0] !== WINDOWS_NETSTAT_PROTO) return false
  return fields[WINDOWS_NETSTAT_STATE_INDEX] === WINDOWS_NETSTAT_LISTEN_STATE
}

/**
 * 解析 `netstat` 的**全部** tcp 监听行（darwin 的 `-an` 与 win32 的 `-ano` 两种形状）。
 *
 * ## 两种形状，判据逐条列出
 *
 * 1. 表头首列是 `Proto`（两平台相同，**计入 `rows`**）；`Active Connections` 那行、
 *    `UDP` 行与 unix 域那一段都不认；
 * 2. **darwin**（`netstat -an`）：监听态在**末列**逐字为 `LISTEN`，本地地址是第 4 列
 *    （`127.0.0.1.3080` / `*.3080`），**不给 pid** ⇒ 命中的行**一律**进 `unidentified`；
 * 3. **win32**（`netstat -ano`）：监听态在**状态列**逐字为 `LISTENING`，本地地址是第 2 列
 *    （`0.0.0.0:3080` / `[::]:3080`），**pid 在末列** ⇒ 带 pid 的候选（见下）；
 * 4. **不扫全行找端口**：两个平台的对端地址都带端口，扫全行会报出别人的端口。
 *
 * ## 三值语义（这一档尤其容易塌）
 *
 * `-o` 这一档**读得到 pid**，所以带 pid 的行**不计入** `unidentified`
 * —— 该栏的定义是「读不到 **pid** 的条数」，而 pid 就在那一列；
 * 但它**读不到进程名与启动时间**，所以候选只带 `port` + `pid`（不留空串占位）。
 * 两种形态都仍然是「**端口上有人在听**」：
 * 「没人听」只由「这张表被读懂了、而它没有这一行」来表达。
 *
 * @param stdout `netstat` 的标准输出。
 */
export function parseNetstatListeners(stdout: string): ParsedListenerTable {
  const table: ParsedListenerTable = { candidates: [], unidentified: 0, rows: 0 }
  for (const rawLine of stdout.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (line === '') continue
    const fields = line.split(/\s+/u)
    const proto = fields[0] ?? ''
    if (proto.toLowerCase() === 'proto') {
      table.rows += 1
      continue
    }

    // ── win32（`netstat -ano`）：状态在第 4 列、**末列是 pid** ──
    if (proto === WINDOWS_NETSTAT_PROTO) {
      if (!windowsNetstatRowIsListening(fields)) continue
      // 认行：到这一行就说明「输出是我认识的那张表」，与端口无关。
      table.rows += 1
      const port = windowsNetstatPortOf(fields)
      if (port === undefined) continue
      const pid = Number.parseInt(fields[WINDOWS_NETSTAT_PID_INDEX] ?? '', 10)
      if (!isPid(pid)) {
        // `netstat -an`（漏了 `-o`）没有 pid 那一列 ⇒ 如实记 unidentified：
        // 「端口上有东西在听、读不到是谁」不是「没人听」。
        table.unidentified += 1
        table.candidates.push({ port })
        continue
      }
      // pid 读到了，但**进程名与启动时间读不到** ⇒ 不留占位串（占位会读成「名字叫 (unknown)」）。
      table.candidates.push({ port, pid })
      continue
    }

    // ── darwin（`netstat -an`）：监听态在**末列**、`netstat` 不给 pid ──
    if (!proto.toLowerCase().startsWith('tcp')) continue
    if (fields[fields.length - 1] !== 'LISTEN') continue
    // 认行：到这一行就说明「输出是我认识的那张表」，与端口无关。
    table.rows += 1
    const port = netstatPortOf(fields)
    if (port === undefined) continue
    table.unidentified += 1
    table.candidates.push({ port })
  }
  return table
}


/** 「列出全部监听者」的一次尝试（命令 + 解析器）。 */
export interface ListenerScanAttempt {
  command: string
  args: readonly string[]
  parse: (stdout: string) => ParsedListenerTable
}

/**
 * 取某个平台的「列出全部监听者」方案。
 *
 * 与 {@link portLookupPlan} 分开而不是参数化：两条路的**命令形态不同**
 * （`-LocalPort` / `-iTCP:<port>` 都得去掉），把它们塞进一个函数只会让
 * 「传不传端口」变成一个运行期分支 —— 而那个分支写错的形状正是**静默少列**。
 *
 * 兜底的用意与那条注释逐字同一个：**主命令本身不可用**（`Get-NetTCPConnection` 缺模块、
 * `lsof` 没装、`-p` 不被支持），不是「主命令慢」。所以顺序即优先级，
 * 第一条**可信**就返回 —— 兜底只在前面每一条都被判成不可信时才会被跑到。
 *
 * @param platform `process.platform`（**调用时**读）。
 */
export function listenerScanAttempts(platform: string): ListenerScanAttempt[] {
  if (platform === 'win32') {
    return [
      {
        command: PORT_LOOKUP_SHELL,
        args: ['-NoProfile', '-NonInteractive', '-Command', listenerScanScript()],
        parse: parseListenerScan,
      },
      // 兜底：`Get-NetTCPConnection` 依赖 `NetTCPIP` 这个 PowerShell 模块 ——
      // 精简系统 / Server Core / 某些容器镜像上它压根不在，于是第一档**一条行都读不出来**
      // ⇒ `unavailable` ⇒ `dsh_list_instances` 报「一个 DSH 宿主都没有」，而宿主可能就在跑。
      // `-o` 这一档能填 pid（比 darwin 那一档还多一样），但进程名与启动时间拿不到。
      { command: WINDOWS_FALLBACK_COMMAND, args: ['-ano'], parse: parseNetstatListeners },
    ]
  }
  if (platform === 'linux') {
    return [
      { command: LINUX_LOOKUP_COMMAND, args: ['-ltnp'], parse: parseSsListeners },
      { command: LINUX_LOOKUP_COMMAND, args: ['-ltn'], parse: parseSsListeners },
    ]
  }
  if (platform === 'darwin') {
    return [
      { command: DARWIN_LOOKUP_COMMAND, args: ['-nP', '-iTCP', '-sTCP:LISTEN'], parse: parseLsofListeners },
      { command: DARWIN_FALLBACK_COMMAND, args: ['-an'], parse: parseNetstatListeners },
    ]
  }
  return []
}

/**
 * 列出本机全部监听者。
 *
 * **不抛**：查不了收敛成 `probed: false`。可注入 spawn；每次尝试都带预算。
 *
 * @param deps 可注入的 spawn 与预算。
 */
export async function listListeners(deps: {
  spawn: SpawnImpl
  timeoutMs: number
  signal?: AbortSignal | undefined
}): Promise<ListenerScanResult> {
  const platform = process.platform
  const attempts = listenerScanAttempts(platform)
  if (attempts.length === 0) {
    return {
      platform,
      probed: false,
      candidates: [],
      unidentified: 0,
      detail: `${platform}: no socket-table command is known on platform ${platform}`,
    }
  }

  const failures: string[] = []
  for (const attempt of attempts) {
    const result = await deps.spawn({
      command: attempt.command,
      args: attempt.args,
      timeoutMs: deps.timeoutMs,
      signal: deps.signal,
    })
    if (result.aborted) {
      return {
        platform,
        probed: false,
        candidates: [],
        unidentified: 0,
        detail: `${platform}: the caller cancelled the listener scan`,
      }
    }
    if (result.timedOut) {
      return {
        platform,
        probed: false,
        candidates: [],
        unidentified: 0,
        detail: `${platform}: the listener scan timed out`,
      }
    }
    if (result.spawnError !== undefined) {
      failures.push(`${attempt.command}: ${result.spawnError}`)
      continue
    }
    const table = attempt.parse(result.stdout)
    if (!listenerTableIsTrusted(result, table)) {
      failures.push(`${attempt.command}: ${listenerAttemptFailure(result, table)}`)
      continue
    }
    return {
      platform,
      probed: true,
      candidates: dedupeCandidates(table.candidates),
      unidentified: table.unidentified,
      detail:
        table.candidates.length === 0
          ? `no listening ports were found (${platform})`
          : `${String(table.candidates.length)} candidate port(s) (${platform})`,
    }
  }
  return {
    platform,
    probed: false,
    candidates: [],
    unidentified: 0,
    detail: `${platform}: no usable socket table (${failures.join('; ')})`,
  }
}

/** 同端口同 pid 只留一条（多张表 / 双栈会让同一条出现两次）。 */
function dedupeCandidates(candidates: readonly ListenerCandidate[]): ListenerCandidate[] {
  const seen = new Set<string>()
  const result: ListenerCandidate[] = []
  for (const candidate of candidates) {
    const key = `${String(candidate.port)}:${String(candidate.pid ?? '')}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(candidate)
  }
  return result
}

/**
 * 一次「列出全部」的尝试能不能当结论用。
 *
 * 与 {@link attemptIsTrusted} 同一条纪律，只是表形状不同。
 */
function listenerTableIsTrusted(
  result: CommandResult,
  table: ParsedListenerTable,
): boolean {
  if (table.rows > 0) return true
  if (result.stdout.trim() === '') return result.code === 0
  if (result.stderr.trim() !== '') return false
  return false
}

/** 一次「列出全部」尝试失败时留给 `detail` 的一句（模型可见，所以英文）。 */
function listenerAttemptFailure(result: CommandResult, table: ParsedListenerTable): string {
  if (result.spawnError !== undefined) return result.spawnError
  if (result.code !== 0) {
    const stderr = result.stderr.trim().split(/\r?\n/u)[0] ?? ''
    return `exit ${String(result.code)}${stderr === '' ? '' : ` (${stderr})`}`
  }
  return `unrecognised output (${String(table.rows)} table row(s) parsed)`
}