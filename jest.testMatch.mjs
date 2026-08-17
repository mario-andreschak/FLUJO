// Single source of truth for which files each Jest project collects.
//
// Both jest.config.mjs (to configure Jest's `projects`) and the
// __tests__/meta/testMatchCoverage.test.ts hygiene guard import from here, so
// the matcher and the "nothing is silently skipped" check can never drift
// apart. See issue #176: a `.test.tsx` under `__tests__/` used to be dropped
// because the matcher only listed `.test.ts`.

// Glob patterns relative to the repo root, posix separators.
// The jsdom project owns component/render tests, plus hook tests that need a
// real DOM (e.g. useAutoFocusSearch's focus()/matchMedia assertions).
export const JSDOM_TEST_GLOBS = [
  '__tests__/frontend/components/**/*.test.{ts,tsx}',
  '__tests__/frontend/hooks/**/*.test.{ts,tsx}',
  '__tests__/frontend/workspaceSelection.test.{ts,tsx}',
];
// The node project owns everything else (backend/engine/util tests).
export const NODE_TEST_GLOBS = ['__tests__/**/*.test.{ts,tsx}'];
// The node project must not also run the jsdom-scoped folders (would run twice).
export const NODE_IGNORE_GLOBS = [
  '__tests__/frontend/components/',
  '__tests__/frontend/hooks/',
  '__tests__/frontend/workspaceSelection\\.test\\.(?:ts|tsx)$',
];

const withRoot = (globs) => globs.map((g) => `<rootDir>/${g}`);

// Jest-consumable shapes (with the <rootDir> token Jest substitutes).
export const jsdomTestMatch = withRoot(JSDOM_TEST_GLOBS);
export const nodeTestMatch = withRoot(NODE_TEST_GLOBS);
export const nodeTestPathIgnorePatterns = ['/node_modules/', ...withRoot(NODE_IGNORE_GLOBS)];

// Union of every project's collection globs, relative to root (for the guard).
export const ALL_TEST_GLOBS = [...NODE_TEST_GLOBS, ...JSDOM_TEST_GLOBS];

// ---------------------------------------------------------------------------
// Isolated (process-boundary) stage — issue #457.
//
// These suites spawn real child processes and are CPU-bound, so they starve
// (and get starved by) the parallel Jest workers of the default run. CI runs
// them in a dedicated serial job instead of the main one. They are still
// collected by the globs above, so the testMatchCoverage guard keeps working;
// the main run merely *ignores* them when the exclusion switch is on.
// ---------------------------------------------------------------------------
export const ISOLATED_TEST_FILES = [
  '__tests__/enduringAgents/personaProcessBoundary.test.ts',
  '__tests__/enduringAgents/activityRuntime.test.ts',
  '__tests__/mcp/processBoundary.test.ts',
  '__tests__/mcp/stdioServers.test.ts',
];

// Environment switch consulted by jest.config.mjs. scripts/run-local-jest.cjs
// sets it when invoked with --exclude-isolated-suites (cross-platform: npm
// scripts cannot portably prefix `VAR=value`).
export const EXCLUDE_ISOLATED_SUITES_ENV = 'FLUJO_JEST_EXCLUDE_ISOLATED_SUITES';

const escapeForRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const isolatedTestPathIgnorePatterns = ISOLATED_TEST_FILES.map(
  (file) => `<rootDir>/${escapeForRegExp(file)}$`,
);

export function shouldExcludeIsolatedSuites(env = process.env) {
  return /^(?:1|true|yes|on)$/i.test(env[EXCLUDE_ISOLATED_SUITES_ENV] ?? '');
}
