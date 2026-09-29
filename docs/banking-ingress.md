# Optional hackathon banking ingress

FLUJO can run one shared banking flow for many customers. A frontend backend verifies
the browser session and signs a short-lived user assertion. FLUJO verifies that
assertion, owns the conversation, and signs each finalized banking tool call.
Customer identity never comes from tool arguments, conversation metadata or URL parameters.

The optional implementation lives in `src/integrations/hackathon-banking`. Select its
`configuredAdapter.ts` with the absolute build setting `FLUJO_EXECUTION_ADAPTER_MODULE`.
The generic FLUJO build contains no banking routes, policy, dependencies or adapter.

## Frontend contract

Call these routes from your **frontend backend**, over a private authenticated connection.
Keep both the execution credential and signing key out of browser JavaScript.

| Route | Method | Body |
| --- | --- | --- |
| `/v1/chat/completions` | POST | `{ "model": "flow-APPROVED_FLOW_NAME", "messages": [{ "role": "user", "content": "…" }], "metadata": { "flujo": "true", "appendMessages": "true", "conversationId": "optional existing owned UUID" }, "stream": false }` |
| `/v1/chat/conversations/{id}` | GET | None |
| `/v1/chat/conversations/{id}/events` | GET | None; bounded SSE snapshots |
| `/v1/chat/conversations/{id}/cancel` | POST | None |
| `/v1/chat/conversations/{id}` | DELETE | None; permanent ownership tombstone |
| `/v1/banking/session/revoke` | POST | None; revoke the authenticated session |

Every request needs `Authorization: Bearer <banking execution credential>` and
`X-Flujo-User-Assertion: <JWT>`. Mint a fresh assertion/JTI for retries and SSE reconnects.
New conversations omit `metadata.conversationId`; unknown supplied IDs are rejected.
Foreign and unknown IDs both return 404. Routing, history, role, provider, graph,
debug and arbitrary metadata fields are rejected. Query strings and workspace headers are forbidden.

Sign assertions with Ed25519. Protected header must contain exactly
`alg: EdDSA`, a configured `kid`, and `typ: flujo-ingress+jwt`. Claims are exactly:

```json
{
  "iss": "your-frontend",
  "aud": "flujo-banking-ingress",
  "sub": "verified-opaque-user-subject",
  "session_id": "server-generated-stable-session-id",
  "session_exp": 1900003600,
  "iat": 1900000000,
  "nbf": 1900000000,
  "exp": 1900000120,
  "jti": "fresh-random-UUID",
  "scope": ["bank:read"]
}
```

`nbf` equals `iat`; assertion lifetime is at most 120 seconds. Session lifetime is at
most eight hours. Keep `session_id` and `session_exp` constant for the entire browser
session; rebinding a session to another subject or extending its expiry is rejected.
Derive `sub` from the verified login. Never accept a browser-supplied subject.

### Accepted work and request expiry

The short assertion authorizes a fresh request. After authentication, graph/model
approval, ownership checks and bounded admission, the server grants that completion
a separate execution lease. The original assertion still expires within 120 seconds;
every read, control, SSE reconnect and continuation requires a fresh valid assertion.
An accepted completion can continue after its original assertion expires.

Queue wait is bounded by `maxQueueWaitSeconds` (default and maximum 300 seconds).
Active work is bounded by the lower of `maxRunSeconds` and 110 seconds, including
conversation-lock waits and setup. The complete lease never exceeds 410 seconds from
acceptance. All three deadlines are clamped to the verified session expiry and cannot
be renewed. Use a 450-second client timeout when testing the full default queue and
active budgets; that client timeout does not grant additional server authority.

Cancellation and revocation cover queued and active work. Policy, session and existing
owner/tombstone checks run again before queued work activates and at execution
boundaries. Rejected or cancelled queued requests start no model or tool call. New
conversations receive no durable owner/state while queued. Leases remain in server
memory and never appear in request metadata, model input, transcripts or tool arguments.
Worker restart interrupts accepted jobs; a retry or continuation needs a new assertion
and JTI. No durable queue or automatic model retry is provided.

Completions retain the normal completion response shape and conversation correlation.
Read/SSE expose only bounded user/assistant messages. Authentication failures never
return raw provider errors, tool traces or signing material.

The specialized `/v1/banking/chat` and `/v1/banking/conversations` routes are retired
and return 404. Execution and conversation controls use the ordinary routes above;
`POST /v1/banking/session/revoke` remains available. Previously owned transcripts
continue to use their existing owner records through ordinary read, events,
cancellation and deletion routes. Retirement does not rewrite transcript data or
change the configured deployment, workspace, graph identity or authority storage.

## Private configuration

Set `FLUJO_BANKING_CONFIG` to an absolute path outside the workspace database.
Its JSON uses the following fields:

```json
{
  "deploymentId": "banking-demo-1",
  "workspace": "default-workspace",
  "executionToken": "REPLACE_WITH_RANDOM_SECRET_AT_LEAST_32_CHARACTERS",
  "stateDir": "/data/flujo/banking-authority",
  "frontendIssuer": "your-frontend",
  "frontendAudience": "flujo-banking-ingress",
  "frontendKeys": { "frontend-1": "REPLACE_WITH_ED25519_PUBLIC_PEM" },
  "bankIssuer": "flujo-banking-runtime",
  "bankAudience": "banking-mcp",
  "bankKeyId": "bank-1",
  "bankSigningKeyFile": "/run/banking/bank-signer.pem",
  "bankServerName": "Banking MCP",
  "bankCommand": "/opt/banking-mcp/.venv/bin/python",
  "bankCwd": "/opt/banking-mcp",
  "bankConfigFile": "/run/banking/bank-config.json",
  "flowId": "APPROVED_FLOW_ID",
  "graphHash": "REPLACE_WITH_64_LOWERCASE_HEX_CHARACTERS",
  "maxActiveRuns": 32,
  "maxQueuedRuns": 512,
  "maxPendingPerSubject": 3,
  "maxQueueWaitSeconds": 300,
  "maxRunSeconds": 110
}
```

The bank MCP independently trusts the bank signer public key and privately maps
verified subjects to customer IDs. It receives no frontend signing private key.
FLUJO receives only the frontend public keys. Mount the bank signer and configuration
read-only into the **existing Linux Docker worker**. Keep `stateDir` on its durable volume.
Do not use the worker's administrative/snapshot bearer as the banking execution credential.
Do not publish the administrative UI through the customer frontend.

Install Banking MCP and its Python dependencies inside the existing FLUJO container.
Register it as MCP v1 **stdio**, with command `bankCommand`, cwd/rootPath `bankCwd`,
empty env, and args `-m banking_mcp serve --config <bankConfigFile> --transport stdio`.
Mount the dataset and private configuration read-only; keep bank state on a writable
durable volume. FLUJO owns the child process and connects through stdin/stdout. Disable
MCP Apps, skills, sampling, elicitation and proxy exposure. Banking resource and
prompt access are denied. Banking MCP calls require an opaque verified run context
even through the ordinary tool tester, Apps or proxy.

## Approving a graphical flow

Use Start, Process, Static, MCP and Finish nodes. Enable only `banking_status`,
`list_my_transactions` and `get_my_transaction` on the approved Banking MCP.
The server pins the exact snapshot hash computed by `hashFlowExecutionSnapshot`.
Graph edits require an explicit new hash in private configuration. Configuration
changes also stop existing runs, so update between active runs.

Banking flows exclude shell/files, shared KV/global/resource references, run-variable
interpolation, subflows, detached tasks and tool approval/resume. User text is literal
input; embedded FLUJO reference commands do not expand into shared data. Authored
handoffs remain available. Process prompts come from the approved flow; mutable model
prompt templates are excluded. API provider adapters are supported. Codex/Claude CLI
adapters are denied by default because their native capabilities exceed the
banking tool boundary. Codex may be admitted only with an explicitly attested binary
and pinned model catalog that pass forced native-call rejection and approved MCP
tests and the restricted catalog gates described in the generic contract.
Claude remains denied. Other FLUJO flows retain
their existing behavior. See [the generic adapter contract](features/execution-extensions.md).

Each MCP call uses a fresh bank JWT in `_meta["com.flujo.bank/assertion"]`, bound to
the verified subject, namespaced session, conversation, logical run, graph, tool and
RFC 8785 digest of final arguments. Shared client headers never contain a current
customer. Expiry, cancellation, revocation and ownership are checked again after
long calls and before persistence. Logout revokes locally first, then propagates
a separately typed signed assertion over stdin to the fixed local Python
`revoke-session` command. This control command is not an advertised MCP tool.
Authority never appears in command arguments or environment variables.
A propagation failure returns 503; local authorization remains revoked and the
frontend can retry with a fresh ingress assertion.

## Deployment limits and tests

This version supports **one FLUJO process with durable local state**. Admission,
active cancellation and SSE registries are process-local. Multiple replicas need
conversation routing plus shared fenced state before this profile can be enabled.
Each banking turn uses one workspace writer admission; nested writes reuse it while
individual banking commits retain their authority checks. Snapshot capture waits for
active turns to finish. Owner/tombstone/session records survive restart and require private retention
management. Expired ingress replay records are swept periodically.

The request principal and accepted execution lease are separate server authorities.
Only a still-fresh request can receive a lease after all asynchronous admission
checks. Queue expiry, request disconnect and owner/session controls remove pending
work; an aborted or expired wake cannot dispatch later or release another job's slot.
Out-of-band policy-file changes are checked at dequeue before any owner creation,
provider/tool execution or persistence; immediate file-change notifications are not
part of this profile. Bank assertions remain single-use and at most 60 seconds,
clamped to the remaining active/job/session deadlines.

Automated tests cover forgery, replay, session rebinding, foreign/unknown/deleted
IDs, graph/routing/history injection, key removal, cancellation, SSE revocation,
durable writes, protocol minimization, Static/model dispatch and 500 concurrent
authenticated ingress requests with distinct subjects and bounded active work.
The deterministic ordinary completion load test runs the real `runFlow` and Process
path for 1, 10, 50 and 500 owners, with mocked provider responses and verified signed
per-call principals, durable histories and buffered events. It is not a measurement
of 500 paid provider calls or real S3 traffic.
Read-only inquiries are implemented; disputes, consent and financial writes need
their own authorization and idempotency implementation.


## Verified local stdio deployment

Banking MCP and its synthetic fixture run as Python stdio children of `next-server`
inside the existing Docker worker. Extra MCP containers were removed; there is no
banking HTTP endpoint or exposed banking port. Saved workspace and OAuth credentials
were preserved, and Slack reconnects after restart.

A burst of **500 requests from 500 separately signed subjects**, mapped privately to
500 real dataset customers, completed through one pinned Static flow: 500 successful
responses, and every saved tool result matched its expected customer. Admission was
32 active runs plus a bounded queue; one transaction was returned per call. Including
queue time, p50 was 26.399 s and p95 was 48.401 s. No provider calls or selected-source
S3 readback were performed. The initial per-write admission path timed out under this
burst; grouping one complete banking turn under the existing reentrant workspace gate
resolved it without changing authorization lifetimes.

Live checks also passed foreign read/delete/cancel/continue rejection, ingress replay
rejection, ordinary tester denial, and signed revocation surviving worker restart.
The actual frontend authentication and conversational API-provider flow still need
acceptance tests. This result is a local backend measurement, not a production SLA.
