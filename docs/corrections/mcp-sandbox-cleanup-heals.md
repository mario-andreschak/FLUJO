# Cleanup of an MCP sandbox and its run-time authority never blocks a server: a failed or unfinished cleanup, or one a crashed FLUJO left behind, is finished by the next start of that server, and shutdown finishes it before exit

Before #1423 this cleanup ran with blocking file calls inside the MCP SDK's
"transport closed" callback, a failed retirement refused the server until FLUJO
restarted, and a crashed FLUJO left a stopped container that refused the server
even after a restart.

Enforced by:
- `flujo/no-sync-fs`
- `__tests__/mcp/sandboxShutdownPaths.test.ts`
- `__tests__/security/isolatedMcp.test.ts`
- `__tests__/mcp/bundledFlujoWorkload.test.ts`
