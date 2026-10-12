/**
 * 宿主半边入口。
 *
 * 这是**唯一**接触 Cordis 的地方：生命周期、配置校验、注册点都落在这里。
 * 业务逻辑放在本文件之外，那样才能用普通对象直接单测。
 *
 * 生命周期纪律：状态、监听器、定时器一律在 `ctx.effect()` / `ctx.on()` 内创建并由
 * 返回的 disposer 释放。**模块顶层不持有任何可变状态** —— 否则热重载后会留下两代
 * 插件共用同一份状态的幽灵故障。
 */

/** Cordis 插件名，用于 loader 诊断。 */
export const name = 'dsh-plugin-debugging'

/**
 * 本插件需要的服务。只有真的用到才写 —— 声明了却不用的服务会让启动顺序无谓地变复杂。
 *
 * TODO: 例如工具注册表写成 `['tools']`。
 */
export const inject: string[] = []

/**
 * 挂载点。
 *
 * TODO: 在这里注册本插件提供的能力。
 *
 * @param ctx 宿主上下文。
 */
export function apply(_ctx: unknown): void {
  // 现在什么都没有。这是骨架，不是成品。
}
