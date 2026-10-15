#!/usr/bin/env node
/**
 * 发版守卫：判断「上个 tag..HEAD」的改动有没有触及已发布产物。
 *
 * 为什么是「排除法」而不是「收录法」：未识别的路径一律算「改变产物」——
 * 宁可漏判（多让人回答一次），不误拦（把真该发的挡下来）。
 *
 * 判据是**路径**，不是语义：改注释、抽常量这类行为等价的改动也会被判成「有产物改动」。
 * 那部分交给人回答；脚本只负责把「纯文档 / 纯测试 / 纯 CI / 纯脚本」这一档干净地挡掉。
 *
 * 用法 —— stdin 收 `git diff --name-only` 的输出：
 *
 *   git diff --name-only "$(git describe --tags --abbrev=0 --match 'v[0-9]*')"..HEAD \
 *     | node scripts/release-guard.mjs
 *
 * 退出码：
 *   0 = 有产物改动，允许发版
 *   1 = 只有非产物改动（或空区间），不该发版
 *   2 = 用法错误
 *
 * 与三仓同名脚本的关系：判据同形、路径清单按本仓实际调整 —— 三仓那三份内容互不相同
 * （本仓无浏览器半边，所以没有 `scripts/build-client.mjs` 那条例外）。
 */

import { readFileSync } from 'node:fs'

const USAGE = `用法：
  git diff --name-only <上个 tag>..HEAD | node scripts/release-guard.mjs

退出码：0 = 有产物改动 / 1 = 只有非产物改动 / 2 = 用法错误`

/**
 * 这些前缀下的改动一律不进 npm 包。
 *
 * `skills/` **不在**这里 —— 它进了本包 `files`，改它就是改产物。
 */
const NON_ARTIFACT_PREFIXES = ['.agents/', '.github/', 'docs/', 'scripts/', 'test/']

/** 根级不进包的文件（或只影响工具链、不影响产物内容的文件）。 */
const NON_ARTIFACT_FILES = new Set([
  '.gitattributes',
  '.gitignore',
  '.prettierignore',
  '.prettierrc.json',
  '.pre-commit-config.yaml',
  '.node-version',
  'AGENTS.md',
  'eslint.config.mjs',
  // 包管理器面：锁文件与 workspace 声明都不进包（本仓已迁 pnpm，唯一锁文件是 pnpm-lock.yaml）。
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'vitest.config.ts',
])

/**
 * 这条路径的改动会不会改变已发布产物。
 *
 * 注意 `scripts/` 整档不进包，而本仓的构建就是 `tsc`（没有生成脚本参与产物），
 * 所以这里**不需要**「前缀里确有例外」那张表。哪天加了会产出 `lib/` 的脚本，
 * 必须把它从 `NON_ARTIFACT_PREFIXES` 里单列出来 —— 否则那条改动会被静默当成非产物。
 *
 * @param file 仓内相对路径。
 */
function changesArtifacts(file) {
  if (NON_ARTIFACT_FILES.has(file)) return false
  return !NON_ARTIFACT_PREFIXES.some((prefix) => file.startsWith(prefix))
}

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE)
  process.exit(2)
}
if (args.length > 0) {
  console.error(`无法识别的参数：${args.join(' ')}`)
  console.error(USAGE)
  process.exit(2)
}
if (process.stdin.isTTY) {
  console.error('没有从 stdin 收到改动清单。')
  console.error(USAGE)
  process.exit(2)
}

const changed = readFileSync(0, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0)

if (changed.length === 0) {
  console.log('上个 tag 到现在没有任何改动，没有什么可发的。')
  process.exit(1)
}

const artifacts = changed.filter(changesArtifacts)
const others = changed.filter((file) => !changesArtifacts(file))

if (artifacts.length > 0) console.log(`改变产物的改动 ${artifacts.length} 条：`)
for (const file of artifacts) console.log(`  - ${file}`)
if (others.length > 0) console.log(`不影响产物的改动 ${others.length} 条：`)
for (const file of others) console.log(`  - ${file}`)

if (artifacts.length === 0) {
  console.log('\n全是非产物改动，不该发版。')
  process.exit(1)
}
console.log('\n有产物改动，允许发版。')
process.exit(0)
