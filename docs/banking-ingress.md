# Banking ingress

FLUJO can run one shared banking flow for many customers. A frontend backend verifies
the browser session and signs a short-lived user assertion. FLUJO verifies that
assertion, owns the conversation, and signs each finalized banking tool call.
Customer identity never comes from tool arguments, conversation metadata or URL parameters.

## Frontend contract

Call these routes from your **frontend backend**, over a private authenticated connection.
Keep both the execution credential and signing key out of browser JavaScript.

| Route | Method | Body |
| --- | --- | --- |
| `/v1/banking/chat` | POST | `{ "message": "…", "conversation_id": "optional existing owned UUID" }` |
| `/v1/banking/conversations/{id}` | GET | None |
| `/v1/banking/conversations/{id}/events` | GET | None; bounded SSE snapshots |
| `/v1/banking/conversations/{id}/cancel` | POST | None |
| `/v1/banking/conversations/{id}` | DELETE | None; permanent ownership tombstone |
| `/v1/banking/session/revoke` | POST | None; revoke the authenticated session |

Every request needs `Authorization: Bearer <banking execution credential>` and
`X-Flujo-User-Assertion: <JWT>`. Mint a fresh assertion/JTI for retries and SSE reconnects.
New conversations omit `conversation_id`; unknown supplied IDs are rejected.
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

The chat response contains `conversation_id`, `status` and assistant `message`.
Read/SSE expose only bounded user/assistant messages. Authentication failures never
return raw provider errors, tool traces or signing material.

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
adapters are denied in this profile because their native capabilities exceed the
banking tool boundary. Other FLUJO flows retain their existing behavior.

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
Owner/tombstone/session records survive restart and require private retention
management. Expired ingress replay records are swept periodically.

Automated tests cover forgery, replay, session rebinding, foreign/unknown/deleted
IDs, graph/routing/history injection, key removal, cancellation, SSE revocation,
durable writes, protocol minimization, Static/model dispatch and 500 concurrent
authenticated ingress requests with distinct subjects and bounded active work.
The ingress load test mocks flow execution and verifies real signed per-call
principals. It is not a measurement of 500 paid provider calls or real S3 traffic.
Read-only inquiries are implemented; disputes, consent and financial writes need
their own authorization and idempotency implementation.
