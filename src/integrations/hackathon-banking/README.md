# Optional hackathon banking adapter

This adapter is selected by the trusted build setting `FLUJO_EXECUTION_ADAPTER_MODULE`, pointing to this directory's `configuredAdapter.ts`. The default FLUJO build has no adapter. `FLUJO_BANKING_CONFIG` points to the private, absolute policy file; neither configuration belongs in a graphical flow or request metadata.

Authenticated callers use ordinary `POST /v1/chat/completions`. The adapter requires the execution bearer and a fresh frontend assertion, verifies the immutable conversation owner before state reads, admits the turn through the bounded pool, pins the approved graph, and supplies opaque runtime authority to the existing completion path. Its synchronous profile accepts one user message, the approved `flow-<name>` model, optional owned `metadata.conversationId`, and ordinary `flujo`/`appendMessages` flags. Debugging, approvals, detached execution, shared references and arbitrary controls remain unavailable.

The MCP assertion remains the existing single-use `bank-mcp+jwt` profile. It is minted after presets and final business argument validation, carried only in private MCP metadata, and checked again before results and durable commits. Optional `customer_id` is a selector: the Python MCP derives an omitted customer from the verified principal and rejects a conflicting selector. A supplied `conversation_id` must equal the signed conversation.

Approved synthetic operator tests use ordinary FLUJO chat and Slack without this authenticated admission contract. They explicitly select an approved customer in the MCP's operator-test mode and supply conversation correlation, optionally through a nonsecret `@current.conversation.id` preset. Missing authentication never falls back to operator mode.

Normal conversation GET, DELETE, events and cancellation receive authenticated owner checks and sanitized responses, including for previously owned banking transcripts. Execution and conversation controls use the ordinary `/v1/chat` routes. The specialized `/v1/banking/chat` and `/v1/banking/conversations` routes are retired and return 404; `POST /v1/banking/session/revoke` remains available. Existing ownership records and transcript data are preserved.

Native CLI execution remains denied unless an explicitly verified restricted profile is configured and the exact CLI attestation passes.

## Event dates, existing cases and saved handoffs

The three model read tools and five host action tools are unchanged. Transaction
lists disclose `date_window` with `basis: "transaction_date"`,
`calendar: "source_timestamp_calendar_date"`, the serving snapshot's last
ownership-valid event date as `anchor`, and `max_calendar_days: 90`.
`snapshot_event_dates` contains `first`, `last`, `basis` and `calendar`. The
inclusive search window uses those source calendar dates; process partitions,
snapshot build time and wall time do not select it. Intake age, authentication,
consent and pending-action deadlines retain their real wall clocks.

`get_my_transaction` and prepare results contain an `existing_case` projection:
`state` is `verified`, `not_found` or `action_unverified`, with a receipt only
for `verified`, `coverage: "sandbox_only"` and `source: "sandbox_cases"`.
A receipt includes `status: "received"` for the simulated local intake. Its
snapshot is the original case snapshot and may differ from the current selected
transaction snapshot when the exact public transaction facts still match.
Legacy, missing or corrupt receipt evidence cannot establish a verified case.

A prepare decision of `existing_case` reads `read_intake_receipt` again by the
same pending handle and requires exact receipt equality. Success returns the
terminal frontend state `existing_case_verified` and `receipt`. It never enters
`pending_confirmation` or invokes confirmation or new handoff creation. Failed
or conflicting readback returns `action_unverified` without a receipt claim.
The frontend must preserve and render `existing_case_verified` as an existing
case, using the verified receipt rather than offering another confirmation.

The host HTTP handoff operation accepts optional `unanswered_questions` (at most
eight strings of 1–240 characters). Omission normalizes to `[]`; values are trimmed
before the exact signed host call and receipt comparison. The frontend freezes
that normalized list with the request ID before any retry. The saved `packet` has schema
`banking-sandbox-handoff/v1`, selected `transaction` facts or null, `reason`,
`unanswered_questions`, `human_responded: false`, and `transaction_provenance`.
Provenance is null for general help; otherwise it contains
`source: "owned_serving_snapshot"`, `snapshot` and real wall UTC `as_of`.
The packet reason and facts must agree with the handoff's top-level fields.
Creation and readback must return the same saved packet and receipt identity.
The separately observed `transaction_currentness` may be `same_snapshot`,
`different_snapshot`, `unknown` or `not_applicable`; it does not rewrite saved
facts or imply that a human responded. Legacy packets and mismatched readback
remain unverified.

Fresh ingress assertions remain valid for at most 120 seconds and are single-use.
An approved, capacity-accepted completion receives a separate server-owned execution
lease: queue wait is at most `maxQueueWaitSeconds` (default/cap 300), active work uses
the lower of `maxRunSeconds` and 110 seconds, and total authority is at most 410
seconds from acceptance or the earlier verified session expiry. Active time includes
owner/setup and conversation-lock waiting. Fresh GET/control/SSE and continuation
requests still use their original request assertion validity; an execution lease
cannot authorize them.

Queued and active jobs register separately so overlapping turns cannot replace each
other's cancellation registration. Cancellation, deletion and session revocation
cover every matching job. Policy/revocation/owner checks remain fresh at dequeue and
existing execution boundaries, and per-call bank assertions remain at most 60
seconds within the active/job/session deadlines. Job authority is private process
memory, never persisted or passed to models; restart requires fresh admission.
Use a 450-second client timeout for default-budget load acceptance without changing
server deadlines, model choice, native capabilities or admission capacity.
