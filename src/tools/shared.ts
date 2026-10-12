/**
 * 四个工具共享的运行期依赖与输出契约。
 *
 * 为什么单独一层（照 `dsh-zhihu-search/src/tools/deps.ts` 的范式）：工具实现因此
 * **不依赖 Cordis**，可以用普通对象构造并直接单测；生命周期与注册只发生在
 * `src/index.ts` → `src/tools/index.ts` 一处。
 *
 * 注入点只有两个，都是「外部 IO」：`spawn`（子进程）与 `fetch`（HTTP）。
 * 文件系统不注入 —— 单测用临时目录造一个假 `DSH_HOME` 更真，且不必 mock 类。
 */
import type { JsonValue, ToolFail, ToolResult } from '../lib/errors.js'
import { ensureToolResult, fail } from '../lib/errors.js'
import type { ResolvedConfig } from '../contracts.js'
import type { FetchImpl } from '../lib/http.js'
import { defaultFetchImpl } from '../lib/http.js'
import type { SpawnImpl } from '../lib/exec.js'
import { defaultSpawnImpl } from '../lib/exec.js'
import { renderToolResult, type TextBlockLike } from '../lib/render.js'

/** 四个工具共享的依赖。 */
export interface ToolDeps {
  readonly config: ResolvedConfig
  readonly spawn: SpawnImpl
  readonly fetch: FetchImpl
  /** 当前时间；只为测试注入（默认 `Date.now`）。 */
  readonly now: () => number
  /** 环境变量；只为测试注入（默认 `process.env`）。 */
  readonly env: NodeJS.ProcessEnv
}

/**
 * 造运行期依赖。
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
    spawn: overrides.spawn ?? defaultSpawnImpl,
    fetch: overrides.fetch ?? defaultFetchImpl,
    now: overrides.now ?? Date.now,
    env: overrides.env ?? process.env,
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
 * @param toolName 工具名（渲染首行用）。
 */
export function toolOutput(toolName: string): {
  schema: typeof TOOL_OUTPUT_SCHEMA
  render(args: unknown, value: unknown): TextBlockLike[]
} {
  return {
    schema: TOOL_OUTPUT_SCHEMA,
    render: (_args: unknown, value: unknown) => renderToolResult(toolName, value),
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
 * @param config 已补齐默认值的配置。
 */
export function assertResolvedDshHome(config: ResolvedConfig): ToolFail | undefined {
  if (config.dshHome !== '') return undefined
  return fail(
    {
      kind: 'internal',
      message: 'ResolvedConfig.dshHome 是空串 —— 契约要求 resolveConfig 做完三级兜底',
      hint: '这是本插件的 bug，不是配置问题；请把这条 message 原样带回',
    },
    { why: '拿空路径继续读文件会得到「看着正常其实读错目录」的结论' },
  )
}
