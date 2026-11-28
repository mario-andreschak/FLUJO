import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';
import flujo from './tooling/eslint-plugin-flujo/index.mjs';

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
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': 'off',
      'react-hooks/exhaustive-deps': 'off',
      // Compiler-only rules stay off until FLUJO enables the React Compiler.
      // The rules that catch effect and ref misuse are switched on for src/
      // below; older code is listed in eslint-suppressions.json.
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
    files: [
      'src/backend/services/enduringAgents/activityRuntime.ts',
      'src/backend/services/enduringAgents/personaDispatcher.ts',
      'src/backend/services/enduringAgents/runtimeEvents.ts',
      'src/backend/services/enduringAgents/runtimeLock.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']", message: 'Use the Persona runtime clock seam.' },
        { selector: "CallExpression[callee.object.name='performance'][callee.property.name='now']", message: 'Use the Persona runtime clock seam.' },
        { selector: "CallExpression[callee.name='setTimeout']", message: 'Use the Persona runtime clock seam.' },
        { selector: "CallExpression[callee.name='setInterval']", message: 'Use the Persona runtime clock seam.' },
      ],
    },
  },
  {
    // Corrections become checks (AGENTS.md). Each rule here replaced a review
    // comment that kept coming back. Code that already breaks a rule is listed
    // in eslint-suppressions.json; that list may only shrink
    // (scripts/check-lint-ratchet.mjs).
    files: ['src/**/*.{js,jsx,ts,tsx}'],
    plugins: { flujo },
    rules: {
      'flujo/no-workaround-comment': 'error',
      'flujo/disable-needs-reason': 'error',
      'flujo/no-double-cast': 'error',
      'flujo/no-node-vm': 'error',
      'flujo/no-sync-fs': 'error',
      'flujo/single-tool-approval-gate': 'error',
      'flujo/mcp-feature-defaults': 'error',
      'flujo/lazy-load-needs-boundary': 'error',
      '@typescript-eslint/ban-ts-comment': ['error', {
        'ts-expect-error': 'allow-with-description',
        'ts-ignore': true,
        'ts-nocheck': true,
        'ts-check': false,
        minimumDescriptionLength: 10,
      }],
      'react-hooks/set-state-in-effect': 'error',
      'react-hooks/set-state-in-render': 'error',
      'react-hooks/refs': 'error',
      'react-hooks/immutability': 'error',
      'react-hooks/purity': 'error',
      'react-hooks/globals': 'error',
      'react-hooks/static-components': 'error',
      'react-hooks/use-memo': 'error',
      'react-hooks/error-boundaries': 'error',
    },
  },
  {
    // These files are generated from flujo-avatar and kept byte for byte
    // (src/vendor/avatar/PROVENANCE.json, checked by
    // __tests__/architecture/vendorAvatarProvenance.test.ts). Fix them in
    // flujo-avatar and resync instead of editing the copy.
    files: [
      'src/vendor/avatar/client/Eyes.tsx',
      'src/vendor/avatar/client/useNativeRouterVoice.ts',
      'src/vendor/avatar/client/usePocketSpeech.ts',
    ],
    rules: {
      'react-hooks/refs': 'off',
    },
  },
  {
    files: ['src/**/*.{js,jsx,ts,tsx}'],
    ignores: ['src/utils/mcp/startupFailureHint.ts'],
    rules: {
      'flujo/no-adhoc-startup-error-match': 'error',
    },
  },
  {
    files: ['src/**/*.{js,jsx,ts,tsx}'],
    ignores: ['src/utils/transientFileRetry.ts'],
    rules: {
      'flujo/no-hand-rolled-file-retry': 'error',
    },
  },
  {
    files: ['src/app/**/route.{js,ts}'],
    rules: {
      'flujo/route-request-required': 'error',
    },
  },
  {
    files: ['src/frontend/**/*.tsx', 'src/app/**/*.tsx', 'src/frontend/**/hooks/**/*.ts'],
    ignores: ['src/frontend/hooks/timing.ts'],
    rules: {
      'flujo/no-raw-timers': 'error',
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
      // Tests deliberately force malformed inputs and partial framework mocks
      // across typed boundaries. Keep that escape hatch test-only; production
      // TypeScript is protected by the error-level rule above.
      '@typescript-eslint/no-explicit-any': 'off',
      'react/display-name': 'off',
    },
  },
]);
