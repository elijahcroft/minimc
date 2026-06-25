import js from '@eslint/js';
import globals from 'globals';

// Lints the Node/shared/test JavaScript. The browser client lives inline in
// index.html and is intentionally out of scope for the flat ESLint setup (no
// HTML plugin to keep dependencies minimal).
export default [
  { ignores: ['node_modules/**', '*.bak', '.playwright-mcp/**', 'styles.css'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
];
