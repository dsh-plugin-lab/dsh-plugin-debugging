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
 * 从源码文本里提取注册用的工具名常量（`export const X_TOOL = 'dsh_...'`）。
 *
 * 抽成函数是为了能拿**合成文本**验证它本身有效：一个坏掉的提取器会返回空集，
 * 而空集在「跳过未实现」的设计里看起来完全正常 —— 那就成了假绿。
 */
function collectDeclaredToolNames(sources: readonly { path: string; text: string }[]): string[] {
  const names: string[] = []
  for (const { text } of sources) {
    for (const match of stripComments(text).matchAll(
      /export\s+const\s+[A-Z0-9_]+_TOOL\s*=\s*'([a-z0-9_]+)'/g,
    )) {
      const name = match[1]
      if (name !== undefined) names.push(name)
    }
  }
  return names
}

/** 从一份 Markdown 里收集提到的 `dsh_*` 记号。 */
function collectMentionedToolNames(markdown: string): string[] {
  return [...markdown.matchAll(/\bdsh_[a-z0-9_]+/g)].map((match) => match[0])
}

/** 工具实现文件（排除聚合入口与共享工具）。 */
const TOOL_IMPL_SOURCES = readSourcesUnder('src/tools').filter(
  (source) => !source.path.endsWith('/index.ts') && !source.path.endsWith('/shared.ts'),
)

const declaredToolNames = [...new Set(collectDeclaredToolNames(TOOL_IMPL_SOURCES))].sort()
const toolHalfImplemented = declaredToolNames.length > 0

if (!toolHalfImplemented) {
  // 响了要看得见：跳过不是绿，这条日志是「本仓此刻还验不了这条」的唯一信号。
  console.warn(
    '[redlines] 工具半边尚未实现：src/tools/ 下没找到 *_TOOL 常量，B9 实现侧断言被跳过（不是通过）。',
  )
}

describe('B9 工具名是闭集', () => {
  it('提取器本身有效：喂合成源码能认出四个名字', () => {
    const synthetic = EXPECTED_TOOLS.map(
      (name, index) => `export const TOOL_${index}_TOOL = '${name}'`,
    ).join('\n')
    const found = collectDeclaredToolNames([{ path: 'synthetic.ts', text: synthetic }]).sort()
    expect(found).toEqual([...EXPECTED_TOOLS].sort())
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

  it.skipIf(!toolHalfImplemented)('实现侧：src/tools/ 声明的名字正好是闭集那四个', () => {
    expect(declaredToolNames).toEqual([...EXPECTED_TOOLS].sort())
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
 * - 禁止任何 fs 写入 API —— v1 不写 `$DSH_HOME`、不改 profile、不落状态文件。
 * - 禁止 `'plugin'` 字面量 —— 那是 `dsh plugin add/remove` 的入口；v1 不碰安装面。
 */
const FORBIDDEN_READONLY_VIOLATIONS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'process.kill', pattern: /\bprocess\.kill\b/ },
  { label: 'taskkill', pattern: /\btaskkill\b/i },
  { label: 'Stop-Process', pattern: /\bStop-Process\b/i },
  { label: 'SIGKILL', pattern: /\bSIGKILL\b/ },
  { label: 'SIGTERM', pattern: /\bSIGTERM\b/ },
  { label: 'writeFile', pattern: /\bwriteFile(Sync)?\b/ },
  { label: 'appendFile', pattern: /\bappendFile(Sync)?\b/ },
  { label: 'mkdir', pattern: /\bmkdir(Sync)?\b/ },
  { label: 'rm/rmSync', pattern: /\brm(Sync)?\s*\(/ },
  { label: 'rmdir', pattern: /\brmdir(Sync)?\b/ },
  { label: 'unlink', pattern: /\bunlink(Sync)?\b/ },
  { label: 'rename', pattern: /\brename(Sync)?\b/ },
  { label: 'copyFile', pattern: /\bcopyFile(Sync)?\b/ },
  { label: 'createWriteStream', pattern: /\bcreateWriteStream\b/ },
  { label: 'chmod', pattern: /\bchmod(Sync)?\b/ },
  { label: 'utimes', pattern: /\butimes(Sync)?\b/ },
  { label: 'symlink', pattern: /\bsymlink(Sync)?\b/ },
  { label: 'fs write flag', pattern: /['"]w['"]\s*[,)]/ },
  { label: "dsh plugin 安装面（'plugin' 字面量）", pattern: /['"]plugin['"]/ },
]

/** B10 判据：扫源码，返回违规（`路径:行号 → 记号`）。 */
function judgeReadOnly(sources: readonly { path: string; text: string }[]): string[] {
  const offenders: string[] = []
  for (const { path, text } of sources) {
    const lines = stripComments(text).split('\n')
    lines.forEach((line, index) => {
      for (const { label, pattern } of FORBIDDEN_READONLY_VIOLATIONS) {
        if (pattern.test(line)) offenders.push(`${path}:${index + 1} → ${label}`)
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

  it('判据可被否证：每种被禁动作都能被照出来', () => {
    const cases: Array<[string, string]> = [
      ['process.kill', 'process.kill(pid)'],
      ['taskkill', "spawn('taskkill', ['/T', '/F', '/PID', String(pid)])"],
      ['Stop-Process', "spawn('powershell', ['Stop-Process', '-Id', String(pid)])"],
      ['SIGKILL', "process.kill(pid, 'SIGKILL')"],
      ['writeFile', "writeFileSync(path, 'x')"],
      ['mkdir', 'mkdirSync(dir, { recursive: true })'],
      ['unlink', 'unlinkSync(path)'],
      ["dsh plugin 安装面（'plugin' 字面量）", "args: ['plugin', 'add', pkg]"],
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
