/**
 * `dsh_hot_reload` —— v1.1 的第一个**写侧**工具：把一个已经在树里的 entry
 * 就地换成磁盘上的新代码，不重启宿主。
 *
 * 工具这一层只做四件事：解析参数（三者择一，不猜）→ 调机制层 →
 * 把机制层的失败原因映射成闭枚举 `kind` → 补 `nextStep`。
 * 算法本身在 `lib/hot-reload.ts`（那里可脱离宿主单测）。
 *
 * **写侧的含义必须在 description 里说清**：它会改运行中的树。所以四要素里的
 * 「一个必知陷阱」给了「cordis 之外开的资源不会被追踪、会静默泄漏」——
 * 那是这个工具唯一会让人事后吃亏的地方。
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import { fail } from '../lib/errors.js'
import {
  hotReload,
  outcomeToToolResult,
  parseReloadTarget,
  reloadInternalFailure,
  type ReloadArgs,
  type ReloadData,
  type ReloadHost,
} from '../lib/hot-reload.js'
import { createDeadline } from '../lib/timeouts.js'
import { toolOutput, toOutput, type ToolDeps } from './shared.js'

/** 工具名。 */
export const HOT_RELOAD_TOOL = 'dsh_hot_reload'

/**
 * 这个工具的运行期依赖。
 *
 * 为什么在本文件里扩展 `ToolDeps` 而不是改 `shared.ts`：写侧需要一个新的注入点
 * （`reload` 宿主端口），而 `shared.ts` 是四个只读工具共享的、已被契约冻结的形状。
 * 在本地扩一个子类型，四个只读工具的依赖面就一点没变。
 */
export interface HotReloadDeps extends ToolDeps {
  /**
   * 宿主侧的热重载能力（真实实现 `reloadHostFrom(ctx)`）。
   *
   * 契约是「**不抛**」：端口内部把宿主结构的任何意外都收敛成返回值，
   * 让机制层能把它们变成结构化失败，而不是让 `execute` 抛出去。
   */
  readonly reload: ReloadHost
}

/** 本工具不读任何配置文件、不涉及端口 —— 它的结论不依赖读的是哪个 profile 目录。 */
export type HotReloadToolData = ReloadData

/**
 * 造工具。
 *
 * @param deps 运行期依赖。
 */
export function createHotReloadTool(deps: HotReloadDeps): ToolDefinition {
  return defineTool({
    name: HOT_RELOAD_TOOL,
    description:
      'Swaps one mounted loader entry to the code currently on disk, in place, without restarting the host. ' +
      'Use it after changing host-side code of a plugin when a restart would be worse than the change. ' +
      'This is write-side: it mutates the running tree, so pass dryRun first if you only want to know what would change. ' +
      'If the new code fails to import the old entry is never touched, and if it fails to apply the previous code is put back ' +
      '- but anything the plugin opened outside cordis (timers, sockets, process handlers, file handles, workers) is not tracked and will leak silently.',
    parameters: {
      entryId: {
        type: 'string',
        description:
          'Loader entry id to replace, e.g. from dsh_diagnose_plugin_load. Pass exactly one of entryId, module, or serverName.',
      },
      module: {
        type: 'string',
        description:
          'Module or package name to match instead of entryId. Pass exactly one of entryId, module, or serverName.',
      },
      serverName: {
        type: 'string',
        description:
          'MCP serverName to match instead of entryId. Pass exactly one of entryId, module, or serverName.',
      },
      dryRun: {
        type: 'boolean',
        description:
          'Check the closure and report what would be replaced, without touching the tree. Nothing is cleared and no fiber is disposed.',
      },
    },
    output: toolOutput(HOT_RELOAD_TOOL, summarizeHotReload),

    timeoutMs: deps.config.timeoutMs,
    // 写侧工具**不安全**：两次并发重载会把缓存的备份/回滚交叉在一起。
    isConcurrencySafe: () => false,

    async execute(rawArgs, exec) {
      try {
        const args = rawArgs as ReloadArgs

        // ① 参数：三者择一，不给或多给都**不猜**。
        const parsed = parseReloadTarget(args)
        if (parsed.failure !== undefined) {
          return toOutput(
            fail(
              {
                kind: 'not-found',
                message: parsed.failure.message,
                hint: parsed.failure.hint,
              },
              {
                tool: 'dsh_diagnose_plugin_load',
                why: 'it lists the entries that actually exist, so you can pass an exact entryId instead of guessing',
              },
            ),
          )
        }
        if (parsed.target === undefined) {
          // 到不了这里（parse 的契约是二者恰有其一），但类型上要收窄。
          return toOutput(
            fail({
              kind: 'internal',
              message: 'target parsing returned neither a target nor a failure',
              hint: 'this is a bug in this plugin; report this message verbatim',
            }),
          )
        }

        const deadline = createDeadline(deps.config.timeoutMs, deps.now)
        const outcome = await hotReload(deps.reload, parsed.target, {
          dryRun: args.dryRun === true,
          signal: exec.signal,
          expired: () => deadline.expired(),
        })

        return toOutput(outcomeToToolResult(outcome))
      } catch (error) {
        // `execute` 绝不 throw：写侧工具抛异常最难收拾 —— 树可能已经改了一半。
        return toOutput(reloadInternalFailure(error))
      }
    },
  })
}

/**
 * 渲染首行的**一句话结论**（形如 §2.4 草稿）。
 *
 * 为什么要有：`data` 里带着闭包 URL 列表与两段解释，整块 JSON 不短；
 * 而模型唯一必须先看到的是**「换了几个模块、旧 fiber 有没有被碰、有没有回滚」** ——
 * 这三件事决定它接下来该说什么。
 *
 * @param data 工具的 `data`；形状不对时返回 `undefined`，让渲染退回纯 JSON。
 */
export function summarizeHotReload(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const record = data as Partial<ReloadData>
  const entry = record.entry
  if (typeof entry !== 'object' || entry === null) return undefined
  const entryId = (entry as { entryId?: unknown }).entryId
  if (typeof entryId !== 'string') return undefined

  if (record.dryRun === true) {
    const count = typeof record.moduleCount === 'number' ? record.moduleCount : 0
    return `verdict: entry=${entryId} · wouldSwap=${String(count)} modules · dryRun=true (nothing was touched)`
  }

  const cleared = typeof record.modulesCleared === 'number' ? record.modulesCleared : 0
  const rolledBack = record.rolledBack === true
  const base = `verdict: entry=${entryId} · swapped=${String(cleared)} modules · rolledBack=${String(rolledBack)}`
  // import 期失败那档最要紧的信息是「旧 fiber 从未被碰」—— 它决定有没有东西要收拾。
  if (record.oldFiberTouched === false && record.newFiberState == null && rolledBack === false) {
    return `${base} · oldFiberUntouched=true`
  }
  return base
}
