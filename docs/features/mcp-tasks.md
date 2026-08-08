# MCP Tasks extension (issue #404)

FLUJO can consume the official MCP **Tasks** extension as a *client*: a
long-running tool call may return a task handle immediately, and FLUJO then
polls the task to completion, durably, across restarts.

Everything below is implemented behind feature flags and defaults to **off**.

## Pinned protocol contract

Implemented against the repository's resolved
`@modelcontextprotocol/sdk` **1.30.0** (`dist/esm/experimental/tasks/*`), which
is the only Tasks implementation FLUJO can interoperate with today. All
unstable SDK surface is isolated in
[`src/backend/services/mcp/tasksProtocol.ts`](../../src/backend/services/mcp/tasksProtocol.ts);
the wire types and validators live in
[`src/shared/types/mcp/tasks.ts`](../../src/shared/types/mcp/tasks.ts).

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

### Deviations from the original planning note

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
   augmentation. It says yes only when the flag is on **and** the live server
   advertised `tasks.requests.tools.call` **and** the tool declares
   `execution.taskSupport` as `required`/`optional`. Classic servers never see
   Tasks metadata.
2. A validated `CreateTaskResult` enters
   [`clientTasks.ts`](../../src/backend/services/mcp/clientTasks.ts), which
   persists a durable record **before** the first follow-up request.
3. Polling uses the clamped `pollInterval`, bounded by the caller timeout, the
   abort signal, the task TTL and a bounded exponential backoff (max 5
   consecutive transient failures) for transport errors/reconnects.
4. Terminal mapping: `completed` → payload fetched with `tasks/result`;
   `failed` → the server's `statusMessage`; `cancelled` → FLUJO's distinct
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
- `serverIdentity` is a SHA-256 fingerprint of non-secret connection structure
  (transport, command/args/url, env/header *names*, whether OAuth is
  configured) — never a secret value.
- Identity fields (`recordId`, `remoteTaskId`, `serverName`, `serverIdentity`,
  `toolName`, `requestFingerprint`, `createdAt`) are immutable after creation.
- Every transition goes through a per-record write chain and a legality check;
  terminal states are immutable.
- **Not persisted:** tool arguments, credentials, headers, elicited input, and
  terminal result payloads. Arguments are represented by a truncated SHA-256
  fingerprint; results stay on the server and are re-fetched via `tasks/result`;
  error/status text is bounded to 500 characters.

### Restart and reconnect

At startup (after the MCP server sweep, so live clients exist)
[`remoteTaskResume.ts`](../../src/backend/services/mcp/remoteTaskResume.ts)
resumes non-terminal, non-expired records **only** when the server config still
exists and its identity fingerprint still matches. Mismatches fail closed with a
non-secret diagnostic (`server-missing`, `identity-mismatch`); a disconnected
server is left for a later sweep (`server-disconnected`). Because the
originating run is gone, a resumed task is polled for observability only: its
terminal state is recorded with the `owner-unavailable` diagnostic and the
payload is deliberately **not** fetched or stored.

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

## Server-side status (deliberately not shipped)

FLUJO's own MCP endpoints (`/mcp-proxy/[server]`, `/mcp-flows`) do **not**
advertise or implement Tasks. Both build a fresh `Server` per request on a
stateless Streamable HTTP transport and have no authenticated caller identity:
`/mcp-proxy` only enforces localhost + explicit exposure, and `/mcp-flows` has
no caller boundary at all. Since task `get`/`result`/`cancel` would then be
reachable by task id alone, enabling server-side Tasks before a caller-bound
ownership mechanism exists would be an authorization hole.

Per the plan's security review gate, server-side Tasks therefore stay disabled
until (a) a stable caller identity can be bound to each task record, and (b) one
specific long-running FLUJO operation is approved as the first exposed task.
The durable store here is already endpoint-agnostic and can back that work.

## Observability

Structured, redacted logging covers creation, every transition, polls, backoff,
input waits/answers, cancellation attempts, expiry, resume decisions and
completion. Task ids, statuses, intervals and diagnostics are logged; arguments,
inputs and results are not.

## Interoperability

The pinned reference is `@modelcontextprotocol/sdk` 1.30.0's experimental Tasks
implementation (`experimental/tasks/server.ts` +
`experimental/tasks/stores/in-memory.ts`), which is what an end-to-end
interoperability suite should be run against. Classic (non-Tasks) servers over
stdio, SSE and Streamable HTTP are unaffected: no Tasks metadata is sent to them
and synchronous behavior is unchanged.
