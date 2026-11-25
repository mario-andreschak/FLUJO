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

## Claude channel messages (no delivery guarantee)

Under **What the server sends**, choose **Claude channel messages (no delivery guarantee)**
for a server built as a [Claude Code channel](https://code.claude.com/docs/en/channels-reference).
Such a server declares `experimental['claude/channel']` and sends
`notifications/claude/channel` with `content` (text) and optional `meta` (text values).
Like Claude Code, FLUJO keeps only `meta` keys made of letters, digits and underscores.

- FLUJO keeps the server running and connected while the automation is on, and checks
  the connection every few minutes.
- Messages go through the same steps as events: the same checks, the same "already seen"
  list, the same steering into a running conversation, and they reach the flow as untrusted
  data (`data.channel` and `data.messages`).
- A burst becomes one run: messages that arrive within a quarter of a second are handed
  over together.
- A message with `meta.event_id` or `meta.message_id` is recognised when it comes again.
  Without one, two equal messages are two messages.
- While the automation is busy, FLUJO holds messages and tries again, for up to 30 minutes
  and within a memory budget that scales with the machine. After that, or when the budget
  is full, the oldest are dropped and the automation card says so. The note clears on the
  next successful check.

Channels have no acknowledgement and no replay. A message sent while FLUJO or the server
is off is lost, and so are messages held when the automation is changed or switched off.
Choose **Events (delivery guaranteed)** whenever the server offers them. Only automations
that chose this source listen; without one, channel messages are ignored and nothing runs.

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
