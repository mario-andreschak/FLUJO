import nextJest from "next/jest.js";
import {
  jsdomTestMatch,
  nodeTestMatch,
  nodeTestPathIgnorePatterns,
} from "./jest.testMatch.mjs";

// next/jest wires up the SWC transform (so .ts/.tsx need no extra toolchain),
// loads next.config + .env, and mocks CSS/asset imports.
const createJestConfig = nextJest({ dir: "./" });

// Shared across both projects: the "@/" alias.
const moduleNameMapper = {
  "^@/(.*)$": "<rootDir>/src/$1",
  "^uuid$": "<rootDir>/__tests__/uuidJestAdapter.ts",
  // Direct backend compatibility tests retain their existing mocked policy
  // modules; subprocess tests still load the compiled standalone package.
  "^@flujo-ai/mcp-shared$": "<rootDir>/__tests__/mcp/mcpSharedJestAdapter.ts",
  // mcp-stdio-oauth is ESM-only and intentionally exposes import conditions.
  // Jest transforms tests to CommonJS, so resolve its documented subpaths to
  // the package artifacts; Next's transpilePackages setting handles the ESM.
  "^mcp-stdio-oauth/(client|protocol)$":
    "<rootDir>/node_modules/mcp-stdio-oauth/dist/$1/index.js",
  "^mcp-stdio-oauth/client/transport$":
    "<rootDir>/node_modules/mcp-stdio-oauth/dist/client/transport.js",
  // NodeNext source imports retain their runtime .js suffix. During tests the
  // colocated source is still TypeScript, so let Jest resolve the same relative
  // path with its transformed extension.
  "^(\\.{1,2}/.*)\\.js$": "$1",
};

// Crawl only application/test sources and the five first-party workspaces.
// Runtime data may contain cloned FLUJO repositories (and therefore duplicate
// package names), while user-installed MCP servers are independent projects.
const roots = [
  "<rootDir>/src",
  "<rootDir>/__tests__",
  "<rootDir>/mcp-servers/bash",
  "<rootDir>/mcp-servers/browser",
  "<rootDir>/mcp-servers/filesystem",
  "<rootDir>/mcp-servers/flujo",
  "<rootDir>/mcp-servers/shared",
];

// The fast backend/engine suite. Runs under node (no DOM). Collects every
// __tests__ file (.ts AND .tsx — issue #176) EXCEPT the jsdom-scoped
// component-test folder, which the jsdom project owns.
const nodeProject = {
  displayName: "node",
  testEnvironment: "node",
  roots,
  // Redirect the conversation-log store to a temp dir so bus emissions in
  // tests never write JSONL files into the repo's db/.
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
  moduleNameMapper,
  testMatch: nodeTestMatch,
  testPathIgnorePatterns: nodeTestPathIgnorePatterns,
};

// React component/render tests. Real DOM via jsdom + Testing Library.
const jsdomProject = {
  displayName: "jsdom",
  testEnvironment: "jsdom",
  roots,
  setupFilesAfterEnv: [
    "<rootDir>/jest.setup.ts",
    "<rootDir>/jest.setup.jsdom.ts",
  ],
  // Explicit CSS/asset mocks in case next/jest's defaults are not applied
  // per-project; the "@/" alias is listed first so it wins.
  moduleNameMapper: {
    ...moduleNameMapper,
    "^.+\\.(css|scss|sass|less)$": "identity-obj-proxy",
    "^.+\\.(png|jpg|jpeg|gif|webp|avif|svg)$":
      "<rootDir>/__tests__/frontend/components/fileMock.js",
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
