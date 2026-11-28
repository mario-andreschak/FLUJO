# MCP events

An automation can start the moment an MCP server reports something, such as a new
message, instead of checking a tool on a timer.

Choose **A tool server reports an event** in the automation editor, then pick a server
and one of its events. Servers that do not report events show a note, and "Watch a tool"
remains the alternative for them.

FLUJO follows the [MCP events extension](https://github.com/modelcontextprotocol/ext-events)
(`io.modelcontextprotocol/events`, defined by
[SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/3415-events-extension.md),
Beta since 2026-11-19). A server opts in by declaring the extension in
`capabilities.extensions`, or, as earlier drafts did, `events` top-level or under
`experimental`. FLUJO declares itself as an events client in each request's `_meta`.

`events/*` are protocol requests rather than tools on purpose: a model can call a tool, but
it cannot create a subscription.

## How events arrive

The extension has three delivery modes. Each event lists the ones it offers, and the
editor shows them under **How events arrive**. FLUJO picks the first one the event offers
in this order:

| Mode | How it works | Why this place in the order |
|---|---|---|
| **Push** | FLUJO keeps one `events/stream` request open on the MCP connection. Events arrive as notifications the moment they happen. | No address to reach, works with local and remote servers, no delay. |
| **Poll** | FLUJO calls `events/poll` at the pace the server asks for (`nextPollMs`, never more than once a second). | Works with every server; events arrive a little later. |
| **Webhook** | The server posts signed requests to `http://127.0.0.1:<port>/api/webhooks/mcp/{id}`. | The spec asks for `https` callback URLs and lets servers refuse this computer's address, so only local servers that allow it can use it. |

An event that lists no modes comes from an earlier draft, which only knew webhooks.
Automations saved before push and poll existed keep using webhooks until you pick another
mode.

All three modes:

- go through the same steps once an event arrives: the "already seen" list (by `eventId`),
  steering into a running conversation, the Persona mailbox, and the labelled untrusted
  data block a run gets;
- save the server's `cursor` once an event is accepted and send it when they start again,
  so a restart of FLUJO or of the server carries on where FLUJO stopped. A cursor is only
  sent to the subscription (server, event, filter) it came from;
- keep the server running while the automation is on (it is pinned, so it is not closed for
  being idle);
- show a note on the automation card when the server reports skipped events (`truncated` or
  a `gap`), when the connection is lost, or when the server ends the subscription, and clear
  it on the next success. They keep trying with growing waits and never give up for good;
- replace a connection that stopped answering. When a request gets no usable answer and the
  server does not answer a ping either, FLUJO builds a new connection (a stdio server that
  hangs is ended and started again) and tries once more. A server that still answers keeps
  its own error, and the waits above apply.

On Streamable HTTP with the newer client, every `events/*` request except `events/list`
carries `Mcp-Name` and one `Mcp-Param-*` header per argument marked `x-mcp-header`, as the
spec asks. An event whose `x-mcp-header` marks break the transport's rules is left out of
the list.

### Push

1. When the automation is armed, FLUJO sends `events/stream` with the event name, the
   filter and the saved cursor (none the first time, which means "from now").
2. The server confirms with `notifications/events/active`. Then events, heartbeats and
   errors follow as notifications that carry the request's id, so several streams can share
   one connection.
3. Events that arrive within a quarter of a second become one run (`data.event` for one,
   `data.events` for several).
4. While the automation is busy, events wait in memory, bounded by count and by a budget that
   scales with the machine. When that is full and the server can replay (its cursor is not
   `null`), FLUJO closes the stream, forgets the waiting events and opens it again from the
   saved cursor once it caught up. Nothing is lost and memory stays bounded. For an event
   type without replay the oldest waiting events are dropped and the card says so.
5. Heartbeats move the saved cursor forward while nothing waits. No message for three
   heartbeats means the stream is dead; FLUJO opens a new one. Every reconnect waits a short
   random moment first, as the spec asks.
6. When the automation is switched off, changed or deleted, FLUJO cancels the stream.

### Poll

1. The first poll sends no cursor ("from now"); later polls send the saved one.
2. A poll answer with events becomes one run. While the automation is busy, FLUJO keeps
   that batch and tries again; it does not poll further, so nothing piles up.
3. The cursor is saved only after the batch was accepted. `hasMore` drains a backlog at
   once; otherwise the next poll waits `nextPollMs`, at least one second.

### Webhook

1. When the automation is armed, FLUJO calls `events/subscribe` with its local URL, a
   generated signing secret and the saved cursor. It repeats this every few minutes, which
   keeps the subscription alive; each grant asks for at most one day. The answer's cursor is
   saved too, so a quiet subscription does not fall behind the server's history.
2. If the server first checks the URL, FLUJO answers its challenge.
3. The server posts each event as a signed webhook
   ([Standard Webhooks](https://www.standardwebhooks.com/)). FLUJO checks the signature and
   starts the flow or Persona.
4. When the automation is deleted, switched off, pointed at another event or moved to
   another mode, FLUJO calls `events/unsubscribe`. Pausing all automations keeps the
   subscription, so events wait.

| FLUJO answers | Meaning | The sender |
|---|---|---|
| `202` | The run started | Moves on |
| `200` | Already seen (by `eventId`, or `webhook-id` for older senders), or added to the running conversation | Moves on |
| `200` + `{"challenge": …}` | The answer to a `verification` message | Activates delivery |
| `200` | A `gap` or `terminated` notice; the automation card shows a note | Moves on |
| `503` + `Retry-After` | A run is going, automations are paused, or the steered conversation has not reached a safe point yet | Tries the same event again |
| `410` | Automation deleted, disabled, changed or moved to push or poll | Drops this delivery |
| `401` | Bad signature | Retries with backoff |
| `413` | Over 256 KB | Skips the event |

The spec suggests a sender retries for only 10 to 15 minutes. An event that stays busy
longer can be dropped by the sender; the saved cursor brings it back only when the server
honours it. The endpoint only accepts calls from this computer.

Events are processed one at a time unless the automation allows parallel runs. The `skip`
overlap setting does not apply to this trigger, because a skipped event would be lost after
it was accepted.

## Claude channel messages (no delivery guarantee)

Under **What the server sends**, choose **Claude channel messages (no delivery guarantee)**
for a server built as a [Claude Code channel](https://code.claude.com/docs/en/channels-reference).
Such a server declares `experimental['claude/channel']` and sends
`notifications/claude/channel` with `content` (text) and optional `meta` (text values).
Like Claude Code, FLUJO keeps only `meta` keys made of letters, digits and underscores.

- FLUJO keeps the server running and connected while the automation is on, and checks
  the connection every few minutes. A connection that no longer answers a ping is replaced.
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

Permission relay (`claude/channel/permission`) is not supported: anyone who can write to a
channel could then approve tool use.

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
- The event counts as delivered only once it is part of the conversation. Until then it
  waits (push and poll hold it; a webhook sender is told `503`). Each event has a fixed
  message id, so a second try never adds it twice.
- If the conversation stops before the event landed, FLUJO takes the waiting copy back and
  starts a run instead.
- Persona conversations take the event through the Persona's durable mailbox.

## Bridge to Claude Code (not built)

The plan in #1401 has a small stdio program that Claude Code starts as a channel and that
forwards FLUJO's events into a Claude Code session. It is deferred: Claude Code channels are
still a research preview, a custom channel only loads with
`--dangerously-load-development-channels` in an interactive session (never with `-p` or the
Agent SDK), and organisations can switch channels off. The design itself still fits the
current Claude Code docs (stdio, `experimental['claude/channel']`, `content` plus `meta`).

## Not covered yet

- `notifications/events/list_changed` arrives only on a `subscriptions/listen` stream that
  asks for `eventsListChanged`. FLUJO does not ask for it; the editor reads `events/list`
  each time it opens, and a removed or changed event ends its subscription with a
  `terminated` notice, which the card shows.
- `maxAgeMs` is not sent: after a long break FLUJO replays everything the server still keeps
  instead of skipping old events. Bursts still become a few runs.

## Writing a server

Declare the extension and implement `events/list` plus at least one mode: `events/stream`
(push), `events/poll`, or `events/subscribe` and `events/unsubscribe` (webhook). Put an
`eventId` and, if you can, a `cursor` on every event. `mcp-whatsapp-web` is a complete
webhook example; `__tests__/mcp/mcpEventsPushPoll.test.ts` has a small push and poll server
built on the official SDK.

`__tests__/mcp/fixtures/eventSourceServer.mjs` is a complete server on the official SDK that
runs as its own process, over stdio or Streamable HTTP: push, poll, Claude channel messages
and resource notifications, with a history file so a restarted server replays from a cursor.
`__tests__/mcp/realEventSource.test.ts` connects it through FLUJO's real connection code,
kills it, restarts it and hangs it, and checks the run history, the card note, the server
status and the resource list version.
