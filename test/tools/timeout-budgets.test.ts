/**
 * 工具超时预算：**工作量 → 预算**只有一处，工具只声明自己是哪一档。
 *
 * ## 为什么这条判据必须存在（它守的是根因，不是症状）
 *
 * 加这一档之前，六个工具各自抄一份全局数（`deps.config.timeoutMs`），而它们的活差 30 倍：
 * 跑 `--dump-config-schema` 的那个实测 10.2–15.7 s（并发 + `npm run check` 时到 32 s），
 * 其余几个最慢的一步是 0.4 s。于是 15_000 − 2_000 = 13 s 的窗口**恰好卡在 10.5 s 与 15.6 s
 * 中间**：空载能过、机器一忙必挂 —— 而这条失败是间歇性的，最容易被当成偶发。
 *
 * 所以本文件钉三件事，缺一条就会退回去：
 * 1. **两档的默认值**（带理由的下界：慢档 ≥ 60 s）；
 * 2. **映射本身**：`toolBudgetMs` 按档取值、跟着配置动、不被夹死；
 * 3. **六个工具真的走了映射**（源码扫描）：`src/tools/` 里既不许出现毫秒字面量，
 *    也不许再直接读配置里的预算字段。
 *
 * ⚠️ 第 3 条是**源码扫描**，不是「跑一遍看看」。理由：预算抄错的表现是**多等或少等**，
 * 在假 spawn 下完全看不出来（替身不耗时）；只有把「预算从哪来」当判据才拦得住。
 *
 * 扫描前的剥注释走 `helpers.ts` 的共享 `stripComments` —— 这条判据与 `test/redlines.test.ts`
 * 是**同一件事**，所以必须**同一份实现**（曾各写一份，两边都因为「块注释整段删掉导致行号前移」踩过）。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  MIN_TOOL_BUDGET_MS,
  MIN_TRANSPORT_TIMEOUT_MS,
  toolBudgetMs,
  TRANSPORT_MARGIN_MS,
  transportTimeoutMs,
  WORKLOAD_DEFAULT_BUDGET_MS,
  type Workload,
} from '../../src/lib/timeouts.ts'
import { resolveConfig } from '../../src/config.ts'
import { createCheckAuthTool } from '../../src/tools/dsh_check_auth.ts'
import { createEffectModeTool } from '../../src/tools/dsh_check_effect_mode.ts'
import { createDumpConfigTool } from '../../src/tools/dsh_dump_config.ts'
import { createDiagnosePluginLoadTool } from '../../src/tools/dsh_diagnose_plugin_load.ts'
import { createHotReloadTool } from '../../src/tools/dsh_hot_reload.ts'
import { createSignCookieTool } from '../../src/tools/dsh_sign_cookie.ts'
import { createListInstancesTool } from '../../src/tools/dsh_list_instances.ts'
import { createRestartTool, type RestartHost } from '../../src/tools/dsh_restart.ts'
import type { ReloadHost } from '../../src/lib/hot-reload.ts'
import { configFor, depsFor, stripComments } from './helpers.ts'

/** 仓根：本文件在 `test/tools/` 下。 */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** 工具文件所在目录（相对仓根）。 */
const TOOLS_DIR = 'src/tools'
/** 全部工作量档（**闭集**：加档时这里会跟着编译报错，逼人回来看这条判据）。 */
const WORKLOADS: readonly Workload[] = ['quick', 'schemaDump']

/** 慢档默认值的下界：理由与实测数字见 `src/lib/timeouts.ts` 的 `WORKLOAD_DEFAULT_BUDGET_MS`。 */
const SLOW_DEFAULT_FLOOR_MS = 60_000

/** 快档默认值（既有配置的含义，不许悄悄变）。 */
const QUICK_DEFAULT_MS = 60_000

describe('工作量 → 预算：唯一映射点的取值面', () => {
  it('两个默认值：快档 60_000、慢档 ≥ 快档 × 4（下界有理由，写在 timeouts.ts）', () => {
    expect(WORKLOAD_DEFAULT_BUDGET_MS.timeoutMs).toBe(QUICK_DEFAULT_MS)
    expect(WORKLOAD_DEFAULT_BUDGET_MS.schemaDumpTimeoutMs).toBeGreaterThanOrEqual(
      SLOW_DEFAULT_FLOOR_MS,
    )
    // 下界之外还要「不卡着点」：慢档至少是快档的 4 倍（实测典型 10.5 s ≈ 4 个旧窗口）。
    expect(WORKLOAD_DEFAULT_BUDGET_MS.schemaDumpTimeoutMs).toBeGreaterThanOrEqual(
      QUICK_DEFAULT_MS * 4,
    )
  })

  it('慢档**严格大于**快档，且两档都是正有限值（防空转：一律返回同一个数会在这里死）', () => {
    for (const workload of WORKLOADS) {
      const budget = toolBudgetMs(workload, WORKLOAD_DEFAULT_BUDGET_MS)
      expect(Number.isFinite(budget), `${workload} 的预算不是有限数`).toBe(true)
      expect(budget, `${workload} 的预算不是正数`).toBeGreaterThan(0)
    }
    const quick = toolBudgetMs('quick', WORKLOAD_DEFAULT_BUDGET_MS)
    const slow = toolBudgetMs('schemaDump', WORKLOAD_DEFAULT_BUDGET_MS)
    expect(slow, '慢档没有严格大于快档 —— 分档就白分了').toBeGreaterThan(quick)
  })

  it('配置面没被架空：往上调跟着变大；**往下填也照办**（不静默夹到默认值）', () => {
    const raised = { timeoutMs: 20_000, schemaDumpTimeoutMs: 120_000 }
    expect(toolBudgetMs('quick', raised)).toBe(20_000)
    expect(toolBudgetMs('schemaDump', raised)).toBe(120_000)

    // 两个字段**互不影响**：只改一个，另一档不动。
    expect(toolBudgetMs('schemaDump', { timeoutMs: 20_000, schemaDumpTimeoutMs: 60_000 })).toBe(
      60_000,
    )
    expect(toolBudgetMs('quick', { timeoutMs: 5_000, schemaDumpTimeoutMs: 120_000 })).toBe(5_000)

    // 用户显式填一个**小于默认值**的数：映射照办（不当成「不许」而悄悄抬回去）。
    // 这条是「别夹死用户」的另一半：夹死不只是不许往上调，也包括偷偷改掉他写的数。
    const lowered = { timeoutMs: 1_000, schemaDumpTimeoutMs: 40_000 }
    expect(toolBudgetMs('quick', lowered)).toBe(1_000)
    expect(toolBudgetMs('schemaDump', lowered)).toBe(40_000)
  })

  it('两档的传输预算都严格小于工具预算，且余量 ≥ TRANSPORT_MARGIN_MS', () => {
    // 「传输先于工具」这条纪律必须在**每一档**上成立，不只是默认那一档。
    const budgets = [
      toolBudgetMs('quick', WORKLOAD_DEFAULT_BUDGET_MS),
      toolBudgetMs('schemaDump', WORKLOAD_DEFAULT_BUDGET_MS),
      ...WORKLOADS.map((workload) =>
        toolBudgetMs(workload, {
          timeoutMs: 5_000,
          schemaDumpTimeoutMs: 120_000,
        }),
      ),
    ]
    for (const budget of budgets) {
      const transport = transportTimeoutMs(budget)
      expect(transport, `传输预算 ${String(transport)} 不是正数`).toBeGreaterThan(0)
      expect(transport, `传输预算不小于工具预算 ${String(budget)}`).toBeLessThan(budget)
      expect(budget - transport).toBeGreaterThanOrEqual(TRANSPORT_MARGIN_MS)
    }
  })

  it('小预算的边界是**推导出来的**：不变量对任何正预算成立，完整余量要 ≥ MIN_TOOL_BUDGET_MS', () => {
    // 这个数是推出来的，不是抄的：传输预算 = max(MIN_TRANSPORT, 工具预算 − 余量)，
    // 所以「余量完整」与「下限生效」的相遇点就是这两个常量之和。
    expect(MIN_TOOL_BUDGET_MS).toBe(MIN_TRANSPORT_TIMEOUT_MS + TRANSPORT_MARGIN_MS)

    // ②① 不变量本身是**全称**的：任何正预算（含 1 ms、含被 defineTool 照收的那些）都满足
    //    「传输 < 工具」。修之前这里会红：`transportTimeoutMs(1)` 曾是 250 > 1 ——
    //    而 `defineTool` 只拒非正/非有限，`timeoutMs: 1` 是**能被装上的配置**
    //    （config schema 也只是 `z.number()`），于是「传输先于工具」静默破。
    //    四个边界点（250 / 251 / 2250 / 2251）是复验者夹出来的，这里各取邻域一起钉住。
    for (const budget of [
      0,
      1,
      2,
      MIN_TRANSPORT_TIMEOUT_MS,
      MIN_TRANSPORT_TIMEOUT_MS + 1,
      MIN_TOOL_BUDGET_MS - 1,
      MIN_TOOL_BUDGET_MS,
      MIN_TOOL_BUDGET_MS + 1,
      15_000,
      60_000,
    ]) {
      const transport = transportTimeoutMs(budget)
      expect(Number.isFinite(transport), `${String(budget)} 的传输预算不是有限数`).toBe(true)
      expect(transport, `工具预算 ${String(budget)} 时传输预算为负`).toBeGreaterThanOrEqual(0)
      expect(
        transport,
        `工具预算 ${String(budget)} 时传输预算 ${String(transport)} 不小于它 —— 不变量被推翻了`,
      ).toBeLessThan(Math.max(budget, 1))
    }

    // ② 「完整余量」则有更高的门槛：低于 MIN_TOOL_BUDGET_MS 时余量被下限吃掉。
    expect(MIN_TOOL_BUDGET_MS - 1 - transportTimeoutMs(MIN_TOOL_BUDGET_MS - 1)).toBe(
      TRANSPORT_MARGIN_MS - 1,
    )
    expect(MIN_TOOL_BUDGET_MS - transportTimeoutMs(MIN_TOOL_BUDGET_MS)).toBe(TRANSPORT_MARGIN_MS)
    // 越过门槛之后余量**恒定**就是它（再给预算也不会继续变宽）。
    expect(MIN_TOOL_BUDGET_MS + 1 - transportTimeoutMs(MIN_TOOL_BUDGET_MS + 1)).toBe(
      TRANSPORT_MARGIN_MS,
    )
    // ③ 封顶**只在极小预算上咬合**（`>= 251` 时 max(250, b−2000) <= b−1 恒成立）：
    //    所以它不可能改变任何正常预算的行为。
    const firstBudgetWhereCapIsInactive = MIN_TRANSPORT_TIMEOUT_MS + 1
    expect(transportTimeoutMs(firstBudgetWhereCapIsInactive)).toBe(MIN_TRANSPORT_TIMEOUT_MS)
    expect(transportTimeoutMs(firstBudgetWhereCapIsInactive + 1)).toBe(MIN_TRANSPORT_TIMEOUT_MS)
  })

  it('配置的默认值来自同一个地方（config.ts 不许再把 15_000 / 60_000 抄一遍）', () => {
    const resolved = resolveConfig(undefined, {})
    expect(resolved.timeoutMs).toBe(WORKLOAD_DEFAULT_BUDGET_MS.timeoutMs)
    expect(resolved.schemaDumpTimeoutMs).toBe(WORKLOAD_DEFAULT_BUDGET_MS.schemaDumpTimeoutMs)
    // 自证这两个数确实不一样，否则上面两条对「抄错字段」是瞎的。
    expect(resolved.schemaDumpTimeoutMs).not.toBe(resolved.timeoutMs)
  })
})

describe('工具只声明工作量：预算一律经 toolBudgetMs 取', () => {
  /** 两个预算都**不等于默认值且彼此不同**：抄错字段 / 硬编码字面量都会在这里现形。 */
  const probeConfig = configFor('/tmp/nowhere', {
    timeoutMs: 4_242,
    schemaDumpTimeoutMs: 9_999,
  })

  /** 写侧工具要一个 `reload` 端口；构造工具**不会**调用它（定义是惰性的）。 */
  function reloadStub(): ReloadHost {
    return {
      internalAvailable: () => false,
      cache: () => undefined,
      resolveEntryUrl: async () => '',
      importFresh: async () => ({}),
      candidates: () => [],
    }
  }

  /** 行动类工具要四个宿主面；构造工具**不会**调用它们（定义是惰性的）。 */
  function restartStub(): RestartHost {
    return {
      ports: {
        fs: { read: async () => ({ status: 'absent' }), write: async () => undefined },
        restartHistory: async () => ({ known: true, value: [] }),
        busySessions: async () => ({ known: true, value: [] }),
        bundles: async () => ({ known: true, value: [] }),
        launchCommand: async () => ({
          known: true,
          value: { command: 'node', args: [], cwd: '/' },
        }),
        now: () => 0,
      },
      approval: { policyOf: () => 'never', request: async () => 'rejected' },
      launch: { relaunch: async () => ({ ok: true, detail: 'stub' }) },
      exit: { exit: () => undefined },
    }
  }

  /** 工具名 → 构造器（名字闭合，加工具时这里必须一起改）。 */
  const TOOLS: ReadonlyArray<{
    name: string
    workload: Workload
    build: () => { timeoutMs?: number }
  }> = [
    {
      name: 'dsh_check_auth',
      workload: 'quick',
      build: () => createCheckAuthTool(depsFor(probeConfig)),
    },
    {
      name: 'dsh_check_effect_mode',
      workload: 'quick',
      build: () => createEffectModeTool(depsFor(probeConfig)),
    },
    {
      name: 'dsh_diagnose_plugin_load',
      workload: 'quick',
      build: () => createDiagnosePluginLoadTool(depsFor(probeConfig)),
    },
    {
      name: 'dsh_sign_cookie',
      workload: 'quick',
      build: () => createSignCookieTool(depsFor(probeConfig)),
    },
    {
      // 写侧工具也**不许**自己定预算：它只改进程内树，属快档。
      name: 'dsh_hot_reload',
      workload: 'quick',
      build: () => createHotReloadTool({ ...depsFor(probeConfig), reload: reloadStub() }),
    },
    {
      // 发现工具（D′）：跑一条 socket 表命令 + 若干次很小的回环探测 ⇒ 快档。
      name: 'dsh_list_instances',
      workload: 'quick',
      build: () => createListInstancesTool(depsFor(probeConfig)),
    },
    {
      // 行动类工具：读两个小文件 + 跑两条 `schtasks` ⇒ 快档（它不是 dump 那种 CPU 密集的活）。
      name: 'dsh_restart',
      workload: 'quick',
      build: () => createRestartTool({ ...depsFor(probeConfig), restart: restartStub() }),
    },
    {
      // **唯一**的慢档：它跑 `--dump-config-schema`。
      name: 'dsh_dump_config',
      workload: 'schemaDump',
      build: () => createDumpConfigTool(depsFor(probeConfig)),
    },
  ]

  it('每个工具的 timeoutMs 都等于它那一档的预算（不是默认值、不是另一个字段）', () => {
    expect(TOOLS, '工具清单被人改过 —— 这条判据按名字点名，必须同批改').toHaveLength(8)
    for (const item of TOOLS) {
      const tool = item.build()
      expect(tool.timeoutMs, `${item.name} 的 timeoutMs 不是它那一档的预算`).toBe(
        toolBudgetMs(item.workload, probeConfig),
      )
    }
    // 自证两档在探针配置下**真的不同** —— 否则上面那条对一个「永远返回同一个数」的实现也是绿的。
    expect(toolBudgetMs('quick', probeConfig)).not.toBe(toolBudgetMs('schemaDump', probeConfig))
  })

  it('用户调大配置 ⇒ 每个工具的 timeoutMs 跟着变大（配置面没被架空）', () => {
    const raised = configFor('/tmp/nowhere', { timeoutMs: 30_000, schemaDumpTimeoutMs: 180_000 })
    for (const item of TOOLS) {
      const before = item.build().timeoutMs ?? 0
      const after = createWith(item.name, raised)
      expect(after, `${item.name} 没跟着配置变大`).toBeGreaterThan(before)
    }
  })

  /** 按名字用另一份配置再建一次同一个工具。 */
  function createWith(name: string, config: ReturnType<typeof configFor>): number {
    switch (name) {
      case 'dsh_check_auth':
        return createCheckAuthTool(depsFor(config)).timeoutMs ?? 0
      case 'dsh_check_effect_mode':
        return createEffectModeTool(depsFor(config)).timeoutMs ?? 0
      case 'dsh_diagnose_plugin_load':
        return createDiagnosePluginLoadTool(depsFor(config)).timeoutMs ?? 0
      case 'dsh_sign_cookie':
        return createSignCookieTool(depsFor(config)).timeoutMs ?? 0
      case 'dsh_list_instances':
        return createListInstancesTool(depsFor(config)).timeoutMs ?? 0
      case 'dsh_restart':
        return createRestartTool({ ...depsFor(config), restart: restartStub() }).timeoutMs ?? 0
      case 'dsh_hot_reload':
        return createHotReloadTool({ ...depsFor(config), reload: reloadStub() }).timeoutMs ?? 0
      case 'dsh_dump_config':
        return createDumpConfigTool(depsFor(config)).timeoutMs ?? 0
      default:
        throw new Error(`未知工具：${name}`)
    }
  }
})

// ── 源码扫描：硬验收「工具里不许再有预算字面量，也不许直接读配置」 ──────────

/** 一条工具源码。 */
interface ToolSource {
  path: string
  text: string
}

/** 预算位置上出现数字字面量 = 违规（不必去猜哪个数字是毫秒）。 */
const BUDGET_LITERAL_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'defineTool 的 timeoutMs 声明', pattern: /timeoutMs:\s*\d/u },
  { label: 'createDeadline 的总量', pattern: /createDeadline\(\s*\d/u },
  { label: 'budgetFor 的工具预算', pattern: /budgetFor\(\s*\d/u },
  { label: 'transportTimeoutMs 的工具预算', pattern: /transportTimeoutMs\(\s*\d/u },
]

/** 直接读配置里的预算字段 = 绕过唯一映射点（今天的老写法就是这样）。 */
const DIRECT_CONFIG_BUDGET = /deps\.config\.(?:timeoutMs|schemaDumpTimeoutMs)\b/u

/** 工具声明的工作量档。 */
const WORKLOAD_DECLARATION = /const WORKLOAD: Workload = '(\w+)'/u

/**
 * 扫一组工具源码，返回违规（`路径:行 → 说明`）。
 *
 * @param sources 工具源码。
 */
function judgeBudgetSources(sources: readonly ToolSource[]): string[] {
  const offenders: string[] = []
  for (const { path, text } of sources) {
    const code = stripComments(text)
    code.split('\n').forEach((line, index) => {
      const at = `${path}:${String(index + 1)}`
      for (const { label, pattern } of BUDGET_LITERAL_PATTERNS) {
        if (pattern.test(line)) offenders.push(`${at} → ${label} 出现了字面量：${line.trim()}`)
      }
      if (DIRECT_CONFIG_BUDGET.test(line)) {
        offenders.push(`${at} → 直接拿配置当预算（应走 toolBudgetMs）：${line.trim()}`)
      }
    })
  }
  return offenders
}

/**
 * 读工具目录下的源码。
 *
 * 同时把「目录里到底有哪些文件」self-proof 出来：读成空 ⇒ 判据空转（活跃坑 18 的 skip 族）。
 */
function readToolSources(): ToolSource[] {
  const dir = join(REPO_ROOT, TOOLS_DIR)
  return readdirSync(dir)
    .filter((name) => name.endsWith('.ts'))
    .sort()
    .map((name) => ({
      path: `${TOOLS_DIR}/${name}`,
      text: readFileSync(join(dir, name), 'utf8'),
    }))
}

describe('源码扫描：预算只在 lib/timeouts.ts 里，工具只声明工作量', () => {
  const sources = readToolSources()
  /** 七个工具文件（`dsh_*.ts`）；`index.ts` / `shared.ts` / `describe.ts` 不是工具。 */
  const toolFiles = sources.filter((item) => item.path.includes('/dsh_'))

  it('自证扫到了东西：工具目录非空、八个工具文件都在且都不是空文件', () => {
    expect(sources.length, '居然扫出 0 个文件 —— 路径写错了，下面全是空转').toBeGreaterThan(6)
    expect(
      toolFiles.map((item) => item.path.replace(`${TOOLS_DIR}/`, '')).sort(),
      '工具文件清单变了 —— 新工具必须声明工作量，请同批补进本文件与 timeout-budgets 的清单',
    ).toEqual([
      'dsh_check_auth.ts',
      'dsh_check_effect_mode.ts',
      'dsh_diagnose_plugin_load.ts',
      'dsh_dump_config.ts',
      'dsh_hot_reload.ts',
      'dsh_list_instances.ts',
      'dsh_restart.ts',
      'dsh_sign_cookie.ts',
    ])
    for (const item of toolFiles) {
      expect(item.text.length, `${item.path} 读出来是空的`).toBeGreaterThan(200)
    }
  })

  it('工具源码里没有预算字面量，也没有直接读配置的预算字段', () => {
    const offenders = judgeBudgetSources(sources)
    expect(
      offenders,
      `预算只能来自 lib/timeouts.ts 的 toolBudgetMs：\n${offenders.join('\n')}`,
    ).toEqual([])
  })

  it('每个工具各自声明一次工作量，且**慢档只有 dump_config 一个**', () => {
    const declared = toolFiles.map((item) => ({
      path: item.path,
      workload: WORKLOAD_DECLARATION.exec(stripComments(item.text))?.[1],
      routes: item.text.includes('toolBudgetMs(WORKLOAD'),
    }))
    for (const item of declared) {
      expect(item.workload, `${item.path} 没有声明工作量档`).toBeDefined()
      expect(WORKLOADS, `${item.path} 声明的档不在闭集里`).toContain(item.workload)
      // 光声明不算数：每个预算位置都得**真的**经映射取。
      expect(item.routes, `${item.path} 声明了工作量却没走 toolBudgetMs`).toBe(true)
    }
    const slow = declared.filter((item) => item.workload === 'schemaDump')
    expect(
      slow.map((item) => item.path),
      '慢档不再是 dump_config 一个 —— 分档的前提变了',
    ).toEqual([`${TOOLS_DIR}/dsh_dump_config.ts`])
  })

  it('判据可被否证：注入字面量 / 直接读配置 → 红；只在注释里出现 → 不误报', () => {
    const bad: ToolSource = {
      path: 'src/tools/dsh_fake.ts',
      text: [
        'const a = { timeoutMs: 15_000 }',
        'const b = createDeadline(deps.config.timeoutMs, deps.now)',
        'const c = budgetFor(9_999, deadline)',
        'const d = transportTimeoutMs(1_234)',
      ].join('\n'),
    }
    expect(judgeBudgetSources([bad])).toHaveLength(4)

    const commented: ToolSource = {
      path: 'src/tools/dsh_fake.ts',
      text: [
        '/** 说明：`timeoutMs: 15_000` 这种写法已经不许了。 */',
        '// const b = createDeadline(deps.config.timeoutMs, deps.now)',
        "const WORKLOAD: Workload = 'quick'",
        'const ok = { timeoutMs: toolBudgetMs(WORKLOAD, deps.config) }',
        // 行尾注释：只剥「整行 //」的旧写法会在这里**假红**。
        'const fine = 1 // 历史写法是 timeoutMs: 15_000，早就不许了',
        // 行内块注释：剥块注释不能把整段删掉，否则后面的行号会前移。
        'const alsoFine = { /* timeoutMs: 7_777 */ timeoutMs: toolBudgetMs(WORKLOAD, deps.config) }',
        // URL 里的 `//` 不是注释起点：不防它就会把这一行**后半段**吞掉。
        "const url = 'http://127.0.0.1:3080' // 探这个端口",
      ].join('\n'),
    }
    expect(judgeBudgetSources([commented]), '注释里的例子被当成真代码了').toEqual([])

    // 反面：URL 那行的**后面**若真出现违规，不许被 URL 里的 `//` 吞掉（假绿比假红坏）。
    const afterUrl: ToolSource = {
      path: 'src/tools/dsh_fake.ts',
      text: "const url = 'http://x' ; const b = { timeoutMs: 15_000 }",
    }
    expect(judgeBudgetSources([afterUrl]), 'URL 里的 // 把同一行后面的真违规吞掉了').toHaveLength(1)
  })

  it('报出的**行号**与真实文件对齐（块注释换成空格，不整段删）', () => {
    // 两种写法都造出来：删掉整段块注释会让后面所有行号前移（实测偏移 87 行）。
    const withBlock: ToolSource = {
      path: 'src/tools/dsh_fake.ts',
      text: [
        '/**',
        ' * 第一行',
        ' * 第二行',
        ' */',
        'const ok = 1',
        'const bad = { timeoutMs: 15_000 }',
      ].join('\n'),
    }
    // 违规在**第 6 行**（手工数出来的）。旧写法会报第 3 行。
    expect(judgeBudgetSources([withBlock])).toEqual([
      expect.stringContaining('src/tools/dsh_fake.ts:6'),
    ])

    // 真实文件上也对一遍：拿 src/tools/dsh_dump_config.ts 的 `const WORKLOAD` 行当锚点，
    // 判据报出的行号必须与 `indexOf` 数出来的真实行号**逐字相等**。
    const dumpConfig = sources.find((item) => item.path.endsWith('dsh_dump_config.ts'))
    expect(dumpConfig, '工具源码没读到 —— 下面这条是空转').toBeDefined()
    const rawLines = (dumpConfig?.text ?? '').split('\n')
    const workloadLine = rawLines.findIndex((line) => line.includes('const WORKLOAD: Workload')) + 1
    expect(workloadLine, '锚点行没找到 —— 判据与文件都对不上了').toBeGreaterThan(0)
    // 把「违规」注入到锚点那一行的真实内容里，看报出来的行号是不是锚点行。
    const injected: ToolSource = {
      path: dumpConfig?.path ?? '',
      text: rawLines
        .map((line, index) =>
          index === workloadLine - 1 ? `${line} const b = { timeoutMs: 15_000 }` : line,
        )
        .join('\n'),
    }
    expect(judgeBudgetSources([injected])).toEqual([
      expect.stringContaining(`:${String(workloadLine)} →`),
    ])
  })
})

/**
 * ## 本判据自己的**已知限度** → 归入正典表，本文件不再自留一份
 *
 * 三条（① 跨行字面量 ② 别名读配置的预算字段 ③ 字符串拼字段名 —— 方向都是**假绿**）
 * 现在编号在 `test/redlines.test.ts` 文末「本文件的已知限度」表的 **#38**，
 * 与 B10 / B15 那族限度放在一起 —— 那是本仓判据限度的**唯一正典处**（一处一事实）。
 * 取舍同理：宁可少抓，也不用近似匹配制造假红（假红会让人把判据删掉）；要收紧就上 AST。
 */
