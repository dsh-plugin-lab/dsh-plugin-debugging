/**
 * s3-harness.mjs —— S3 行为面驱动器（Node，真机）。
 *
 * 干什么：`import` 本仓的**构建产物** `lib/index.js`，用一个最小 ctx 替身捕获
 * `ctx.tools.register` 收到的工具，然后对**真实 bench 实例**逐个跑 `execute`，断言：
 *   ① 永不 throw；② 返回结构合法；③ 每个工具至少一条成功 + 一条预期内失败；
 *   ④ `nextStep` 存在且非空；⑤ **观测与推断不许混**（`observation.mode`）。
 *
 * 关于 `process.argv[1]`（**不是 hack，是复现宿主条件**）：
 * 工具用 `resolveDshLaunch()` 决定怎么再起一个 dsh —— 宿主里 `process.argv[1]` 就是
 * `…/@deepseek-ai/dsh/lib/bin.js`，于是它用「同一个 node + 同一个 bin.js」起子进程。
 * 而 `lib/exec.ts` 的 spawn **没有** `shell: true`，Windows 上 `spawn('dsh')` 不解析
 * `dsh.cmd`。所以本 harness 把 `process.argv[1]` 设成真实 bin.js 路径，**精确复现宿主里的形状**；
 * 否则会把「Windows 上 spawn 不到 .cmd」误判成本插件的问题。
 *
 * 关于 loader 替身：工具侧走 `ctx.get('loader')` → `loader.entries()` → `entry.fiber.state`
 * （见 `src/lib/loader.ts`）。本 harness 因此能给出**两个方向**的 ctx：
 *   - `loader: 'present'` → 造一棵假树 → 工具应报 `observation.mode === 'observed'`
 *   - `loader: 'absent'`  → 接不到 loader → 工具应报 `mode === 'inferred'`
 *
 * 关于 `auth` 的两条判据：本机 web 实例的 `/` **不带 cookie 就是 401**（实测），
 * 所以对真实例期望的是 `fail` + `kind: 'auth'`（**服务在、认证没过**，这是正确行为不是缺陷）；
 * 走 `ok` 分支要另起一个**答 200 的夹具服务器**。
 *
 * 用法：
 *   node test/integration/s3-harness.mjs <repoRoot> <livePort> [outJson]
 * 环境：
 *   DSH_HOME         —— bench 的 home（必填）
 *   S3_DSH_BIN       —— 真实 dsh 的 lib/bin.js 绝对路径（必填）
 *   S3_FIXTURE_PORT  —— 夹具服务器端口（默认 18396）
 */

import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'

const repoRoot = process.argv[2]
const livePort = Number(process.argv[3])
const outJson = process.argv[4]
const benchHome = process.env.DSH_HOME
const dshBin = process.env.S3_DSH_BIN
const fixturePort = Number(process.env.S3_FIXTURE_PORT ?? 18396)

if (!repoRoot || !Number.isSafeInteger(livePort) || livePort <= 0 || !benchHome || !dshBin) {
  console.error(
    'usage: node s3-harness.mjs <repoRoot> <livePort> [outJson]  (env: DSH_HOME, S3_DSH_BIN)',
  )
  process.exit(2)
}

// 复现宿主形状：argv[1] = dsh 的 bin.js
process.argv[1] = dshBin
// 「三条端口来源都没有」这一档要求环境里也不给端口
delete process.env.DSH_WEB_URL

const CLOSED_KINDS = new Set([
  'not-running',
  'auth',
  'not-found',
  'not-configured',
  'timeout',
  'command-failed',
  'cancelled',
  'internal',
])

const mod = await import(pathToFileURL(join(repoRoot, 'lib', 'index.js')).href)

/** 造一棵假 Loader 树（形状对齐 `src/lib/loader.ts` 的 `snapshotEntry`）。 */
function fakeLoader(entries) {
  return {
    entries() {
      return entries
    },
  }
}

/**
 * 用一份配置换一组「被捕获的工具」。
 *
 * @param config 插件配置。
 * @param loaderMode `'present'` = 接得上 loader；`'absent'` = 接不上。
 */
function toolsFor(config, loaderMode = 'absent') {
  const captured = []
  const loader =
    loaderMode === 'present'
      ? fakeLoader([
          {
            options: { id: 'include:dsh-plugin-debugging', name: 'dsh-plugin-debugging' },
            disabled: false,
            fiber: { state: 2 },
          },
          {
            options: {
              id: 'include:working-directory',
              name: '@deepseek-ai/dsh-working-directory',
            },
            disabled: false,
            fiber: { state: 2 },
          },
        ])
      : undefined
  const ctx = {
    // skills 一律不提供 → 技能半边走 no-registry 降级；工具半边不受影响
    get: (name) => (name === 'loader' ? loader : undefined),
    effect: () => {},
    tools: { register: (t) => captured.push(t) },
  }
  mod.apply(ctx, config)
  return captured
}

const baseConfig = { dshHome: benchHome, profile: 'bench', port: 0, timeoutMs: 30_000 }

const cases = [
  // ── dsh_check_effect_mode ──────────────────────────────────────────
  {
    id: 'effect/success-hmr-on',
    tool: 'dsh_check_effect_mode',
    config: { ...baseConfig, profile: 'bench' },
    args: { change: 'config' },
    expect: 'ok',
    check: (r) =>
      r.data?.hmr?.usable === true && r.data?.mode === 'hot' && r.data?.downgraded === false,
    checkWhy: 'hmr 在 → 配置改动判热生效、不降级',
  },

  {
    id: 'effect/HMR-GATE-no-hmr',
    tool: 'dsh_check_effect_mode',
    config: { ...baseConfig, profile: 'bench-nohmr' },
    args: { change: 'config' },
    expect: 'ok',
    check: (r) =>
      r.data?.hmr?.usable === false &&
      r.data?.mode === 'restart-required' &&
      r.data?.downgraded === true,
    checkWhy: 'hmr disabled → 任何「热生效」必须降级成 restart-required',
  },

  {
    id: 'effect/fail-cancelled',
    tool: 'dsh_check_effect_mode',
    config: { ...baseConfig, profile: 'bench-nohmr' },
    args: { change: 'config' },
    expect: 'fail',
    expectKind: 'cancelled',
    abort: true,
    checkWhy: '调用方取消 → cancelled（不可重试）',
  },

  // ── dsh_diagnose_plugin_load（**观测 vs 推断**）────────────────────
  {
    id: 'diagnose/OBSERVED-success',
    tool: 'dsh_diagnose_plugin_load',
    config: { ...baseConfig },
    args: { package: 'dsh-plugin-debugging', port: livePort },
    expect: 'ok',
    loader: 'present',
    check: (r) => {
      const o = r.data?.observation
      const pkgs = r.data?.packages ?? []
      return o?.mode === 'observed' && pkgs.some((p) => 'observed' in p)
    },
    checkWhy: '接得上 loader → mode=observed 且 packages[].observed 存在',
  },

  {
    id: 'diagnose/INFERRED-degraded',
    tool: 'dsh_diagnose_plugin_load',
    config: { ...baseConfig },
    args: { package: 'dsh-plugin-debugging', port: livePort },
    expect: 'ok',
    loader: 'absent',
    check: (r) => {
      const o = r.data?.observation
      const pkgs = r.data?.packages ?? []
      return (
        o?.mode === 'inferred' &&
        typeof o.note === 'string' &&
        o.note.includes('未能直接观测') &&
        pkgs.length > 0 &&
        pkgs.every((p) => !('observed' in p))
      )
    },
    checkWhy:
      '接不上 loader → mode=inferred、note 说明「未能直接观测」、且 packages[].observed 整个不出现（观测与推断不许混）',
  },

  {
    id: 'diagnose/fail-not-found',
    tool: 'dsh_diagnose_plugin_load',
    config: { ...baseConfig, profile: 'no-such-profile' },
    args: {},
    expect: 'fail',
    checkWhy: 'profile 不存在 → not-found',
  },

  // ── dsh_check_auth ─────────────────────────────────────────────────
  {
    id: 'auth/EXPECTED-auth-401',
    tool: 'dsh_check_auth',
    config: { ...baseConfig },
    args: { port: livePort },
    expect: 'fail',
    expectKind: 'auth',
    check: (r) => /401/.test(r.error?.message ?? ''),
    checkWhy: '真实例 `/` 无 cookie = 401 → auth（服务在、认证没过），不是 not-running',
  },

  {
    id: 'auth/success-200',
    tool: 'dsh_check_auth',
    config: { ...baseConfig },
    args: { port: fixturePort },
    expect: 'ok',
    check: (r) => r.data?.probe?.kind === 'ok' || r.data?.verdict === '服务在、认证通过',
    checkWhy: '答 200 的夹具服务器 → ok（服务在、认证通过）',
  },

  {
    id: 'auth/fail-not-running',
    tool: 'dsh_check_auth',
    config: { ...baseConfig },
    args: { port: 18399 },
    expect: 'fail',
    expectKind: 'not-running',
    checkWhy: '没人监听 → not-running',
  },

  {
    id: 'auth/fail-not-configured',
    tool: 'dsh_check_auth',
    config: { ...baseConfig },
    args: {},
    expect: 'fail',
    expectKind: 'not-configured',
    checkWhy: '三条端口来源都没有 → not-configured',
  },

  // ── dsh_dump_config ────────────────────────────────────────────────
  {
    id: 'dump/success',
    tool: 'dsh_dump_config',
    config: { ...baseConfig },
    args: { profile: 'bench' },
    expect: 'ok',
    checkWhy: '正常 profile → ok',
  },

  {
    id: 'dump/fail-composition-error',
    tool: 'dsh_dump_config',
    config: { ...baseConfig },
    args: { profile: 'bench-badpatch' },
    expect: 'fail',
    expectKind: 'command-failed',
    check: (r) => /组合期错|skipping|not found|actionable/i.test(JSON.stringify(r)),
    checkWhy: '组合期错（patch 指向不存在的 id）必须被判成失败 —— 退出码仍是 0',
  },

  {
    id: 'dump/fail-no-such-profile',
    tool: 'dsh_dump_config',
    config: { ...baseConfig },
    args: { profile: 'no-such-profile' },
    expect: 'fail',
    checkWhy: 'profile 不存在 → 失败',
  },
]

// ── 夹具服务器：一个答 200 的探测目标 ────────────────────────────────
let fixture
try {
  fixture = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('s3-harness fixture\n')
  })
  await new Promise((resolve, reject) => {
    fixture.once('error', reject)
    fixture.listen(fixturePort, '127.0.0.1', resolve)
  })
  console.log(`fixture server: http://127.0.0.1:${String(fixturePort)}/ (200)`)
} catch (e) {
  console.error(`fixture server 起不来：${String(e)}`)
  process.exit(2)
}

const results = []
let hardFailures = 0

for (const c of cases) {
  const tools = toolsFor(c.config, c.loader ?? 'absent')
  const tool = tools.find((t) => t.name === c.tool)
  const row = { id: c.id, tool: c.tool, threw: false, shapeOk: false, nextStepOk: false }

  if (tool === undefined) {
    row.threw = true
    row.error = `工具未注册：${c.tool}（captured: ${tools.map((t) => t.name).join(',')}）`
    hardFailures += 1
    results.push(row)
    continue
  }

  const ac = new AbortController()
  if (c.abort === true) ac.abort(c.abortReason ?? new Error('harness: deliberate abort'))
  const exec = { signal: ac.signal }

  let res
  const t0 = Date.now()
  try {
    res = await tool.execute(c.args, exec)
  } catch (e) {
    row.threw = true
    row.error = `execute 抛了：${(e && e.stack) || String(e)}`
  }
  row.ms = Date.now() - t0

  if (!row.threw) {
    row.result = res
    const isObj = typeof res === 'object' && res !== null
    const okFlag = isObj && typeof res.ok === 'boolean'
    let shapeOk = okFlag
    if (okFlag === true && res.ok === true) {
      shapeOk = 'data' in res
      row.verdict = 'ok'
    } else if (okFlag === true && res.ok === false) {
      const e = res.error
      shapeOk =
        typeof e === 'object' &&
        e !== null &&
        typeof e.kind === 'string' &&
        CLOSED_KINDS.has(e.kind) &&
        typeof e.message === 'string' &&
        e.message.length > 0 &&
        typeof e.hint === 'string' &&
        e.hint.length > 0
      row.verdict = `fail:${e?.kind}`
      row.kind = e?.kind
    }
    row.shapeOk = shapeOk

    const ns = res.nextStep
    row.nextStepOk =
      typeof ns === 'object' &&
      ns !== null &&
      typeof ns.why === 'string' &&
      ns.why.trim().length > 0
    row.nextStep = ns ?? null

    const expectOk =
      (c.expect === 'ok' && res.ok === true) || (c.expect === 'fail' && res.ok === false)
    const kindOk = c.expectKind === undefined ? true : res.ok === false && row.kind === c.expectKind
    const customOk = c.check === undefined ? true : c.check(res)
    row.expectOk = expectOk && kindOk && customOk
    row.checks = { expectOk, kindOk, customOk, checkWhy: c.checkWhy ?? null }
  }

  const passed = !row.threw && row.shapeOk && row.nextStepOk && row.expectOk
  row.passed = passed
  if (!passed) hardFailures += 1
  results.push(row)
}

// ── 报告 ────────────────────────────────────────────────────────────
const summary = {
  at: new Date().toISOString(),
  repoRoot,
  livePort,
  fixturePort,
  benchHome,
  dshBin,
  capturedTools: toolsFor(baseConfig, 'absent').map((t) => t.name),
  total: results.length,
  passed: results.filter((r) => r.passed).length,
  failed: hardFailures,
  results,
}

if (outJson) writeFileSync(outJson, JSON.stringify(summary, null, 2), 'utf8')

for (const r of results) {
  const mark = r.passed ? 'PASS' : 'FAIL'
  const shape = `shape=${r.shapeOk ? 'y' : 'n'} nextStep=${r.nextStepOk ? 'y' : 'n'}`
  console.log(
    `[${mark}] ${r.id.padEnd(32)} verdict=${String(r.verdict ?? '-').padEnd(18)} ${shape} ${String(r.ms ?? '-')}ms${r.error ? ' :: ' + r.error : ''}`,
  )
}
console.log(
  `\ncaptured tools (${summary.capturedTools.length}): ${summary.capturedTools.join(', ')}`,
)
console.log(`passed ${summary.passed}/${summary.total}`)

await new Promise((resolve) => fixture.close(resolve))
process.exit(hardFailures === 0 ? 0 : 1)
