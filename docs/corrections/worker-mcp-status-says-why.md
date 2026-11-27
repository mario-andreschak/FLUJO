# Worker status says why each MCP server is not running (a fixed code, one plain sentence and what to do, worded only in `workerMcpReason.ts`) and never copies an error's text; a server waiting for owner approval does not block the worker and starts once approved, without a restart

A worker used to report only "MCP dependency could not be prepared." for every
server, and a fresh workspace's built-in servers, which need the owner's
approval on a worker, put the whole worker in error.

Enforced by:
- `PublishedWorkerMcpServers` in `src/backend/services/workspace/workerMode.ts` (only `normalizeWorkerMcpServers` makes one, rebuilding each entry from its code)
- `__tests__/workspace/workerMcpServers.test.ts`, `__tests__/backend/initGating.test.ts`, `__tests__/packages/workspaceMcpTransfer.test.ts`
