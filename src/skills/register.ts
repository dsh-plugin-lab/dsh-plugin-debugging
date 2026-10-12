/**
 * 技能半边 —— 把随包分发的 `skills/dsh-plugin-debugging/SKILL.md` 注册进宿主技能注册表。
 *
 * **契约（G2 冻结，改它要同时改 `src/contracts.ts` 与工具半边）**
 * - 只导出 `registerSkills(ctx, skills, options?)`，输入是宿主上下文与**可能缺席**的 `ctx.skills`，
 *   返回 `SkillReport`；
 * - **绝不抛**：任何失败都收敛成 `SkillReport.error`；
 * - 注册必须挂在 fiber 上：用 `ctx.effect(function* () { yield skills.register({...}) })`，
 *   这样热重载/卸载时注册自己会被撤掉（模块顶层不许持有可变状态）；
 * - 本文件**不许** import 工具半边，也不许碰 `ctx.tools`。
 *
 * **为什么是 runtime 注册而不是 filesystem provider**（决策 D1/D2，已回源码核）：
 * `ctx.skills.register()` 的 rank 是模块常量 **250**，且**无参数可改**
 * （`…\dsh-skill\lib\index.js:21` 常量、`:446` 写入、`:519-521` 升序比较 → **数值小者胜**）。
 * 六根 rank 里的 `custom`(300) / `user-dsh`(400) / `user-agents`(500) 都 > 250，
 * 所以本插件的技能盖过用户级同名技能；而 `project-dsh`(100) / `project-agents`(200) 仍会赢，
 * 这是预期的（项目级就该赢）。
 *
 * **rank 只在同一层内比较**：宿主行与 repository 插件落**全局层**，preset 挂载的插件落该
 * preset 的层；最近层的同名条目**直接胜出**、不比 rank（官方 `docs/subsystems/skills.md:13,270,286-295`）。
 *
 * **所以本文件做两次注册**（决策见 `.agents/notes/` 里那条「动态 scope 注入」）：
 * 1. **全局层**（`ctx.skills`）：插件挂在 profile 根，注册落全局层；
 * 2. **每个活跃 agent 的 preset 作用域**（`agent.ctx` 里的 skills 注册表）：与 `skill-filesystem`
 *    **同层**，于是 rank 250 在同层仲裁里**真的赢**用户级 400/500。
 *
 * 为什么第 2 步是必需的：**发布形态下用户级技能由 preset 层发现**，而 preset 层比全局层**更近** →
 * 全局那次注册会被**跨层遮蔽**（实测见 `.coord/verify-s2.md`）。只在同一个层里，rank 才参与比较。
 *
 * 为什么用「动态注入」而不是「把插件行写进 preset 组合」：后者一旦插件包不可解析，
 * **默认 `standard` 会话直接建不起来**（`agent-presets[standard].broken`），等于插件坏了就没人能用；
 * 现在插件行**不动**，坏包只影响插件自己（实测见 `.coord/verify-preset-layer.md` vs `verify-dynamic-scope.md`）。
 *
 * **三个必须 fail-closed 的点**
 * 1. `content` 宿主**不校验**（`…\dsh-skill\lib\index.js:465-469` 只查 name/description/invocation），
 *    漏了要到渲染 `<skill_content>` 时才是空 —— 所以正文为空必须自己判成失败；
 * 2. `parseSkillFile` **不是公开 API**（`…\dsh-skill-filesystem\lib\index.js:891` 的导出表里没有它，
 *    且它的签名依赖 `ctx.fs` 与真实路径）→ 自己解析 frontmatter；
 * 3. 技能根路径要按**产物位置**解析，见 `DEFAULT_SKILL_ROOT` 的注释（上溯**两级**）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'
import type { SkillRegistration, SkillRegistry } from '@deepseek-ai/dsh-skill'

import type { SkillError, SkillReport } from '../contracts.js'

/** 本插件技能在包内的固定位置：`<包根>/skills/<SKILL_NAME>/SKILL.md`。 */
const SKILL_NAME = 'dsh-plugin-debugging'
const SKILL_FILE = 'SKILL.md'

/** 与宿主同一套 kebab-case 判定（对应 `…\dsh-skill\lib\index.js:17` 的 `SKILL_NAME`）。 */
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * YAML 块标量指示符（`>-` / `|` / `|-` / `>+` …）。
 *
 * 宿主用完整的 `yaml` 包，折叠描述是合法的；本文件只解析**单行标量**。碰到块标量必须
 * **响亮失败**，不能把 `>-` 当描述文本注册进去 —— `description` 是模型唯一的路由信号
 * （技能不进系统提示词），注册成 `>-` 等于这个技能对模型不存在，而**不会报任何错**。
 */
const BLOCK_SCALAR = /^[|>][+-]?$/

/** 本模块所在目录：源码跑是 `<包根>/src/skills`，tsc 产物跑是 `<包根>/lib/skills`。 */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url))

/**
 * 包根下的 `skills/` 目录（SKILL.md 的父目录的父目录）。
 *
 * **上溯两级**，不是一级：本文件是 `src/skills/register.ts`、产物是 `lib/skills/register.js`，
 * 所以「包根 = MODULE_DIR/../..」。上溯一级会落到 `lib/skills`（源布局下是 `src/skills`），
 * 那里没有 SKILL.md —— 而这个错**不会让插件崩**，只会静默地报 `missing-file`。
 * 两种布局下同一个式子都成立：`src/skills/../..` 与 `lib/skills/../..` 都是包根。
 */
const DEFAULT_SKILL_ROOT = join(MODULE_DIR, '..', '..', 'skills')

/**
 * 可选的注入口。
 *
 * **只为测试与解耦存在**：三个 fail-closed 分支（缺文件 / frontmatter 坏 / 正文空）没法拿
 * 真实 SKILL.md 触发，只能指向 `test/skills/fixtures/` 下的夹具。
 * 生产调用（`src/index.ts`）不传它，走的永远是 `DEFAULT_SKILL_ROOT`。
 */
export interface RegisterSkillOptions {
  /** 技能根目录；缺省 = 按产物位置推断的包内 `skills/`。 */
  skillRoot?: string
  /**
   * 取 `ctx.agents`（活跃 agent 注册表）。
   *
   * **用函数而不是值**：宿主上下文里这个服务可能缺席（那时我们只做全局层注册），
   * 而且这样调用方不必知道 `agents` 服务的形状。缺省 = 不做动态注入。
   */
  agents?: () => AgentsLike | undefined
}

/**
 * 「活跃 agent 注册表」的**结构型**视图。
 *
 * 刻意**不**从 `@deepseek-ai/dsh-agent` import 具体类型：这套机制（`ctx.agents` / `agent.ctx` /
 * `agent/created`）是**宿主内部 primitive、不是公开契约**（实测见 `.coord/verify-dynamic-scope.md`），
 * 而结构型声明让我们**只依赖真正用到的那一点点形状** —— 宿主换版本时，
 * 失效会表现为「读不到」，而不是类型编译不过或运行期炸。
 */
export interface AgentsLike {
  /** 全部活跃 agent，注册序。 */
  list(): readonly AgentLike[]
}

/** 一个活跃 agent 的**结构型**视图：我们只要它的作用域 ctx。 */
export interface AgentLike {
  /** Agent 作用域上下文；其贡献是 agent-local、随销毁解开。 */
  readonly ctx: { get(serviceName: string): unknown }
}

/** 技能注册表里我们用到的那一个方法（scoped 与全局注册表形状相同）。 */
interface SkillRegistryLike {
  register(skill: SkillRegistration): () => void
}

/** 收敛出一条失败报告。 */
function fail(kind: SkillError['kind'], message: string, hint: string): SkillReport {
  return { ok: false, error: { kind, message, hint } }
}

/** 去掉成对的首尾引号（frontmatter 的值含 `: ` 时按 YAML 惯例要引起来）。 */
function stripQuotes(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

/** frontmatter 里的顶层键值对。只认无缩进的行，缩进续行一律跳过（本技能用不到）。 */
function parseFields(block: string): Map<string, string> {
  const fields = new Map<string, string>()
  for (const rawLine of block.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (line === '' || /^\s/.test(line)) continue
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const key = line.slice(0, colon).trim()
    if (key === '') continue
    fields.set(key, stripQuotes(line.slice(colon + 1)))
  }
  return fields
}

/**
 * 切出 frontmatter 与正文。
 *
 * **不用 `split(/\r?\n/)` 再拼回去**：那样会把 CRLF 归一成 LF，`contentBytes` 就不再是
 * 文件里真实的字节数了。这里按索引切片，正文与源文件逐字一致（宿主的
 * `parseFrontmatter` 也是这么做的，见 `…\dsh-skill-filesystem\lib\index.js:783-796`）。
 *
 * @param raw 技能文件全文。
 * @returns frontmatter 字段与**未 trim** 的正文；没有合法 frontmatter 时返回 `undefined`。
 */
function splitFrontmatter(raw: string): { fields: Map<string, string>; body: string } | undefined {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  if (raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return undefined

  let lineStart = firstLineEnd + 1
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      return {
        fields: parseFields(raw.slice(firstLineEnd + 1, lineStart)),
        body: raw.slice(nextNewline < 0 ? raw.length : nextNewline + 1),
      }
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
  return undefined
}

/**
 * 注册本插件的技能。**绝不抛**。
 *
 * @param ctx 宿主上下文（单测里是普通对象替身，只要有 `effect`）。
 * @param skills `ctx.skills`；缺失即 `no-registry`（缺技能服务的宿主属正常降级，不算错误路径）。
 * @param options 只在单测里用，见 {@link RegisterSkillOptions}。
 * @returns 成功时带 `name` 与 `contentBytes`；失败时带结构化 `error`。
 */
export function registerSkills(
  ctx: Context,
  skills: SkillRegistry | undefined,
  options: RegisterSkillOptions = {},
): SkillReport {
  if (skills === undefined) {
    return fail(
      'no-registry',
      '这个宿主没有 skills 服务，技能未注册（工具半边不受影响）',
      '确认 profile 里挂了 @deepseek-ai/dsh-skill；或直接读 skills/dsh-plugin-debugging/SKILL.md',
    )
  }

  const skillRoot = options.skillRoot ?? DEFAULT_SKILL_ROOT
  const skillFile = join(skillRoot, SKILL_NAME, SKILL_FILE)

  // ① 文件必须在。宿主那边缺 root 只是「探到出现为止」（filesystem provider README 的
  //    「A root that does not exist yet is probed until it appears」），不会让插件启动失败，
  //    所以这里自己响亮失败。
  let raw: string
  try {
    raw = readFileSync(skillFile, 'utf8')
  } catch {
    return fail(
      'missing-file',
      `技能文件读不到：${skillFile}`,
      '确认 skills/dsh-plugin-debugging/SKILL.md 随包发布了（package.json 的 files 白名单里有 "skills"），且产物在 lib/ 下（技能根要上溯两级到包根）。',
    )
  }

  // ② frontmatter 必须有合法的 name 与 description。宿主自己也会拒，但这里是第一道。
  const frontmatter = splitFrontmatter(raw)
  const name = frontmatter?.fields.get('name') ?? ''
  const description = frontmatter?.fields.get('description') ?? ''
  if (
    frontmatter === undefined ||
    !KEBAB_CASE.test(name) ||
    description.trim() === '' ||
    BLOCK_SCALAR.test(description.trim())
  ) {
    return fail(
      'bad-frontmatter',
      `frontmatter 不合法：name=${JSON.stringify(name)}，description=${JSON.stringify(description.trim())}`,
      'SKILL.md 顶部要有一段 --- 包住的 YAML，含 kebab-case 的 name 与非空 description（version/author 等未知键会被忽略）；description 要写成单行标量，不要用 >- / | 这类块标量。',
    )
  }

  // ③ 正文必须非空。**这一条是本文件存在的核心理由**：宿主不校验 content
  //    （…\dsh-skill\lib\index.js:465-469 只查 name/description/invocation），
  //    漏了要到渲染 <skill_content> 时才表现为空，而那时已经看不出是哪一步坏的了。
  //    trim() 与宿主一致（…\dsh-skill-filesystem\lib\index.js:706 用 parsed.body.trim()），
  //    这样「只有空白字符的正文」也算空。
  const content = frontmatter.body.trim()
  if (content === '') {
    return fail(
      'empty-content',
      `${SKILL_FILE} 的 frontmatter 之后没有正文`,
      '技能正文（frontmatter 之后的 Markdown）不能为空，否则模型加载后拿到空的 <skill_content>。',
    )
  }

  const contentBytes = Buffer.byteLength(content, 'utf8')
  const registration: SkillRegistration = { name, description, content, source: 'runtime' }

  // 挂在 fiber 上：`ctx.effect` 的生成器体在加载期同步跑到第一个 yield，
  // 宿主会把 yield 出来的 disposer 收进 fiber（cordis `_execute`，`…\cordis\lib\index.js:1142-1153`）。
  // 所以这里同步就能拿到「注册成了没有」的结论，卸载/热重载时注册自动撤掉。
  try {
    ctx.effect(function* () {
      yield skills.register(registration)
    })
  } catch (error) {
    return fail(
      'internal',
      `注册进宿主注册表时抛错：${error instanceof Error ? error.message : String(error)}`,
      '这是基础设施问题（不是 SKILL.md 的问题）：确认 ctx 是活跃 fiber，且 skills.register 的字段契约没变。',
    )
  }

  // 第二次注册：进每个**活跃 agent 的 preset 作用域**（与 skill-filesystem 同层 → rank 250 才真正赢）。
  // 失败**不影响**上面的全局注册，所以只记数、不改 `ok`。
  const scoped = registerScoped(ctx, options.agents, registration)

  return { ok: true, name, contentBytes, scoped }
}

/**
 * 把同一个技能注册进每个活跃 agent 的 preset 作用域。
 *
 * 三条实测出来的纪律（`.coord/verify-dynamic-scope.md`）：
 * 1. **`agent/created` 是 serial 派发，处理器里不许 `await`** —— 实测在处理器里 await 会让
 *    `agents.create()` 直接卡住。所以下面是**全同步**的：不 await、不推迟。
 * 2. **作用域注册表要从 `agent.ctx.get('skills')` 取**：`presets.serviceFor(agent,'skills')`
 *    即使在 preset 已挂时也返回 `undefined`（它找的是 preset 组内部的服务）。
 * 3. **新会话覆盖得到**：处理器对「apply 之后才出现的 agent」同样生效，所以不依赖启动时遍历。
 *
 * @param ctx 宿主上下文（提供 `on` / `effect`；单测里是替身）。
 * @param agentsOf 取活跃 agent 注册表；缺省或返回 `undefined` 时只做全局层注册。
 * @param registration 已验证过的技能定义。
 * @returns 计数；`undefined` 表示这次压根没做动态注入（宿主没有 agents 服务）。
 */
function registerScoped(
  ctx: Context,
  agentsOf: (() => AgentsLike | undefined) | undefined,
  registration: SkillRegistration,
): SkillReport['scoped'] {
  if (agentsOf === undefined) return undefined

  let initial = 0
  let failed = 0

  /**
   * 同步注册进一个 agent 的作用域；绝不抛。
   *
   * **必须把这次注册的 disposer 收进我们自己的 fiber**（`ctx.effect` 里 yield 它），
   * 否则会**泄漏**：`SkillRegistry.register` 内部是 `this.layers.effect(this.ctx, …)`，
   * 而 `this.ctx` 是**那个作用域自己的 ctx（= agent）** —— 于是注册的生命周期只绑在 agent 上，
   * 与插件 fiber **无关**：停用/卸载插件时，**已存在的 agent** 作用域里还留着我们的技能
   * （实测复现见 `.coord/verify-dynamic-scope-impl.md` 判据 5b：停用插件后老会话仍赢、
   * 新会话已退回用户级 —— 同一时刻两种结果，就是泄漏的定义）。
   *
   * 收进自己的 fiber 之后**两条路都能解开**：插件卸载 → 我们 yield 的 disposer 被调；
   * agent 销毁 → agent 作用域自己解开。Cordis 的 disposer 是幂等的，重复调用无副作用。
   */
  const intoAgent = (agent: AgentLike): boolean => {
    try {
      const scopedRegistry = agent.ctx.get('skills') as SkillRegistryLike | undefined
      if (scopedRegistry === undefined) return false
      ctx.effect(function* () {
        yield scopedRegistry.register(registration)
      })
      return true
    } catch {
      return false
    }
  }

  try {
    // ① 已经在跑的 agent（插件热重载时这一批就是全部）。
    for (const agent of agentsOf()?.list() ?? []) {
      if (intoAgent(agent)) initial += 1
      else failed += 1
    }

    // ② 之后新开的 agent。**同步处理器**：见上面纪律 1。
    //    签名要求返回 `Promise<undefined> | undefined`（serial 派发），所以显式 `return undefined`，
    //    而不是依赖 `void` —— 这也是「不许 await」在类型上的体现。
    ctx.on('agent/created', (payload) => {
      if (!intoAgent(payload.agent)) failed += 1
      return undefined
    })
  } catch {
    // 动态注入整条路失败（宿主没有 agents 服务、或事件名变了）：退回「只有全局注册」。
    // **不**把 `ok` 改成 false —— 全局那次已经成了，技能仍然是可见的（只是可能被用户级遮蔽）。
    return { initial, failed: failed + 1 }
  }

  return { initial, failed }
}
