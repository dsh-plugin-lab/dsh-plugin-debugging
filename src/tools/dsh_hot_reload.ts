/**
 * `dsh_hot_reload` —— v1.1 的第一个**写侧**工具：把一个已经在树里的 entry
 * 就地换成磁盘上的新代码，不重启宿主。
 *
 * 工具这一层只做四件事：解析参数（三者择一，不猜）→ 调机制层 →
 * 把机制层的失败原因映射成闭枚举 `kind` → 补 `nextStep`。
 * 算法本身在 `lib/hot-reload.ts`（那里可脱离宿主单测）。
 *
 * ## 新契约下的形状（SHAPE §2 / §3 / §4 / §5）
 *
 * 1. **描述四段**（`what / useWhen / boundary / cost`）并由 `composeDescription` 合成；
 *    上限是红线 B20a 的硬数（description ≤240 字符；参数描述只判下界 —— 非空 + 合计 > 0）。
 *    **`cost` 段必写**（§2 的规则 ④：只对行动 / 派生类写）——「改不改状态、有没有
 *    `dryRun`、可不可逆」三件事都在这一行里。
 * 2. **`data` 顶层恰好三键** `{verdict, key, audit}`，成功失败同形（B21），由
 *    `outcomeToToolResult()` 一处产出（机制层负责算，本层不重算）。
 * 3. **失败分支没有 `hint` 了**（§4.1 删掉它）：那句最要紧的
 *    "the running entry was never touched — nothing to undo" 现在住在 **`verdict`**（L1），
 *    而「要不要收拾」的两个结构化事实（`oldFiberTouched` / `rolledBack`）住在 **`key`**（L2）。
 *    `error.message` **不进模型文本**，所以失败分支的「所以呢」只能由 `verdict` 承载。
 * 4. **`kind` 不许降级**：import / apply 两档仍是 `reload-failed` —— 那是模型判
 *    「该去改被重载的那份插件代码再重试」的唯一稳定机器码（`kindForReason` 里钉住）。
 * 5. `execute` **绝不 throw**（B24）：写侧工具抛异常最难收拾 —— 树可能已经改了一半，
 *    而调用方只看到一条栈。顶层 try/catch 因此不是风格，是契约的承载条件。
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import { fail } from '../lib/errors.js'
import {
  hotReload,
  kindForReason,
  outcomeToToolResult,
  parseReloadTarget,
  reloadInternalFailure,
  type ReloadArgs,
  type ReloadHost,
  type ReloadKey,
} from '../lib/hot-reload.js'
import { createDeadline, toolBudgetMs, type Workload } from '../lib/timeouts.js'
import type { RenderTable } from '../lib/render.js'
import { composeDescription, type ToolDescription } from './describe.js'
import { toolOutput, toOutput, type ToolDeps } from './shared.js'

/** 工具名。 */
export const HOT_RELOAD_TOOL = 'dsh_hot_reload'

/**
 * 本工具的工作量档：**快档**。
 *
 * 它只改进程内的模块缓存与 fiber（不起子进程、不发 HTTP），所以它与读文件的工具
 * 是同一量级 —— 慢档留给真正跑 `--dump-config-schema` 的那个工具。
 */
const WORKLOAD: Workload = 'quick'

/** 出错时唯一可派发的只读工具（它的 L2 里就有 entryId，正是重载要的输入）。 */
const DIAGNOSE_TOOL = 'dsh_diagnose_plugin_load'

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

/**
 * 本工具的描述（SHAPE §2.1 四段骨架）。
 *
 * 逐段理由：
 * - `what`：动词 + 对象，并点明它**不重启**（那是它与 `dsh_restart` 的分界）。
 * - `useWhen`：路由信号 = 「刚改完插件自己的代码」+ 「三个目标参数只能给一个」
 *   （后者是执行前必须知道、且调用结果里学不到的约束 —— §1.1 的判据）。
 * - `boundary`：**唯一的反直觉点**，也是这个工具唯一会让人事后吃亏的地方 ——
 *   cordis 之外开的资源不归 effect 管、dispose 旧 fiber 不会释放 → 静默泄漏。
 * - `cost`：行动类的三件事 —— 会改**运行中的树**、有 `dryRun` 可预览、失败会回滚。
 */
export const HOT_RELOAD_DESCRIPTION: ToolDescription = {
  what: 'Swaps one loader entry to code on disk, in place, no restart.',
  useWhen: 'Use after editing plugin code; pass exactly one target.',
  boundary: 'Outside-cordis resources (timers, sockets, handlers) leak silently.',
  cost: 'Write-side; dryRun previews; failures roll back.',
}

/**
 * 参数描述（B20a：只判**下界** —— 每个非空、合计 > 0；上界已删，见 SHAPE §2）。
 *
 * 写法按 §10.1 评审项：**留**怎么填 / 不填怎样 / 有什么陷阱；**删**从参数名能推出的、
 * 与工具描述重复的、纯机制解释的。
 * 「三者择一」那条约束**不在这里复述**（§2：参数规则放参数上、工具描述里不复述）——
 * 它属于「执行前必须知道的约束」，已经写在描述第 2 行；错误分支的 `verdict` 里也再说一次。
 */
const PARAMETERS = {
  entryId: { type: 'string', description: 'Loader entry id' },
  module: { type: 'string', description: 'Module or package name' },
  serverName: { type: 'string', description: 'MCP server name' },
  dryRun: { type: 'boolean', description: 'Report only, change nothing' },
} as const

/**
 * 本工具的输出表：L1 就是 `data.verdict` 逐字，L2 由 `key` 投影成行。
 *
 * 行数上限用默认 15 —— 本工具最多三行（entry / reload / moduleUrl），
 * 与 `diagnose` 那种「一个 bundle 一行」的量级不同，不需要抬。
 */
const TABLE: RenderTable<ReloadKey> = {
  key: (data) => keyText(data.key),
}

/**
 * 造工具。
 *
 * @param deps 运行期依赖。
 */
export function createHotReloadTool(deps: HotReloadDeps): ToolDefinition {
  return defineTool({
    name: HOT_RELOAD_TOOL,
    description: composeDescription(HOT_RELOAD_DESCRIPTION),
    parameters: PARAMETERS,
    output: toolOutput(HOT_RELOAD_TOOL, TABLE),

    timeoutMs: toolBudgetMs(WORKLOAD, deps.config),
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
              { kind: kindForReason(parsed.failure.reason), message: parsed.failure.message },
              {
                // 失败分支也有实质 L1（§4.1 约定 1）：机制层给出的那句结论就是它。
                verdict: parsed.failure.verdict,
                // **key 为空是有意的**：这一步什么都没定位到，没有任何可供决策的观测
                // —— 不许拿 `rolledBack: false` 之类的默认值冒充「树是安全的」。
                key: {},
                audit: { providedTargets: providedTargetNames(args) },
              },
              {
                tool: DIAGNOSE_TOOL,
                why: 'it lists the entries that actually exist, so you can pass an exact entryId instead of guessing',
              },
            ),
          )
        }
        if (parsed.target === undefined) {
          // 到不了这里（parse 的契约是二者恰有其一），但类型上要收窄。
          return toOutput(
            fail(
              {
                kind: 'internal',
                message: 'target parsing returned neither a target nor a failure',
              },
              {
                verdict:
                  'nothing was reloaded: this plugin could not resolve the call arguments, which is a bug in this plugin — report this message verbatim',
                key: {},
                audit: {},
              },
            ),
          )
        }

        const deadline = createDeadline(toolBudgetMs(WORKLOAD, deps.config), deps.now)
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
 * `key` → L2 的逐行文本。
 *
 * 顺序即输出顺序，也是模型读的顺序：
 * **先「换的是谁」（下一句要引用的标识符），再「换成什么样 / 要不要收拾」，最后才是路径**。
 *
 * 三条纪律：
 * - **不给默认值**：字段缺省就整项不印（`key` 是「这次知道了什么」，不是一张填满的表）；
 * - **`dryRun` 只在为真时印**：`false` 是默认值，L2 只放本次非默认的（§3）；
 * - **identifiers 必须出现**：`nextStep.args.package` 取的是 `entry.moduleName`，
 *   所以它必须印在 L1/L2 里（B17 的判据，否则模型在拿一个它从没见过的值去调下一个工具）。
 *
 * @param key 本次的 `key`。
 */
function keyText(key: ReloadKey): string[] {
  const lines: string[] = []
  if (key.entry !== undefined) {
    const server = key.entry.serverName === undefined ? '' : ` serverName=${key.entry.serverName}`
    lines.push(`entry: ${key.entry.entryId} module=${key.entry.moduleName}${server}`)
  }

  const facts: string[] = []
  if (key.dryRun === true) facts.push('dryRun=true')
  if (key.modulesCleared !== undefined) facts.push(`cleared=${String(key.modulesCleared)}`)
  if (key.oldFiberTouched !== undefined) {
    facts.push(`oldFiberTouched=${String(key.oldFiberTouched)}`)
  }
  if (key.rolledBack !== undefined) facts.push(`rolledBack=${String(key.rolledBack)}`)
  if (key.newFiberState !== undefined) facts.push(`newFiberState=${String(key.newFiberState)}`)
  if (facts.length > 0) lines.push(`reload: ${facts.join(' ')}`)

  if (key.moduleUrl !== undefined) lines.push(`moduleUrl: ${key.moduleUrl}`)
  return lines
}

/**
 * 从参数里挑出「给了哪几个目标」（只留名字，不留值 —— 值可能是拼错的包名，不值得进日志）。
 *
 * @param args 工具参数。
 */
function providedTargetNames(args: ReloadArgs): string[] {
  const names: string[] = []
  if (typeof args.entryId === 'string' && args.entryId.trim() !== '') names.push('entryId')
  if (typeof args.module === 'string' && args.module.trim() !== '') names.push('module')
  if (typeof args.serverName === 'string' && args.serverName.trim() !== '') {
    names.push('serverName')
  }
  return names
}
