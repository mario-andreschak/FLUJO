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
| `200` | Already seen (`webhook-id` is remembered), or added to the running conversation | Moves on |
| `503` + `Retry-After` | A run is going, automations are paused, or the steered conversation has not reached a safe point yet | Tries the same event again |
| `410` | Automation deleted, disabled or changed | Stops this subscription |
| `401` | Bad signature | Retries with backoff |
| `413` | Over 256 KB | Skips the event |

Events are processed one at a time unless the automation allows parallel runs. The `skip`
overlap setting does not apply to this trigger, because a skipped event would be lost after
the sender was told it arrived.

While the automation is armed, FLUJO pins the server so it is not closed for being idle.

The endpoint only accepts calls from this computer.

## Steer a running conversation

Fill in **Send to a running conversation (optional)** with a conversation id or a
pasted chat link (`/chat?conversation=<id>`). While that conversation is running, each
event is added to it as a new message instead of starting a run. When it is not running,
the automation starts a run as usual.

- The message is the automation's prompt plus the event in the same labelled block a run
  gets, so the content stays untrusted data. The chat shows it as "Event from <server>".
- It takes the same path as a message typed into a running chat, so every model picks it up
  at its next safe point. Like those messages, it is kept word for word when a long chat is
  summarized, so its "untrusted" label is never lost in a summary.
- The event counts as delivered only once it is part of the conversation. Until then FLUJO
  answers `503` and the event stays queued in the conversation; the sender's retry is told
  `200` once it landed. Each event has a fixed message id, so retries never add it twice.
- If the conversation stops before the event landed, FLUJO takes the waiting copy back and
  starts a run instead.
- Persona conversations take the event through the Persona's durable mailbox.

## Writing a server

Declare the capability and implement `events/list` and `events/subscribe`. Keep the events
durably and retry until a `2xx`. `mcp-whatsapp-web` is a complete example.
