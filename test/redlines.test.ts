import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

/**
 * 本仓的**红线**：能落成断言的不变量。
 *
 * 组织判据把一批东西定为 Must agree（`plugin-conventions.md:172,174,177,179,180`），
 * 而「能落成校验的就不写散文」是本仓的全局规则 —— 这个文件就是把它们落成执行体。
 *
 * 两条纪律：
 *
 * 1. **判据写成「纯函数 + 断言」两层**。判定逻辑（`judge*`）只吃解析好的数据、返回违规清单，
 *    断言只负责把清单判空。这样**反例可以在内存里构造**：改一个字段就能证明这条守卫真的会红，
 *    而不必去动真文件（动真文件既留脏改动，又会把「判据是否有效」和「工作树是否干净」搅在一起）。
 * 2. **每条守卫都要能被否证**。一条永远为真的断言比没有断言更坏 —— 它看起来绿，实际不设防。
 *    所以凡是「扫某个集合」的判据，都配一条同函数的反例，或一条「扫描器本身有效」的自检。
 *
 * 出处约定：`plugin-conventions.md` 指组织仓的 `docs/plugin-conventions.md`。
 *
 * **档位从属（A 组 vs B 组）**：A 组是组织 Must-agree 档的直接执行体，动它要回组织判据；
 * B 组是**本仓自己的形状**。B 组里有一条要特别说明：
 * **#7（`files` 覆盖 `skills/<name>/SKILL.md`）是本仓自选的更严判据，不是组织强制。**
 * 组织判据 `:176` 的原文是「a pure host plugin **may be exempt** from the `files` item,
 * **the host compatibility range must not be**」—— 本仓正是纯 host 插件，**豁免是被允许的**，
 * 我们**选择不豁免**（技能随包分发是本仓 v1 的能力面，D12）。
 * 写在这里的理由：判据从严可以，但**必须让人知道这是自选的** ——
 * 否则下一个人会以为组织要求它，从而不敢动、也不敢查。
 *
 * **本文件的已知限度**（哪条断言只在当前实现下成立、改了实现会跟着失效）见**文末**那一节。
 * 改这个文件或改它守护的实现之前，先读那一节。
 */

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))

/**
 * 本次运行建过的临时根。
 *
 * `afterAll` 兜底再扫一遍：Windows 上删除「刚被 `spawnSync` 读过的目录树」偶发
 * EBUSY/EPERM，而清理失败**不该**改变判据结论 —— 但它也不该留下垃圾。
 * 所以 `finally` 负责正常清理、`afterAll` 负责兜底，两级都失败才记一行警告。
 */
const TEMP_ROOTS: string[] = []

/** 建一个临时根并登记（保证一定会被清）。 */
function makeTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  TEMP_ROOTS.push(root)
  return root
}

/** 清掉一个临时根。清理失败只记一行，不改判据结论。 */
function cleanupTempRoot(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    const at = TEMP_ROOTS.indexOf(root)
    if (at >= 0) TEMP_ROOTS.splice(at, 1)
  } catch (error) {
    console.warn(`[redlines] 临时目录清理失败（afterAll 会再试）：${root} — ${String(error)}`)
  }
}

afterAll(() => {
  for (const root of [...TEMP_ROOTS]) cleanupTempRoot(root)
})

/** 读仓内文件（UTF-8）。 */
function readRepo(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), 'utf8')
}

/** 仓内路径是否存在。 */
function existsRepo(relPath: string): boolean {
  return existsSync(join(REPO_ROOT, relPath))
}

/** 把违规清单变成断言消息：**先报第一处**，再报总数与前几条 —— 只给 true/false 没法排障。 */
function describeOffenders(what: string, offenders: readonly string[]): string {
  if (offenders.length === 0) return `${what}：没有违规`
  const head = offenders.slice(0, 5).join('\n')
  const tail = offenders.length > 5 ? `\n… 另有 ${offenders.length - 5} 条` : ''
  return `${what}：第一处 → ${offenders[0]}\n共 ${offenders.length} 条：\n${head}${tail}`
}

/**
 * 去掉块注释与行注释。
 *
 * 必须有：源码注释里会正常出现「不杀进程」「`--dump-config` 退出码恒 0」这类字样，
 * 不剥注释就会把**解释规则的文字**当成违规。`[^:]` 那一段是防 `https://` ——
 * 不防的话 URL 里那个 `//` 会被当成行注释起点，把整行后半截吃掉。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** 遍历 `src/**` 下的 TS 源码（相对路径 + 内容）。 */
function readSourcesUnder(dirRelPath: string): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = []
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(REPO_ROOT, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`
      if (entry.isDirectory()) walk(child)
      else if (entry.name.endsWith('.ts')) out.push({ path: child, text: readRepo(child) })
    }
  }
  walk(dirRelPath)
  return out
}

interface Manifest {
  name?: string
  version?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  engines?: Record<string, string>
  exports?: Record<string, unknown>
  files?: string[]
  dsh?: { bundle?: { patch?: string } }
}

const packageJson = JSON.parse(readRepo('package.json')) as Manifest

// ── A. 组织 Must-agree 档 ──────────────────────────────────────────────────

/** A1 判据：每个官方包在 peer 与 dev 里必须**同值**。 */
function judgePeerDevAgreement(pkg: Manifest): string[] {
  const peers = pkg.peerDependencies ?? {}
  const devs = pkg.devDependencies ?? {}
  const offenders: string[] = []
  for (const [name, range] of Object.entries(peers)) {
    if (!name.startsWith('@deepseek-ai/')) continue
    if (devs[name] === undefined) {
      offenders.push(`${name} 只有 peer、没 dev（本地类型检查会挂）`)
      continue
    }
    if (devs[name] !== range) {
      offenders.push(`${name}：peer=${range} ≠ dev=${devs[name]}`)
    }
  }
  return offenders
}

describe('A1 官方包的 peer 与 dev 版本逐条相等', () => {
  it('真实清单里没有漂开的官方包', () => {
    const offenders = judgePeerDevAgreement(packageJson)
    expect(offenders, describeOffenders('peer/dev 版本不一致', offenders)).toEqual([])
  })

  it('判据可被否证：把 dev 改一个字符就会红', () => {
    const mutated: Manifest = {
      ...packageJson,
      peerDependencies: { '@deepseek-ai/dsh-tools': '^0.2.0-rc.1' },
      devDependencies: { '@deepseek-ai/dsh-tools': '^0.2.0-rc.2' },
    }
    const offenders = judgePeerDevAgreement(mutated)
    expect(offenders).toHaveLength(1)
    expect(offenders[0]).toContain('@deepseek-ai/dsh-tools')
  })

  it('判据可被否证：只有 peer、缺 dev 也会红', () => {
    const mutated: Manifest = {
      ...packageJson,
      peerDependencies: { '@deepseek-ai/dsh-tools': '^0.2.0-rc.1' },
      devDependencies: {},
    }
    expect(judgePeerDevAgreement(mutated)).toHaveLength(1)
  })
})

/** A2 判据：`engines.dsh` 与每条 `@deepseek-ai/dsh-*` 声明**逐字相同**。 */
function judgeEngineRangeAgreement(pkg: Manifest): string[] {
  const engine = pkg.engines?.['dsh']
  if (typeof engine !== 'string' || engine.trim() === '') return ['engines.dsh 没声明']
  const offenders: string[] = []
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
    for (const [name, range] of Object.entries(pkg[field] ?? {})) {
      if (!name.startsWith('@deepseek-ai/dsh-')) continue
      if (range !== engine) offenders.push(`${field}:${name} = ${range} ≠ engines.dsh = ${engine}`)
    }
  }
  return offenders
}

describe('A2 engines.dsh 与每个 @deepseek-ai/dsh-* 区间逐字相同', () => {
  it('真实清单里逐字一致，且承诺的族不只一族', () => {
    const engine = packageJson.engines?.['dsh'] ?? ''
    // 单区间罩不住两个预发布族：npm 只在区间内存在**同元组**预发布项时才匹配候选，
    // 所以要同时承诺 0.1.7 与 0.2.0 线必须用 `||` 显式枚举。这条防的是「悄悄删掉一族」。
    expect(engine.split('||').length, `engines.dsh = ${engine} 只承诺了一族`).toBeGreaterThan(1)

    const offenders = judgeEngineRangeAgreement(packageJson)
    expect(offenders, describeOffenders('engines.dsh 与 dsh-* 区间不同值', offenders)).toEqual([])
  })

  it('判据可被否证：只改一条 dsh-* 区间就会红', () => {
    const mutated: Manifest = {
      ...packageJson,
      engines: { dsh: '^0.2.0-rc.1' },
      peerDependencies: { '@deepseek-ai/dsh-skill': '^0.1.7-rc.1' },
      devDependencies: { '@deepseek-ai/dsh-skill': '^0.2.0-rc.1' },
    }
    const offenders = judgeEngineRangeAgreement(mutated)
    expect(offenders).toHaveLength(1)
    expect(offenders[0]).toContain('@deepseek-ai/dsh-skill')
  })

  it('判据可被否证：engines.dsh 缺席时先红这一条，而不是静默返回空', () => {
    expect(judgeEngineRangeAgreement({ ...packageJson, engines: {} })).toEqual([
      'engines.dsh 没声明',
    ])
  })
})

/** A3 判据：`@deepseek-ai/*` 绝不进 dependencies。 */
function judgeNoOfficialRuntimeDeps(pkg: Manifest): string[] {
  return Object.keys(pkg.dependencies ?? {})
    .filter((name) => name.startsWith('@deepseek-ai/'))
    .map((name) => `dependencies 里有官方包 ${name}`)
}

describe('A3 @deepseek-ai/* 绝不进 dependencies', () => {
  it('真实清单的 dependencies 里没有官方包', () => {
    const offenders = judgeNoOfficialRuntimeDeps(packageJson)
    expect(offenders, describeOffenders('官方包进了运行时依赖', offenders)).toEqual([])
  })

  it('判据可被否证：往 dependencies 塞一个官方包就会红', () => {
    const mutated: Manifest = {
      ...packageJson,
      dependencies: { '@deepseek-ai/dsh-tools': '^0.2.0-rc.1' },
    }
    const offenders = judgeNoOfficialRuntimeDeps(mutated)
    expect(offenders).toHaveLength(1)
    expect(offenders[0]).toContain('@deepseek-ai/dsh-tools')
  })
})

/**
 * A4 判据：锁文件里每个 http(s) 来源的 `resolved` 必须指向官方 registry。
 *
 * 只看 http(s)：`file:` / `link:` / `git` 本就不是包的公开源。
 */
function judgeLockfileRegistry(lock: {
  packages?: Record<string, { resolved?: string }>
}): string[] {
  const offenders: string[] = []
  for (const [name, meta] of Object.entries(lock.packages ?? {})) {
    const resolved = meta.resolved
    if (resolved === undefined || !resolved.startsWith('http')) continue
    if (!resolved.startsWith('https://registry.npmjs.org/')) {
      let host = resolved
      try {
        host = new URL(resolved).host
      } catch {
        // 解析不了就原样报出来 —— 比吞掉更像一条线索。
      }
      offenders.push(`${name === '' ? '(root)' : name} → ${host}`)
    }
  }
  return offenders
}

describe('A4 锁文件的 resolved 指向官方 registry', () => {
  it('真实 package-lock.json 里没有镜像源，且扫描量非零', () => {
    const lock = JSON.parse(readRepo('package-lock.json')) as {
      packages?: Record<string, { resolved?: string }>
    }
    const scanned = Object.values(lock.packages ?? {}).filter((meta) =>
      meta.resolved?.startsWith('http'),
    ).length
    // 非空自证：扫到 0 条时这条断言会假绿（锁文件读错了也会 0 条）。
    // 「拿不到输出」与「通过」长得一样，所以把规模一并钉住。
    expect(
      scanned,
      '锁文件里没扫到任何 http(s) resolved —— 判据没跑到，不是判据通过',
    ).toBeGreaterThan(50)

    const offenders = judgeLockfileRegistry(lock)
    expect(offenders, describeOffenders('锁文件里有非官方源', offenders)).toEqual([])
  })

  it('判据可被否证：注入一条镜像源就会红，且报出主机名', () => {
    const offenders = judgeLockfileRegistry({
      packages: {
        '': { resolved: 'https://registry.npmjs.org/' },
        'node_modules/foo': { resolved: 'https://registry.npmmirror.com/foo/-/foo-1.0.0.tgz' },
      },
    })
    expect(offenders).toHaveLength(1)
    expect(offenders[0]).toContain('registry.npmmirror.com')
  })
})

/**
 * A5 判据：发布流程不得改写版本号（组织判据 `:177`，要求带 **negative control**）。
 *
 * 正例直接跑本仓的执行体 `scripts/check-release.mjs`；反例在一个**临时副本**里注入
 * `npm version patch` 再跑同一个脚本，证明它真的会红 —— 不动真文件。
 */
describe('A5 发布流程不得改写版本号', () => {
  /** 把 check-release 需要的文件拷进临时根，返回临时根。 */
  function makeTempRepo(): string {
    const root = makeTempRoot('dsh-redline-release-')
    const need = [
      'package.json',
      'cordis.patch.yml',
      'LICENSE',
      'skills/dsh-plugin-debugging/SKILL.md',
      '.github/workflows/release.yml',
    ]
    for (const rel of need) {
      const target = join(root, rel)
      mkdirSync(join(target, '..'), { recursive: true })
      cpSync(join(REPO_ROOT, rel), target, { recursive: true })
    }
    return root
  }

  /** 跑发布态守卫，返回退出码与 stderr。 */
  function runCheckRelease(root: string): { status: number | null; stderr: string } {
    const result = spawnSync(
      process.execPath,
      [join(REPO_ROOT, 'scripts/check-release.mjs'), root],
      { encoding: 'utf8' },
    )
    return { status: result.status, stderr: result.stderr ?? '' }
  }

  it('正例：干净副本上守卫通过（退出码 0）', () => {
    const root = makeTempRepo()
    try {
      const { status } = runCheckRelease(root)
      expect(status, '干净副本上 check-release 没通过 —— 先修守卫，别急着信反例').toBe(0)
    } finally {
      cleanupTempRoot(root)
    }
  })

  it('反例控制：往发布流程注入 bump 后，守卫必须红（退出码 1）且点出那条命令', () => {
    const root = makeTempRepo()
    try {
      const workflowPath = join(root, '.github/workflows/release.yml')
      const original = readFileSync(workflowPath, 'utf8')
      // 注入一处**会执行**的 bump：位置在 Publish 步骤的 run 里，不是注释、不是 echo。
      const mutated = original.replace(
        '          npm publish',
        '          npm version patch --no-git-tag-version\n          npm publish',
      )
      // 自检：变异真的落地了吗。没落地就说明 replace 没匹配上，
      // 那样这个反例证明的不是「守卫有效」，而是「正则没命中」。
      expect(mutated, '注入没生效：release.yml 里没有可替换的 npm publish 行').not.toBe(original)
      writeFileSync(workflowPath, mutated)
      const { status, stderr } = runCheckRelease(root)
      expect(status, '注入 bump 后守卫仍然通过 —— 这条红线是空转的').toBe(1)
      expect(stderr).toContain('npm version patch')
      expect(stderr).toContain('发布流程不改写版本号')
    } finally {
      cleanupTempRoot(root)
    }
  })

  it('真实 release.yml 里没有会执行的 bump 命令', () => {
    const source = readRepo('.github/workflows/release.yml')
    const writes = source
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .filter((line) => !/^\s*echo\b/.test(line))
      .filter((line) => /(npm|pnpm)\s+version\b|npm\s+pkg\s+set\b/.test(line))
    expect(writes, describeOffenders('发布流程里出现了会改版本的命令', writes)).toEqual([])
  })
})

/**
 * A6 判据：tag 名是 `v<semver>`，且**由显式前缀拼出**，不是拿清单里的值直接当 tag。
 *
 * 形状是判据不是审美：守卫靠 `git describe --match 'v[0-9]*'` 认它（组织判据 `:179`），
 * 不带 `v` 的 tag 那个 `--match` **看不见** —— 于是「发过了」与「没发过」判定相反。
 */
function judgeTagShape(workflowSource: string): string[] {
  const source = stripComments(workflowSource)
  const offenders: string[] = []
  // 机器读者的形状必须存在。
  if (!/--match\s+['"]v\[0-9\]\*['"]/.test(source)) {
    offenders.push("没有 `git describe --match 'v[0-9]*'` —— 机器认不出本地 tag 的形状")
  }
  // tag 必须由显式 `v` 前缀拼出。
  const assignsTag = /tag\s*=\s*"v\$\{\{/.test(source) || /tag\s*=\s*"v\$/.test(source)
  if (!assignsTag) {
    offenders.push('tag 名不是「显式 v 前缀 + 版本号」拼出来的（例如 tag="${{ ...version }}"）')
  }
  return offenders
}

describe('A6 tag 形状是 v<semver>，且前缀显式', () => {
  it('真实 release.yml 用的是 v 前缀 + --match 的形状', () => {
    const offenders = judgeTagShape(readRepo('.github/workflows/release.yml'))
    expect(offenders, describeOffenders('tag 形状不对', offenders)).toEqual([])
  })

  it('判据可被否证：把前缀拿掉就会红', () => {
    const mutated = [
      "          previous=$(git describe --tags --abbrev=0 --match 'v[0-9]*')",
      '          tag="${{ steps.probe.outputs.version }}"',
      '          git tag "$tag"',
    ].join('\n')
    const offenders = judgeTagShape(mutated)
    expect(offenders.length).toBeGreaterThan(0)
    expect(offenders.join('\n')).toContain('显式 v 前缀')
  })
})

// ── B. 本仓自己的形状 ──────────────────────────────────────────────────────

/** B7 判据：`files` 必须覆盖这些路径（含技能随包分发的 D12）。 */
const REQUIRED_FILES_COVERAGE = [
  'cordis.patch.yml',
  'README.md',
  'README_zh.md',
  'LICENSE',
  'skills/dsh-plugin-debugging/SKILL.md',
] as const

/**
 * `files` 的某一条目能不能覆盖目标路径。
 *
 * 只实现本仓真实用到的三种形态：裸目录名（`skills` → 整棵子树）、显式路径、`**` 后缀。
 * 刻意不做通用 glob：npm 用的是 minimatch，几十行不可能对齐它，
 * 而一个「看起来像完整语义」的实现比一个窄的更容易让人误信。
 */
function fileEntryCovers(entry: string, target: string): boolean {
  if (entry.startsWith('!')) return false
  const clean = entry.replace(/^\.\//, '').replace(/\/+$/, '')
  if (clean === '') return false
  if (clean === target) return true
  if (clean.endsWith('/**')) return target.startsWith(`${clean.slice(0, -3)}/`)
  return target.startsWith(`${clean}/`)
}

/** B7 判据：返回没被任何 `files` 条目覆盖的必需路径。 */
function judgeFilesCoverage(files: readonly string[] | undefined): string[] {
  const list = files ?? []
  return REQUIRED_FILES_COVERAGE.filter((target) => !list.some((e) => fileEntryCovers(e, target)))
}

describe('B7 files 覆盖随包必需的路径', () => {
  it('五个必需路径都被覆盖', () => {
    const offenders = judgeFilesCoverage(packageJson.files)
    expect(offenders, describeOffenders('files 没覆盖', offenders)).toEqual([])
  })

  it('判据可被否证：删掉 skills 条目，技能就不再随包', () => {
    const mutated = (packageJson.files ?? []).filter((entry) => entry !== 'skills')
    const offenders = judgeFilesCoverage(mutated)
    expect(offenders).toContain('skills/dsh-plugin-debugging/SKILL.md')
  })

  it('判据可被否证：取反条目不算覆盖', () => {
    expect(judgeFilesCoverage(['!skills', '!LICENSE'])).toContain('LICENSE')
  })
})

describe('B8 exports 暴露 ./skills/*，且 bundle patch 文件真实存在', () => {
  it("exports 里有 './skills/*'", () => {
    // 缺这条子路径导出时，宿主按 <包名>/skills/... 解析会拿到
    // ERR_PACKAGE_PATH_NOT_EXPORTED —— 与「元数据静默消失」是同一族故障。
    expect(Object.keys(packageJson.exports ?? {})).toContain('./skills/*')
  })

  it('dsh.bundle.patch 指向的文件在磁盘上', () => {
    const patch = packageJson.dsh?.bundle?.patch
    expect(typeof patch, 'dsh.bundle.patch 没声明').toBe('string')
    // 去掉开头的 './' 换成仓内相对路径。
    const rel = String(patch).replace(/^\.\//, '')
    expect(existsRepo(rel), `dsh.bundle.patch 指向 ${rel}，但文件不在`).toBe(true)
  })
})

/** B9：工具名是模型可见 API —— 闭集，改一个名字就要同步改文档与技能正文。 */
const EXPECTED_TOOLS = [
  'dsh_check_effect_mode',
  'dsh_diagnose_plugin_load',
  'dsh_check_auth',
  'dsh_dump_config',
] as const

/**
 * 提取器认得的形态。**写在这里就要写进自检** —— 认得的形态和自检覆盖的形态必须是同一批，
 * 否则自检自己也在假绿（只喂它认得的那种，当然永远通过）。
 */
const TOOL_NAME_SHAPES: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  {
    label: 'export const <任意名> = <任意引号>dsh_…<任意引号>',
    pattern: /export\s+const\s+[A-Za-z0-9_$]+\s*=\s*['"`](dsh_[a-z0-9_]+)['"`]/g,
  },
  {
    label: 'defineTool 内联 name: <任意引号>dsh_…<任意引号>',
    pattern: /\bname\s*:\s*['"`](dsh_[a-z0-9_]+)['"`]/g,
  },
]

/**
 * 从源码文本里提取注册用的工具名。
 *
 * 覆盖三种引号（`'` / `"` / `` ` ``）与常见命名：**不再绑定 `*_TOOL` 这种命名约定**，
 * 因为绑定命名约定的提取器一旦遇到别的写法就返回空集 —— 而空集在「跳过未实现」的设计里
 * 看起来完全正常（这是本文件上一版确认过的假绿）。
 *
 * @param sources 源码文本。
 * @returns 提取到的名字（可能重复，由调用方去重）。
 */
function collectDeclaredToolNames(sources: readonly { path: string; text: string }[]): string[] {
  const names: string[] = []
  for (const { text } of sources) {
    const stripped = stripComments(text)
    for (const { pattern } of TOOL_NAME_SHAPES) {
      // 每次新建正则：`g` 正则带 lastIndex，跨文件复用会漏匹配。
      for (const match of stripped.matchAll(new RegExp(pattern.source, pattern.flags))) {
        const name = match[1]
        if (name !== undefined) names.push(name)
      }
    }
  }
  return names
}

/** 从一份 Markdown 里收集提到的 `dsh_*` 记号。 */
function collectMentionedToolNames(markdown: string): string[] {
  return [...markdown.matchAll(/\bdsh_[a-z0-9_]+/g)].map((match) => match[0])
}

/** `src/tools/` 下的全部源码。 */
const ALL_TOOL_SOURCES = readSourcesUnder('src/tools')

/**
 * 工具半边里的**基础设施文件**：聚合入口与共享助手。它们不属于「一个工具一个文件」那批。
 *
 * 按文件名排除，而不是按内容特征 —— 见 {@link toolHalfImplemented} 的理由。
 */
const TOOL_INFRASTRUCTURE_FILES = ['index.ts', 'shared.ts'] as const

/** 工具实现文件：`src/tools/` 下除掉基础设施文件之后剩下的。 */
const TOOL_IMPL_FILES = ALL_TOOL_SOURCES.filter(
  (source) => !TOOL_INFRASTRUCTURE_FILES.some((name) => source.path.endsWith(`/${name}`)),
)

const declaredToolNames = [...new Set(collectDeclaredToolNames(ALL_TOOL_SOURCES))].sort()

/**
 * 「工具半边实现了没有」的判据 = **`src/tools/` 下存在非基础设施文件**。
 *
 * 只看**文件存在性**，不看内容 —— 这是刻意的，也是上一版留下的最后一个洞的堵法：
 * 上一版用 `defineTool(` 这个**结构标记**当判据，于是「换一个工厂函数」就会让判据变假、
 * 静默降级成 skip（注册名、文件全都在，只是提取不出来）。而「文件存在」这件事本身就是
 * 独立真源，不依赖任何代码写法。
 *
 * 新边界：**文件在 = 已实现**。此时提不出名字就是**红**（要么提取器的形态表落后于实现，
 * 要么真没人声明名字 —— 两种都要人来看）。于是 skip 只剩一种合法情形：
 * **文件真的不存在**，即工具半边尚未写。
 */
const toolHalfImplemented = TOOL_IMPL_FILES.length > 0

if (!toolHalfImplemented) {
  // 响了要看得见：跳过不是绿。走到这里意味着 src/tools/ 下**一个实现文件都没有**。
  console.warn(
    `[redlines] 工具半边尚未实现：src/tools/ 下除了 ${TOOL_INFRASTRUCTURE_FILES.join(' / ')} ` +
      '没有别的 .ts 文件，B9 实现侧断言被跳过（不是通过）。',
  )
}

describe('B9 工具名是闭集', () => {
  it('提取器本身有效：三种引号 + 内联 name 五种形态都认得', () => {
    // 每种形态各喂一个：认得几种就自检几种（自检与 TOOL_NAME_SHAPES 必须同批）。
    const synthetic = [
      `export const A_TOOL = '${EXPECTED_TOOLS[0]}'`,
      `export const B_TOOL = "${EXPECTED_TOOLS[1]}"`,
      `export const C_TOOL = \`${EXPECTED_TOOLS[2]}\``,
      `export const lowercaseName = "${EXPECTED_TOOLS[3]}"`,
      `export function make() { return defineTool({ name: 'dsh_check_auth' }) }`,
    ].join('\n')
    const found = [
      ...new Set(collectDeclaredToolNames([{ path: 'synthetic.ts', text: synthetic }])),
    ]
    // 四种常量形态 + 内联那一处（与第 4 个名字重复，去重后仍是四个）。
    expect(found.sort()).toEqual([...EXPECTED_TOOLS].sort())
  })

  it('提取器不绑定命名约定：`*_TOOL` 之外的写法也要认', () => {
    // 这条正是上一版假绿的成因：换名字约定后提取器返回空集，而空集被当成「尚未实现」跳过。
    const synthetic = `export const CHECK_AUTH = "dsh_check_auth"`
    expect(collectDeclaredToolNames([{ path: 'synthetic.ts', text: synthetic }])).toEqual([
      'dsh_check_auth',
    ])
  })

  it('提取器要能忽略注释里的假声明', () => {
    const synthetic = [
      "// export const FAKE_TOOL = 'dsh_not_a_real_tool'",
      "/* export const ALSO_FAKE_TOOL = 'dsh_also_fake' */",
      "export const REAL_TOOL = 'dsh_check_auth'",
    ].join('\n')
    expect(collectDeclaredToolNames([{ path: 'synthetic.ts', text: synthetic }])).toEqual([
      'dsh_check_auth',
    ])
  })

  it('声明侧：README×2 / 设计文档 / 技能正文里提到的工具名都属于这个闭集', () => {
    const corpora: Array<{ path: string; text: string }> = [
      { path: 'README.md', text: readRepo('README.md') },
      { path: 'README_zh.md', text: readRepo('README_zh.md') },
      { path: 'docs/ARCHITECTURE.md', text: readRepo('docs/ARCHITECTURE.md') },
      {
        path: 'skills/dsh-plugin-debugging/SKILL.md',
        text: readRepo('skills/dsh-plugin-debugging/SKILL.md'),
      },
    ]
    // 自证非空：每个语料都真的是那份文件（读错了会全是 0 命中，而 0 命中看起来像全绿）。
    for (const corpus of corpora) {
      expect(corpus.text.length, `${corpus.path} 短得不像真文件`).toBeGreaterThan(500)
    }

    const offenders: string[] = []
    let mentions = 0
    for (const corpus of corpora) {
      for (const name of collectMentionedToolNames(corpus.text)) {
        mentions += 1
        if (!EXPECTED_TOOLS.includes(name as (typeof EXPECTED_TOOLS)[number])) {
          offenders.push(`${corpus.path} 提到 ${name}，它不在闭集里`)
        }
      }
    }
    // 扫描确实命中了东西（README 两张表就是活证据），否则下面那条可能是空转。
    expect(mentions, '四份语料里一个 dsh_* 记号都没扫到 —— 扫描器坏了').toBeGreaterThan(0)

    expect(offenders, describeOffenders('出现了闭集外的工具名', offenders)).toEqual([])
  })

  it.skipIf(!toolHalfImplemented)('实现侧：文件在却提不出名字 = 红（不许降级成 skip）', () => {
    // 走到这里说明 src/tools/ 下**确有**实现文件（非 index/shared）—— 那么名字必须提得出来。
    // 提不出来只有两种可能：提取器的形态清单落后于实现（该扩 TOOL_NAME_SHAPES），
    // 或者真的没声明名字。**两种都要人来看**，所以判红并报出文件、以及提取器认得的形态。
    expect(
      declaredToolNames,
      `src/tools/ 下有 ${TOOL_IMPL_FILES.length} 个实现文件（${TOOL_IMPL_FILES.map((f) => f.path).join(', ')}），` +
        `但提取到的名字是 ${JSON.stringify(declaredToolNames)}` +
        `（期望 ${JSON.stringify([...EXPECTED_TOOLS].sort())}）。\n` +
        '这不是「尚未实现」—— 文件在。提取器当前认得这些形态：\n' +
        TOOL_NAME_SHAPES.map((shape) => `  - ${shape.label}`).join('\n') +
        '\n若实现换了写法，请把新形态加进 TOOL_NAME_SHAPES 并同步扩自检。',
    ).toEqual([...EXPECTED_TOOLS].sort())
  })
})

/**
 * B10 判据：**v1 只读**。这是对外承诺（README「v1 is read-only on purpose」、
 * `docs/ARCHITECTURE.md` §1），必须由断言守着，不能只写在散文里。
 *
 * 允许与禁止的边界**要划准**，否则这条会变成噪声：
 * - 允许 `child_process.spawn` —— 本仓的诊断要起 `dsh --dump-config` 这类**只读**子进程，
 *   `src/lib/exec.ts` 是唯一出口（这是设计，不是违规）。
 * - 允许 `child.kill()` —— 掐掉**自己刚起的那个只读探针**（超时/取消卫生），
 *   它不改变系统状态。
 * - 禁止 `process.kill` / `taskkill` / `Stop-Process` / 信号常量 —— 那是杀**别人的**进程。
 * - 禁止装面命令（`dsh plugin add/remove/…`）——**按子串匹配、不要求引号形状**，
 *   因为 `execSync('dsh plugin add ' + p)` 与模板字符串都会绕过「引号紧邻」那种写法。
 * - 禁止 fs 写入 API —— **只在确实从 `node:fs` 导入的名字上判定**（见 {@link fsBindingsOf}），
 *   否则 `src/lib/render.ts` 里那个同名的本地 `truncate` 字符串助手会被误报，
 *   而「因为会误报所以整族不查」等于不设防（上一版就是这么漏掉 `fs.truncate` 家族的）。
 *
 * **已知未覆盖**（明确列出来，不静默排除）：`node:fs` 之外的写入通道，例如
 * `process.binding`、原生 addon、`require()`（本仓是纯 ESM）、以及把 `fs` 方法先赋给
 * 别的变量再调用（`const w = writeFileSync`）。这些在本仓不出现；真出现时靠人看出来。
 */
const FORBIDDEN_PROCESS_VIOLATIONS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'process.kill', pattern: /\bprocess\.kill\b/ },
  { label: 'taskkill', pattern: /\btaskkill\b/i },
  { label: 'Stop-Process', pattern: /\bStop-Process\b/i },
  { label: 'SIGKILL', pattern: /\bSIGKILL\b/ },
  { label: 'SIGTERM', pattern: /\bSIGTERM\b/ },
  {
    label: 'dsh plugin 安装面（命令形态）',
    // 不要求引号形状：`plugin` 后面隔着引号/逗号/加号/空白，紧跟一个改动动词即命中。
    pattern: /\bplugin\b[\s'"`,+]*\b(add|remove|install|uninstall|link|unlink|publish)\b/,
  },
]

/**
 * 从一份源码里解析出「哪些本地名字其实是 `node:fs` 的函数」。
 *
 * 这是 fix 的关键：判据只在**确有 fs 来源**的名字上生效，于是本地的同名助手自然豁免，
 * 而 `fs.truncate` / 具名导入的 `truncate` / `fsp.writeFile` 都跑不掉。
 *
 * @param source 源码全文（自行 stripComments）。
 */
function fsBindingsOf(source: string): { namespaces: string[]; named: Set<string> } {
  const stripped = stripComments(source)
  const namespaces: string[] = []
  const named = new Set<string>()

  // import * as fs from 'node:fs'  /  import fs from 'node:fs'
  for (const match of stripped.matchAll(
    /import\s+(?:\*\s+as\s+([A-Za-z0-9_$]+)|([A-Za-z0-9_$]+))\s+from\s+['"`]node:fs(?:\/promises)?['"`]/g,
  )) {
    const name = match[1] ?? match[2]
    if (name !== undefined) namespaces.push(name)
  }
  // import { readFile, promises as fsp } from 'node:fs'
  for (const match of stripped.matchAll(
    /import\s*\{([^}]*)\}\s*from\s*['"`]node:fs(?:\/promises)?['"`]/g,
  )) {
    for (const part of (match[1] ?? '').split(',')) {
      const piece = part.trim()
      if (piece === '') continue
      const alias = piece.split(/\s+as\s+/)
      const local = (alias[1] ?? alias[0] ?? '').trim()
      if (local !== '') named.add(local)
    }
  }
  return { namespaces, named }
}

/** 写入族的 fs API（读 API 刻意不在内，`open` 另有标志判定）。 */
const FS_WRITE_APIS = [
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
  'truncate',
  'truncateSync',
  'ftruncate',
  'ftruncateSync',
  'createWriteStream',
  'mkdir',
  'mkdirSync',
  'mkdtemp',
  'mkdtempSync',
  'rmdir',
  'rmdirSync',
  'rm',
  'rmSync',
  'unlink',
  'unlinkSync',
  'rename',
  'renameSync',
  'copyFile',
  'copyFileSync',
  'cp',
  'cpSync',
  'chmod',
  'chmodSync',
  'chown',
  'chownSync',
  'utimes',
  'utimesSync',
  'symlink',
  'symlinkSync',
  'link',
  'linkSync',
  'writev',
  'writevSync',
  'writeFileSync',
] as const

/** `open`/`openSync` 只在标志可写时算写入（`open(p,'r')` 是纯读，不该误报）。 */
const FS_OPEN_WRITE_FLAG =
  /\b(open|openSync)\s*\([^)]*['"`](w|a|r\+|w\+|a\+|wx|ax|as|rs\+|w\+x|a\+x)['"`]/

/** B10 判据：扫源码，返回违规（`路径:行号 → 记号`）。 */
function judgeReadOnly(sources: readonly { path: string; text: string }[]): string[] {
  const offenders: string[] = []
  for (const { path, text } of sources) {
    const { namespaces, named } = fsBindingsOf(text)
    const lines = stripComments(text).split('\n')
    lines.forEach((line, index) => {
      const at = `${path}:${index + 1}`
      for (const { label, pattern } of FORBIDDEN_PROCESS_VIOLATIONS) {
        if (pattern.test(line)) offenders.push(`${at} → ${label}`)
      }
      if (FS_OPEN_WRITE_FLAG.test(line)) offenders.push(`${at} → fs.open（可写标志）`)
      // 具名导入有两种用法：**直接当函数**（`truncate(...)`）与**命名空间别名**
      // （`import { promises as fsp }` → `fsp.rmdir(...)`）。两种都查，
      // 否则 `promises as X` 这种写法整族漏掉（上一版实测漏过）。
      const namespaceLike = [...namespaces, ...named]
      for (const api of FS_WRITE_APIS) {
        for (const ns of namespaceLike) {
          if (new RegExp(`\\b${ns}\\s*\\.\\s*${api}\\b`).test(line)) {
            offenders.push(`${at} → ${ns}.${api}`)
          }
        }
        // 具名导入形态：import { truncate } from 'node:fs' 后的 truncate(...)
        if (named.has(api) && new RegExp(`\\b${api}\\b`).test(line)) {
          offenders.push(`${at} → ${api}（从 node:fs 具名导入）`)
        }
      }
    })
  }
  return offenders
}

describe('B10 v1 只读：src/** 不含改变系统状态的动作', () => {
  it('真实源码里没有杀进程 / 写文件 / 碰安装面的动作', () => {
    const sources = readSourcesUnder('src')
    // 非空自证：真的扫到了源码（0 个文件时这条会假绿）。
    expect(sources.length, 'src/** 下没扫到 TS 源码 —— 判据没跑到').toBeGreaterThan(5)

    const offenders = judgeReadOnly(sources)
    expect(offenders, describeOffenders('v1 只读被破坏', offenders)).toEqual([])
  })

  it('判据可被否证：安装面的三种命令形态都必须红（含字符串与模板字符串）', () => {
    // 上一版只认「引号紧邻 plugin」的 argv 数组形态，另外两种**确认漏掉**过。三种都钉住。
    const forms: Array<[string, string]> = [
      ['argv 数组形态', "const args = ['plugin', 'add', pkg]"],
      ['单引号字符串拼接', "execSync('dsh plugin add ' + pkg)"],
      ['模板字符串', 'execSync(`dsh plugin remove ${pkg}`)'],
      ['双引号字符串', 'execSync("dsh plugin install " + pkg)'],
    ]
    for (const [label, line] of forms) {
      const labels = judgeReadOnly([{ path: 'synthetic.ts', text: line }]).map(
        (entry) => entry.split(' → ')[1] ?? '',
      )
      expect(labels, `${label} 漏了（照到的是：${labels.join(' / ') || '空'}）`).toContain(
        'dsh plugin 安装面（命令形态）',
      )
    }
  })

  it('判据可被否证：fs 写入族的各种来源形态都能照出来', () => {
    const cases: Array<[string, string]> = [
      // 具名导入 + 调用（上一版正好漏掉 append 与 truncate 家族）
      ["import { openSync } from 'node:fs'\nopenSync(p, 'a')", 'fs.open（可写标志）'],
      [
        "import { ftruncateSync } from 'node:fs'\nftruncateSync(fd, 0)",
        'ftruncateSync（从 node:fs 具名导入）',
      ],
      [
        "import { appendFileSync } from 'node:fs'\nappendFileSync(p, 'x')",
        'appendFileSync（从 node:fs 具名导入）',
      ],
      // 命名空间形态
      ["import * as fs from 'node:fs'\nfs.truncate(p, 0)", 'fs.truncate'],
      ["import fsp from 'node:fs/promises'\nfsp.writeFile(p, 'x')", 'fsp.writeFile'],
      // `promises as X` 这种别名
      ["import { promises as fsp } from 'node:fs'\nfsp.rmdir(p)", 'fsp.rmdir'],
    ]
    for (const [source, expected] of cases) {
      const labels = judgeReadOnly([{ path: 'synthetic.ts', text: source }]).map(
        (entry) => entry.split(' → ')[1] ?? '',
      )
      expect(labels, `${expected} 漏了（照到的是：${labels.join(' / ') || '空'}）`).toContain(
        expected,
      )
    }
  })

  it('判据可被否证：不带 node:fs 来源的同名本地函数不算违规（防误报）', () => {
    // 这正是上一版把 `truncate` 整族排除掉的原因。现在按来源判定，两边都成立：
    // 本地的 truncate 不报，import 来的 truncate 报（见上一条）。
    const localHelper = [
      'export function truncate(text: string): string {',
      '  return text.length > 10 ? text.slice(0, 10) : text',
      '}',
    ].join('\n')
    expect(judgeReadOnly([{ path: 'synthetic.ts', text: localHelper }])).toEqual([])
  })

  it('真实源码里的本地 truncate（render.ts）不被误报，而它确实没有 fs 来源', () => {
    const render = readSourcesUnder('src/lib').find((source) => source.path.endsWith('/render.ts'))
    expect(render, 'src/lib/render.ts 不在了 —— 这条防误报的判据要跟着改').toBeDefined()
    // 前提自证：render.ts 不含 truncate 的 fs 来源（否则下面那条断言没有意义）。
    expect(render?.text).toContain('function truncate')
    expect(fsBindingsOf(render?.text ?? '').namespaces).toEqual([])
    expect([...fsBindingsOf(render?.text ?? '').named].filter((n) => n === 'truncate')).toEqual([])
    expect(judgeReadOnly([render!])).toEqual([])
  })

  it('判据可被否证：每种被禁动作都能被照出来', () => {
    const cases: Array<[string, string]> = [
      ['process.kill', 'process.kill(pid)'],
      ['taskkill', "spawn('taskkill', ['/T', '/F', '/PID', String(pid)])"],
      ['Stop-Process', "spawn('powershell', ['Stop-Process', '-Id', String(pid)])"],
      ['SIGKILL', "process.kill(pid, 'SIGKILL')"],
    ]
    for (const [label, line] of cases) {
      const offenders = judgeReadOnly([{ path: 'synthetic.ts', text: line }])
      // 一行可以同时命中多条规则（`process.kill(pid, 'SIGKILL')` 就是两条），
      // 所以判「目标记号在其中」而不是「恰好一条」—— 后者会把正确的实现判红。
      const labels = offenders.map((entry) => entry.split(' → ')[1] ?? '')
      expect(labels, `${label} 没被照出来（照到的是：${labels.join(' / ') || '空'}）`).toContain(
        label,
      )
    }
  })

  it('注释里出现这些字样不算违规（否则解释规则的文字会把判据变成噪声）', () => {
    const commented = [
      '// v1 不杀进程：不用 process.kill，也不跑 taskkill',
      '/* 也不写 $DSH_HOME：不调用 writeFileSync / mkdirSync */',
      '// 也不跑 dsh plugin add —— 安装面归用户',
    ].join('\n')
    expect(judgeReadOnly([{ path: 'synthetic.ts', text: commented }])).toEqual([])
  })

  it('允许 child.kill()：掐掉自己刚起的只读探针不算改变系统状态', () => {
    expect(judgeReadOnly([{ path: 'synthetic.ts', text: 'child.kill()' }])).toEqual([])
  })
})

describe('B11 双语门面成对，且展示元数据齐全', () => {
  it('README.md 与 README_zh.md 都在，且互相链接', () => {
    for (const path of ['README.md', 'README_zh.md']) {
      expect(existsRepo(path), `${path} 不在`).toBe(true)
    }
    // 互为入口：单向链接会让另一语言成为孤岛。
    expect(readRepo('README.md')).toContain('README_zh.md')
    expect(readRepo('README_zh.md')).toContain('README.md')
  })

  it('locale/en.json 与 locale/zh.json 都有 meta.title 与 meta.description', () => {
    for (const path of ['locale/en.json', 'locale/zh.json']) {
      const locale = JSON.parse(readRepo(path)) as {
        meta?: { title?: unknown; description?: unknown }
      }
      const title = locale.meta?.title
      const description = locale.meta?.description
      expect(typeof title === 'string' && title.trim() !== '', `${path} 的 meta.title 缺失`).toBe(
        true,
      )
      expect(
        typeof description === 'string' && description.trim() !== '',
        `${path} 的 meta.description 缺失`,
      ).toBe(true)
    }
  })

  it('两份 locale 的 title 不重复（中英各表其名，而不是复制粘贴）', () => {
    const en = JSON.parse(readRepo('locale/en.json')) as { meta: { title: string } }
    const zh = JSON.parse(readRepo('locale/zh.json')) as { meta: { title: string } }
    expect(en.meta.title).not.toBe(zh.meta.title)
  })
})

describe('B12 技能文件本体', () => {
  const SKILL_REL = 'skills/dsh-plugin-debugging/SKILL.md'

  /**
   * 独立切出 frontmatter（不复用 `src/skills/register.ts` 的解析器）。
   * 红线若复用被它守护的实现，实现有 bug 时两边一起错 —— 那就不是独立判据了。
   */
  function parseFrontmatter(raw: string): Map<string, string> | undefined {
    const lines = raw.split('\n')
    if (lines[0]?.replace(/\r$/, '') !== '---') return undefined
    const end = lines.findIndex((line, index) => index > 0 && line.replace(/\r$/, '') === '---')
    if (end < 0) return undefined
    const fields = new Map<string, string>()
    for (const line of lines.slice(1, end)) {
      const colon = line.indexOf(':')
      if (colon < 0 || /^\s/.test(line)) continue
      fields.set(
        line.slice(0, colon).trim(),
        line
          .slice(colon + 1)
          .trim()
          .replace(/^["']|["']$/g, ''),
      )
    }
    return fields
  }

  it('SKILL.md 存在、frontmatter 的 name 合规且等于目录名、description 非空', () => {
    expect(existsRepo(SKILL_REL), `${SKILL_REL} 不在`).toBe(true)
    const frontmatter = parseFrontmatter(readRepo(SKILL_REL))
    expect(frontmatter, 'SKILL.md 没有可解析的 frontmatter').toBeDefined()

    const name = frontmatter?.get('name') ?? ''
    const description = frontmatter?.get('description') ?? ''
    expect(name, 'frontmatter 的 name 不是 kebab-case').toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    // 目录名必须与 name 一致：不一致时模型调用用的名字与包内路径对不上，而两边都不报错。
    expect(name, 'name 与所在目录名不一致').toBe('dsh-plugin-debugging')
    expect(description.length, 'description 为空 —— 模型唯一的路由信号没了').toBeGreaterThan(0)
  })

  it('判据可被否证：非法 name 与空 description 都会被照出来', () => {
    const bad = parseFrontmatter('---\nname: Bad_Name\ndescription:\n---\n\n正文\n')
    const name = bad?.get('name') ?? ''
    const description = bad?.get('description') ?? ''
    expect(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)).toBe(false)
    expect(description.length).toBe(0)
  })

  it('技能正文不空（正文为空的技能会在渲染 <skill_content> 时才暴露）', () => {
    const raw = readRepo(SKILL_REL)
    const body = raw.slice(raw.indexOf('\n---', 4) + 4).trim()
    expect(body.length).toBeGreaterThan(500)
  })
})

/**
 * B13 判据：仓内 `.ps1` 必须带 UTF-8 BOM。
 *
 * **为什么值得一条红线**：Windows PowerShell 5.1（系统默认那个 `powershell.exe`）读**无 BOM** 的文件时
 * 按 **GBK** 解码；本仓脚本的注释是中文 → **直接解析失败**，报错还是 `Unexpected token '}'`
 * 这种**看起来像语法错**的形状。而 **prettier 跳过 `.ps1`、CI 也不解析它** ——
 * 所以「本机全绿 + CI 全绿」**照不出这条**，实测两个脚本都 PARSE-FAIL 过。
 *
 * 判据只吃字节，故可以**在内存里造反例**（同一段内容、有无 BOM 各判一次），不碰真文件。
 */
const UTF8_BOM = [0xef, 0xbb, 0xbf] as const

/** 判断一个字节序列是否以 UTF-8 BOM 开头。 */
function hasUtf8Bom(bytes: readonly number[]): boolean {
  return UTF8_BOM.every((byte, index) => bytes[index] === byte)
}

/** 找出所有缺 BOM 的 `.ps1`（返回违规清单，空 = 通过）。 */
function judgePs1Bom(files: readonly { path: string; bytes: readonly number[] }[]): string[] {
  return files.filter((file) => !hasUtf8Bom(file.bytes)).map((file) => file.path)
}

describe('B13 仓内 .ps1 带 UTF-8 BOM（否则 PowerShell 5.1 按 GBK 解码、中文注释导致解析失败）', () => {
  /** 仓内所有 `.ps1`（递归；跳过 node_modules 与构建产物）。 */
  function ps1Files(dir: string, found: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === '.git') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) ps1Files(full, found)
      else if (entry.name.endsWith('.ps1')) found.push(full)
    }
    return found
  }

  it('每个 .ps1 都以 EF BB BF 开头', () => {
    const files = ps1Files(REPO_ROOT).map((path) => ({
      path,
      bytes: [...readFileSync(path).subarray(0, 3)],
    }))
    // 自检：扫描器必须真的扫到东西，否则这条判据是空转（`scripts/**` 与 `test/integration/**` 都有）。
    expect(files.length, '一个 .ps1 都没扫到 —— 扫描器空转').toBeGreaterThan(0)
    expect(judgePs1Bom(files)).toEqual([])
  })

  it('判据可被否证：同一段内容去掉 BOM 会被照出来', () => {
    const content = 'Write-Output "中文注释"'
    const withBom = [...UTF8_BOM, ...[...Buffer.from(content, 'utf8')]]
    const withoutBom = [...Buffer.from(content, 'utf8')]
    expect(judgePs1Bom([{ path: 'ok.ps1', bytes: withBom }])).toEqual([])
    expect(judgePs1Bom([{ path: 'bad.ps1', bytes: withoutBom }])).toEqual(['bad.ps1'])
  })
})

/**
 * B14 判据：**`src/**` 里模型可见的字符串不得含 CJK**（注释除外）。
 *
 * 判据原话：凡是可能到达模型或用户眼里的字符串都必须英文（工具 `data` 的文本字段、
 * `fail` 的 `message`/`hint`、`nextStep.why`、render 的文本）；**只被实现内部 catch、
 * 进不了工具结果 / `SkillReport` 的字符串不受此约束**（例如测试替身自己的中文 Error）。
 *
 * **边界**：只扫 `src/**`。`test/**` 的中文一律放过 —— 那正是上面那条例外的落点。
 * 本仓约定注释写中文，所以注释必须跳过，否则这条判据会把「解释规则的文字」判成违规。
 */
const CJK = /[\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uFF00-\uFFEF]/

/**
 * 从一个 TS 源文本里挑出「**字符串字面量**里含 CJK」的命中（带行号与原样文本）。
 *
 * 手写状态机而不是正则：注释、三种引号、转义、以及**未闭合**四种情况要分开处理，
 * 一条正则表达不了，而表达不准的扫描器会**永远绿**（本仓已有三处假绿判例）。
 *
 * 两条防偏措施：
 * - 单/双引号串**不允许跨行**（TS 也不允许裸换行）：行内没闭合就把那个引号当**普通字符**。
 *   这是为了防正则字面量里的引号（如 `/['"]/`）把状态机带跑偏 —— 那会让扫描器吞掉后面整段代码。
 * - 模板串允许跨行，且串内的 `//` 不当注释（它确实在字符串里）。
 *
 * @param source 源文本全文。
 * @returns 命中列表（行号 1 起、原文已 trim）。
 */
function collectCjkInStringLiterals(source: string): Array<{ line: number; literal: string }> {
  const hits: Array<{ line: number; literal: string }> = []
  let i = 0
  let line = 1
  const n = source.length

  while (i < n) {
    const ch = source[i]
    const next = source[i + 1]

    // 行注释：跳到行尾（不消费换行，交给主循环计行）。
    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i += 1
      continue
    }
    // 块注释：跳到配对的结束标记。
    if (ch === '/' && next === '*') {
      i += 2
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') line += 1
        i += 1
      }
      i += 2
      continue
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      const startLine = line
      let body = ''
      let j = i + 1
      let closed = false
      while (j < n) {
        const c = source[j]
        if (c === '\\') {
          body += c + (source[j + 1] ?? '')
          if (source[j + 1] === '\n') line += 1
          j += 2
          continue
        }
        if (c === quote) {
          closed = true
          j += 1
          break
        }
        if (c === '\n') {
          if (quote !== '`') break
          line += 1
        }
        body += c
        j += 1
      }
      if (closed) {
        if (CJK.test(body)) hits.push({ line: startLine, literal: body.trim() })
        i = j
        continue
      }
      // 未闭合：单/双引号当普通字符继续扫（防正则字面量带偏）；模板串只能走到 EOF。
      i = quote === '`' ? j : i + 1
      continue
    }

    if (ch === '\n') line += 1
    i += 1
  }
  return hits
}

/** B14 判据：扫一组源码，返回违规（`路径:行 → 命中原文`）。 */
function judgeCjkInSourceStrings(sources: readonly { path: string; text: string }[]): string[] {
  const offenders: string[] = []
  for (const { path, text } of sources) {
    for (const hit of collectCjkInStringLiterals(text)) {
      offenders.push(`${path}:${hit.line} → ${JSON.stringify(hit.literal)}`)
    }
  }
  return offenders
}

describe('B14 src/** 的模型可见字符串不含 CJK（注释除外）', () => {
  it('真实源码里没有含 CJK 的字符串字面量', () => {
    const sources = readSourcesUnder('src')
    // 非空自证：真的扫到了源码（0 个文件时这条会假绿）。
    expect(sources.length, 'src/** 下没扫到 TS 源码 —— 判据没跑到').toBeGreaterThan(5)

    const offenders = judgeCjkInSourceStrings(sources)
    expect(
      offenders,
      describeOffenders('src/** 的字符串字面量里出现 CJK', offenders) +
        '\n模型可见字符串必须用英文；若这是内部字符串，请确认它不会进入工具结果' +
        '（data 文本字段 / message / hint / nextStep.why / render 文本）。注释写中文不受此限。',
    ).toEqual([])
  })

  it('扫描器非空转：三种引号里的 CJK 必须报出来，注释里的必须放过', () => {
    const sample = [
      "const a = '中文'",
      'const b = "中文"',
      'const c = `中文`',
      '// 行注释里的中文不算',
      '/* 块注释里的中文也不算 */',
      "const ok = 'plain english'",
    ].join('\n')
    // 三行字符串各命中一次、行号 1/2/3；注释与英文一行都不报。
    expect(collectCjkInStringLiterals(sample).map((hit) => hit.line)).toEqual([1, 2, 3])
  })

  it('扫描器非空转：纯英文样本必须一个都不报', () => {
    expect(collectCjkInStringLiterals("const a = 'hello world'\nconst b = `hi`")).toEqual([])
  })

  it('判据可被否证：全角标点也算（真实命中过的那一族）', () => {
    expect(collectCjkInStringLiterals("const sep = '；'")).toHaveLength(1)
    expect(collectCjkInStringLiterals("const end = part.join('。')")).toHaveLength(1)
  })

  it('正则字面量里的引号不会把扫描器带偏（未闭合即当普通字符）', () => {
    const sample = ['const re = /[\'"]/', "const s = '中文'"].join('\n')
    // 第 1 行的引号是正则的一部分，不该被当成字符串起点把第 2 行吞掉。
    expect(collectCjkInStringLiterals(sample).map((hit) => hit.line)).toEqual([2])
  })

  it('转义引号不会提前闭合', () => {
    expect(
      collectCjkInStringLiterals("const q = 'a \\' 中文 \\' b'").map((hit) => hit.line),
    ).toEqual([1])
  })
})

/**
 * # 本文件的已知限度
 *
 * 这一节本身是判据的一部分：它让下一个改实现的人知道**哪些红线会跟着失效**。
 * 「能确证」与「只能推断」必须分开写 —— 把它拔高成「已确认」就等于制造新的假绿。
 *
 * 措辞约定：**【已探明】** = 用探针/反例实测过；**【推断】** = 从输入推不出来，只是当前如此。
 *
 * | # | 断言 | 依赖了哪个实现细节 | 改了会怎样 |
 * |---|---|---|---|
 * | 1 | B10 的安装面规则（`plugin` + 动词，不要求引号） | 只按子串匹配；认得的动词是硬编码的一小张表 | 出现动词表外的子命令（如 `dsh plugin why`）会**漏**（潜在假绿）；提示文案里出现「plugin add」会**误报** |
 * | 2 | B10 的 fs 写入族 | 判据只在「确有 `node:fs` 来源的名字」上生效；来源靠 import 语句文本识别 | 换一种拿 fs 的写法（`require`、把方法先赋给别的变量）会**漏**；见下方「已知未覆盖」 |
 * | 3 | B10 的 `fs.open` 可写标志 | 标志字符串是我列的集合 | 表外标志（如 `'rs+'` 之外的组合）会**漏** |
 * | 4 | B9 的提取器形态表 `TOOL_NAME_SHAPES` | 名字必须是**字面量**（三种引号之一），或是 `name:` 内联字面量 | 名字改成运行时拼接/从别处 import → 提不出来 → **判红**（响亮，不是假绿），需扩形态表并同步扩自检 |
 * | 5 | B9「文件在却提不出名字 = 红」 | **只看文件存在性**：`src/tools/` 下（排除 `index.ts` / `shared.ts`）有 `.ts` 就算子实现 | 判据已与代码写法解耦（上一版依赖 `defineTool(` 结构标记，换个工厂就会降级成 skip —— 已修）。**新边界**：只看存在、不看内容；若有人把实现挪出 `src/tools/`（或新增基础设施文件名），判据要跟着调 |
 * | 6 | B7 的 `files` 覆盖判定 | 我自写的 minimatch **代理**（只实现裸目录名/显式路径/`**` 后缀） | 不是 npm 本身：语义有偏差时**假绿**。唯一真判据是 `npm pack` 后看 tarball —— 未接进红线，属【推断】 |
 * | 7 | A2 的「族不只一族」（`split('||').length > 1`） | 借姊妹仓注释里的 npm 预发布匹配推理，**未在本机核** | 合理地收窄到单族会**红**（响亮误报）。【推断】 |
 * | 8 | B9 的 `EXPECTED_TOOLS` | 我手抄的**第 4 个副本**（另三份：`docs/ARCHITECTURE.md` 表、README×2、`src/tools` 常量） | **没有单一真源**。加第五个工具漏改这里会红（响亮）。【推断】 |
 * | 9 | B11 的 `en.title !== zh.title` | 我假设「中英各表其名」 | 产品名中英同形会**红**（误报）。【推断】 |
 * | 10 | A4 的 `scanned > 50`、B12 的 `body > 500` 阈值 | 我按当前规模猜的数（现状 188 / 约 1.1 万字节） | 仓合理地变小会**红**（响亮）。【推断】 |
 * | 11 | B12 的正文切片 `raw.indexOf('\n---', 4)` | 假定 frontmatter 之后没有更早的 `\n---` | 切错区域仍可能 > 500 → **假绿**（潜在）。【推断】 |
 * | 12 | A6 的 tag 形状 | 对 `release.yml` 做正则形状匹配 | 换一种同样正确的拼法（先赋 `V="v"`）会**红**（误报）；tag 改到别处生成则**看不见**（假绿）。【推断】 |
 * | 13 | A5 的反例控制 | 守卫的报错文案、以及注入锚点 `'          npm publish'` 的确切缩进 | 两者都已在文件里做成**响亮失败**（含「变异真的落地」自检），但都与实现细节耦合。【已探明】 |
 * | 14 | B14 的 CJK 扫描 | 自写状态机（注释 / 三种引号 / 转义 / 未闭合）；**引号未闭合时当普通字符** | 极端写法（跨行未闭合的引号）会**漏** —— TS 本就不允许裸换行，代价可忽略；模板串里 `${}` 表达式的文本会并入同一段 body，其中的 CJK 也照出（属真命中，不是误报）。【已探明】 |
 *
 * **B10 已知未覆盖的写入通道**（明确列出，不静默排除）：
 * `process.binding`、原生 addon、`require()`（本仓纯 ESM）、把 fs 方法先赋给别的变量再调用
 * （`const w = writeFileSync`）、以及经 `ctx.subprocess`/`ctx.shell` 发起的写命令。
 * 这些在本仓目前不出现；真出现时要靠人看出来，或把判据扩成 AST 级。
 *
 * **B9 第二个出口（提取器之外的）**：`src/tools/` 里**别处**出现的 `dsh_*` 字面量
 * （例如 `nextStep` 文案里的 `tool: 'dsh_dump_config'`）**不被提取器看见** ——
 * 判据只认「声明工具名」的形态（`TOOL_NAME_SHAPES`）。也就是说：把名字改成运行时拼接、
 * 却仍在文案里写旧名字，会**判红**（响亮，正是我们要的）；但反过来，
 * 文案里引用了闭集外的名字**不会**被这条判据照出来。这是**已知未覆盖**。
 *
 * **不要**为了消掉上面这些限度去扩大断言范围 —— 先把限度写清楚，再按需收紧。
 */
