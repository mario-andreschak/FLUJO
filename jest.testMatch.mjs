// Single source of truth for which files each Jest project collects.
//
// Both jest.config.mjs (to configure Jest's `projects`) and the
// __tests__/meta/testMatchCoverage.test.ts hygiene guard import from here, so
// the matcher and the "nothing is silently skipped" check can never drift
// apart. See issue #176: a `.test.tsx` under `__tests__/` used to be dropped
// because the matcher only listed `.test.ts`.

// Glob patterns relative to the repo root, posix separators.
// The jsdom project owns component/render tests.
export const JSDOM_TEST_GLOBS = ['__tests__/frontend/components/**/*.test.{ts,tsx}'];
// The node project owns everything else (backend/engine/util tests).
export const NODE_TEST_GLOBS = ['__tests__/**/*.test.{ts,tsx}'];
// The node project must not also run the jsdom-scoped folder (would run twice).
export const NODE_IGNORE_GLOBS = ['__tests__/frontend/components/'];

const withRoot = (globs) => globs.map((g) => `<rootDir>/${g}`);

// Jest-consumable shapes (with the <rootDir> token Jest substitutes).
export const jsdomTestMatch = withRoot(JSDOM_TEST_GLOBS);
export const nodeTestMatch = withRoot(NODE_TEST_GLOBS);
export const nodeTestPathIgnorePatterns = ['/node_modules/', ...withRoot(NODE_IGNORE_GLOBS)];

// Union of every project's collection globs, relative to root (for the guard).
export const ALL_TEST_GLOBS = [...NODE_TEST_GLOBS, ...JSDOM_TEST_GLOBS];
