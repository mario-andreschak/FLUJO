# Original Goal execution source read

Calma's continuous original-case report reader previously needed two complete
Persona bundles. Unrelated history could exceed its 4MiB cap and hold a valid
case report. This source candidate adds a narrow owner API without changing
native orchestration or activating any work.

`GET /v1/personas/{personaId}/work-items/{workItemId}/source` requires the normal
owner/workspace transport wrapper, strict loopback and unlocked encryption.
Only an existing owned root Goal is eligible. It reuses
`readPersonaGoalRuntime` for the original round/dispatch/mailbox/Activity/lease
join, then reads that one Persona-scoped Activity and its original immutable
Core revision with the existing store getters. It compares two selected source
reads and a final independent runtime read. No authored current Flow or preview
can replace the execution's frozen revision.

The `flujo-goal-source/v1` envelope contains `workspaceId`, `personaId`,
`goalId`, `goalVersion`, `round`, `activity` and `behaviorRevision`. The Activity
projection includes frozen Core/App/instruction-context provenance, execution
identity/status/update time and structured outcome. It excludes customer
context, message history, reported-but-uncommitted outcomes, lease capabilities
and source idempotency keys. The full immutable revision is necessary for a
consumer's existing reviewed digest. Frozen instructions/configuration stay
inside this private owner boundary and must not be forwarded to a browser or
model. Responses use `Cache-Control: private, no-store`.

Missing/foreign/child/invalid root is 404. Missing, foreign or changed execution
lineage/revision is 409; unexpected storage failures return bounded 503 text.
Legacy executions without a Core revision are held. A compacted Activity may
retain revision identity while losing its context; the consumer must still
hold source qualification when its frozen evidence is incomplete.
The serialized UTF-8 envelope is capped at 1MiB; oversized frozen source yields
413. The endpoint never loads Persona history. Consumers must still bound
streams and deadlines and independently verify exact source/outcome identity.
Calma selects legacy full bundles only on the initial absent endpoint (404),
never after a malformed/source-drift/permission/capacity failure.

This is source evidence, not effective model/account/billing/tool attestation,
activation qualification, safe dependency wakeup, remote-stop proof, 100-agent
qualification, bank authority or business resolution. No model/provider/customer
call occurs. The separate Calma #24/#84 consumer retains its original
registration/version checks, independent source/report readbacks and human
review boundaries. Adoption requires independent review and reviewed release.

Development checks are lint/typecheck and the inspected non-container app build.
Retained unrun release regressions cover strict transport/lock/root ownership,
single-record lineage, missing/drifting sources/outcomes, projection privacy,
no-store envelopes and UTF-8 capacity. Broad/online acceptance stays reserved
for actual release; mocked records do not establish operational execution.
