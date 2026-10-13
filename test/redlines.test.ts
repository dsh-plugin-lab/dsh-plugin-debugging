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
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterAll, describe, expect, it } from 'vitest'

import type { ResolvedConfig } from '../src/contracts.ts'
import type { NextStep, ToolData, ToolErrorKind, ToolResult } from '../src/lib/errors.ts'
import { ensureToolResult, toolResultProblem } from '../src/lib/errors.ts'
import type { SpawnImpl } from '../src/lib/exec.ts'
import type { ReloadEntryPort, ReloadHost } from '../src/lib/hot-reload.ts'
import type { FetchImpl } from '../src/lib/http.ts'
import { renderToolResultText, type RenderTable } from '../src/lib/render.ts'
import {
  composeDescription,
  DESCRIPTION_MAX_CHARS,
  DESCRIPTION_MAX_LINES,
  type ToolDescription,
} from '../src/tools/describe.ts'
import {
  CHECK_AUTH_DESCRIPTION,
  CHECK_AUTH_TOOL,
  createCheckAuthTool,
} from '../src/tools/dsh_check_auth.ts'
import {
  CHECK_EFFECT_MODE_DESCRIPTION,
  EFFECT_MODE_TOOL,
  createEffectModeTool,
} from '../src/tools/dsh_check_effect_mode.ts'
import {
  createDiagnosePluginLoadTool,
  DIAGNOSE_PLUGIN_LOAD_DESCRIPTION,
  DIAGNOSE_PLUGIN_LOAD_TOOL,
} from '../src/tools/dsh_diagnose_plugin_load.ts'
import {
  createDumpConfigTool,
  DUMP_CONFIG_DESCRIPTION,
  DUMP_CONFIG_TOOL,
} from '../src/tools/dsh_dump_config.ts'
import {
  createHotReloadTool,
  HOT_RELOAD_DESCRIPTION,
  HOT_RELOAD_TOOL,
} from '../src/tools/dsh_hot_reload.ts'
import { createToolDeps, type ToolDeps } from '../src/tools/shared.ts'

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
 * 去掉块注释与行注释，**但保留换行**。
 *
 * 必须有：源码注释里会正常出现「不杀进程」「`--dump-config` 退出码恒 0」这类字样，
 * 不剥注释就会把**解释规则的文字**当成违规。`[^:]` 那一段是防 `https://` ——
 * 不防的话 URL 里那个 `//` 会被当成行注释起点，把整行后半截吃掉。
 *
 * **为什么把块注释的内容换成等量空格而不是整段删掉**：本仓几乎每个文件开头都有一大段
 * 文档注释，整段删掉会让后面所有行号**整体前移** —— 于是红线报出的 `文件:行`
 * 是个**错的位置**（实测：注入在第 190 行，报出来是 143 行）。
 * 「一个精确到行的错位置，比一句模糊的描述更费人」，所以行号必须与真实文件对齐。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
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
  'dsh_hot_reload',
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
    // ⚠️ 必须写**字面量**名字，不能写 `EXPECTED_TOOLS[i]` —— 追加第 5 个工具后，
    // 这里只喂前四个形态，而末尾拿 `[...EXPECTED_TOOLS]` 断言，就会自己判自己红。
    const synthetic = [
      `export const A_TOOL = 'dsh_check_effect_mode'`,
      `export const B_TOOL = "dsh_diagnose_plugin_load"`,
      `export const C_TOOL = \`dsh_check_auth\``,
      `export const lowercaseName = "dsh_dump_config"`,
      `export function make() { return defineTool({ name: 'dsh_hot_reload' }) }`,
    ].join('\n')
    const found = [
      ...new Set(collectDeclaredToolNames([{ path: 'synthetic.ts', text: synthetic }])),
    ]
    // 四种常量形态 + 内联那一处（各一个名字，去重后正好是闭集本身）。
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
 * B10 判据：**诊断半边只读** —— 那四个诊断工具不许杀进程 / 写文件 / 走 `dsh plugin` 安装面。
 *
 * **它管的是诊断半边，不是「整个 `src/**` 只读」。** v1.1 起本仓有了**写侧**
 * （`dsh_hot_reload`），写侧的边界是**另一条**红线 —— B15（写侧只许碰进程内树）。
 * 两条的分工：B10 = 诊断半边不许改系统状态；B15 = 写侧不许越出进程内。
 * **这里三类扫描（杀进程 / fs 写入 / 安装面）一个字都没有放宽。**
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

/**
 * fs **写入类**用法的判定（B10 与 B15 共用）。
 *
 * 判据只在「确有 `node:fs` 来源的名字」上生效，见 {@link fsBindingsOf}。
 * 抽出来是因为两条红线共用同一套 fs 语义，分开写会漂。
 *
 * @param sources 源码（相对路径 + 内容）。
 * @returns 违规清单（`路径:行号 → 记号`）。
 */
function judgeFsWriteUsage(sources: readonly { path: string; text: string }[]): string[] {
  const offenders: string[] = []
  for (const { path, text } of sources) {
    const { namespaces, named } = fsBindingsOf(text)
    const lines = stripComments(text).split('\n')
    lines.forEach((line, index) => {
      const at = `${path}:${index + 1}`
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

/** B10 判据：扫源码，返回违规（`路径:行号 → 记号`）。 */
function judgeReadOnly(sources: readonly { path: string; text: string }[]): string[] {
  const offenders: string[] = []
  for (const { path, text } of sources) {
    const lines = stripComments(text).split('\n')
    lines.forEach((line, index) => {
      const at = `${path}:${index + 1}`
      for (const { label, pattern } of FORBIDDEN_PROCESS_VIOLATIONS) {
        if (pattern.test(line)) offenders.push(`${at} → ${label}`)
      }
    })
  }
  return [...offenders, ...judgeFsWriteUsage(sources)]
}

describe('B10 诊断半边只读：不含杀进程 / 写文件 / 走安装面的动作', () => {
  it('真实源码里没有杀进程 / 写文件 / 碰安装面的动作', () => {
    const sources = readSourcesUnder('src')
    // 非空自证：真的扫到了源码（0 个文件时这条会假绿）。
    expect(sources.length, 'src/** 下没扫到 TS 源码 —— 判据没跑到').toBeGreaterThan(5)

    const offenders = judgeReadOnly(sources)
    expect(offenders, describeOffenders('诊断半边只读被破坏', offenders)).toEqual([])
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

  it('真实 render.ts 不被误报（按**来源**判定，不按函数名前缀）', () => {
    const render = readSourcesUnder('src/lib').find((source) => source.path.endsWith('/render.ts'))
    expect(render, 'src/lib/render.ts 不在了 —— 这条防误报的判据要跟着改').toBeDefined()

    // ⚠️ 这里**曾经**写的是 `expect(render.text).toContain('function truncate')` —— 两个毛病：
    // ① 它是**子串/前缀**判据：W1 把函数改名成 `truncateKeyLines` 之后**照样通过**
    //    （`'function truncate'` 仍是它的子串），而那个名字**已不再与 fs 的 `truncate` 同名**
    //    —— 于是这条「防误报」自证**什么都没证明**（假绿）；
    // ② 反过来，谁把它写紧成 `\bfunction truncate\b`，一次**改名就会假红**。
    // 所以改成按**来源**判（B10 本来就是按来源判的），并用合成样本做**双向**自证。
    const bindings = fsBindingsOf(render?.text ?? '')
    expect(
      bindings.namespaces,
      'render.ts 忽然有了 node:fs 来源 —— 那它就不再是「同名本地助手」样本了',
    ).toEqual([])
    expect([...bindings.named], 'render.ts 从 node:fs 具名导入了东西 —— 同上').toEqual([])
    expect(judgeReadOnly([render!])).toEqual([])

    // 双向自证（**不依赖 render.ts 里的具体函数名**，改名/换写法都不会让它假红或空转）：
    // 本地同名助手 → 不报；同一名字但**来源是 node:fs** → 必须报。
    const localHelper =
      'function truncateKeyLines(lines: string[], max: number) { return lines.slice(0, max) }'
    expect(judgeReadOnly([{ path: 'synthetic.ts', text: localHelper }])).toEqual([])
    const fsSourced = ["import { truncate } from 'node:fs'", 'truncate(p, 0)'].join('\n')
    expect(
      judgeReadOnly([{ path: 'synthetic.ts', text: fsSourced }]),
      '同一名字一旦有 fs 来源就必须报 —— 否则上面那条「不报」是恒真的',
    ).not.toEqual([])
  })

  it('报出的行号是**真实文件行号**（块注释不能把行号带偏）', () => {
    // 实测踩过：`stripComments` 早先整段删掉块注释，于是注入在第 190 行的违规被报成 143 行。
    // 行号错的位置比模糊的描述更费人 —— 所以这条断言钉住「块注释不吃掉行」。
    const source = [
      '/**',
      ' * 一段跨多行的文档注释',
      ' * 第二行',
      ' * 第三行',
      ' */',
      'const before = 1',
      'process.kill(pid)',
    ].join('\n')
    expect(judgeReadOnly([{ path: 'synthetic.ts', text: source }])).toEqual([
      'synthetic.ts:7 → process.kill',
    ])
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
 * B15 判据：**写侧工具只许碰进程内树**。
 *
 * v1.1 起本仓有写侧（`dsh_hot_reload`）：它改的是**进程内**的模块缓存与 fiber ——
 * 不写文件、不起子进程、不杀进程、不碰 `$DSH_HOME`。这是对外承诺，
 * 决策见 `.agents/notes/2026-10-13-write-side-tool-boundaries.md`。
 *
 * **为什么按文件清单限定**（而不是扫全 `src/**`）：诊断半边**合法地** spawn
 * `dsh --dump-config`（只读 CLI，出口在 `src/lib/exec.ts`）并**读**文件；
 * 全扫会把那些合法用法判红。B10 与 B15 的分工就在这里：
 * **B10 = 诊断半边不许改系统状态；B15 = 写侧不许越出进程内。**
 *
 * **没有 skip**：「这两个文件在不在」本身就是判据的一部分 —— 写侧被删/改名时，
 * 应当**响亮失败并要求人显式改这条红线**，而不是静默跳过（本仓假绿判例，见活跃坑 18）。
 */
const WRITE_SIDE_FILES = ['src/tools/dsh_hot_reload.ts', 'src/lib/hot-reload.ts'] as const

/** 写侧额外禁止的记号（fs 写入类由 {@link judgeFsWriteUsage} 另行判定）。 */
const WRITE_SIDE_FORBIDDEN: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'node:child_process（写侧不起子进程）', pattern: /['"`]node:child_process['"`]/ },
  { label: 'process.kill', pattern: /\bprocess\.kill\b/ },
  { label: 'taskkill', pattern: /\btaskkill\b/i },
  { label: 'Stop-Process', pattern: /\bStop-Process\b/i },
  { label: 'SIGKILL', pattern: /\bSIGKILL\b/ },
  { label: 'SIGTERM', pattern: /\bSIGTERM\b/ },
  { label: 'DSH_HOME（写侧不碰宿主主目录）', pattern: /\bDSH_HOME\b/ },
]

/** B15 判据：扫写侧文件，返回违规（`路径:行号 → 记号`）。 */
function judgeWriteSide(sources: readonly { path: string; text: string }[]): string[] {
  const offenders: string[] = []
  for (const { path, text } of sources) {
    const lines = stripComments(text).split('\n')
    lines.forEach((line, index) => {
      const at = `${path}:${index + 1}`
      for (const { label, pattern } of WRITE_SIDE_FORBIDDEN) {
        if (pattern.test(line)) offenders.push(`${at} → ${label}`)
      }
    })
  }
  return [...offenders, ...judgeFsWriteUsage(sources)]
}

describe('B15 写侧工具只许碰进程内树', () => {
  it('写侧两个文件都在（不在 = 响亮失败，要求显式改这条红线）', () => {
    const missing = WRITE_SIDE_FILES.filter((rel) => !existsRepo(rel))
    expect(
      missing,
      `写侧文件不见了：${missing.join(', ')}。` +
        '\n这不是「写侧还没实现」—— 本红线按文件清单限定作用域，文件被删/改名必须显式改这里，' +
        '否则这条判据会**静默变成空转**。',
    ).toEqual([])
  })

  it('真实写侧源码里没有 fs 写入 / 子进程 / 杀进程 / DSH_HOME', () => {
    const sources = WRITE_SIDE_FILES.map((rel) => ({ path: rel, text: readRepo(rel) }))
    // 非空自证：两处都真读到了内容（读成空串会让这条假绿）。
    for (const { path, text } of sources) {
      expect(text.length, `${path} 读出来是空的 —— 判据没跑到`).toBeGreaterThan(200)
    }

    const offenders = judgeWriteSide(sources)
    expect(
      offenders,
      describeOffenders('写侧越出了进程内', offenders) +
        '\n写侧只许改进程内的模块缓存与 fiber：不写文件、不起子进程、不杀进程、不碰 $DSH_HOME。' +
        '（诊断半边起 `dsh --dump-config` 是合法的，那条由 B10 管 —— 别放宽 B10。）',
    ).toEqual([])
  })

  it('扫描器非空转：含 writeFile 的样本必须报，纯只读样本必须不报', () => {
    const writing = [
      "import { writeFile } from 'node:fs/promises'",
      'export async function f(p: string) {',
      "  await writeFile(p, 'x')",
      '}',
    ].join('\n')
    const readOnly = [
      "import { readFile } from 'node:fs/promises'",
      'export async function f(p: string) {',
      "  return await readFile(p, 'utf8')",
      '}',
    ].join('\n')
    expect(judgeWriteSide([{ path: 'w.ts', text: writing }]).length).toBeGreaterThan(0)
    expect(judgeWriteSide([{ path: 'r.ts', text: readOnly }])).toEqual([])
  })

  it('判据可被否证：四类禁止记号都能照出来', () => {
    const cases: Array<string> = [
      "import { spawn } from 'node:child_process'",
      'process.kill(pid)',
      "const home = process.env.DSH_HOME + '/profiles'",
      "import { rmSync } from 'node:fs'\nrmSync(p, { recursive: true })",
    ]
    for (const source of cases) {
      expect(
        judgeWriteSide([{ path: 'synthetic.ts', text: source }]),
        `漏了：${source}`,
      ).not.toEqual([])
    }
  })

  it('读文件与只读 fs API 不算违规（别误伤合法用法）', () => {
    const source = [
      "import { readFileSync } from 'node:fs'",
      'export function f(p: string) { return readFileSync(p, "utf8") }',
    ].join('\n')
    expect(judgeWriteSide([{ path: 'synthetic.ts', text: source }])).toEqual([])
  })
})

/**
 * # 渲染层三条红线：B16 / B18b / B22
 *
 * 三条都只吃 `renderToolResultText` 的**输出文本**，所以合成 fixture 就能钉住形状
 * （不必 import 任何工具）。等 T2（五个工具的描述与 `data` 全齐）再把夹具换成真实工具。
 *
 * 共用**唯一一处**「哪一行是哪一层」的实现 {@link splitRenderText} —— 三条红线共用，
 * 不许各写一份（各写一份必然漂，而漂出来的形状是「红线绿但模型看到别的」）。
 */

/** 渲染头行（`[tool] ok` / `[tool] failed (kind)`）。 */
const RENDER_HEAD_RE = /^\[[\w_]+\] (?:ok|failed \([\w-]+\))$/

/**
 * 截断模板行（§3.1 规则 3）。
 *
 * **恒定模板** ⇒ B16 必须排除它：两份 fixture 若都被截断、且还剩同样的条数，
 * 这一行就逐字相同 → **假红**（§10 B16 明写）。
 */
const RENDER_TRUNCATED_RE = /^\d+ more line\(s\) not shown — the full record is in the session log$/

/** L1 前缀。 */
const RENDER_VERDICT_PREFIX = 'verdict: '
/** L3 前缀。 */
const RENDER_NEXT_STEP_PREFIX = 'nextStep:'
/** 工具支里 `<tool>(<args>)` 与 `<why>` 之间的分隔符（§3.1 两支逐字形状）。 */
const NEXT_STEP_TOOL_SEPARATOR = ' — '

/** 渲染文本按层切开的结果。 */
interface RenderLayers {
  /** 头行。 */
  head: string
  /** L1 正文（`verdict: ` 之后）；没有判定行时 `undefined`。 */
  verdict: string | undefined
  /** L2 行（**已剔除截断模板行**）。 */
  l2: string[]
  /** L3 正文（`nextStep:` 之后、trim 过）；没有下一步时 `undefined`。 */
  nextStep: string | undefined
  /** 形状不合法 → 退化成一行原始 JSON（§3.1 规则 4）。 */
  degenerate: boolean
}

/**
 * 按 §3.1 的冻结格式把渲染文本切成三层。
 *
 * @param text `renderToolResultText` 的输出。
 */
function splitRenderText(text: string): RenderLayers {
  const lines = text.split('\n')
  const head = lines[0] ?? ''
  const verdictIndex = lines.findIndex((line) => line.startsWith(RENDER_VERDICT_PREFIX))
  const nextStepIndex = lines.findIndex((line) => line.startsWith(RENDER_NEXT_STEP_PREFIX))
  const l2End = nextStepIndex < 0 ? lines.length : nextStepIndex
  return {
    head,
    verdict:
      verdictIndex < 0
        ? undefined
        : (lines[verdictIndex] ?? '').slice(RENDER_VERDICT_PREFIX.length),
    l2: (verdictIndex < 0 ? [] : lines.slice(verdictIndex + 1, l2End)).filter(
      (line) => !RENDER_TRUNCATED_RE.test(line),
    ),
    nextStep:
      nextStepIndex < 0
        ? undefined
        : (lines[nextStepIndex] ?? '').slice(RENDER_NEXT_STEP_PREFIX.length).trim(),
    degenerate: !RENDER_HEAD_RE.test(head),
  }
}

// ── B16 输出里不许有恒定块 ────────────────────────────────────────────────

/** B16 的阈值：只有 ≥40 字符的行才算「恒定块」候选。 */
const CONSTANT_BLOCK_MIN_CHARS = 40

/**
 * B16 取候选行：**只看 `verdict:` 行与 L2 行**（§3.1 规则 5）。
 *
 * 三处排除各对应一种**假红**（不排除就会误报）：
 * - `[tool] …` 头行：同一个工具两份 fixture 恒同 → 永远红；
 * - `nextStep:` 行：两份 fixture 给同一条下一步建议是**合法**的（§3 明说跨工具链里
 *   不随结果变的那段属于描述②）；
 * - 截断模板行：恒定模板，同 `n` 时逐字相同。
 */
function constantBlockCandidates(text: string): string[] {
  const layers = splitRenderText(text)
  const lines = [
    ...(layers.verdict === undefined ? [] : [`${RENDER_VERDICT_PREFIX}${layers.verdict}`]),
    ...layers.l2,
  ]
  return lines.filter((line) => line.length >= CONSTANT_BLOCK_MIN_CHARS)
}

/**
 * B16 下界（§10.0）：**两份 fixture 都**必须真的产出候选行。
 *
 * 两份都为空时交集恒为空 → 判据**恒真**；只有一份为空时交集同样恒空 ——
 * 所以下界要求的是「两份都非空」，不是「一共非空」。
 *
 * @param texts 各份 fixture 的渲染文本。
 */
function judgeConstantBlockCandidates(texts: readonly string[]): string[] {
  const offenders: string[] = []
  texts.forEach((text, index) => {
    if (constantBlockCandidates(text).length === 0) {
      offenders.push(
        `第 ${String(index + 1)} 份 fixture 一条 ≥${String(CONSTANT_BLOCK_MIN_CHARS)} 字符的 verdict/L2 行都没有` +
          ' —— 「共有行」恒为空，判据在空转',
      )
    }
  })
  return offenders
}

/** B16 判据：两份渲染文本之间**逐字相同**的候选行（空 = 通过）。 */
function judgeConstantBlocks(first: string, second: string): string[] {
  const secondSet = new Set(constantBlockCandidates(second))
  return constantBlockCandidates(first).filter((line) => secondSet.has(line))
}

// ── B18b L3 的 why 不许逐字等于 L1 ────────────────────────────────────────

/**
 * 取出 L3 的 `<why>` 正文（§3.1「两支的逐字形状」里 B18b 的判定对象）。
 *
 * 工具支是 `<tool>(<args>) — <why>`，manual 支是 `<why>`。
 *
 * **为什么必须剥掉 `tool(args) — ` 那段前缀**：不剥的话，工具支的正文里恒有
 * `tool(args)` 在前，就**永远不可能**等于 L1 —— 这条红线对工具支就**恒真**了，
 * 而它要抓的恰恰是「把结论原样当 why 用」。
 *
 * ⚠️ 已知限度：用**第一个** ` — ` 切分。`why` 自己含 ` — ` 时会切早
 * （合成夹具不会；真实工具若出现，见文末「已知限度」）。
 *
 * @param text 渲染文本。
 */
function nextStepWhy(text: string): string | undefined {
  const body = splitRenderText(text).nextStep
  if (body === undefined) return undefined
  const at = body.indexOf(NEXT_STEP_TOOL_SEPARATOR)
  return at < 0 ? body : body.slice(at + NEXT_STEP_TOOL_SEPARATOR.length)
}

/**
 * B18b 判据：L3 的 `<why>` 不许逐字等于 L1。
 *
 * ⚠️ **这条是防御性症状监控，不是根因判据。** 根因是「没有动作的 `nextStep` 在类型上
 * 写不出来」，由 **B18a** 守（要等 T2：需要五个工具齐）。与本条拆开的理由见 §10 B18b：
 * **「结论恰好等于动作描述」是合法的**（由 B18a 排除），**「结论被当下一步复述」是坏的**（本条报警）。
 */
function judgeNextStepEchoesVerdict(text: string): string[] {
  const verdict = splitRenderText(text).verdict
  const why = nextStepWhy(text)
  if (verdict === undefined || why === undefined) return []
  return why === verdict ? [`L3 的 why 逐字等于 L1：${why}`] : []
}

// ── B22 audit 不进模型文本 ────────────────────────────────────────────────

/** B22 判据：`audit` 的哨兵不许出现在渲染文本里。 */
function judgeAuditLeak(text: string, sentinel: string): string[] {
  return text.includes(sentinel) ? [`渲染文本里出现了 audit 的哨兵：${sentinel}`] : []
}

/**
 * B22 下界（§10.0）：哨兵必须**真的**在 `data.audit` 里。
 *
 * 不查这一条的话，「文本里不含哨兵」在**哨兵压根没放进去**时也成立 —— 判据恒真。
 *
 * @param value 夹具的返回值。
 * @param sentinel 哨兵字符串。
 */
function auditJsonOf(value: unknown): string | undefined {
  const record = value as { data?: { audit?: unknown } }
  try {
    return JSON.stringify(record.data?.audit)
  } catch {
    return undefined
  }
}

// ── 合成夹具 ──────────────────────────────────────────────────────────────

/** 合成工具的 `key` 形状：**同时**含「按输入变」与「按环境变」的字段（§3.1 规则 6）。 */
interface SyntheticKey {
  /** 环境（临时 home）—— 两份 fixture 必须各用一份，否则 `resolved:` 恒同 → 假红。 */
  home: string
  /** 输入。 */
  mode: string
  /** 输入。 */
  port: number
}

/** 合成工具的 `RenderTable`：L2 三行，其中一行来自**环境**。 */
const SYNTHETIC_TABLE: RenderTable<SyntheticKey> = {
  key: (data) => [
    `resolved: dshHome=${data.key.home}`,
    `change=${data.key.mode}`,
    `port=${String(data.key.port)}`,
  ],
}

/** 造一份合成的**成功** fixture。 */
function okFixture<T>(
  verdict: string,
  key: T,
  options: { audit?: unknown; nextStep?: NextStep } = {},
): ToolResult<T> {
  return {
    ok: true,
    data: { verdict, key, audit: (options.audit ?? {}) as ToolData<T>['audit'] },
    ...(options.nextStep === undefined ? {} : { nextStep: options.nextStep }),
  }
}

/** 造一份合成的**失败** fixture。 */
function failFixture<T>(
  kind: ToolErrorKind,
  message: string,
  verdict: string,
  key: T,
  options: { audit?: unknown; nextStep?: NextStep } = {},
): ToolResult<T> {
  return {
    ok: false,
    error: { kind, message },
    data: { verdict, key, audit: (options.audit ?? {}) as ToolData<T>['audit'] },
    ...(options.nextStep === undefined ? {} : { nextStep: options.nextStep }),
  }
}

/** 渲染一份合成 fixture。 */
function renderSynthetic(value: ToolResult<SyntheticKey>, toolName = 'dsh_synth'): string {
  return renderToolResultText(toolName, value, SYNTHETIC_TABLE)
}

describe('B16 输出里不许有恒定块', () => {
  it('两份 fixture（**输入与环境各不同**）之间没有 ≥40 字符的共有行', () => {
    // 规则 6：**各用一份不同的临时 home**。这不是随便挑两份 —— `resolved:` 这类行
    // 按**环境**恒定、不按输入恒定；共用同一个 home 时它必然逐字相同 → 假红。
    const homeA = makeTempRoot('dsh-b16-a-')
    const homeB = makeTempRoot('dsh-b16-b-')
    const textA = renderSynthetic(
      okFixture('the change applies live: hot reload is watching this profile', {
        home: homeA,
        mode: 'config',
        port: 3080,
      }),
    )
    const textB = renderSynthetic(
      okFixture('a restart is required before the new code can take effect', {
        home: homeB,
        mode: 'host-code',
        port: 3101,
      }),
    )

    // 先立下界：任一fixture 产不出候选行，下面的「共有行」就是恒真的空转。
    const unusable = judgeConstantBlockCandidates([textA, textB])
    expect(unusable, `B16 判据空转 —— 「共有行」会恒为空：\n${unusable.join('\n')}`).toEqual([])
    // 自证：两份的环境行确实不同（否则这条用例证明不了「环境也变了」）。
    expect(textA).not.toContain(homeB)
    expect(textB).not.toContain(homeA)

    const offenders = judgeConstantBlocks(textA, textB)
    expect(
      offenders,
      describeOffenders('输出里出现了恒定块', offenders) +
        '\n恒定知识应当写在**描述层**（写一次），而不是每次输出都印一遍。',
    ).toEqual([])
  })

  it('判据可被否证：注入一条恒定 ≥40 字符的 L2 行 → 红', () => {
    const constant = 'resolved: dshHome=THIS_LINE_IS_IDENTICAL_IN_BOTH_FIXTURES'
    const leakyTable: RenderTable<SyntheticKey> = { key: () => [constant] }
    const textA = renderToolResultText(
      'dsh_synth',
      okFixture('first conclusion that differs from the second one', {
        home: 'a',
        mode: 'config',
        port: 1,
      }),
      leakyTable,
    )
    const textB = renderToolResultText(
      'dsh_synth',
      okFixture('second conclusion that also differs from the first', {
        home: 'b',
        mode: 'host-code',
        port: 2,
      }),
      leakyTable,
    )
    // 下界先过（两份都产出了候选行），所以下面的命中是真命中，不是空转。
    expect(judgeConstantBlockCandidates([textA, textB])).toEqual([])
    expect(judgeConstantBlocks(textA, textB)).toEqual([constant])
  })

  it('下界本身可被否证：候选行为空（含「只有一份为空」）→ 判红，不许 skip', () => {
    const emptyTable: RenderTable<SyntheticKey> = { key: () => [] }
    const key: SyntheticKey = { home: 'x', mode: 'config', port: 1 }
    const shortA = renderToolResultText('dsh_synth', okFixture('short a', key), emptyTable)
    const shortB = renderToolResultText('dsh_synth', okFixture('short b', key), emptyTable)

    // 恒真：交集为空 —— 这正是必须补下界的那一类。
    expect(judgeConstantBlocks(shortA, shortB)).toEqual([])
    expect(judgeConstantBlockCandidates([shortA, shortB])).not.toEqual([])

    // 「只有一份为空」同样让交集恒空，下界必须也抓住它。
    const rich = renderSynthetic(
      okFixture('a conclusion long enough to become a candidate line here', {
        home: 'x',
        mode: 'config',
        port: 1,
      }),
    )
    expect(judgeConstantBlocks(rich, shortA)).toEqual([])
    expect(judgeConstantBlockCandidates([rich, shortA])).not.toEqual([])
  })

  it('别误伤：两份 fixture 共有的头行 / nextStep 行 / 截断模板行都不算恒定块', () => {
    // 三处排除各对着一种假红。这里把三种**真的共有**的东西同时摆出来：
    // ① 头行：工具名取得长到 ≥40 字符；② nextStep：两份给同一条（合法）；③ 截断模板行：同 n。
    const longToolName = 'dsh_a_deliberately_very_long_synthetic_tool_name'
    const shared = {
      tool: 'dsh_dump_config',
      why: 'read the composed tree to see which row is actually missing',
    }
    const truncatingTable: RenderTable<SyntheticKey> = {
      maxKeyLines: 1,
      key: (data) => [
        `resolved: dshHome=${data.key.home}`,
        'second line that is long enough to be a candidate here',
        'third line that is also long enough to be a candidate',
      ],
    }
    const textA = renderToolResultText(
      longToolName,
      okFixture(
        'first conclusion long enough to be a candidate line',
        {
          home: 'a',
          mode: 'config',
          port: 1,
        },
        { nextStep: shared },
      ),
      truncatingTable,
    )
    const textB = renderToolResultText(
      longToolName,
      okFixture(
        'second conclusion long enough to be a candidate too',
        {
          home: 'b',
          mode: 'host-code',
          port: 2,
        },
        { nextStep: shared },
      ),
      truncatingTable,
    )

    // 自证：这三样**真的**在文本里且**真的**两份共有 —— 否则「不报」是空转。
    expect(textA.split('\n')[0]!.length).toBeGreaterThanOrEqual(CONSTANT_BLOCK_MIN_CHARS)
    expect(textA.split('\n')[0]).toBe(textB.split('\n')[0])
    expect(textA).toContain('2 more line(s) not shown')
    expect(textB).toContain('2 more line(s) not shown')
    expect(textA).toContain(shared.why)
    expect(textB).toContain(shared.why)

    // 判据：一个都不报。
    expect(judgeConstantBlocks(textA, textB)).toEqual([])
    // 而候选行确实非空（判据没在空转）。
    expect(judgeConstantBlockCandidates([textA, textB])).toEqual([])
  })
})

describe('B18b L3 的 why 不许逐字等于 L1', () => {
  const VERDICT = 'the entry is mounted but its fiber never reached the active phase'

  it('两支都覆盖：工具支与 manual 支的 why 都不等于 L1，且**两条都真的适用**', () => {
    const cases: ReadonlyArray<{ label: string; nextStep: NextStep }> = [
      {
        label: '工具支',
        nextStep: {
          tool: 'dsh_dump_config',
          args: { profile: 'web' },
          why: 'read the composed tree to see which row is actually missing',
        },
      },
      {
        label: 'manual 支',
        nextStep: { manual: true, why: 'rebuild the client bundle and refresh the page' },
      },
    ]

    let applicable = 0
    for (const item of cases) {
      const text = renderSynthetic(
        okFixture(VERDICT, { home: 'h', mode: 'config', port: 3080 }, { nextStep: item.nextStep }),
      )
      // 计数而不是静默 skip：`nextStep` 缺席时这条不适用，但**数量必须对得上**。
      if (nextStepWhy(text) === undefined) continue
      applicable += 1
      const offenders = judgeNextStepEchoesVerdict(text)
      expect(offenders, describeOffenders(`${item.label} 的 why 复述了 L1`, offenders)).toEqual([])
    }
    expect(applicable, '两条支一条都没适用 —— 判据空转（不许静默 skip）').toBe(cases.length)
  })

  it('判据可被否证：manual 支的 why 逐字等于 L1 → 红', () => {
    // 这正是今天 `diagnose` 的形状：`ok({...data, verdict}, { why: verdict })` —— 同一个 const 绑两次。
    const text = renderSynthetic(
      okFixture(
        VERDICT,
        { home: 'h', mode: 'config', port: 3080 },
        {
          nextStep: { manual: true, why: VERDICT },
        },
      ),
    )
    expect(judgeNextStepEchoesVerdict(text)).not.toEqual([])
  })

  it('判据可被否证：**工具支**的 why 逐字等于 L1 也要红（证明剥掉了 `tool(args) — ` 前缀）', () => {
    // 不剥前缀的话，工具支正文恒含 `tool(args)`，永远不可能等于 L1 → 这条对工具支恒真。
    const text = renderSynthetic(
      okFixture(
        VERDICT,
        { home: 'h', mode: 'config', port: 3080 },
        {
          nextStep: { tool: 'dsh_dump_config', why: VERDICT },
        },
      ),
    )
    expect(text).toContain(`${NEXT_STEP_TOOL_SEPARATOR}${VERDICT}`)
    expect(judgeNextStepEchoesVerdict(text)).not.toEqual([])
  })

  it('别误伤：没有 nextStep 时本条不适用（而不是判红）', () => {
    const text = renderSynthetic(okFixture(VERDICT, { home: 'h', mode: 'config', port: 3080 }))
    expect(splitRenderText(text).nextStep).toBeUndefined()
    expect(judgeNextStepEchoesVerdict(text)).toEqual([])
  })
})

describe('B22 audit 不进模型文本', () => {
  /** 足够独特，不会与描述/格式里的词撞。 */
  const SENTINEL = 'SENTINEL_B22_9f3a1c_audit_must_not_reach_the_model'

  it('成功与失败两档：哨兵真的在 audit 里，而渲染文本不含它', () => {
    const key: SyntheticKey = { home: 'h', mode: 'config', port: 3080 }
    const cases: ReadonlyArray<{ label: string; value: ToolResult<SyntheticKey> }> = [
      {
        label: '成功档',
        value: okFixture('ok verdict line', key, { audit: { deep: [SENTINEL] } }),
      },
      {
        label: '失败档',
        value: failFixture('internal', 'something went wrong', 'failed verdict line', key, {
          audit: { deep: [SENTINEL] },
        }),
      },
    ]

    for (const item of cases) {
      // 下界：哨兵**真的**被放进去了（否则「不含它」恒真 —— §10.0）。
      expect(
        auditJsonOf(item.value),
        `${item.label} 的哨兵没放进 audit —— 这条判据会恒真`,
      ).toContain(SENTINEL)

      const text = renderSynthetic(item.value)
      const offenders = judgeAuditLeak(text, SENTINEL)
      expect(
        offenders,
        describeOffenders(`${item.label} 把 audit 印进了模型文本`, offenders),
      ).toEqual([])
    }
  })

  it('判据非空转：把哨兵放进渲染文本（模拟旧版整块 JSON）→ 必须照出来', () => {
    // 旧 render.ts 是 `stableJson(result.data)` —— 整块 JSON 进上下文，audit 必然在里面。
    const leaking = `[dsh_synth] ok\nverdict: v\n${JSON.stringify({ audit: { deep: [SENTINEL] } })}`
    expect(judgeAuditLeak(leaking, SENTINEL)).not.toEqual([])
  })

  it('下界本身可被否证：哨兵没放进 audit 时，文本当然不含它 —— 这正是必须查下界的理由', () => {
    const value = okFixture('v', { home: 'h', mode: 'config', port: 1 }, { audit: {} })
    expect(auditJsonOf(value)).not.toContain(SENTINEL)
    // 「文本不含哨兵」照样成立 —— 所以只有下界能把这种空转拦下来。
    expect(judgeAuditLeak(renderSynthetic(value), SENTINEL)).toEqual([])
  })
})

/**
 * # B19 / B23：观察层的 import 闭包
 *
 * 两条红线共用同一个底座：从**观察层四个工具文件**出发，递归解析**相对 import**，
 * 得到完整依赖闭包（含 `src/lib/**`），再在闭包上判两件事：
 *
 * | 红线 | 判什么 | 为什么要有 |
 * |---|---|---|
 * | **B19** | 不许触到**取值路径**（`lib/cookie.ts` 整体；`lib/credentials.ts` 只许存在性扫描） | 观察层必须停在「存在性」这一档，不许把密钥读出来带进输出 |
 * | **B23** | 不许**自己写文件** | `audit` 落盘只能经宿主服务，不许本仓写（§5） |
 *
 * ## ⚠️ B23 相对 B10 的关系（**必须先读，否则会以为它提供了 B10 没有的 fs 覆盖**）
 *
 * `[已核]` **B10 已经在扫整个 `src/**`**，且 `FS_WRITE_APIS` 里**已含** `writeFile` / `mkdir` 等。
 * 所以「fs 写入族」那一部分**是 B10 的子集**，B23 在这里**没有增量**。
 * B23 的**真实增量只有两条**：
 *
 * 1. **项目内写 helper 的名字**（`writeText(…)` 这类）—— 它们是**本仓自己的函数**、不是 `node:fs` API，
 *    而 B10 的判据是「**须有 `node:fs` 来源**」⇒ **照不到它们**；
 * 2. 把判据**钉在观察层闭包**上，而不是「整个 `src/**`」—— 将来写侧若合法获得写入能力，
 *    B10（全局）会误伤，而 B23（只管观察层）不会。
 *
 * **不要**为了「让 B23 看起来更值钱」去放宽 B10 或删掉它 —— B10 才是那层保护。
 *
 * ## ⚠️ 下界（SHAPE §10.0）：空转必须判红，不许 skip
 *
 * 两条红线都是「闭包里**不得**出现 X」的形状 —— 而**空集不含 X**。
 * 所以 import 解析一旦失效（正则过时、路径拼装改错、入口文件被改名），闭包缩成空集，
 * 两条红线都会**恒真**，且看起来完全正常（活跃坑 18 的教科书形状）。
 * 因此 {@link judgeClosureUsable} 是**两条红线共同的前置断言**，它自己也可被否证（见各自的用例）。
 */

/** 观察层四个工具 —— **逐个列出，不用 glob**。glob 会在文件被删/改名时静默缩水。 */
const OBSERVATION_TOOL_FILES = [
  'src/tools/dsh_check_auth.ts',
  'src/tools/dsh_check_effect_mode.ts',
  'src/tools/dsh_diagnose_plugin_load.ts',
  'src/tools/dsh_dump_config.ts',
] as const

/** 读一份仓内源码；文件不在就返回 `undefined`（合成用例靠它注入）。 */
type SourceReader = (relPath: string) => string | undefined

/** 默认的读取器：真的读磁盘。 */
function repoSourceReader(relPath: string): string | undefined {
  return existsRepo(relPath) ? readRepo(relPath) : undefined
}

/** 一条 import 语句（已剥注释、带**真实文件行号**）。 */
interface ImportStatement {
  /** `import type …`（整条语句都是类型）。 */
  typeOnly: boolean
  /** `from` 之前的子句；副作用 import 是空串。 */
  clause: string
  /** 模块说明符的字面量。 */
  spec: string
  /** 1 起的**真实**行号（`stripComments` 保留换行，所以与文件对齐）。 */
  line: number
}

/**
 * 拆出一份源码里的 import 语句。
 *
 * 先 `stripComments` —— 本仓会在文档注释里写 import 例子（例如 `shared.ts` 的契约说明），
 * 不剥注释就会把**解释规则的文字**当成真依赖。
 */
function importStatementsOf(source: string): ImportStatement[] {
  const text = stripComments(source)
  const lineOf = (index: number): number => text.slice(0, index).split('\n').length
  const out: ImportStatement[] = []
  // 常规形态：import [type] <clause> from '<spec>'
  for (const match of text.matchAll(/import\s+(type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
    out.push({
      typeOnly: (match[1] ?? '') !== '',
      clause: match[2] ?? '',
      spec: match[3] ?? '',
      line: lineOf(match.index ?? 0),
    })
  }
  // 副作用形态：import '<spec>'（没有 from，所以与上面那条不重叠）
  for (const match of text.matchAll(/import\s+['"]([^'"]+)['"]/g)) {
    out.push({ typeOnly: false, clause: '', spec: match[1] ?? '', line: lineOf(match.index ?? 0) })
  }
  return out
}

/** 从 import 子句里拆出的绑定。 */
interface ImportBindings {
  /** **值**绑定（`*` 表示命名空间导入）。 */
  values: string[]
  /** 纯**类型**绑定（`type X` 或 `import type`）—— 取不到值，不算越界。 */
  types: string[]
  /** 命名空间 / 默认导入：拿到的是「整个模块」，任何导出都变得可达。 */
  namespaceOrDefault: boolean
}

/**
 * 拆一条 import 子句。
 *
 * **为什么必须区分值与类型**：`check_auth` 今天写的是
 * `import { readCredentialsPresence, type CredentialsPresence } from '../lib/credentials.js'` ——
 * 值那半是**允许**的存在性扫描，类型那半是**无害**的（类型不取运行时值）。
 * 不区分就会把这条**合规**的 import 判红（假红），而假红会逼人去放宽判据。
 */
function parseImportClause(clause: string, typeOnlyStatement: boolean): ImportBindings {
  const values: string[] = []
  const types: string[] = []
  let namespaceOrDefault = false
  const trimmed = clause.trim()

  if (trimmed.startsWith('*')) {
    if (typeOnlyStatement) types.push('*')
    else {
      namespaceOrDefault = true
      values.push('*')
    }
    return { values, types, namespaceOrDefault }
  }

  if (trimmed.startsWith('{')) {
    for (const part of (trimmed.slice(1, trimmed.lastIndexOf('}')) ?? '').split(',')) {
      const piece = part.trim()
      if (piece === '') continue
      const isType = typeOnlyStatement || /^type\s/.test(piece)
      const name =
        piece
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)[0]
          ?.trim() ?? ''
      if (name === '') continue
      if (isType) types.push(name)
      else values.push(name)
    }
    return { values, types, namespaceOrDefault }
  }

  if (trimmed !== '') {
    // 默认导入（`import x from`）。`import type x from` 是纯类型，不算可达值。
    const name = trimmed.split(',')[0]?.trim() ?? ''
    if (!typeOnlyStatement) namespaceOrDefault = true
    if (name !== '') (typeOnlyStatement ? types : values).push(name)
  }
  return { values, types, namespaceOrDefault }
}

/** 把相对说明符解析成仓内相对路径（`.js` → `.ts`，本仓是 ESM + TS 源码）。 */
function resolveRelativeImport(fromRelPath: string, spec: string): string {
  const joined = posix.join(posix.dirname(fromRelPath), spec)
  return joined.endsWith('.js') ? `${joined.slice(0, -3)}.ts` : joined
}

/** 闭包里的一个文件（连内容一起带着，判据不必再读一次盘）。 */
interface ClosureFile {
  path: string
  text: string
}

/** 一条已解析的相对 import 边。 */
interface ImportEdge {
  from: string
  line: number
  spec: string
  to: string
  values: string[]
  types: string[]
  namespaceOrDefault: boolean
}

/** import 闭包的构建结果（**连诊断信息一起给**，好让「解析坏了」变成红）。 */
interface ImportClosure {
  files: ClosureFile[]
  edges: ImportEdge[]
  /** 相对 import 解析不到文件 —— 非空 = 解析器或路径拼装坏了。 */
  unresolved: string[]
  /** 入口文件本身不在磁盘上。 */
  entryMissing: string[]
  /** 包名 import（`@deepseek-ai/…`）：不遍历，只记下来（见「已知限度」）。 */
  packageImports: string[]
}

/**
 * 从入口出发递归解析相对 import，建出完整闭包。
 *
 * @param entries 入口文件的仓内相对路径。
 * @param read 读取器；合成用例靠它注入内存源码，真判据用 {@link repoSourceReader}。
 */
function buildImportClosure(
  entries: readonly string[],
  read: SourceReader = repoSourceReader,
): ImportClosure {
  const files: ClosureFile[] = []
  const edges: ImportEdge[] = []
  const unresolved: string[] = []
  const entryMissing: string[] = []
  const packageImports: string[] = []
  const seen = new Set<string>()
  const queue = [...entries]

  for (const entry of entries) {
    if (read(entry) === undefined) entryMissing.push(entry)
  }

  while (queue.length > 0) {
    const rel = queue.shift()
    if (rel === undefined || seen.has(rel)) continue
    seen.add(rel)
    const text = read(rel)
    if (text === undefined) continue
    files.push({ path: rel, text })

    for (const statement of importStatementsOf(text)) {
      if (!statement.spec.startsWith('.')) {
        packageImports.push(`${rel}:${String(statement.line)} → ${statement.spec}`)
        continue
      }
      const to = resolveRelativeImport(rel, statement.spec)
      if (read(to) === undefined) {
        unresolved.push(
          `${rel}:${String(statement.line)} → ${statement.spec}（解析成 ${to}，文件不在）`,
        )
        continue
      }
      edges.push({
        from: rel,
        line: statement.line,
        spec: statement.spec,
        to,
        ...parseImportClause(statement.clause, statement.typeOnly),
      })
      queue.push(to)
    }
  }

  return { files, edges, unresolved, entryMissing, packageImports }
}

/**
 * 闭包下界（B19 与 B23 共同的前置）：**空转必须判红，不许 skip**。
 *
 * 逐条对着「解析失效会怎么静默坏」来：
 * - **入口缺失** → 后面的判据在一个不含该文件的集合上成立；
 * - **有相对 import 解析不到** → 路径拼装或扩展名规则坏了；
 * - **闭包比入口还少** → 入口自己都没进来；
 * - **某个入口一条相对 import 都没解析出来** → import 正则过时了（`edges` 会整体归零，而「不含 X」恒真）；
 * - **闭包里没有 `src/lib/**`** → 没走深，「不得包含 X」是在一个小得可疑的集合上成立。
 *
 * @param closure 闭包。
 * @param entries 入口清单（用来判「每个入口都真的解析出了东西」）。
 */
function judgeClosureUsable(closure: ImportClosure, entries: readonly string[]): string[] {
  const offenders: string[] = []
  if (closure.entryMissing.length > 0) {
    offenders.push(`入口文件不在磁盘上：${closure.entryMissing.join(', ')}`)
  }
  if (closure.unresolved.length > 0) {
    offenders.push(
      `相对 import 解析不到文件（解析器 / 路径拼装坏了）：\n${closure.unresolved.join('\n')}`,
    )
  }
  if (closure.files.length < entries.length) {
    offenders.push(
      `闭包只有 ${String(closure.files.length)} 个文件，比入口数 ${String(entries.length)} 还少`,
    )
  }
  const resolvedFrom = new Set(closure.edges.map((edge) => edge.from))
  const silent = entries.filter((entry) => !resolvedFrom.has(entry))
  if (silent.length > 0) {
    offenders.push(
      `这些入口一条相对 import 都没解析出来（import 正则该升级了，否则本判据恒真）：${silent.join(', ')}`,
    )
  }
  if (!closure.files.some((file) => file.path.startsWith('src/lib/'))) {
    offenders.push('闭包里一个 src/lib/** 文件都没有 —— 闭包没走深，判据形同空转')
  }
  return offenders
}

/** 从 `lib/credentials.ts` 允许的**值**绑定：只有存在性扫描这一支。 */
const ALLOWED_CREDENTIALS_VALUES: ReadonlySet<string> = new Set(['readCredentialsPresence'])

/** B19 判据：观察层闭包不许触到取值路径。 */
function judgeObservationValuePath(closure: ImportClosure): string[] {
  const offenders: string[] = []
  const at = (edge: ImportEdge): string => `${edge.from}:${String(edge.line)}`
  for (const edge of closure.edges) {
    // ① 取值路径整个禁止：`lib/cookie.ts` 的唯一职责就是签发凭证。
    if (edge.to.endsWith('/lib/cookie.ts')) {
      offenders.push(`${at(edge)} → 观察层 import 了取值路径 ${edge.to}（spec: ${edge.spec}）`)
      continue
    }
    if (!edge.to.endsWith('/lib/credentials.ts')) continue
    // ② 命名空间 / 默认导入 = 任何导出都可达 → 与「直接 import 取值函数」等价，必须一起禁。
    if (edge.namespaceOrDefault) {
      offenders.push(`${at(edge)} → 命名空间/默认导入 credentials.ts（此后任何导出都可达）`)
    }
    for (const name of edge.values) {
      if (!ALLOWED_CREDENTIALS_VALUES.has(name)) {
        offenders.push(`${at(edge)} → 从 credentials.ts 导入取值函数 ${name}`)
      }
    }
  }
  return offenders
}

/**
 * 项目内**写 helper** 的名字（显式、窄的拒绝名单）。
 *
 * 这是 B23 相对 B10 的**真实增量之一**：这些是**本仓自己的函数**，不是 `node:fs` API，
 * 而 B10 判据的前提是「确有 `node:fs` 来源」⇒ 照不到它们。
 *
 * ⚠️ **已知限度**：这是**开放名单**，改写个名字（`persist()`）就绕过去了。见文末「已知限度」。
 */
const LOCAL_WRITE_HELPER_NAMES = [
  'writeText',
  'writeJson',
  'writeTextFile',
  'writeJsonFile',
  'saveToFile',
  'dumpToFile',
] as const

/** B23 判据：观察层闭包不许自己写文件。 */
function judgeObservationWrites(closure: ImportClosure): string[] {
  // fs 写入族直接复用 B10/B15 那套**按来源判定**的扫描器 —— 不另写一份，否则语义会漂。
  const offenders = judgeFsWriteUsage(closure.files)
  for (const file of closure.files) {
    const lines = stripComments(file.text).split('\n')
    lines.forEach((line, index) => {
      for (const name of LOCAL_WRITE_HELPER_NAMES) {
        if (new RegExp(`\\b${name}\\s*\\(`).test(line)) {
          offenders.push(`${file.path}:${String(index + 1)} → 项目内写 helper ${name}(…)`)
        }
      }
    })
  }
  return offenders
}

/** 用内存里的源码造一个闭包（只验判据本身，不碰真文件）。 */
function closureOf(sources: Record<string, string>, entries: readonly string[]): ImportClosure {
  return buildImportClosure(entries, (rel) => sources[rel])
}

describe('B19 观察层四个工具不许间接 import 到取值路径', () => {
  it('真实闭包：解析得动（下界），且没有碰取值路径', () => {
    const closure = buildImportClosure(OBSERVATION_TOOL_FILES)

    // 先立下界：这几条一旦红，下面的「不含取值路径」就是**恒真的空转**。
    const unusable = judgeClosureUsable(closure, OBSERVATION_TOOL_FILES)
    expect(
      unusable,
      `闭包不可用 —— 下面的断言会退化成恒真（空集不含任何东西）：\n${unusable.join('\n')}`,
    ).toEqual([])

    // 非空自证②：真的走深了（18 个文件是实测值；这里只钉「比入口多」，不钉死数字 —— 会漂）。
    expect(
      closure.files.length,
      `闭包只有 ${String(closure.files.length)} 个文件，没走深到这个判据有意义`,
    ).toBeGreaterThan(OBSERVATION_TOOL_FILES.length)

    const offenders = judgeObservationValuePath(closure)
    expect(
      offenders,
      describeOffenders('观察层触到了取值路径', offenders) +
        '\n观察层必须停在「存在性扫描」这一档：可以 `readCredentialsPresence`，' +
        '但绝不能把密钥读出来（那会把秘密带进一个判定型输出）。',
    ).toEqual([])
  })

  it('判据可被否证：import `lib/cookie.ts` → 红', () => {
    const closure = closureOf(
      {
        'src/tools/dsh_check_auth.ts': "import { signCookie } from '../lib/cookie.js'\n",
        'src/lib/cookie.ts': 'export function signCookie() {}\n',
        'src/lib/errors.ts': 'export const x = 1\n',
      },
      ['src/tools/dsh_check_auth.ts'],
    )
    expect(judgeClosureUsable(closure, ['src/tools/dsh_check_auth.ts'])).toEqual([])
    expect(judgeObservationValuePath(closure).length).toBeGreaterThan(0)
  })

  it('判据可被否证：从 `credentials.ts` import 一个取值函数 → 红', () => {
    const closure = closureOf(
      {
        'src/tools/dsh_check_auth.ts':
          "import { readCredentialsSecret } from '../lib/credentials.js'\n",
        'src/lib/credentials.ts':
          'export function readCredentialsSecret() {}\nexport const x = 1\n',
      },
      ['src/tools/dsh_check_auth.ts'],
    )
    expect(judgeObservationValuePath(closure)).toEqual([
      'src/tools/dsh_check_auth.ts:1 → 从 credentials.ts 导入取值函数 readCredentialsSecret',
    ])
  })

  it('判据可被否证：命名空间/默认导入 `credentials.ts` 也算越界（否则一切导出都可达）', () => {
    // 这是判据里最容易被绕过的一条：`import * as c` 之后 `c.任何取值函数()` 都合法，
    // 而且**名字一个都不出现在 import 子句里** —— 只查具名绑定必然漏。
    for (const source of [
      "import * as credentials from '../lib/credentials.js'\n",
      "import credentials from '../lib/credentials.js'\n",
    ]) {
      const closure = closureOf(
        { 'src/tools/dsh_check_auth.ts': source, 'src/lib/credentials.ts': 'export const x = 1\n' },
        ['src/tools/dsh_check_auth.ts'],
      )
      expect(judgeObservationValuePath(closure), `漏了命名空间形态：${source.trim()}`).not.toEqual(
        [],
      )
    }
  })

  it('别误伤：今天真的写法（具名值 + 内联 `type` 限定）必须是绿的', () => {
    // 实测这就是 `dsh_check_auth.ts` 的现行写法。区分值与类型是必须的 ——
    // 不区分就会把这条**合规** import 判红，而假红会逼人放宽整条判据。
    const closure = closureOf(
      {
        'src/tools/dsh_check_auth.ts':
          "import { readCredentialsPresence, type CredentialsPresence } from '../lib/credentials.js'\n",
        'src/lib/credentials.ts':
          'export interface CredentialsPresence { exists: boolean }\nexport function readCredentialsPresence() {}\n',
      },
      ['src/tools/dsh_check_auth.ts'],
    )
    expect(judgeObservationValuePath(closure)).toEqual([])
  })

  it('别误伤：整条 `import type` 也不该算越界（类型取不到运行时值）', () => {
    const closure = closureOf(
      {
        'src/tools/dsh_check_auth.ts':
          "import type { CredentialsPresence } from '../lib/credentials.js'\n",
        'src/lib/credentials.ts': 'export interface CredentialsPresence { exists: boolean }\n',
      },
      ['src/tools/dsh_check_auth.ts'],
    )
    expect(judgeObservationValuePath(closure)).toEqual([])
  })

  it('下界本身可被否证：解析失效（入口缺失 / 解析不到 / 一条 import 都没有）必须红', () => {
    // 这一条守的是「另外那条红线不要变成恒真」。三种静默坏法各来一个。
    const missingEntry = closureOf({}, ['src/tools/dsh_check_auth.ts'])
    expect(judgeClosureUsable(missingEntry, ['src/tools/dsh_check_auth.ts'])).not.toEqual([])

    const brokenPath = closureOf(
      { 'src/tools/dsh_check_auth.ts': "import { ok } from '../lib/errs.js'\n" },
      ['src/tools/dsh_check_auth.ts'],
    )
    expect(judgeClosureUsable(brokenPath, ['src/tools/dsh_check_auth.ts'])).not.toEqual([])

    const noImports = closureOf(
      {
        'src/tools/dsh_check_auth.ts': 'export const nothing = 1\n',
        'src/lib/errors.ts': 'export const x = 1\n',
      },
      ['src/tools/dsh_check_auth.ts'],
    )
    expect(
      judgeClosureUsable(noImports, ['src/tools/dsh_check_auth.ts']),
      '一个入口一条相对 import 都没有 → 应当判红（否则 import 正则失效时本判据恒真）',
    ).not.toEqual([])
  })

  it('下界本身可被否证：闭包没走深到 src/lib（regex 只吃到入口层）也要红', () => {
    // 让「入口有 import」但都指向非 lib 文件：edges 非空、unresolved 为空，
    // 只有「必须含 src/lib/**」这一条能把它挡下来。
    const shallow = closureOf(
      {
        'src/tools/dsh_check_auth.ts': "import { helper } from './util.js'\n",
        'src/tools/util.ts': 'export const helper = 1\n',
      },
      ['src/tools/dsh_check_auth.ts'],
    )
    const offenders = judgeClosureUsable(shallow, ['src/tools/dsh_check_auth.ts'])
    expect(offenders.join('\n')).toContain('src/lib')
  })
})

describe('B23 观察层不许自己写文件', () => {
  it('真实闭包：解析得动（下界），且闭包里没有写入', () => {
    const closure = buildImportClosure(OBSERVATION_TOOL_FILES)
    const unusable = judgeClosureUsable(closure, OBSERVATION_TOOL_FILES)
    expect(unusable, `闭包不可用 —— 下面的断言会退化成恒真：\n${unusable.join('\n')}`).toEqual([])
    expect(closure.files.length).toBeGreaterThan(OBSERVATION_TOOL_FILES.length)

    const offenders = judgeObservationWrites(closure)
    expect(
      offenders,
      describeOffenders('观察层在自己写文件', offenders) +
        '\n观察层只读：`audit` 落盘只能经宿主服务（`spillStore`），不许本仓自己写文件。' +
        '\n（注意 B23 的 fs 判据与 B10 共用同一个扫描器 —— fs 那部分是 B10 的子集，别把 B10 放宽。）',
    ).toEqual([])
  })

  it('判据可被否证：闭包里出现 fs 写入 → 红', () => {
    const closure = closureOf(
      {
        'src/tools/dsh_check_auth.ts':
          "import { writeFileSync } from 'node:fs'\nwriteFileSync(p, 'x')\n",
      },
      ['src/tools/dsh_check_auth.ts'],
    )
    expect(judgeObservationWrites(closure).length).toBeGreaterThan(0)
  })

  it('判据可被否证：项目内写 helper（B23 相对 B10 的真实增量）→ 红', () => {
    // `writeText` 是本仓自己的函数、**不是** node:fs API —— B10 的「须有 fs 来源」规则照不到它。
    // 这条用例就是 B23 存在的理由本身。
    // 定义放在闭包**外**的 writer.ts，好让入口里只剩**调用点**，从而能钉住真实行号。
    const entry = [
      '/**',
      ' * 一段多行注释：把后面的行号顶下去，用来证明报的是**真实文件行号**',
      ' * （块注释整体删掉会让行号整体前移，本仓为这个踩过坑）',
      ' */',
      "import { writeText } from '../lib/writer.js'",
      'const a = 1',
      "writeText('/tmp/x', 'y')",
    ].join('\n')
    const closure = closureOf(
      {
        'src/tools/dsh_check_auth.ts': entry,
        'src/lib/writer.ts': 'export function writeText(p: string, t: string) { void p; void t }\n',
      },
      ['src/tools/dsh_check_auth.ts'],
    )
    // 前提自证：B10 那套扫描器确实照不到它（没有 node:fs 来源）——
    // 否则这条用例证明不了「B23 有增量」，而只是把 B10 又说了一遍。
    expect(judgeFsWriteUsage([{ path: 'src/tools/dsh_check_auth.ts', text: entry }])).toEqual([])

    const offenders = judgeObservationWrites(closure)
    expect(offenders).not.toEqual([])
    // 真实行号：调用点在第 7 行（前面 4 行块注释 + import，注释不能被吃掉）。
    expect(offenders[0]).toContain(':7 →')
    expect(offenders[0]).toContain('writeText')
  })

  it('别误伤：只读 fs API 不算写入', () => {
    const closure = closureOf(
      {
        'src/tools/dsh_check_auth.ts':
          "import { readFileSync } from 'node:fs'\nexport const t = readFileSync(p, 'utf8')\n",
      },
      ['src/tools/dsh_check_auth.ts'],
    )
    expect(judgeObservationWrites(closure)).toEqual([])
  })

  it('别误伤：本仓那个同名的本地 `truncate` 不算写入（按来源判定）', () => {
    // `src/lib/render.ts` 里就有一个本地 truncate —— B10 已经有同样的防误报用例，这里在闭包口径上再钉一次。
    const closure = closureOf(
      {
        'src/tools/dsh_check_auth.ts': "import { truncate } from '../lib/render.js'\n",
        'src/lib/render.ts': 'export function truncate(text: string) { return text }\n',
      },
      ['src/tools/dsh_check_auth.ts'],
    )
    expect(judgeObservationWrites(closure)).toEqual([])
  })

  it('别误伤：注释里提到 `writeText(` 不算违规（否则解释规则的文字会把判据变成噪声）', () => {
    const closure = closureOf(
      {
        'src/tools/dsh_check_auth.ts':
          '// 绝不能调 writeText(…) —— 观察层只读\nexport const a = 1\n',
      },
      ['src/tools/dsh_check_auth.ts'],
    )
    expect(judgeObservationWrites(closure)).toEqual([])
  })

  it('下界本身可被否证：闭包空转（解析失效）必须红', () => {
    const empty = closureOf({}, ['src/tools/dsh_check_auth.ts'])
    expect(judgeClosureUsable(empty, ['src/tools/dsh_check_auth.ts'])).not.toEqual([])
  })
})

/**
 * # 依赖五个工具全齐的红线：B17 / B20a / B20b / B18a / B21 / B24
 *
 * 这六条与前六条（B16 / B18b / B22）的分工：前六条只吃**合成 fixture**，任何工具都没落地也能跑；
 * 这六条要**真的把五个工具跑起来**（成功与失败各一条），因为它们的判据对象是
 * 「工具自己声明的描述与参数」「工具自己返回的 `data` 外形」「`execute` 在替身抛异常时的行为」——
 * 用合成对象断言等于在测我自己的夹具，不是测工具（活跃坑 18 的假绿形状）。
 *
 * ## 一处语料，六条红线共用
 *
 * {@link redlineCorpus} 把五个工具各跑成功 / 失败两次，B17 / B18a / B20b / B21 全部读它。
 * **不各写一份夹具**：各写一份必然漂，而漂出来的形状是「红线绿但工具已经改了」。
 *
 * ## 为什么夹具写在**本文件内部**而不 import `test/tools/helpers.ts`
 *
 * `test/tools/helpers.ts` 是 W1 冻结的、四个工具测试共享的形状，**不是这条红线的写域**。
 * 需要助手就写在文件内部 —— 这也是本文件一直以来的做法（它至今只 import `src/**`）。
 * **代价如实记下**：`withPlatform` 与那边的实现重复了一份（见文末「已知限度」的技术债条目）。
 */

// ── 运行期夹具 ────────────────────────────────────────────────────────────

/** 造配置。 */
function redlineConfig(dshHome: string, overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    dshHome,
    dshHomeSource: 'config',
    profile: 'web',
    port: 0,
    timeoutMs: 15_000,
    ...overrides,
  }
}

/** 夹具默认的 spawn：**一次只会失败**，免得哪条路意外真起子进程。 */
const redlineNeverSpawn: SpawnImpl = async () => {
  throw new Error('redline fixture: this path must not start a subprocess')
}

/** 夹具默认的 fetch：同上。 */
const redlineNeverFetch: FetchImpl = async () => {
  throw new Error('redline fixture: this path must not make an HTTP request')
}

/**
 * 造依赖。
 *
 * `env` 默认给**空对象**（不是 `process.env`）：否则本机的 `DSH_WEB_URL` 会让
 * 「端口从哪来」随机器漂，判据就变成「在开发机上绿」。
 */
function redlineDeps(config: ResolvedConfig, overrides: Partial<ToolDeps> = {}): ToolDeps {
  return createToolDeps(config, {
    spawn: redlineNeverSpawn,
    fetch: redlineNeverFetch,
    env: {},
    ...overrides,
  })
}

/** 写一个 JSON 文件（自动建父目录）。 */
function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/** 写一个文本文件（自动建父目录）。 */
function writeTextFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, 'utf8')
}

/** 造一个 profile 清单（`dsh.profile.bundles`）。 */
function writeProfileFixture(dshHome: string, bundles: readonly string[]): string {
  const dir = join(dshHome, 'profiles', 'web')
  writeJsonFile(join(dir, 'package.json'), {
    name: 'dsh-profile-web',
    dsh: { profile: { bundles: [...bundles] } },
    dependencies: {},
  })
  return dir
}

/** 造一个「已安装的包」（清单 + 产物文件都在）。 */
function writeInstalledPackageFixture(profileDir: string, packageName: string): void {
  const packageDir = join(profileDir, 'node_modules', ...packageName.split('/'))
  writeJsonFile(join(packageDir, 'package.json'), {
    name: packageName,
    version: '0.0.1',
    main: './lib/index.js',
  })
  writeTextFile(join(packageDir, 'lib', 'index.js'), '// redline fixture\n')
}

/** 造一个 exec（只需要 signal）。 */
function redlineExec(): ToolRunContext {
  return { signal: new AbortController().signal } as unknown as ToolRunContext
}

/**
 * 临时把 `process.platform` 换成指定值，跑完**无条件还原**。
 *
 * 为什么必须有：`lib/ports.ts` 只在 Windows 上起子进程查监听端口，别的平台**早返回**。
 * 不钉平台的话，「`diagnose × spawn` 这条注入到底有没有被走到」会随机器变 ——
 * 本机 Windows 上绿、CI ubuntu 上 `spawn` 一次都没被调用 → **判据在 CI 上空转**。
 * 钉住平台让两条分支在任意机器上都被真跑到（与活跃坑 25 同一条纪律）。
 *
 * ⚠️ 与 `test/tools/helpers.ts` 的 `withPlatform` 重复 —— 那边不是本红线的写域，
 * 见文末「已知限度」的技术债条目。
 *
 * @param platform 要伪装的平台值。
 * @param fn 在该平台下跑的逻辑。
 */
async function withPlatformRedline<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  if (original === undefined) throw new Error('process.platform has no property descriptor')
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
    enumerable: true,
    writable: true,
  })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, 'platform', original)
  }
}

/**
 * 走**工具自己的声明**取模型可见文本。
 *
 * 不直接调 `renderToolResultText`：`toolOutput()` 已经绑好了工具名与输出表，
 * 自己再拼一次就多一个「红线拼装 ≠ 宿主取数」的漂移点。
 *
 * @param tool 工具定义。
 * @param args 调用参数。
 * @param value 工具返回值。
 */
function renderViaTool(tool: ToolDefinition, args: unknown, value: unknown): string {
  const blocks = tool.output.render(args as never, value as never) as unknown as { text?: string }[]
  return blocks.map((block) => block.text ?? '').join('\n')
}

/** 一次工具运行的结果（六条红线共用的语料条目）。 */
interface RedlineRun {
  /** 工具名。 */
  tool: string
  /** 这条 fixture 在测什么（报错时点名用）。 */
  label: string
  /** 工具返回的原始值（**未经守卫**）。 */
  value: unknown
  /** 模型可见文本。 */
  text: string
}

/** 跑一条 fixture 并渲染。 */
async function runFixture(
  tool: ToolDefinition,
  toolName: string,
  label: string,
  args: unknown,
): Promise<RedlineRun> {
  const value = await tool.execute(args, redlineExec())
  return { tool: toolName, label, value, text: renderViaTool(tool, args, value) }
}

/** 造一个带 `ECONNREFUSED` 的异常（`probeHttp` 据此判 `not-running`）。 */
function connectionRefused(): Error {
  return Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
}

// ── 五个工具各一条成功 / 一条失败 ──────────────────────────────────────────

/** `check_auth`：成功 = 200；失败 = 连接被拒。 */
function checkAuthWith(fetch: FetchImpl): ToolDefinition {
  const home = makeTempRoot('dsh-redline-auth-')
  return createCheckAuthTool(redlineDeps(redlineConfig(home, { port: 3080 }), { fetch, env: {} }))
}

/** `effect_mode`：成功 = profile 文件里看得到 hmr；失败 = dsh 起不来（ENOENT）。 */
function effectModeWith(kind: 'hmr' | 'no-dsh'): ToolDefinition {
  const home = makeTempRoot('dsh-redline-effect-')
  if (kind === 'hmr') writeProfileFixture(home, ['@deepseek-ai/dsh-hmr'])
  const spawn: SpawnImpl = async () => {
    if (kind === 'no-dsh') {
      return {
        code: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        aborted: false,
        spawnError: 'spawn: ENOENT',
      }
    }
    return { code: 0, stdout: '', stderr: '', timedOut: false, aborted: false }
  }
  return createEffectModeTool(redlineDeps(redlineConfig(home), { spawn }))
}

/** `diagnose`：成功 = 清单与产物都在；失败 = 没有 profile 清单。 */
function diagnoseWith(kind: 'loaded' | 'no-profile'): ToolDefinition {
  const home = makeTempRoot('dsh-redline-diagnose-')
  if (kind === 'loaded') {
    const dir = writeProfileFixture(home, ['pkg-a'])
    writeInstalledPackageFixture(dir, 'pkg-a')
  }
  // `port: 0` + 空 `env` ⇒ `resolvePort` 返回 `undefined` ⇒ 一次端口查询都不做：
  // 这条 fixture 因此与平台无关（不必钉 win32）。
  return createDiagnosePluginLoadTool(redlineDeps(redlineConfig(home)))
}

/** `dump_config`：成功 = 两次 dump 都干净；失败 = `--dump-config` 退出码非 0。 */
function dumpConfigWith(kind: 'clean' | 'exit-code'): ToolDefinition {
  const home = makeTempRoot('dsh-redline-dump-')
  const spawn: SpawnImpl = async (options) => {
    const schema = options.args.includes('--dump-config-schema')
    if (kind === 'exit-code' && !schema) {
      return { code: 5, stdout: '', stderr: 'dsh: boom\n', timedOut: false, aborted: false }
    }
    return {
      code: 0,
      stdout: schema ? '{}' : '- id: hmr\n  name: "@deepseek-ai/dsh-hmr"\n',
      stderr: '',
      timedOut: false,
      aborted: false,
    }
  }
  return createDumpConfigTool(redlineDeps(redlineConfig(home), { spawn }))
}

/** 造一个可控的 entry 端口。 */
function reloadEntryFixture(): ReloadEntryPort {
  return {
    entryId: 'include:pkg-a',
    moduleName: 'file:///repo/pkg-a/lib/index.js',
    hasFiber: true,
    oldFiberCount: 1,
    fiberState: 2,
    reloadable: true,
    disposeOld: async () => undefined,
    mountFresh: async () => undefined,
    removeFresh: async () => undefined,
    remountOld: async () => undefined,
    refresh: async () => undefined,
  }
}

/** `hot_reload`：成功 = 就地换成功；失败 = `reload` 端口的 `candidates()` 抛异常。 */
function hotReloadWith(kind: 'success' | 'throwing'): ToolDefinition {
  const home = makeTempRoot('dsh-redline-reload-')
  const entry = reloadEntryFixture()
  const store = new Map<string, unknown[]>([[entry.moduleName, ['job:1']]])
  const reload: ReloadHost = {
    internalAvailable: () => true,
    cache: () => ({
      read: (url) => store.get(url) ?? [],
      write: (url, job) => {
        const jobs = store.get(url) ?? []
        jobs.push(job)
        store.set(url, jobs)
        return true
      },
      clear: (url) => {
        store.delete(url)
      },
      children: async () => [],
    }),
    resolveEntryUrl: async () => entry.moduleName,
    importFresh: async () => ({}),
    candidates: () => {
      if (kind === 'throwing') throw new Error('reload port exploded')
      return [entry]
    },
  }
  return createHotReloadTool({ ...redlineDeps(redlineConfig(home)), reload })
}

/**
 * 五个工具各跑成功 / 失败一次。
 *
 * 只建一次（memo）：六条红线共用，避免每条各跑十次真 IO。
 */
let corpusPromise: Promise<RedlineRun[]> | undefined

/** 取语料（首次调用时构建）。 */
function redlineCorpus(): Promise<RedlineRun[]> {
  corpusPromise ??= buildRedlineCorpus()
  return corpusPromise
}

/** 构建语料。 */
async function buildRedlineCorpus(): Promise<RedlineRun[]> {
  return [
    await runFixture(
      checkAuthWith(async () => ({ status: 200 })),
      CHECK_AUTH_TOOL,
      'check_auth · 服务在且认证过了（200）',
      { port: 3080 },
    ),
    await runFixture(
      checkAuthWith(async () => {
        throw connectionRefused()
      }),
      CHECK_AUTH_TOOL,
      'check_auth · 连不上（ECONNREFUSED）',
      { port: 3080 },
    ),
    await runFixture(
      effectModeWith('hmr'),
      EFFECT_MODE_TOOL,
      'effect_mode · profile 文件里看得到 hmr',
      { change: 'config' },
    ),
    await runFixture(effectModeWith('no-dsh'), EFFECT_MODE_TOOL, 'effect_mode · dsh 起不来', {
      change: 'config',
    }),
    await runFixture(
      diagnoseWith('loaded'),
      DIAGNOSE_PLUGIN_LOAD_TOOL,
      'diagnose · 清单与产物都在',
      {},
    ),
    await runFixture(
      diagnoseWith('no-profile'),
      DIAGNOSE_PLUGIN_LOAD_TOOL,
      'diagnose · 没有 profile 清单',
      {},
    ),
    await runFixture(
      dumpConfigWith('clean'),
      DUMP_CONFIG_TOOL,
      'dump_config · 两次 dump 都干净',
      {},
    ),
    await runFixture(
      dumpConfigWith('exit-code'),
      DUMP_CONFIG_TOOL,
      'dump_config · --dump-config 退出码非 0',
      {},
    ),
    await runFixture(hotReloadWith('success'), HOT_RELOAD_TOOL, 'hot_reload · 就地换成功', {
      entryId: 'pkg-a',
    }),
    await runFixture(hotReloadWith('throwing'), HOT_RELOAD_TOOL, 'hot_reload · reload 端口抛异常', {
      entryId: 'pkg-a',
    }),
  ]
}

// ── 五个工具自己的声明（B17 / B20a / B20b 共用） ───────────────────────────

/** 一个工具的形状：描述声明 + 合成文本 + 工具定义。 */
interface RedlineToolShape {
  /** 工具名。 */
  name: string
  /** 四段声明（原始字段 —— B20a 要判「写了但是空的」）。 */
  description: ToolDescription
  /** `composeDescription` 的结果（= 模型看到的 description）。 */
  text: string
  /** 工具定义（取 `parameters` 与 `output.render`）。 */
  tool: ToolDefinition
}

/** 造形状。 */
function shapeOf(
  name: string,
  description: ToolDescription,
  tool: ToolDefinition,
): RedlineToolShape {
  return { name, description, text: composeDescription(description), tool }
}

let shapesCache: RedlineToolShape[] | undefined

/** 取五个工具的形状（构造它们不需要真的 IO）。 */
function toolShapes(): RedlineToolShape[] {
  if (shapesCache !== undefined) return shapesCache
  const deps = redlineDeps(redlineConfig('redline-shape-home'))
  const reload: ReloadHost = {
    internalAvailable: () => false,
    cache: () => undefined,
    resolveEntryUrl: async () => '',
    importFresh: async () => ({}),
    candidates: () => [],
  }
  shapesCache = [
    shapeOf(CHECK_AUTH_TOOL, CHECK_AUTH_DESCRIPTION, createCheckAuthTool(deps)),
    shapeOf(EFFECT_MODE_TOOL, CHECK_EFFECT_MODE_DESCRIPTION, createEffectModeTool(deps)),
    shapeOf(
      DIAGNOSE_PLUGIN_LOAD_TOOL,
      DIAGNOSE_PLUGIN_LOAD_DESCRIPTION,
      createDiagnosePluginLoadTool(deps),
    ),
    shapeOf(DUMP_CONFIG_TOOL, DUMP_CONFIG_DESCRIPTION, createDumpConfigTool(deps)),
    shapeOf(HOT_RELOAD_TOOL, HOT_RELOAD_DESCRIPTION, createHotReloadTool({ ...deps, reload })),
  ]
  return shapesCache
}

/** 一个值的字符串视图（**字符串与数字**算标识符；布尔不是）。 */
function seg(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * 取 `tool.parameters` 里每个参数的描述。
 *
 * ⚠️ **必须点进 `.properties`**（§10.0 口 3）：`defineTool` 把参数**编译**成 JSON schema
 * （`{ type, properties, required }`），`Object.values(tool.parameters)` 拿到的是 `'object'`
 * 字符串与 properties 对象本身 → 每条 `description` 都是 `undefined` → **「每个参数描述非空」
 * 与「合计 > 0」一起被架空**。本仓五个工具的测试里曾有四份是这种写法。
 *
 * @param tool 工具定义。
 */
function parameterDescriptions(tool: ToolDefinition): Record<string, unknown> {
  const parameters = tool.parameters as unknown as {
    properties?: Record<string, { description?: unknown }>
  }
  const properties = parameters.properties ?? {}
  const result: Record<string, unknown> = {}
  for (const [name, node] of Object.entries(properties)) result[name] = node.description
  return result
}

/** 目标工具的「描述 ∪ 参数文本」（B17 的取值面右半边）。 */
function toolTextOf(shape: RedlineToolShape): string {
  const params = parameterDescriptions(shape.tool)
  return [
    shape.text,
    ...Object.entries(params).map(([name, text]) => `${name}: ${seg(text)}`),
  ].join('\n')
}

/** 一个值里的全部叶子字符串（B17 逐个判）。 */
function leafStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (typeof value === 'number') return [String(value)]
  if (Array.isArray(value)) return value.flatMap((item) => leafStrings(item))
  if (typeof value === 'object' && value !== null) {
    return Object.values(value as Record<string, unknown>).flatMap((item) => leafStrings(item))
  }
  return []
}

/** B17 的例外：到处都在的值不算标识符。 */
function isExemptIdentifier(leaf: string): boolean {
  return leaf === '' || leaf === '0' || leaf === '1'
}

/** B20b 的共享串长度下限（与 B16 同一个数：只抓**逐字**复述）。 */
const B20B_SHARED_MIN_CHARS = 40

/** 找出 `a` 里**逐字出现在 `b` 中**的、长度 ≥`min` 的片段。 */
function sharedSubstringsRedline(a: string, b: string, min: number): string[] {
  const hits = new Set<string>()
  for (let start = 0; start + min <= a.length; start += 1) {
    const window = a.slice(start, start + min)
    if (b.includes(window)) hits.add(window)
  }
  return [...hits]
}

// ── B20a 描述四段骨架 + 上限 ──────────────────────────────────────────────

describe('B20a 描述四段骨架 + 上限', () => {
  it('五个工具：段数 / 行数 / 字符上限 / 每个参数描述非空且合计 > 0', () => {
    const offenders: string[] = []
    const measured: string[] = []
    const shapes = toolShapes()

    for (const shape of shapes) {
      const segments = [
        shape.description.what,
        shape.description.useWhen,
        shape.description.boundary,
        shape.description.cost,
      ]
      // 口 2：可选段「**写了但是空的**」必须单独判红 —— 它不是「没写」。
      // `composeDescription` 会把它滤掉，所以只看合成结果看不出这一档。
      for (const [index, raw] of segments.entries()) {
        if (typeof raw === 'string' && raw.trim() === '') {
          offenders.push(
            `${shape.name}: 第 ${String(index + 1)} 段是空串 / 纯空白 —— 字段本身违规（滤空段会把它藏起来）`,
          )
        }
      }
      const present = segments.filter((raw) => seg(raw).trim() !== '')
      if (seg(shape.description.what).trim() === '') offenders.push(`${shape.name}: what 为空`)
      if (seg(shape.description.useWhen).trim() === '')
        offenders.push(`${shape.name}: useWhen 为空`)

      const lines = shape.text.split('\n')
      const blanks = lines.filter((line) => line.trim() === '')
      if (blanks.length > 0) {
        offenders.push(`${shape.name}: 合成后的描述里有 ${String(blanks.length)} 条纯空白行`)
      }
      // 下界用 `≥ 段数`（不是 `===`）：段内允许折行（useWhen 1–2 行）。
      if (lines.length < present.length) {
        offenders.push(
          `${shape.name}: 行数 ${String(lines.length)} < 段数 ${String(present.length)}（下界）`,
        )
      }
      if (lines.length > DESCRIPTION_MAX_LINES) {
        offenders.push(
          `${shape.name}: 行数 ${String(lines.length)} > ${String(DESCRIPTION_MAX_LINES)}`,
        )
      }
      if (shape.text.length > DESCRIPTION_MAX_CHARS) {
        offenders.push(
          `${shape.name}: description ${String(shape.text.length)} 字符 > ${String(DESCRIPTION_MAX_CHARS)}`,
        )
      }
      // 连接符必须是 `\n`：段数 ≥2 却合成成一行 ⇒ 有人把连接符换回了空格，
      // 那时「行数 ≤4」就是恒真断言（§2.1 的 A 方案就白拍了）。
      if (present.length >= 2 && !shape.text.includes('\n')) {
        offenders.push(
          `${shape.name}: ${String(present.length)} 段却合成成了一行 —— 连接符不是 \\n`,
        )
      }

      const params = parameterDescriptions(shape.tool)
      const names = Object.keys(params)
      // 口 1 + 口 3 的下界：没有参数、或点错层级（`Object.values(tool.parameters)`），
      // 都会让参数描述这一族判据恒真 —— 现在这两条下界是**唯一的机械守卫**。
      if (names.length === 0) {
        offenders.push(`${shape.name}: 一个参数都没有 —— 参数描述的判据会空转（口 3）`)
      }
      let total = 0
      for (const name of names) {
        const text = seg(params[name])
        if (text.trim() === '') {
          offenders.push(`${shape.name}.${name}: 参数描述为空 / 缺失`)
          continue
        }
        total += text.length
      }
      if (total === 0) offenders.push(`${shape.name}: 参数描述合计为 0 —— 判据在空转`)
      // ⚠️ 这里**曾经**有一条上界「参数描述合计 ≤100」（常量 `PARAMETER_DESCRIPTIONS_MAX_CHARS`）。
      // 维护者 2026-10-13 拍板**删掉上界、只保留下界**：100 是在「还没有第二个轴」时定的，
      // 而 `dshHome` / `profile` 这类真实新参数需要地方写描述 —— **上界只防啰嗦、下界才防空转**。
      // 实测留档（上界曾经有多紧）：diagnose 97 / effect_mode 88 / check_auth 86 /
      // hot_reload 79 / dump_config 55。**这条实测不再被断言**，只作为「上界曾经是紧约束」的证据。
      // 「某条参数描述该不该留」现在是**人工评审项**（SHAPE §10.1：模型看不到这条会不会填错），
      // **刻意不在这里断言** —— 语义质量没法机械判，硬凑只会造出一条恒真的假红线（§10.2 那类）。
      measured.push(
        `${shape.name}: desc=${String(shape.text.length)}/${String(DESCRIPTION_MAX_CHARS)}` +
          ` lines=${String(lines.length)}/${String(DESCRIPTION_MAX_LINES)}` +
          ` segs=${String(present.length)}` +
          ` params=${String(names.length)}` +
          ` paramChars=${String(total)}`,
      )
    }

    // 五个工具一个都不能少 —— 否则「描述层合规」只在一个子集上成立。
    expect(shapes).toHaveLength(5)
    expect(offenders, `B20a 违规：\n${offenders.join('\n')}`).toEqual([])
    // 实测值随断言带出去：红了能一眼看出是哪一项顶到上限。
    expect(measured, `B20a 实测：\n${measured.join('\n')}`).toHaveLength(5)
  })
})

// ── B20b 描述不许复述输出 ────────────────────────────────────────────────

describe('B20b 描述不许复述输出', () => {
  it('每个工具的 description 与它自己的 render 输出之间没有 ≥40 字符的共享串', async () => {
    const runs = await redlineCorpus()
    const offenders: string[] = []
    const checked: string[] = []

    for (const shape of toolShapes()) {
      const run = runs.find((item) => item.tool === shape.name)
      if (run === undefined) {
        offenders.push(`${shape.name}: 语料里没有它的运行结果 —— 判据无从下手`)
        continue
      }
      // 下界：**两侧都要有** ≥40 字符的候选，否则「没有共享串」恒真（§10.0）。
      if (shape.text.length < B20B_SHARED_MIN_CHARS) {
        offenders.push(
          `${shape.name}: 描述只有 ${String(shape.text.length)} 字符，构不成 ≥${String(B20B_SHARED_MIN_CHARS)} 的候选 —— 判据空转`,
        )
        continue
      }
      if (run.text.length < B20B_SHARED_MIN_CHARS) {
        offenders.push(
          `${shape.name}: 渲染文本只有 ${String(run.text.length)} 字符，构不成候选 —— 判据空转`,
        )
        continue
      }
      checked.push(shape.name)
      const shared = sharedSubstringsRedline(shape.text, run.text, B20B_SHARED_MIN_CHARS)
      if (shared.length > 0) {
        offenders.push(
          `${shape.name}: 描述里逐字抄了输出 → ${shared.slice(0, 3).join(' | ')}（共 ${String(shared.length)} 段）`,
        )
      }
    }

    // 「一条都没真检查」必须判红，不许静默 skip（活跃坑 18）。
    if (checked.length !== toolShapes().length) {
      offenders.push(
        `只有 ${String(checked.length)}/${String(toolShapes().length)} 个工具被真检查 —— 判据没覆盖全`,
      )
    }
    expect(offenders, `B20b 违规：\n${offenders.join('\n')}`).toEqual([])
  })
})

// ── B18a nextStep 出现时必须带动作 ────────────────────────────────────────

describe('B18a nextStep 出现时必须带动作', () => {
  it('语料里每个 nextStep 都落在两支之一，且**两支都真的出现过**', async () => {
    const runs = await redlineCorpus()
    const offenders: string[] = []
    let toolBranch = 0
    let manualBranch = 0
    let absent = 0

    for (const run of runs) {
      const step = (run.value as { nextStep?: unknown }).nextStep
      if (step === undefined) {
        absent += 1
        continue
      }
      if (typeof step !== 'object' || step === null || Array.isArray(step)) {
        offenders.push(`${run.label}: nextStep 不是对象`)
        continue
      }
      const record = step as Record<string, unknown>
      if (seg(record['why']).trim() === '') {
        offenders.push(`${run.label}: nextStep.why 不是非空字符串`)
        continue
      }
      const hasTool = record['tool'] !== undefined
      const hasManual = record['manual'] !== undefined
      if (hasTool && hasManual) {
        offenders.push(`${run.label}: 两支同时出现 —— 契约只允许恰有其一`)
        continue
      }
      if (!hasTool && !hasManual) {
        // 这正是根因那一档：没有动作的 nextStep 在类型上写不出来，运行期也必须是红。
        offenders.push(`${run.label}: nextStep 没有动作（裸结论伪装成下一步）`)
        continue
      }
      if (hasManual) {
        if (record['manual'] !== true) {
          offenders.push(`${run.label}: manual 不是 true`)
          continue
        }
        manualBranch += 1
        continue
      }
      if (seg(record['tool']).trim() === '') {
        offenders.push(`${run.label}: tool 不是非空字符串`)
        continue
      }
      toolBranch += 1
    }

    // 下界：两支都要有 fixture，否则这条判据只覆盖一半。
    if (toolBranch === 0) offenders.push('语料里没有**工具支**的 nextStep —— 判据只覆盖一半')
    if (manualBranch === 0) offenders.push('语料里没有 **manual 支**的 nextStep —— 判据只覆盖一半')
    if (absent === runs.length) offenders.push('全部 fixture 都没有 nextStep —— 判据空转')
    expect(
      offenders,
      `B18a 违规：\n${offenders.join('\n')}\n（工具支 ${String(toolBranch)} 条 / manual 支 ${String(manualBranch)} 条 / 无 nextStep ${String(absent)} 条）`,
    ).toEqual([])
  })
})

// ── B17 下一个工具的参数标识符必须出现 ────────────────────────────────────

describe('B17 下一个工具的参数标识符必须出现', () => {
  it('args 的每个标识符都在 verdict/L2 ∪ 目标工具自己的描述与参数文本里', async () => {
    const runs = await redlineCorpus()
    const shapes = toolShapes()
    const offenders: string[] = []
    let checkedIdentifiers = 0
    let emptyArgs = 0
    let noArgs = 0
    let manualSteps = 0

    for (const run of runs) {
      const step = (run.value as { nextStep?: unknown }).nextStep
      if (step === undefined) continue
      const record = step as Record<string, unknown>
      if (record['manual'] === true) {
        manualSteps += 1
        continue
      }
      const args = record['args']
      if (args === undefined) {
        noArgs += 1
        continue
      }
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        offenders.push(`${run.label}: args 不是对象`)
        continue
      }
      const entries = Object.entries(args as Record<string, unknown>)
      // 例外：`args` 为空对象时**不适用** —— 但要**计数**，不许静默 skip。
      if (entries.length === 0) {
        emptyArgs += 1
        continue
      }

      const target = shapes.find((shape) => shape.name === record['tool'])
      if (target === undefined) {
        // 目标工具不在本仓闭集里 ⇒ 取值面的右半边求不出来。**响亮判红**，
        // 要求显式扩表或把建议改成 manual —— 不静默放行（活跃坑 18）。
        offenders.push(
          `${run.label}: 目标工具 ${seg(record['tool'])} 不在本仓五工具闭集里 —— 取值面无法求值`,
        )
        continue
      }

      // 取值面 = `verdict:` 行 / L2 行 ∪ 目标工具自己的描述与参数文本。
      // ⚠️ **必须排除 `nextStep:` 行** —— 那一行按格式本来就会把 args 印出来，不排除则恒真。
      const layers = splitRenderText(run.text)
      const haystack = [
        ...(layers.verdict === undefined ? [] : [layers.verdict]),
        ...layers.l2,
        toolTextOf(target),
      ].join('\n')
      // 自证排除真的成立：取值面里不许出现 nextStep 行本身。
      if (haystack.includes(RENDER_NEXT_STEP_PREFIX)) {
        offenders.push(`${run.label}: 取值面里混进了 ${RENDER_NEXT_STEP_PREFIX} 行 —— 判据会恒真`)
        continue
      }

      for (const [key, value] of entries) {
        for (const leaf of leafStrings(value)) {
          if (isExemptIdentifier(leaf)) continue
          checkedIdentifiers += 1
          if (!haystack.includes(leaf)) {
            offenders.push(
              `${run.label}: args.${key} = ${leaf} 在模型看得到的地方找不到（verdict/L2 ∪ 目标工具的描述与参数）`,
            )
          }
        }
      }
    }

    // 下界：一条可判的标识符都没有 ⇒ 判据空转。空 args 的例外也要被计数。
    if (checkedIdentifiers === 0) {
      offenders.push(
        `一条可判的 args 标识符都没有 —— 判据空转（空 args ${String(emptyArgs)} / 无 args ${String(noArgs)} / manual ${String(manualSteps)}）`,
      )
    }
    expect(
      offenders,
      `B17 违规：\n${offenders.join('\n')}\n（可判标识符 ${String(checkedIdentifiers)} 个 / 空 args ${String(emptyArgs)} 条 / 无 args ${String(noArgs)} 条 / manual ${String(manualSteps)} 条）`,
    ).toEqual([])
  })
})

// ── B21 data 外层形状是闭集 ──────────────────────────────────────────────

describe('B21 data 外层形状是闭集', () => {
  it('每个工具的成功与失败返回值：顶层闭集 + data 恰好三键 + key/audit 是对象', async () => {
    const runs = await redlineCorpus()
    const offenders: string[] = []
    const stats = new Map<string, { ok: number; fail: number }>()

    for (const run of runs) {
      const record = run.value as Record<string, unknown> | null
      if (record === null || typeof record !== 'object' || Array.isArray(record)) {
        offenders.push(`${run.label}: 返回值不是对象`)
        continue
      }
      // 顶层闭集：`ok` / `data` / `error` / `nextStep` 之外不许有第五个键。
      for (const key of Object.keys(record)) {
        if (!['ok', 'data', 'error', 'nextStep'].includes(key)) {
          offenders.push(`${run.label}: 顶层多了一个键 "${key}"`)
        }
      }
      if (typeof record['ok'] !== 'boolean') {
        offenders.push(`${run.label}: ok 不是布尔`)
        continue
      }
      const data = record['data']
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        offenders.push(`${run.label}: data 不是对象`)
        continue
      }
      const dataRecord = data as Record<string, unknown>
      const dataKeys = Object.keys(dataRecord).sort()
      if (dataKeys.join(',') !== 'audit,key,verdict') {
        offenders.push(`${run.label}: data 的键是 ${dataKeys.join(',')}（应为 audit,key,verdict）`)
      }
      if (seg(dataRecord['verdict']).trim() === '') {
        offenders.push(`${run.label}: data.verdict 不是非空字符串`)
      }
      for (const name of ['key', 'audit'] as const) {
        const item = dataRecord[name]
        // 「是对象」按契约字面读：非 null 对象即可（数组也是一种投影目标，契约没禁）。
        if (typeof item !== 'object' || item === null) {
          offenders.push(`${run.label}: data.${name} 不是对象`)
        }
      }
      // 判据必须与守卫同意同一套规则：形状非法 / 被守卫换掉，都判红。
      const problem = toolResultProblem(run.value)
      if (problem !== undefined) offenders.push(`${run.label}: toolResultProblem 报「${problem}」`)
      if (ensureToolResult(run.value) !== run.value) {
        offenders.push(`${run.label}: 没过守卫（ensureToolResult 换掉了它）`)
      }

      const bucket = stats.get(run.tool) ?? { ok: 0, fail: 0 }
      if (record['ok'] === true) bucket.ok += 1
      else bucket.fail += 1
      stats.set(run.tool, bucket)
    }

    // 下界：每个工具**至少各一条成功与一条失败**，否则「闭集」只在一条路上被看过。
    for (const shape of toolShapes()) {
      const bucket = stats.get(shape.name)
      if (bucket === undefined) {
        offenders.push(`${shape.name}: 语料里一条 fixture 都没有`)
        continue
      }
      if (bucket.ok < 1) offenders.push(`${shape.name}: 没有**成功** fixture（下界）`)
      if (bucket.fail < 1) offenders.push(`${shape.name}: 没有**失败** fixture（下界）`)
    }
    if (stats.size !== toolShapes().length) {
      offenders.push(`语料只覆盖了 ${String(stats.size)}/${String(toolShapes().length)} 个工具`)
    }
    expect(offenders, `B21 违规：\n${offenders.join('\n')}`).toEqual([])
  })
})

// ── B24 execute 全路径不抛 ───────────────────────────────────────────────

/**
 * 一个「底层端口抛异常」的注入组。
 *
 * ## 为什么每组都自带 `calls()` 计数（实测教训，不是洁癖）
 *
 * 本仓第一版 B24 探针在 `probe()` 里**另造了一份 deps**，注入被丢掉 → 六组**全部「通过」**
 * → 差点得出「B24 今天已经是绿的」这个**反结论**。判据必须能自证「替身真的被走到了」，
 * 否则它测的是「工具在正常路径上返回了什么」，与 `execute` 抛不抛无关。
 */
interface InjectionGroup {
  /** 报错时点名用。 */
  label: string
  /** 造一份**新的**工具 + 替身（每次调用都要新的，替身带状态）。 */
  build: () => { tool: ToolDefinition; calls: () => number }
  /** 调用参数。 */
  args: unknown
  /** 需要显式钉住的平台（见 `withPlatformRedline`）。 */
  platform?: NodeJS.Platform
}

/** `check_auth`：能穿出 `execute` 的是 `resolvePort` 读 `env.DSH_WEB_URL`（它**不碰** `spawn`）。 */
function checkAuthEnvBomb(): { tool: ToolDefinition; calls: () => number } {
  let calls = 0
  const env = {} as NodeJS.ProcessEnv
  Object.defineProperty(env, 'DSH_WEB_URL', {
    get() {
      calls += 1
      throw new Error('env exploded')
    },
    enumerable: true,
    configurable: true,
  })
  const home = makeTempRoot('dsh-redline-b24-auth-')
  return {
    tool: createCheckAuthTool(redlineDeps(redlineConfig(home), { env })),
    calls: () => calls,
  }
}

/** `effect_mode`：没有 hmr 时它会去跑 dump，那条路走 `spawn`。 */
function effectModeSpawnBomb(): { tool: ToolDefinition; calls: () => number } {
  let calls = 0
  const home = makeTempRoot('dsh-redline-b24-effect-')
  const spawn: SpawnImpl = async () => {
    calls += 1
    throw new Error('spawn exploded')
  }
  return {
    tool: createEffectModeTool(redlineDeps(redlineConfig(home), { spawn })),
    calls: () => calls,
  }
}

/** `dump_config`：两次 dump 都走 `spawn`。 */
function dumpConfigSpawnBomb(): { tool: ToolDefinition; calls: () => number } {
  let calls = 0
  const home = makeTempRoot('dsh-redline-b24-dump-')
  const spawn: SpawnImpl = async () => {
    calls += 1
    throw new Error('spawn exploded')
  }
  return {
    tool: createDumpConfigTool(redlineDeps(redlineConfig(home), { spawn })),
    calls: () => calls,
  }
}

/** `diagnose`：端口查询那条路走 `spawn` —— 但只在 Windows 上才会起子进程。 */
function diagnoseSpawnBomb(): { tool: ToolDefinition; calls: () => number } {
  let calls = 0
  const home = makeTempRoot('dsh-redline-b24-diag-spawn-')
  writeProfileFixture(home, ['pkg-a'])
  const spawn: SpawnImpl = async () => {
    calls += 1
    throw new Error('spawn exploded')
  }
  return {
    tool: createDiagnosePluginLoadTool(redlineDeps(redlineConfig(home, { port: 3080 }), { spawn })),
    calls: () => calls,
  }
}

/** `diagnose`：读 Loader 树那条路走 `loader`（**与平台无关**，每次都走到）。 */
function diagnoseLoaderBomb(): { tool: ToolDefinition; calls: () => number } {
  let calls = 0
  const home = makeTempRoot('dsh-redline-b24-diag-loader-')
  writeProfileFixture(home, ['pkg-a'])
  const loader = (): never => {
    calls += 1
    throw new Error('loader exploded')
  }
  return {
    tool: createDiagnosePluginLoadTool(redlineDeps(redlineConfig(home), { loader })),
    calls: () => calls,
  }
}

/** `hot_reload`：它唯一多要的宿主端口就是 `reload`。 */
function hotReloadBomb(): { tool: ToolDefinition; calls: () => number } {
  let calls = 0
  const home = makeTempRoot('dsh-redline-b24-reload-')
  const reload: ReloadHost = {
    internalAvailable: () => true,
    cache: () => undefined,
    resolveEntryUrl: async () => '',
    importFresh: async () => ({}),
    candidates: () => {
      calls += 1
      throw new Error('reload port exploded')
    },
  }
  return {
    tool: createHotReloadTool({ ...redlineDeps(redlineConfig(home)), reload }),
    calls: () => calls,
  }
}

describe('B24 execute 全路径不抛（契约的承载条件）', () => {
  it('六组注入：替身**真的被调用**，且返回的是过了守卫的合法结果', async () => {
    const groups: InjectionGroup[] = [
      {
        label: 'check_auth × env（resolvePort 读 DSH_WEB_URL）',
        build: checkAuthEnvBomb,
        args: {},
      },
      { label: 'effect_mode × spawn', build: effectModeSpawnBomb, args: { change: 'config' } },
      { label: 'dump_config × spawn', build: dumpConfigSpawnBomb, args: {} },
      {
        label: 'diagnose × spawn（端口查询；显式钉 win32）',
        build: diagnoseSpawnBomb,
        args: {},
        platform: 'win32',
      },
      { label: 'diagnose × loader', build: diagnoseLoaderBomb, args: {} },
      { label: 'hot_reload × reload', build: hotReloadBomb, args: { entryId: 'pkg-a' } },
    ]

    const offenders: string[] = []
    const trace: string[] = []

    for (const group of groups) {
      const built = group.build()
      const invoke = async (): Promise<unknown> => built.tool.execute(group.args, redlineExec())
      let value: unknown
      let threw: string | undefined
      try {
        value =
          group.platform === undefined
            ? await invoke()
            : await withPlatformRedline(group.platform, invoke)
      } catch (error) {
        threw = error instanceof Error ? error.message : String(error)
      }

      // 下界（实测教训）：替身一次都没被调用 ⇒ 注入没生效 ⇒ 这一组在空转。
      const calls = built.calls()
      trace.push(`${group.label}: calls=${String(calls)}${threw === undefined ? '' : ' THREW'}`)
      if (calls === 0) {
        offenders.push(`${group.label}: 替身一次都没被调用 —— 注入没生效，这一组在空转`)
      }
      if (threw !== undefined) {
        offenders.push(`${group.label}: execute **抛了**（${threw}）—— 契约的承载条件失效`)
        continue
      }

      // 判据是**恒等**：证明这个值**过了守卫**，而不是被守卫合成的兜底（活跃坑 37）。
      if (ensureToolResult(value) !== value) {
        offenders.push(`${group.label}: 返回的不是过守卫的值（被 ensureToolResult 换掉了）`)
      }
      const problem = toolResultProblem(value)
      if (problem !== undefined) offenders.push(`${group.label}: 形状非法（${problem}）`)
      const record = value as { ok?: unknown; data?: Record<string, unknown> }
      if (record.ok !== false) {
        offenders.push(`${group.label}: 期望结构化失败，实际 ok=${String(record.ok)}`)
      }
      if (
        record.data === undefined ||
        Object.keys(record.data).sort().join(',') !== 'audit,key,verdict'
      ) {
        offenders.push(`${group.label}: 失败分支的 data 不是三键闭集`)
      }
    }

    // 声明边界（写进断言消息，防下一个人以为它管得更多）：
    // B24 抓不到「异常被吞掉」——`try{…}catch{ return fail({kind:'internal'}) }` 的返回值合法，
    // 本条照样绿。那是活跃坑 37 的地盘，不在这条红线的声明范围内。
    expect(
      offenders,
      `B24 违规：\n${offenders.join('\n')}\n实测轨迹：\n${trace.join('\n')}\n` +
        '（声明边界：本条的判据是「返回了过守卫的合法结果」，**抓不到「异常被吞掉」**。）',
    ).toEqual([])
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
 * | 2 | B10 与 B15 共用的 fs 写入族（`judgeFsWriteUsage`） | 判据只在「确有 `node:fs` 来源的名字」上生效；来源靠 import 语句文本识别 | 换一种拿 fs 的写法（`require`、把方法先赋给别的变量）会**漏**；见下方「已知未覆盖」。**这段逻辑两条红线共用，改一处两边都变** |
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
 * | 15 | B15 的作用域 | **按文件清单限定**（`WRITE_SIDE_FILES` 两个文件），且**要求它们存在**（不在即红，不给 skip） | 写侧新增文件而没加进清单 → 那个文件**不被 B15 覆盖**（假绿）；清单里的文件被删/改名 → **判红**（响亮，要求显式改这条红线）。**B15 只管写侧，不覆盖诊断半边** —— 诊断那边是 B10 |
 * | 16 | B19 / B23 的 import 闭包 | 自写解析器：正则认 `import … from '<spec>'` 与副作用 `import '<spec>'`；只跟**相对**说明符；`.js` → `.ts` | **动态 `import()` 不跟**（写法 `await import('./x.js')` 会**漏**，属已知未覆盖）；**包名 import 不跟**（本仓零运行时依赖，且观察层不 import 官方包的值路径）；解析器靠文本，不用 TS 的模块图 —— 语法写法一换（`export … from`、重导出）可能漏。【已探明：闭包 18 文件 / 0 未解析】 |
 * | 17 | B19 的「允许清单」`ALLOWED_CREDENTIALS_VALUES` | 手写的**单一名字** `readCredentialsPresence` | `credentials.ts` 改名/新增别的**存在性**扫描函数会**误报**（红，需同步改这张表）；反过来，把一个取值函数**改名成** `readCredentialsPresence` 会绕过（那是刻意伪装，红线本来也防不住） |
 * | 18 | B23 的项目内写 helper 名单 `LOCAL_WRITE_HELPER_NAMES` | 手抄的 6 个名字 | **开放名单，必然漏**：换个名字（`persist()` / `emit()`）就绕过去了。它只挡「顺手抄了测试里的 `writeText`」这一种真实失误。**fs 那部分不是这条的功劳**（那是 B10） |
 * | 19 | B16 的阈值 `CONSTANT_BLOCK_MIN_CHARS = 40` 与「**逐字**相等」的比对 | 阈值是我选的；**不做近似匹配**（§10.2 第 3 条） | 同一句话**同义改写 / 折行** → **漏**（这是**有意**不做的：近似匹配引入假红比漏更贵，见 §10.2）；阈值调大同样只是少抓，不会误红 |
 * | 20 | B18b 用**第一个** ` — ` 切出 `<why>` 正文 | 依赖 §3.1 工具支的分隔符逐字是 ` — ` | `why` 自身含 ` — ` 时**切早** → 正文被判短 → **假绿**（工具支漏报）；分隔符换形状（如 `: `）→ 工具支正文含 `tool(args)` 前缀，该支变**恒真** |
 * | 21 | B22 只查 `audit` 里放进去的**哨兵字符串** | 哨兵是我放的，`auditJsonOf` 用 `JSON.stringify` 读回 | `audit` 以**别的形态**泄漏（渲染时改名 / 编码 / 只印其中一个非哨兵叶子）→ **漏**。本条只覆盖「`audit` 这块或其中这个哨兵进了这段文本」 |
 * | 22 | B17 的取值面 = `verdict`/L2 ∪ **目标工具自己的描述与参数文本** | 目标工具必须在**本仓五工具闭集**里，否则右半边求不出来 | 建议一个**宿主自己的**工具 → 判红（响亮，要求显式扩表或改成 `manual`）。**这是有意的**：不静默放行；但代价是「合法的宿主工具建议」会被拦下 |
 * | 23 | B17 的标识符提取（`leafStrings` + `isExemptIdentifier`） | 只把**字符串与数字**当标识符；`''` / `'0'` / `'1'` 例外；布尔**不算**标识符 | 真标识符恰好是 `0` / `1` / 空串时**漏**（与 SHAPE §10 的例外一致，是有意的）；布尔被排除属判断，不是实测 |
 * | 24 | B20a 的行数判据 | 依赖 `composeDescription` 的 `\n` 连接 + 「先滤空段」 | 连接符换回空格 → **判红**（不是漏，见 M2 变异）；段内折行不会误红（下界写的是 `≥ 段数`） |
 * | 25 | B20a 的参数描述判据**只有下界**（每个非空 + 合计 > 0） | `PARAMETER_DESCRIPTIONS_MAX_CHARS`（≤100）**已于 2026-10-13 删除** | **上界没了 ⇒ 参数描述写多长都不会红**。质量归**人工评审**（SHAPE §10.1 第 4 项），**刻意不做成红线**：语义没法机械判 |
 * | 26 | B20b 只抓**逐字**共享串（≥40 字符） | 同 B16：不做近似匹配 | 描述里**同义改写**输出结构 → **漏**（§10.1 / §10.2 第 2 条已明说）。这条只抓「逐字抄」 |
 * | 27 | B18a / B21 的覆盖面 = `redlineCorpus()` 那 10 条 fixture | 夹具是我造的：每个工具成功/失败各一条 | 工具新增**第三种**返回路径（如新的 `kind`）而语料没覆盖 → 那条路不被这两条红线看见。加分支时**同批加 fixture** |
 * | 28 | B24 的六个注入组 | 每组自带 `calls()` 计数；`diagnose × spawn` **显式钉 `win32`** | 替身调用 0 次 → **判红**（不是 skip）；`diagnose × spawn` 在别的平台本来就不起子进程，所以必须钉平台（否则 CI 上空转） |
 * | 29 | 本文件的 `withPlatformRedline` 与 `test/tools/helpers.ts` 的 `withPlatform` **重复** | 那是本仓已知的测试助手重复（见 AGENTS「技术债：收敛重复的测试助手」） | 收敛那笔债时**连它一起收**；两份实现的语义必须一致（`finally` 里按属性描述符还原） |
 * | 30 | B18a 的**可观测前提**：`toOutput()` 里的 `ensureToolResult` 守卫**在渲染之前**就把「没有动作的 nextStep」换掉了 | 这是 `src/tools/shared.ts` 的现行实现；判据能红，正是因为**红线读的是 `execute` 的返回值、不是渲染文本** | 守卫一旦被挪到渲染之后（或 `toOutput` 被绕过），**B18a 会假绿**：`ensureToolResult` 合成的兜底 `nextStep` 是 `undefined`（缺省 = 合法），坏形状在到达本红线前就消失了。**已用变异实测**：只改工具写法 → 85 全绿（假绿）；**同时旁路守卫 → B18a 红**（另一条 M4 证据） |
 * | 31 | 上一条的连带：`ensureToolResult` 合成的兜底 `key` 是 `{}`，而 `dsh_check_auth` / `dsh_diagnose_plugin_load` / `dsh_dump_config` 的 `keyText` **会崩**在它上面（`resolvedLine(undefined)`） | 三条 `keyText` 都假定 `key.resolved` 在；`effect_mode` / `hot_reload` 的写法是防御式的（`typeof … === 'string' ? … : 'unknown'`） | **这是已实测的工具侧缺陷**（探针：`ensureToolResult({ok:true})` 的 `key={}` 喂五个 render 表 → 3 抛 / 2 过）。**本文件不断言它**（它属 B21/B24 的邻域，修不修由维护者定）；**只报不改** |
 *
 * **B10 已知未覆盖的写入通道**（明确列出，不静默排除）：
 * `process.binding`、原生 addon、`require()`（本仓纯 ESM）、把 fs 方法先赋给别的变量再调用
 * （`const w = writeFileSync`）、以及经 `ctx.subprocess`/`ctx.shell` 发起的写命令。
 * 这些在本仓目前不出现；真出现时要靠人看出来，或把判据扩成 AST 级。
 *
 * **B23 的定位（别读错）**：`[已核]` **B10 已经在扫整个 `src/**`**，且 `FS_WRITE_APIS` 里已含
 * `writeFile` / `mkdir`。所以 B23 的 **fs 部分是 B10 的子集**，它**不提供 B10 没有的 fs 覆盖**。
 * B23 的真实增量只有两条：① 项目内写 helper 名（`writeText(…)`，B10 的「须有 `node:fs` 来源」照不到）；
 * ② 把判据钉在**观察层闭包**而非整个 `src/**`（将来写侧合法获得写入能力时，B10 全局会误伤，B23 不会）。
 * **要加严应从 B10 加**，不要在 B23 里重复实现一遍 fs 判据。
 *
 * **B19 / B23 的下界（SHAPE §10.0）**：两条都是「闭包里不得出现 X」，而**空集不含 X**。
 * `judgeClosureUsable` 是它们共同的前置断言，**空转判红、不给 skip**；它自己有两条否证用例
 * （解析失效 / 没走深到 `src/lib`）。改闭包解析器时**必须先看这两条用例**，否则整族判据会静默变恒真。
 *
 * **B9 第二个出口（提取器之外的）**：`src/tools/` 里**别处**出现的 `dsh_*` 字面量
 * （例如 `nextStep` 文案里的 `tool: 'dsh_dump_config'`）**不被提取器看见** ——
 * 判据只认「声明工具名」的形态（`TOOL_NAME_SHAPES`）。也就是说：把名字改成运行时拼接、
 * 却仍在文案里写旧名字，会**判红**（响亮，正是我们要的）；但反过来，
 * 文案里引用了闭集外的名字**不会**被这条判据照出来。这是**已知未覆盖**。
 *
 * **不要**为了消掉上面这些限度去扩大断言范围 —— 先把限度写清楚，再按需收紧。
 */
