import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * `scripts/release-guard.mjs` 的回归判据。
 *
 * 被测物是**真闸门**，不是普通工具：release.yml 里
 * `git diff --name-only 上个tag..HEAD | node scripts/release-guard.mjs` —— 它的退出码决定这次 tag 发不发。
 * 在写这份判据之前，全仓对它零测试；而它已经被证伪过一次（pnpm 迁移时清单里
 * `package-lock.json` 换成 `pnpm-lock.yaml`，变异结果是**红→绿反转**：只改锁文件的改动被当成
 * 「有产物改动」放行了一次不该发的版）。
 *
 * 运行上下文（坑 24）：本文件**真跑子进程**（`process.execPath` + 管道 stdio），不 import 脚本内部 ——
 * 它是顶层直接 `process.exit()` 的 CLI、没有任何导出，而且判定输入读的是 fd 0。
 * 已实测：本机 Node 上管道 stdio 可用（正常退出码、中文输出完整、`result.error` 为空）。
 * 若哪天在受限环境里报 EPERM，`runGuard` 的第一条断言会直接点明「子进程没起来」——
 * 而不是让后面那一串退出码断言静默地变成另一种意思。
 *
 * 判据形状：每条都断言**退出码 + 输出文本**。只断退出码会放过一半的错法 ——
 * 「永远 exit 0」与「永远 exit 1」各能骗过其中一半；输出里那两行按类计数才是
 * 「分类真的发生过」的证据。
 *
 * 已知限度：
 * ① `process.stdin.isTTY` 那条分支（没有 stdin ⇒ exit 2）在子进程里造不出来 ——
 *    管道 stdin 的 `isTTY` 恒为 undefined。本文件不覆盖它，也不假装覆盖了。
 * ② 路径清单是脚本里的字面量，本文件按两条腿覆盖：显式那几条钉住「锁文件」这一格（本次变异的目标），
 *    解析真源那条保证以后往清单里加的条目也会被真跑一遍。
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const GUARD = resolve(REPO_ROOT, 'scripts', 'release-guard.mjs')

/** 脚本源码。路径清单的真源从这里读，不在测试里手抄一份会漂的副本。 */
const SOURCE = readFileSync(GUARD, 'utf8')

interface GuardRun {
  status: number | null
  stdout: string
  stderr: string
}

/**
 * 真跑一次闸门。
 *
 * @param input 喂给 stdin 的改动清单（`git diff --name-only` 的形状）。
 * @param args 命令行参数，省略即 `argv` 为空。
 * @param env 省略则**原样继承**环境；脚本只读 argv 与 stdin，不读任何环境变量
 *            （下面「判定不依赖环境变量」那条用一个最小环境复跑同一输入来钉这一点）。
 */
function runGuard(input: string, args: readonly string[] = [], env?: NodeJS.ProcessEnv): GuardRun {
  const result = spawnSync(process.execPath, [GUARD, ...args], {
    cwd: REPO_ROOT,
    input,
    encoding: 'utf8',
    ...(env === undefined ? {} : { env }),
  })
  // 子进程起不来时 `status` 是 null、`error` 有值 —— 那种情况下面的退出码断言全都无意义，
  // 所以先在这里点名，别让它伪装成「闸门判错了」。
  expect(
    result.error,
    `release-guard 子进程没起来：${String(result.error)}。管道 stdio 不可用时结论一律不成立。`,
  ).toBeUndefined()
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/**
 * 从脚本源码里读出一份字符串字面量清单（真源）。
 *
 * @param name 脚本里的常量名。
 * @returns 清单里的条目；解析不出来就是空数组（调用方必须自己防「空转」）。
 */
function readStringList(name: string): string[] {
  const pattern = new RegExp(`const ${name} = (?:new Set\\(\\[|\\[)([\\s\\S]*?)\\]`, 'u')
  const match = pattern.exec(SOURCE)
  if (match === null) return []
  return [...match[1].matchAll(/'([^']+)'/gu)].map((item) => item[1])
}

/** 本卡的核心那一格：本仓现在唯一的锁文件。 */
const LOCKFILE = 'pnpm-lock.yaml'

describe('release-guard：锁文件不是产物（本卡核心）', () => {
  it(`${LOCKFILE} 单独出现 ⇒ exit 1，且被归进「不影响产物」那一类`, () => {
    // 防什么：那一格**红→绿反转**。清单里少了它，纯锁文件改动就会被判成「有产物改动」⇒ exit 0
    // ⇒ 发布链放行一次不该发的版；而错误方向是静默的（没有信号说它判错了）。
    const run = runGuard(`${LOCKFILE}\n`)
    expect(
      run.status,
      `锁文件单独出现必须 exit 1（不该发版），实际 ${String(run.status)}；stdout=${run.stdout}`,
    ).toBe(1)
    expect(run.stdout, '锁文件没有被印在「不影响产物」那一类里').toContain(LOCKFILE)
    expect(run.stdout).toContain('不影响产物的改动 1 条：')
    expect(run.stdout, '锁文件被归进「改变产物」一类了 —— 这正是那次反转的形状').not.toContain(
      '改变产物的改动',
    )
  })

  it('pnpm-workspace.yaml 单独出现 ⇒ exit 1（workspace 声明同样不进包）', () => {
    // 防什么：清单只补锁文件、漏掉 workspace 声明这一格 —— 只改 workspace 文件的那次发布会被放行。
    const run = runGuard('pnpm-workspace.yaml\n')
    expect(run.status, `pnpm-workspace.yaml 必须 exit 1，实际 ${String(run.status)}`).toBe(1)
    expect(run.stdout).toContain('不影响产物的改动 1 条：')
    expect(run.stdout).toContain('pnpm-workspace.yaml')
  })
})

describe('release-guard：真产物是产物', () => {
  it.each([
    'src/tools/dsh_check_auth.ts',
    'package.json',
    'skills/dsh-plugin-debugging/SKILL.md',
    'lib/index.js',
  ])('%s 单独出现 ⇒ exit 0', (file) => {
    // 防什么：把闸门做成「永远拦」。那种实现在 CI 上会把每一次真发布都拦下来，
    // 后果是人去删闸门，而不是修判据。
    // `skills/` 这一条额外钉住「它刻意不在非产物前缀里」（技能进了 files，改它就是改产物）。
    const run = runGuard(`${file}\n`)
    expect(run.status, `${file} 是进包产物，必须 exit 0，实际 ${String(run.status)}`).toBe(0)
    expect(run.stdout).toContain('改变产物的改动 1 条：')
    expect(run.stdout).toContain(file)
    expect(run.stdout).toContain('有产物改动，允许发版。')
    expect(run.stdout, '产物被同时归进「不影响产物」一类了 —— 分类两侧都数了一遍').not.toContain(
      '不影响产物的改动',
    )
  })
})

describe('release-guard：非产物前缀', () => {
  const REQUIRED = ['.agents/', '.github/', 'docs/', 'scripts/', 'test/']

  it.each(REQUIRED)('%s 下的改动不算产物 ⇒ exit 1', (prefix) => {
    // 防什么：纯文档 / 纯 CI / 纯脚本 / 纯测试 / 纯决策记录的改动被放行成一次发布。
    const run = runGuard(`${prefix}probe-file.txt\n`)
    expect(run.status, `${prefix} 必须 exit 1，实际 ${String(run.status)}`).toBe(1)
    expect(run.stdout).toContain('不影响产物的改动 1 条：')
    expect(run.stdout).toContain(`${prefix}probe-file.txt`)
  })

  it('源码真源里的每一条前缀都被真跑一遍（清单加条目时不会被漏掉）', () => {
    // 防什么：清单以后加前缀、判据却只看手抄的那五条 —— 新条目**没有判据**，
    // 而「没有判据」长得和「通过」一样。解析结果为空则判红，不许 skip。
    const parsed = readStringList('NON_ARTIFACT_PREFIXES')
    // 下界（不是等号）：以后往清单里**加**前缀是正当改动，不该判红；但**删**一条要判红。
    expect(
      parsed.length,
      '真源里解析出的前缀比应有的还少 —— 很可能有一条被删了，或者解析器失灵在空转',
    ).toBeGreaterThanOrEqual(REQUIRED.length)
    for (const prefix of REQUIRED) expect(parsed).toContain(prefix)
    for (const prefix of parsed) {
      const run = runGuard(`${prefix}probe-file.txt\n`)
      expect(run.status, `前缀 ${prefix} 没被当成非产物（exit ${String(run.status)}）`).toBe(1)
    }
  })
})

describe('release-guard：根级不进包的文件', () => {
  const REQUIRED = ['.gitignore', 'AGENTS.md', 'vitest.config.ts']

  it.each(REQUIRED)('%s 单独出现 ⇒ exit 1', (file) => {
    // 防什么：改 `.gitignore` / 根 AGENTS.md / 测试配置这类**不进包**的根级文件被当成产物改动。
    const run = runGuard(`${file}\n`)
    expect(run.status, `${file} 不进包，必须 exit 1，实际 ${String(run.status)}`).toBe(1)
    expect(run.stdout).toContain('不影响产物的改动 1 条：')
  })

  it('真源清单里的每一条都被真跑一遍（解析器失灵会被当场判红）', () => {
    // 防什么：解析器读空之后循环一次都不跑 —— 那正是坑 18 的「最危险的静默失败」。
    // 三条锚点都在真源里，所以「解析器读到的是真清单」本身也被钉住了。
    const parsed = readStringList('NON_ARTIFACT_FILES')
    for (const anchor of REQUIRED) {
      expect(parsed, `解析器没从源码里读到 ${anchor} —— 下面那条循环会空转`).toContain(anchor)
    }
    for (const file of parsed) {
      const run = runGuard(`${file}\n`)
      expect(run.status, `根级文件 ${file} 没被判成非产物（exit ${String(run.status)}）`).toBe(1)
    }
    // 本卡的核心那一格必须在真源清单里 —— 它不是靠手抄在测试里，而是靠这条钉在脚本里。
    expect(parsed, `${LOCKFILE} 不在脚本的非产物清单里`).toContain(LOCKFILE)
  })
})

describe('release-guard：混合输入', () => {
  it('一个产物 + 一堆非产物 ⇒ exit 0，且两类计数都印出来', () => {
    // 防什么：只按 exit code 判的判据挡不住「分类根本没发生」的实现。
    // 这一条要求**两类计数同时出现**，即真的走过两条分支。
    const input = [
      'src/index.ts',
      'docs/PUBLISHING.md',
      '.github/workflows/release.yml',
      'test/smoke.test.ts',
      `${LOCKFILE}`,
    ].join('\n')
    const run = runGuard(`${input}\n`)
    expect(run.status, '有产物改动时必须 exit 0（允许发版）').toBe(0)
    expect(run.stdout).toContain('改变产物的改动 1 条：')
    expect(run.stdout).toContain('不影响产物的改动 4 条：')
    expect(run.stdout).toContain('- src/index.ts')
    expect(run.stdout).toContain(`- ${LOCKFILE}`)
    expect(run.stdout).toContain('有产物改动，允许发版。')
  })

  it('空 stdin ⇒ exit 1（空区间不发版）', () => {
    // 防什么：没有收到改动清单时默认放行 —— 管道上游失败（git 报错、tag 不存在）时
    // 会得到「空清单 ⇒ 允许发版」这个最坏的组合。
    const run = runGuard('')
    expect(run.status, '空 stdin 必须 exit 1').toBe(1)
    expect(run.stdout).toContain('没有任何改动')
    expect(run.stdout, '空区间却印出了分类计数 —— 说明它没走空区间那条分支').not.toContain(
      '改变产物的改动',
    )
  })

  it('只有空行与空白的 stdin 与空 stdin 同判 ⇒ exit 1', () => {
    // 防什么：`git diff` 的尾随换行、Windows 的 CRLF 留下空行时被判成「有改动」。
    // 上一段脚本会 trim + 丢空行，这条钉住那个行为。
    const run = runGuard('\n   \n\t\r\n')
    expect(run.status, '全是空白的清单必须 exit 1').toBe(1)
    expect(run.stdout).toContain('没有任何改动')
  })
})

describe('release-guard：用法错误 ⇒ exit 2', () => {
  it('--help ⇒ exit 2，用法印在 stdout', () => {
    // 防什么：用法错误与「只有非产物改动」共用一个退出码 —— 发布链无法区分「别发」与「你调用错了」。
    // 这里刻意钉 2，不是 0：把 `--help` 当成功会让 `--help` 误用静默通过管道。
    const run = runGuard('', ['--help'])
    expect(run.status, '--help 必须 exit 2').toBe(2)
    expect(run.stdout).toContain('用法：')
    expect(run.stdout).toContain('2 = 用法错误')
    expect(run.stderr, '--help 是正常用法，不该往 stderr 写').toBe('')
  })

  it('-h ⇒ exit 2（与 --help 同义）', () => {
    // 防什么：只认长参数，短参数落进「未知参数」分支时文案会误导人（「无法识别的参数：-h」）。
    const run = runGuard('', ['-h'])
    expect(run.status, '-h 必须 exit 2').toBe(2)
    expect(run.stdout).toContain('用法：')
    expect(run.stderr, '-h 是已声明的用法，不该被判成未知参数').not.toContain('无法识别的参数')
  })

  it('未知参数 ⇒ exit 2，文案点到那个参数且走 stderr', () => {
    // 防什么：多余的参数被**静默忽略** —— 例如把 `--profile x` 之类的调用当成正常输入，
    // 于是「你以为换了行为、其实没有」。
    const run = runGuard('', ['--version'])
    expect(run.status, '未知参数必须 exit 2').toBe(2)
    expect(run.stderr).toContain('无法识别的参数：--version')
    expect(run.stderr).toContain('用法：')
    expect(run.stdout, '用法错误不该往 stdout 写成功路径的内容').toBe('')
  })

  it('位置参数（非选项）同样算未知参数 ⇒ exit 2', () => {
    // 防什么：只拦以 `-` 开头的参数，于是 `release-guard.mjs somefile` 被当成合法调用。
    const run = runGuard('', ['src/index.ts'])
    expect(run.status, '位置参数必须 exit 2').toBe(2)
    expect(run.stderr).toContain('无法识别的参数：src/index.ts')
  })
})

describe('release-guard：防空转', () => {
  it('产物输入与纯非产物输入的结论**相反**', () => {
    // 防什么：常量实现。「永远 exit 0」与「永远 exit 1」都能骗过只看单边的判据，
    // 这一条要求两个方向同时成立，所以两种常量实现都活不下来。
    const artifact = runGuard('src/index.ts\n')
    const docOnly = runGuard('docs/PUBLISHING.md\n')
    expect(artifact.status, '产物输入必须 exit 0').toBe(0)
    expect(docOnly.status, '纯文档输入必须 exit 1').toBe(1)
    expect(artifact.status, '两个方向必须给出不同结论').not.toBe(docOnly.status)
    expect(artifact.stdout).toContain('改变产物的改动')
    expect(artifact.stdout, '产物输入不该印出非产物计数').not.toContain('不影响产物的改动')
    expect(docOnly.stdout).toContain('不影响产物的改动')
    expect(docOnly.stdout, '纯文档输入不该印出产物计数').not.toContain('改变产物的改动')
  })

  it('同一输入连跑两次，退出码与输出逐字相同（判定不是随机的）', () => {
    // 防什么：判定里混进了时钟 / 环境 / 随机顺序 —— 那种闸门在 CI 上偶发红，红得没人信。
    const input = `src/index.ts\ndocs/PUBLISHING.md\n${LOCKFILE}\n`
    const first = runGuard(input)
    const second = runGuard(input)
    expect(second.status).toBe(first.status)
    expect(second.stdout).toBe(first.stdout)
    expect(second.stderr).toBe(first.stderr)
  })

  it('判定不依赖环境变量（最小环境复跑同一输入，结论逐字相同）', () => {
    // 防什么：闸门偷偷读 `GH_TOKEN` / `CI` 之类的环境变量 —— 那样本机绿推不出 CI 绿
    // （坑 24 的那一族）。**对照的是真实环境那一跑**，不是硬编码一个期望值。
    const inherited = runGuard(`${LOCKFILE}\n`)
    const minimal = runGuard(`${LOCKFILE}\n`, [], {})
    expect(minimal.status, '裁掉环境后结论变了 —— 判定依赖了环境变量').toBe(inherited.status)
    expect(minimal.stdout).toBe(inherited.stdout)
    expect(minimal.stderr).toBe(inherited.stderr)
  })
})
