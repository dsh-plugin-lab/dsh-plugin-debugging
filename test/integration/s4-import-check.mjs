/**
 * s4-import-check.mjs —— S4-2：解包目录里的 `lib/index.js` 能不能 import，且**无副作用**。
 *
 * 权威证据是**文件系统快照**（import 前后目录与 cwd 逐一对比）；
 * 网络/子进程的探测是**尽力而为**的钩子（ESM 对 CJS 内建的命名导入在链接期就绑定，
 * 事后改 `fs.writeFileSync` 未必影响已链接的绑定）—— 两者都打印，并在报告里分开标注。
 *
 * 用法：
 *   node test/integration/s4-import-check.mjs <unpackedRoot> <scratchCwd> [outJson]
 */

import { readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

// 必须走 createRequire 拿 CJS 对象：`import * as net` 得到的是 ESM 命名空间，
// 其属性是只读的（实测 `TypeError: Cannot assign to read only property 'request'`）。
const require = createRequire(import.meta.url)
const net = require('node:net')
const http = require('node:http')
const https = require('node:https')
const cp = require('node:child_process')

const unpackedRoot = process.argv[2]
const scratchCwd = process.argv[3]
const outJson = process.argv[4]

if (!unpackedRoot || !scratchCwd) {
  console.error('usage: node s4-import-check.mjs <unpackedRoot> <scratchCwd> [outJson]')
  process.exit(2)
}

const effects = []
const note = (kind, detail) => effects.push({ kind, detail })

// ── 尽力而为的钩子（在 import 之前装）────────────────────────────────
const realConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  note('net-connect', JSON.stringify(args[0] ?? null).slice(0, 200))
  return realConnect.apply(this, args)
}
for (const [name, mod] of [
  ['http', http],
  ['https', https],
]) {
  for (const fn of ['request', 'get']) {
    const real = mod[fn]
    mod[fn] = function (...args) {
      note(`${name}-${fn}`, JSON.stringify(args[0] ?? null).slice(0, 200))
      return real.apply(this, args)
    }
  }
}
for (const fn of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const real = cp[fn]
  cp[fn] = function (...args) {
    note(`child_process-${fn}`, String(args[0]).slice(0, 200))
    return real.apply(this, args)
  }
}

/** 递归快照一个目录（名字 + 大小 + mtime），用于前后对比。 */
function snapshot(root) {
  const rows = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        rows.push(`${relative(root, p)}/`)
        walk(p)
      } else {
        let st
        try {
          st = statSync(p)
        } catch {
          rows.push(`${relative(root, p)}|?`)
          continue
        }
        rows.push(`${relative(root, p)}|${st.size}|${st.mtimeMs}`)
      }
    }
  }
  walk(root)
  return rows
}

mkdirSync(scratchCwd, { recursive: true })
const beforeUnpacked = snapshot(unpackedRoot)
const beforeScratch = snapshot(scratchCwd)

const entry = join(unpackedRoot, 'lib', 'index.js')
let importOk = false
let importError = null
let exportsSeen = null
const t0 = Date.now()
try {
  const mod = await import(pathToFileURL(entry).href)
  importOk = true
  exportsSeen = Object.keys(mod).sort()
} catch (e) {
  importError = String((e && e.stack) || e)
}
const ms = Date.now() - t0

const afterUnpacked = snapshot(unpackedRoot)
const afterScratch = snapshot(scratchCwd)

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])

const report = {
  at: new Date().toISOString(),
  entry,
  importOk,
  importError,
  ms,
  exportsSeen,
  unpackedUnchanged: same(beforeUnpacked, afterUnpacked),
  unpackedBefore: beforeUnpacked.length,
  unpackedAfter: afterUnpacked.length,
  scratchUnchanged: same(beforeScratch, afterScratch),
  scratchBefore: beforeScratch.length,
  scratchAfter: afterScratch.length,
  scratchDiff: afterScratch.filter((x) => !beforeScratch.includes(x)),
  detectedEffects: effects,
  effectsNote:
    '这些钩子是尽力而为的（ESM 对 CJS 内建的命名导入在链接期绑定）。权威证据是 unpackedUnchanged / scratchUnchanged 两个快照。',
}

if (outJson) writeFileSync(outJson, JSON.stringify(report, null, 2), 'utf8')

console.log(`entry          = ${entry}`)
console.log(`importOk       = ${importOk}  (${ms}ms)`)
if (importError) console.log(`importError    = ${importError}`)
console.log(`exports        = ${(exportsSeen ?? []).join(', ')}`)
console.log(
  `unpacked 未变  = ${report.unpackedUnchanged} (${report.unpackedBefore} → ${report.unpackedAfter} 条)`,
)
console.log(
  `scratch 未变   = ${report.scratchUnchanged} (${report.scratchBefore} → ${report.scratchAfter} 条)`,
)
if (report.scratchDiff.length > 0) console.log(`scratch 新增   = ${report.scratchDiff.join(', ')}`)
console.log(`探测到的副作用 = ${effects.length === 0 ? '无' : JSON.stringify(effects)}`)

process.exit(importOk && report.unpackedUnchanged && report.scratchUnchanged ? 0 : 1)
