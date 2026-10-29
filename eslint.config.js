import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', 'web.bundle.js', 'ios/**', 'artifacts/**', 'evidence/**'],
  },
  {
    files: ['*.js', '*.jsx', 'web/**/*.js', 'web/**/*.jsx', 'hosted/**/*.js', 'hosted/**/*.mjs', 'tests/**/*.mjs', 'backend/setup/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
    },
  },
  {
    files: ['*.jsx', 'web/**/*.jsx'],
    // TypeScript checks unused JSX references with noUnusedLocals and noUnusedParameters.
    // ESLint's core rule cannot distinguish JSX component references from unused imports.
    rules: { 'no-unused-vars': 'off' },
  },
];
