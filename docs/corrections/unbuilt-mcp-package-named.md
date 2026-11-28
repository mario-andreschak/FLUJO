# A bundled MCP package that was never built is built for you in tests and `npm run dev`, and otherwise named with the exact fix, never a raw ENOENT

A fresh clone has no `mcp-servers/<name>/dist`. Creating a workspace then failed
with `ENOENT ... lstat '.../mcp-servers/flujo/dist'`, which says nothing about
`npm run build:mcp` (#1442).

Enforced by:
- `__tests__/workspace/shippedWorkspacePackages.test.ts`
- `__tests__/scripts/bundledMcpBuild.test.ts`
- `ensureBundledMcpBuilt` in `scripts/bundled-mcp-build.cjs`
- `bundledMcpEntry` in `__tests__/helpers/bundledMcpEntry.ts`
