#!/usr/bin/env node
/**
 * 发布态不变量的执行体。
 *
 * 为什么存在：组织判据 [plugin-conventions.md] 把「Release-state invariants」定为 **Must agree**、
 * 由各仓 `check:release` 承担 —— 而**脚手架不生成它**（v0 边界，见组织的
 * `.agents/notes/2026-10-12-scaffold-seeds-not-syncs.md`）。判据没有执行体就会烂掉，
 * 所以本仓自建这一份，由 `ci.yml` 与 `release.yml` 在 publish **之前**跑。
 *
 * 与三仓同名脚本的关系：**判据同形、内容各自表述**（三仓那三份 83 / 208 / 295 行，互不相同）。
 * 本仓独有的第 7、8 条来自本仓决策 D12 —— 技能随包分发是本仓第一个、组织现有三仓都没有。
 *
 * 用法：
 *   node scripts/check-release.mjs [仓库根目录]     # 省略时用当前目录
 *
 * 带上可选根目录是**为了正反例都能复现**：把仓拷到临时目录、故意改坏一处，就能在
 * 不动工作树的前提下证明这道守卫真的会红（判据自己也要能被否证）。
 *
 * 退出码：0 = 全部通过 / 1 = 有断言不成立 / 2 = 用法或前置条件错（如 package.json 读不到）。
 *
 * 输出约定与另两仓一致：`ok` / `FAIL` 前缀 + 末行汇总；`note` 是不阻断的现状说明。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const USAGE = `用法：
  node scripts/check-release.mjs [仓库根目录]

退出码：0 = 通过 / 1 = 有断言不成立 / 2 = 用法或前置条件错`

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE)
  process.exit(2)
}
if (args.length > 1) {
  console.error(`无法识别的参数：${args.slice(1).join(' ')}`)
  console.error(USAGE)
  process.exit(2)
}

const root = resolve(args[0] ?? '.')

/** 本仓技能随包分发的落点。改目录结构时两条（`files` 覆盖 + 存在性）要一起改。 */
const SKILL_FILE = 'skills/dsh-plugin-debugging/SKILL.md'

/** 包名参与 `skills/<包名>/SKILL.md` 的形状判定，所以从清单里读，不手抄。 */
let pkg
try {
  pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
} catch (error) {
  console.error(`FAIL 读不到 ${join(root, 'package.json')}：${String(error)}`)
  process.exit(2)
}

const failures = []
const notes = []
let checked = 0

/**
 * 断言一条发布态不变量。
 *
 * @param label 判定的名字（红了要能一眼看出是哪一条）。
 * @param ok 条件。
 * @param hint 红了之后该怎么改。
 */
function require_(label, ok, hint) {
  checked += 1
  if (ok) {
    console.log(`ok    ${label}`)
    return
  }
  failures.push(`${label} —— ${hint}`)
  console.log(`FAIL  ${label}`)
}

/** 记一条不阻断的现状（不是绿，也不是红）。 */
function note(text) {
  notes.push(text)
  console.log(`note  ${text}`)
}

/**
 * `files` 里某一条目能不能覆盖目标路径。
 *
 * 只实现两种**本仓真实用到**的形态：裸目录名（`skills` → 整个目录随包）与显式路径，
 * 外加 `**` 后缀。刻意不做通用 glob：npm 用的是 minimatch，三十行不可能对齐它，
 * 而写一个「看起来像完整语义」的实现，比写一个窄的更容易让人误信。
 * 取反项（以 `!` 开头，例如 `files` 里那条排除 map 的条目）只表示排除，**不构成覆盖**。
 *
 * @param entry `files` 里的一个条目。
 * @param target 仓内相对路径（POSIX 分隔符）。
 */
function covers(entry, target) {
  if (typeof entry !== 'string') return false
  if (entry.startsWith('!')) return false
  const clean = entry.replace(/^\.\//, '').replace(/\/+$/, '')
  if (clean === '') return false
  if (clean === target) return true
  if (clean.endsWith('/**')) return target.startsWith(`${clean.slice(0, -3)}/`)
  return target.startsWith(`${clean}/`)
}

const files = pkg.files

// 自检：`files` 缺席时下面那条覆盖判定会永远为假 —— 那是「判据没跑到」，不是「判据通过」。
require_(
  'files 是非空数组',
  Array.isArray(files) && files.length > 0,
  '`files` 缺席或为空时，覆盖判定恒为假。先把它补回来，别让下面那条变成空转。',
)

// 1. bundle 层。缺了它，本包进不了 profile（判据在组织仓的 §3）。
require_(
  'dsh.bundle.patch 指向 ./cordis.patch.yml',
  pkg.dsh?.bundle?.patch === './cordis.patch.yml',
  'bundle 层靠它进入 profile；开发期若被摘掉，发布前必须加回。',
)

// 2. 发布态不该带 private。
require_('private 未设置', pkg.private !== true, '发布前要移除 "private": true。')

// 3. 宿主兼容范围必须声明（值会漂，所以只判「声明了、非空」）。
require_(
  'engines.dsh 已声明且非空',
  typeof pkg.engines?.dsh === 'string' && pkg.engines.dsh.trim() !== '',
  '宿主兼容范围必须声明；具体值现查 npm view @deepseek-ai/dsh dist-tags，别抄进文档。',
)

// 4. bundle patch 文件要随包。
require_(
  'files 含 cordis.patch.yml',
  Array.isArray(files) && files.includes('cordis.patch.yml'),
  'bundle 层依赖它随包发出去。',
)

// 5. 许可证：清单声明 MIT，仓里就得有对应文件。
require_(
  'LICENSE 存在',
  existsSync(join(root, 'LICENSE')),
  'package.json 声明 MIT，仓库里必须有对应文件。',
)

// 6. 本仓决策 D12（前半）：`exports` 必须暴露 `./skills/*`。
//    技能半边按包内路径解析 SKILL.md，这条子路径导出缺席时宿主拿到
//    ERR_PACKAGE_PATH_NOT_EXPORTED —— 与「元数据静默消失」是同一族故障。
const exportsMap = typeof pkg.exports === 'object' && pkg.exports !== null ? pkg.exports : {}
require_(
  "exports 暴露 './skills/*'",
  Object.hasOwn(exportsMap, './skills/*'),
  '技能随包分发要求宿主能按 <包名>/skills/... 解析到文件；缺这条子路径导出会得到 ERR_PACKAGE_PATH_NOT_EXPORTED。',
)

// 7. 本仓决策 D12（后半，**本仓独有**）：「SKILL.md 随包且在」里「随包」的那一半。
//    组织现有三仓都没有这条 —— 它们不带技能，所以这条判据在本组织是新的。
require_(
  `files 覆盖 ${SKILL_FILE}`,
  Array.isArray(files) && files.some((entry) => covers(entry, SKILL_FILE)),
  `技能是 v1 的能力面之一，SKILL.md 必须随包发出去。当前 files 没有一条覆盖 ${SKILL_FILE}；` +
    '补一条覆盖它的条目（不要只补一个文件路径就完事 —— 技能目录还会长别的文件）。',
)

// 8. D12 里「且在」的那一半。
//
//    **条件式**，理由是诚实：技能半边由另一条活件落地，`skills/` 现在可能还不在树里。
//    无条件判红会让这道守卫在本仓还没长出技能时**永远是红的** —— 那种红会训练人忽略它。
//    所以：`skills/` 一旦在树里，缺 SKILL.md 就是失败；还没有 `skills/` 时只记一条 note，
//    让「还没落地」这件事**可见**，而不是静默地算通过。
const skillHint =
  'skills/ 已经在树里，但这一份 SKILL.md 不在 —— 随包会发出去一个空技能目录，而制品里少文件没有任何信号。'
if (existsSync(join(root, SKILL_FILE))) {
  require_(`${SKILL_FILE} 在磁盘上`, true, skillHint)
} else if (existsSync(join(root, 'skills'))) {
  require_(`${SKILL_FILE} 在磁盘上`, false, skillHint)
} else {
  note(
    `${SKILL_FILE} 尚未落地（skills/ 还不在树里）—— 「随包」成立、「且在」还没成立；` +
      '技能活件落地后，这条 note 自动转成硬判。',
  )
}

// 9. 发布流程不得改写版本号（组织 Must agree）。
//
//    判据只认**会执行的命令行**：YAML 注释与 `echo`（提示文案）不算 ——
//    否则「提醒你先本地 bump」这种正确的话会被自己的守卫判红。
//    命令位置用整行正则近似：本仓 workflow 里这几条命令都独占一行。
const RELEASE_WORKFLOW = '.github/workflows/release.yml'
const releaseWorkflowPath = join(root, RELEASE_WORKFLOW)

if (!existsSync(releaseWorkflowPath)) {
  require_('发布入口存在', false, `缺少 ${RELEASE_WORKFLOW} —— 本仓的发布入口还没落地。`)
} else {
  require_('发布入口存在', true, '')
  const source = readFileSync(releaseWorkflowPath, 'utf8')
  const writes = findVersionWrites(source)
  require_(
    '发布流程不改写版本号',
    writes.length === 0,
    `release.yml 里出现了会改版本的命令：${writes.join(' / ')}。版本要**本地** bump 并提交` +
      '（见 docs/PUBLISHING.md），否则工作树永远停在「上一个已发布版本」，界面与截图拍出的都是旧号。',
  )

  // 10. 只推 tag、不推 main。
  //     这条保证「发布不需要 GitHub App token」：要往受保护分支直推就得多一把 App 私钥，
  //     而本仓刻意选了不需要任何 secret 的那条路（对齐 dsh-ds-balance）。
  const pushesDefaultBranch = source
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .some((line) => /git\s+push\s+\S+\s+(HEAD:)?(main|master)\b/.test(line))
  require_(
    '发布流程不推默认分支',
    !pushesDefaultBranch,
    'release.yml 里出现了往 main/master 的 push —— 那需要 App token 与 ruleset 放行；' +
      '本仓的发布只产出 tag 与 GitHub Release。',
  )

  // 11. 发布前**一定会构建**（机制之一，不锁定某一种实现）。
  //
  //     为什么这条存在：`main` / `exports` 指向 `lib/`，而 `/lib/` 是**构建产物**、
  //     被 `.gitignore` 忽略 —— 检出里根本没有它。`0.2.0` 就是这么发出去的：
  //     tarball 只有 9 个文件、**一行代码都没有**，装上去连入口都解析不到（静默挂不起来）。
  //
  //     本工作区里另三个仓各有各的机制（release.yml 显式 build 步骤 / `test` 先 build /
  //     `prepare` 先 build）—— 本仓当时**一种都没有**。所以这条判据要认的是
  //     「publish 之前有构建」，而不是某一种写法；改机制不该把它判红。
  const scripts = typeof pkg.scripts === 'object' && pkg.scripts !== null ? pkg.scripts : {}
  /** 这个 npm script 会不会产生 `lib/`。 */
  const scriptBuilds = (scriptName) => {
    const body = scripts[scriptName]
    if (typeof body !== 'string') return false
    return /npm run build\b/.test(body) || /(^|\s)(tsc|tsdown)\b/.test(body)
  }
  const releaseLines = source.split('\n')
  const buildAt = releaseLines.findIndex((line) => /^\s*(-\s*)?run:\s*npm run build\b/.test(line))
  const testAt = releaseLines.findIndex((line) => /^\s*(-\s*)?run:\s*npm (run )?test\b/.test(line))
  const publishAt = releaseLines.findIndex((line) => /\bnpm publish\b/.test(line))
  const before = (a, b) => a !== -1 && b !== -1 && a < b
  const mechanisms = [
    before(buildAt, publishAt) && 'release.yml 在 publish 之前跑了 build',
    (scriptBuilds('prepack') || scriptBuilds('prepare')) && '`prepack` / `prepare` 会构建',
    before(testAt, publishAt) &&
      scriptBuilds('test') &&
      'release.yml 在 publish 之前跑 test，而 test 会构建',
  ].filter((item) => typeof item === 'string')
  require_(
    '发布前一定会构建（lib/ 是构建产物）',
    mechanisms.length > 0,
    '`main` / `exports` 指向 `lib/`，而它是构建产物（被 gitignore）—— publish 之前必须真的构建，' +
      '否则发出去的 tarball 里没有代码。三选一：release.yml 里 publish 之前跑 `npm run build`；' +
      '或在 package.json 里加 `prepack: npm run build`；或让 `test` 脚本先构建（而 release.yml 会跑 test）。',
  )

  // 12. 入口文件真的在（**条件式** —— 与上面 SKILL.md 那条同一套理由：判据要写清它在哪个上下文里成立）。
  //
  //     这里刻意分三种情形，而不是一律判红：「还没构建的检出」与「构建跑过却没产出入口」
  //     是两件不同的事 —— 前者是**上下文**（干净检出、`git archive` 出来的副本、CI 里 build 之前），
  //     后者才是**故障**。一律判红会把前者也判红（本仓红线 A5 正是用**不构建的干净副本**跑守卫，
  //     实测会被误判），而那种红会训练人忽略这道守卫。
  const mainTarget = typeof pkg.main === 'string' ? pkg.main.replace(/^\.\//, '') : ''
  if (mainTarget !== '') {
    const outDir = mainTarget.includes('/') ? mainTarget.slice(0, mainTarget.lastIndexOf('/')) : ''
    const outDirExists = outDir !== '' && existsSync(join(root, outDir))
    if (existsSync(join(root, mainTarget))) {
      require_(`入口文件在磁盘上（${mainTarget}）`, true, '')
    } else if (outDirExists) {
      require_(
        `入口文件在磁盘上（${mainTarget}）`,
        false,
        `构建产物目录 ${outDir}/ **在**，但入口 ${mainTarget} 不在 —— 构建跑过却没产出入口，` +
          '发出去的包会加载不到任何东西。先修构建，别发版。',
      )
    } else {
      note(
        `入口 ${mainTarget} 不在这个根下（${outDir}/ 也不在）—— 这看起来是**还没构建**的检出。` +
          '发布态里它必须存在（由上面「发布前一定会构建」那条保证）；构建过的工作树里这条 note 自动转成硬判。',
      )
    }
  }
}

/**
 * 在一份 workflow 文本里找**命令位置**上会改写版本号的调用。
 *
 * 导出是为了能被测试直接喂字符串（正反例各一条），而不是只能靠跑真 workflow —— 后者
 * 只能在 main 上 dispatch，而这条不变量要在每次 `npm test` 里就能判。
 *
 * @param source 一份 `release.yml` 的文本。
 * @returns 命中的命令行；没命中就是空数组。
 */
export function findVersionWrites(source) {
  return source
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .filter((line) => !/^\s*echo\b/.test(line))
    .filter((line) => /(npm|pnpm)\s+version\b|npm\s+pkg\s+set\b/.test(line))
    .map((line) => line.trim())
}

if (notes.length > 0) {
  console.log('\n现状说明（不阻断）：')
  for (const line of notes) console.log(`  - ${line}`)
}

console.log(`\n共判定 ${checked} 条`)

if (failures.length > 0) {
  console.error(`\nrelease check failed（${failures.length} 条不成立）：`)
  for (const line of failures) console.error(`  - ${line}`)
  process.exit(1)
}
console.log('release check passed')
