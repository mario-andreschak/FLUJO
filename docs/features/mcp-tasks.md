# MCP Tasks legacy adapter notes (issue #404)

These notes record the original SDK1 client baseline. For the current modern
extension, deployment switches, authorized server operation, migration,
durability and qualification, see [MCP Tasks 2026](mcp-tasks-2026.md).
The table below describes the legacy wire contract; the lifecycle notes cover
both generations.

FLUJO can consume both MCP **Tasks** generations as a *client*: a
long-running tool call may return a task handle immediately, and FLUJO then
polls the task to completion, durably, across restarts.

The delivered client lifecycle is behind a feature flag and defaults to **off**.
Modern server Tasks are separately enabled at `/mcp-flows`; see the linked
deployment and authorization requirements. The legacy endpoint stays synchronous.

## Pinned protocol contract

Implemented against the repository's resolved
`@modelcontextprotocol/sdk` **1.32.1** (`dist/esm/experimental/tasks/*`), which
provides the legacy contract; an isolated adapter also validates the newer extension. All
unstable SDK surface is isolated in
[`src/backend/services/mcp/tasksProtocol.ts`](../../src/backend/services/mcp/tasksProtocol.ts);
the wire types and validators live in
[`src/shared/types/mcp/tasks.ts`](../../src/shared/types/mcp/tasks.ts).

This is the 2025-11-25 core Tasks generation. The
[2026-07-28 Tasks extension](https://modelcontextprotocol.github.io/ext-tasks/specification/2026-07-28/tasks.html)
uses per-request extension capabilities, `resultType: "task"`, `ttlMs`,
`pollIntervalMs`, keyed `tasks/update` inputs and inline terminal `tasks/get`
results. FLUJO discovers and translates that generation independently, retaining
the original generation on each durable task record. Historical records without
a generation remain legacy. The table below describes the legacy contract.

| Concern | Contract |
| --- | --- |
| Negotiation (server) | `capabilities.tasks.requests.tools.call`, plus optional `tasks.cancel` / `tasks.list` |
| Negotiation (per request) | `params.task = { ttl }` (`TaskAugmentedRequestParams`) |
| Per tool | `tool.execution.taskSupport`: `required` / `optional` / `forbidden` |
| Creation result | `CreateTaskResult = { task: Task }` |
| Task | `{ taskId, status, ttl, createdAt, lastUpdatedAt, pollInterval?, statusMessage? }` |
| Statuses | `working`, `input_required`, `completed`, `failed`, `cancelled` |
| Baseline methods | `tasks/get`, `tasks/result`, `tasks/cancel` (`tasks/list` unused) |
| Deferred | `notifications/tasks/status`, `subscriptions/listen` |

### Legacy differences from the original planning note

The plan was written against an earlier draft. Three of its assumptions do not
exist in the resolved SDK/spec and were implemented per the real contract:

1. **No `resultType: "task"` discriminator.** A task result is
   `{ task: Task }`. FLUJO therefore classifies strictly instead: a payload with
   `content` / `structuredContent` is *always* a classic `CallToolResult`, even
   if it also carries a `task` key, and a task lifecycle only starts for a
   schema-valid task object (`classifyToolCallResult`).
2. **No `pollIntervalMs`.** The hint is `Task.pollInterval`, in milliseconds,
   clamped by FLUJO to `[1s, 60s]` (default 5s).
3. **No `tasks/update` and no `inputRequests`.** `input_required` is driven by
   the server issuing a *related* `elicitation/create` (or
   `sampling/createMessage`) carrying
   `_meta["io.modelcontextprotocol/related-task"] = { taskId }`. Answering that
   request *is* the task update; FLUJO then resumes `tasks/get`.

FLUJO declares **no `tasks` client capability**: that capability describes tasks
a *client* hosts for sampling/elicitation requests, which remains out of scope,
and advertising it would claim partial support.

## Client lifecycle

1. `callTool()` asks `decideTaskAugmentation()` whether to request task
   augmentation. Modern extension discovery is bounded and cached per live client.
   For legacy servers it says yes only when the flag is on **and** the live server
   advertised `tasks.requests.tools.call` **and** the tool declares
   `execution.taskSupport` as `required`/`optional`. Classic servers never see
   Tasks metadata.
2. A validated `CreateTaskResult` enters
   [`clientTasks.ts`](../../src/backend/services/mcp/clientTasks.ts), which
   persists a durable record **before** the first follow-up request.
3. Polling uses the clamped `pollInterval`, bounded by the caller timeout, the
   abort signal, the task TTL and a bounded exponential backoff (max 5
   consecutive transient failures) for transport errors/reconnects.
4. Terminal mapping: legacy `completed` → payload fetched with `tasks/result`;
   modern `completed` → validated inline `tasks/get` result; modern `failed` →
   bounded JSON-RPC code, message and optional data (returned, never persisted);
   legacy `failed` → the server's `statusMessage`; `cancelled` → FLUJO's distinct
   `cancelled` response.
5. Cancellation is cooperative and sent **at most once** (`tasks/cancel`) on
   abort, timeout, expiry, protocol violation or a poll-limit refusal. Terminal
   records are immutable, so a terminal result that lands first wins the
   cancel-vs-complete race.
6. Task creation is never retried after an ambiguous transport failure — the
   protocol has no idempotency key for `tools/call`. Only polling is resumable.

### `input_required` policy

FLUJO waits for input **only inside an attended run** (an active elicitation
context for that server that is not marked unattended). Otherwise — unattended
run, no active context, no UI able to answer — the task is cancelled and the
call fails with `task-input-required-unattended` instead of polling forever. A
task that stays in `input_required` longer than `inputRequiredTimeoutMs`
(default 5 min) is abandoned the same way.

Modern keyed requests use the same registered per-client elicitation, sampling and roots
handlers and policy checks as ordinary requests. The attended conversation must
match the task owner. At most 32 distinct input keys are handled per lifecycle;
answers are sent through `tasks/update` and are never written to task records.
Unknown or unregistered handlers are denied. Input waits are bounded by the
input window, caller deadline, TTL and abort signal. A modern cancellation
acknowledgement does not prove that the server has reached a terminal state.

Each follow-up request rechecks live client, caller authority and server identity.
Restarted tasks retain their original wire generation; changed generations or
connection identities are refused. Ownerless input after restart is cancelled
instead of being presented to another conversation.

Correlation between the two channels lives in
[`taskInputRegistry.ts`](../../src/backend/services/mcp/taskInputRegistry.ts).
It stores **elicitation ids only** — never the prompt, the schema or the user's
answer — and repeat submissions for the same id are ignored (idempotent).

## Durability, ownership and privacy

Records live in the workspace-owned collection `db/mcp-remote-tasks/<recordId>.json`
([`remoteTaskStore.ts`](../../src/backend/services/mcp/remoteTaskStore.ts)).

- The local `recordId` is a UUID; the remote task id is just a field. **A task id
  alone never authorizes access**: lookups require the server name *and* the
  server identity fingerprint.
- `serverIdentity` is the existing SHA-256 connection fingerprint
  (transport, command/args/url, env/header *names*, whether OAuth is
  configured). Command arguments and URLs can contain secrets, so this unkeyed
  fingerprint is not a confidentiality guarantee or an authorization token.
- Identity fields (`recordId`, `remoteTaskId`, `serverName`, `serverIdentity`,
  `generation`, `toolName`, `requestFingerprint`, `createdAt`) are immutable after creation.
- Every transition goes through a per-record write chain and a legality check;
  terminal states are immutable.
- **Not persisted:** tool arguments, credentials, headers, elicited input, and
  terminal result payloads. New request tags contain independent randomness;
  historical argument-derived fingerprints remain historical. Legacy results
  use `tasks/result`; modern results arrive inline without durable payload storage;
  error/status text is bounded to 500 characters.

### Restart and reconnect

At startup (after the MCP server sweep, so live clients exist)
[`remoteTaskResume.ts`](../../src/backend/services/mcp/remoteTaskResume.ts)
resumes non-terminal, non-expired records **only** when the server config still
exists and its identity fingerprint still matches. Mismatches fail closed with a
non-secret diagnostic (`server-missing`, `identity-mismatch`); a disconnected
server is left for a later sweep (`server-disconnected`). Because the
originating run is gone, a resumed task is polled for observability only: its
terminal state is recorded with the `owner-unavailable` diagnostic. Legacy
payload retrieval is skipped; modern inline status payloads are discarded and
never stored or delivered to another conversation.

## Limits and settings

Stored under `StorageKey.MCP_REMOTE_TASK_SETTINGS` (no secrets), defaults in
[`taskRecords.ts`](../../src/shared/types/mcp/taskRecords.ts):

| Setting | Default | Purpose |
| --- | --- | --- |
| `minPollIntervalMs` / `maxPollIntervalMs` | 1s / 60s | clamp an untrusted `pollInterval` |
| `defaultPollIntervalMs` | 5s | used when the server suggests none |
| `requestedTtlMs` / `fallbackTtlMs` | 1h | TTL requested / assumed when omitted |
| `maxConcurrentPolls` | 16 | global poll-concurrency cap |
| `maxConcurrentPollsPerServer` | 4 | per-server poll-concurrency cap |
| `maxTransientPollFailures` | 5 | bounded backoff before failing closed |
| `inputRequiredTimeoutMs` | 5 min | `input_required` wait window |
| `retentionAgeDays` | 7 | terminal-record retention |
| `maxResumePerStartup` | 25 | resume sweep budget |

Exceeding a concurrency cap refuses the task (`task-poll-limit`) rather than
creating a poll storm. An hourly cron sweeps expiry and retention per workspace.

## Feature flags

`src/config/features.ts`:

- `ENABLE_MCP_TASKS_CLIENT` (default `false`) — governs negotiation **and**
  durable record creation, so FLUJO never claims partial support. With the flag
  off FLUJO never requests task augmentation; if a server returns a schema-valid
  task handle anyway it is still handled correctly (never misread as a tool
  result), just without durable-compliance claims.
- `ENABLE_MCP_TASKS_SERVER` (default `false`) — see below.

## Server-side status

The modern `/mcp-flows` handler supports caller/workspace-bound durable Tasks
for saved flows when `FLUJO_MCP_TASKS_SERVER=true`. It requires the configured
owner policy and an explicit authorized bearer, rechecks authority before
execution and each lifecycle operation, and retains encrypted results across
restart without replaying interrupted work. Task IDs alone grant no access.
The feature defaults to off. The legacy `/mcp-flows` handler and `/mcp-proxy`
remain synchronous. See [MCP Tasks 2026](mcp-tasks-2026.md) for supported profiles,
bounds, protocol migration and the production smoke command.

## Observability

Structured, redacted logging covers creation, every transition, polls, backoff,
input waits/answers, cancellation attempts, expiry, resume decisions and
completion. Task ids, statuses, intervals and diagnostics are logged; arguments,
inputs and results are not.

## Interoperability

The resolved reference is `@modelcontextprotocol/sdk` 1.32.1's experimental Tasks
implementation (`experimental/tasks/server.ts` +
`experimental/tasks/stores/in-memory.ts`), which is what an end-to-end
interoperability suite should be run against. Classic (non-Tasks) servers over
stdio, SSE and Streamable HTTP are unaffected: no Tasks metadata is sent to them
and synchronous behavior is unchanged.
