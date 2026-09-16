# API Reference

The in-app **/docs** page is a curated reference with request examples. The [generated route inventory](routes.md) lists every explicit App Router handler in this revision; it does not make internal routes stable public APIs.

## REST API

For external chat clients, configure an OpenAI-compatible base URL of `http://localhost:4200/v1` and select a flow model returned by `GET /v1/models`. The ordinary local app accepts arbitrary client API-key values; that compatibility value is **not authentication**. Keep the service on localhost or put deliberately exposed deployments behind authenticating network controls. Worker deployments require their own bearer credential.

Select a workspace explicitly with `x-flujo-workspace` or the supported `workspace` query parameter when addressing workspace-owned resources. Workspace names identify logical data partitions, not users. The installation-wide workspace management endpoint is separate. Locked workspaces must be unlocked through the owner UI before secret-dependent execution.

| Surface | Purpose | Contract |
| --- | --- | --- |
| `/v1/models`, `/v1/chat/completions` | OpenAI-compatible model discovery and execution | Curated in-app docs describe supported fields; not every OpenAI feature is implemented |
| `/api/model`, `/api/flow`, `/api/mcp` | Manage model, agent, and app configuration | Internal administration; use current schemas and do not forward these endpoints publicly |
| `/api/workspaces` | GET list; POST create; PATCH rename/roots; DELETE remove | Installation-wide; names and roots are validated; removal affects stored data |
| `/api/tickets` | Query/create tickets and delete by IDs | Workspace-scoped, local/unlocked; child routes manage individual tickets |
| `/v1/personas` and child routes | Create/list experimental persistent Personas, goals, and controls | Workspace-scoped; lifecycle and version checks apply |
| `/v1/roles` and child routes | Role definitions and immutable versions for Personas | Experimental administration contract |

Read the source handler and its validation schema for internal/experimental request bodies before writing an integration. Handle validation errors, forbidden exposure/auth responses, locked-workspace responses, conflicts, and temporary initialization failures. Retry only operations whose side effects you understand.

## MCP API

FLUJO can connect to MCP servers and expose configured servers through `/mcp-proxy/{server}` or flows through `/mcp-flows`. These transports have their own local/exposure and worker-auth gates. See [Connected Apps](../features/mcp/overview.md), [MCP Apps](../features/mcp/apps.md), and the in-app reference for the selected transport.

## Keeping the reference current

Run `node scripts/generate-api-inventory.mjs` after route changes. CI checks it with `--check`, so added or removed handlers cannot silently disappear from the inventory. Update the curated examples separately when public request/response behavior changes. There is no separately documented stable JavaScript SDK; use the supported HTTP/MCP surfaces.
