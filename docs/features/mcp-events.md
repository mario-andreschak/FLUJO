# MCP events

An automation can start the moment an MCP server reports something, such as a new
message, instead of checking a tool on a timer.

Choose **A tool server reports an event** in the automation editor, then pick a server
and one of its events. Servers that do not report events show a note, and "Watch a tool"
remains the alternative for them.

## How it works

1. When the automation is armed, FLUJO calls `events/subscribe` on the server with a local
   URL (`/api/webhooks/mcp/{id}`) and a generated signing secret. It repeats this every few
   minutes, which keeps the subscription alive and tells the server FLUJO is reachable.
2. The server posts each event as a signed webhook.
3. FLUJO checks the signature and starts the flow or Persona. The event reaches it as
   untrusted trigger data.

The wire format follows the webhook part of the
[MCP events draft](https://github.com/modelcontextprotocol/experimental-ext-triggers-events)
and [Standard Webhooks](https://www.standardwebhooks.com/) signing. The draft will change,
so everything that knows its format is in `src/backend/services/mcp/serverEvents.ts`. A
server opts in by declaring `events`, either top-level or under `experimental`.

`events/*` are protocol requests rather than tools on purpose: a model can call a tool, but
it cannot create a subscription.

## Delivery guarantees

The sender owns reliability. FLUJO never holds an unstarted event in memory:

| FLUJO answers | Meaning | The sender |
|---|---|---|
| `202` | The run started | Moves on |
| `200` | Already seen (`webhook-id` is remembered) | Moves on |
| `503` + `Retry-After` | A run is going, or automations are paused | Tries the same event again |
| `410` | Automation deleted, disabled or changed | Stops this subscription |
| `401` | Bad signature | Retries with backoff |
| `413` | Over 256 KB | Skips the event |

Events are processed one at a time unless the automation allows parallel runs. The `skip`
overlap setting does not apply to this trigger, because a skipped event would be lost after
the sender was told it arrived.

While the automation is armed, FLUJO pins the server so it is not closed for being idle.

The endpoint only accepts calls from this computer.

## Writing a server

Declare the capability and implement `events/list` and `events/subscribe`. Keep the events
durably and retry until a `2xx`. `mcp-whatsapp-web` is a complete example.
