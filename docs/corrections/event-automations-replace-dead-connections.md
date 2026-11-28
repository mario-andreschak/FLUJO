# Event automations replace a server connection that stopped answering

A registered MCP client is no proof of a live connection. A stdio server that hangs
without exiting never closes its connection, so before this rule an event automation
reopened its stream on the same dead client forever and never ran again. When an
automation's request to its server fails and the client no longer answers a ping, FLUJO
replaces the connection (a hung stdio process is ended and started again) and tries once
more; a channel automation checks the same way on its regular connection check. A server
that still answers keeps its own error, and the automation's backoff handles it.

The checks run a real server process built on the official SDK, kill it, restart it and
hang it, and read what the user sees: run history, the card note, server status and the
resource list version.

Enforced by:
- `__tests__/mcp/realEventSource.test.ts`
- `__tests__/mcp/liveConnection.test.ts`
- `withLiveConnection` in `src/backend/services/mcp/liveConnection.ts`
- `healDeadConnection` in `src/backend/services/mcp/liveConnection.ts`
