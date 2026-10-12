import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import eslintConfigPrettier from 'eslint-config-prettier'

/**
 * ESLint 与编译器分工：`strict` 那组开关管类型与死代码，这里管编译器不覆盖的那一层
 * （hooks、promise、import 顺序之类）。参数是各仓自己的，不需要跨仓一致。
 */
export default [
  { ignores: ['lib/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // 浏览器半体，见 tsconfig.client.json。
    files: ['src/client/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    rules: {
      // `_` 前缀是「有意不用」的既有写法（回调占位、解构剔除某个键）。
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  eslintConfigPrettier,
]
