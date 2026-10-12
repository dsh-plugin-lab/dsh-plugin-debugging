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
 * **只为测试存在**：三个 fail-closed 分支（缺文件 / frontmatter 坏 / 正文空）没法拿
 * 真实 SKILL.md 触发，只能指向 `test/skills/fixtures/` 下的夹具。
 * 生产调用（`src/index.ts`）只传两个参数，走的永远是 `DEFAULT_SKILL_ROOT`。
 */
export interface RegisterSkillOptions {
  /** 技能根目录；缺省 = 按产物位置推断的包内 `skills/`。 */
  skillRoot?: string
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

  return { ok: true, name, contentBytes }
}
