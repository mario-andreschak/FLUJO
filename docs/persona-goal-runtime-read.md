# Read a Goal's native execution evidence

`GET /v1/personas/{personaId}/work-items/{workItemId}/runtime` exposes the same
bounded `readPersonaGoalRuntime` result used by the native
`work_item_runtime_read` tool. It does not start, resume, stop or modify work,
invoke a provider, or impersonate a Persona Activity. The existing owner,
workspace, local-origin and encryption-lock gates remain in force. An external
consumer must use an authorized local host; this adds no public access grant.

The response is `{schema: "flujo-goal-runtime/v1", workspaceId, personaId,
runtime}` with `Cache-Control: private, no-store`. Select an existing workspace
using the ordinary workspace header/query contract. IDs must identify a root
Goal belonging to that Persona; invalid, missing, foreign and child/task IDs
return the same 404. Read failures return 503 rather than inventing a state.
This includes foreign records in both legacy flat storage and Persona shards.
Only the root lookup's identity refusal becomes 404; a failed native lineage
read remains unavailable with 503.

`runtime` is the engine's explicit projection of the root Goal and current or
saved round, dispatch, mailbox, Activity and lease. Its existing drift/lineage
checks determine `verified`, `state` and `reason`; this route does not reproduce
the join or promote metadata to execution. Dispatch inputs, mailbox payloads,
Activity context and lease capabilities are excluded by the native engine.

Consumers must validate the echoed workspace, Persona and Goal against their
own trusted assignment and hold on `unverified`/unavailable data. `registered`
is not running work. `accepted_running` is evidence for that observed round,
not a participant count or a promise of continued activity. `terminal_observed`
describes a native round's terminal records; it does not by itself establish a
business outcome, completed Goal or stop of every child. A control response is
not a replacement for a later independent runtime read.

Regression source covers route admission/404/error/cache behavior and delegates
lineage/privacy/drift semantics to the existing `goalRuntimeRead` engine suite.
Run applicable suites and operational transport acceptance at release preflight;
development validation is local lint/typecheck plus the application build.

Scoped maintenance qualification is recorded in
the bound evidence. The
focused regression uses the actual storage reader for foreign legacy/sharded
records and malformed JSON. To repeat the built HTTP check when authorized,
stage the candidate source, build it, then run
`node scripts/persona-goal-runtime-read-acceptance.mjs <absolute-private-report-path>`
through flujo-bash. It uses a new private owner/profile, controlled persisted
WorkItems and loopback HTTP. It does not manufacture a running native round or
business completion. Observe every app epoch's exit and pipe drainage before
removing the disposable profile and authority through flujo-bash.
