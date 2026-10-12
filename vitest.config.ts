import { configDefaults, defineConfig } from 'vitest/config'

/**
 * 日常测试配置（`npm test` / `pnpm test`）。
 *
 * **契约测试不在这里**：它们打真实上游、要凭据、要配额，只由单独的
 * `vitest.contract.config.ts` 与每周的 `contract.yml` 跑。本仓还没有契约测试，
 * 只先把这条排除留下 —— 免得以后加第一个契约测试时它悄悄混进日常测试，
 * 让「本机绿」变成「要有网络和密钥才绿」。
 *
 * `exclude` 取官方默认值再追加：手抄一份官方清单，官方加一项我们就漏一项。
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'test/contract-live-*.test.ts'],
    environment: 'node',
  },
})
