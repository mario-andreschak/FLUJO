import nextJest from 'next/jest.js';

// next/jest wires up the SWC transform (so .ts/.tsx need no extra toolchain),
// loads next.config + .env, and mocks CSS/asset imports. We add node as the
// test environment (these are backend/engine tests) and map the "@/" alias.
const createJestConfig = nextJest({ dir: './' });

/** @type {import('jest').Config} */
const config = {
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  // Keep test files out of the way of the app source tree.
  testMatch: ['<rootDir>/__tests__/**/*.test.ts'],
  // The flow engine clones/deep-copies; give a little headroom over the default.
  testTimeout: 15000,
};

export default createJestConfig(config);
