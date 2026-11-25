# MCP events

An automation can start the moment an MCP server reports something, such as a new
message, instead of checking a tool on a timer.

Choose **A tool server reports an event** in the automation editor, then pick a server
and one of its events. Servers that do not report events show a note, and "Watch a tool"
remains the alternative for them.

## How it works

1. When the automation is armed, FLUJO calls `events/subscribe` on the server with a local
   URL (`/api/webhooks/mcp/{id}`), a generated signing secret and the cursor of the last
   event it accepted. It repeats this every few minutes, which keeps the subscription alive
   and tells the server FLUJO is reachable. Each grant asks for at most one day.
2. If the server first checks the URL, FLUJO answers its challenge.
3. The server posts each event as a signed webhook.
4. FLUJO checks the signature and starts the flow or Persona. The event reaches it as
   untrusted trigger data.
5. When the automation is deleted, switched off or pointed at another event, FLUJO calls
   `events/unsubscribe`. Pausing all automations keeps the subscription, so events wait.

The wire format follows the webhook part of the
[MCP events extension](https://github.com/modelcontextprotocol/ext-events)
(`io.modelcontextprotocol/events`, SEP-3415, Beta) and
[Standard Webhooks](https://www.standardwebhooks.com/) signing. The extension can still
change, so everything that knows its format is in `src/backend/services/mcp/serverEvents.ts`
and `receiveMcpEvent`. A server opts in by declaring the extension in
`capabilities.extensions`, or, as earlier drafts did, `events` top-level or under
`experimental`. FLUJO declares itself as an events client in each request's `_meta`.

`events/*` are protocol requests rather than tools on purpose: a model can call a tool, but
it cannot create a subscription.

## Delivery guarantees

The sender owns reliability. FLUJO never holds an unstarted event in memory:

| FLUJO answers | Meaning | The sender |
|---|---|---|
| `202` | The run started | Moves on |
| `200` | Already seen (by `eventId`, or `webhook-id` for older senders), or added to the running conversation | Moves on |
| `200` + `{"challenge": …}` | The answer to a `verification` message | Activates delivery |
| `200` | A `gap` or `terminated` notice; the automation card shows a note | Moves on |
| `503` + `Retry-After` | A run is going, automations are paused, or the steered conversation has not reached a safe point yet | Tries the same event again |
| `410` | Automation deleted, disabled or changed | Drops this delivery |
| `401` | Bad signature | Retries with backoff |
| `413` | Over 256 KB | Skips the event |

Events are processed one at a time unless the automation allows parallel runs. The `skip`
overlap setting does not apply to this trigger, because a skipped event would be lost after
the sender was told it arrived.

FLUJO saves the server's `cursor` from each accepted event (and from a `gap` notice) and
sends it with every subscribe. A subscription that expired while FLUJO was off starts again
from there instead of "from now". Repeats from such a replay are recognised by `eventId`.

The current draft suggests a sender retries for only 10 to 15 minutes. An event that stays
busy longer (a run that takes longer than that while the next event waits) can be dropped
by the sender. The saved cursor helps only when the server honours it.

While the automation is armed, FLUJO pins the server so it is not closed for being idle.

The endpoint only accepts calls from this computer.

### Known gap: `https` callback URLs

The current draft says servers must refuse callback URLs that are not `https`, and should
refuse loopback addresses unless configured to allow them. FLUJO's URL is
`http://127.0.0.1:<port>/…`, so it works with servers that allow local delivery
(`mcp-whatsapp-web` does), but a strict server will refuse the subscription and the card
shows its error. The draft's `events/stream` push mode, over the MCP connection itself,
would avoid this for local servers; it is not built yet.

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
- The event counts as delivered only once it is part of the conversation. Until then FLUJO
  answers `503` and the event stays queued in the conversation; the sender's retry is told
  `200` once it landed. Each event has a fixed message id, so retries never add it twice.
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

## Writing a server

Declare the extension and implement `events/list`, `events/subscribe` and
`events/unsubscribe`. Keep the events durably and retry until a `2xx`. Put an `eventId` and,
if you can, a `cursor` on every event. `mcp-whatsapp-web` is a complete example.
