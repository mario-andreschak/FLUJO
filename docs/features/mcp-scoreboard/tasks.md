# Scoreboard row: Tasks

Row on [Is MCP good yet?](https://ismcpgoodyet.com/): "Long-running work
returns a durable task id. The client polls, supplies input, and resumes after a
disconnect." The board rated Claude Code **Partial** on November 27 because some
of its surfaces get no Tasks and it does not use `tasks/list` or task
notifications.

FLUJO status (November 27, 2026, branch `wip-cleanup`, epic
[#1448](https://github.com/mario-andreschak/FLUJO/issues/1448)): **Yes** for
the criteria above, on every transport, on by default. Task notifications are
optional in the extension and not used (see below). Not in a release yet.

Sources: [Tasks overview](https://modelcontextprotocol.io/extensions/tasks/overview),
[ext-tasks 0.2.2](https://github.com/modelcontextprotocol/ext-tasks/tree/5246bc3d0253c1c4b09e682f690b7e8b97362500)
(`@modelcontextprotocol/ext-tasks` 0.2.2, Apache-2.0). Background:
[MCP Tasks 2026](../mcp-tasks-2026.md), [MCP Tasks](../mcp-tasks.md).

## FLUJO as a client

| Criterion | Status | Source | Test |
| --- | --- | --- | --- |
| Always on, no switch | Yes | [clientTasks.ts](../../../src/backend/services/mcp/clientTasks.ts) | every Tasks suite below |
| Declares `io.modelcontextprotocol/tasks` per request and only asks for a task when the server advertises it | Yes | [tasksProtocol.ts](../../../src/backend/services/mcp/tasksProtocol.ts) `decideTaskAugmentation` | `modernTasksDispatch.test.ts`, `toolsModernTasks.test.ts` |
| Works on every transport that speaks 2026-07-28: Streamable HTTP, SSE and stdio (before: remote HTTP only) | Yes | Tasks registration in [betaClient.ts](../../../src/backend/services/mcp/betaClient.ts) | `stdioProtocolNegotiation.test.ts` "runs a modern Task over stdio"; `modernTasksDispatch.test.ts` (HTTP) |
| Older 2025-11-25 servers: per-tool task support, `tasks/get`, `tasks/result`, `tasks/cancel` | Yes | [tasksProtocol.ts](../../../src/backend/services/mcp/tasksProtocol.ts) | `tasksGenerationsProtocol.test.ts`, `clientTasksGenerationsLifecycle.test.ts` |
| Durable task id: a record is saved before the first follow-up request | Yes | [clientTasks.ts](../../../src/backend/services/mcp/clientTasks.ts), [remoteTaskStore.ts](../../../src/backend/services/mcp/remoteTaskStore.ts) | `stdioProtocolNegotiation.test.ts`, `clientTasksLifecycle.test.ts` |
| Polls `tasks/get` at the server's `pollIntervalMs`, within FLUJO's bounds, caller timeout and task lifetime | Yes | clientTasks.ts | `clientTasksLifecycle.test.ts` |
| Supplies input: `input_required` opens the attended form, the answer goes back with `tasks/update` | Yes; unattended runs cancel instead of waiting | clientTasks.ts, [tasksExtensionSession.ts](../../../src/backend/services/mcp/tasksExtensionSession.ts) | `clientTasksLifecycle.test.ts`, `tasksExtensionSession.test.ts` |
| Cancels with `tasks/cancel`, at most once | Yes | clientTasks.ts | `clientTasksLifecycle.test.ts` |
| stdio: an abandoned Tasks request is cancelled with `notifications/cancelled` | Yes | `RawTasksChannel` in tasksExtensionSession.ts | no separate test |
| **Resumes after a disconnect during a run**: polling follows the same task id onto the server's replacement connection and delivers the result to the run | Yes (new) | `followOnNewConnection` in clientTasks.ts; `reacquireClient` in [tools.ts](../../../src/backend/services/mcp/tools.ts) | `clientTasksLifecycle.test.ts` "follows the same task on the replacement connection" |
| Only a matching server is followed: same server identity, same protocol generation; no replacement within the task's lifetime keeps the record recoverable and does not cancel it | Yes | same | `clientTasksLifecycle.test.ts` "without a replacement connection" |
| Resumes after a FLUJO restart | Yes, for the outcome: polling resumes and records the final state; a result cannot reach a run that died with the old process | [remoteTaskResume.ts](../../../src/backend/services/mcp/remoteTaskResume.ts) | `remoteTaskResumeGeneration.test.ts` |
| Every surface: chat, flows, scheduled flows and tool calls forwarded through `/mcp-proxy` all use the same tool-call path | Yes | `mcpService.callTool` | the suites above |
| `tasks/list` | Not part of the 2026-07-28 extension (0.2.2); FLUJO keeps its own durable task list | — | — |
| Task notifications (`notifications/tasks` on `subscriptions/listen`) | Not used: optional in the extension, polling is the documented default | — | — |

A stdio server keeps its tasks in its own process. If that process dies, the
task is gone; FLUJO then records the server's "task unavailable" answer.

## FLUJO as a server (`/mcp-flows`)

| Criterion | Status | Source | Test |
| --- | --- | --- | --- |
| Saved flows run as durable tasks for modern clients that declare Tasks | Yes, always on, no switch | [flowsTasksServer.ts](../../../src/backend/services/mcp/flowsTasksServer.ts), [serverTasks.ts](../../../src/backend/services/mcp/serverTasks.ts) | `flowsTasksServer.test.ts` |
| Tasks belong to an owner: offered only with the owner bearer; without owner sign-in, ordinary tools still work and no Tasks are offered | Yes | `resolveModernOwner` | `flowsTasksServer.test.ts` |
| `tasks/get`, `tasks/update` (confirmation form), `tasks/cancel`; results survive restart, interrupted work is never replayed | Yes | serverTasks.ts | `flowsTasksServer.test.ts`; production smoke `node scripts/smoke-mcp-tasks.mjs --production` |
| `/mcp-proxy` Tasks | Not offered: the proxy waits for a downstream task and returns its final result | [proxyModernServer.ts](../../../src/backend/services/mcp/proxyModernServer.ts) | `proxyModernServing.test.ts` |

## Still open

- The official conformance tool's `tasks-*` server scenarios were not run: they
  need the owner bearer, which the tool cannot send. Run them by hand against an
  owner-configured FLUJO when the tool supports headers.
- Optional task notifications could shorten the wait between polls.
- A result for a run that died in a restart cannot be delivered until
  MCP-started runs are saved first (#1095).
- Installed-app and release checks are release pre-flight.
