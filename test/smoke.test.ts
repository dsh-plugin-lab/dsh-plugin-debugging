import { describe, expect, it } from 'vitest'

import { apply, inject, name } from '../src/index.ts'

/**
 * 冒烟测试：只证明「这个包能被导入、入口的形状是对的」。
 *
 * 它**不是**红线。红线是「这个插件的行为不可被破坏」那种断言，随能力一起长出来。
 */
describe('entry', () => {
  it('导出了插件名', () => {
    expect(name).toBe('dsh-plugin-debugging')
  })

  it('声明了服务列表（可以是空的）', () => {
    expect(Array.isArray(inject)).toBe(true)
  })

  it('apply 可以被调用而不抛错', () => {
    expect(() => apply({})).not.toThrow()
  })
})
