import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
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
import { isDeepStrictEqual } from 'node:util'

import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterAll, describe, expect, it } from 'vitest'

import type { ResolvedConfig } from '../src/contracts.ts'
import { WORKLOAD_DEFAULT_BUDGET_MS } from '../src/lib/timeouts.ts'
// 载体是**工具语料**的一部分（`ToolDeps.carrier` 的兜底落在拒绝那一端）：
// 红线要跑的是「工具能跑通的那条路」，所以在任意平台上都必须显式给 `cli × win32`。
import { carrierOf } from './tools/helpers.ts'
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
import {
  createSignCookieTool,
  SIGN_COOKIE_DESCRIPTION,
  SIGN_COOKIE_TOOL,
} from '../src/tools/dsh_sign_cookie.ts'
import {
  createListInstancesTool,
  DSH_UNAUTHORIZED_BODY,
  LIST_INSTANCES_DESCRIPTION,
  LIST_INSTANCES_TOOL,
} from '../src/tools/dsh_list_instances.ts'
import {
  createRestartTool,
  RESTART_DESCRIPTION,
  RESTART_TOOL,
  type RestartHost,
} from '../src/tools/dsh_restart.ts'
import type { LaunchCommand, RestartFsPort, RestartPorts } from '../src/lib/restart.ts'
import { encodeBase64Url } from '../src/lib/cookie-sign.ts'
import { createToolDeps, type ToolDeps } from '../src/tools/shared.ts'
import { stripComments, withPlatform } from './tools/helpers.ts'

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
 * 剥注释走 `test/tools/helpers.ts` 的共享 `stripComments`（**唯一一份**）。
 *
 * 本文件曾自己内联一份，而 `test/tools/timeout-budgets.test.ts` 还有第三份 ——
 * 两份都源自同一个坑（块注释整段删掉会让后面行号整体前移）。三份实现收敛成一份，
 * 坑的实测证据也一并收在那一处的注释里（两边的证据都留着，别压成一句空话）。
 */

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
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  engines?: Record<string, string>
  exports?: Record<string, unknown>
  files?: string[]
  dsh?: { bundle?: { patch?: string } }
}

const packageJson = JSON.parse(readRepo('package.json')) as Manifest

// ── 文档里点名的包管理器命令，必须是本仓真有的脚本 ──────────────────────────

/**
 * 判据：文档里写的 `npm run X` / `pnpm run X` / `npm test` / `pnpm test`，那个 `X` 必须
 * **真实存在于 `package.json` 的 `scripts` 里**。
 *
 * **为什么要有这条**（维护者 2026-10-15 的原话：「怕你们有时候读到旧文档会被带偏」）：
 * 快速迭代里**过时文档比缺文档更危险** —— 缺的人会去查，过时的**会被当真**。而命令是
 * 最容易被带偏的一类：读者照着文档敲，敲错的东西看起来仍然能跑（`npm run check` 在
 * 没迁 pnpm 时也是能跑的，只是从此不走冻结安装）。
 * ⇒ 与其每次靠人记得去扫文档（**扫一次的成本会随文档增长而上涨，而且必然漏**），
 * 不如让这条**自己红**：改名/删脚本时同一次改动里文档跟着改，忘了就当场红。
 *
 * **判定面刻意只取「文档里点名本仓脚本」的场合**：
 * - **历史陈述不在判定面** —— `docs/PUBLISHING.md` 里有讲 2026-10-13 那次事故的
 *   `npm ci`（那次跑的确实是 `npm ci`），改它就是把历史快照改成假的；
 * - **registry 操作不在判定面** —— `npm publish` / `view` / `deprecate` / `pack`
 *   是 **npm 自己的**命令，迁 pnpm 不改这些（CI 的 publish 步骤走的也是 npm）。
 * ⇒ 所以本判据查的是**脚本名**是否存在，不查**该用哪个包管理器**；
 * 「文档里的包管理器前缀对不对」是**人工评审**那一半，本判据只钉住**不会敲错脚本名**那一半。
 */

/** 文档里出现的「包管理器 + run/test/ci」形态，只保留本仓脚本该有的那一段。 */
const DOC_COMMAND_PATTERN =
  /(?<![a-z])(?:npm|pnpm) (?:run |)test\b|(?<![a-z])(?:npm|pnpm) run ([a-z0-9:_-]+)/g

/** 从文档里提出「它想跑的脚本名」，去掉明显不是本仓脚本的（registry 操作、历史快照）。 */
function collectClaimedScriptNames(markdown: string): string[] {
  const claims: string[] = []
  for (const match of markdown.matchAll(DOC_COMMAND_PATTERN)) {
    // `npm test` / `pnpm test` —— 无参形态指向 `test` 脚本。
    if (match[0].endsWith('test')) {
      claims.push('test')
      continue
    }
    const named = match[1]
    // registry 侧的 npm 子命令带别的形状（publish / view / deprecate / pack），
    // 它们不是 package.json 的 scripts，不该进判定面。
    if (named !== undefined) claims.push(named)
  }
  return claims
}

/** 会被这条判据读到的文档：门面、子树手册、docs 下那几份。 */
const DOC_COMMAND_FILES = [
  'README.md',
  'README_zh.md',
  'AGENTS.md',
  'docs/SHAPE.md',
  'docs/ARCHITECTURE.md',
  'docs/PUBLISHING.md',
  'docs/HOST-CONTRACTS.md',
  'src/README.md',
  'src/lib/README.md',
  'src/skills/README.md',
  'src/tools/README.md',
  'test/README.md',
  'test/tools/README.md',
  'test/skills/README.md',
  'test/integration/README.md',
  'scripts/README.md',
  'locale/README.md',
  'skills/README.md',
] as const

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
 * A4 判据：锁文件里**出现的每一个 http(s) 地址**都必须指向官方 registry。
 *
 * 迁到 pnpm 之后**形状变了、口径没变**：pnpm-lock 不再有 `resolved: <url>` 那一层
 * （完整性摘要在 `resolution: {integrity: …}`），所以判据从「解析 JSON 的 resolved 字段」
 * 换成「扫原文里出现的每一个 http(s) 地址」。
 *
 * ⚠️ **反空转换了挂点**（这是本条最容易做错的地方）：npm 的锁文件里每个包都有一条
 * `resolved`，所以「扫到 0 条」必然意味着读错了文件；而 pnpm 只在来源**不是**默认 registry
 * 时才写 `tarball: <url>`，于是「零个地址」是**正常状态**
 * （本仓实测：0 个地址 / 188 条 `resolution`；三个姊妹仓的 pnpm 锁文件同样是 0）。
 * 把反空转继续挂在地址数上，就成了**永远红**的自否定守卫 —— 所以它改挂在
 * 「锁文件本身到底被读进来了没有」上，见 `lockfileVacuityProblems`。
 *
 * 只看 http(s)：`file:` / `link:` / `git` 本就不是包的公开源。
 */
const LOCKFILE_NAME = 'pnpm-lock.yaml'

/** 官方 registry 主机名。按**逐字相等**判（`startsWith` 会放过 `registry.npmjs.org.evil.com`）。 */
const OFFICIAL_REGISTRY_HOST = 'registry.npmjs.org'

/** 扫出文本里出现的所有 http(s) 地址（顺手去掉紧跟其后的 YAML 标点）。 */
function httpUrlsIn(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s'"<>\\]+/g)].map((match) =>
    match[0].replace(/[,)\]}]+$/, ''),
  )
}

/** A4 判据体：返回扫到的地址数与违规清单。只吃文本，所以反例可以在内存里构造。 */
function judgeLockfileRegistry(lockText: string): { scanned: number; offenders: string[] } {
  const urls = httpUrlsIn(lockText)
  const offenders: string[] = []
  for (const url of urls) {
    let host = url
    try {
      host = new URL(url).hostname
    } catch {
      // 解析不了就原样报出来 —— 比吞掉更像一条线索。
    }
    if (host !== OFFICIAL_REGISTRY_HOST) offenders.push(`${url} → ${host}`)
  }
  return { scanned: urls.length, offenders }
}

/**
 * A4 的反空转：判据必须自证**真的读到了一份有内容的 pnpm 锁文件**。
 *
 * 为什么不是「地址数为 0 就红」：pnpm 对默认 registry 的包不写 `tarball`，所以零地址
 * 正是**干净锁文件**的样子（见上面那段）。真正的空转是「读错文件 / 读成空 / 被截断」——
 * 那两种都表现为**没有 `lockfileVersion`、没有 `resolution` 条目**，在这里判红。
 */
function lockfileVacuityProblems(lockText: string): string[] {
  const problems: string[] = []
  if (!/^lockfileVersion:/m.test(lockText)) {
    problems.push('锁文件里没有 lockfileVersion —— 读到的不是 pnpm 锁文件，判据没跑到')
  }
  if (!/^\s+resolution:/m.test(lockText)) {
    problems.push('锁文件里没有 resolution 条目 —— 判据没跑到，不是判据通过')
  }
  return problems
}

/**
 * A4b 判据：`pnpm-lock.yaml` 是**唯一**的锁文件。
 *
 * 跨仓判据：全族只有 pnpm 一条路。两份锁文件同时存在时，CI 装的那棵与本机装的那棵
 * 可以不是同一棵，而「装出来能跑」不会报错 —— 那正是要在这里拦的情况。
 *
 * ⚠️ 那个名字刻意**拼出来**、不写字面量：本文件正被一次批量改名扫过，写字面量的话
 * 这条断言会被改成「pnpm-lock.yaml 不该存在」而**永远红** —— 一个自我否定的守卫
 * 比没有守卫更坏。
 */
const COMPETING_LOCKFILE_NAMES = [['package', 'lock.json'].join('-')]

/** A4b 判据体：目录里除 `pnpm-lock.yaml` 外还有别的锁文件、或它自己缺席，都算违规。 */
function judgeSingleLockfile(names: readonly string[]): string[] {
  const offenders = COMPETING_LOCKFILE_NAMES.filter((name) => names.includes(name)).map(
    (name) => `${name} 与 ${LOCKFILE_NAME} 不能共存`,
  )
  if (!names.includes(LOCKFILE_NAME)) offenders.push(`${LOCKFILE_NAME} 必须入库`)
  return offenders
}

describe('A4 锁文件：地址只许指向官方 registry，且只有它一个', () => {
  it('真实 pnpm-lock.yaml 里没有镜像源，且判据真的读到了锁文件', () => {
    const lockText = readRepo(LOCKFILE_NAME)

    // 反空转先跑：先证明这次扫描的输入是一份真的、有内容的 pnpm 锁文件。
    const vacuity = lockfileVacuityProblems(lockText)
    expect(vacuity, describeOffenders('A4 判据没跑到', vacuity)).toEqual([])

    const { scanned, offenders } = judgeLockfileRegistry(lockText)
    expect(
      offenders,
      describeOffenders(`锁文件里有非官方源（本次扫到 ${scanned} 个地址）`, offenders),
    ).toEqual([])
  })

  it('判据可被否证：往真实锁文件里注入一条镜像地址就会红，且报出主机名', () => {
    // 夹具是**文本级**的：判据只扫原文，不解析 YAML，所以这段不必是合法锁文件。
    const injected = `${readRepo(LOCKFILE_NAME)}
  'evil@1.0.0':
    resolution:
      {tarball: https://registry.npmmirror.com/evil/-/evil-1.0.0.tgz, integrity: sha512-x}
`
    const { scanned, offenders } = judgeLockfileRegistry(injected)
    expect(scanned).toBeGreaterThan(0)
    expect(offenders).toHaveLength(1)
    expect(offenders[0]).toContain('registry.npmmirror.com')
  })

  it('判据可被否证：官方 registry 的地址不算违规（扫描器真的会认出地址）', () => {
    // 上一条只证明「扫到违规会红」；一个恒返回违规的扫描器也能让它绿。
    // 这条补「扫到合法地址**不**红」，两条合起来才钉死扫描器本身有效。
    const baseline = judgeLockfileRegistry(readRepo(LOCKFILE_NAME)).scanned
    const injected = `${readRepo(LOCKFILE_NAME)}
# https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz
`
    const { scanned, offenders } = judgeLockfileRegistry(injected)
    expect(scanned).toBe(baseline + 1)
    expect(offenders).toEqual([])
  })

  it('判据可被否证：锁文件被扫空（读错 / 截断）时反空转先红', () => {
    expect(lockfileVacuityProblems(''), '空文本必须判红，不许静默判过').not.toEqual([])
    expect(
      lockfileVacuityProblems("lockfileVersion: '9.0'\n"),
      '只有版本号、没有包段也必须判红',
    ).not.toEqual([])
  })

  it('真实仓库根目录里只有 pnpm-lock.yaml 一个锁文件', () => {
    const offenders = judgeSingleLockfile(readdirSync(REPO_ROOT))
    expect(offenders, describeOffenders('锁文件不唯一', offenders)).toEqual([])
  })

  it('判据可被否证：把那个 npm 锁文件放回去就红', () => {
    // 用**同一个判据函数 + 同一个目录列举机制**跑一个临时目录：这条证明判据体有效，
    // 上面那条证明它接在真实仓根上（`REPO_ROOT` 传错会报「必须入库」而红）。
    const root = makeTempRoot('dsh-redline-locks-')
    try {
      writeFileSync(join(root, LOCKFILE_NAME), '')
      writeFileSync(join(root, COMPETING_LOCKFILE_NAMES[0]), '')
      const names = readdirSync(root)
      // 夹具真的落地了才算数：写失败时这条会红，而不是静默空转。
      expect(names).toContain(COMPETING_LOCKFILE_NAMES[0])
      const offenders = judgeSingleLockfile(names)
      expect(offenders).toHaveLength(1)
      expect(offenders[0]).toContain(COMPETING_LOCKFILE_NAMES[0])
    } finally {
      cleanupTempRoot(root)
    }
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

/**
 * 取出源码里所有 **import/export 说明符**。
 *
 * 为什么只认语句形态、不认「任何含 `@deepseek-ai/` 的字符串字面量」：本仓的**代码**里
 * 本来就有这类字面量，而且它们**不该**被当成依赖 —— `src/lib/profile.ts` 有
 * `const HMR_PACKAGE = '@deepseek-ai/dsh-hmr'` 与 `resolve('@deepseek-ai/dsh/package.json')`，
 * 两者都是「按名字去查宿主安装树」，不是本仓 import 的包。宽扫会当场假红。
 *
 * 所以先剥注释（`stripComments`），再只认四种写法：`import x from 's'`、
 * `import type { T } from 's'`（含跨行的花括号子句）、副作用 `import 's'`、`export … from 's'`。
 */
function importSpecifiers(source: string): string[] {
  const text = stripComments(source)
  const out: string[] = []
  // `import` / `export` … `from 's'`：`[^'"]` 允许换行，于是跨行的 import 子句也认。
  const fromClause = /\b(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g
  // 副作用 import：`import 's'`（它没有 `from`，上面那条抓不到）。
  const sideEffect = /\bimport\s*['"]([^'"]+)['"]/g
  for (const re of [fromClause, sideEffect]) {
    let match: RegExpExecArray | null
    while ((match = re.exec(text)) !== null) out.push(match[1])
  }
  return out
}

/** 说明符 → 包名（`@scope/name/sub` → `@scope/name`）。 */
function packageNameOf(specifier: string): string {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/**
 * B28 判据：`src/` 里 import 的每个 `@deepseek-ai/*` 都必须在清单里声明。
 *
 * 为什么这条必须存在（它是**实测踩出来的**，不是洁癖）：`src/config.ts` 一直
 * `import z from '@deepseek-ai/schemastery'`，而 `package.json` 里**三处都没有它** ——
 * 它只是经 `@deepseek-ai/dsh-llm` 传递进来的。npm 与 hoisted linker 都会把它抬到顶层，
 * 于是**靠包管理器的 hoist 行为**才解析得到。迁 pnpm 后在默认（isolated）linker 下当场现形：
 * `tsc` 报 `TS2307: Cannot find module '@deepseek-ai/schemastery'`，4 个测试文件起不来。
 *
 * 为什么 A1 抓不住它：A1 管的是「**已经声明**的官方包在 peer 与 dev 里要同值」——
 * **整个声明缺失**从它旁边直接走过去。这条补的正是那个缺口。
 */
function judgeOfficialImportsDeclared(
  sources: ReadonlyArray<{ path: string; text: string }>,
  pkg: Manifest,
): string[] {
  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ])
  const offenders: string[] = []
  for (const { path, text } of sources) {
    for (const specifier of importSpecifiers(text)) {
      if (!specifier.startsWith('@deepseek-ai/')) continue
      const name = packageNameOf(specifier)
      if (!declared.has(name)) offenders.push(`${path}: import 了 ${name}，但清单里没声明`)
    }
  }
  return offenders
}

/** 去掉一个键（用于「摘掉声明」的否证用例）。 */
function withoutKey(
  record: Record<string, string> | undefined,
  key: string,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, range] of Object.entries(record ?? {})) if (name !== key) out[name] = range
  return out
}

describe('B28 src 里 import 的官方包都必须在清单里声明（不许靠 hoist 掩着）', () => {
  it('真实源码与清单一致，且扫描量非零', () => {
    const sources = readSourcesUnder('src')
    const scanned = new Set(
      sources
        .flatMap(({ text }) => importSpecifiers(text))
        .filter((specifier) => specifier.startsWith('@deepseek-ai/'))
        .map(packageNameOf),
    )
    // 反空转：一个都没扫到 = 判据没跑到，不是判据通过（本仓 A4 的老教训）。
    expect(
      scanned.size,
      '一个 @deepseek-ai/* import 都没扫到 —— 判据没跑到，不是判据通过',
    ).toBeGreaterThan(0)
    const offenders = judgeOfficialImportsDeclared(sources, packageJson)
    expect(offenders, describeOffenders('import 了未声明的官方包', offenders)).toEqual([])
  })

  it('判据可被否证：摘掉 @deepseek-ai/schemastery 的声明就会红', () => {
    const mutated: Manifest = {
      ...packageJson,
      peerDependencies: withoutKey(packageJson.peerDependencies, '@deepseek-ai/schemastery'),
      devDependencies: withoutKey(packageJson.devDependencies, '@deepseek-ai/schemastery'),
    }
    const offenders = judgeOfficialImportsDeclared(readSourcesUnder('src'), mutated)
    expect(offenders.length).toBeGreaterThan(0)
    expect(offenders.join('\n')).toContain('@deepseek-ai/schemastery')
  })

  it('提取器本身有效：四种 import 形态都认得', () => {
    const sample = [
      "import z from '@deepseek-ai/alpha'",
      "import type { C } from '@deepseek-ai/beta'",
      "import '@deepseek-ai/gamma'",
      "export { d } from '@deepseek-ai/delta'",
      "import {\n  e,\n  f,\n} from '@deepseek-ai/epsilon'",
    ].join('\n')
    expect([...new Set(importSpecifiers(sample))].sort()).toEqual([
      '@deepseek-ai/alpha',
      '@deepseek-ai/beta',
      '@deepseek-ai/delta',
      '@deepseek-ai/epsilon',
      '@deepseek-ai/gamma',
    ])
  })

  it('别误伤：注释与普通字符串字面量里的包名不算 import', () => {
    const sample = [
      "// import x from '@deepseek-ai/never-declared'",
      "/* import y from '@deepseek-ai/also-never-declared' */",
      "const HMR_PACKAGE = '@deepseek-ai/dsh-hmr'",
      "createRequire(entry).resolve('@deepseek-ai/dsh/package.json')",
    ].join('\n')
    expect(importSpecifiers(sample)).toEqual([])
  })
})

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

  it('判据可被否证：删掉所有提到 skills 的条目，技能就不再随包', () => {
    // **不写死条目名**：`files` 怎么拼（整目录 `skills`，还是显式路径
    // `skills/<name>/SKILL.md`）与这条否证无关。写死就会变成「改了拼法 ⇒ 一条都没删掉
    // ⇒ 否证静默失效」—— 那正是本仓踩过的那类空转（与坑 18 同族）。
    const before = packageJson.files ?? []
    const mutated = before.filter((entry) => !entry.includes('skills'))
    expect(
      mutated.length,
      '`files` 里一条提到 skills 的条目都没有 —— 变异没落地，这条否证在空转',
    ).toBeLessThan(before.length)
    expect(judgeFilesCoverage(mutated)).toContain('skills/dsh-plugin-debugging/SKILL.md')
  })

  it('判据可被否证：取反条目不算覆盖', () => {
    expect(judgeFilesCoverage(['!skills', '!LICENSE'])).toContain('LICENSE')
  })
})

/**
 * B31 判据：**门面图不进 npm 包，README 用相对路径引用它。**
 *
 * 两条独立的理由，合成同一条判据（它们必须一起成立，缺一条就是另一种坏法）：
 *
 * **① 体积**：本仓 `assets/` 曾经整目录进包，而门面里那两张大图（横幅 4.0 MB 的动画 GIF、
 * 一张 32 KB 截图）只在两份 README 里当插图 —— 它们跟着包发出去时占掉整包 **78%** 的体积，
 * 而市场的每小时构建要把四个包都抓下来读 `locale/` 与图标，本仓一个包就占了那一轮下载的 91%
 * （单次 16 秒，其余三个各 1–2 秒）。见
 * .agents/notes/2026-10-20-readme-images-out-of-tarball.md。→ 图**不进包**。
 *
 * **② 写法**：README 一律用**相对路径**。npm 会把 README 的相对图片路径解析到仓库的 raw 文件
 * （维护者 2026-10-20 在 npm 页面上实地确认：图正常显示），所以「不进包 + 相对引用」是成立且
 * 统一的组合 —— 四个插件仓都这么写。绝对 URL 是**例外形态**：它把 owner/repo/分支硬编码进散文，
 * 仓改名或转移就静默破图，而且旧版本页面会跟着 `main` 走。只有「图确实在别的仓」时才该用它。
 *
 * **这个事实不是论证出来的，是 grep 出来的**：`dsh-zhihu-search/assets/README.md` 早就写着
 * 「npm 会把 README 的相对图片路径改写到默认分支的 raw 地址」。顺序应当是**先在兄弟仓里搜既有
 * 结论，再自己论证** —— 详见上面那份决策记录的「教训」一节。
 *
 * 判据的五面：
 *   1. 两份门面都用**相对路径**引用这两张图，且没有它们对应的绝对 raw 形态；
 *   2. 文件**在仓里存在** —— 相对路径写错或文件被删时没人会收到报错（图静默不显示）；
 *   3. 它们**没被 `files` 覆盖** —— 只改 README 不改 `files` 等于白改（体积一分没省）；
 *   4. 反向钉住：**运行期资产必须仍在包里** —— 防止「顺手把 assets 全排掉」那种过度收窄，
 *      那会让 `launcher.js` / `*.vbs` / `stop-window.ps1` 缺席，而这些是代码在运行期按包内路径找的；
 *   5. **写法本身**：`files` **逐条列举**运行期资产、**不出现** `assets` 整目录条目 ——
 *      只判「今天这两张图不在包里」的话，「整目录 + 按名排除」的旧写法同样绿，而新增一张截图
 *      会静默重新进包 —— 判据守的是**方向**，不是今天的清单（组织判据把它判成真缺陷的那一轮）。
 *      代价照实记：逐条列举意味着新增运行期资产要显式写进 `files`，于是另配一条兜底断言
 *      （`assets/` 里每个文件要么是门面图、要么被列举），把「忘了列举」变成红而不是静默缺席。
 */
const README_ONLY_IMAGES = ['assets/banner.gif', 'assets/invoke-skill.png'] as const

/** 运行期资产：代码按包内路径引用，**必须**随包发出去。 */
const RUNTIME_ASSETS = [
  'assets/launcher.js',
  'assets/launcher.d.ts',
  'assets/launcher.vbs',
  'assets/show-window.vbs',
  'assets/stop-window.ps1',
] as const

/**
 * 判据本体：一份门面里，门面图该是相对路径、且不该有对应的绝对 raw 形态。
 *
 * 抽成函数是为了**否证能真的跑起来**（把真实文本变异后喂回来），而不是只断言「现在通过」。
 *
 * @param readme - README 文件名，只用于报错文案。
 * @param body - README 正文。
 * @returns 违规描述；空数组表示通过。
 */
function facadeImageOffenders(readme: string, body: string): string[] {
  const offenders: string[] = []
  for (const image of README_ONLY_IMAGES) {
    if (!body.includes(`src="${image}"`)) {
      offenders.push(`${readme} 没有用相对路径引用 ${image}`)
    }
    // 同一张图的绝对形态：`/assets/<文件名>` 出现即视为写回了绝对 URL。
    const absolute = new RegExp(
      `src="https?://[^"]*/${image.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`,
    )
    if (absolute.test(body)) {
      offenders.push(`${readme} 里 ${image} 是绝对 URL —— 家族统一用相对路径`)
    }
  }
  return offenders
}

/**
 * 某条 `files` 取反条目能不能命中目标路径。
 *
 * 与本文件的 `fileEntryCovers` 同一个取舍：只实现本仓真实用到的形态（显式路径、`dir/**`），
 * 不做通用 glob —— 一个「看起来像完整 minimatch」的实现比一个窄的更容易被误信。
 * @param entry - 以 `!` 开头的 `files` 条目。
 * @param target - 仓库相对路径。
 * @returns 命中时为 true。
 */
function negationMatches(entry: string, target: string): boolean {
  const pattern = entry.slice(1).replace(/^\.\//, '')
  if (pattern === '') return false
  if (pattern.endsWith('/**')) return target.startsWith(`${pattern.slice(0, -3)}/`)
  const clean = pattern.replace(/\/+$/, '')
  return target === clean || target.startsWith(`${clean}/`)
}

/**
 * 某个路径**是否真的会进包**：既被某条正向条目覆盖，又没被任何取反条目命中。
 *
 * @param files - `package.json` 的 `files`。
 * @param target - 仓库相对路径。
 * @returns 会进包时为 true。
 */
function shippedInPackage(files: readonly string[] | undefined, target: string): boolean {
  const list = files ?? []
  const covered = list
    .filter((entry) => !entry.startsWith('!'))
    .some((e) => fileEntryCovers(e, target))
  const negated = list
    .filter((entry) => entry.startsWith('!'))
    .some((e) => negationMatches(e, target))
  return covered && !negated
}

describe('B31 门面图不进包，且 README 用相对路径引用', () => {
  it('两份门面都用相对路径引用这两张图，且没有绝对 raw 形态', () => {
    for (const readme of ['README.md', 'README_zh.md']) {
      const offenders = facadeImageOffenders(readme, readRepo(readme))
      expect(offenders, describeOffenders('门面图写法不对', offenders)).toEqual([])
    }
  })

  it('绝对路径指向的文件在仓里存在（否则图片静默不显示，没有任何报错）', () => {
    for (const image of README_ONLY_IMAGES)
      expect(existsRepo(image), `${image} 不在仓里`).toBe(true)
  })

  it('这两张图不进包，而运行期资产必须进包', () => {
    const files = packageJson.files
    const wronglyShipped = README_ONLY_IMAGES.filter((image) => shippedInPackage(files, image))
    expect(
      wronglyShipped,
      describeOffenders('门面图跟着包发出去了（曾占整包约 78% 体积）', wronglyShipped),
    ).toEqual([])

    const missing = RUNTIME_ASSETS.filter((asset) => !shippedInPackage(files, asset))
    expect(
      missing,
      describeOffenders('运行期资产没进包（代码按包内路径找它们，会运行期崩）', missing),
    ).toEqual([])
  })

  /**
   * `files` 不列 `assets/` 整个目录 —— 这一条把**写法本身**钉住。
   *
   * 只判「图不在包里」是不够的：`["assets", "!assets/banner.gif", "!assets/invoke-skill.png"]`
   * 这种「整目录 + 按名排除」的旧写法当时也是绿的（图确实被排掉了），可新增一张截图会静默
   * 重新进包 —— 判据守的是**方向**，不是今天的清单。详见决策记录
   * .agents/notes/2026-10-20-readme-images-out-of-tarball.md 与取代它的那一条。
   */
  it('`files` 逐条列举 assets/ 里的运行期资产，不出现整目录条目', () => {
    const files = packageJson.files ?? []
    expect(
      files.filter((entry) => entry === 'assets' || entry === 'assets/'),
      '`files` 里出现了整目录条目 —— 新增的截图会跟着进包',
    ).toEqual([])

    const enumerated = files.filter((entry) => entry.startsWith('assets/'))
    // 自检：一条都没列举时，上面那条断言恒为真 —— 那是「判据没跑到」。
    expect(enumerated.length, '`files` 里一条 assets/<文件> 都没有 —— 判据没跑到').toBeGreaterThan(
      0,
    )
    for (const asset of RUNTIME_ASSETS) {
      expect(enumerated, `运行期资产 ${asset} 没有逐条列举`).toContain(asset)
    }
  })

  /**
   * 反向兜底，正是「改成白名单」的代价所在：新增一个运行期资产如果忘了写进 `files`，
   * 它会**静默缺席**（`test/assets.test.ts` 从磁盘读，照样绿，只有真机才炸）。
   *
   * 所以判据取「`assets/` 里每个文件要么是门面图、要么在 `files` 里」——
   * 新增任何一类文件都会当场红，红的时候自然要求人决定它该不该随包。
   */
  it('assets/ 里每个文件要么是门面图，要么被 files 列举（新增资产不会静默缺席）', () => {
    const files = packageJson.files
    const known = new Set<string>([...README_ONLY_IMAGES, ...RUNTIME_ASSETS])
    // 自检：目录读不到时这条会把「没扫到」算成通过。
    const present = readdirSync(join(REPO_ROOT, 'assets'))
    expect(present.length, 'assets/ 是空目录 —— 判据没跑到').toBeGreaterThan(0)

    const unclassified = present
      .map((name) => `assets/${name}`)
      .filter((path) => !known.has(path) && !shippedInPackage(files, path))
    expect(
      unclassified,
      describeOffenders(
        'assets/ 里有既不是门面图、又没被 files 列举的文件（新增运行期资产会静默不随包）',
        unclassified,
      ),
    ).toEqual([])
  })

  it('判据可被否证：改成绝对 URL、或换回整目录写法，都会红', () => {
    // 变异 1：把一张门面图写回绝对 raw URL —— 判据必须红。
    const absoluteForm = readRepo('README.md').replace(
      'src="assets/banner.gif"',
      'src="https://raw.githubusercontent.com/dsh-plugin-lab/dsh-plugin-debugging/main/assets/banner.gif"',
    )
    expect(absoluteForm, '变异没落地：README.md 里找不到相对引用的 banner.gif').not.toBe(
      readRepo('README.md'),
    )
    expect(facadeImageOffenders('README.md', absoluteForm).length).toBeGreaterThan(0)

    // 变异 2：把逐条列举的 5 个运行期资产换回整目录 `assets` —— 门面图会被算成随包。
    // 旧写法下的等价变异是「删掉 `!assets/` 取反条目」；判据意图没变（按名排除的写法会让
    // 新截图悄悄进包），变的只是旧写法已经不存在了。
    const files = packageJson.files ?? []
    const enumerated = RUNTIME_ASSETS as readonly string[]
    const collapsed = files.filter((entry) => !enumerated.includes(entry))
    expect(collapsed.length, '`files` 里没有逐条列举的运行期资产 —— 变异没落地').toBeLessThan(
      files.length,
    )
    const collapsedFiles = [...collapsed, 'assets']
    expect(shippedInPackage(collapsedFiles, 'assets/banner.gif')).toBe(true)
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
  'dsh_list_instances',
  'dsh_hot_reload',
  'dsh_sign_cookie',
  'dsh_restart',
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

/**
 * 从一份 Markdown 里收集「**宣称存在**」的 `dsh_*` 记号。
 *
 * ## 为什么要在 B9 的基础上再窄一层
 *
 * B9 的原判据是「文档里出现闭集外的名字 = 文档在宣称一个不存在的工具」——
 * 这个方向是对的，`dsh_restart` 那类**规划中**的工具名本不该被当成已存在。
 *
 * 但它**没有区分两种出现**：宣称它有，和**明确说它没有**。
 * 而技能正文里「重启类动作有意排在最后、本插件不提供它」是**必须写**的 ——
 * 不写，模型会去调一个不存在的工具（SHAPE §1 对「未做工具」的处置正是这一条）。
 *
 * ⇒ 处置：**按行判定**，只在同一行明确说了「不提供 / 尚未 / 没有」时放行。
 * 措辞必须贴着那一行判定，所以这句话写在哪一行、在不在，都影响判据 ——
 * 这是有意的：把「本插件没有这个工具」挪到别的段落，就不再算数。
 *
 * @param markdown 整份文档。
 */
function collectClaimedToolNames(markdown: string): string[] {
  const denied = /不提供|尚未实现|尚未提供|还没有(这个)?工具|有意推迟|不在本仓/
  return [...markdown.matchAll(/\bdsh_[a-z0-9_]+/g)]
    .filter(
      (match) => !denied.test(markdown.slice(match.index, markdown.indexOf('\n', match.index))),
    )
    .map((match) => match[0])
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
    // ⚠️ 必须写**字面量**名字，不能写 `EXPECTED_TOOLS[i]` —— 追加工具时
    // 这里只喂前几种形态，而末尾拿 `[...EXPECTED_TOOLS]` 断言，就会自己判自己红。
    const synthetic = [
      `export const A_TOOL = 'dsh_check_effect_mode'`,
      `export const B_TOOL = "dsh_diagnose_plugin_load"`,
      `export const C_TOOL = \`dsh_check_auth\``,
      `export const lowercaseName = "dsh_dump_config"`,
      `export function make() { return defineTool({ name: 'dsh_hot_reload' }) }`,
      // 第 6 个工具（W4 `dsh_sign_cookie`）走的是「常量 + defineTool 内联 name」两处，
      // 与上面五种形态同批 —— 所以这里也必须是**字面量**，不能用索引取。
      `export const SIGN_COOKIE_TOOL = 'dsh_sign_cookie'`,
      // 第 7 个工具（D′ 的发现工具）同样走「常量 + defineTool 内联 name」两处。
      `export const LIST_INSTANCES_TOOL = 'dsh_list_instances'`,
      // 第 8 个工具（行动类 `dsh_restart`）同样走「常量 + defineTool 内联 name」两处。
      `export const RESTART_TOOL = 'dsh_restart'`,
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
      for (const name of collectClaimedToolNames(corpus.text)) {
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

  it('「说明尚不存在」才放行：换个说法就又变成宣称存在', () => {
    // 窄的那一层**建立在那条宽的之上**：被放行的记号，全集里必须真的出现过。
    // 否则「什么都没扫到」也能通过 —— 那正是坑 18 说的静默失败。
    const denied = '本插件**不提供**它'
    const sample = (text: string) =>
      collectClaimedToolNames(`- 重启类动作（\`dsh_restart\`）${text}。\n`)
    const deniedLine = `- 重启类动作（\`dsh_restart\`）${denied}。\n`
    expect(collectMentionedToolNames(deniedLine)).toEqual(['dsh_restart'])
    expect(sample(denied)).toEqual([])
    // 中性措辞（「有意排在最后」没说不提供）⇒ 判它宣称存在。
    expect(sample('**有意排在最后**')).toEqual(['dsh_restart'])
    // 空集口径（什么都不放行）必须判红 —— 否则「工具尚未落地」那条正当用法也过不去。
    expect(() => expect(sample(denied)).toEqual(['dsh_restart'])).toThrow()
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
 * 文档里点名的包管理器命令，其脚本名必须真在 `package.json` 里。
 *
 * 与 B9 那条「文档提到的工具名属于闭集」同族：B9 守的是**工具名**，这条守的是**脚本名** ——
 * 两者都是「文档断言了一件事，而那件事最好有东西在守」。维护者 2026-10-15 点名的正是
 * 这个形状：「怕你们有时候读到旧文档会被带偏」。命令是最容易带偏的一类，因为敲错的命令
 * **看起来仍然能跑**。
 */
describe('B29 文档点名的脚本名必须真存在', () => {
  it('提取器本身有效：`npm run X` / `pnpm run X` / `npm test` / `pnpm test` 四种形态都提得出脚本名', () => {
    const sample = [
      '必跑 `npm run check`。',
      '必跑 `pnpm run check:release`。',
      '要个数就去跑 `npm run test`。',
      '本机侧跑 `pnpm test`。',
    ].join('\n')
    // ⚠️ **这四条各自都不可省**：`pnpm run X` 那两条是这条判据真正在守的东西 ——
    // 若提取器只认 `npm`（哪怕带着词边界），`pnpm` 那两行就提不出脚本名，本条立刻红。
    // （2026-10-15：曾额外写一条「pnpm 不被当成 npm」并声称它钉住词边界，变异后仍是绿的 ——
    //  交替本身就能解析 `pnpm`，那条是装饰性假绿，已删。）
    expect(collectClaimedScriptNames(sample).sort()).toEqual([
      'check',
      'check:release',
      'test',
      'test',
    ])
  })

  it('`pnpm run X` 提出来的是 X，不是把 pnpm 当成 npm 再多提一次', () => {
    // 防空转的一半：**同一个脚本名不该因为前缀不同被算成两条**。
    expect(collectClaimedScriptNames('跑 `pnpm run check`')).toEqual(['check'])
  })

  it('文档里点名的每个脚本都在 package.json 里（漏改的当场红）', () => {
    const scripts = packageJson.scripts ?? {}
    const offenders: string[] = []
    let claims = 0
    for (const relPath of DOC_COMMAND_FILES) {
      const markdown = readRepo(relPath)
      // 自证读到的是真文件：读错路径会得到空串，而空串 = 0 命中 = 看起来像全绿（坑 18）。
      expect(markdown.length, `${relPath} 短得不像真文件`).toBeGreaterThan(200)
      for (const name of collectClaimedScriptNames(markdown)) {
        claims += 1
        if (!Object.prototype.hasOwnProperty.call(scripts, name)) {
          offenders.push(`${relPath} 让读者跑 \`${name}\`，而 package.json 的 scripts 里没有它`)
        }
      }
    }
    // 防空转：扫不到东西时下面那条判红没有意义。
    expect(
      claims,
      `${DOC_COMMAND_FILES.length} 份文档里一个脚本名都没扫到 —— 提取器坏了`,
    ).toBeGreaterThan(0)
    expect(offenders, describeOffenders('文档点名了不存在的脚本', offenders)).toEqual([])
  })
})

/**
 * B10 判据：**只读半边** —— 不许杀进程 / 写文件 / 写宿主数据目录 / 走 `dsh plugin` 安装面。
 *
 * ## 作用域是**整个 `src/**`**，不只是诊断半边（2026-10-14 改：注释与实现曾不一致）
 *
 * 标题里的「诊断半边」说的是**动机**（那四个只读工具），而扫描面**刻意取全部 `src/**`**：
 * 写侧那两个文件若只由 B15 管，就会漏掉 B10 独有的那条安装面规则（`dsh plugin add/remove/…`）
 * —— B15 不管安装面。收窄成「只有诊断半边」= **削弱保护面**，本仓明确禁止
 * （见文末「已知限度」里关于「不要为了显得别的红线更值钱而放宽 B10」的告诫）。
 * 作用域本身有一条判据钉着（`B10 的作用域是整个 src/**`），谁想收窄都会红。
 * 两条的分工：**B10 = 只读半边不许改系统状态（宽作用域）；B15 = 写侧不许越出进程内（窄作用域、更严）**。
 * **这里四类扫描一个字都没有放宽。**
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
 * - 禁止**写进宿主自有路径** —— 见 {@link judgeHostDataWrites}：判据落在**路径前缀**上
 *   （`profiles` / `sessions` / `storages` / `logs` / `cache` / `attachments` / `backups`
 *   + `.credentials.yaml` / `.salt` / `.anonymous-user-id` / `settings.yaml`），
 *   或写入目标取自宿主家目录（`DSH_HOME` / `dshHome`）。**读**这些路径是诊断半边的本职，
 *   不在禁止面里（判据只绑在写 API 的实参上）。
 *
 * **已知未覆盖**（明确列出来，不静默排除）：`node:fs` 之外的写入通道，例如
 * `process.binding`、原生 addon、`require()`（本仓是纯 ESM）、把 `fs` 方法先赋给
 * 别的变量再调用（`const w = writeFileSync`）、经 `ctx.subprocess` / `ctx.shell` 发起的
 * 写命令、以及用 shell 重定向写文件（`cmd /c … > file`）。这些在本仓不出现；
 * 真出现时靠人看出来，或把判据扩成 AST 级。
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

/**
 * 宿主自有路径的**一级前缀** —— 写进这些地方就是改宿主状态（B10 禁止）。
 *
 * 表取自**真机 `$DSH_HOME` 的一级目录/文件**（2026-10-14 实读本机 `~/.dsh`）：
 * `attachments` / `backups` / `cache` / `integrations` / `logs` / `mcp` / `profiles` /
 * `sessions` / `storages` + `.credentials.yaml` / `.salt` / `.anonymous-user-id` / `settings.yaml`。
 *
 * **逐条前缀、不用通配**（硬要求）：写成通配（`any-dir/logs/any-file` 那种）会**漏掉**
 * `profiles/<p>/logs` —— 前缀里那一层会被通配吃掉，而 `logs` 恰恰是最该禁的目录之一。
 * 判据是「路径片段里出现这一段」，所以 `join(home, 'profiles', p)` 与
 * `home + '/logs/x'` 两种写法都命中，而 `'logs'` 作为普通词出现在别的语境里
 * （例如变量名 `logStartup`）不会 —— 判据只认**路径分隔符构成的那一段**
 * （见 {@link hasHostDataPathSegment}）。
 *
 * ## 它现在只管**没有** `$DSH_HOME` 参与的那一类写
 *
 * `$DSH_HOME` 参与的写走**白名单**判据（见 {@link firstSegmentAfterHome} 与
 * {@link judgeHostDataWrites}）：只有「**紧跟 home 的第一个路径段逐字等于本包名**」才放过。
 * 两条通道合起来的语义：**写宿主目录 ⇒ 红，除非写的是本包自己那一层**。
 */
const HOST_DATA_PATH_SEGMENTS = [
  'profiles',
  'sessions',
  'storages',
  'logs',
  'cache',
  'attachments',
  'backups',
  'integrations',
  'mcp',
  'settings.yaml',
  '.credentials.yaml',
  '.salt',
  '.anonymous-user-id',
] as const

/** 取值为「宿主家目录」的表达式：一旦它出现在**写** API 的实参里，就进入白名单判定。 */
const HOST_HOME_EXPRESSION = /\bDSH_HOME\b|\bdshHome\b|process\.env\.DSH_HOME/

/**
 * 本包的包名 —— **从 `package.json` 读，不手抄**（本仓规矩：不抄会漂的值）。
 *
 * 白名单就是「`$DSH_HOME/<这个串>/`」这一层。包名改了就自动跟着改。
 */
const OWN_PACKAGE_NAME = packageJson.name ?? ''

/**
 * 取出「跟在宿主家目录表达式**某一次出现**之后的第一个路径段」——**只在它是字面量时**给得出值。
 *
 * 认得的写法（都是本仓会出现的形态）：
 * - `join(dshHome, 'seg', …)` —— 逗号之后的第一个实参；
 * - `join(process.env.DSH_HOME ?? '', 'seg', …)` —— 先跨过 `?? ''` 这个兜底；
 * - `` `${dshHome}/seg/…` `` —— 插值之后的第一个段（`}` 是桥）；
 * - `dshHome + '/seg/…'` —— `+` 之后的第一个段。
 *
 * **取不出来就返回 `undefined`**（= 不知道），调用方据此**保守判红**：
 * 首段是变量（`join(dshHome, name, …)`）时判据验不了它是不是包名 —— 这是放宽的
 * **已知限度**（记在文末正典表），不是漏写。
 *
 * 取段时**要求前面有引号 / 分隔符 / `}` 之类的桥**：同一行里 `dshHome` 还可能出现在
 * **类型标注**（`function f(dshHome: string)`）或解构里，那时它后面跟的是 `:` 而不是路径 ——
 * 不要求桥的话会把 `:` 当成段名（实测踩到：接线断言里那个一行的 fixture 因此被误判成红）。
 *
 * @param line 一行源码（已 stripComments）。
 * @param from 从哪个下标开始看（= 家目录表达式那一次匹配的**结尾**）。
 */
function segmentAfter(line: string, from: number): string | undefined {
  let rest = line.slice(from)
  // 桥：`??` 的兜底、空串兜底、`)`、`,`、`+`、`-`、`}`、空白。**不跨过任何标识符。**
  for (;;) {
    const before = rest
    rest = rest.replace(/^\s*(?:\?\?\s*(?:''|""|``)\s*)?[)\s,+-]*\s*/u, '')
    rest = rest.replace(/^\s*\}/u, '')
    if (rest === before) break
  }
  // 现在应当直接是「引号 / 分隔符 / 可选引号 + 段名」。
  // 引号要在这一步吃掉：`join(dshHome, 'seg')` 里 `'seg'` 是从引号开始的，
  // 不吃掉的话取出来是 undefined（= 验不了 ⇒ 保守判红），正例会被误杀。
  const segment = /^(?:['"`]|[/\\]|\})\s*[/\\]?([^/\\'"`\s),}:]+)/u.exec(rest)
  if (segment?.[1] === undefined) return undefined
  return segment[1]
}

/**
 * 判一行里的**每一次**家目录出现，汇总成三值结论。
 *
 * 为什么要看**每一次**而不是第一次：同一行常见「签名 + 调用」并存
 * （`function f(dshHome: string) { mkdirSync(join(dshHome, '…', 'x')) }`），
 * 只看第一次会把类型标注那处当目标。所以逐次取段，再按**安全优先**汇总：
 *
 * - 只要有一次取出了**不等于包名**的确定段 ⇒ `other`（红）—— 确定的可疑段**压过**白名单；
 * - 否则只要有一次取出的是包名 ⇒ `in-namespace`（绿）；
 * - 一次都取不出确定段（首段是变量 / 写法认不出）⇒ `unknown`（**保守判红**）。
 *
 * @param line 一行源码（已 stripComments）。
 */
function classifyHomeWrite(line: string): 'in-namespace' | 'other' | 'unknown' {
  if (OWN_PACKAGE_NAME === '') return 'other'
  const pattern = new RegExp(HOST_HOME_EXPRESSION.source, 'gu')
  let sawOwn = false
  let sawOther = false
  for (const match of line.matchAll(pattern)) {
    const segment = segmentAfter(line, match.index + match[0].length)
    if (segment === undefined) continue
    if (segment === OWN_PACKAGE_NAME) sawOwn = true
    else sawOther = true
  }
  if (sawOther) return 'other'
  return sawOwn ? 'in-namespace' : 'unknown'
}

/**
 * 一段文本里有没有「宿主自有路径」。
 *
 * 判据 = **被路径分隔符包住的**那一段（`'/logs/'`、`'\\logs\\'`、引号紧邻的 `` `logs/` ``、
 * `join(home, 'logs')` 里的 `'logs'`）—— 而不是「文本里出现过 logs 这个词」。
 * 两道都要过：`segment` 命中**且**该行还有路径味道（分隔符 / `join(` / 反引号路径）。
 *
 * @param line 一行源码（已 stripComments）。
 */
function hasHostDataPathSegment(line: string): boolean {
  return HOST_DATA_PATH_SEGMENTS.some((segment) => {
    const escaped = segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // ① 前后有分隔符：`/logs/`、`\\logs\\`、`'logs/'`、`"logs"` 收尾于 `join(…)`
    const withSeparator = new RegExp(
      `[/\\\\]${escaped}[/\\\\]|['"\`]${escaped}['"\`]|[/\\\\]${escaped}['"\`]|['"\`]${escaped}[/\\\\]`,
    )
    if (withSeparator.test(line)) return true
    // ② `join(home, 'logs')` 这类：`join(` 在**同一行**、且该段是引号包着的独立实参
    const asJoinArg = new RegExp(`\\b(?:join|resolve)\\([^)]*['"\`]${escaped}['"\`]`)
    return asJoinArg.test(line)
  })
}

/**
 * **宿主数据写入**的判定（B10）—— 「不许写 `$DSH_HOME`」的机械判据。
 *
 * ## 只绑在**写** API 的实参上
 *
 * 诊断半边**合法地读**这些路径（`lib/profile.ts` 的 `credentialsPath`、
 * `listStartupLogs`、`readProfileManifest` 全在读宿主目录），所以判据不能是
 * 「源码里出现 `DSH_HOME` 就红」（那是 B15 的做法，只在写侧两个文件的窄作用域上才安全）。
 *
 * ## 两条通道，语义合起来是一句话
 *
 * 1. **写动作的实参里出现宿主家目录表达式** ⇒ 走**白名单**：首段逐字等于本包名才放过
 *    （`$DSH_HOME/<包名>/…`，该层以下随便分）；其余一律红 —— 包括 `$DSH_HOME` 本身、
 *    `$DSH_HOME/<别的任何顶层项>`、以及首段是变量（验不了，保守判红）。
 * 2. **没有家目录表达式、但写动作指向宿主数据前缀**（`.../logs/...` 这类）⇒ 照旧红。
 *
 * 通道 1 的放宽是维护者 2026-10-14 拍板的**精确命名空间**（形态 A）：只放过本包自己那一层，
 * **同前缀兄弟**（`<包名>-logs`）不放过 —— 那正是它与「前缀族白名单」（形态 B）的分界。
 *
 * @param sources 源码（相对路径 + 内容）。
 * @returns 违规清单（`路径:行号 → 说明`）。
 */
function judgeHostDataWrites(sources: readonly { path: string; text: string }[]): string[] {
  const offenders: string[] = []
  for (const { path, text } of sources) {
    const lines = stripComments(text).split('\n')
    lines.forEach((line, index) => {
      const at = `${path}:${index + 1}`
      // 写类 API 的调用行：`writeFile(…)` / `fs.writeFileSync(…)` / `mkdir(…)` …
      // 用**通用**形态（不依赖 import 来源）：这里判的是「这一行有写动作」，
      // 来源判定由 `judgeFsWriteUsage` 负责，两者互补。
      const writes = WRITE_CALL_NAMES.some((api) => new RegExp(`\\b${api}\\s*\\(`).test(line))
      const shellWrites = SHELL_WRITE_SHAPES.some((shape) => shape.test(line))
      if (!writes && !shellWrites) return
      if (HOST_HOME_EXPRESSION.test(line)) {
        const verdict = classifyHomeWrite(line)
        if (verdict !== 'in-namespace') {
          const why =
            verdict === 'unknown'
              ? '首段取不出来（可能是个变量）—— 判不了就保守判红'
              : `首段不等于本包名 ${OWN_PACKAGE_NAME}`
          offenders.push(`${at} → 写动作指向 $DSH_HOME，但不在本包命名空间内（${why}）`)
        }
        return
      }
      if (hasHostDataPathSegment(line)) {
        offenders.push(`${at} → 写动作指向宿主数据路径（${line.trim()}）`)
      }
    })
  }
  return offenders
}

/** 写类 API 的名字（判「这一行有写动作」；来源是否来自 `node:fs` 由另一条判据管）。 */
const WRITE_CALL_NAMES = [
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
  'rm',
  'rmSync',
  'rmdir',
  'rmdirSync',
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
] as const

/**
 * 经 shell 写文件的形态（重定向 / `Set-Content` / `Out-File` / `New-Item`）。
 *
 * 为什么要有它：本仓的 `.ps1` 与 `execSync` 都是一等公民，而「用 shell 重定向写进
 * `$DSH_HOME`」绕过了所有 fs API 判据。这是**已知未覆盖**里最容易真发生的一种，
 * 所以顺手堵上（只认能看出写方向的形态，不做通用 shell 解析）。
 */
const SHELL_WRITE_SHAPES: readonly RegExp[] = [
  />>?\s*['"`]?[^|]*[/\\]/,
  /\bSet-Content\b/,
  /\bOut-File\b/,
  /\bNew-Item\b/,
]

/**
 * B10 的**扫描面**（唯一出处）：整个 `src/**`，**不许在调用处再收窄**。
 *
 * 为什么把它抽成函数而不是各处直接 `readSourcesUnder('src')`：注释里那句作用域声明
 * （「不是只有诊断半边」）必须有个**可判的落点**。抽出来之后，判据可以断言
 * 「这个扫描面就是全量 `src/**`」—— 收窄它就会红。
 * 残余限度如实记在文末「已知限度」里：在**调用处**临时加 `.filter()` 是任何
 * 同一文件内的判据都防不住的（红线自己也在那个文件里）。
 */
function readOnlyScope(): Array<{ path: string; text: string }> {
  return readSourcesUnder('src')
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
  return [...offenders, ...judgeFsWriteUsage(sources), ...judgeHostDataWrites(sources)]
}

describe('B10 只读半边：不含杀进程 / 写文件 / 写宿主数据目录 / 走安装面的动作', () => {
  it('真实源码里没有杀进程 / 写文件 / 写宿主数据目录 / 碰安装面的动作', () => {
    const sources = readOnlyScope()
    // 非空自证：真的扫到了源码（0 个文件时这条会假绿）。
    expect(sources.length, 'src/** 下没扫到 TS 源码 —— 判据没跑到').toBeGreaterThan(5)

    const offenders = judgeReadOnly(sources)
    expect(offenders, describeOffenders('只读半边被破坏', offenders)).toEqual([])
  })

  it('B10 的作用域是整个 src/**（收窄它 = 削弱保护面）', () => {
    // 这条不是「测实现」，是把**注释里那句作用域声明**钉住：块注释 2026-10-14 之前
    // 写的是「它管的是诊断半边」，而实现扫的是全部 `src/**` —— 两者矛盾。
    // 选定的方向是**保留宽作用域**（收窄会漏掉 B10 独有的安装面规则，B15 不管那一条），
    // 所以这里断言：扫描面就是全量 `src/**`（按文件数比，写法无关），
    // 写侧文件也在里面，而且同一个 `judgeReadOnly` 对写侧文件里的安装面动作也判红。
    const scanned = readOnlyScope()
    const everything = readSourcesUnder('src')
    expect(
      scanned.length,
      `B10 的扫描面被收窄了：只扫了 ${String(scanned.length)} 个文件，src/** 有 ${String(everything.length)} 个`,
    ).toBe(everything.length)

    const paths = scanned.map((source) => source.path)
    for (const writeSide of ['src/tools/dsh_hot_reload.ts', 'src/lib/hot-reload.ts']) {
      expect(paths, `${writeSide} 不在 B10 的扫描面里 —— 作用域被收窄了`).toContain(writeSide)
    }
    // 而且**同一个 `judgeReadOnly`** 对写侧文件也要能判红（安装面规则是 B10 独有的）。
    const syntheticWriteSide = [
      { path: 'src/tools/dsh_hot_reload.ts', text: "execSync('dsh plugin add ' + pkg)" },
    ]
    expect(
      judgeReadOnly(syntheticWriteSide),
      '写侧文件里的安装面动作没被 B10 照出来 —— 作用域声明与实现又对不上了',
    ).not.toEqual([])
  })

  it('判据可被否证：写进宿主数据目录的各种形态都必须红（B10 路径判据）', () => {
    const forms: Array<[string, string]> = [
      [
        "import { writeFile } from 'node:fs/promises'\nwriteFile(join(home, 'profiles', p), 'x')",
        'profiles',
      ],
      ['writeFileSync(`${dshHome}/logs/out.log`, x)', 'dshHome + /logs/'],
      ["fs.mkdirSync(home + '/sessions/abc', { recursive: true })", 'sessions'],
      [
        "writeFile(path.join(process.env.DSH_HOME, 'storages', 'a.json'), x)",
        'env.DSH_HOME + storages',
      ],
      ["writeFileSync(join(dshHome, '.credentials.yaml'), y)", 'credentials'],
      ["writeFileSync(home + '/cache/x', y)", 'cache'],
      ["writeFileSync(home + '/attachments/v1/x', y)", 'attachments'],
      ["writeFileSync(join(dshHome, 'backups', 'b'), y)", 'backups'],
      ["writeFileSync(home + '/integrations/x', y)", 'integrations'],
      ["writeFileSync(join(dshHome, 'settings.yaml'), y)", 'settings.yaml'],
      // shell 重定向写宿主目录（本仓 .ps1 与 execSync 都是一等公民）
      ["execSync('echo x > $DSH_HOME/logs/out.log')", 'shell 重定向'],
    ]
    for (const [source, label] of forms) {
      expect(
        judgeHostDataWrites([{ path: 'synthetic.ts', text: source }]),
        `${label} 漏了 —— 写宿主数据目录没被照出来`,
      ).not.toEqual([])
    }
  })

  it('新判据真的**接进了** B10（只写一个判据、不接线的话，上面那些否证用例全在空转）', () => {
    // 实测踩过（本任务自己的变异）：把 `judgeHostDataWrites` 从 `judgeReadOnly` 的返回里摘掉，
    // 上面那些「否证用例」**照样全绿** —— 因为它们直接调判据函数，不经过 B10。
    // 于是「判据立起来了」是假的：真实源码扫描里那条根本没跑。
    // 这条断言专治那种空转：拿一段**合成源码走完整入口**，必须报出来。
    const violation = "writeFileSync(join(dshHome, 'sessions', 'x'), y)"
    expect(
      judgeReadOnly([{ path: 'src/tools/synthetic.ts', text: violation }]),
      '路径判据没接进 B10 的返回 —— 真实扫描对它完全瞎（假绿）',
    ).not.toEqual([])
    // 反向：合法源码走同一个入口，必须一条都不报（否则这条判据是恒真的）。
    expect(
      judgeReadOnly([
        {
          path: 'src/tools/synthetic.ts',
          text: "export function f(home: string) { return readFileSync(join(home, 'profiles', 'web'), 'utf8') }",
        },
      ]),
      '只读的宿主目录访问被 B10 误报了',
    ).toEqual([])
    // **白名单的正例也必须走完整入口**：放宽若只落在一个没人调用的函数里，
    // 「本包命名空间可写」就是假的 —— 真实扫描会把它判红（写侧一落地就红）。
    expect(
      judgeReadOnly([
        {
          path: 'src/tools/synthetic.ts',
          text: `export function f(dshHome: string) { writeFileSync(join(dshHome, '${OWN_PACKAGE_NAME}', 'restart', 'marker.json'), 'x') }`,
        },
      ]),
      '本包命名空间的写走完整入口时被判红了 —— 白名单没接进 B10',
    ).toEqual([])
  })

  it('白名单判据（拍板形态 A）：只有**紧跟 home 的第一段逐字等于包名**才放过', () => {
    // 包名从 `package.json` 读（不手抄）。自证它真的读到了 —— 读成空串会让**每一条**
    // 写 home 的动作都判红，于是下面那些「正例必须绿」全部变成恒真的反例。
    expect(OWN_PACKAGE_NAME, 'package.json 没有 name —— 白名单判据会全红').not.toBe('')
    // 自证包名形状（与 B9 的 kebab 断言同族）：它会被拼进路径，形状不对说明读错了字段。
    expect(OWN_PACKAGE_NAME).toMatch(/^[a-z0-9][a-z0-9-]*$/)
    const own = OWN_PACKAGE_NAME

    // ① **正例**：本包命名空间内 —— 首段逐字等于包名，**该层以下随便分** ⇒ 必须绿。
    const inside = [
      `writeFileSync(join(dshHome, '${own}', 'restart', 'marker.json'), y)`,
      `writeFileSync(join(dshHome, '${own}', 'restart', 'nested', 'marker.json'), y)`,
      `mkdirSync(join(dshHome, '${own}', 'logs'), { recursive: true })`,
      `writeFileSync(\`\${dshHome}/${own}/cookie/x\`, y)`,
      `writeFileSync(dshHome + '/${own}/x', y)`,
      `writeFileSync(join(process.env.DSH_HOME ?? '', '${own}', 'restart', 'm'), y)`,
      // ⚠️ 白名单内的 `logs` 是被放过的 —— 与 `$DSH_HOME/logs`（禁止）**不是同一个东西**：
      // 只看紧跟 home 的那一段，不看整行里出现过什么词。
      `writeFileSync(join(dshHome, '${own}', 'logs', 'x'), y)`,
      // 同一行里 `dshHome` 先出现在**类型标注**里、路径在后 —— 判据逐次取段，不被标注带偏。
      `function f(dshHome: string): void { mkdirSync(join(dshHome, '${own}', 'restart'), { recursive: true }) }`,
    ]
    for (const source of inside) {
      expect(
        judgeHostDataWrites([{ path: 'synthetic.ts', text: source }]),
        `本包命名空间内的写被误报：${source}`,
      ).toEqual([])
    }

    // ② **反例**：包名在**第二位**不算 —— 「行里出现了包名」不等于「包名是第一段」。
    expect(
      judgeHostDataWrites([
        { path: 'synthetic.ts', text: `writeFileSync(join(dshHome, 'profiles', '${own}'), y)` },
      ]),
      '包名在第二位被当成白名单了（这正是写成子串包含的错法）',
    ).not.toEqual([])

    // ③ **反例**：同前缀兄弟（`<包名>-logs`）不是逐字相等 ⇒ 红。**这条正是形态 A 与 B 的分界**。
    expect(
      judgeHostDataWrites([
        { path: 'synthetic.ts', text: `writeFileSync(join(dshHome, '${own}-logs', 'x'), y)` },
      ]),
      '同前缀兄弟被放过了 —— 那是形态 B（前缀族），不是拍板的形态 A',
    ).not.toEqual([])
    expect(
      judgeHostDataWrites([
        { path: 'synthetic.ts', text: `writeFileSync(join(dshHome, '${own}.tmp', 'x'), y)` },
      ]),
    ).not.toEqual([])

    // ④ **反例**：写 `$DSH_HOME` 本身（没有下一段）⇒ 红。
    expect(
      judgeHostDataWrites([
        { path: 'synthetic.ts', text: 'mkdirSync(dshHome, { recursive: true })' },
      ]),
      '写 $DSH_HOME 本身被放过了',
    ).not.toEqual([])

    // ⑤ **反例**：首段是**别的**顶层项 ⇒ 红（每一种都要照得出来，靠 home 通道而不是靠前缀表）。
    for (const segment of ['profiles', 'sessions', 'storages', 'logs', 'cache', 'attachments']) {
      expect(
        judgeHostDataWrites([
          { path: 'synthetic.ts', text: `writeFileSync(join(dshHome, '${segment}', 'x'), y)` },
        ]),
        `写 $DSH_HOME/${segment} 没被照出来`,
      ).not.toEqual([])
    }

    // ⑥ **保守判红**：首段是变量 ⇒ 判据说它「验不了」，**不许**当成合法放过（本次的已知限度）。
    expect(
      judgeHostDataWrites([
        { path: 'synthetic.ts', text: "writeFileSync(join(dshHome, name, 'x'), y)" },
      ]),
      '首段是变量却放过了 —— 判据只能保守判红',
    ).not.toEqual([])
  })

  it('路径前缀表非空自证：单条前缀被删 = 那一族**静默失守**（判据只看表）', () => {
    // 为什么必须有这一条：`HOST_DATA_PATH_SEGMENTS` 是**手抄的一份表**，判据完全依赖它。
    // 删掉表里一行（例如 `logs`），真实扫描照样全绿 —— 而那一族就再没人管了。
    //
    // ⚠️ 第一版这条写错了：它**遍历被保护的表本身**造样本，于是删掉一行时
    // 「样本」也一起消失 ⇒ 恒绿（自指的假绿，和「断言自己写自己」同一族）。
    // 现在用**独立的一份副本**（下面这张字面量表）当样本来源：删表里的行 ⇒ 副本还在 ⇒ 红。
    //
    // ⚠️ 第二版（白名单落地后）改了样本形状：**不能再用 `join(dshHome, …)` 造样本** ——
    // 那条路现在走**白名单**通道，与「表里有没有这一行」无关（表被删它也照样红）。
    // 样本改成**没有 home 表达式**的写法（`home + '/logs/x'`），才真的在测这张表。
    const required = [
      'profiles',
      'sessions',
      'storages',
      'logs',
      'cache',
      'attachments',
      'backups',
      'integrations',
      'mcp',
      'settings.yaml',
      '.credentials.yaml',
      '.salt',
      '.anonymous-user-id',
    ]
    // 表与副本必须**逐条相同**（多一条少一条都红，逼人同批改两处）。
    expect([...HOST_DATA_PATH_SEGMENTS].sort()).toEqual([...required].sort())

    for (const segment of required) {
      // 两种写法各测一次：`home + '/seg/x'`（前缀表通道）与 `join(dshHome, 'seg', …)`
      // （白名单外的 home 通道）。**两条通道都要能照出这一族** —— 只测一条的话，
      // 另一条被拆掉时这条自证还是绿的。
      const viaConcat = `writeFileSync(home + '/${segment}/x', y)`
      const viaJoin = `writeFileSync(join(dshHome, '${segment}', 'x'), y)`
      for (const sample of [viaConcat, viaJoin]) {
        expect(
          judgeHostDataWrites([{ path: 'synthetic.ts', text: sample }]),
          `前缀 ${segment} 没被照出来（样本：${sample}）—— 表与判据脱节了`,
        ).not.toEqual([])
      }
    }
  })

  it('路径判据不误报：**读**宿主目录、以及与本仓无关的写，都必须放过', () => {
    // ① 读宿主目录是诊断半边的本职（本仓 `lib/profile.ts` 全在读）——**白名单内外都不报**。
    const reads = [
      "import { readFile } from 'node:fs/promises'\nreadFile(credentialsPath(dshHome), 'utf8')",
      "readFileSync(join(dshHome, 'profiles', p, 'package.json'), 'utf8')",
      "await readdir(join(dshHome, 'logs'))",
      // 白名单内也是读 ⇒ 同样不许报（判据只绑写动作）。
      `readFileSync(join(dshHome, '${OWN_PACKAGE_NAME}', 'restart', 'marker.json'), 'utf8')`,
    ]
    for (const source of reads) {
      expect(
        judgeHostDataWrites([{ path: 'synthetic.ts', text: source }]),
        `读被误报了：${source}`,
      ).toEqual([])
    }
    // ② 写**别处**（本仓将来真会有的写侧动作）不该被路径判据误伤。
    const otherWrites = [
      "writeFileSync(join(tmpdir(), 'x.log'), y)",
      "writeFileSync('/tmp/scratch/out.json', y)",
      "writeFile(join(repoRoot, '.local', 'notes.md'), y)",
    ]
    for (const source of otherWrites) {
      expect(
        judgeHostDataWrites([{ path: 'synthetic.ts', text: source }]),
        `误报了本仓自己的写入：${source}`,
      ).toEqual([])
    }
    // ③ 反面对照：把 ② 的路径换成宿主数据目录 ⇒ 必须报（证明上面两条不是恒真）。
    expect(
      judgeHostDataWrites([
        { path: 'synthetic.ts', text: "writeFileSync(join(dshHome, 'cache', 'x'), y)" },
      ]),
    ).not.toEqual([])
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
 * B12b 判据：`SKILL.md` 里的「干预」一节**存在，且不是占位标题**。
 *
 * **为什么值得一条红线**：SKILL 正文已解冻（不再逐字冻结在 v2.1.4），
 * 而**现有 B12 照不到这件事** —— 它只查 frontmatter 合规与正文长度，
 * 「解冻了却没写」在它那里**看不出来**（正文只会变长，`>500` 照样成立）。
 * 于是有一个真实且静默的缺口：写侧 `dsh_hot_reload` 与派生 `dsh_sign_cookie` **实现了、
 * 却没进正文** —— 而模型读不到正文就等于没有这两个工具，于是它会去调一个不存在的东西、
 * 或者退回重启那条更贵的路。
 *
 * **钉的是「这一节在、有实质内容」，不是「内容不许变」**：
 * 正文会跟着插件一起演化，所以本判据**只认三件事** —— 标题在、正文不是占位、
 * 写侧与派生两个工具都被提到。任何**逐字比对**都不写在这里：
 * 那是解冻之前的东西，写回来等于把刚解开的冻又结上（SHAPE §9 / §10 的 B12 修订注）。
 *
 * 纯函数 + 断言两层：判定吃 Markdown 文本、返回违规清单，于是**反例在内存里造**
 * （删掉那一节 / 只留占位标题 / 只写一半），不必去动真文件。
 */

/**
 * 该节标题里必须出现的那个词。取前缀匹配，所以标题改措辞不必同批改判据。
 *
 * ⚠️ **2026-10-15：`SKILL.md` 正文改成全英文**（模型可见文本按本仓规矩一律英文），
 * 标题从「干预 —— 判断之后的动作」变成 `Acting on the verdict`，这个词随之改成 `Acting`。
 * 它现在是一个**英文词**，所以下面的正则要带 `i` 之外的显式大小写。
 */
const INTERVENTION_HEADING_WORD = 'Acting'

/** 该节正文的字符数下界（占位标题只有十来个字；真的一节是若干条结论）。 */
const INTERVENTION_MIN_BODY_CHARS = 200

/**
 * 该节必须提到的工具：写侧 / 派生 / 行动各一个。
 *
 * 写成字面量而不是从 `EXPECTED_TOOLS` 里筛：筛出来的那份会随闭集变化而自动变短 ——
 * 工具被移除时判据跟着一起失效，于是「该节不再覆盖写侧」会静默通过。
 * 这里要的是「删掉工具就有人来看」的方向，所以它是一个**必须同批维护**的点。
 *
 * ⚠️ **三处同批维护**：增删工具、改 `SKILL.md` 那一节的标题措辞、改这里的清单 ——
 * 三者互不知道，漏改任何一个都会让本条变成空转或假红。
 * —— 2026-10-15 补 `dsh_restart`：那节现在覆盖三个工具，清单当时只列了两个（重启类当时还不存在，
 * 注释里写着「有意不预设」）；它落地之后，不列就是**漏**。
 */
const INTERVENTION_REQUIRED_TOOLS = ['dsh_hot_reload', 'dsh_sign_cookie', 'dsh_restart'] as const

/** 该节至少要有这么多条要点（拆成列表的那几条 `-`），否则「有内容」判据太松。 */
const INTERVENTION_MIN_BULLETS = 4

/**
 * 切出「干预」这一节的正文。
 *
 * 只认**标题行**（`#{1,6}` 开头且含那个词），到**下一个同级或更高级标题**为止。
 * 两条刻意的取舍：
 * - **不认正文里出现的那个词**：否则 §二、§五 里「见 §3.9」这种指针会被当成小节起点，
 *   切出来的「正文」只剩一行指针 —— 判据看着在跑，量的是指针。
 * - **切到同级标题为止**，不是切到下一个标题：子标题属于这一节，切早了会少算内容。
 *
 * @param markdown 整份 Markdown。
 * @returns 标题行（没找到时为空串）与正文（不含标题行）。
 */
function interventionSectionOf(markdown: string): { heading: string; body: string } {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const body: string[] = []
  let heading = ''
  let level = 0
  for (const line of lines) {
    const found = new RegExp(`^(#{1,6})\\s+.*${INTERVENTION_HEADING_WORD}`).exec(line)
    if (found?.[1] !== undefined) {
      heading = line
      level = found[1].length
      continue
    }
    if (heading === '') continue
    const next = /^(#{1,6})\s/.exec(line)
    if (next?.[1] !== undefined && next[1].length <= level) break
    body.push(line)
  }
  return { heading, body: body.join('\n') }
}

/**
 * B12b 的判定：返回违规清单（空 = 通过）。
 *
 * @param markdown 整份 `SKILL.md`。
 */
function judgeInterventionSection(markdown: string): string[] {
  const { heading, body } = interventionSectionOf(markdown)
  if (heading === '') {
    return [`没有以「${INTERVENTION_HEADING_WORD}」为标题的小节 —— 写侧与派生工具在正文里没有家`]
  }

  const text = body.trim()
  const offenders: string[] = []
  if (text.length < INTERVENTION_MIN_BODY_CHARS) {
    offenders.push(
      `「${INTERVENTION_HEADING_WORD}」一节的正文只有 ${text.length} 字符` +
        `（下界 ${INTERVENTION_MIN_BODY_CHARS}）：是占位标题，不是内容`,
    )
  }
  const bullets = text.split('\n').filter((line) => /^\s*[-*]\s+\S/.test(line))
  if (bullets.length < INTERVENTION_MIN_BULLETS) {
    offenders.push(
      `「${INTERVENTION_HEADING_WORD}」一节只有 ${bullets.length} 条要点` +
        `（下界 ${INTERVENTION_MIN_BULLETS}）：内容还没拆开写`,
    )
  }
  for (const tool of INTERVENTION_REQUIRED_TOOLS) {
    if (!new RegExp(`\\b${tool}\\b`).test(text)) {
      offenders.push(`「${INTERVENTION_HEADING_WORD}」一节没提到 ${tool} —— 该工具在正文里没有家`)
    }
  }
  return offenders
}

describe('B12b 技能正文的「干预」一节存在且非空（否则「解冻了却没写」是静默的）', () => {
  const SKILL_REL = 'skills/dsh-plugin-debugging/SKILL.md'

  it('提取器本身有效：找得到那一节、找不到也照实说', () => {
    const withSection = ['# T', '', '## Acting on the verdict', '', '- 一条', '- 两条', ''].join(
      '\n',
    )
    expect(interventionSectionOf(withSection).heading).toBe('## Acting on the verdict')
    // 正文里提到那个词不算数 —— 指针会被误当成小节起点，切出来只剩一行（见函数注释）。
    const withPointerOnly = [
      '# T',
      '',
      '先判断，再动手（见 Acting on the verdict）。',
      '',
      '## 别的一节',
    ].join('\n')
    expect(interventionSectionOf(withPointerOnly).heading).toBe('')
  })

  it('判据可被否证：删掉那一节 / 只留占位标题 / 只写一半，三种都会被照出来', () => {
    const full = [
      '---',
      'name: x',
      '---',
      '',
      '## Acting on the verdict',
      '',
      '**写侧 `dsh_hot_reload`**：换代码，不重启宿主。',
      '',
      '- 什么时候用：刚改完插件宿主端代码，进程不动。',
      '- 给目标的方式：`entryId` / `module` / `serverName` 恰好给一个。',
      '- 第一次先带 `dryRun: true` 预览。',
      '- 失败会放回旧版本，运行树被碰过没有会报出来。',
      '',
      '**派生 `dsh_sign_cookie`**：让脚本带上凭证。',
      '',
      '- 401 之后用它，让脚本与命令行客户端带上凭证。',
      '- cookie 值刻意不进返回值，报的是签成了、绑在哪个 authority。',
      '',
      '**行动 `dsh_restart`**：重启宿主并接回会话。',
      '',
      '- 判成 restart-required 时用它。',
      '- 四道闸门先过，再走审批门；不可逆。',
      '',
      '## 下一节',
    ].join('\n')

    // ① 完整的一份要过 —— 否则下面三条「会红」就毫无意义。
    expect(judgeInterventionSection(full)).toEqual([])

    // ② 整节删掉（解冻了却没写的那一种）。
    expect(
      judgeInterventionSection(full.replace(/## Acting on the verdict[\s\S]*?(?=## 下一节)/, '')),
    ).not.toEqual([])
    // ③ 只留标题 —— 这正是本条要挡的「占位标题看起来像写了」。
    const placeholder = '## Acting on the verdict\n\n待补。\n\n## 下一节\n'
    expect(judgeInterventionSection(placeholder)).not.toEqual([])
    // ④ 同一节的正文在，但只覆盖写侧与派生、漏了行动那个工具。
    expect(judgeInterventionSection(full.replace(/`dsh_restart`/g, '（不写了）'))).not.toEqual([])
    expect(judgeInterventionSection(full.replace(/`dsh_sign_cookie`/g, '（不写了）'))).not.toEqual(
      [],
    )
  })

  it('SKILL.md 里有这一节，写侧与派生两个工具都在里面', () => {
    const offenders = judgeInterventionSection(readRepo(SKILL_REL))
    expect(offenders, describeOffenders('「干预」一节的判据没过', offenders)).toEqual([])
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
    // `src/client/` 是**给人看的界面文案**，到不了模型 —— B14 守的是「模型可见字符串」，
    // 把 UI 文案也算进来就等于禁止界面本地化。维护者 2026-10-15 拍板：这张卡片跟随界面语言切换，
    // 所以 `zh` 字典是**该有的**，不是违规。
    // ⚠️ 别用「把中文藏进 .tsx 就绕过」那种写法 —— 那是钻判据的空子，不是解法。
    if (path.replace(/\\/g, '/').includes('src/client/')) continue
    for (const hit of collectCjkInStringLiterals(text)) {
      offenders.push(`${path}:${hit.line} → ${JSON.stringify(hit.literal)}`)
    }
  }
  return offenders
}

/**
 * B14b 判据：**技能正文**（`skills/<包名>/SKILL.md`）不含 CJK。
 *
 * 为什么不并进 B14：B14 的扫描面是 `src/**`，而技能正文住在 `skills/`。
 * 本仓规则写「可能到达模型眼里的字符串用英文」，**而技能正文正是模型逐字读的那一份** ——
 * 它却不在 B14 的面内。实测（2026-10-15）：正文全中文而全仓门禁全绿 ——
 * 也就是说「有人把它改回中文」这件事**没有任何东西会红**。
 *
 * ⚠️ **扫描面是那份具体的 `SKILL.md`，不是递归扫 `skills/`**：
 * - `skills/dsh-plugin-debugging/archive/` 下有一份**中文的历史存档** ——
 *   它是「当时长什么样」的证据，**必须**保持中文；
 * - `test/skills/fixtures/` 那几个夹具的正文也是中文，且它们故意是坏的。
 * 递归会把这两类一起判红，而那正是本条**不该**管的东西。
 */
describe('B14b 技能正文（模型可见）不含 CJK', () => {
  const SKILL_REL = 'skills/dsh-plugin-debugging/SKILL.md'
  const ARCHIVE_REL = 'skills/dsh-plugin-debugging/archive/2026-10-12-pure-text.md'

  it('随包分发的 SKILL.md 整份不含 CJK', () => {
    const text = readRepo(SKILL_REL)
    expect(text.length, 'SKILL.md 读空了 —— 判据没跑到').toBeGreaterThan(1000)

    const hits: string[] = []
    text.split('\n').forEach((line, index) => {
      if (CJK.test(line)) hits.push(`第 ${String(index + 1)} 行 → ${line.trim().slice(0, 60)}`)
    })
    expect(
      hits,
      describeOffenders('SKILL.md 里出现 CJK', hits) +
        '\n技能正文是模型逐字读的长文本，按本仓规矩一律英文。' +
        '它不是源码，没有「注释写中文」那条例外。',
    ).toEqual([])
  })

  it('扫描器非空转：中文一定报、纯英文一定不报；存档那份**必须仍是中文**', () => {
    // 自证：正则不是恒假 —— 否则上面那条对任何内容都会绿。
    expect(CJK.test('# 技能正文')).toBe(true)
    expect(CJK.test('## Acting on the verdict')).toBe(false)
    // 反向自证：存档是**历史证据**，它若被翻译成英文，「当时长什么样」就没了。
    expect(
      CJK.test(readRepo(ARCHIVE_REL)),
      '历史存档被改成英文了 —— 它存在的意义就是原样保留当时的中文版',
    ).toBe(true)
  })
})

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
  // ⚠️ 这条是**记号**判据（写侧连读都不许读宿主主目录），比 B10 的**路径**判据更严 ——
  // 两条都留着、不合并成一条，因为语义不同：
  // - 这里：写侧**碰都不许碰** `DSH_HOME`（连 `process.env.DSH_HOME` 读也不行）；
  // - B10：只禁止**写**宿主数据路径（诊断半边必须读那些目录，那是它的本职）。
  // 同一条路径判据（`judgeHostDataWrites`）两条红线共用，见 `judgeWriteSide` 的返回。
  { label: 'DSH_HOME（写侧不碰宿主主目录，读也不碰）', pattern: /\bDSH_HOME\b/ },
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
  // 写侧与 B10 **共用同一套** fs 写入 / 宿主数据路径判据（一处一事实：两条红线不许各写一份，
  // 各写一份必然漂 —— 漂出来的形状就是「一条红一条绿」）。
  return [...offenders, ...judgeFsWriteUsage(sources), ...judgeHostDataWrites(sources)]
}

/**
 * 写侧机制的**入口**（谁 import 它，谁就在改进程内树）。
 *
 * 用它把 `WRITE_SIDE_FILES` 那类**手抄清单**钉住：清单漏一个文件，写侧边界对那个文件
 * 就不生效，而失败是**静默**的（红线照样绿）。判据见下面「写侧文件清单不是手抄孤本」。
 */
const WRITE_SIDE_MECHANISM_IMPORT = /from\s+['"`][^'"`]*hot-reload\.js['"`]/

/**
 * 允许 import 写侧机制、但**自身不改树**的文件（注册点：它只把端口绑给工具）。
 *
 * 白名单必须**非空自证**（见用例）：这条判据靠它区分「注册点」与「新的写侧实现」。
 */
const WRITE_SIDE_NON_IMPLEMENTATIONS = ['src/tools/index.ts'] as const

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

  it('写侧文件清单不是手抄孤本：谁 import 写侧机制、谁就必须在清单里', () => {
    // `WRITE_SIDE_FILES` 是闭集，而「新写侧文件没加进来 ⇒ 边界对它不生效」是**静默**的
    // （红线照样绿）。所以判据不靠人记得改清单，而是从**机制入口**反推：
    // 凡 import 了写侧重载机制、且不当注册点的文件，都必须出现在清单里。
    const sources = readSourcesUnder('src')
    const importers = sources
      .filter((source) => WRITE_SIDE_MECHANISM_IMPORT.test(stripComments(source.text)))
      .map((source) => source.path)
      .filter((path) => !WRITE_SIDE_NON_IMPLEMENTATIONS.includes(path as never))

    // 下界：机制入口一个都找不到 ⇒ 判据空转（机制改名时会走到这里）。
    expect(
      importers.length,
      '没有任何文件 import 写侧机制 —— 入口正则失效了，这条判据在空转',
    ).toBeGreaterThan(0)

    const missing = importers.filter(
      (path) => !(WRITE_SIDE_FILES as readonly string[]).includes(path),
    )
    expect(
      missing,
      `这些文件 import 了写侧机制却不在 WRITE_SIDE_FILES 里：${missing.join(', ')}\n` +
        '写侧边界按清单限定作用域，漏一个 = 那个文件不被 B15 覆盖（静默假绿）。',
    ).toEqual([])

    // 白名单非空自证：注册点真的存在（否则上面那半条过滤是恒真的）。
    expect(
      WRITE_SIDE_NON_IMPLEMENTATIONS.filter((path) => existsRepo(path)).length,
      '注册点白名单里的文件都不在 —— 这条判据的过滤条件失效了',
    ).toBe(WRITE_SIDE_NON_IMPLEMENTATIONS.length)
  })

  it('真实写侧源码里没有 fs 写入 / 子进程 / 杀进程 / 写宿主数据路径', () => {
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

  it('判据可被否证：写进宿主数据路径的写侧代码必须红（与 B10 共用同一套判据）', () => {
    const phases: Array<[string, string]> = [
      ["writeFileSync(join(dshHome, 'logs', 'x'), y)", 'logs'],
      ["writeFile(join(process.env.DSH_HOME, 'profiles', p), y)", 'env.DSH_HOME'],
      ["mkdirSync(home + '/sessions/x')", 'sessions'],
      // 白名单**只**放过本包那一层：写侧往别处写照样红。
      [`writeFileSync(join(dshHome, '${OWN_PACKAGE_NAME}-logs', 'x'), y)`, '同前缀兄弟'],
    ]
    for (const [source, label] of phases) {
      expect(
        judgeWriteSide([{ path: 'src/lib/hot-reload.ts', text: source }]),
        `${label} 漏了 —— 写侧写宿主数据路径没被照出来`,
      ).not.toEqual([])
    }
    // 反向：写侧写**自己的命名空间**是唯一被放过的形态（白名单对 B15 同样生效）。
    expect(
      judgeWriteSide([
        {
          path: 'src/lib/hot-reload.ts',
          text: `writeFileSync(join(dshHome, '${OWN_PACKAGE_NAME}', 'restart', 'm.json'), y)`,
        },
      ]),
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
 * 认出截断行的**前缀**（§3.1 规则 3）。
 *
 * 两处用途，共用这一处定义：
 * - B16 必须排除它 —— **恒定模板**，两份 fixture 若都被截断、且还剩同样的条数，
 *   这一行就逐字相同 → **假红**（§10 B16 明写）；
 * - B27 用它取出截断行，再查**内容**（不许指向模型够不到的位置）。
 *
 * 用**前缀**而不是整行逐字：整行逐字在「截断行后面又被加了半句」时匹配不到，
 * 于是 B16 会把它当普通 L2 行（可能假红）、B27 会以为「没有截断行」—— 两种都走偏。
 * 逐字约束不该住在这里，见 B27。
 */
const RENDER_TRUNCATED_RE = /^\d+ more line\(s\) not shown/

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

// ── B27 截断行不许指向模型够不到的位置 ────────────────────────────────────

/**
 * B27 的禁词表：**这些位置模型读不到**，写进截断行就是「说了但兑现不了」。
 *
 * 为什么是「session log」这一族（而不是随便一条路径）：宿主 `appendToolResult` 只写
 * `{turn, step, message, error?, meta?}` —— **没有 `value`**（SHAPE §8.1 的 `[已核]`），
 * 而本仓八个工具里**没有任何一个**能读会话日志。⇒ 被截掉的行在会话日志里**根本不存在**，
 * 模型也没有途径去读。这句指引 2026-10-14 之前一直印着（两名互不知情的审查员独立指到同一处）。
 *
 * 表是**闭集**：将来若某条真有了可达的读入口，加进来之前先核「谁读得到、用什么工具读」；
 * 反之若要加新的不可达位置（例如把 `data` 说成「在进程内」），照这里加一条并写理由。
 */
const UNREACHABLE_POINTERS: readonly string[] = ['session log', 'session-log', 'sessionlog']

/**
 * B27 判据：截断行必须**明说并给总数**，且**不许**指向模型够不到的位置。
 *
 * 为什么必须是**语义**判据（而不是「截断行逐字相等」）：本仓各处的逐字断言
 * （`RENDER_TRUNCATED_RE`、各工具测试里的 `toContain(...)`）在**两处一起改**时照样绿 ——
 * 把假话换个说法加回来，一个都不会红。这正是本仓坑 37 的形状（**推断不算钉死，变异才算**）。
 * 这里钉的是**规则**：这一行里出现的「去哪找」必须真的可兑现。
 *
 * 下界（§10.0）：取不到截断行 ⇒ 判红，不许静默放行 —— 夹具没触发截断时，
 * 「不含禁词」是恒真的空转（本仓坑 18）。
 *
 * @param text 渲染文本（`renderToolResultText` 的输出）。
 */
function judgeTruncationPointers(text: string): string[] {
  const line = text.split('\n').find((item) => RENDER_TRUNCATED_RE.test(item))
  if (line === undefined) {
    return ['渲染文本里没有截断行 —— 判据在空转（夹具必须真的触发截断）']
  }
  const lower = line.toLowerCase()
  return UNREACHABLE_POINTERS.filter((pointer) => lower.includes(pointer)).map(
    (pointer) => `截断行指向模型够不到的位置「${pointer}」：${line}`,
  )
}

describe('B27 截断行不许指向模型够不到的位置', () => {
  /** 造一份**真的**会被截断的渲染文本（3 行 L2、上限 1）。 */
  function truncatedText(): string {
    const table: RenderTable<SyntheticKey> = {
      maxKeyLines: 1,
      key: () => ['first line', 'second line', 'third line'],
    }
    return renderToolResultText(
      'dsh_synth',
      okFixture('the change applies live', { home: 'h', mode: 'config', port: 3080 }),
      table,
    )
  }

  it('截断行明说并给总数，且不指向模型够不到的位置', () => {
    const text = truncatedText()
    // 下界自证：这一行**真的**存在、**真的**给了总数 —— 否则下面的「不含禁词」是空转。
    expect(text).toContain('2 more line(s) not shown')
    expect(judgeTruncationPointers(text)).toEqual([])
  })

  it('判据可被否证：旧的那半句逐字加回来 → 红；换个说法的同义句 → 也红', () => {
    const text = truncatedText()
    const withOldWording = text.replace(
      '2 more line(s) not shown',
      '2 more line(s) not shown — the full record is in the session log',
    )
    expect(withOldWording).not.toBe(text)
    expect(judgeTruncationPointers(withOldWording)).not.toEqual([])

    // 换说法：逐字断言放它过去，语义判据必须抓住 —— 这就是本条存在的理由。
    const reworded = text.replace(
      '2 more line(s) not shown',
      '2 more line(s) not shown; the rest is in the session-log',
    )
    expect(judgeTruncationPointers(reworded)).not.toEqual([])
  })

  it('下界本身可被否证：没有截断行 → 判红，不许当成「通过」', () => {
    const table: RenderTable<SyntheticKey> = { key: () => ['only one line'] }
    const text = renderToolResultText(
      'dsh_synth',
      okFixture('nothing was truncated here', { home: 'h', mode: 'config', port: 3080 }),
      table,
    )
    expect(judgeTruncationPointers(text)).not.toEqual([])
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
 * # 依赖五个工具全齐的红线：B17 / B20a / B20b / B18a / B21 / B24 / B25 / B26
 *
 * 这八条与前六条（B16 / B18b / B22）的分工：前六条只吃**合成 fixture**，任何工具都没落地也能跑；
 * 这八条要**真的把五个工具跑起来**（成功与失败各一条），因为它们的判据对象是
 * 「工具自己声明的描述与参数」「工具自己返回的 `data` 外形」「`execute` 在替身抛异常时的行为」
 * 「工具返回值能不能无损落 JSON」——
 * 用合成对象断言等于在测我自己的夹具，不是测工具（活跃坑 18 的假绿形状）。
 *
 * ## 一处语料，多条红线共用
 *
 * {@link redlineCorpus} 把五个工具各跑成功 / 失败两次，B17 / B18a / B20b / B21 / B26 全部读它。
 * **不各写一份夹具**：各写一份必然漂，而漂出来的形状是「红线绿但工具已经改了」。
 * （B26 在这 10 条之外**另有**一条自己带的夹具 —— 那 10 条的临时 `$DSH_HOME` 里没有
 * `logs/` 目录，于是启动日志那条路走不到；见 B26 那段注释。）
 *
 * ## 为什么夹具写在**本文件内部**而不 import `test/tools/helpers.ts`
 *
 * 本文件造的是**红线自己的语料夹具**（十个工具结果条目、临时 `$DSH_HOME`），与工具测试要的东西
 * 不同源，硬拉过去只会让两边的语料一起漂。所以留在文件内部 —— 这也是本文件一直以来的做法。
 *
 * ⚠️ **例外只有「通用助手」那几条**（剥注释、钉平台）：它们不是红线语料，各写一份就等于
 * 让判据的取数口随文件分叉。2026-10-15 已收敛到 `test/tools/helpers.ts`（AGENTS「技术债：
 * 收敛重复的测试助手」的收尾）—— 本文件从那里取，**不再自带副本**。
 */

// ── 运行期夹具 ────────────────────────────────────────────────────────────

/** 造配置。 */
function redlineConfig(dshHome: string, overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    dshHome,
    dshHomeSource: 'config',
    profile: 'web',
    port: 0,
    // 两个预算**引用唯一那处默认值**（`lib/timeouts.ts`）：红线夹具不该把数字抄一遍，
    // 否则默认值一改，这里就静默按旧值跑（判据滞后于实现）。
    timeoutMs: WORKLOAD_DEFAULT_BUDGET_MS.timeoutMs,
    schemaDumpTimeoutMs: WORKLOAD_DEFAULT_BUDGET_MS.schemaDumpTimeoutMs,
    // 总闸默认关 ⇒ `restartWith` 的两条 fixture 里有**一条**（dry-run 那条走不了闸门）
    // 必须显式打开；关着的话它会拿到「被配置禁用」的拒绝，而红线的下界要求
    // 每个工具**至少各一条成功与一条失败**。形态是活引用（`Volatile<boolean>`）。
    enableRestart: { get: () => true },
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

/**
 * 造一个 exec。
 *
 * ⚠️ **带一个 agent**：`dsh_restart` 的闸②要拿「调用方自己那个会话」把它从阻塞者里
 * 排除掉，而这个 id 只能从 `exec.agent` 取。夹具不给 agent 时那条路只能判失败 ——
 * 于是「成功」那一条 fixture 根本走不到，B21 的下界会（正确地）报「没有成功 fixture」。
 * 别的工具不读这个字段，所以带上它对它们零影响。
 */
function redlineExec(): ToolRunContext {
  return {
    signal: new AbortController().signal,
    agent: { id: 'session-redline', session: { id: 'session-redline' } },
  } as unknown as ToolRunContext
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

/**
 * `sign_cookie`：成功 = 真有一份带 browser-session 密钥的凭证文件；
 * 失败 = 文件在但没有那一条 grant。
 *
 * ⚠️ **夹具里的密钥是真造的 32 字节 base64url**（`randomBytes(32)`），不是常量 ——
 * 常量会让「它到底有没有真的签出东西」这件事在这个语料里不可判。
 * 它只活在临时目录里，跑完即删。
 *
 * @param kind 成功那条还是缺 grant 那条。
 */
function signCookieWith(kind: 'granted' | 'no-grant'): ToolDefinition {
  const home = makeTempRoot('dsh-redline-signcookie-')
  const secret = encodeBase64Url(randomBytes(32))
  const body =
    kind === 'granted'
      ? [
          'version: 1',
          'refs:',
          'records:',
          '  client-connection/browser-session:',
          '    kind: grant',
          '    payload:',
          '      version: 1',
          `      secret: ${secret}`,
          '',
        ].join('\n')
      : ['version: 1', 'refs:', 'records:', '  other-thing/other-id:', '    kind: grant', ''].join(
          '\n',
        )
  writeTextFile(join(home, '.credentials.yaml'), body)
  // 端口用配置里的（`env: {}` 保证不走 `DSH_WEB_URL`），这样夹具与平台无关。
  return createSignCookieTool(redlineDeps(redlineConfig(home, { port: 3080 }), { env: {} }))
}

/**
 * `list_instances`：**只给端口**，不去读 socket 表（`scan.status = 'skipped'`）——
 * 夹具因此与平台无关，也不必伪造 socket 表命令。探针替身按脚本回答。
 *
 * @param answer 探针的回答（状态码 + body）。
 */
function listInstancesWith(
  answer: () => Promise<{ status: number; body: string }>,
): ToolDefinition {
  const home = makeTempRoot('dsh-redline-listinstances-')
  const base = redlineDeps(redlineConfig(home, { port: 0 }))
  return createListInstancesTool({
    ...base,
    signatureFetch: async () => {
      const result = await answer()
      return { status: result.status, text: async () => result.body }
    },
  })
}

/**
 * `list_instances` 的**失败** fixture：socket 表读不出来，且**没给 `port`** ⇒
 * 连候选都形不成 ⇒ `not-configured`。
 *
 * 与平台无关：任何平台上那条命令拿到的都是一段**认不出的输出**（stdout 非空、stderr 空、
 * 一行都没认清）⇒ 每一条尝试都不可信 ⇒ `probed: false`。没有已知命令的平台更快走到同一结论。
 */
function listInstancesScanUnavailable(): ToolDefinition {
  const home = makeTempRoot('dsh-redline-listinstances-')
  const spawn: SpawnImpl = async () => ({
    code: 0,
    stdout: 'this is not a socket table\n',
    stderr: '',
    timedOut: false,
    aborted: false,
  })
  return createListInstancesTool(redlineDeps(redlineConfig(home), { spawn }))
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
 * `restart`：成功 = 闸门全过 + `dryRun`（演练，什么都不做）；失败 = **审批档读不出来**
 * （fail-closed 的那一格，也是本工具唯一的 `ok: false` 常路）。
 *
 * 两条 fixture 各用一份不同的临时 home（B16 规则 6：`resolved:` 这类行按**环境**恒定）。
 *
 * @param kind 走哪条路。
 */
function restartWith(kind: 'dry-run' | 'no-policy'): ToolDefinition {
  const home = makeTempRoot(`dsh-redline-restart-${kind}-`)
  const fs: RestartFsPort = {
    read: async () => ({ status: 'absent' }),
    write: async () => undefined,
  }
  const launch: LaunchCommand = {
    command: 'node',
    args: ['bin.js', '--profile', 'web'],
    cwd: 'C:/repo',
  }
  const ports: RestartPorts = {
    fs,
    restartHistory: async () => ({ known: true, value: [] }),
    busySessions: async () => ({ known: true, value: [] }),
    bundles: async () => ({ known: true, value: ['dsh-plugin-debugging'] }),
    launchCommand: async () => ({ known: true, value: launch }),
    now: () => Date.UTC(2026, 9, 14, 6, 0, 0),
  }
  const restart: RestartHost = {
    // 平台相关分支显式钉住（CI 是 ubuntu）—— 红线语料测的不是启动器形态。
    pathExists: () => true,
    ports,
    approval: {
      policyOf: () => (kind === 'no-policy' ? undefined : 'never'),
      request: async () => 'rejected',
    },
    launch: { relaunch: async () => ({ ok: true, detail: 'schtasks /run exited 0' }) },
    exit: { exit: () => () => undefined },
  }
  // ⚠️ **语料里必须显式给载体**：`ToolDeps.carrier` 的兜底是 `UNKNOWN_CARRIER`，而它在
  // 闸④上是**拒绝**（没有已实测的回归路线）—— 于是这两条 fixture 会从「闸门全过 + 演练」
  // 掉进「拒绝」，B16 / B20b / B22 那几条会以一种**看起来像文案问题**的方式变红。
  // 这里给 `cli × win32`：它是**唯一**有已实测路线的组合，也正是这两条 fixture 想演的那条路。
  return createRestartTool({
    ...redlineDeps(redlineConfig(home), { carrier: carrierOf('cli', 'win32') }),
    restart,
  })
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
    // B18a「死路」判据的**唯一语料**：端口三条来源都没有（port 0 + env 空）→ `not-configured`，
    // 且它是**确定性**拒绝（重调同一个不动点）。B18a 要靠这条把「带 tool + 空 args」判红；
    // 没有它那条判据就空转（活跃坑 18）。改回 `{ tool: CHECK_AUTH_TOOL }`（不给 args）
    // 必须让 B18a 红；本仓库已把它改成 `manual` 支（真机 2026-10-13）。
    await runFixture(
      createCheckAuthTool(
        redlineDeps(redlineConfig(makeTempRoot('dsh-redline-noport-'), { port: 0 }), { env: {} }),
      ),
      CHECK_AUTH_TOOL,
      'check_auth · 端口三条来源都没有（not-configured 确定性失败）',
      {},
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
    await runFixture(
      signCookieWith('granted'),
      SIGN_COOKIE_TOOL,
      'sign_cookie · 凭证文件里有 browser-session 密钥',
      { port: 3080, host: '127.0.0.1' },
    ),
    await runFixture(
      signCookieWith('no-grant'),
      SIGN_COOKIE_TOOL,
      'sign_cookie · 凭证文件里没有那一条 grant',
      { port: 3080, host: '127.0.0.1' },
    ),
    await runFixture(
      listInstancesWith(async () => ({ status: 401, body: DSH_UNAUTHORIZED_BODY })),
      LIST_INSTANCES_TOOL,
      'list_instances · 回环端口上认出了 DSH 签名',
      { port: 3080 },
    ),
    await runFixture(
      listInstancesScanUnavailable(),
      LIST_INSTANCES_TOOL,
      'list_instances · socket 表读不出来（没给 port ⇒ 连候选都形不成）',
      {},
    ),
    await runFixture(
      restartWith('dry-run'),
      RESTART_TOOL,
      'restart · 闸门全过 + dryRun（演练，零写零拉起）',
      { reason: 'the plugin code changed', dryRun: true },
    ),
    await runFixture(
      restartWith('no-policy'),
      RESTART_TOOL,
      'restart · 审批档读不出来（fail-closed）',
      { reason: 'the plugin code changed' },
    ),
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
  /** 工具定义（取 `description` / `parameters` / `output.render`）。 */
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

/** 取全部工具的形状（构造它们不需要真的 IO）。 */
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
    shapeOf(SIGN_COOKIE_TOOL, SIGN_COOKIE_DESCRIPTION, createSignCookieTool(deps)),
    // 发现工具：它的 HTTP 依赖多一个 body 读取，但构造它同样不需要真 IO
    // （默认 `signatureFetch` 只在这一行被引用，不在这里被调用）。
    shapeOf(LIST_INSTANCES_TOOL, LIST_INSTANCES_DESCRIPTION, createListInstancesTool(deps)),
    // 行动类工具：构造它同样不需要真 IO（端口都是惰性的）。
    shapeOf(RESTART_TOOL, RESTART_DESCRIPTION, restartWith('dry-run')),
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

// ── B20a 描述四段骨架 + 参数描述下界 ────────────────────────────────────

describe('B20a 描述四段骨架 + 参数描述下界', () => {
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

    // 一个工具都不能少 —— 否则「描述层合规」只在一个子集上成立。
    //
    // ⚠️ 这里比的是**闭集长度**而不是字面的 `5`：写死数字就得每加一个工具回来改这里，
    // 而漏改的那次会**静默放过**一个新工具（形状对不上但数量恰好还过）。
    // `toolShapes()` 与 `EXPECTED_TOOLS` 同一个闭集，加工具时由 B9 那条逼着改，
    // 不靠这里的手工同步。
    expect(shapes.length).toBe(EXPECTED_TOOLS.length)
    expect(shapes.map((shape) => shape.name).sort()).toEqual([...EXPECTED_TOOLS].sort())
    expect(offenders, `B20a 违规：\n${offenders.join('\n')}`).toEqual([])
    // 实测值随断言带出去：红了能一眼看出是哪一项顶到上限。
    expect(measured.length).toBe(shapes.length)
  })

  it('每个工具 defineTool 里的 description 真的来自 composeDescription（不是手写字符串）', () => {
    // ⚠️ 这一条照的是 B20a 上面那条的盲区：上面的判据全部作用于 `composeDescription`
    // 的**合成结果** —— 而 `defineTool` 的 `description:` 字段若被人绕开合成器
    // **手写**一段字符串，四段骨架 / 滤空段 / `\n` 连接就全部失守，上面那条**照样全绿**
    // （它从头到尾没读过 `tool.description`）。test/tools 的共享断言
    // `expectSynthesizedDescription` 只在逐工具测试里守这一格 —— 这里把同一不变量
    // 提到红线层，对**全部工具的闭集**判一次（下界：shapes 非空，见 §10.0）。
    const shapes = toolShapes()
    expect(shapes.length, '一个工具都没构造出来 —— 这条判据在空转').toBeGreaterThan(0)
    const offenders = shapes
      .filter((shape) => shape.tool.description !== shape.text)
      .map(
        (shape) =>
          `${shape.name}: defineTool 的 description 与 composeDescription(声明) 不一致 —— ` +
          `手写或改错了合成调用（声明合成结果 ${String(shape.text.length)} 字符，定义里 ${String(shape.tool.description.length)} 字符）`,
      )
    expect(offenders, `B20a（合成器一致）违规：\n${offenders.join('\n')}`).toEqual([])
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

/**
 * 「重试一次」**可能**得到不同结果的失败档（白名单）。
 *
 * 分界不是「args 空不空」，是**这次失败会不会自己变**：预算/传输层耗尽会随时间与负载变，
 * 确定性拒绝（缺端口来源、包解析不到）不会 —— 那带工具名重调就是**不动点**。
 * ⚠️ **新增 `kind` 时必须裁决它属哪一档**，否则 B18a 会静默放行或误红（SHAPE §4.1）。
 */
const NON_DETERMINISTIC_KINDS: ReadonlySet<string> = new Set(['timeout'])

/** 从工具原始返回值里取失败的 `kind`（成功或取不到时返回空串）。 */
function failureKindOf(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ''
  const error = (value as Record<string, unknown>)['error']
  if (typeof error !== 'object' || error === null) return ''
  const kind = (error as Record<string, unknown>)['kind']
  return typeof kind === 'string' ? kind : ''
}

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
      // 「带工具名 + 空参数」= **死路**判据（真机 2026-10-13 抓到的那一处）：
      // `{ tool: 'dsh_check_auth' }`（不给 args）在 `not-configured` 上，模型逐字重调 → **同一个不动点**。
      // **例外**：非确定性失败（`timeout` 这类预算耗尽）重试**可能**得到不同结果 → 合法。
      // 确定性拒绝（`not-configured` / `not-found` / `command-failed` / `internal` …）→ 非法。
      // ⚠️ 只在 args **为空**时判；args 非空的「去问一个更具体的问题」永远合法。
      // 「非确定性」读的是**失败 `kind`**（闭枚举），不靠人读 `why` 的语义。
      const argKeys =
        typeof record['args'] === 'object' &&
        record['args'] !== null &&
        !Array.isArray(record['args'])
          ? Object.keys(record['args'] as Record<string, unknown>)
          : []
      if (argKeys.length === 0 && !NON_DETERMINISTIC_KINDS.has(failureKindOf(run.value))) {
        offenders.push(
          `${run.label}: 带 tool 却给空 args —— 确定性失败上重调是**不动点**（死路）；` +
            '下一步是用户动作就该给 manual 支（不带 tool）',
        )
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
  /** 需要显式钉住的平台（见 `withPlatform`）。 */
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
        // ⚠️ `diagnose × spawn` 这一组**必须**钉 `win32`：`lib/ports.ts` 只在 Windows 上起子进程
        // 查监听端口，别的平台早返回 —— 不钉的话本机 Windows 绿、CI ubuntu 上 `spawn` 一次都没被调用，
        // 判据就在 CI 上空转（坑 25）。
        value =
          group.platform === undefined ? await invoke() : await withPlatform(group.platform, invoke)
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

// ── B25 守卫合成的兜底必须可渲染 ───────────────────────────────────────────

/**
 * 一个**形状非法**的候选返回值 —— 守卫必须把它换成自己合成的兜底。
 *
 * 为什么用「`data.verdict` 是空串」这一种：`toolResultProblem` 的判据里它最直接
 * （`"data.verdict" must be a non-empty string`），不必构造复杂对象就能确定**会**被换掉。
 * 换一种坏法（缺 `data` / `ok` 不是布尔）同样会被换掉，但判据只需要一条能自证的入口。
 */
const MALFORMED_CANDIDATE = { ok: true, data: { verdict: '', key: {}, audit: {} } }

/**
 * B25：**守卫合成的兜底必须可渲染**。
 *
 * ## 为什么这条值得单独存在（不是 B24 的重复）
 *
 * B24 管的是「`execute` 不抛」，判据落在**工具自己**的返回路径上。契约还有**最后一段**：
 * 工具自己返回了坏形状时，`ensureToolResult` 会合成一个兜底 —— 那个兜底里 `key` 是 `{}`。
 * 实测（2026-10-13 探针）：`dsh_check_auth` / `dsh_diagnose_plugin_load` / `dsh_dump_config`
 * 的 `keyText` 直接取 `key.resolved.*`，**喂 `{}` 当场抛** —— 于是「任何一次形状非法 →
 * 守卫兜底 → 渲染当场抛」，而 `render.ts` 的纪律是**渲染绝不抛**（§3.1）。
 * 这条路径的崩溃**永远发生在「本来就已经出错」的时刻**：那一刻模型最需要的是结构化的失败，
 * 而不是一句 `Cannot read properties of undefined`。
 *
 * ## 判据与下界
 *
 * 判据是**行为可判**的：拿守卫真合成的兜底，对五个工具各渲染一次，**不抛且走正常渲染路径**。
 * ⚠️ 下界（§10.0 + 活跃坑 37）：必须先自证那个值**真的是兜底** ——
 * ① 兜底 `!==` 输入（输入被换掉了）；② `ensureToolResult(兜底) === 兜底`（幂等 = 它自己过了守卫）；
 * ③ `兜底.data.key` 真的是 `{}`。少了这三条，「渲染一个正常值当然不抛」是**恒真**的。
 *
 * ⚠️ **空转判红、不许 skip**：五个工具一个都不能漏，按 `EXPECTED_TOOLS` 逐个点名。
 *
 * ## 这条**不**断言什么（写清楚，防下一个人误读）
 *
 * - **不断言「守卫必须生效」**：那是断言实现结构（脆）。这里断言的是「兜底可渲染」——
 *   它正是真实会崩的那条路，且行为可判。
 * - **不断言五个工具的降级措辞一致**：`effect_mode` / `hot_reload` 的 `keyText` 本来就是
 *   防御式的，兜底时一个印 `resolved: profile=unknown …`、一个干脆不印 L2 行 —— 两种都
 *   **不抛**。三个被修的工具印 `resolved: unknown (the guard synthesized this result)`，
 *   那句逐字断言住在**它们各自的测试**里（B25 只要求「不抛 + 走正常渲染路径」）。
 */
describe('B25 守卫合成的兜底必须可渲染', () => {
  it('五个工具各渲染一次兜底：不抛、走正常渲染路径、一个都不许漏', () => {
    const fallback = ensureToolResult(MALFORMED_CANDIDATE)

    // ── 下界：自证这**真的是**兜底（§10.0 + 活跃坑 37）────────────────────────
    expect(fallback, '守卫没换掉这个值 —— 下面渲染的不是兜底，判据会恒真').not.toBe(
      MALFORMED_CANDIDATE,
    )
    expect(ensureToolResult(fallback), '兜底自己没过守卫 —— 渲染的可能是个坏形状').toBe(fallback)
    expect((fallback as { ok: unknown }).ok, '兜底应当是结构化失败').toBe(false)
    const fallbackKey = (fallback as { data: { key: unknown } }).data.key
    expect(fallbackKey, '兜底的 key 不是 {} —— 夹具没打到守卫合成的那条路').toEqual({})

    const offenders: string[] = []
    const trace: string[] = []
    const shapes = toolShapes()

    // 空转判红：五个工具一个都不能漏（漏一个 = 漏一条真实会崩的路）。
    const expected = [...EXPECTED_TOOLS].sort()
    const actual = shapes.map((shape) => shape.name).sort()
    if (actual.join(',') !== expected.join(',')) {
      offenders.push(
        `夹具覆盖的工具是 ${actual.join(', ')}，期望闭集 ${expected.join(', ')} —— 这条红线在空转`,
      )
    }

    for (const shape of shapes) {
      let text: string | undefined
      let threw: string | undefined
      try {
        text = renderViaTool(shape.tool, {}, fallback)
      } catch (error) {
        threw = error instanceof Error ? error.message : String(error)
      }
      trace.push(
        `${shape.name}: ${
          threw === undefined ? `ok (${String(text?.length ?? 0)} chars)` : `THREW ${threw}`
        }`,
      )
      if (threw !== undefined) {
        offenders.push(
          `${shape.name}: 渲染守卫合成的兜底时**抛了**（${threw}）—— 「渲染绝不抛」失效`,
        )
        continue
      }
      if (text === undefined || text.trim() === '') {
        offenders.push(`${shape.name}: 兜底渲染出空文本 —— 兜底被静默吞掉了`)
        continue
      }
      // 「走正常渲染路径」的下界：形状不合法时 `renderToolResultText` 会退化成**一行**原始 JSON
      // （§3.1 规则 4），那一行里没有 `verdict: `。所以它在不在，正好区分
      // 「兜底被当成合法结果渲染」与「兜底其实也没过渲染层的形状判据」。
      if (!text.includes('verdict: ')) {
        offenders.push(
          `${shape.name}: 兜底走的是退化成一行 JSON 的那条路（没有 \`verdict:\` 行）—— 它没被当成合法结果`,
        )
      }
    }

    expect(
      offenders,
      `B25 违规：\n${offenders.join('\n')}\n实测轨迹：\n${trace.join('\n')}`,
    ).toEqual([])
  })
})

// ── B30 跨工具共享语义不许被重新实现 ──────────────────────────────────────

/**
 * B30：**同一种语义只许有一个实现**。
 *
 * 由来（2026-10-16 核对）：`resolved:` 那一行曾在 6 个工具里各写一份，`dsh_restart` 的
 * 字段顺序与其余五个**相反**；`asAudit` 5 份逐字相同、`oneLine` 3 份、兜底行 5 份。
 * 这类缺陷**不抛不报错、既有判据全绿** —— B25 明写不断言措辞一致，B16 / B21 也不管「印得一样」。
 *
 * ## 判据分两条（靶子不同，别合并）
 *
 * - **格式**：只能出现在 `shared.ts`。工具里出现 `resolved: profile=` / `resolved: dshHome=`
 *   或兜底句 = 有人又在自己拼那一行。**薄适配器不算违规**（它调共享实现，只绑本工具的取舍）。
 * - **名字**：这几个助手在工具文件里**不许有定义**（`function x(` / `const x =`）。
 *
 * ⚠️ 闭集写死在这里，加共享助手时同批加。
 * ⚠️ **已知限制（2026-10-17 复核，判定不上 AST）**：FORMAT 片段判**逐字**子串 ⇒
 * 「换一种说法的同一件事」照不到；闭集覆盖的是**今天已知的**重复面，未来若真出现
 * 一次换说法的漏网，先靠 review / 审计抓，再评估要不要上 AST（ts-morph / compiler
 * API 的语义等价判定没有便宜写法，且本仓大量**有意的相似**——三个 `omit for` 参数
 * 描述、C2 的 `'unknown'` 各表一格——会被相似度误伤）。决策依据见
 * `.agents/notes/2026-10-16-duplication-inventory.md` §一 第 3 条。
 */
/**
 * 「格式模板 → 它的唯一落点」。**落点不一定是 `shared.ts`** —— 每个「格式」声明自己的家，
 * 家以外出现同一句话即违规（2026-10-16 实测：relaunch 措辞的正典在 `lib/carrier.ts`，
 * 一刀切「只许在 shared.ts」会把正典自己也判红）。
 */
const FORMAT_OWNED_BY_SHARED: ReadonlyArray<readonly [fragment: string, home: string]> = [
  ['resolved: profile=', 'shared.ts'],
  ['resolved: dshHome=', 'shared.ts'],
  ['the guard synthesized this result', 'shared.ts'],
  // 「没有已实测回归路线」的正典在 lib/carrier.ts 的 unverifiedRelaunchReason。
  ['no relaunch route has been verified on', 'carrier.ts'],
  // 起不了 dsh 的 message 模板正典在 shared.ts 的 spawnFailureMessage。
  // ⚠️ 取消语义（CANCELLED_MESSAGE / CANCELLED_WHY）**不进 FORMAT 闭集**：
  // 各工具 verdict 句里内嵌同一短语是合法的（各自判定句，不是模板），
  // 而常量的「重复定义」由 NAME 闭集下面两条抓。
  ['cannot start dsh: ', 'shared.ts'],
  // ⚠️ B3 的违约形状：keyText 开头对「key 不是对象」静默 `return []`（守卫换了结果
  // 还装作正常空结果）。唯一合法写法是 guardKeyLines 判定 —— 本片段在工具文件里
  // 出现即违规（正典返回 undefined 让调用方继续，不含这个形状）。
  ["typeof key !== 'object') return []", 'shared.ts'],
  // B7：「dshHome 为空」的失败 detail 唯一措辞，正典在 lib/restart.ts 的常量。
  // ⚠️ 两个调用方（restart / restart-recovery）都用常量引用 —— 常量重定义由 NAME 闭集抓，
  // 字面量再写一遍（忘了改用常量）由这条抓。
  ['dshHome is empty', 'restart.ts'],
] as const

/**
 * 「助手名 → 它的唯一落点」。定义形态认 `function x(` 与 `const x =`。
 */
const NAME_OWNED_BY_SHARED: ReadonlyArray<readonly [helper: string, home: string]> = [
  ['asAudit', 'shared.ts'],
  ['oneLine', 'shared.ts'],
  ['withCallHome', 'shared.ts'],
  ['withHomeOverride', 'shared.ts'],
  ['spawnWithHome', 'shared.ts'],
  ['childEnvFor', 'shared.ts'],
  // 取异常 code 的唯一实现是 lib/errors.ts 的 systemErrorCode（带 cause 那一半）。
  ['systemErrorCodeOf', 'errors.ts'],
  ['effectiveConfig', 'shared.ts'],
  // 取消语义的一对常量（message / nextStep.why）正典在 shared.ts。
  ['CANCELLED_MESSAGE', 'shared.ts'],
  ['CANCELLED_WHY', 'shared.ts'],
  // spawn 失败的 kind 映射与 message 模板正典在 shared.ts。
  ['spawnFailureOf', 'shared.ts'],
  ['spawnFailureMessage', 'shared.ts'],
  // 守卫兜底 keyText 的判定与跨实例重试参数的判定，正典都在 shared.ts。
  ['guardKeyLines', 'shared.ts'],
  ['homeRetryArg', 'shared.ts'],
  // A1 / A3 / A4 收敛：异常取词与类型守卫的正典在 lib/errors.ts。
  ['messageOf', 'errors.ts'],
  ['asRecord', 'errors.ts'],
  ['asFunction', 'errors.ts'],
  ['asString', 'errors.ts'],
  ['isString', 'errors.ts'],
  ['isAborted', 'errors.ts'],
  // B7：「dshHome 为空」detail 常量的正典在 lib/restart.ts。
  ['DSH_HOME_EMPTY_DETAIL', 'restart.ts'],
  // B8：keyText 的 authority 条件行模板正典在 shared.ts。
  ['authorityLine', 'shared.ts'],
  // A2：宿主可迭代结构的遍历生成器正典在 lib/loader.ts（hot-reload 写侧同用这一份）。
  ['iterate', 'loader.ts'],
] as const

describe('B30 跨工具共享语义只有一个实现', () => {
  it('`src` 下没有第二份格式模板，也没有第二份助手定义', () => {
    // ⚠️ **扫描面是整个 `src`**，不是 `src/tools`（2026-10-16 审计实测的盲区）：
    // 曾只扫 `src/tools` 下文件名含 `dsh_` 的文件 ⇒ `src/lib` 整层与
    // `src/tools/{index,describe}.ts` **全在门外**，而重复最多的恰是 `src/lib`。
    // `src/client` 除外：它是另一半边（B14 同此分法）。
    // shared.ts 本身是多数助手的唯一落点，同样从扫描面排除。
    const sources = readSourcesUnder('src').filter(
      (source) => !source.path.endsWith('/shared.ts') && !source.path.startsWith('src/client/'),
    )
    // 空转判红：一个文件都没扫到时不许算通过（坑 18 的同族）。
    expect(sources.length, '一个文件都没扫到 —— 这条判据在空转').toBeGreaterThan(0)

    const offenders: string[] = []
    for (const source of sources) {
      const text = stripComments(source.text)
      for (const [fragment, home] of FORMAT_OWNED_BY_SHARED) {
        // 唯一落点不一定是 shared.ts（如 relaunch 措辞住在 lib/carrier.ts）：
        // 每个「格式」声明自己的家，家以外出现即违规。
        if (source.path.endsWith(home)) continue
        if (text.includes(fragment)) offenders.push(`${source.path} 又自己拼了一份「${fragment}」`)
      }
      for (const [helper, home] of NAME_OWNED_BY_SHARED) {
        if (source.path.endsWith(home)) continue
        if (
          new RegExp(`\\bfunction\\s+${helper}\\s*\\(`, 'u').test(text) ||
          new RegExp(`\\bconst\\s+${helper}\\s*=`, 'u').test(text)
        ) {
          offenders.push(`${source.path} 又定义了一份 \`${helper}\``)
        }
      }
    }

    expect(offenders, `B30 违规：\n${offenders.join('\n')}`).toEqual([])
  })

  it('判据可被否证：两种定义形态与格式片段都能认出来', () => {
    // 下界：正则或片段写错时这条会常绿（坑 37）。
    expect(/\bfunction\s+oneLine\s*\(/u.test('function oneLine(t: string) {}')).toBe(true)
    expect(/\bconst\s+asAudit\s*=/u.test('const asAudit = (v: unknown) => v')).toBe(true)
    expect('/x'.includes('resolved: profile=')).toBe(false)
    expect('resolved: profile=web dshHome=/h'.includes('resolved: profile=')).toBe(true)
  })
})

// ── B26 返回值必须可无损落 JSON（宿主边界的硬要求） ────────────────────────

/**
 * B26：**五个工具的每个返回值都必须无损通过一次 JSON 往返。**
 *
 * ## 为什么这条独立于 B21
 *
 * B21 判的是 §4.1 的**形状**表，而形状表照不到宿主的逐值判据：实测（2026-10-13 真机回归）
 * `data.audit.startupLogs.reports[0].report.messages[2].text` 是一个**值为 `undefined`** 的
 * 自有可枚举属性 —— B21 逐条全绿，而宿主在同一次调用上抛
 * `ToolOutputError('dsh_diagnose_plugin_load', ['value is not lossless JSON'])`，
 * 模型因此拿不到任何 `verdict` / `key` / `audit`。
 *
 * ## 判据：往返 + 深度相等（`isDeepStrictEqual`，**不是** `toEqual`）
 *
 * `expect(parsed).toEqual(value)` 有一条**必须避开的陷阱**：vitest 的 `toEqual`
 * **忽略值为 `undefined` 的属性** —— 恰好把这条红线要抓的那一类放过。
 * `isDeepStrictEqual` 不放过（它比的是键的集合），且对 `NaN` / `-0` 用 `Object.is` 语义。
 * 四类违规于是全部被覆盖：
 *
 * | 违规 | 往返后 | 判据 |
 * |---|---|---|
 * | `undefined` 值 | 该键**消失** | 键集合不等 → 红 |
 * | `NaN` / `±Infinity` | `null` | 不等 → 红 |
 * | `-0` | `0` | `Object.is` 不等 → 红 |
 * | 循环引用 | `JSON.stringify` **抛** | `try/catch` 记红 |
 * | `Date` / `Map` / 类实例 | 变成别的形状 | 不等 → 红 |
 *
 * ## 三条下界（缺任何一条，这条红线就是恒真的）
 *
 * 1. **判据能红**：七种**故意违规**的值（`undefined` / `NaN` / `Infinity` / 负零 / 循环引用 /
 *    `Map` / `Date`）各喂一次，`judgeLosslessRoundTrip` 必须对每一个都给出问题
 *    （活跃坑 18：让判据自己看起来通过是最危险的失败）。
 * 2. **守卫能红**：`toolResultProblem` 必须判「形状合法但不是无损 JSON」的候选为违规，
 *    且 `ensureToolResult` 把它换成**自身也无损**的兜底 —— 这条守着
 *    `src/lib/errors.ts` 的那道闸（把它改回「只查形状」就会红）。
 * 3. **夹具没空转**：五个工具一个都不许漏，语料不足 10 条判红（不 skip）。
 *
 * ## ⚠️ 为什么每条还必须断言「返回值**不是**守卫合成的兜底」（实测踩过的假绿）
 *
 * 本条第一版只断言「往返 + `ensureToolResult(value) === value`」，于是把 2a 的修复
 * 改回原样（`report: item.report`）之后 —— **仍然全绿**。原因：工具自己的 `toOutput()`
 * 在返回前就调过 `ensureToolResult`，所以宿主与本红线拿到的**永远是兜底**，而兜底
 * **当然**无损、也**当然**过自己的守卫。这是活跃坑 37 的原样形状：
 * 断言的是「症状（宿主报错）消失」，而不是「根因（那个 `undefined`）修好」。
 *
 * 修法是 `isGuardFallback()`：合成的兜底 `audit` **必定**含且只含 `received` 一个键
 * （`src/lib/errors.ts` 的 `malformedResult`，全仓唯一写这个键的地方）。
 * 任何一条 fixture 返回了兜底 → 判红，因为那时「这个工具的无损性」根本没被测到。
 */

/**
 * 这个返回值是不是 `ensureToolResult` **合成的兜底**。
 *
 * 判据取 `data.audit` 里的 `received` 键：那是 `malformedResult` 独有的字段
 * （`audit: { received: describe(value) }`），五个工具自己从不写它。
 *
 * @param value 工具返回值。
 */
function isGuardFallback(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const data = (value as { data?: unknown }).data
  if (typeof data !== 'object' || data === null) return false
  const audit = (data as { audit?: unknown }).audit
  if (typeof audit !== 'object' || audit === null) return false
  return Object.prototype.hasOwnProperty.call(audit, 'received')
}

/**
 * B26 专属的一条夹具：**带组合期消息的启动日志**（真机回归那条路的形状）。
 *
 * ## 为什么必须另有这一条（`redlineCorpus()` 那 10 条覆盖不到）
 *
 * 那 10 条 fixture 的临时 `$DSH_HOME` **没有 `logs/` 目录** —— 于是启动日志那条路
 * 根本不会被走到，漏点回归对 B26 是**完全不可见**的（那条「看起来绿」的形状）。
 * 这里是本仓第一次把「启动日志存在且被解析」这条**真机形状**做成夹具。
 *
 * ## 夹具里那一条消息为什么是关键
 *
 * 真机日志里 `workspace-registry` 的 `args` 是一个**跨行**的双引号字符串：
 *
 * ```
 * args: [
 *   "workspace 'w' filtered session 's' from membership: cwd 'D:\\x' does not resolve",
 *   [length]: 1
 * ]
 * ```
 *
 * 而 `lib/startup-log.ts` 的 `firstArgText` 的引号正则**只认单引号** ⇒ 返回 `undefined`，
 * 于是那条消息上挂着一个值为 `undefined` 的自有属性。2026-10-13 的真机回归就是这么来的。
 * 这份夹具按原样复刻那个形状（**故意不加 `[entries]` 段**，与真机那份不同 ——
 * 少一个锚点只让 `gaps` 多一条，与本条红线要判的「无损与否」无关）。
 */
const REAL_SHAPED_STARTUP_LOG = [
  '  error: startup failed: 1 required plugin did not activate',
  '  Failed plugins (1):',
  '    webserver (required)',
  '      Package: dsh-web',
  '      Error: listen EADDRINUSE: address already in use 127.0.0.1:19388',
  '  [startup]: {',
  '    messages: [',
  '      {',
  "        name: 'workspace-registry',",
  "        type: 'warn',",
  '        args: [',
  "          \"workspace 'w' filtered session 's' from membership: cwd 'D:\\\\x' does not resolve\",",
  '          [length]: 1',
  '        ]',
  '      },',
  '      [length]: 1',
  '    ]',
  '  }',
  '}',
  '',
].join('\n')

/** 跑一次 `dsh_diagnose_plugin_load`，`$DSH_HOME` 里有 profile 清单与上面那份启动日志。 */
async function runDiagnoseWithStartupLog(): Promise<unknown> {
  const home = makeTempRoot('dsh-redline-b26-log-')
  const dir = writeProfileFixture(home, ['pkg-a'])
  writeInstalledPackageFixture(dir, 'pkg-a')
  writeTextFile(
    join(home, 'logs', 'startup-2026-01-01T00-00-00.000Z-b26.log'),
    REAL_SHAPED_STARTUP_LOG,
  )
  const tool = createDiagnosePluginLoadTool(redlineDeps(redlineConfig(home)))
  return await tool.execute({}, redlineExec())
}

describe('B26 返回值必须可无损落 JSON（宿主边界的硬要求）', () => {
  it('五个工具的每个返回值：往返深度相等 + 不是守卫合成的兜底', async () => {
    const runs = [...(await redlineCorpus())]

    // 真机形状那条另跑一次（`redlineCorpus()` 里没有带启动日志的夹具）。
    const logRun = await runDiagnoseWithStartupLog()
    runs.push({
      tool: DIAGNOSE_PLUGIN_LOAD_TOOL,
      label: 'diagnose · 读到了带组合期消息的启动日志（真机形状）',
      value: logRun,
      text: '',
    })

    // ── 下界 1：判据能红（四类违规逐个） ────────────────────────────────────
    const cyclic: Record<string, unknown> = { verdict: 'v' }
    cyclic['self'] = cyclic
    const violations: Array<[string, unknown]> = [
      ['undefined', { ok: true, data: { verdict: 'v', key: {}, audit: { a: undefined } } }],
      ['NaN', { ok: true, data: { verdict: 'v', key: { n: Number.NaN }, audit: {} } }],
      ['negative zero', { ok: true, data: { verdict: 'v', key: { n: -0 }, audit: {} } }],
      [
        'Infinity',
        { ok: true, data: { verdict: 'v', key: { n: Number.POSITIVE_INFINITY }, audit: {} } },
      ],
      ['circular', cyclic],
      ['class instance', { ok: true, data: { verdict: 'v', key: new Map(), audit: {} } }],
      ['Date', { ok: true, data: { verdict: 'v', key: {}, audit: { at: new Date(0) } } }],
    ]
    const blindViolations = violations
      .filter(([, value]) => judgeLosslessRoundTrip(value) === undefined)
      .map(([label]) => label)
    expect(
      blindViolations,
      `B26 下界失败：往返判据对下面这些**故意违规**的值居然说没问题 —— 这条红线在空转：\n${blindViolations.join('\n')}`,
    ).toEqual([])

    // ── 下界 2：守卫（`src/lib/errors.ts` 那道闸）能红 ─────────────────────────
    const shapeValidButNotLossless = {
      ok: true,
      data: { verdict: 'v', key: {}, audit: { message: { text: undefined } } },
    }
    const guardProblem = toolResultProblem(shapeValidButNotLossless)
    if (guardProblem === undefined) {
      expect.fail(
        'B26 下界失败：`toolResultProblem` 对「形状合法但含 undefined」的值说没问题 —— ' +
          '守卫不再要求无损 JSON（把它改回只查形状，这条就会红）',
      )
    }
    const fallback = ensureToolResult(shapeValidButNotLossless)
    expect(fallback, '守卫必须把这个值换掉，而不是原样放行').not.toBe(shapeValidButNotLossless)
    expect(
      judgeLosslessRoundTrip(fallback),
      '守卫自己合成的兜底必须也是无损的，否则宿主要拒收它的产物',
    ).toBeUndefined()

    // ── 判据本体：五个工具的每个返回值 ─────────────────────────────────────
    const offenders: string[] = []
    const covered = new Set<string>()
    for (const run of runs) {
      covered.add(run.tool)
      const roundTrip = judgeLosslessRoundTrip(run.value)
      if (roundTrip !== undefined) offenders.push(`${run.label}: 往返失败 —— ${roundTrip}`)
      if (toolResultProblem(run.value) !== undefined) {
        offenders.push(`${run.label}: toolResultProblem 判它违规（守卫没查无损 JSON？）`)
      }
      // ⚠️ **这一条是本条红线真正的载荷**（实测踩过一次假绿，见下面那段注释）。
      if (isGuardFallback(run.value)) {
        offenders.push(
          `${run.label}: 返回的是**守卫合成的兜底**（audit.received 存在）—— 工具自己踩了契约，这条夹具正走在那条路上，"无损"无从判断`,
        )
      }
    }

    // ── 下界 3：空转判红，一个工具都不许漏 ──────────────────────────────────
    for (const shape of toolShapes()) {
      if (!covered.has(shape.name)) {
        offenders.push(`${shape.name}: 语料里一条 fixture 都没有 —— 这条红线在空转`)
      }
    }
    if (runs.length < 10) {
      offenders.push(`语料只有 ${String(runs.length)} 条（期望 ≥10）—— 这条红线的覆盖面在缩水`)
    }

    // ── 下界 4：oracle 对宿主的两条真实判据既不漏也不多报 ────────────────────
    // 两类都是对着本机 `0.2.1-alpha.2` 的 `dsh-util-values/lib/index.js`
    // 跑探针实测出来的（见 docs/HOST-CONTRACTS.md §0），不是读源码推的。
    const nonEnumerable = { a: 1 } as Record<string, unknown>
    Object.defineProperty(nonEnumerable, 'hidden', { value: 2, enumerable: false })
    if (judgeLosslessRoundTrip(nonEnumerable) === undefined) {
      offenders.push('oracle 对「不可枚举自有属性」判成无损 —— 宿主实测 REJECT，这是真盲区')
    }
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, {
      a: 1,
      nested: Object.assign(Object.create(null) as Record<string, unknown>, { b: 2 }),
    })
    if (judgeLosslessRoundTrip(nullPrototype) !== undefined) {
      offenders.push(
        `oracle 对「null 原型对象」判成违规（${String(judgeLosslessRoundTrip(nullPrototype))}）—— 宿主实测接受，这是假红`,
      )
    }
    // 空原型对象同样不该被判红（与上面同一族）。
    if (judgeLosslessRoundTrip(Object.assign(Object.create(null) as object, {})) !== undefined) {
      offenders.push('oracle 对「空的 null 原型对象」判成违规 —— 宿主实测接受')
    }

    expect(offenders, `B26 违规：\n${offenders.join('\n')}`).toEqual([])
  })
})

/**
 * 找出**不可枚举**的自有属性（宿主拒、B26 原判据放过的那一类）。
 *
 * `Object.keys` 只列可枚举的，`JSON.stringify` 也只写可枚举的 ⇒ 一遍往返之后
 * 不可枚举键**两边都在、值也一样**，`isDeepStrictEqual` 判「无损」。但宿主
 * `dsh-util-values` 的 `walkJsonValue` **拒收非枚举自有属性**
 * （实测：`{a:1}` 加一个 `enumerable:false` 的 `hidden` ⇒ 宿主 REJECT，本函数绿）。
 * 这条补上那个盲区。
 *
 * @param value 待查的值。
 * @returns 第一条违规描述；`undefined` = 没有不可枚举自有属性。
 */
function judgeNonEnumerableOwnProperty(value: unknown): string | undefined {
  const walk = (node: unknown, path: string): string | undefined => {
    if (node === null || typeof node !== 'object') return undefined
    if (Array.isArray(node)) {
      // 数组的 `length` **天生**不可枚举，而宿主照收数组 —— 它不是违规。
      // 只查下标与额外 own 键（实测：额外 own 键与稀疏下标宿主都拒）。
      for (let index = 0; index < node.length; index += 1) {
        if (!(index in node)) return `稀疏数组 ${path}[${String(index)}]（宿主拒收）`
        const found = walk(node[index], `${path}[${String(index)}]`)
        if (found !== undefined) return found
      }
      for (const key of Object.keys(node)) {
        if (/^(0|[1-9]\d*)$/u.test(key)) continue
        const descriptor = Object.getOwnPropertyDescriptor(node, key)
        if (descriptor !== undefined && descriptor.enumerable === false) {
          return `数组上的不可枚举自有属性 ${path}.${key}（宿主拒收）`
        }
        const found = walk(node[key as keyof typeof node], `${path}.${key}`)
        if (found !== undefined) return found
      }
      return undefined
    }
    for (const key of Object.getOwnPropertyNames(node)) {
      const descriptor = Object.getOwnPropertyDescriptor(node, key)
      if (descriptor !== undefined && descriptor.enumerable === false) {
        return `不可枚举自有属性 ${path}.${key}（宿主拒收，JSON 往返却看不见它）`
      }
    }
    // 宿主认的容器只有普通对象与数组；别的（Date/Map/类实例）交给往返判据去抓。
    const prototype = Object.getPrototypeOf(node)
    const isPlain = prototype === Object.prototype || prototype === null
    if (!isPlain) return undefined
    for (const key of Object.keys(node)) {
      const found = walk((node as Record<string, unknown>)[key], `${path}.${key}`)
      if (found !== undefined) return found
    }
    return undefined
  }
  return walk(value, '$')
}

/**
 * B26 的判据本体：一次 JSON 往返之后**深度相等**。
 *
 * 为什么用 `node:util` 的 `isDeepStrictEqual` 而不是 vitest 的 `toEqual`：
 * `toEqual` **忽略值为 `undefined` 的属性** —— 恰好放过这条红线要抓的头号违规
 * （实测那条 `messages[2].text`），那样这条红线就只剩 B21 的形状检查在起作用。
 * `isDeepStrictEqual` 比的是**键的集合**，且标量用 `Object.is`（`-0` ≠ `0`）。
 *
 * ⚠️ 但它有一条**反向**的毛病：`isDeepStrictEqual` 连**原型**一起比，于是
 * `Object.create(null)` 的普通对象会被判「不等」——**宿主是接受的**
 * （`hasPlainObjectPrototype` 显式放行 `prototype === null`，实测）。那是**假红**，
 * 所以比之前先把原型归一，只比可枚举键的集合与值。
 *
 * @param value 待查的值。
 * @returns 第一条违规描述；`undefined` = 无损。
 */
function judgeLosslessRoundTrip(value: unknown): string | undefined {
  let text: string | undefined
  try {
    text = JSON.stringify(value)
  } catch (error) {
    return `JSON.stringify 抛了（${error instanceof Error ? error.message : String(error)}）`
  }
  if (text === undefined) return 'JSON.stringify 返回 undefined（顶层就是 undefined）'
  let back: unknown
  try {
    back = JSON.parse(text)
  } catch (error) {
    return `JSON.parse 抛了（${error instanceof Error ? error.message : String(error)}）`
  }
  const hidden = judgeNonEnumerableOwnProperty(value)
  if (hidden !== undefined) return hidden
  // 归一**两侧**再比：`isDeepStrictEqual` 连原型一起比，而宿主把
  // `Object.create(null)` 与 `{}` 一视同仁，所以原型不同不该在这里判红。
  if (!isDeepStrictEqual(nullPrototypeToPlain(back), nullPrototypeToPlain(value))) {
    return `往返后与原值不等（序列化长度 ${String(text.length)}）—— 典型原因：undefined 键 / NaN / ±Infinity / -0 / 类实例`
  }
  return undefined
}

/**
 * 把 `Object.create(null)` 的对象换成同键同值的普通对象（数组与标量原样返回）。
 *
 * 只为让 `isDeepStrictEqual` 不因**原型不同**而报不等 —— 宿主两等都接受，
 * 所以原型不该成为本条红线的判据。
 *
 * @param value 待查的值。
 */
function nullPrototypeToPlain(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => nullPrototypeToPlain(item))
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== null && prototype !== Object.prototype) return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    out[key] = nullPrototypeToPlain((value as Record<string, unknown>)[key])
  }
  return out
}

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
 * | 10 | A4 的反空转下界（锁文件里 ≥1 条 `resolution`）、B12 的 `body > 500` 阈值 | A4 那条**不再数地址**（pnpm 下零地址是正常状态，见 #44），改判「锁文件本身读进来了没有」；B12 的 500 是我按当前规模猜的数（约 1.1 万字节） | 锁文件被读空 / 被截断 → **红**（响亮）；阈值调小只是少抓，不会误红。【已探明】 |
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
 * | 30 | B18a 的**可观测前提**：`toOutput()` 里的 `ensureToolResult` 守卫**在渲染之前**就把「没有动作的 nextStep」换掉了 | 这是 `src/tools/shared.ts` 的现行实现；判据能红，正是因为**红线读的是 `execute` 的返回值、不是渲染文本** | 守卫一旦被挪到渲染之后（或 `toOutput` 被绕过），**B18a 会假绿**：`ensureToolResult` 合成的兜底 `nextStep` 是 `undefined`（缺省 = 合法），坏形状在到达本红线前就消失了。**已用变异实测**：只改工具写法 → 85 全绿（假绿）；**同时旁路守卫 → B18a 红**（另一条 M4 证据） |
 * | 31 | B25 的「兜底可渲染」：`ensureToolResult` 合成的兜底 `key` 是 `{}`，而 `dsh_check_auth` / `dsh_diagnose_plugin_load` / `dsh_dump_config` 的 `keyText` 曾**会崩**在它上面（`resolvedLine(undefined)`） | 三条 `keyText` 现在都按 `typeof … === 'string' ? … : 'unknown'` 防御取值；`effect_mode` / `hot_reload` 的写法本来就是防御式的 | **这是已实测的工具侧缺陷**（2026-10-13 探针：`ensureToolResult({ok:true})` 的 `key={}` 喂五个 render 表 → 3 抛 / 2 过）。**已修，由 B25 守着**：变异（把三处防御改回直接取值）→ B25 **红**；还原 → 绿 |
 * | 32 | B25 只断言「**不抛** + 走正常渲染路径（有 `verdict: ` 行）+ 输出非空」，**不断言降级措辞** | 三个被修工具的降级句 `resolved: unknown (the guard synthesized this result)` 的逐字断言住在**它们各自的测试**里 | 有人把降级句改成别的诚实措辞（仍不抛）→ B25 **仍绿**（**有意**：那条措辞是各工具自己的契约，不是全局契约）；反之，谁把某个 `keyText` 改回直接取值 → **B25 红**（响亮，不是假绿） |
 * | 33 | B25 的兜底夹具只有**一种**坏法（`data.verdict` 是空串） | `ensureToolResult` 对任何 `toolResultProblem` 非 `undefined` 的值都走**同一个** `malformedResult` | 换一种坏法（缺 `data` / `ok` 不是布尔）走的是同一条合成路径 → 判据等价；但若将来给不同坏法**分叉**出不同的兜底形状，这条只覆盖其中一支 |
 * | 34 | B26 的覆盖面 = `redlineCorpus()` 那 10 条 + **本文件自带的 1 条带启动日志的夹具** | 夹具是我造的；诊断工具的**第三种**返回路径（如某条新的失败分支）不在语料里 → 那条路不被本条看见。加分支时**同批加 fixture** | 同 #27，与 B21 共用同一个语料源 |
 * | 35 | B26 用 `isDeepStrictEqual` 比往返结果（**不是** `toEqual`） | `toEqual` 忽略值为 `undefined` 的属性 —— 恰好放过本条要抓的头号违规 | 换成 `toEqual` → 本条只剩 `isGuardFallback` 那一半在起作用（**已实测**：换掉之后 M3 变异不红了）。**别换** |
 * | 36 | B26 的 `isGuardFallback` 认的是 `data.audit.received` 这个键 | 它是 `src/lib/errors.ts` 的 `malformedResult` 独有的字段 | 某个工具自己开始往 `audit` 里写 `received` → **误报**（红，需同步改这一条）；反过来，`malformedResult` 改了合成形状而不再写 `received` → 本条对兜底**失明**（假绿）。改 `malformedResult` 时必须同批看 B26。【已探明】 |
 * | 37 | B12b 的**四条下界**（正文 ≥200 字符 / ≥4 条要点 / 提到 `dsh_hot_reload` / 提到 `dsh_sign_cookie`）与「标题里含『干预』」 | 阈值与**工具名清单**都是我定的：它们把「解冻了却没写」这一种缺口挡住，但**不是**「内容不许变」 | 那三个阈值是**量级**而非合同：正文明显更短（拆得更碎）→ **红**（响亮，人来看）；工具名清单是**手抄的一份**，写侧 / 派生出第二个工具而没加进 `INTERVENTION_REQUIRED_TOOLS` → **漏**（假绿），加工具时必须同批改它。**刻意不做的**：与任何原文的逐字比对 —— 那会把解冻又变成冻结 |
 * | 38 | **`test/tools/timeout-budgets.test.ts` 的源码扫描**（预算字面量 / 直接读配置的预算字段）：判据 = `stripComments` + **逐行**正则 | 逐行扫描 + 正则形态匹配（不解析表达式） | 三条**假绿**方向：① **跨行字面量**（`timeoutMs:` 与数字分在两行）漏；② **别名**（`const c = deps.config` 之后 `c.timeoutMs`）漏；③ **字符串拼字段名**（`cfg['timeout' + 'Ms']`）漏。本仓格式化与写法下都不出现；要收紧得上 AST。【已探明】 |
 * | 39 | **B10 的作用域**（整个 `src/**`，由 `readOnlyScope()` 唯一出处） | 判据是「扫描面的文件数 == `readSourcesUnder('src')` 的文件数」 | 在**调用处**再 `.filter()` 收窄（`readOnlyScope()` 之外另写一份过滤）是**同一文件内的判据防不住**的 —— 红线自己也在那个文件里。它能抓的是「改 `readOnlyScope()` 这个唯一出处」。【已探明】 |
 * | 40 | **B10 的宿主数据路径前缀表** `HOST_DATA_PATH_SEGMENTS` | 手抄的一份表（取自真机 `~/.dsh` 一级项），另有一份**独立副本**（用例里的 `required` 字面量）与之逐条比对。**（2026-10-14 语义变了）** 表只管**没有** `$DSH_HOME` 参与的那一类写；写了 `$DSH_HOME` 的走**白名单**判据（见 #43） | 只删表里一行 → 第二副本的逐条比对**判红**（响亮，逼人同批改两处）；两处**同批**删同一族 → 静默失守。表外新增的宿主目录（宿主以后加一个）也不在覆盖面内 —— 需人来补。**前缀判据本身不认通配**（`profiles/<p>/logs` 那种嵌套靠逐条前缀覆盖）。⚠️ **自证的样本形态要跟着通道走**：白名单落地前样本是 `join(dshHome, 'seg', …)`，现在那种写法走白名单通道 —— 表被删它也照样红，于是「表还在不在」就**测不出来**了（本任务第二次踩到自指假绿）。现在的样本**两条通道各一个**（`home + '/seg/x'` 走表、`join(dshHome, 'seg', …)` 走白名单）【已探明】 |
 * | 41 | **B15 的写侧文件清单** `WRITE_SIDE_FILES` | 不再只靠手抄：判据从**机制入口**反推（`WRITE_SIDE_MECHANISM_IMPORT` 认 `from '…hot-reload.js'` + `WRITE_SIDE_NON_IMPLEMENTATIONS` 注册点白名单），并自证白名单文件存在 | 换一种拿机制的方式（`await import()` 动态导入 / 间接 re-export）→ **漏**（假绿）；把新写侧实现塞进白名单文件里 → 也漏。清单里的文件被删/改名 → 判红（响亮）【已探明】 |
 * | 42 | **B10 的「写宿主数据」判据是接进 `judgeReadOnly` 的**（不是孤立的判据函数） | 判据从 `judgeReadOnly` 的返回里摘掉后，那批「喂一条违规」的否证用例**照样全绿** | 本任务实测踩到过：**自指的假绿** —— 否证用例直接调判据函数、不经过 B10，于是「判据立起来了」是假的。现由三条接线自证守着（违规走完整入口必须红 / 只读必须不报 / **白名单正例走完整入口必须绿**）。**新增判据时照抄这个形状**：否证用例之外**必须**有一条走完整入口的接线断言【已探明】 |
 * | 43 | **B10 白名单的首段判定**（`classifyHomeWrite` + `segmentAfter`）：`$DSH_HOME/<包名>/` 逐字相等才放过 | 靠**文本**认写法：`join(home, 'seg')` / `` `${home}/seg` `` / `home + '/seg'` / `join(env.DSH_HOME ?? '', 'seg')` 四种桥各有一条正则式；段名靠「不以分隔符/引号/空白/逗号/冒号结尾的连续字符」切 | ① **首段是变量取不出**（`join(dshHome, name, …)`）⇒ 判**unknown** ⇒ **保守判红**（要放过就得写字符串字面量，或把判据扩成能解析 const）；② **写法认不出**（多层拼接、先算好路径再传）同样落进 unknown ⇒ 红（响亮，不是漏）；③ 同一行里 `dshHome` 出现多次时**逐次取段、安全优先**（出现任一「不等于包名的确定段」⇒ 红），所以 `function f(dshHome: string) { … join(dshHome, 'pkg', …) }` 不会因类型标注被误判；④ 包名从 `package.json` 读（**没有手抄副本**），`name` 缺失/形状不对由用例自证判红【已探明】 |
 * | 44 | **A4 的地址扫描**（正则扫 `pnpm-lock.yaml` 原文里出现的每一个 http(s)） | 判据是**文本**扫描（不解析 YAML）；且 pnpm 只在来源**不是默认 registry** 时才写 `tarball: <url>` | ① 镜像被配成**默认 registry** 时 pnpm 不写地址 ⇒ 零地址看着干净（**漏**；要抓得读生效的 registry 配置，那在锁文件之外）；② 地址跨行 / 转义 / 运行时拼出来 ⇒ 漏；③ 主机名按**逐字相等**判（比姊妹仓的 `startsWith` 严）⇒ 官方源带子域会**误红**（响亮）；④ 反空转改挂「有 `lockfileVersion` + 有 `resolution` 条目」⇒ 一份**结构合法但包段被换掉**的锁文件照样绿（那是别的判据的事）。【已探明：真实锁文件 0 地址 / 188 条 resolution】 |
 * | 45 | **B27 的禁词表** `UNREACHABLE_POINTERS` | 手写的**闭集**（`session log` 一族），且只扫**截断行**那一行（靠 `RENDER_TRUNCATED_RE` 前缀取行） | ① 换个说法指向同一个不可达位置（如「ask the session」）→ **漏**；② 将来新增别的不可达位置（例如把 `data` 说成「在进程内」）→ 需人补表；③ L2 / L3 里别的不可兑现指引**不归它管**（那是评审的活）。**下界**：取不到截断行 → 判红，不 skip（坑 18）。**已实测**：把旧半句逐字加回来 → 红；换说法（`the rest is in the session-log`）→ 也红 |
 *
 * **B10 已知未覆盖的写入通道**（明确列出，不静默排除）：
 * `process.binding`、原生 addon、`require()`（本仓纯 ESM）、把 fs 方法先赋给别的变量再调用
 * （`const w = writeFileSync`）、以及经 `ctx.subprocess`/`ctx.shell` 发起的写命令。
 * 这些在本仓目前不出现；真出现时要靠人看出来，或把判据扩成 AST 级。
 * **（2026-10-14 补）** shell 重定向 / `Set-Content` / `Out-File` / `New-Item` 这几族
 * **已纳入** `judgeHostDataWrites`（本仓 `.ps1` 与 `execSync` 都是一等公民）；其余 shell
 * 拼装方式（`cmd /c copy …`、`Start-Process -RedirectStandardOutput`）仍在未覆盖之列。
 *
 * **B10 的宿主数据路径判据是「禁止」那一半，不是全部纪律**（2026-10-14 立）：
 * 「要不要允许插件写**自己的命名空间**」是**维护者的未决事**，留在这里等拍板 ——
 * 两种放宽写法（精确命名空间 vs 前缀族白名单）与差异见 SHAPE 的对应小节。
 * **判据先立、放宽后议**：立起来时只加了一条更严的规则，没有削弱任何现有保护面。
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
