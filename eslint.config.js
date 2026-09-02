import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      // Not covered by the glob above: the Expo web export goes to `dist-web`, and
      // linting a bundled build tree produces thousands of meaningless errors.
      'apps/mobile/dist-web/**',
      '**/.expo/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      'apps/api/src/generated/**',
      'apps/mobile/android/**',
      'apps/mobile/ios/**',
      'apps/api/prisma/migrations/**',
      'coverage/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    files: ['apps/mobile/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // Metro/Babel configs must be CommonJS.
    files: ['**/metro.config.js', '**/babel.config.js', '**/*.config.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  prettier, // MUST be last — disables rules that conflict with Prettier
);
