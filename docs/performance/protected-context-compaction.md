# Protected context compaction

This batch implements the generic instruction, receipt and recovery work in
[#1091](https://github.com/mario-andreschak/FLUJO/issues/1091), alongside the
disposable summary-cache portion of
[#569](https://github.com/mario-andreschak/FLUJO/issues/569).

Canonical conversations remain authoritative. Summaries and emergency refits
only change provider projections. Old user corrections remain verbatim in their
original order. System and developer instructions are retained. When protected
instructions, unresolved calls or unrecoverable observations cannot fit, the
request fails with `context_budget_exceeded`; it does not shorten the contract.

Completed tool groups can leave an emergency wire only when runtime-captured
resource metadata is bound to each exact call ID. A URI mentioned in a tool
result is insufficient. The retained receipt includes the call ID, tool name,
observed-result status, exact arguments or their captured resource, and result
resource. An observed result does not assert that a side effect succeeded.
Summary and recovery anchors remain protected during subsequent transforms.

Saved global/model percentage thresholds reach the runtime, with the existing
absolute-model override taking precedence. The trigger estimates the current
provider projection and tool schemas, rather than a previous prompt count.
These remain conservative estimates, not measured provider token counts.
Settings-read failure disables optional summarization and visual compaction.

Summaries must contain the five anchored sections and reduce the restored wire.
Provider length/content-filter/tool termination is rejected. Tool observations
require a successfully persisted exact source. Reuse fingerprints the archived
prefix, model, tools and effective policy; growing an unchanged recent tail does
not regenerate the prefix. Concurrent source edits still invalidate generation.
Disposable metadata keeps the newest artifact per node/model, with at most 64
artifacts and 1,048,576 summary characters, including when restoring older state.
This cache bound does not evict canonical, active, paused or recovery-owned runs.

Small standalone JSON objects/arrays in assistant and tool observations now have
an exact, deterministic evidence block alongside the narrative. It preserves the
original JSON literal and source role/message ID, including arrays, nulls,
escaped paths and integers too large for a JavaScript number. Recorded data
does not grant tool permissions; original user corrections remain separate and
supersede earlier observations. Text parts and pretty-printed/fenced JSON are
eligible; inline prose, malformed JSON and non-text content are not extracted.
Each value is at most 4,096 code units. The newest 32 records fit within 16,384
record code units; omitted or larger data explicitly requires the full source
archive. Callers without an archive writer retain the source when these bounds
are exceeded. Subsequent wire rewrites carry the recorded block without nesting it
or asking the summarizer to regenerate its values. The summary policy is
`summary-v3-exact-observations`, so earlier cached summaries are regenerated.
The complete restored projection must still shrink, and existing persistence,
source-change and context-budget refusal paths remain in effect. This bounded
evidence does not establish universal structured-state or provider fidelity.

Stored-resource `read_resource` calls default to at most 50,000 UTF-16 code units
and accept `start_char` and `max_chars` (maximum 200,000). `range.nextChar` is the
next offset. Reads decode incrementally with a 64 KiB byte buffer. Optional
SHA-256 verification hashes the complete opened file snapshot; a mismatch is
returned as an error by the tool. Native MCP reads retain their separate route.
For example, `{ "uri": "flujo://run/conversation/resource", "start_char": 900000,
"max_chars": 5000, "expected_sha256": "<64 hexadecimal characters>" }` recovers
a bounded tail range instead of reinserting the full resource into context.

The shared native text projection retains developer instructions in a labelled
instruction block, exact call IDs and unarchived arguments/results. Captured
payloads can still use their resource pointers. Codex's transport character
ceiling remains distinct from model token budgets, and counting does not create
an array of every Unicode character. Provider/session owners must still qualify
resume and native compaction behavior on their final integration. Codex and
Claude SDK session prefixes bind the text-projection policy version. A session
created with the older lossy policy restarts with the corrected full projection
before later turns can use delta-only resume.

Visual compaction remains experimental and disabled by default. It preserves
trusted instructions and complete pairing and must beat the estimated shortened
text route. Its existing image carrier uses a user-role message; source-authority
acceptance and measured quality/cost remain open before treating this experiment
as a qualified native compaction route.

Complete projection fingerprints stream the existing canonical JSON bytes into
SHA-256 instead of cloning the whole graph and materializing its JSON string.
String encoding uses 16,384-code-unit slices and a 32,768-code-unit hash-buffer
target; canonical sorting still retains each active object's entries. Numeric
property order, omitted values, Unicode pairs and lone-surrogate escaping retain
their previous hashes. Non-JSON callable `toJSON` values retain the legacy
materialization path. No artifact or projection version changes.

The October 15 Windows/Node 22.23.3 source check hashes the same approximately
48 MiB international-text transcript with unchanged input and SHA-256. Observed
transient heap growth falls from 101,168,288 to 1,330,752 bytes; peak RSS falls
from 242,996 to 54,484 KiB. Single-run digest times are 313.239 and 247.294 ms,
respectively. These are measurements of this controlled case, not estimates of
whole-flow memory or latency. The old source fails the focused allocation
envelope; the corrected source passes. This negative control is an allocation
assertion failure, not an observed OOM. Three repeated child batches, 128 mixed
JSON comparisons and the existing compaction checks preserve saved hashes,
source content and metadata invalidation. The [frozen source evidence](
compaction-digest-2026-10-15.json) records inputs and validation scope.
The emitted production digest factory also passes the same hash and allocation
envelope with its actual emitted Node crypto external.

Token estimation and resource-URI preservation also inspect persisted message
JSON without materializing each complete serialized message. The estimator
retains the exact native JSON UTF-16 length and existing per-message char/4
rounding, including escaped control characters and paired/lone surrogates.
Encoding uses 16,384-code-unit slices. URI discovery visits serialized keys and
string values in native order, preserving the existing URI alphabet, deduplication
and summary wording; omitted properties contribute no resources. A failed
inspection discards partial URI discoveries before applying the previous native
serialization/content fallback. Accessors, custom `toJSON` and non-JSON objects
retain native serialization compatibility, including its allocation cost.
Resource discovery uses prefix/ASCII scanning and copies matched URI bytes so
neither the RegExp input cache nor a small sliced URI holds a complete source
message through a cached summary.
Traversal stores the active object's keys and ancestors; resource bookkeeping
and output scale with the resources actually found. Archive writes and provider
serialization keep their existing complete-payload behavior.

The controlled Windows/Node 22.23.3 preparation check uses one flattened tool
message with about 25.2 million UTF-16 code units (the exact size and fingerprint
are in the [preparation evidence](compaction-preparation-2026-10-15.json)). Under the
same 192 MiB old-space budget, the previous token/URI paths each allocate about
48 MiB of extra heap; the corrected paths each remain below 0.7 MiB across three
rounds. The previous URI path retains about 48 MiB after collection; corrected
retained growth stays below 40 KiB in this source run. Both native token estimates and
resource text/order match, and canonical input remains unchanged. The committed
allocation regression fails on the original source with
`Full-message allocation returned`; this is not an observed OOM. Another 4,096
seeded mixed JSON comparisons retain counts, URI output and source content.
A separate released-source case returns a 120-character resource summary
without retaining its large source message. The emitted negative control before
detached URI copies retains about 48 MiB in all three rounds; its build and
factory fingerprints are recorded in the preparation evidence. The source
regression covers that release boundary as well as transient allocation.
The corrected emitted compaction factory also passes three count/resource and
source-release rounds, with retained heap growth of 31,048–33,224 bytes. This
uses an injected deterministic summary and no archive writer to isolate
preparation; it does not measure summarizer fidelity or persistence. The final
five-MCP/Next 16.4.1 application build passes in 355.639 seconds. Factory/build
fingerprints and exact validation inputs are in the preparation evidence.

Local regression coverage is source/runtime plumbing evidence. It is not
real-model fidelity, native opaque-window/signature roundtrip, original
[#520](https://github.com/mario-andreschak/FLUJO/issues/520) crash confirmation,
cross-platform/default-heap endurance, or an installed-release acceptance claim.
Those issue criteria remain open. Broader/provider/release suites follow release
pre-flight policy; the existing capped-child/HTTP-400 fixes are not reimplemented.

## Focused real-model fidelity — October 15, 2026

The summary prompt now explicitly preserves untranslated identifiers and decoded
JSON string values, with an example distinguishing a Windows path from its JSON
escape spelling. It also asks to retain JSON value types. These are model
instructions; deterministic exact-field validation remains unfinished in #1091.

The [frozen results](compaction-fidelity-2026-10-15.json) compare the actual built
Windows application on main `ae263f4c` with this prompt change. Both runs use the
production OpenRouter Responses route, the explicit
`nvidia/nemotron-3-super-120b-a12b:free` model and identical source after the first
summary's system instruction. The strict relay forwards real provider requests
and replies. It neither substitutes answers nor changes models. The existing
encrypted provider credential stays in memory; the isolated app stores a
disposable relay credential through its normal model API.

| Observation | Baseline, five rounds | Candidate, ten rounds |
| --- | --- | --- |
| Exact operating values, including path, ID, hash, configuration, corrections and unknown answer | 0/5 | 10/10 |
| Permission/prohibition meaning | 5/5 | 10/10 |
| Every field and its original JSON type | 0/5 | 4/10 |
| Canonical history and complete source-archive hashes | Preserved | Preserved |

The six remaining strict candidate failures render a permission array as a
comma-separated string. The original strict failures remain recorded; the
separate permission-meaning metric does not turn them into typed-state passes.
The earlier `openrouter/free` router also renamed an operating ID, and its
continuation repeated the changed value. That failure and the distinct equipment
errors remain in the evidence. This controlled, stochastic comparison supports
the scoped prompt improvement; it does not establish universal model fidelity.

The candidate restarts after round five and continues through the accepted
destination and owner corrections. A further fresh app process returns the
identical canonical transcript and exact 768-byte tails of the round-five and
round-ten archives, with independent complete-file SHA-256 verification and HTTP
416 beyond EOF. Its stdout, stderr, exit and close witnesses settle. These HTTP
byte-range observations retain their own scope alongside the existing UTF-16
`read_resource` regressions.

Local types, whole-source lint, 39 affected cases and the inspected non-container
five-MCP/Next application build pass. The candidate build takes 324.279 seconds;
its live journey takes 493.723 seconds, measured separately. All 40 real provider
requests across baseline, candidate and retained failed attempts report zero
cost. No full suite, remote workflow, container or release check is dispatched.
Native sessions/signatures, visual benefit, real side-effect replay, original
#520 workload confirmation and the remaining exact-state criteria stay open.

The [bounded JSON observation results](compaction-structured-observations-2026-10-15.json)
retain the prompt-only candidate above as the existing main `f52c8f08` baseline.
The complete first summary request, including its instructions and fixed Free
model, is identical. Retaining the original JSON literals alongside the narrative
raises strict field/type retention from 4/10 to 10/10 on this controlled workload;
both new five/ten checkpoints pass. All ten continuations receive the recorded
evidence block. The original six failures remain in the baseline evidence.

The new run preserves canonical history through the round-five restart. A
further fresh process returns the identical transcript, verifies complete source
hashes and exact 768-byte archive tails at rounds five/ten, and returns HTTP 416
beyond EOF. All three application processes close. Fifty focused cases, including
ten deterministic rewrites, cache-policy migration, no-archive refusal and capped
allocation/source-release checks, pass with local types/lint and the inspected
non-container application build. The qualified build takes 299.963 seconds and
the real-model journey 710.166 seconds, measured separately. All 20 new approved
Free requests report $0, with no missing reported-cost values. These results
qualify bounded observation retention on this fixture; universal exact-state,
native/session/signature, visual and genuine side-effect acceptance remain open
in #1091.

## Focused tool-action recovery — October 15, 2026

The [frozen result](compaction-actions-2026-10-15.json) qualifies this controlled
local-write scenario on the unchanged `f02f18d8` application source. Ten reviews
retain both exact generated receipts, with two physical writes, two commit
invocations, two reconciliation reads and zero duplicates. The agent stops after
the uncertain result; reconciliation follows a fresh application process.
Both five/ten checkpoints pass, including a second restart after review five.
Canonical history, tool pairing and complete archived action results remain
intact, and all three application processes close.

All 29 approved Free provider requests (13 summaries and 16 continuations)
report $0, with no missing reported costs. The live journey takes 682.105 seconds;
the inspected non-container application build takes 327.312 seconds, measured
separately. Local types, source lint, harness syntax/lint and the independent
ledger check pass. The existing 50 unchanged runtime regressions are reused.
The [complete provider trace](compaction-actions-provider-trace-2026-10-15.json.gz)
is gzip-compressed UTF-8 JSON; its compressed/uncompressed SHA-256 values and
per-call request/response digests are in the result. It contains the actual
requests and replies, without provider authorization headers.

`scripts/compaction-action-acceptance.mjs` runs the built application in a private
profile through its ordinary owner enrollment, model, MCP-server, flow and chat
APIs. Run it through flujo-bash because the application retires temporary files.
Build the application first. Create a task-owned run directory and set
`COMPACTION_ACCEPTANCE_RUN_DIR` to its absolute path. Supply an OpenRouter key
through `OPENROUTER_API_KEY`, then run
`node scripts/compaction-action-acceptance.mjs`. Never put credentials in source,
command arguments or committed evidence. The automation can instead use an
absolute `COMPACTION_ACCEPTANCE_PROVIDER_MODULE` exporting
`loadConfiguredProvider(accountId, repo)` and an explicit
`COMPACTION_ACCEPTANCE_ACCOUNT_ID`; that loader decrypts one selected existing
OpenRouter Free account only in memory.

The default model is explicitly
`nvidia/nemotron-3-super-120b-a12b:free`. The harness allows only that Free model
or `openrouter/free`, rejects relay requests changing the selected model, and
does not substitute answers or fall back. `COMPACTION_ACCEPTANCE_ROUNDS` may be
5 or 10; the default is 10. Ports 5481/5482 must be available; the application
port can be set with `COMPACTION_ACCEPTANCE_PORT`.

The local MCP ledger appends and fsyncs a real row for every `commit_action`
invocation. The first action returns its generated receipt. The second writes
its row, deliberately suppresses the receipt and returns an uncertain outcome.
The user asks the agent to stop before reconciliation. After a fresh application
process starts, a new user request asks it to reconcile with `lookup_action`.
Every review adds history and requires a fresh real summary; another application
restart follows review five. The write tool stays available. The ledger has no
idempotency or duplicate suppression: an extra invocation creates another row
and fails acceptance. A separate SDK check deliberately repeats a commit and
confirms the extra row is observable.

The harness checks actual calls and durable rows, exact model-returned receipts,
canonical-history integrity, tool pairing, complete source-archive hashes and
unchanged archived action results. It records source/harness fingerprints, build
ID, provider requests/replies, timings and reported costs. The generated private
profile and authority files need owned cleanup through flujo-bash after evidence
is frozen. This controlled local-write scenario does not establish third-party
delivery, crash-midcommit atomicity, arbitrary concurrent/unresolved tool groups,
every provider or transform, native session/signature recovery, visual benefit
or release acceptance. Those broader #1091 criteria remain open.

### Parallel action acceptance and partially resolved groups

Set `COMPACTION_ACCEPTANCE_SCENARIO=parallel` to exercise two model-selected
`commit_action` calls in one assistant tool-call group. The MCP server uses a
concurrency limit of two. The first action waits for the second to finish and
then waits another 75 milliseconds; both calls must overlap, and their result
completion order must differ from the authored call order. A sequential caller
times out and fails this acceptance. Every commit still appends and fsyncs a
new row; the ledger does not suppress duplicates.

The uncertain second acknowledgement, later read reconciliation, ten fresh
summaries, exact receipt checks, complete archived results and two application
restarts use the same checks as the sequential scenario. Receipts come from the
actual ledger after execution and are never supplied in user requests. Default
execution remains the existing sequential scenario.

Two focused local regressions also cover either missing result in a two-call
group. Across ten attempts, summary generation and archive writes remain
disabled; an infeasible emergency refit keeps both calls and the observed
result intact. Supplying the missing result permits summarization again without
changing canonical history. These tests use an injected narrative and establish
local projection behavior; live interruption with unresolved tools, arbitrary
concurrency and crash-midcommit recovery remain open acceptance work.

The [frozen parallel result](compaction-parallel-actions-2026-10-15.json) passes
ten exact-receipt reviews with two commit invocations, two physical writes and
zero duplicate writes. Both five/ten checkpoints pass, all three application
processes close, canonical history and tool pairing remain intact, and every
complete action archive is hash-verified. The two actual commit calls overlap
and finish in reverse authored order.

The live journey takes 536.757 seconds, measured separately from the
333.584-second application build. All 24 approved Free requests (11 summaries
and 13 continuations) report $0 with no missing costs. The
[complete parallel provider trace](compaction-parallel-actions-provider-trace-2026-10-15.json.gz)
contains actual requests/replies; compressed and uncompressed hashes are in the
result. Local typecheck, source/touched lint, 29 focused cases and independent
MCP concurrency/duplicate instrumentation pass. This scoped result extends the
earlier sequential proof; it does not close the remaining #1091 criteria.

### Unresolved write interruption and restart acceptance

A live cancellation first exposed a recovery checkpoint defect: a tool
batch could return a cancellation result after a write committed, then mark
that batch completed and safe. Cancelled write batches now retain unknown
effects and the existing reconciliation warning without advancing the safe
replay boundary. Normal completed writes and read-only cancellation retain
their existing behavior. The new regression fails before repair; all nine
focused recovery cases pass afterward.

Set `COMPACTION_ACCEPTANCE_SCENARIO=cancel` or `crash` for the remaining
generic interruption path. Both start actual parallel, model-selected local
writes. The ledger fsyncs both rows but holds the second acknowledgement
without returning a success, error or receipt. Before interruption, the harness
requires the original calls in the durable event log and an unanswered tool
result in the canonical transcript. No ledger idempotency can hide repeats.

The cancel scenario calls the normal conversation Stop endpoint, requires
terminal `cancelled` recovery and valid tool pairing, and rejects any model
call after Stop. The crash scenario terminates the owned application process
abruptly with SIGKILL/Windows TerminateProcess, requires the outstanding HTTP
request to fail and observes `interrupted` after restart. In both cases the
held acknowledgement is released only after the original app process closes.

A new application process uses the same private data. The user authorizes
read reconciliation of both action IDs; the model must actually call
`lookup_action` for each. Five fresh real summaries per scenario must preserve
the original calls and recovered results, exact model-returned receipt IDs,
canonical history and complete hash-verified source archives. The private
ledger is checked independently for exactly two commit invocations and rows
per scenario. A further app restart follows checkpoint five.

The [frozen recovery result](compaction-interruption-recovery-2026-10-15.json)
passes 10/10 exact receipt reviews across both scenarios, with four
physical writes, four commit invocations and zero duplicates. All 6 application
processes close. The actual built OpenRouter Responses route makes
42 requests (20 summaries), all to the pinned approved Free model,
reporting USD 0 with no missing costs. The live journeys take
866.559 seconds, measured separately from the
329.088-second non-container build.

The [complete recovery trace](compaction-interruption-provider-trace-2026-10-15.json.gz)
includes actual provider requests/replies, durable pre-interruption events,
canonical snapshots and recovery receipts. Both compressed and uncompressed
hashes are recorded. Two real-SDK regressions verify held fsynced writes
survive request cancellation/server closure; a deliberate repeated commit
must create a duplicate physical row. Local types, source/touched lint and
the application build pass. The unchanged 29 summary cases are reused.

The trace also retains the first stopped acceptance attempt (7 requests),
which exposed the checkpoint defect and an undersized synthetic history
prefix. FLUJO correctly refused a non-reducing summary in that attempt. The
prefix was lengthened while keeping the summary-consumption assertion. Its
separate measured runtime and costs remain in the result; all 49
requests including that attempt report USD 0.

This establishes the controlled post-fsync interruption/reconciliation path.
It does not establish crash-midcommit atomicity, external delivery, concurrent
edits or persistence-failure acceptance, every-transform guarantees, native
sessions/signatures, visual benefit or release acceptance. #1091 stays open.

Git normalizes the two touched TypeScript files from CRLF to LF. Both accepted
and published fingerprints are recorded; normalized source and emitted
JavaScript match exactly. The application source tree matches the qualified
build and accepted runtime; the harness and complete trace are byte-identical.

### Concurrent edits and persistence-failure recovery

The [frozen persistence result](compaction-persistence-recovery-2026-10-15.json)
extends the existing #1091 acceptance through the built application's normal
conversation and debugger routes. An edit attempted while a real summary is
in flight returns 409 without changing history. Attaching the debugger reaches
a safe pause, where the same edit succeeds. After restarting the application,
five fresh summaries must use the corrected observation and reject the old
artifact. All five complete source archives are independently hash-verified;
eleven canonical snapshots retain the original messages and the permitted edit.

Two genuine filesystem failures occur after the provider returns a summary:
a regular file prevents creating the source archive directory, and an empty
directory prevents atomic rename onto the conversation metadata file. The
previous files are held inside the disposable profile and restored before the
continuation finishes. The actual outgoing requests must contain full canonical
history, the exact corrected observation and the original prohibition, with no
summary marker. Failed generations cannot replace the last durable artifact.
Normal retries then generate and persist fresh summaries successfully.

All seven receipt replies, including both fallback replies, pass exact-field
checks. The three accepted application processes and the earlier failed setup
process close. The metadata rename's actual EPERM appears in the application
log. Production defaults suppress warning logs; the archive refusal is verified
through its awaited filesystem barrier, discarded summary, canonical provider
request and preserved durable cache. No production repair was needed.

Run `scripts/compaction-recovery-acceptance.mjs` through flujo-bash with an
already qualified application build, a private `COMPACTION_ACCEPTANCE_RUN_DIR`,
unused adjacent local ports, and the existing approved OpenRouter credential
mechanism. It accepts the same explicit Free model allowlist as the action
harness, with no fallback. Set `COMPACTION_ACCEPTANCE_ROUNDS=5` for this result;
the owner removes the disposable profile and credentials through flujo-bash.

The accepted journey takes 251.206 seconds, separately from the 331.392-second
application build. Its 16 requests (eight summaries and eight continuations)
report USD 0 with no missing costs. The
[complete provider trace](compaction-persistence-provider-trace-2026-10-15.json.gz)
also retains the first setup attempt: its observation stayed in the recent tail,
so compaction did not run and the pause assertion failed. Adding a bulky recent
observation moves the original observation into the summarizable prefix while
preserving every assertion. All 17 requests, including that attempt, report USD 0.

Local typecheck, source/touched lint, the non-container application build and
16 focused cases pass. Three new cases cover mutation during generation,
archive failure and metadata failure, including recovery and safe cache reuse.
The unchanged 29 summary cases retain their earlier evidence. The result does
not qualify arbitrary out-of-band mutation, crash-midcommit atomicity, all
projection/configuration changes, native sessions/signatures, visual benefit or
release acceptance. #1091 remains open for those existing criteria.

### Plaintext identifiers and their source relationships

A retained compatibility failure kept the exact receipt identifier but detached
it from its defining observation. The continuation then returned surrounding
description as the receipt. That summary also incorrectly described preparing
the summary as the underlying task. The compaction prompt now keeps labels,
subjects and defining relationships together, distinguishes current values from
superseded observations, and describes the source task rather than its own
compaction controls. `summary-v4-source-relations` invalidates artifacts from
the previous prompt; canonical history remains authoritative.

Compaction requests are system controls instead of synthetic source user turns.
Previous generated anchors are passed separately as assistant data and never
inserted into a trusted control. The prompt identifies the current value for a
subject explicitly instead of grouping it with superseded values.

The existing compatibility harness accepts
`COMPACTION_ACCEPTANCE_MODE=reference-fidelity` for ten fresh summaries using
the original receipt question without an identifier-prefix hint. Each later
round changes the observed receipt. It verifies exact replies, preserved user
instructions, complete source-archive hashes and canonical history, with
application restarts after rounds five and ten. The optional
`COMPACTION_ACCEPTANCE_REFERENCE_BASELINE` selects the retained failed JSON
trace and requires the first summary's source and original review to match it
exactly. The source after the first round uses smaller recent context to keep
this focused check bounded. Run through flujo-bash with the same qualified-build,
private-profile and approved-provider setup as the compatibility harness.

These prompt instructions do not provide deterministic general semantic or
exact-field validation. Native sessions/signatures, every-transform guarantees,
experimental visual benefit and release acceptance retain their existing scope
in #1091.

The [frozen reference result](compaction-reference-fidelity-2026-10-15.json)
retains the original wrong-description reply and the wording-only candidate's
round-four stale receipt and task-state contamination. After separating controls
from source turns and naming current values explicitly, ten review rounds on the explicit
Ultra Free route pass
the original question without a prefix hint. All ten receipt replies and 9 source
archive hashes pass, as do twelve canonical snapshots and restarts after rounds
five and ten. The source and review in the first round match the original failure;
the accepted provider selection also changes from Super Free to Ultra Free. The final
source still fails Super Free at round five, so this is not a same-model causal
comparison or cross-model qualification. Task-state excerpts
and actual control roles are recorded for each accepted round.

Local typecheck, source/touched/final-harness lint and 68 focused cases pass.
Twelve separate journey-guard regressions retain real task-contamination failures and
allow the captured correct negative statement; that stopped run is retained.
Three new runtime cases cover previous-policy invalidation and source/control authority
with and without an older generated summary. Both stale-cache reuse and the
synthetic user-turn regression fail before their respective repairs. The final
non-container application build takes 341.881 seconds and its live journey
368.215 seconds, measured separately. All 58 new approved pinned Free
requests, including both failed Super candidates, report USD 0. Every
application process closes. The accepted run has 9 persisted summaries and
1 complete-canonical fallbacks; the earlier captured fenced-summary
fallback independently preserves all 20 source messages and the previous durable cache. Separate failed-candidate timings and complete
requests/replies, source payloads and canonical snapshots are retained in the
[compressed trace](compaction-reference-provider-trace-2026-10-15.json.gz).
No full suite, remote CI, container or release check was dispatched. This remains
a stochastic controlled result; #1091's broader criteria remain open.
