/**
 * 四个工具共享的运行期依赖与输出契约。
 *
 * 为什么单独一层（照 `dsh-zhihu-search/src/tools/deps.ts` 的范式）：工具实现因此
 * **不依赖 Cordis**，可以用普通对象构造并直接单测；生命周期与注册只发生在
 * `src/index.ts` → `src/tools/index.ts` 一处。
 *
 * 注入点都是「外部 IO」：`spawn`（子进程）、`fetch`（HTTP）、`loader`（宿主 Loader 树）。
 * 文件系统不注入 —— 单测用临时目录造一个假 `DSH_HOME` 更真，且不必 mock 类。
 */
import type { JsonValue, ToolFail, ToolResult } from '../lib/errors.js'
import { ensureToolResult, fail } from '../lib/errors.js'
import type { ResolvedConfig } from '../contracts.js'
import type { CarrierObservation } from '../lib/carrier.js'
import { UNKNOWN_CARRIER } from '../lib/carrier.js'
import type { FetchImpl } from '../lib/http.js'
import { defaultFetchImpl } from '../lib/http.js'
import type { SpawnImpl } from '../lib/exec.js'
import { defaultSpawnImpl } from '../lib/exec.js'
import type { LoaderReadResult } from '../lib/loader.js'
import { renderToolResult, type RenderTable, type TextBlockLike } from '../lib/render.js'

/** 四个工具共享的依赖。 */
export interface ToolDeps {
  readonly config: ResolvedConfig
  /**
   * 这个宿主跑在什么载体上（`apply()` 里探**一次**，判定与理由见 `src/lib/carrier.ts`）。
   *
   * **必填**而不是可选：可选会让「没探过」与「探出 `unknown`」在类型上不可分，
   * 而两者对判据的意义完全不同 —— 前者是接线漏了（本插件的 bug），后者是一条真结论。
   */
  readonly carrier: CarrierObservation
  readonly spawn: SpawnImpl
  readonly fetch: FetchImpl
  /** 当前时间；只为测试注入（默认 `Date.now`）。 */
  readonly now: () => number
  /** 环境变量；只为测试注入（默认 `process.env`）。 */
  readonly env: NodeJS.ProcessEnv
  /**
   * 读宿主 Loader 树（用来**观测** `fiber.state`）。
   *
   * 做成**闭包**而不是把 `ctx` 传进工具：工具实现因此仍然不依赖 Cordis，
   * 单测可以喂一个假实现；真实实现在 `src/tools/index.ts` 里从 `ctx` 绑一次。
   *
   * 契约是「**不抛**」：读不到就返回 `ok: false` + 原因，由工具降级成推断。
   * 这是宿主内部 primitive，版本一变就失效 —— 失效必须是降级，不是报错。
   */
  readonly loader: () => LoaderReadResult
}

/**
 * 没有宿主上下文时的 loader 实现：干净地降级，而不是抛。
 *
 * `reason` 会**逐字进模型可见的 L2**（`reason: …`），所以它有两条硬要求：
 * ① 英文；② **短**。短不只是文风 —— 红线 B16（「不许有恒定块」）把「两份 fixture 里
 * 都出现、且 ≥40 字符的行」判红，而这条 reason 在「没有宿主上下文」的每一次调用里
 * **逐字相同**。压到 40 字符以内，它才是「恒定块压成一行」而不是恒定块。
 */
export function unavailableLoader(): LoaderReadResult {
  return {
    ok: false,
    reason: 'no host context',
    entries: [],
  }
}

/**
 * 造运行期依赖。
 *
 * `carrier` 的兜底是 {@link UNKNOWN_CARRIER}（**不是** `cli`）：`cli` 会让
 * `relaunchRouteFor` 在 win32 上给出 `task-scheduler` —— 那就是「把不知道印成有能力」。
 * 兜底取 `unknown` 于是**偏向拒绝**：任何忘了注入载体的用例都会在闸④上响亮地失败，
 * 而不是悄悄走通一条它在真机上并不拥有的路线（本仓最典型的那种假绿）。
 *
 * @param config 已补齐默认值的配置。
 * @param overrides 测试注入的替身。
 */
export function createToolDeps(
  config: ResolvedConfig,
  overrides: Partial<ToolDeps> = {},
): ToolDeps {
  return {
    config,
    carrier: overrides.carrier ?? UNKNOWN_CARRIER,
    spawn: overrides.spawn ?? defaultSpawnImpl,
    fetch: overrides.fetch ?? defaultFetchImpl,
    now: overrides.now ?? Date.now,
    env: overrides.env ?? process.env,
    loader: overrides.loader ?? unavailableLoader,
  }
}

/** 端口是从哪来的 —— 「谁给的」比「是什么」更值得留在输出里。 */
export type PortSource = 'tool-argument' | 'plugin-config' | 'env:DSH_WEB_URL'

/** 定出来的端口 + 它的来源。 */
export interface ResolvedPort {
  port: number
  source: PortSource
}

/**
 * 定端口。
 *
 * 顺序：显式参数 > 配置里的 `port` > 环境变量 `DSH_WEB_URL` 里的端口。
 *
 * 为什么要看 `DSH_WEB_URL`：配置里 `port: 0` 的语义是「自己推断」，而本工具**不猜**。
 * 宿主启动时会把自己的地址放进 `DSH_WEB_URL`（本机实测形如
 * `http://127.0.0.1:3080`，且**不含任何 token**）—— 那是宿主自己给的答案，
 * 比猜一个 3080 诚实得多。三条都没有时返回 `undefined`，由调用方显式失败
 * 或（`dsh_diagnose_plugin_load` 那种文件层仍能答的工具）照实报 `none`。
 *
 * @param explicit 工具参数里的端口。
 * @param configured 配置里的端口。
 * @param env 环境变量。
 */
export function resolvePort(
  explicit: number | undefined,
  configured: number,
  env: NodeJS.ProcessEnv,
): ResolvedPort | undefined {
  if (explicit !== undefined && Number.isSafeInteger(explicit) && explicit > 0) {
    return { port: explicit, source: 'tool-argument' }
  }
  if (Number.isSafeInteger(configured) && configured > 0) {
    return { port: configured, source: 'plugin-config' }
  }
  const fromEnv = portFromUrl(env.DSH_WEB_URL)
  return fromEnv === undefined ? undefined : { port: fromEnv, source: 'env:DSH_WEB_URL' }
}

/**
 * 从 URL 里取端口。
 *
 * @param url 形如 `http://127.0.0.1:3080`；缺省端口按 scheme 补。
 */
export function portFromUrl(url: string | undefined): number | undefined {
  if (url === undefined || url === '') return undefined
  try {
    const parsed = new URL(url)
    if (parsed.port !== '') {
      const port = Number.parseInt(parsed.port, 10)
      return Number.isSafeInteger(port) && port > 0 ? port : undefined
    }
    if (parsed.protocol === 'http:') return 80
    if (parsed.protocol === 'https:') return 443
    return undefined
  } catch {
    return undefined
  }
}

/**
 * 工具的输出 schema：`{ type: 'json' }` = 无损 JSON、不做结构强制。
 *
 * 为什么不用 `oneOf` 把「成功/失败」两分支写成强制 schema：`defineTool` 的
 * `output.schema` 走**字面量推断**，两分支的 `oneOf` 会让推断出的 `data` 类型
 * 与工具自己的返回类型对不上，`execute` 的返回类型会退化成 `Promise<never>`
 * （实测报错：`Type 'Promise<JsonValue>' is not assignable to type 'Promise<never>'`）。
 *
 * 结构强制因此挪到 `toOutput()` 里在**返回前**做（见 `lib/errors.ts` 的
 * `ensureToolResult`）—— 「形状不合法的结果永远不会交给模型」这条保证不丢，
 * 只是从编译期挪到了运行期，而且现在**可被单测直接打到**。
 */
export const TOOL_OUTPUT_SCHEMA = { type: 'json' } as const

/**
 * 造一个工具的 `output` 声明。
 *
 * `render` 只读 `data.verdict`（L1）与 `table.key(data)`（L2）；
 * `audit` 不进模型文本（SHAPE §3.1 规则 1）。
 *
 * @param toolName 工具名（渲染首行用）。
 * @param table 该工具的输出表（L2 投影；L1 就是 `data.verdict` 逐字）。
 */
export function toolOutput<T>(
  toolName: string,
  table: RenderTable<T>,
): {
  schema: typeof TOOL_OUTPUT_SCHEMA
  render(args: unknown, value: unknown): TextBlockLike[]
} {
  return {
    schema: TOOL_OUTPUT_SCHEMA,
    render: (_args: unknown, value: unknown) => renderToolResult(toolName, value, table),
  }
}

/**
 * 把工具结果交给宿主：先过形状守卫，再转型成无损 JSON。
 *
 * 转型是必须的：宿主 `{ type: 'json' }` 对应的 TS 类型是带索引签名的递归联合，
 * 而本仓的结果类型是 `interface`（interface 不带隐式索引签名，所以结构上合法的
 * `ToolOk<T>` 通不过赋值检查）。与其为一个 TS 规则把冻结的契约层改成类型别名，
 * 不如在**唯一一处**边界上显式转型。
 *
 * @param result 工具结果。
 */
export function toOutput<T>(result: ToolResult<T>): JsonValue {
  return ensureToolResult(result) as unknown as JsonValue
}

/**
 * 参数里的 `dshHome`（跨实例观察的接缝；见 `docs/SHAPE.md` §1.2 的 D′ 第②块）。
 *
 * 只做**规整**，不做校验：空串 / 全空白 / 没传 = 「没覆盖」。刻意不 `resolve()`
 * 成绝对路径 —— 本仓对路径一律**照实回报**（`resolved.dshHome` 就是用户给的那个串），
 * 悄悄改写用户给的路径会让「我让它看的是 X，它读的是 Y」这种问题更难查。
 *
 * @param raw 工具参数里的值。
 */
export function dshHomeOverride(raw: string | undefined): string | undefined {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  return trimmed === '' ? undefined : trimmed
}

/**
 * 把本次调用的 `dshHome` 参数**叠进**配置：给了就覆盖 `dshHome`，
 * 并把来源标成 `tool-argument`。
 *
 * 为什么同批改来源：只改路径不改来源串，输出里就会把「参数来的目录」印成
 * `config` / `default`（三值纪律）—— 而那正是这次调用最该被看见的事实。
 * 没给参数时**原样返回同一个对象**（不是浅拷贝），这样「没覆盖」与「覆盖成同一个值」
 * 在引用层也分得开，判据可以据此断言。
 *
 * @param config 已补齐默认值的配置。
 * @param dshHome 参数里的 `dshHome`。
 */
export function withHomeOverride(
  config: ResolvedConfig,
  dshHome: string | undefined,
): ResolvedConfig {
  const home = dshHomeOverride(dshHome)
  if (home === undefined) return config
  return { ...config, dshHome: home, dshHomeSource: 'tool-argument' }
}

/**
 * 让**这次调用起的每一个子进程**都看到同一个 `DSH_HOME`。
 *
 * ## 为什么必须有这一层（本仓踩过的那条缝）
 *
 * `spawn` 型的工具（`dump_config` / `check_effect_mode`）是**起一个 `dsh` 去问**的，
 * 而 `lib/exec.ts` 的 `env` 默认是 `process.env` ⇒ **只加参数、不注环境**的话，
 * 子进程会读回**宿主进程自己的** home，而工具却把 `resolved.dshHome` 印成参数值 ——
 * 那正好是「看着成功、其实读的是另一个目录」，也就是这个接缝要消灭的那类谎。
 *
 * ## 两条边界
 *
 * 1. **永远注入**（不只是给了参数时）：子进程问的必须是本次调用**认的那个** home ——
 *    配置里指定的 home 同理（否则工具报的是配置的 home，子进程读的是 env 的）。
 * 2. **返回新对象，绝不改 `process.env`**：改进程环境是**写侧**动作（本仓写侧边界
 *    见 B15），而且会跨调用泄漏。`{ ...env, DSH_HOME: home }` 只影响这一个子进程。
 *
 * @param spawn 底层 spawn 实现。
 * @param env 要注入的环境变量（见 {@link childEnvFor}）。
 */
export function spawnWithHome(spawn: SpawnImpl, env: NodeJS.ProcessEnv): SpawnImpl {
  return async (options) => await spawn({ ...options, env })
}

/**
 * 子进程要看到的环境变量：在调用方给的环境上叠加 `DSH_HOME`。
 *
 * @param env 调用方的环境（`ToolDeps.env`，测试可注入）。
 * @param dshHome 本次调用认的 home；空串时不叠加（契约上不可能，见 `assertResolvedDshHome`）。
 */
export function childEnvFor(env: NodeJS.ProcessEnv, dshHome: string): NodeJS.ProcessEnv {
  if (dshHome === '') return env
  return { ...env, DSH_HOME: dshHome }
}

/**
 * 「这次调用跑在哪个实例上」的**唯一装配点**：把 `dshHome` 参数叠进配置，
 * 并让该次调用的子进程也看到同一个 home。
 *
 * 为什么要有它（而不是各工具自己 `{...config, dshHome}` 一遍）：
 * 跨实例这个接缝**有两层**（路径解析 + 子进程环境），两层必须同时改 ——
 * 分开写就一定会出现「只改了一层」的工具，而那种错的形状是**看着成功、读的是另一个实例**。
 * 一处装配，六个工具共用；将来再加一层也只是改这一个函数。
 *
 * 没给参数时**仍然**包一层 spawn：子进程问的必须是本次调用认的那个 home（配置指定的也一样），
 * 否则工具报的 home 与子进程读的 home 会不同 —— 那正是这个接缝要消灭的谎。
 *
 * @param deps 运行期依赖。
 * @param dshHome 参数里的 `dshHome`。
 */
export function withCallHome(deps: ToolDeps, dshHome: string | undefined): ToolDeps {
  const config = withHomeOverride(deps.config, dshHome)
  return {
    ...deps,
    config,
    spawn: spawnWithHome(deps.spawn, childEnvFor(deps.env, config.dshHome)),
  }
}

/**
 * 生效配置块：把「这次调用实际用的是哪份配置」变成**可见证据**。
 *
 * 为什么每个工具的成功 `data` 都要带它：诊断工具最坏的一种失败不是报错，而是
 * **看着成功、其实读的是另一份目录/另一个 profile**。把来源写进返回值，
 * 用户就能一眼看出「哦它读的是默认的 `~/.dsh`，不是我以为的那个」。
 * 这是只读的：不改任何行为，只把隐藏假设摊开。
 */
export interface EffectiveConfigBlock {
  /** 实际使用的 DSH_HOME（绝对路径）。 */
  dshHome: string
  /** 它是怎么来的：配置 / 环境变量 / 我们按宿主默认值推的。 */
  dshHomeSource: ResolvedConfig['dshHomeSource']
  /** 插件配置里的 profile（注意：某个工具若被显式传了 profile，实际用的可能不是这个）。 */
  profile: string
  /** 实际使用的端口；`null` = 这次调用没有用到端口。 */
  port: number | null
  /** 端口来源；`not-used` = 这次调用没用到端口，`none` = 要用但三条来源都没有。 */
  portSource: PortSource | 'none' | 'not-used'
}

/**
 * 造生效配置块。
 *
 * @param config 已补齐默认值的配置。
 * @param port 端口解析结果；不涉及端口的工具传 `'not-used'`。
 * @param profileOverride 这次调用实际用的 profile（工具参数优先于配置时传它）。
 */
export function effectiveConfig(
  config: ResolvedConfig,
  port: ResolvedPort | undefined | 'not-used' = 'not-used',
  profileOverride?: string,
): EffectiveConfigBlock {
  const profile = profileOverride ?? config.profile
  if (port === 'not-used') {
    return {
      dshHome: config.dshHome,
      dshHomeSource: config.dshHomeSource,
      profile,
      port: null,
      portSource: 'not-used',
    }
  }
  return {
    dshHome: config.dshHome,
    dshHomeSource: config.dshHomeSource,
    profile,
    port: port?.port ?? null,
    portSource: port?.source ?? 'none',
  }
}

/**
 * 防御性断言：`ResolvedConfig.dshHome` 必须非空。
 *
 * 这里**曾经**是一个「预期内的配置缺失」（`not-configured`）—— 因为那时
 * `resolveConfig` 的注释许诺了 `<homedir>/.dsh` 兜底、实现却没有。**兜底现已补上**
 * （`config` → `env` → `<homedir>/.dsh`，并记录 `dshHomeSource`），空串在契约上
 * 不可能出现。所以它不再是配置问题，而是**契约被违反的断言**：真出现就是
 * 本插件自己的 bug，故用 `internal`（模型不该去改配置重试）。
 *
 * 保留它而不是删掉的理由：将来若有人重构 `resolveConfig` 又漏掉兜底，这四个工具会
 * **拿空路径去读文件**，而读空的结论看起来完全正常 —— 那是最坏的一类静默坏。
 * 一行断言的代价，换「读错目录」变成一条响亮的失败。
 *
 * 形状（新契约）：失败分支必须带 `data`，所以 `verdict` 承载「所以呢」那句
 * （旧 `hint` 里的「这不是配置问题、是本插件的 bug」搬到这里），`nextStep` **不出现**
 * —— 模型没有动作可做，硬编一步只会是「裸结论伪装成下一步」。
 *
 * @param config 已补齐默认值的配置。
 */
export function assertResolvedDshHome(config: ResolvedConfig): ToolFail | undefined {
  if (config.dshHome !== '') return undefined
  return fail(
    {
      kind: 'internal',
      message: 'ResolvedConfig.dshHome is an empty string',
    },
    {
      verdict:
        'nothing was read: the resolved DSH_HOME is empty, which the contract forbids — this is a bug in this plugin, not a configuration problem',
      key: {},
      audit: { dshHomeSource: config.dshHomeSource, profile: config.profile },
    },
  )
}

/**
 * 守卫兜底那一支的降级行。
 *
 * **为什么它住在 `shared.ts`**：守卫合成的结果里整块 `key` 都是 `{}`（见
 * `lib/errors.ts` 的 `ensureToolResult`），渲染层仍必须**印得出一行**（`lib/render.ts`
 * 的「永远有输出」）。这一句此前是**每个工具各抄一份**的逐字副本，共 5 处；
 * 抄漏 / 抄走样都不会被任何判据照出来（红线 B25 只断言「可渲染、不抛」，
 * **不**断言措辞，见 `test/redlines.test.ts` 的「这条**不**断言什么」）。
 *
 * ⚠️ **形参是可选的、不是必填**：不同工具兜底时缺的东西不同（`list_instances`
 * 缺的是「扫到了什么」，`check_auth` 缺的是「用的是哪个实例」），所以**措辞
 * 本身**仍是各工具自己的契约 —— 这里只统一「兜底时印一行、并说清是守卫合成的」
 * 这件事。想要自己的措辞就传 `label`。
 */
export const GUARD_FALLBACK_LINE = 'resolved: unknown (the guard synthesized this result)'

/** {@link GUARD_FALLBACK_LINE} 的可选变体：把「缺的是什么」写进行里。 */
export function guardFallbackLine(label = 'resolved'): string {
  return `${label}: unknown (the guard synthesized this result)`
}

/**
 * `resolvedLine` 实际读的那几个字段 —— **不是** `EffectiveConfigBlock` 本身。
 *
 * 为什么收窄：各工具的 `key.resolved` 形状**按各自需要裁剪**（`dsh_dump_config` 不碰端口，
 * 于是它那块 `ResolvedKey` 里根本没有 `port` / `portSource`；`dsh_diagnose_plugin_load` 的
 * `port` 是可选的）。渲染器要的只是「这几个字段在不在、是什么类型」，
 * 参数类型写成整块 `EffectiveConfigBlock` 会强迫每个工具的 `key` 都长成同一副样子 ——
 * 那是在改契约来迁就渲染，而不是相反。
 */
export interface ResolvedLineInput {
  profile?: unknown
  dshHome?: unknown
  dshHomeSource?: unknown
}

/**
 * `resolved:` 那一行的**唯一渲染点**：模型在工具之间读的是同一张脸
 * （`dsh_check_auth.ts` 原本就把这句要求写在注释里，实现却各写一份）。
 *
 * **字段集合由调用方决定，各工具的取舍是有意的**（`SHAPE.md` §3.1 的 L2 规则：
 * 只印本次非默认、且下一个决定要用到的）：
 * - `port` 传 `'omit'` → 不印端口（不涉及端口的工具）；
 * - `dir` 传 `undefined` → 不印 profile 目录（不读 profile 目录的工具）。
 *
 * **字段顺序在这里定死**：`profile` → `dshHome` → 来源 → 端口 → 目录。
 * 此前 `dsh_restart` 是反的（`dshHome` 在前），它自己没给理由。
 *
 * **逐字段按 `typeof` 防御**：`dsh_check_auth` 的注释记着原因 —— 兜底合成的 `key`
 * 里整块 `resolved` 都不在，直接取字段会在兜底路径上抛（那是它过去真实崩过的原因）。
 * 抽到一处之后，**六个工具都受这条保护**，包括此前没受保护的 `dsh_restart`。
 *
 * @param resolved 生效配置块（可能是兜底合成的 `undefined` / 缺字段；只读上面那几个字段）。
 * @param port 端口投影；`'omit'` = 这个工具不涉及端口。
 * @param dir profile 目录；`undefined` = 不印。
 */
export function resolvedLine(
  resolved: ResolvedLineInput | undefined,
  port: 'omit' | { port: number | null; source: PortSource | 'none' | 'not-used' } = 'omit',
  dir?: string,
): string {
  if (!resolved || typeof resolved !== 'object') return GUARD_FALLBACK_LINE
  const profile = typeof resolved.profile === 'string' ? resolved.profile : 'unknown'
  const dshHome = typeof resolved.dshHome === 'string' ? resolved.dshHome : 'unknown'
  const source = typeof resolved.dshHomeSource === 'string' ? resolved.dshHomeSource : 'unknown'
  const head = `resolved: profile=${profile} dshHome=${dshHome} (${source})`
  if (port === 'omit') return typeof dir === 'string' && dir !== '' ? `${head} dir=${dir}` : head
  const portText =
    typeof port.port !== 'number'
      ? ''
      : ` port=${String(port.port)} (${typeof port.source === 'string' ? port.source : 'unknown'})`
  const dirText = typeof dir === 'string' && dir !== '' ? ` dir=${dir}` : ''
  return `${head}${portText}${dirText}`
}

/**
 * 把一个只读记录转成 `audit` 的契约类型 `JsonValue`。
 *
 * 为什么需要它：`JsonValue` 是**带索引签名**的递归联合，而本仓的记录是 `interface`
 * —— interface **不带隐式索引签名**，结构上合法的对象也通不过赋值检查（同一条 TS 规则，
 * 见本文件的 `toOutput`）。与其为一个 TS 规则把冻结的契约层改成类型别名，
 * 不如在**唯一一处**边界上显式转型；`audit` 必须是无损 JSON 这条要求由契约本身承担
 * （红线 B26 真的走一次 JSON 往返来验）。
 *
 * ⚠️ **它此前是 5 份逐字相同的副本**（`check_auth` / `diagnose` / `effect_mode` /
 * `list_instances` / `dump_config`），每个文件还各自抄了一遍这段理由。
 *
 * @param value 任一可无损落 JSON 的只读记录。
 */
export function asAudit(value: unknown): JsonValue {
  return value as JsonValue
}

/**
 * 把可能含换行的文本压成一行。
 *
 * 为什么必须有：L2 的契约是**一行一条**（`lib/render.ts` 的 `RenderTable.key` 返回
 * `readonly string[]`）。子进程的 stderr、日志里的 `detail` 都可能自带换行 ——
 * 不压就会把一个条目拆成两行，读者看到的是两条事实。
 *
 * ⚠️ **它此前是 3 份逐字相同的副本**（`diagnose` / `list_instances` / `dump_config`）。
 *
 * @param text 原始文本。
 */
export function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/**
 * 起不了 `dsh` 子进程时的错误判定 —— **错误 kind 与 message 模板的唯一落点**。
 *
 * 判据：`ENOENT` ⇒ `not-configured`（dsh 不在 PATH，是环境问题，模型该指给用户）；
 * 其它 ⇒ `internal`（本插件自己的问题，模型不该去改配置重试）。这条 kind 映射此前
 * 在两个 spawn 型工具（`dump_config` / `check_effect_mode`）里各写一遍。
 *
 * @param spawnError `spawn` 抛出或返回的原始错误文本。
 */
export function spawnFailureOf(spawnError: string): {
  kind: 'not-configured' | 'internal'
  notFound: boolean
} {
  const notFound = spawnError.includes('ENOENT')
  return { kind: notFound ? 'not-configured' : 'internal', notFound }
}

/** `cannot start dsh: …` 的 message 模板 —— 两个 spawn 型工具共用一句。 */
export function spawnFailureMessage(spawnError: string): string {
  return `cannot start dsh: ${spawnError}`
}

/** 取消语义的 `error.message`：重试同一个调用对 `cancelled` 不成立。 */
export const CANCELLED_MESSAGE = 'the caller cancelled this execution'

/** 取消语义的 `nextStep.why`：重试的判据按 `kind` 走，`cancelled` 不在其中。 */
export const CANCELLED_WHY = 'cancellation is up to the caller; retrying the same call is pointless'

/**
 * 「再调一次时 `dshHome` 参数要不要带」的**唯一判定**。
 *
 * 规则：只在本次是**参数覆盖**（`dshHomeSource === 'tool-argument'`）时才带 ——
 * 结论是关于**那个实例**的，下一步丢掉 home 会拿到另一个实例的答案，而两次输出
 * 长得一样（同一张输出表），这种错看起来像成功。没覆盖时多印配置值只是噪声。
 *
 * 此前这条规则在 `dump_config` 与 `diagnose` 各实现一遍（后者注释还明写
 * 「同 `dsh_dump_config.retryArgs` 的理由」）—— 改一处必漏另一处（审计 B6）。
 *
 * @param resolved 带 `dshHomeSource` 的配置投影（各工具的 `key.resolved` 形状即可）。
 * @returns 应并入重试参数的 `dshHome` 键值；非跨实例时为空对象。
 */
export function homeRetryArg(resolved: {
  dshHomeSource?: unknown
  dshHome?: unknown
}): Record<string, string> {
  if (resolved.dshHomeSource !== 'tool-argument') return {}
  return typeof resolved.dshHome === 'string' ? { dshHome: resolved.dshHome } : {}
}

/**
 * 守卫兜底那一支的 `keyText` 开头 —— **key 不是对象时该印什么**的唯一判定。
 *
 * 规则：**不许静默返回空数组**（守卫把结果换掉了，那一刻模型最该知道「字段都不可信」，
 * 静默会让兜底看起来像一次正常的空结果）。此前 5 份逐字相同，而 `check_effect_mode`
 * 走样成 `return []` —— 同一语义 6 个落点、1 处违约，没有任何判据照得到（审计 B3）。
 *
 * @param key 本次的 `key`（守卫合成的兜底里是 `{}`）。
 * @returns 兜底行数组；`key` 合法时返回 `undefined`，调用方继续正常路径。
 */
export function guardKeyLines(key: unknown): string[] | undefined {
  if (!key || typeof key !== 'object') return [GUARD_FALLBACK_LINE]
  return undefined
}

/**
 * L2 的 `authority:` 渲染行 —— `keyText` 里可选字段的**条件行**模板。
 *
 * `check_auth` 与 `sign_cookie` 的 keyText 各印一行「有才印」的 authority；
 * 此前是同一模板两份逐字（2026-10-16 审计 B8）。「有才印」的纪律留在调用方
 * —— 这里只收「印出来长什么样」。
 *
 * @param authority 本次的 authority（`undefined` 表示缺席，返回 `undefined` 不印）。
 */
export function authorityLine(authority: string | undefined): string | undefined {
  return authority === undefined ? undefined : `authority: ${authority}`
}
