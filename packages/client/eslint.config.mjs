// @ts-check
/**
 * 客户端 ESLint 扁平配置。
 * 视图层是 Preact + TSX，渲染由 JSX 自动转义，不再手写 innerHTML 插值。
 */
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },

  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      // 关闭：项目大量使用 any（服务端响应 payload 无类型定义）
      '@typescript-eslint/no-explicit-any': 'off',
      // 未使用变量警告（忽略 _ 前缀参数）
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // 禁止空 catch 块，应至少注释说明为何忽略
      'no-empty': ['warn', { allowEmptyCatch: false }],
    },
  },
);
