import nextJest from 'next/jest.js';
import {
  jsdomTestMatch,
  nodeTestMatch,
  nodeTestPathIgnorePatterns,
} from './jest.testMatch.mjs';

// next/jest wires up the SWC transform (so .ts/.tsx need no extra toolchain),
// loads next.config + .env, and mocks CSS/asset imports.
const createJestConfig = nextJest({ dir: './' });

// Shared across both projects: the "@/" alias.
const moduleNameMapper = {
  '^@/(.*)$': '<rootDir>/src/$1',
};

// The fast backend/engine suite. Runs under node (no DOM). Collects every
// __tests__ file (.ts AND .tsx — issue #176) EXCEPT the jsdom-scoped
// component-test folder, which the jsdom project owns.
const nodeProject = {
  displayName: 'node',
  testEnvironment: 'node',
  // The flow engine clones/deep-copies; give a little headroom over default.
  testTimeout: 15000,
  // Redirect the conversation-log store to a temp dir so bus emissions in
  // tests never write JSONL files into the repo's db/.
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  moduleNameMapper,
  testMatch: nodeTestMatch,
  testPathIgnorePatterns: nodeTestPathIgnorePatterns,
};

// React component/render tests. Real DOM via jsdom + Testing Library.
const jsdomProject = {
  displayName: 'jsdom',
  testEnvironment: 'jsdom',
  testTimeout: 15000,
  setupFilesAfterEnv: [
    '<rootDir>/jest.setup.ts',
    '<rootDir>/jest.setup.jsdom.ts',
  ],
  // Explicit CSS/asset mocks in case next/jest's defaults are not applied
  // per-project; the "@/" alias is listed first so it wins.
  moduleNameMapper: {
    ...moduleNameMapper,
    '^.+\\.(css|scss|sass|less)$': 'identity-obj-proxy',
    '^.+\\.(png|jpg|jpeg|gif|webp|avif|svg)$': '<rootDir>/__tests__/frontend/components/fileMock.js',
  },
  testMatch: jsdomTestMatch,
};

// next/jest is applied per project so each keeps the SWC transform + env
// loading while choosing its own environment.
async function buildConfig() {
  const node = await createJestConfig(nodeProject)();
  const jsdom = await createJestConfig(jsdomProject)();
  return {
    projects: [node, jsdom],
  };
}

export default buildConfig;
