import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

export default defineConfig([
  // Unused eslint-disable comments are an error, not a warning (issue #457):
  // stale directives silently hide the day a rule starts mattering again, and
  // the CI lint job runs with --max-warnings=0 anyway.
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
  },
  ...nextVitals,
  ...nextTypescript,
  globalIgnores([
    'mcp-servers/**/*',
    '.next/**/*',
    'output/**/*',
    'userdata/**/*',
  ]),
  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    settings: {
      'import/parsers': {
        '@typescript-eslint/parser': ['.ts', '.tsx'],
      },
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
          project: './tsconfig.json',
        },
        node: {
          extensions: ['.js', '.jsx', '.ts', '.tsx'],
        },
      },
    },
    rules: {
      // TypeScript is the source of truth for the MCP SDK's wildcard exports.
      'import/no-unresolved': ['error', { ignore: ['^@modelcontextprotocol/sdk/'] }],
      // TypeScript validates named type/value exports more accurately than
      // eslint-plugin-import across modern conditional package exports.
      'import/named': 'off',
      'import/default': 'error',
      'import/namespace': 'error',
      'import/export': 'error',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      'react-hooks/exhaustive-deps': 'off',
      // These rules target React Compiler adoption. FLUJO does not enable the
      // compiler yet, so treat that migration separately from the Next 16 bump.
      'react-hooks/static-components': 'off',
      'react-hooks/use-memo': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/incompatible-library': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/globals': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/error-boundaries': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/set-state-in-render': 'off',
      'react-hooks/unsupported-syntax': 'off',
      'react-hooks/config': 'off',
      'react-hooks/gating': 'off',
      'react/no-unescaped-entities': 'off',
      'prefer-const': 'warn',
      // Duplicate-detection (issue #457). The Next/typescript-eslint presets
      // leave both of these disabled: `no-dupe-keys` is only in
      // eslint:recommended (never extended here) and `no-redeclare` is turned
      // off by typescript-eslint's eslint-recommended layer in favour of
      // ts(2451). A duplicated key in a jest.mock() factory and a duplicated
      // `const` in a test file both shipped to main because nothing flagged
      // them, so enable the TypeScript-aware equivalents explicitly.
      'no-dupe-keys': 'error',
      '@typescript-eslint/no-redeclare': 'error',
    },
  },
  {
    // CommonJS bootstrap scripts and subprocess fixtures must run before any
    // ESM/Jest resolution exists, so require() is the only option there.
    files: ['**/*.cjs', 'scripts/**/*.js'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // Test files legitimately use require() for lazy/isolated module loading
    // inside jest.mock factories, and inline mock components have no display
    // name by design.
    files: ['__tests__/**/*.{js,jsx,ts,tsx}'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'react/display-name': 'off',
    },
  },
]);
