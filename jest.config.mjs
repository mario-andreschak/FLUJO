// Resolve Next from this checkout explicitly. Bare package resolution walks up
// parent directories, which made nested isolated worktrees silently borrow the
// host FLUJO repository's Next/Jest toolchain when their own install was absent.
import nextJest from "./node_modules/next/jest.js";
import {
  isolatedTestPathIgnorePatterns,
  jsdomTestMatch,
  nodeTestMatch,
  nodeTestPathIgnorePatterns,
  shouldExcludeIsolatedSuites,
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

// Packages that ship ESM-only builds and are pulled in (directly or
// transitively) by code under test — chokidar v4+ and its readdirp v5+
// dependency from file-watch triggers, plus the MCP Apps browser bridge.
//
// next/jest hard-codes a leading "/node_modules/(?!(<transpilePackages>)/)"
// ignore pattern and only APPENDS whatever a caller passes in. Because
// transformIgnorePatterns is OR-ed, an extra pattern can never re-enable
// transformation for a package the generated pattern already ignored. So we
// widen that generated allowlist instead of appending to it.
const esmOnlyTestPackages = [
  "chokidar",
  "readdirp",
  "@modelcontextprotocol/ext-apps",
];

function allowEsmOnlyPackages(patterns = []) {
  return patterns.map((pattern) =>
    pattern.replace(
      /\(\?!\(([^)]*)\)\/\)/,
      (_match, allowed) =>
        `(?!(${allowed}|${esmOnlyTestPackages.join("|")})/)`,
    ),
  );
}

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
  // Issue #457: the CI "test" job hands the child-process suites to a separate
  // serial job, so they neither flake under worker contention nor slow the
  // main run. Local `npm test` is unaffected unless the switch is set.
  const excludeIsolated = shouldExcludeIsolatedSuites();
  for (const project of [node, jsdom]) {
    project.transformIgnorePatterns = allowEsmOnlyPackages(
      project.transformIgnorePatterns,
    );
    if (excludeIsolated) {
      project.testPathIgnorePatterns = [
        ...(project.testPathIgnorePatterns ?? []),
        ...isolatedTestPathIgnorePatterns,
      ];
    }
  }
  return {
    projects: [node, jsdom],
  };
}

export default buildConfig;
