import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';
import eslintConfigPrettier from 'eslint-config-prettier';

export default defineConfig([
  globalIgnores(['dist', 'node_modules', 'coverage', 'logs', 'spikes']),
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended, eslintConfigPrettier],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
    },
    rules: {
      // Use the winston logger (src/utils/logger.ts) so output is structured and persisted.
      'no-console': 'error',
      quotes: ['error', 'single', { allowTemplateLiterals: true, avoidEscape: true }],
      // Express handlers are typed Request<{}, {}, Body>; `{}` there means "no params/query".
      '@typescript-eslint/no-empty-object-type': ['error', { allowObjectTypes: 'always' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
      // ~100 existing `any`s; a warning keeps them visible without blocking. Don't add new ones.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
]);
