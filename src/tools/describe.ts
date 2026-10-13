/**
 * 描述层四段骨架（SHAPE §2.1 冻结）。
 *
 * 为什么把骨架做成**类型**而不是约定：模型的工具路由完全靠 description，而「四段齐全」
 * 「行数上限」「单工具字数上限」只有写成字段之后才**能被红线机械断言**（B20a）。
 *
 * 连接符是 `\n`（不是空格）—— 这是 2026-10-13 拍板的选择：空格连接会让合成后的描述
 * **恒为一行**，于是「行数 ≤4」变成恒真断言、「边界 ≤2 行」永远判不出来，两条判据一起
 * 变成装饰。改成 `\n` 之后，四段各占一行，两条上限同时成为真判据，而且模型读到的描述
 * 是四行而不是一坨。**这是有意与宿主官方描述（单段）分歧的一处。**
 *
 * 段序不许换：做什么 → 什么时候用我 → 边界 → 代价。
 */

/** 一段描述的四个槽位。 */
export interface ToolDescription {
  /** 必填：做什么（动词 + 对象），1 行。 */
  what: string
  /** 必填：什么时候用我 = 模型的路由信号，1–2 行。 */
  useWhen: string
  /** 可选：我**答不了**什么 + 唯一的反直觉点，≤2 行；没有就不写。 */
  boundary?: string
  /** 可选：只对行动 / 派生类写（改不改状态、有没有 `dryRun`、可不可逆），1 行。 */
  cost?: string
}

/** 单工具 description 的字符上限（现状 371–575；目标是描述层总量减半）。 */
export const DESCRIPTION_MAX_CHARS = 240

/** 合成后的行数上限：骨架就是四段。 */
export const DESCRIPTION_MAX_LINES = 4

/** 该工具**全部参数**描述的字符合计上限（现状合计 1230）。 */
export const PARAMETER_DESCRIPTIONS_MAX_CHARS = 100

/**
 * 按固定顺序把四段拼成最终的 description。
 *
 * **先滤空段再 `join`**：`boundary` / `cost` 是可选的，直接 `join` 会在缺省时留下空行，
 * 而空行按 `\n` 切分**也占一行** —— 于是「两段齐全」的描述会数出 4 行，
 * 「行数 ≥ 段数」与「行数 ≤ 4」同时通过，描述里却躺着空行。
 * 滤空段**不是**放宽 `what` / `useWhen`：那两段必须非空，由红线断言（B20a）。
 *
 * @param description 四段声明。
 * @returns 以 `\n` 连接的描述；四段全空时返回空串（由红线判红，这里不抛）。
 */
export function composeDescription(description: ToolDescription): string {
  return [description.what, description.useWhen, description.boundary, description.cost]
    .map((segment) => (segment ?? '').trim())
    .filter((segment) => segment !== '')
    .join('\n')
}
