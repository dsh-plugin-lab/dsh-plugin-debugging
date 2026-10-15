/**
 * 端口识别的三条平台分支（linux / darwin / win32）—— 每条都被**显式钉住**。
 *
 * ## 为什么这层能被 CI 真验证
 *
 * 本机是 Windows、CI 是 ubuntu，两边平台不同。所以：
 * - **绝不在用例里按真实 `process.platform` 分支**（那会让一半用例永不执行）；
 * - 每条用例用 `withPlatform('<platform>')` **声明**它测哪条分支，
 *   于是三条分支在**任意机器上都被真跑到**（活跃坑 25）。
 *
 * ## 三条纪律
 *
 * 1. **判据钉「平台标识」，不钉文案**：`detail` 里唯一稳定的是开头的 `linux:` / `darwin:` /
 *    `win32:`，后面那句会随实现改 —— 认文案等于让判据跟着实现漂成假绿。
 * 2. **判据钉「根因造成的事实」**，不是「不再报错」：例如「`ss -ltn` 读不到 pid 时
 *    `listening` 仍为 `true`」，断的是「结论」不是「没抛错」（活跃坑 37）。
 * 3. **替身被调用次数 > 0**：否则「注入没生效」会让判据假绿（活跃坑 18）。
 */
import { describe, expect, it } from 'vitest'

import {
  DARWIN_FALLBACK_COMMAND,
  DARWIN_LOOKUP_COMMAND,
  LINUX_LOOKUP_COMMAND,
  lookupPort,
  parseLsofOutput,
  parseNetstatOutput,
  parseSsOutput,
  portLookupPlan,
  PORT_LOOKUP_SHELL,
  WINDOWS_FALLBACK_COMMAND,
} from '../../src/lib/ports.ts'
import { cmdResult, recordingSpawn, withPlatform } from './helpers.ts'

/** 目标端口（三条分支共用，**显式**而不是从环境拿 —— 那才是写死平台行为）。 */
const PORT = 3080

/** `ss -ltnp` 的真实输出形状（Linux；`users:` 段需要权限才出现）。 */
const SS_WITH_PROCESS = [
  'State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process',
  'LISTEN 0      128          0.0.0.0:22              0.0.0.0:*',
  'LISTEN 0      511                0.0.0.0:3080            0.0.0.0:*         users:(("node",pid=4242,fd=20))',
  'LISTEN 0      128              127.0.0.1:9230              0.0.0.0:*         users:(("node",pid=77,fd=21))',
  '',
].join('\n')

/** `ss -ltn` 的真实输出形状（没有 `users:` 段 ⇒ 读不到 pid）。 */
const SS_WITHOUT_PROCESS = [
  'State  Recv-Q Send-Q Local Address:Port  Peer Address:Port',
  'LISTEN 0      128          0.0.0.0:22              0.0.0.0:*',
  'LISTEN 0      511                0.0.0.0:3080            0.0.0.0:*',
  '',
].join('\n')

/** `lsof -nP -iTCP:3080 -sTCP:LISTEN` 的真实输出形状（macOS）。 */
const LSOF_OUTPUT = [
  'COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
  'node    4242 speak   20u  IPv4 0x1234      0t0  TCP 127.0.0.1:3080 (LISTEN)',
  '',
].join('\n')

/** `netstat -an` 的真实输出形状（macOS；unix 域那一段混在里面，必须被跳过）。 */
const NETSTAT_OUTPUT = [
  'Active Internet connections (including servers)',
  'Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)',
  'tcp4       0      0  127.0.0.1.3080         *.*                    LISTEN',
  'tcp46      0      0  *.3080                 *.*                    LISTEN',
  'tcp4       0      0  127.0.0.1.22           *.*                    LISTEN',
  'udp4       0      0  *.5353                 *.*',
  'ffff0000  0      0  /var/run/mDNS.sock     => /tmp/other.sock',
  '',
].join('\n')

/**
 * `netstat -ano` 的真实输出形状（Windows；真机摘录，混着非监听态与 UDP 行）。
 *
 * ⚠️ 与上面 darwin 那份**形状完全不同**：状态在第 4 列且逐字为 `LISTENING`、
 * **末列是 pid**、本地地址用冒号分隔。按末列判 `LISTEN` 的写法会把这里每一行都丢掉。
 */
const NETSTAT_AN_OUTPUT = [
  '',
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    0.0.0.0:3080            0.0.0.0:0              LISTENING       4242',
  '  TCP    [::]:3080               [::]:0                 LISTENING       4242',
  '  TCP    127.0.0.1:4000          0.0.0.0:0              LISTENING       77',
  '  TCP    10.0.0.5:5231           10.0.0.8:443            ESTABLISHED     9',
  '  UDP    0.0.0.0:500            *:*                                    4600',
  '',
].join('\r\n')

describe('portLookupPlan · 三个平台各自的命令面', () => {
  // ⚠️ 这条用例的标题与 `toHaveLength` **2026-10-15 被有意改过**（Lead 拍板），
  // 理由写在这里，免得下一个人以为它在守某个不可动的约束：
  // 它原本逐字是「win32：**一次尝试**」+ `expect(plan?.attempts).toHaveLength(1)` ——
  // 钉的是「**win32 没有兜底**」这个**事实**，不是「win32 最多只能有一次尝试」这个**能力上限**。
  // 事实变了（`Get-NetTCPConnection` 缺 `NetTCPPowerShell` 模块时要有救），判据就得跟着变。
  //
  // **第一档一个字没动**：它仍是 `powershell.exe`、脚本仍按 `LocalPort` + `State` 过滤 ⇒
  // 下面那几条 `toContain` 断言（`-LocalPort 3080` / `-State Listen` / `not.toContain('bin.js')`）
  // **一条都不该动**，它们守的是「问的是哪个端口」与「不用命令行子串」这两条硬规矩。
  it('win32：两档 —— 第一档 PowerShell 按 LocalPort + State 过滤，第二档兜底 netstat -ano', () => {
    const plan = portLookupPlan('win32', PORT)

    // 顺序即优先级：第一档**可信**就返回，兜底只在主命令本身不可用时才被跑到。
    expect(plan?.attempts.map((attempt) => attempt.command)).toEqual([
      PORT_LOOKUP_SHELL,
      WINDOWS_FALLBACK_COMMAND,
    ])
    expect(plan?.attempts[0]?.command).toBe(PORT_LOOKUP_SHELL)
    const script = plan?.attempts[0]?.args.join(' ') ?? ''
    expect(script).toContain('-LocalPort 3080')
    expect(script).toContain('-State Listen')
    // 「不用命令行子串」是本仓硬规矩（派生 shell 会误匹配）。
    expect(script).not.toContain('bin.js')
    // 兜底那一档：`-ano` 列全表 + 解析器比对端口，**不是** `findstr :3080` 那种管道过滤
    // （那会把对端地址里含 `:3080` 的行也算进来）。这条不许被改回「按子串问端口」。
    expect(plan?.attempts[1]?.args).toEqual(['-ano'])
    expect(plan?.attempts[1]?.args.join(' ')).not.toContain('3080')
  })

  it('linux：两次尝试，同一个 ss，先带 -p 再不带', () => {
    const plan = portLookupPlan('linux', PORT)

    expect(plan?.attempts.map((a) => a.command)).toEqual([
      LINUX_LOOKUP_COMMAND,
      LINUX_LOOKUP_COMMAND,
    ])
    expect(plan?.attempts.map((a) => a.args)).toEqual([['-ltnp'], ['-ltn']])
  })

  it('darwin：先 lsof（带端口过滤），兜底 netstat -an', () => {
    const plan = portLookupPlan('darwin', PORT)

    expect(plan?.attempts.map((a) => a.command)).toEqual([
      DARWIN_LOOKUP_COMMAND,
      DARWIN_FALLBACK_COMMAND,
    ])
    // 端口必须落在参数里 —— 少传一个参数就会让命令去列**所有**监听者。
    expect(plan?.attempts[0]?.args).toEqual(['-nP', '-iTCP:3080', '-sTCP:LISTEN'])
    expect(plan?.attempts[1]?.args).toEqual(['-an'])
  })

  it('方案里的端口与解析器是同一个（问 3080 不会去查 0）', () => {
    // 端口同时出现在**参数**（`-iTCP:3080`、PowerShell 脚本）与**解析器闭包**里。
    // 任何一处漏掉都不报错，只会安静地报告「没人听」。
    //
    // linux 的 `ss` **不按端口过滤**（解析器自己按值匹配行），所以那条只能验解析器；
    // win32 的表与端口无关（PowerShell 已在参数里过滤），所以那条只能验参数。
    const win32 = portLookupPlan('win32', PORT)
    expect(win32?.attempts[0]?.args.join(' ')).toContain('3080')

    const darwin = portLookupPlan('darwin', PORT)
    expect(darwin?.attempts[0]?.args.join(' ')).toContain('-iTCP:3080')
    // 兜底那条不过滤端口，但解析器必须认得目标端口。
    expect(darwin?.attempts[1]?.parse(NETSTAT_OUTPUT).unidentified).toBe(2)
    expect(darwin?.attempts[1]?.parse(NETSTAT_OUTPUT.replaceAll('3080', '9999')).unidentified).toBe(
      0,
    )

    const linux = portLookupPlan('linux', PORT)
    expect(linux?.attempts[0]?.parse(SS_WITH_PROCESS).listeners).toHaveLength(1)
    // 同一个解析器换个端口就认不出来 ⇒ 它真的绑在 PORT 上（若绑成 0，上面那条就恒空）。
    expect(linux?.attempts[0]?.parse(SS_WITH_PROCESS.replaceAll('3080', '9999')).listeners).toEqual(
      [],
    )
  })

  it('没有命令方案的平台 → undefined（不是「没人听」）', () => {
    expect(portLookupPlan('aix', PORT)).toBeUndefined()
    expect(portLookupPlan('sunos', PORT)).toBeUndefined()
  })
})

describe('parseSsOutput · ss -ltnp 那一列是怎么解析的', () => {
  it('认端口靠「值」不靠「列号」：目标端口在第 4 列也照样命中', () => {
    const table = parseSsOutput(SS_WITH_PROCESS, PORT)

    expect(table.listeners).toHaveLength(1)
    expect(table.listeners[0]).toEqual({ pid: 4242, processName: 'node' })
  })

  it('别的端口的行不进 listeners，但**计入 rows**（说明这张表被读懂了）', () => {
    const table = parseSsOutput(SS_WITH_PROCESS, PORT)

    // `rows` 是「我认得这张表」的证据：目标端口没人听时它 > 0 而命中为 0，
    // `attemptIsTrusted` 靠它区分「真没人听」与「输出形状不对」。
    // 3 = 1 行表头 + 3 行数据行（22 / 3080 / 9230）。
    expect(table.rows).toBe(4)
    expect(table.unidentified).toBe(0)
    expect(table.listeners.map((l) => l.pid)).not.toContain(77)
  })

  it('只有表头（一个 TCP 监听都没有）→ rows=1：空表也是「读懂了」的正面证据', () => {
    // 真机上会发生：容器里若真没有 TCP 监听者，`ss -ltn` 就只打印表头。
    // 把它当成「形状不对」会把「确实没人听」报成「查不了」。
    const table = parseSsOutput(
      'State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process\n',
      PORT,
    )

    expect(table.rows).toBe(1)
    expect(table.listeners).toEqual([])
  })

  it('表头被跳过（ss 在非 tty 下也打印表头）', () => {
    const table = parseSsOutput(
      'State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process\n',
      PORT,
    )

    expect(table.listeners).toEqual([])
    expect(table.unidentified).toBe(0)
  })

  it('同一行多个进程（SO_REUSEPORT）→ 每个 pid 一条，名字按下标配', () => {
    const table = parseSsOutput(
      'LISTEN 0 128 0.0.0.0:3080 0.0.0.0:* users:(("nginx",pid=11,fd=6),("nginx",pid=12,fd=6))\n',
      PORT,
    )

    expect(table.listeners).toEqual([
      { pid: 11, processName: 'nginx' },
      { pid: 12, processName: 'nginx' },
    ])
  })

  it('有端口行但没有 users: 段 → unidentified（不是「没人听」）', () => {
    const table = parseSsOutput(SS_WITHOUT_PROCESS, PORT)

    expect(table.listeners).toEqual([])
    expect(table.unidentified).toBe(1)
    expect(table.rows).toBe(3)
  })

  it('IPv6 字面量也能命中（地址里的冒号不该把匹配带偏）', () => {
    const table = parseSsOutput(
      'LISTEN 0 128 [::1]:3080 [::]:* users:(("node",pid=9,fd=3))\n',
      PORT,
    )

    expect(table.listeners).toEqual([{ pid: 9, processName: 'node' }])
  })

  it('非 LISTEN 状态不认；形状不对的行走「降级」而不是「按某列猜」', () => {
    // ESTAB 行：`-l` 模式下不会出现，但解析器不该因为没有状态过滤就把它算进来。
    const established = parseSsOutput(
      'ESTAB 0 0 10.0.0.1:3080 10.0.0.2:5555 users:(("x",pid=1,fd=1))\n',
      PORT,
    )
    expect(established.rows).toBe(0)
    expect(established.listeners).toEqual([])

    // 形状不对（Recv-Q 不是数字）⇒ 这一行**不认得**，`rows` 不加 ——
    // 宁可少认一行，也不要在不知道列义的情况下猜一个 pid 出来。
    const unknownShape = parseSsOutput(
      'LISTEN x 128 0.0.0.0:3080 0.0.0.0:* users:(("x",pid=1,fd=1))\n',
      PORT,
    )
    expect(unknownShape.rows).toBe(0)
    expect(unknownShape.listeners).toEqual([])
  })

  it('⚠️ 只看本地地址列：对端地址里出现目标端口不会被误认成监听者', () => {
    // 这条是「扫全行找 :port」那个写法的**否证**。真机上 `ss -ltn` 的对端恒为 `*`
    // 撞不上，但「恰好撞不上」是静默坏掉的典型前提。
    const peerPort = parseSsOutput(
      'LISTEN 0 128 0.0.0.0:22 1.2.3.4:3080 users:(("x",pid=1,fd=1))\n',
      PORT,
    )

    expect(peerPort.rows).toBe(1)
    expect(peerPort.listeners).toEqual([])
    expect(peerPort.unidentified).toBe(0)
  })
})

describe('parseLsofOutput · lsof -i 那一列是怎么解析的', () => {
  it('前两列取进程名与 pid，末列（含空格）判监听态与端口', () => {
    const table = parseLsofOutput(LSOF_OUTPUT, PORT)

    expect(table.rows).toBe(2)
    expect(table.listeners).toEqual([{ pid: 4242, processName: 'node' }])
  })

  it('表头被跳过；列宽变化（列数不同）不影响取值', () => {
    const table = parseLsofOutput(
      'COMMAND  PID USER  FD  TYPE  DEVICE SIZE/OFF NODE NAME\n' +
        'code  77  me  3u  IPv6  0x1      0t0    TCP *:3080 (LISTEN)\n',
      PORT,
    )

    expect(table.rows).toBe(2)
    expect(table.listeners).toEqual([{ pid: 77, processName: 'code' }])
  })

  it('端口不是目标的那一行：算「认得这张表」，但不算命中', () => {
    const table = parseLsofOutput(
      'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode 1 me 20u IPv4 0x1 0t0 TCP 127.0.0.1:9229 (LISTEN)\n',
      PORT,
    )

    expect(table.rows).toBe(2)
    expect(table.listeners).toEqual([])
    expect(table.unidentified).toBe(0)
  })

  it('非 LISTEN 的连接（ESTABLISHED）不认成监听', () => {
    const table = parseLsofOutput(
      'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode 1 me 20u IPv4 0x1 0t0 TCP 127.0.0.1:3080 (ESTABLISHED)\n',
      PORT,
    )

    // 1 = 只有表头；ESTABLISHED 那行不认。
    expect(table.rows).toBe(1)
    expect(table.listeners).toEqual([])
  })

  it('进程名里带冒号带端口，也不能被误认成目标端口的监听者', () => {
    // 反例护栏：`-iTCP:` 过滤已由命令承担，但解析器仍按值复核 ——
    // 这里证明复核用的是**行尾那一段**，不是「行里出现过这个数字」。
    const table = parseLsofOutput(
      'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nodd:3080 5 me 20u IPv4 0x1 0t0 TCP *:9229 (LISTEN)\n',
      PORT,
    )

    expect(table.listeners).toEqual([])
  })
})

describe('parseNetstatOutput · netstat -an 那一列是怎么解析的', () => {
  it('命中目标端口的行（两条：v4 与 v6）→ 一律 unidentified（netstat 不给 pid）', () => {
    const table = parseNetstatOutput(NETSTAT_OUTPUT, PORT)

    expect(table.rows).toBe(4)
    expect(table.unidentified).toBe(2)
    expect(table.listeners).toEqual([])
  })

  it('unix 域那一段与非 tcp 的行被跳过', () => {
    const unixOnly = parseNetstatOutput(
      'Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)\n' +
        'ffff0000  0      0  /var/run/mDNS.sock     => /tmp/other.sock\n' +
        'udp4       0      0  *.5353                 *.*\n',
      PORT,
    )

    // 1 = 只有表头；unix 与 udp 两行都不认。
    expect(unixOnly.rows).toBe(1)
    expect(unixOnly.unidentified).toBe(0)
  })

  it('对端 `*.*` 不会被当成端口', () => {
    const peerOnly = parseNetstatOutput(
      'Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)\n' +
        'tcp4       0      0  127.0.0.1.22           1.2.3.4.3080           ESTABLISHED\n',
      PORT,
    )

    // 1 = 只有表头；那行是 ESTABLISHED（末列不是 LISTEN），不认。
    expect(peerOnly.rows).toBe(1)
    expect(peerOnly.unidentified).toBe(0)
  })
})

describe('lookupPort · linux 分支（显式钉住 linux）', () => {
  it('ss -ltnp 一次就命中 → probed=true，端口上有人听', async () => {
    await withPlatform('linux', async () => {
      const { spawn, calls } = recordingSpawn(() => cmdResult({ stdout: SS_WITH_PROCESS }))

      const result = await lookupPort(PORT, { spawn, timeoutMs: 1_000 })

      expect(result.probed).toBe(true)
      expect(result.listening).toBe(true)
      expect(result.listeners).toEqual([{ pid: 4242, processName: 'node' }])
      // 一次就够：不许再跑兜底。
      expect(calls).toHaveLength(1)
      expect(calls[0]?.command).toBe(LINUX_LOOKUP_COMMAND)
      expect(calls[0]?.args).toEqual(['-ltnp'])
    })
  })

  it('目标端口没人听（表头仍在、rows>0）→ probed=true 且 listening=false', async () => {
    await withPlatform('linux', async () => {
      // 真机上最常见的情形：`ss` 照样打印表头，所以 stdout 非空。
      const { spawn, calls } = recordingSpawn(() =>
        cmdResult({
          stdout:
            'State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process\nLISTEN 0 128 0.0.0.0:22 0.0.0.0:*\n',
        }),
      )

      const result = await lookupPort(PORT, { spawn, timeoutMs: 1_000 })

      expect(result.probed).toBe(true)
      expect(result.listening).toBe(false)
      expect(result.listeners).toEqual([])
      expect(calls).toHaveLength(1)
    })
  })

  it('输出空且 exit 0 → probed=true 且 listening=false（空表 = 真没人听）', async () => {
    await withPlatform('linux', async () => {
      const { spawn } = recordingSpawn(() => cmdResult({ stdout: '' }))

      const result = await lookupPort(PORT, { spawn, timeoutMs: 1_000 })

      expect(result.probed).toBe(true)
      expect(result.listening).toBe(false)
    })
  })

  it('-p 拿不到 pid → listening 仍是 true（根因事实：端口上确实有东西）', async () => {
    await withPlatform('linux', async () => {
      const { spawn } = recordingSpawn(() => cmdResult({ stdout: SS_WITHOUT_PROCESS }))

      const result = await lookupPort(PORT, { spawn, timeoutMs: 1_000 })

      // 这条是「断根因」的断言：把 listening 改成 false（=「当成没人听」）
      // 就得红 —— 那正是活跃坑那一族的反向结论。
      expect(result.probed).toBe(true)
      expect(result.listening).toBe(true)
      expect(result.listeners).toEqual([])
    })
  })

  it('ss 没装 / 不支持 -p（第一次非零退出）→ 兜底 ss -ltn 顶上', async () => {
    await withPlatform('linux', async () => {
      const { spawn, calls } = recordingSpawn((options) =>
        // 只有第一次（-ltnp）失败 —— 兜底（-ltn）给出一张认得的表。
        options.args.join(' ') === '-ltnp'
          ? cmdResult({ code: 1, stderr: 'ss: unsupported option' })
          : cmdResult({ stdout: SS_WITHOUT_PROCESS }),
      )

      const result = await lookupPort(PORT, { spawn, timeoutMs: 1_000 })

      expect(calls.map((c) => c.args.join(' '))).toEqual(['-ltnp', '-ltn'])
      expect(result.probed).toBe(true)
      expect(result.listening).toBe(true)
      expect(result.listeners).toEqual([])
    })
  })

  it('⚠️ ss 完全不存在（容器里常见）→ probed=false，**不是** listening=false', async () => {
    await withPlatform('linux', async () => {
      // 两个尝试都 ENOENT：`spawn` 报「可执行文件不存在」而不是「没人听」。
      const { spawn, calls } = recordingSpawn(() =>
        cmdResult({ code: null, spawnError: 'spawn: ENOENT' }),
      )

      const result = await lookupPort(PORT, { spawn, timeoutMs: 1_000 })

      // 两条尝试都被真跑到（不是「第一条失败就放弃」）。
      expect(calls).toHaveLength(2)
      expect(result.probed).toBe(false)
      expect(result.listening).toBe(false)
      // 判据认平台标识，不认后面那句文案。
      expect(result.detail.startsWith('linux:')).toBe(true)
      expect(result.detail).toContain('ENOENT')
    })
  })

  it('两条都不认得的输出 → probed=false（形状不对 ≠ 没人听）', async () => {
    await withPlatform('linux', async () => {
      // 喂的是 Windows 那张 `pid|name|start` 表：ss 解析器读它，一行都不认。
      const { spawn, calls } = recordingSpawn(() =>
        cmdResult({ stdout: '4242|node|2026-10-12T20:00:00.0000000+08:00\n' }),
      )

      const result = await lookupPort(PORT, { spawn, timeoutMs: 1_000 })

      expect(calls).toHaveLength(2)
      expect(result.probed).toBe(false)
      expect(result.detail.startsWith('linux:')).toBe(true)
    })
  })

  it('有 stderr 且没命中 → 不可信（权限不足的告警不能被读成「没人听」）', async () => {
    await withPlatform('linux', async () => {
      const { spawn } = recordingSpawn(() =>
        cmdResult({ stdout: 'State Recv-Q Send-Q\n', stderr: 'ss: permission denied' }),
      )

      const result = await lookupPort(PORT, { spawn, timeoutMs: 1_000 })

      expect(result.probed).toBe(false)
      expect(result.listening).toBe(false)
    })
  })

  it('超时 / 调用方取消不重试（两条尝试都不该被跑到）', async () => {
    await withPlatform('linux', async () => {
      const timedOut = recordingSpawn(() => cmdResult({ code: null, timedOut: true }))
      const aborted = recordingSpawn(() => cmdResult({ code: null, aborted: true }))

      const timeoutResult = await lookupPort(PORT, { spawn: timedOut.spawn, timeoutMs: 1_000 })
      const abortResult = await lookupPort(PORT, { spawn: aborted.spawn, timeoutMs: 1_000 })

      expect(timeoutResult.probed).toBe(false)
      expect(timeoutResult.detail).toContain('timed out')
      expect(abortResult.probed).toBe(false)
      expect(abortResult.detail).toContain('cancelled')
      expect(timedOut.calls).toHaveLength(1)
      expect(aborted.calls).toHaveLength(1)
    })
  })

  it('signal 与预算透传到每一次尝试', async () => {
    await withPlatform('linux', async () => {
      const controller = new AbortController()
      const { spawn, calls } = recordingSpawn(() =>
        cmdResult({ code: null, spawnError: 'spawn: ENOENT' }),
      )

      await lookupPort(PORT, { spawn, timeoutMs: 4_321, signal: controller.signal })

      expect(calls).toHaveLength(2)
      for (const call of calls) {
        expect(call.timeoutMs).toBe(4_321)
        expect(call.signal).toBe(controller.signal)
      }
    })
  })
})

describe('lookupPort · darwin 分支（显式钉住 darwin）', () => {
  it('lsof 命中 → probed=true，取到 pid 与进程名', async () => {
    await withPlatform('darwin', async () => {
      const { spawn, calls } = recordingSpawn(() => cmdResult({ stdout: LSOF_OUTPUT }))

      const result = await lookupPort(PORT, { spawn, timeoutMs: 1_000 })

      expect(result.probed).toBe(true)
      expect(result.listening).toBe(true)
      expect(result.listeners).toEqual([{ pid: 4242, processName: 'node' }])
      expect(calls).toHaveLength(1)
      expect(calls[0]?.command).toBe(DARWIN_LOOKUP_COMMAND)
      expect(calls[0]?.args).toContain('-iTCP:3080')
    })
  })

  it('lsof 没装（精简安装常见）→ 兜底 netstat -an → listening=true 但无 pid', async () => {
    await withPlatform('darwin', async () => {
      const { spawn, calls } = recordingSpawn((options) =>
        options.command === DARWIN_LOOKUP_COMMAND
          ? cmdResult({ code: null, spawnError: 'spawn: ENOENT' })
          : cmdResult({ stdout: NETSTAT_OUTPUT }),
      )

      const result = await lookupPort(PORT, { spawn, timeoutMs: 1_000 })

      expect(calls.map((c) => c.command)).toEqual([DARWIN_LOOKUP_COMMAND, DARWIN_FALLBACK_COMMAND])
      // 根因事实：netstat 看得见「有人在听」，只是给不出 pid —— 所以 listening 为 true。
      expect(result.probed).toBe(true)
      expect(result.listening).toBe(true)
      expect(result.listeners).toEqual([])
    })
  })

  it('两个命令都没有 → probed=false，detail 带 darwin 标识', async () => {
    await withPlatform('darwin', async () => {
      const { spawn, calls } = recordingSpawn(() =>
        cmdResult({ code: null, spawnError: 'spawn: ENOENT' }),
      )

      const result = await lookupPort(PORT, { spawn, timeoutMs: 1_000 })

      expect(calls).toHaveLength(2)
      expect(result.probed).toBe(false)
      expect(result.detail.startsWith('darwin:')).toBe(true)
    })
  })
})

describe('lookupPort · win32 分支（回归网：改非 Windows 分支不许把这条退掉）', () => {
  it('powershell 命中 → probed=true / listening=true', async () => {
    await withPlatform('win32', async () => {
      const { spawn, calls } = recordingSpawn(() =>
        cmdResult({ stdout: '4242|node|2026-10-12T20:00:00.0000000+08:00\n' }),
      )

      const result = await lookupPort(PORT, { spawn, timeoutMs: 1_000 })

      expect(result.probed).toBe(true)
      expect(result.listening).toBe(true)
      expect(result.listeners[0]?.pid).toBe(4242)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.command).toBe(PORT_LOOKUP_SHELL)
    })
  })

  it('linux 分支的命令绝不出现在 win32 上（一次都不许调 ss）', async () => {
    await withPlatform('win32', async () => {
      const { spawn, calls } = recordingSpawn(() => cmdResult({ stdout: '' }))

      await lookupPort(PORT, { spawn, timeoutMs: 1_000 })

      expect(calls.map((c) => c.command)).toEqual([PORT_LOOKUP_SHELL])
    })
  })
})

describe('lookupPort · win32 兜底：Get-NetTCPConnection 缺模块时退到 netstat -ano', () => {
  // ## 为什么这条族必须也有兜底（2026-10-15 补的理由）
  //
  // `Get-NetTCPConnection` 缺 `NetTCPPowerShell` 模块**同时打断两条路**，只补一条是修一半：
  //
  // | 路 | 消费者 | 兜底在哪 |
  // |---|---|---|
  // | 列全部监听者 | `dsh_list_instances` | `listenerScanAttempts` 的第二档 |
  // | 查单个端口 `lookupPort` | **`dsh_check_auth`** · **`dsh_dump_config`** | **就是这里** |
  //
  // ⇒ 不补的话，在那类机器上 8 个工具里有 2 个照样读不到端口。**修一个落点 ≠ 扫一族。**
  //
  // ⚠️ 每条用例都把**构造与执行整段**包进 `withPlatform('win32', …)`（坑 25 的隐蔽变体：
  // 只包构造、让 `execute` 落在平台恢复之后 = 等于没包）。

  it('主命令成功 ⇒ **兜底一次都不跑**（计数断言；白跑一条只是白花一次进程预算）', async () => {
    await withPlatform('win32', async () => {
      const { spawn, calls } = recordingSpawn(() =>
        cmdResult({ stdout: '4242|node|2026-10-12T20:00:00.0000000+08:00\n' }),
      )

      const result = await lookupPort(PORT, { spawn, timeoutMs: 1_000 })

      expect(result.probed).toBe(true)
      expect(result.listeners[0]?.pid).toBe(4242)
      expect(calls.map((call) => call.command)).toEqual([PORT_LOOKUP_SHELL])
    })
  })

  it('主命令起不了进程 ⇒ 兜底**真被跑到**且结果可用（能读到 pid）', async () => {
    await withPlatform('win32', async () => {
      const { spawn, calls } = recordingSpawn((options) =>
        options.command === PORT_LOOKUP_SHELL
          ? cmdResult({ code: null, spawnError: 'spawn: ENOENT' })
          : cmdResult({ stdout: NETSTAT_AN_OUTPUT }),
      )

      const result = await lookupPort(PORT, { spawn, timeoutMs: 1_000 })

      expect(calls.map((call) => call.command)).toEqual([
        PORT_LOOKUP_SHELL,
        WINDOWS_FALLBACK_COMMAND,
      ])
      expect(result.probed).toBe(true)
      // 根因事实（坑 37：断的是事实，不是症状）：那台机器上 3080 真的有人在听。
      expect(result.listening).toBe(true)
      // `-o` 给了 pid ⇒ 双栈那两行折叠成**同一个 pid 一条**（不是「2 个监听者」）。
      expect(result.listeners).toEqual([{ pid: 4242, processName: '(unknown)' }])
      // 别的端口不许混进来（只认目标端口那一列，不扫全行）。
      expect(result.listeners.map((listener) => listener.pid)).not.toContain(77)
    })
  })

  it('主命令非零退出 + stderr（模块缺失长这样）⇒ 兜底顶上', async () => {
    await withPlatform('win32', async () => {
      const { spawn, calls } = recordingSpawn((options) =>
        options.command === PORT_LOOKUP_SHELL
          ? cmdResult({ code: 1, stderr: 'The term Get-NetTCPConnection is not recognized' })
          : cmdResult({ stdout: NETSTAT_AN_OUTPUT }),
      )

      const result = await lookupPort(PORT, { spawn, timeoutMs: 1_000 })

      expect(calls.map((call) => call.command)).toEqual([
        PORT_LOOKUP_SHELL,
        WINDOWS_FALLBACK_COMMAND,
      ])
      expect(result.probed).toBe(true)
      expect(result.listening).toBe(true)
      expect(result.listeners.map((listener) => listener.pid)).toEqual([4242])
    })
  })

  it('兜底读到表、但目标端口没人听 ⇒ probed=true 且 listening=false（**不是** probed=false）', async () => {
    await withPlatform('win32', async () => {
      const { spawn, calls } = recordingSpawn((options) =>
        options.command === PORT_LOOKUP_SHELL
          ? cmdResult({ code: null, spawnError: 'spawn: ENOENT' })
          : cmdResult({ stdout: NETSTAT_AN_OUTPUT.replaceAll('3080', '9999') }),
      )

      const result = await lookupPort(PORT, { spawn, timeoutMs: 1_000 })

      expect(calls).toHaveLength(2)
      // 「表被读懂了、里面没有这一行」= 真的没人听 ⇒ 与「查不了」必须是两件事。
      expect(result.probed).toBe(true)
      expect(result.listening).toBe(false)
      expect(result.listeners).toEqual([])
    })
  })

  it('⚠️ 兜底读得到表、但**读不到 pid** ⇒ listening 仍是 true（这是最容易写塌的一处）', async () => {
    await withPlatform('win32', async () => {
      // `netstat -an`（漏了 `-o`）那一档：端口看得见、pid 那一列不存在。
      // 把它写成 `listening: false` 就是「把『查不到是谁』说成『没人听』」—— 反向结论。
      const withoutPid = NETSTAT_AN_OUTPUT.replace(
        /^.*LISTENING\s+\d+\r?$/gmu,
        '  TCP    0.0.0.0:3080            0.0.0.0:0              LISTENING',
      )
      const { spawn } = recordingSpawn((options) =>
        options.command === PORT_LOOKUP_SHELL
          ? cmdResult({ code: null, spawnError: 'spawn: ENOENT' })
          : cmdResult({ stdout: withoutPid }),
      )

      const result = await lookupPort(PORT, { spawn, timeoutMs: 1_000 })

      expect(result.probed).toBe(true)
      expect(result.listening).toBe(true)
      expect(result.listeners).toEqual([])
    })
  })

  it('两档都不可用 ⇒ probed=false，**不是** listening=false（四态不许塌成两态）', async () => {
    await withPlatform('win32', async () => {
      const { spawn, calls } = recordingSpawn(() =>
        cmdResult({ code: null, spawnError: 'spawn: ENOENT' }),
      )

      const result = await lookupPort(PORT, { spawn, timeoutMs: 1_000 })

      // 两条尝试都被真跑到（不是「第一条失败就放弃」）。
      expect(calls).toHaveLength(2)
      expect(result.probed).toBe(false)
      expect(result.listening).toBe(false)
      // 判据认平台标识，不认后面那句文案。
      expect(result.detail.startsWith('win32:')).toBe(true)
      expect(result.detail).toContain('ENOENT')
    })
  })

  it('兜底那一档真的**按字段比对端口**：换个端口问就认不出来（钉住「不是命令行子串匹配」）', async () => {
    await withPlatform('win32', async () => {
      const { spawn } = recordingSpawn((options) =>
        options.command === PORT_LOOKUP_SHELL
          ? cmdResult({ code: null, spawnError: 'spawn: ENOENT' })
          : cmdResult({ stdout: NETSTAT_AN_OUTPUT }),
      )

      const hit = await lookupPort(PORT, { spawn, timeoutMs: 1_000 })
      const miss = await lookupPort(4000, { spawn, timeoutMs: 1_000 })
      const absent = await lookupPort(9999, { spawn, timeoutMs: 1_000 })

      expect(hit.listening).toBe(true)
      expect(hit.listeners.map((listener) => listener.pid)).toEqual([4242])
      // 问 4000 时认出来的是 4000 那一行（pid 77），不是表里第一个端口 ——
      // 「扫全行取第一个 `:port`」的写法在这里会答成 3080。
      expect(miss.listeners.map((listener) => listener.pid)).toEqual([77])
      expect(absent.listening).toBe(false)
      expect(absent.probed).toBe(true)
    })
  })

  it('⚠️ 对端地址里含目标端口的行**不许**被算成监听者（钉住「不扫全行」）', async () => {
    await withPlatform('win32', async () => {
      // 若兜底写成 `findstr :3080` 之类的管道过滤，这一行就会被算进来 ⇒ 报出一个
      // 根本不监听 3080 的 pid。反过来，正确实现只认**本地地址那一列**。
      const peerPort = NETSTAT_AN_OUTPUT.replace(
        '  TCP    127.0.0.1:4000          0.0.0.0:0              LISTENING       77',
        '  TCP    127.0.0.1:4000          10.0.0.8:3080            LISTENING       77',
      )
      const { spawn } = recordingSpawn((options) =>
        options.command === PORT_LOOKUP_SHELL
          ? cmdResult({ code: null, spawnError: 'spawn: ENOENT' })
          : cmdResult({ stdout: peerPort }),
      )

      const result = await lookupPort(PORT, { spawn, timeoutMs: 1_000 })

      expect(result.listeners.map((listener) => listener.pid)).toEqual([4242])
      expect(result.listeners.map((listener) => listener.pid)).not.toContain(77)
    })
  })
})

describe('lookupPort · 不支持的平台', () => {
  it('aix：一次都不 spawn → probed=false，detail 带平台标识', async () => {
    await withPlatform('aix', async () => {
      const { spawn, calls } = recordingSpawn(() => cmdResult({ stdout: '4242|node|\n' }))

      const result = await lookupPort(PORT, { spawn, timeoutMs: 1_000 })

      expect(calls).toHaveLength(0)
      expect(result.probed).toBe(false)
      expect(result.listening).toBe(false)
      // 「查不了」与「没人听」必须是两件事 —— 这里钉住前者。
      expect(result.detail.startsWith('aix:')).toBe(true)
    })
  })
})

describe('三条分支的共同不变量', () => {
  const platforms: NodeJS.Platform[] = ['win32', 'linux', 'darwin']

  it('probed=false 时 detail 一律以平台标识开头（判据认标识，不认文案）', async () => {
    for (const platform of platforms) {
      await withPlatform(platform, async () => {
        const { spawn } = recordingSpawn(() =>
          cmdResult({ code: null, spawnError: 'spawn: ENOENT' }),
        )

        const result = await lookupPort(PORT, { spawn, timeoutMs: 1_000 })

        expect(result.probed).toBe(false)
        expect(
          result.detail.startsWith(`${platform}:`),
          `${platform} 分支的 detail 缺少平台标识：${result.detail}`,
        ).toBe(true)
      })
    }
  })

  it('「查不了」与「没人听」在三种取值下互不重叠（下游不用猜）', async () => {
    type Platform = 'win32' | 'linux' | 'darwin'
    /**
     * 每档给**各平台自己的**语料。
     *
     * 为什么不给一份通用语料：Windows 那张 `pid|name|start` 表对 ss/lsof/netstat 都不认，
     * 反过来 ss 的表对 PowerShell 解析器也不认 —— 套一份会让两边的「形状不认」变成同义反复。
     *
     * `covers` 显式写出**哪几个平台表达得出这一档**，末尾断言它们的并集仍是三个平台 ——
     * 「某个平台表达不出某一档」是事实（「不许静默 skip」），但**并集不许缩小**，
     * 否则删掉一条覆盖就没人看得见。
     */
    const cases: Array<{
      label: string
      covers: readonly Platform[]
      stdout: Partial<Record<Platform, string>>
      expectProbed: boolean
      expectListening: boolean
    }> = [
      {
        label: '空表（真没人听）',
        covers: ['win32', 'linux', 'darwin'],
        stdout: {
          win32: '',
          // `ss` 在没人听时仍打印表头 —— 那张表**被读懂了**，所以是「没人听」不是「查不了」。
          linux: 'State  Recv-Q Send-Q Local Address:Port  Peer Address:Port\n',
          darwin: 'COMMAND  PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\n',
        },
        expectProbed: true,
        expectListening: false,
      },
      {
        label: '有表但没命中（也是没人听）',
        // win32 表达不出这一档：那张表每一行都自带 pid，
        // 「认得但没命中」在它那儿只能是空输出（已由上一档覆盖）。
        covers: ['linux', 'darwin'],
        stdout: {
          linux: SS_WITH_PROCESS.replaceAll('3080', '9999'),
          darwin: LSOF_OUTPUT.replaceAll('3080', '9999'),
        },
        expectProbed: true,
        expectListening: false,
      },
      {
        label: '有进程但读不到 pid',
        // 同理：Windows 的解析器要么给得出 pid，要么这一行就不认。
        covers: ['linux', 'darwin'],
        stdout: { linux: SS_WITHOUT_PROCESS, darwin: NETSTAT_OUTPUT },
        expectProbed: true,
        expectListening: true,
      },
      {
        label: '形状不认（查不了）',
        covers: ['win32', 'linux', 'darwin'],
        stdout: { win32: 'x', linux: 'x', darwin: 'x' },
        expectProbed: false,
        expectListening: false,
      },
    ]

    for (const item of cases) {
      for (const platform of item.covers) {
        await withPlatform(platform, async () => {
          const { spawn } = recordingSpawn(() => cmdResult({ stdout: item.stdout[platform] ?? '' }))

          const result = await lookupPort(PORT, { spawn, timeoutMs: 1_000 })

          expect(
            result.probed,
            `${platform} / ${item.label}：probed=${String(result.probed)} detail=${result.detail}`,
          ).toBe(item.expectProbed)
          expect(
            result.listening,
            `${platform} / ${item.label}：listening=${String(result.listening)} detail=${result.detail}`,
          ).toBe(item.expectListening)
        })
      }
    }

    // 覆盖面不许缩：三个平台都得被至少一档钉住。
    const covered = [...new Set(cases.flatMap((item) => item.covers))].sort()
    expect(covered).toEqual(['darwin', 'linux', 'win32'])
  })

  it('lookupPort 不吞 spawn 实现抛出的异常（承重条件在**工具层**的顶层 try/catch 上）', async () => {
    // 这条刻意**反着**钉：本层只把「命令跑出了坏结果」收敛成 `probed: false`，
    // 而「注入的实现自己炸了」由**工具层**的顶层 try/catch 接住（B24）。
    // 本层再加一层 try/catch 只会把两种失败抹平成一种，所以这里钉住边界不许糊。
    for (const platform of platforms) {
      await withPlatform(platform, async () => {
        await expect(
          lookupPort(PORT, {
            spawn: () => Promise.reject(new Error('spawn exploded')),
            timeoutMs: 1_000,
          }),
        ).rejects.toThrow('spawn exploded')
      })
    }
  })
})
