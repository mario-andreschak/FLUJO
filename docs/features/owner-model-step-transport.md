# Owner model-step transport (v2)

An owner-bound `Model` stores an `ownerCredentialBinding` (`ownerId` and
`credentialId`) and an empty `ApiKey`. The binding names a credential held by the
execution owner; it is neither a credential nor permission to send a request.
FLUJO supports this contract only through the OpenAI-compatible
Chat Completions route. A bound model needs a branded execution context from the
trusted adapter, and `issueModelStep` must mint a fresh private child for **each
logical model call**. A child is consumed before owner I/O and cannot be reused
after a denial, failure, or uncertain outcome. Tool loops and later Process
turns need new children and new owner budget decisions.

The owner issuer receives a closed `{ nodeId, ordinal }` slot with each child.
`nodeId` comes from the active Process node; `ordinal` starts at zero per node
and logical run, then advances for each owner-bound model call across later
visits to that node. An error-driven tool-free fallback takes the next slot;
denied and uncertain attempts never roll back. The run-bound cursor is saved
with conversation state for approval/debug resume, and a missing or malformed
same-run cursor fails closed. Ordinary models do not consume it. This slot is
only a call-site hint: the owner must match it to its independently frozen
graph and original call plan, then durably refuse a reused slot under its own
original run identity before minting a child. A crash or concurrent worker can
replay a cursor from an older state snapshot; FLUJO's metadata-only logical
run id and saved cursor are not the owner's physical authority or dedupe ledger.

At the OpenAI SDK's final `fetch` seam, FLUJO checks the resolved recipient,
method, JSON body, and headers, then passes their snapshot and digests to
`dispatchModelRequest`. The SDK's construction-only bearer placeholder is
removed: the owner receives the SDK-final request **without Authorization**.
The bound credential never enters the FLUJO model record or its provider fetch.
For this path, the owner callback must supply the credential and perform the
physical send; FLUJO does not open the provider socket. The callback returns a
`Response` to the SDK for ordinary response parsing, including streaming.

Before sending, the owner must authenticate the original task and graph, the
fresh child and original lease, current OFF state, bound model and exact
recipient, effective headers and body, selected account and credential, and
the budget for this **specific step**. It must durably claim that step with a
cross-worker compare-and-swap before any physical send. A claim or SDK intent
marker alone is not a provider receipt. A lost response or ambiguous send stays
unknown until reconciled; it must not become an automatic retry or a free new
step. For a stream, the owner must account for the full response lifecycle,
including completion, abort, disconnect, and provider-side failure, rather
than treating the initial HTTP response as completed inference. The owner also
needs to serialize physical sends with revocation and budget decisions if it
claims an immediate OFF guarantee.

Bound models fail closed at saved-model consumers without a model-step context,
including direct completions, connection probes, embeddings, authoring,
sampling, scheduling, and transcription. Fallback policies are rejected for
bound models and protected Flow calls. Protected Subflow and Behavior child
runs are currently rejected because they do not receive owner-issued child
authority; a contextless child may not silently use ordinary transport. These
guards are admission checks, not a substitute for the owner's broker and
original-task accounting.

Direct Azure, OpenRouter Agent, Antigravity and Gemini assessment entries also
reject bound records before their concrete client or sender can run. This
applies even when a caller misdeclares the model's saved adapter as OpenAI;
only the OpenAI Chat Completions boundary implements this transport contract.

Protected MCP clients carry a process-private HMAC equality token for their
resolved configuration. The token detects recipient or credential rotation
without publishing an unkeyed digest of secrets; it is not password storage or
authorization. A protected connection failure cannot fall through to ordinary
OAuth capability discovery or authentication-configuration mutation. Recipient
classification comes from the trusted adapter, independently of caller headers.

Process preparation now acquires a cross-worker shared catalog reader before
looking up its model and holds that reader through prompt, resource, and MCP
preparation. A missing model fails before those effects. The admitted model is
detached from the saved catalog and is used for prompt composition, model
metadata, compaction, and provider dispatch. Catalog add, update, delete, and
legacy restore writers close reader admission and refuse an edit while active
readers remain; the generic storage route cannot replace or clear the models
file. A saved catalog generation check under a fresh reader refuses a late
edit before local credential resolution or any provider attempt. Independent readers can
run concurrently. These are cooperating application paths; arbitrary direct
filesystem edits or unregistered older workers are outside the protocol.

A model call retains its shared reader across compaction, provider response,
native adapter tool loops, and tool approval. This keeps a live edit from
interleaving with a physical attempt. An edit attempted during one of these
calls fails without changing the catalog; the model API returns HTTP 409 with
`MODEL_CATALOG_BUSY`, so a client may retry after the call finishes. A tool
that edits the catalog during its own native model call receives this conflict
instead of waiting for that call to finish. Acquiring the admission gate and
retiring stale reader locks can still take time; the conflict has no fixed
response-time guarantee. A legacy backup restore that skips
models for this reason returns HTTP 409 with `partial: true`, since other
selected items may already have been restored. The edit does not cancel the
active call or commit during it. Do not describe this as a liveness-safe final
transport fence; the owner transport and budget broker remain separate adoption
gates.

The generic `configuredExecutionAdapter` is **undefined** for ordinary Source.
An explicitly enrolled Persona root uses the built-in Original owner described
below; ordinary conversations do not install it. FACTORY, TEE and remote Native
Worker adoption remain separate, unqualified integrations. The earlier v1 single-attempt contract in
[`authenticated-model-attempts.md`](../performance/authenticated-model-attempts.md)
is separate: it limits retries and calls an owner claim hook, but FLUJO still
holds the local API key and sends the request itself. It must not be reported as
owner-sent transport or as evidence for another owner's v2 adoption.

## Original Persona owner

The genuine Persona dispatcher captures its own immutable root identity before
Flow execution. Saved task, active goal and pending dispatch, Activity, frozen
revision, workspace, current lease, Persona ON state, model, account, enrollment
and administrative approval must all agree. JSON, a local API credential alone,
and a genuine authority for a different root cannot mint this runtime capability.
The exact root shares its held Persona fence with durable Flow writes; other
adapters retain their independent fences. Protected conversation access is
scoped to the validated root while loading and running it.

Before granting that runtime capability, the dispatcher durably records the
genuine run's owner, enrollment, Persona, Activity, frozen revision, conversation,
logical run and model plan in the private book. A normal owner GET may read its
completed conversation and model-turn archive only when current owner
authorization and these exact persisted joins still agree. Account or enrollment
revocation stops execution without hiding legitimate history. This read scope
does not grant runtime, model, tool, mutation or Worker authority; saved metadata
without the private dispatcher record grants no access.

`/api/original-owner` requires an actual current owner bearer with
`control:admin` and `secrets:read`. Its `account` operation transfers the selected
configured model credential into a private encrypted account and leaves the
public model credential empty. The catalog writer precedes the owner journal
lock. A durable pending account survives an interrupted transfer; retrying the
same account settings completes it without replacing or losing its credential.
Revoked accounts remain revoked.

The `enroll` operation names an existing Persona task and account and requires
explicit `budget.maxModelSteps` and `budget.maxOutputTokens`. Each accepts a
positive integer or `null` for an unlimited grant. There are no inferred caps.
Finite output budgets reserve the request's output limit cumulatively before
sending; missing provider usage retains that reservation. No unavailable billing
or usage counter becomes zero. `revoke` stops future admissions, and an active
sender observes durable revocation and the original cancellation signal.

The private book lives below the snapshot-excluded
`db/native-session-origins/owner-runtime-v1/`. It never opens earlier Original or
Worker journals. Atomic, fsynced claims bind the original run, Process node and
ordinal to the exact model, URL, headers, routing projection and body hashes.
Only the owner inserts its decrypted credential and sends, without redirects or
automatic retries. Approved account routing is supplied through the opaque child;
ambient SDK organization/project headers cannot select another account.

The sender tracks the complete response. Valid terminal choices and `[DONE]`
complete a stream even when the SDK cancels its reader before socket EOF.
Provider error payloads remain redacted, including error events inside HTTP 200
responses. Ambiguous sends, early stream loss and unobserved `sending` records
remain `unknown` and refuse further work; a restart, later slot or task
reenrollment cannot erase that hold. Definitive pre-send denial spends no
physical output reservation. An unresolved provider outcome cannot be declared
successful without independent receipt evidence.

This integration qualifies model-only Original roots. Native profiles, remote
Workers, protected Worker tools, handoffs and descendant authority retain their
separate Parent integration in PR #905. An enrollment or bearer returned here
does not grant those effects. Source qualification also does not substitute for
installed, Linux, container, fleet or release acceptance.

## October 14, 2026 Original qualification

PR #739 integrates the existing #748 and #753 implementations with main
`1a7f8e4158b02c8c2bc510129ad931f40106ec75`. The following checks cover the
frozen application/test tree `613c69ceac2ff70cf2728db2913a4856bef9bedf`,
Next build `esYAmrPk6CB5WhcS2nYQW`. The final qualification text is the only
subsequent change to that tree; application, tests, dependencies and build
configuration are unchanged.

| Check | Observed result |
| --- | --- |
| Focused model, catalog, sender and restore regressions | 276 cases passed before the history correction; unchanged evidence reused |
| Affected authority, history, owner authentication, workspace and archive regressions | 183 cases passed after the correction; overlapping counts are not summed |
| Canonical typecheck / source lint / changed-test lint | Passed in 60.572 / 99.420 / 4.695 seconds |
| Inspected non-container MCP and Next production build | Passed in 345.679 seconds |
| Genuine built HTTP controlled provider | Four received physical requests: one completed stream and held sends interrupted by Stop, enrollment revocation and process restart |
| Replay, recovery and catalog behavior | Completed run and immutable archive survived restart without another send; interrupted physical sends remained `unknown`; an active-call model edit returned 409 and preserved the saved model |
| Genuine external completion | Exact OpenRouter `openrouter/free`, streamed HTTP 200, one durable completed step, 950 input and 234 output tokens; requested nonce and successful goal saved |
| External durability | Original process restart preserved the exact Chat reply, model-turn archive, run claim and step without another inference |

The actual model-turn archive GET initially reproduced a 500 after a successful
Original response. The private run provenance and current-owner read scope above
fix that failure; the resulting archive was read through the normal HTTP route
before and after restart. A 64-token Free acceptance response was truncated and
did not qualify semantic goal completion. A distinct task with 256 requested
output tokens completed the full criterion; the two Free attempts are not
reported as one provider call. The final external task and restart took 22.032
seconds, measured separately from the reused controlled scenarios and build.

The passing external task used only the explicitly selected OpenRouter Free account,
with exact provider, endpoint and model guards and no inference fallback. Its
existing encrypted configuration was read without mutation; credentials stayed
in memory or encrypted private test storage. Known provider credential bytes
were absent from the fresh profile's 62 database files, application logs and
redacted receipt. All owned application epochs exited and closed before cleanup.
Old held journals and peer services were untouched. Full suites, online CI,
installed/container and release checks remain release pre-flight.

## Historical October 12, 2026 source qualification

PR #739 incorporates main `ee0a9673675b59fba44a62555e1886369725eec7`, including
the delivered Codex lifecycle, MCP conformance, Antigravity 1.3.3, phone World,
and compaction/recovery changes. The MCP joins retain protected pending-client
identity alongside beta resource invalidation, owner-bound sampling refusal
alongside output-token caps, and ordinary cursor/protected-context tool listing
without losing the requested page on reconnect. The admission test continues
to reject a bound Codex call before its current catalog snapshot helper or SDK
setup. These are composition repairs to the existing transport contract.

At that revision, downstream #748 catalog/admission and #753 slot work remained separately
owned; that integration did not introduce their implementations. Its
source checks and a non-container application build qualify the merged source
before publication. The configured production owner adapter, physical sender
and durable journal were absent. No provider credential work or release/remote CI
was performed by that source repair. The current Original integration consumes
both downstream implementations and current main together.

Qualification covered application/test tree `0339e23f5f9ad61650688d4bb7516e1ea7f41f5e`: local typecheck,
whole-source and changed-file lint, and 24 distinct focused suites passed;
the nine suites affected by the current main integration passed 280 cases.
The inspected non-container application build passed in 431.445 seconds,
measured separately from its lease wait. Seven built HTTP checks passed,
including saved-model connection/catalog refusal and normal/streaming
completion refusal of serialized authority, with zero physical provider
requests. The public completion probes use the model alias exposed by
`/v1/models`. That historical evidence qualifies source admission only.
