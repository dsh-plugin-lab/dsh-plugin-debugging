import { describe, expect, it } from 'vitest'

import { apply, inject, name } from '../src/index.ts'

/**
 * 冒烟测试：只证明「这个包能被导入、入口的形状是对的、宿主不在场也不炸」。
 *
 * 它**不是**红线。红线是「这个插件的行为不可被破坏」那种断言，随能力一起长出来。
 *
 * 宿主替身只给最小面：真实 `ctx` 由 Cordis 提供，单测里不需要它。
 */
const fakeCtx = { get: () => undefined } as never

describe('entry', () => {
  it('导出了插件名', () => {
    expect(name).toBe('dsh-plugin-debugging')
  })

  it('声明了服务列表（且只声明硬依赖 tools）', () => {
    expect(inject).toEqual(['tools'])
  })

  it('apply 在宿主缺席、没有工具注册表时也不抛错', () => {
    expect(() => apply(fakeCtx)).not.toThrow()
  })
})
