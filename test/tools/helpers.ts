/**
 * `test/tools/**` 的共用夹具。
 *
 * 两条纪律：
 * 1. **不依赖真机**：`$DSH_HOME` 用临时目录现造，profile / 凭证 / 日志都是写出来的假文件；
 * 2. **不 mock 类**：外部 IO 只从注入点进（`spawn` / `fetch`），
 *    其余（文件系统）用真的 —— 打真文件比打替身更能照出路径拼接的错。
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect } from 'vitest'

import type { ResolvedConfig } from '../../src/contracts.ts'
import { WORKLOAD_DEFAULT_BUDGET_MS } from '../../src/lib/timeouts.ts'
import { observeCarrier, type CarrierKind, type CarrierObservation } from '../../src/lib/carrier.ts'
import type { CommandResult, RunCommandOptions, SpawnImpl } from '../../src/lib/exec.ts'
import type { FetchImpl } from '../../src/lib/http.ts'
import { createToolDeps, type ToolDeps } from '../../src/tools/shared.ts'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue, NextStep, ToolData, ToolResult } from '../../src/lib/errors.ts'
import type { LoaderEntrySnapshot } from '../../src/lib/fiber.ts'
import type { LoaderReadResult } from '../../src/lib/loader.ts'

/** 建过的临时目录，测试结束统一清掉。 */
const created: string[] = []

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
})

/** 造一个临时 `$DSH_HOME`。 */
export async function tempDshHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-debug-test-'))
  created.push(dir)
  return dir
}

/** 写一个 JSON 文件（自动建父目录）。 */
export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, JSON.stringify(value, null, 2))
}

/** 写一个文本文件（自动建父目录）。 */
export async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, 'utf8')
}

/** 建一个目录软链（Windows 上用 junction，不需要管理员权限）。 */
export async function linkDir(target: string, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await symlink(target, path, 'junction')
}

/** 写一份 profile 的 `package.json`。 */
export async function writeProfile(
  dshHome: string,
  profile: string,
  value: { bundles?: string[]; dependencies?: Record<string, string> },
): Promise<string> {
  const dir = join(dshHome, 'profiles', profile)
  await writeJson(join(dir, 'package.json'), {
    name: `dsh-profile-${profile}`,
    dsh: { profile: { bundles: value.bundles ?? [] } },
    dependencies: value.dependencies ?? {},
  })
  return dir
}

/**
 * 造一个已安装的包（`node_modules/<pkg>` + 产物文件）。
 *
 * @param profileDir profile 目录。
 * @param packageName 包名。
 * @param options `entry` 为假时不写产物文件（用来造「entry 不在」）。
 */
export async function writeInstalledPackage(
  profileDir: string,
  packageName: string,
  options: { entry?: string; writeEntryFile?: boolean; patch?: string } = {},
): Promise<string> {
  const packageDir = join(profileDir, 'node_modules', ...packageName.split('/'))
  const entry = options.entry ?? './lib/index.js'
  await writeJson(join(packageDir, 'package.json'), {
    name: packageName,
    version: '0.0.1',
    main: entry,
    ...(options.patch === undefined ? {} : { dsh: { bundle: { patch: options.patch } } }),
  })
  if (options.writeEntryFile !== false) await writeText(join(packageDir, entry), '// 产物\n')
  if (options.patch !== undefined) await writeText(join(packageDir, options.patch), '[]\n')
  return packageDir
}

/**
 * 造一个**活引用**（`Volatile<T>` 就是 `{ get(): T }`）。
 *
 * 为什么夹具里手搓而不是喂字面量：`Config.enableRestart` 的类型是 `Volatile<boolean>`
 * （宿主那侧的可变引用，正是「改开关不用重启」那条要求在 schema 上的落点），
 * 喂 `true` 编译就红 —— 那份类型不该被夹具绕开。
 *
 * @param value 当前值。
 */
export function volatileOf<T>(value: T): { get(): T } {
  return { get: () => value }
}

/**
 * 造配置。
 *
 * 两个预算的默认值**引用 `lib/timeouts.ts`**（一处一事实）：夹具不该把 15_000 / 60_000
 * 再抄一遍 —— 抄一遍就会出现「默认值改了、夹具还按旧值跑」这种**判据滞后于实现**的假绿。
 * 要断言具体数字的用例（`timeout-budgets.test.ts`）用**字面量**，不用这里的默认值。
 */
export function configFor(
  dshHome: string,
  overrides: Partial<ResolvedConfig> = {},
): ResolvedConfig {
  return {
    dshHome,
    dshHomeSource: 'config',
    profile: 'web',
    port: 0,
    timeoutMs: WORKLOAD_DEFAULT_BUDGET_MS.timeoutMs,
    schemaDumpTimeoutMs: WORKLOAD_DEFAULT_BUDGET_MS.schemaDumpTimeoutMs,
    // 总闸**默认关**（维护者 2026-10-15 拍板）：夹具照它写，于是「忘了覆盖」
    // 的那些用例会静默走成被拒 —— 那正好与真实默认一致，是本仓最典型的假绿形状。
    // 要测「开着的那条路」的用例必须**显式**覆盖它（形态是活引用，见 {@link volatileOf}）。
    enableRestart: volatileOf(false),
    ...overrides,
  }
}

/** 造 deps（IO 用假实现，其余默认）。 */
export function depsFor(
  config: ResolvedConfig,
  overrides: {
    spawn?: SpawnImpl
    fetch?: FetchImpl
    env?: NodeJS.ProcessEnv
    now?: () => number
    loader?: () => LoaderReadResult
    carrier?: CarrierObservation
  } = {},
): ToolDeps {
  return createToolDeps(config, {
    spawn: overrides.spawn ?? neverSpawn(),
    fetch: overrides.fetch ?? neverFetch,
    env: overrides.env ?? {},
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
    ...(overrides.loader === undefined ? {} : { loader: overrides.loader }),
    // ⚠️ **不注入就落 `UNKNOWN_CARRIER`**（`createToolDeps` 的兜底）：那是 fail-closed 的
    // 那一端 —— 忘了注入的用例会在 `dsh_restart` 闸④上响亮失败，而不是悄悄拿到一条
    // 它在真机上并不拥有的回归路线（`task-scheduler`）。凡是断言「能拉起」的用例
    // **必须**显式给 `carrierOf('cli')`。
    ...(overrides.carrier === undefined ? {} : { carrier: overrides.carrier }),
  })
}

/**
 * 造一个**指定载体**的观测 —— 判据里注入载体用。
 *
 * ## 为什么是「派生」而不是手搓字面量
 *
 * 手搓 `{kind, profile, platform, rule, evidence}` 会成为 `observeCarrier` 之外的
 * **第二份事实源**：将来加一条判据时，夹具仍然喂着旧形状，于是判据在真机上失效而测试全绿
 * （本仓「判据滞后于实现」那一族）。所以这里一律经 `observeCarrier` 走真实判据，
 * 只把输入换掉。
 *
 * ## 为什么不读当前进程
 *
 * `argv` / `env` / `profileContext` 全部**显式给**：夹具必须是封闭的，
 * 否则「本机 argv[1] 恰好是什么」会悄悄决定判据走哪一支（坑 24 / 坑 40 的同族）。
 *
 * @param kind 要造的载体（`unknown` = 什么都没观测到）。
 * @param platform 平台（默认 `win32`，让「已实测的那条路线」在任意机器上都能被表达）。
 */
export function carrierOf(kind: CarrierKind, platform = 'win32'): CarrierObservation {
  switch (kind) {
    case 'cli':
      return observeCarrier({
        argv: ['node', '/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'],
        env: {},
        platform,
        profileContext: { name: 'web' },
      })
    case 'desktop-host':
      return observeCarrier({
        argv: [
          'node',
          '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js',
        ],
        env: {},
        platform,
        profileContext: { name: 'desktop' },
      })
    case 'unknown':
      return observeCarrier({ argv: ['node'], env: {}, platform })
  }
}

/**
 * 造一个「观测得到」的 loader 替身。
 *
 * 直接喂 `LoaderEntrySnapshot[]`，不模拟宿主结构 —— 结构那一层由 `loader.test.ts` 单独打。
 *
 * @param entries 快照数组。
 */
export function loaderWith(entries: LoaderEntrySnapshot[]): () => LoaderReadResult {
  return () => ({ ok: true, entries })
}

/**
 * 造一个「降级」的 loader 替身。
 *
 * 默认 `reason` 必须**英文且短**：它会逐字进模型可见的 L2（`reason: …`），
 * 而红线 B16 把「两份 fixture 里都出现、且 ≥40 字符的行」判红 —— 替身里的默认值
 * 也一样会被算进去。与 `src/tools/shared.ts` 的 `unavailableLoader()` 同值。
 *
 * @param reason 降级原因（原样进输出，所以别写中文长句）。
 */
export function loaderUnavailable(reason = 'no host context'): () => LoaderReadResult {
  return () => ({ ok: false, reason, entries: [] })
}

/**
 * 造一个 entry 快照。
 *
 * @param overrides 覆盖字段。
 */
export function entrySnapshot(overrides: Partial<LoaderEntrySnapshot> = {}): LoaderEntrySnapshot {
  const moduleName = overrides.moduleName ?? 'pkg-a'
  return {
    entryId: overrides.entryId ?? `include:${moduleName}`,
    moduleName,
    disabled: overrides.disabled ?? false,
    hasFiber: overrides.hasFiber ?? true,
    ...(overrides.fiberState === undefined ? {} : { fiberState: overrides.fiberState }),
    ...(overrides.fiberError === undefined ? {} : { fiberError: overrides.fiberError }),
    ...(overrides.disabledExpressionError === undefined
      ? {}
      : { disabledExpressionError: overrides.disabledExpressionError }),
    inject: overrides.inject ?? [],
    presentServices: overrides.presentServices ?? [],
  }
}

/**
 * 临时把 `process.platform` 换成指定值，跑完**无条件还原**。
 *
 * ## 为什么需要它
 *
 * 本机的平台与 CI 的平台不同（本机 Windows、CI ubuntu）。凡是断言依赖平台分支的用例，
 * 只要按**真实** `process.platform` 去写，就总有一半**永远没被跑过** ——
 * 而且失败点落在 CI 上（对外可见）。这个助手让**两条分支在任意机器上都被真跑到**，
 * 把「判据只能靠 CI 验证」变成「本机就能验证」。
 *
 * ## 为什么直接改全局是安全的（以及边界）
 *
 * `src/lib/ports.ts` 在**调用时**读 `process.platform`，所以改写能生效。
 * 风险是污染同一进程里并发的用例；这里用两条纪律压住：
 * 1. **`finally` 里用原属性描述符还原**（不是简单赋值回去 —— 描述符还原更严格）；
 * 2. 本仓测试**不在文件内并发**（没有 `it.concurrent`），vitest 的文件级并行是
 *    独立 worker/进程，不会共享这个全局。
 *
 * 另外 `platform-guard.test.ts` 有一条自检用例证明「还原」真的成立 ——
 * 光靠「我记得还原了」不算判据。
 *
 * @param platform 要伪装的平台值。
 * @param fn 在该平台下跑的逻辑（同步或异步）。
 */
export async function withPlatform<T>(
  platform: NodeJS.Platform,
  fn: () => Promise<T> | T,
): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  if (original === undefined) {
    throw new Error('process.platform 没有属性描述符，无法临时改写')
  }
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
 * 去掉块注释与行注释，**但保留换行**（扫源码类判据的共同前置）。
 *
 * 为什么必须有：本仓源码的注释里会**讨论**被扫的那件事（「不杀进程」「`timeoutMs` 必须为正有限值」
 * 「`--dump-config` 退出码恒 0」这类字样），不剥就会把**解释规则的文字**当成真代码 ——
 * 那是**假红**，而假红同样会让人把判据删掉。
 *
 * ## 三个必须做对的地方（每一处都实测过一次，两份判据各踩到其中一部分）
 *
 * 1. **块注释要换成等量空格，不能整段删掉**：本仓几乎每个文件开头都有一大段文档注释，
 *    删掉整段会让后面所有行号**整体前移** ⇒ 报出的 `文件:行` 是个**错的位置**。
 *    实测过两次：`src/tools/dsh_dump_config.ts` 真实 242 行被报成 155 行（偏移 87）；
 *    红线侧一次注入在第 190 行、被报成 143 行。「一个精确到行的错位置，比一句模糊的描述更费人」，
 *    而对这几条判据来说「指到哪一行」正是唯一的产品 ⇒ 行号必须与真实文件对齐。
 * 2. **行注释要认「行尾」的，不只是整行的**：`const x = 1 // timeoutMs: 15_000` 不剥就是假红。
 * 3. **`(^|[^:])` 那一段是防 URL 的 `//`**（`http://…`）：不防就会从 URL 那里开始吞，
 *    把同一行**后面**的真违规一起吞掉 —— 那是**假绿**，比假红更坏。
 *
 * 正则标志取 `timeout-budgets.test.ts` 那份（`gu` / `gmu`）：`u` 让这两条正则的转义语义
 * 与 ES 规范一致（将来往里加 `\p{…}` 之类的写法不会静默按 `u` 解释），`m` 对本组形态是
 * **空转的**（`(^|[^:])` 的 `[^:]` 本来就吃掉换行符，所以行首注释两种写法都认得）——
 * 留着它只是因为**逐字照抄**那份已实测过的形态最省事，不是它起了作用。
 *
 * @param text 源文件原文（全文，不是单行）。
 */
export function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, (block) => block.replace(/[^\n]/gu, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/gmu, '$1')
}

/** 一次只会失败的 spawn：测试里没显式给 spawn 时用它，避免真起进程。 */
export function neverSpawn(): SpawnImpl {
  return async () => {
    throw new Error('测试未提供 spawn 实现：这条路径不该起子进程')
  }
}

/** 一次只会失败的 fetch。 */
export const neverFetch: FetchImpl = async () => {
  throw new Error('测试未提供 fetch 实现：这条路径不该发 HTTP')
}

/** 记录调用的 spawn 包装。 */
export interface RecordingSpawn {
  spawn: SpawnImpl
  calls: RunCommandOptions[]
}

/**
 * 造一个「按调用脚本返回结果」的 spawn，并记录每次调用参数。
 *
 * @param handler 根据参数给结果。
 */
export function recordingSpawn(
  handler: (options: RunCommandOptions) => CommandResult | Promise<CommandResult>,
): RecordingSpawn {
  const calls: RunCommandOptions[] = []
  return {
    calls,
    spawn: async (options) => {
      calls.push(options)
      return await handler(options)
    },
  }
}

/** 造一个成功的命令结果。 */
export function cmdResult(partial: Partial<CommandResult> = {}): CommandResult {
  return { code: 0, stdout: '', stderr: '', timedOut: false, aborted: false, ...partial }
}

/** 造一个 exec（只需要 signal）。 */
export function execWith(signal: AbortSignal = new AbortController().signal): ToolRunContext {
  return { signal } as unknown as ToolRunContext
}

/**
 * 造一个「一用就过期」的时钟。
 *
 * 为什么要它：`defineTool` 拒绝非正的 `timeoutMs`（实测
 * `defineTool(x): timeoutMs must be a positive finite number`），所以
 * **不能**用 `timeoutMs: 0` 去构造「预算已耗尽」。改成让时钟第二次读就跳过一个完整预算：
 * `createDeadline` 第一次读作为基准，之后 `elapsed >= totalMs` → `expired()` 立刻为真。
 *
 * @param totalMs 配置里的工具预算。
 */
export function jumpingClock(totalMs: number): () => number {
  let calls = 0
  return () => {
    calls += 1
    return calls === 1 ? 0 : totalMs + 1
  }
}

/** 跑一个工具并拿到结构化结果。 */
export async function run(
  tool: ToolDefinition,
  args: unknown,
  exec: ToolRunContext = execWith(),
): Promise<ToolResult<unknown>> {
  return (await tool.execute(args, exec)) as unknown as ToolResult<unknown>
}

/**
 * 走**工具自己的声明**取模型可见文本（不直接调 `renderToolResultText`）。
 *
 * 为什么：`toolOutput()` 已经绑好了工具名与输出表，直接调渲染函数就多一个
 * 「红线自己拼装」的漂移点；走 `tool.output.render` 才是宿主真正的取数口。
 *
 * @param tool 工具定义。
 * @param args 调用参数（渲染用）；没有渲染参数的工具传 `{}`。
 * @param value 工具的返回值。
 */
export function renderText(tool: ToolDefinition, args: unknown, value: unknown): string {
  const blocks = tool.output.render(args, value as JsonValue) as unknown as { text?: string }[]
  return blocks.map((block) => block.text ?? '').join('\n')
}

/**
 * 按 SHAPE §3.1 的冻结逐行格式切分渲染文本（与红线实现同源的取数口）。
 *
 * 截断行按**前缀**认（与 `test/redlines.test.ts` 的 `RENDER_TRUNCATED_RE` 同一形状）：
 * 它要认的是「这一行是截断声明、不是 L2」，不是「截断行必须逐字长这样」——
 * 后者在两处一起改时照样绿。截断行**内容**的约束由红线 B27 语义判据守。
 *
 * @param text 渲染文本。
 */
export function splitRender(text: string): {
  head?: string
  verdict?: string
  l2: string[]
  l3?: string
} {
  const headPattern = /^\[[\w_]+\] (ok|failed \([\w-]+\))$/
  const truncPattern = /^\d+ more line\(s\) not shown/
  const lines = text.split('\n')
  const verdictIndex = lines.findIndex((line) => line.startsWith('verdict: '))
  const nextStepIndex = lines.findIndex((line) => line.startsWith('nextStep:'))
  const head = lines.find((line) => headPattern.test(line))
  return {
    ...(head === undefined ? {} : { head }),
    ...(verdictIndex < 0 ? {} : { verdict: lines[verdictIndex]?.slice('verdict: '.length) }),
    l2: lines
      .slice(verdictIndex + 1, nextStepIndex < 0 ? lines.length : nextStepIndex)
      .filter((line) => !truncPattern.test(line)),
    ...(nextStepIndex < 0
      ? {}
      : { l3: (lines[nextStepIndex] ?? '').slice('nextStep:'.length).trim() }),
  }
}

/**
 * 找出 `a` 里**逐字出现在 `b` 中**的、长度 ≥`min` 的片段（B20b 的取交集手法）。
 *
 * 实现：把 `a` 按 `min` 宽滑窗，逐个查 `b.includes(window)` —— 只要没有窗口命中，
 * 就不存在 ≥`min` 的共享串（任一更长的共享串必然包含一个命中的窗口）。
 *
 * @param a 描述文本。
 * @param b 渲染文本。
 * @param min 长度下限。
 */
export function sharedSubstrings(a: string, b: string, min: number): string[] {
  const hits = new Set<string>()
  for (let start = 0; start + min <= a.length; start += 1) {
    const window = a.slice(start, start + min)
    if (b.includes(window)) hits.add(window)
  }
  return [...hits]
}

/**
 * 一个工具 `data` 的测试视图（SHAPE §4.1 的三层记录）。
 *
 * `key` / `audit` 在契约里分别是泛型与 `JsonValue`，断言里按记录用更顺手 ——
 * 转型只发生在这个测试助手里。
 */
export interface ToolDataView {
  verdict: string
  key: Record<string, unknown>
  audit: Record<string, unknown>
}

/** 断言成功并取出 `data`（三层记录）。 */
export function expectOk(result: ToolResult<unknown>): ToolDataView {
  if (!result.ok) throw new Error(`期望成功，实际失败：${JSON.stringify(result.error)}`)
  return viewOf(result.data)
}

/**
 * 断言失败并取出 `error` 与 `data`。
 *
 * `hint` **没有了**（SHAPE §4.1 删掉它）：它的内容现在只有两个家 ——
 * 恒定知识在描述层边界段、具体动作在 `nextStep`。所以这里也不再返回它。
 *
 * `data` 一并给出来，因为**失败分支也有 L1 与被观测到的事实**（旧契约的 `evidence`），
 * 大多数断言要看的就是它。
 *
 * @param result 工具返回值。
 */
export function expectFail(result: ToolResult<unknown>): {
  kind: string
  message: string
  data: ToolDataView
  nextStep?: NextStep
} {
  if (result.ok) throw new Error(`期望失败，实际成功：${JSON.stringify(result.data)}`)
  return {
    kind: result.error.kind,
    message: result.error.message,
    data: viewOf(result.data),
    ...(result.nextStep === undefined ? {} : { nextStep: result.nextStep }),
  }
}

/**
 * 把三层记录转成测试视图。
 *
 * @param data 工具的 `data`。
 */
function viewOf(data: ToolData<unknown>): ToolDataView {
  return {
    verdict: data.verdict,
    key: data.key as Record<string, unknown>,
    audit: data.audit as Record<string, unknown>,
  }
}

/**
 * 「合成器与声明一致」的断言 —— **B20a 照不到的那一半**，这里收敛为唯一实现。
 *
 * 红线 B20a（`test/redlines.test.ts`）的 `shape.text` 是从 `description` **重新合成**的，
 * 从不读 `tool.description` ⇒ 「有人手写字符串绕过骨架」这一档只有各工具测试能照到。
 * 骨架的其余判据（段非空 / 行数与字符上界 / 参数描述下界）**B20a 已全量覆盖且更严**，
 * 工具测试不再逐字重抄 —— 只留一行指针注释（一处一事实）。
 *
 * @param tool 工具定义（读它**注册后**的 `description`，即合成器的真实产物）。
 * @param composed `composeDescription(声明)` 的结果。
 */
export function expectSynthesizedDescription(tool: ToolDefinition, composed: string): void {
  expect(tool.description).toBe(composed)
}

/**
 * 「参数描述非空 + 合计 > 0」的下界 —— 点进 `.properties` 才有效的那个口（坑 39）。
 *
 * 与 B20a 的差别：B20a 是**全仓扫描**（对闭集每个工具跑一遍），这里是**本工具自己**的
 * 单点断言（红了直接指到本文件）。两处都留是有意的：红线防「加新工具忘了」，这里防
 * 「改本工具时弄坏」。**精确的参数名闭集各工具自己断**（那是本工具的契约，不是骨架的）。
 *
 * @param tool 工具定义。
 * @param label 用例失败时的点名前缀。
 */
export function expectParameterDescriptionsNotBlank(tool: ToolDefinition, label = '本工具'): void {
  // ⚠️ `defineTool` 把参数编译成了 JSON schema（`{ type, properties }`，活跃坑 11）——
  // 直接 `Object.values(tool.parameters)` 会拿到 `'object'` 与 properties 对象本身，
  // 每条 `description` 都是 `undefined` ⇒ 合计恒为 0 ⇒ **判据空转**。
  const parameters = tool.parameters as {
    properties?: Record<string, { description?: string }>
  }
  const props = parameters.properties ?? {}
  const names = Object.keys(props)
  expect(names.length, `${label} 一个参数都没读到 —— 判据空转`).toBeGreaterThan(0)
  let total = 0
  for (const name of names) {
    const text = props[name]?.description ?? ''
    expect(text, `${label} 参数 ${name} 的描述是空的`).not.toBe('')
    total += text.length
  }
  expect(total, `${label} 参数描述合计为 0 —— 判据空转`).toBeGreaterThan(0)
}
