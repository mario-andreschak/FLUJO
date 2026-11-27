# The newer MCP client gets handlers for non-core notifications only with a schema, through `registerExtensionNotifications`

The split SDK (`@modelcontextprotocol/client`) throws while the connection is being built
when a handler for a method outside the core protocol (such as
`notifications/claude/channel` or `notifications/events/*`) is registered without a
schema. An `as unknown as` cast in the MCP service hid that from the type checker, so
every server on the newer client failed to connect. The cast is gone; the client's own
types now refuse the wrong call, and `createNewBetaClient` registers every such handler
with a schema.

Enforced by:
- `registerExtensionNotifications` in `src/backend/services/mcp/betaClient.ts`
- `__tests__/mcp/mcpEventsPushPoll.test.ts`
- `__tests__/mcp/betaProtocolToggle.test.ts`
- `flujo/no-double-cast`
