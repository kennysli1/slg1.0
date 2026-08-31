import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  { ignores: ['dist/**'] },
  { files: ['src/**/*.ts', 'src/**/*.tsx'], languageOptions: { parserOptions: { project: ['./tsconfig.server.json', './tsconfig.client.json'] } } },
);
