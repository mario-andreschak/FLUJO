# Scoreboard row: Push events

Part of #1448 ("Get FLUJO to Yes on every MCP capability"). Checked on 2026-11-27 against
the [Is MCP good yet?](https://ismcpgoodyet.com/) scoreboard and the
[MCP events extension](https://github.com/modelcontextprotocol/ext-events/blob/main/specification/beta/events/events.mdx)
(`io.modelcontextprotocol/events`, Beta, defined by
[SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/3415-events-extension.md),
Final since 2026-11-19).

**Result: Yes**, as we read the criteria below. Baseline in #1448 was Partial: FLUJO only
had the webhook part of an earlier draft.

## What the scoreboard asks

The row's text, in short:

- A server gets an event to the model, or wakes its session, without a tool call for each
  event.
- Setting up a watch first is fine. List-change notifications alone do not count.
- The reference is the official Events extension, which defines poll, push and webhook
  delivery.

The board defines Partial as "opt-in, a subset, or experimental". Its notes show what keeps
a client at Partial: one client has push only, with poll and webhook missing and the
feature still labelled experimental. So for Yes we built all three modes of the current
extension, on by default in the normal automation editor.

## How FLUJO meets it

| Criterion | FLUJO | Source | Tests |
|---|---|---|---|
| Events reach the model without a tool call per event | An automation subscribes once; every event then starts a flow run, wakes a Persona, or joins a running conversation as a new message | `src/backend/services/scheduler/mcpEventDelivery.ts`, `src/backend/services/scheduler/eventSteering.ts` | `__tests__/scheduler/mcpEventPushPollTriggers.test.ts`, `__tests__/scheduler/mcpEventSteering.test.ts` |
| Push delivery (`events/stream`) | One long-lived stream per automation; `active`, `event`, `heartbeat`, `error`, `terminated` handled; streams on one connection kept apart by subscription id; cancel on close | `src/backend/services/mcp/serverEventStream.ts`, `src/backend/services/scheduler/triggers/mcpEventStream.ts` | `__tests__/mcp/mcpEventsPushPoll.test.ts` (official SDK server, both client generations) |
| Poll delivery (`events/poll`) | Polls at `nextPollMs` with a one-second floor, drains `hasMore`, holds a busy batch | `src/backend/services/mcp/serverEvents.ts`, `src/backend/services/scheduler/triggers/mcpEventPoll.ts` | `__tests__/mcp/mcpEventsPushPoll.test.ts`, `__tests__/scheduler/mcpEventPushPollTriggers.test.ts` |
| Webhook delivery (`events/subscribe`) | Standard Webhooks signatures, verification challenge, `gap` and `terminated` notices, refresh before expiry, `events/unsubscribe` on retire | `src/backend/services/scheduler/triggers/mcpEvent.ts`, `src/app/api/webhooks/mcp/[id]/route.ts` | `__tests__/scheduler/mcpEventsDraft.test.ts`, `__tests__/scheduler/mcpEventTrigger.test.ts` |
| Capability negotiation | Reads `capabilities.extensions["io.modelcontextprotocol/events"]` (and earlier draft keys); declares itself in each request's `_meta` | `serverSupportsEvents` in `src/backend/services/mcp/serverEvents.ts` | `__tests__/mcp/mcpEventsPushPoll.test.ts`, `__tests__/scheduler/mcpEventsDraft.test.ts` |
| Mode choice by the client | Picks push, then poll, then webhook from each event's `delivery` list; the user can change it | `preferredMcpEventDelivery` in `src/shared/types/plannedExecution/plannedExecution.ts`, `McpEventPanel.tsx` | `__tests__/mcp/mcpEventsPushPoll.test.ts` |
| Resume and dedup | Saves the cursor per subscription after acceptance (and from heartbeats, `active`, subscribe answers); dedups by `eventId` | `resumeCursor`, `withEventCursor`, `admitMcpEvents` in `mcpEventDelivery.ts` | `__tests__/scheduler/mcpEventPushPollTriggers.test.ts`, `__tests__/scheduler/mcpEventSchedulerLifecycle.test.ts` |
| Liveness and reconnect | Dead after three silent heartbeats; reconnect with random jitter and growing waits; heals on the next success | `armMcpEventStream` | `__tests__/scheduler/mcpEventPushPollTriggers.test.ts` |
| Streamable HTTP routing headers | `Mcp-Name` and `Mcp-Param-*` from `x-mcp-header` (Base64 form when needed); invalid annotations leave the event out of the list | `eventRequestHeaders`, `eventHeaderDeclarations` in `serverEvents.ts` | `__tests__/mcp/mcpEventsPushPoll.test.ts` |
| Payloads are untrusted | Event content reaches the model only inside the labelled untrusted data block, also when steered into a chat | `composeTriggerPrompt` in `src/backend/services/scheduler/triggerPrompt.ts` | `__tests__/scheduler/mcpEventSteering.test.ts` |
| Not experimental | Available to everyone in **Automations → A tool server reports an event**; no feature switch | `src/frontend/components/PlannedExecutions/McpEventPanel.tsx` | `__tests__/scheduler/mcpEventSchedulerLifecycle.test.ts` |

User guide: [docs/features/mcp-events.md](../mcp-events.md).

## Known limits (do not change the rating)

- `notifications/events/list_changed` is not requested (it needs a `subscriptions/listen`
  stream). The editor reads `events/list` each time; removed events end with `terminated`.
- `maxAgeMs` is not sent; after a long break FLUJO replays what the server still keeps.
- Webhook mode needs a server that accepts `http://127.0.0.1` callbacks; the spec asks for
  `https`. Push and poll have no such limit, and FLUJO prefers them.
- `Mcp-Name` and `Mcp-Param-*` are sent by the newer client only; the classic client speaks
  the earlier protocol revision, where these headers do not exist.

## Still to do by a person

- Try push and poll with a real third-party server that implements the Beta extension, once
  one is published (the tests use servers built on the official SDK).
- FLUJO is not listed on ismcpgoodyet.com. Asking the maintainers to add it is Mario's call.
