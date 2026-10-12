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

/**
 * 定端口。
 *
 * 顺序：显式参数 > 配置里的 `port` > 环境变量 `DSH_WEB_URL` 里的端口。
 *
 * 为什么要看 `DSH_WEB_URL`：配置里 `port: 0` 的语义是「自己推断」，而本工具**不猜**。
 * 宿主启动时会把自己的地址放进 `DSH_WEB_URL`（本机实测形如
 * `http://127.0.0.1:3080`，且**不含任何 token**）—— 那是宿主自己给的答案，
 * 比猜一个 3080 诚实得多。三条都没有时返回 `undefined`，由调用方显式失败。
 *
 * @param explicit 工具参数里的端口。
 * @param configured 配置里的端口。
 * @param env 环境变量。
 */
export function resolvePort(
  explicit: number | undefined,
  configured: number,
  env: NodeJS.ProcessEnv,
): number | undefined {
  if (explicit !== undefined && Number.isSafeInteger(explicit) && explicit > 0) return explicit
  if (Number.isSafeInteger(configured) && configured > 0) return configured
  return portFromUrl(env.DSH_WEB_URL)
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
 * 校验 `dshHome` 能不能用。
 *
 * 为什么这会是一个**失败**而不是「兜底到家目录」：`resolveConfig` 读完配置与
 * `DSH_HOME` 之后可能仍是空串（契约注释许诺了 `<homedir>/.dsh` 兜底，但实现没有）。
 * 这里**不自己发明兜底策略** —— 猜一个 DSH_HOME 去读，可能在别的机器上读到无关目录，
 * 于是工具给出**看着成功其实读错了目录**的结论。宁可显式失败。
 *
 * @param config 已补齐默认值的配置。
 */
export function requireDshHome(config: ResolvedConfig): ToolFail | undefined {
  if (config.dshHome !== '') return undefined
  return fail(
    {
      kind: 'not-configured',
      message: '拿不到 DSH_HOME，无法定位 profile 与凭证文件',
      hint: '在插件配置里填 dshHome，或让宿主带着环境变量 DSH_HOME 启动',
    },
    { why: '定位不到 $DSH_HOME 时，后面每一步读的都是猜测的路径' },
  )
}
