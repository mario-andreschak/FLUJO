# MCP Tasks: modern extension and retained legacy adapter

FLUJO supports the official Tasks extension on negotiated `2026-07-28` remote
connections, with `@modelcontextprotocol/ext-tasks` pinned to **0.2.2** and the
split client/server SDKs at **2.3.1**. The existing SDK1 adapter remains available
for 2025-era servers. Task creation is never retried after an ambiguous failure.

## Enable

Both deployment switches default to off. Set `FLUJO_MCP_TASKS_CLIENT=true` for
outbound task calls and `FLUJO_MCP_TASKS_SERVER=true` for inbound Tasks at
`/mcp-flows`. Changes require no source edits. For outbound modern negotiation,
also enable the existing **MCP beta protocol** experimental setting; its saved
setting name is retained for compatibility, although the split SDK is stable.
HTTP connections negotiate automatically. Stdio deliberately uses legacy
negotiation so one owned process cannot become an untracked probe sibling.

Server Tasks require a configured private `FLUJO_OWNER_AUTH_FILE` policy and an
unexpired owner bearer carrying `mcp:access`, `control:admin`, and `secrets:read`.
Use the existing owner bootstrap/credential workflow. The host/origin localhost
guard still applies. Each task is bound to the credential ID, owner, policy
revision, and actual admitted workspace; knowing a task ID grants no access.
Cookie sessions, worker control tokens, and bundled/private execution grants
cannot authorize this durable server path. No credential issuance rules change.

## Wire contract

Modern clients opt in on each request through
`_meta["io.modelcontextprotocol/clientCapabilities"].extensions["io.modelcontextprotocol/tasks"]`.
The server advertises `capabilities.extensions["io.modelcontextprotocol/tasks"]`
only when the feature and ordinary owner-authorized execution profile are ready.
The SDK validates protocol framing and the required HTTP routing headers;
`Mcp-Name` identifies the tool on `tools/call` and task ID on follow-up methods.

An eligible saved flow may return a **flat** creation result with
`resultType: "task"`, `taskId`, `status`, `createdAt`, `lastUpdatedAt`, `ttlMs`,
and `pollIntervalMs`. `tasks/get` returns `resultType: "complete"` with detailed
state: completed tasks carry `result`, failed tasks carry structured `error`,
and `input_required` carries keyed `inputRequests`. `tasks/update` accepts
correlated `inputResponses`; it and `tasks/cancel` return acknowledgements.
Unknown/already answered input keys are ignored and acknowledged. A key cannot
be reused to change an accepted answer. Optional task notifications/subscriptions
are not required: FLUJO uses bounded polling.

Authoring tools stay synchronous. Unknown tools and clients without Tasks opt-in
retain synchronous tool results. `/mcp-proxy` and the legacy `/mcp-flows` path do
not advertise server Tasks. Private execution tools stay synchronous.

The retained 2025 contract uses `capabilities.tasks.requests.tools.call`,
per-tool `execution.taskSupport`, request `task: { ttl }`, a nested `{ task }`
creation response, `tasks/result`, and related sampling/elicitation requests.
It does not send modern `tasks/update`. A retired modern connection never falls
through to these legacy RPC shapes.

## Input and cancellation

Saved flow tools accept optional `confirm: true`. A negotiated task with form
elicitation support asks for confirmation before running the flow. An accepted
`confirmed: true` answer runs it; decline/cancel skips execution. Confirmation
without form/Tasks support returns a synchronous tool error and creates no job.
The default remains `confirm: false`.

Outbound modern input uses the existing roots/sampling/elicitation policies.
Forms require an attended originating conversation and use the existing UI.
The connection, conversation, and policy are checked before effects and again
before submitting the answer. Headless/unattended inputs are cancelled rather
than opening a form. Repeated keys do not reopen the UI; changed requests under
an answered key fail closed. Abort/timeout removes a pending form and propagates
through sampling and the flow's runtime execution authority.

Cancellation is cooperative. Terminal states are immutable; cancellation does
not prove an arbitrary external effect was undone. Slots remain occupied until
the callback actually settles or its process dies, even after cancellation.
The client sends cancellation at most once, only on its still-current authorized
connection. Aborted creation replies have a bounded best-effort late-handle
cleanup window; a timeout or crash cannot guarantee that no remote job exists.

## Durability, privacy, and bounds

The server persists a handle and encrypted envelope **before** starting a flow.
The global ledger is under the data root's `.mcp-server-tasks/ledger.json`.
Results, input requests and response mailboxes are encrypted with the workspace
key and cryptographically bound to task/credential/workspace/policy identity.
The ledger does not store bearer tokens, original arguments, plaintext results,
or user answers. Ordinary flow/model archive behavior remains separate.
Storage/encryption failure prevents admission. Metadata and file reads are
bounded; corrupt ledgers/payloads fail closed.

Server limits: **128 retained records**, **32 running callbacks globally**,
**4 per owner across credentials**, **16 input keys**, and **32 KiB per encrypted JSON
payload**. The request body limit is **256 KiB**, including the era classifier.
The default server task lifetime is ten minutes and its maximum is 24 hours; expired
handles are unavailable. Active expired callbacks still retain their execution
slot. Revoked/expired credentials lose access and abort owned live execution.
Process ownership uses PID plus a birth marker. A live task can be polled,
updated or cancelled through another process. After process death, unfinished
tasks become `TASK_INTERRUPTED`, with **no replay**. Completed encrypted results
remain retrievable after restart and workspace unlock until expiry.

Remote client records retain only opaque request tags, task IDs, ownership,
protocol generation, status and bounded diagnostics. They store neither input
nor result payloads. Polling has global/per-server concurrency limits, clamped
intervals, transient-failure backoff, caller timeout and TTL bounds. Restart
resumes observability only when the connection identity and protocol generation
match; it cannot deliver a result to a lost originating run. Existing legacy
argument hashes and connection fingerprint limitations are not retroactively
remediated by new task records.

## Qualification and upstream references

Run `node scripts/smoke-mcp-tasks.mjs --production` after a production `npm run build` using a
supported Node runtime. It uses an isolated application/data/home, a local
synthetic OpenAI-compatible model, real SDK HTTP negotiation and a saved flow.
It exercises confirmation, cancellation, authorization, encrypted result
survival and interrupted execution after restart, plus legacy compatibility.
It does not contact a model account or use operator credentials.

The pinned upstream contract is the published
[0.2.2 source](https://github.com/modelcontextprotocol/ext-tasks/tree/5246bc3d0253c1c4b09e682f690b7e8b97362500).
See the [official overview](https://modelcontextprotocol.io/extensions/tasks/overview)
and [SDK migration guide](https://github.com/modelcontextprotocol/ext-tasks/blob/5246bc3d0253c1c4b09e682f690b7e8b97362500/typescript/migrating-from-the-sdk.md).
The upstream `/receiver` facade implements client-side 2025 task-backed
sampling/elicitation; it is not a modern tools server implementation.
