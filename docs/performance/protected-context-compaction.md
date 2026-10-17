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

Assistant and tool observations have a deterministic source-evidence block
alongside the narrative. It preserves standalone JSON literals and complete
plaintext lines containing numbers, paths/URIs or quoted literals, with the
original source role/message ID. Plaintext updates appear in their source order
after earlier JSON replies, preserving the defining sentence instead of a list
of detached values. Repeated identical records move to their latest occurrence.
JSON keeps its lexical numbers, arrays, nulls and escaped paths. Original user
corrections remain separate; recorded observations do not authorize execution.

Each selected value/line is at most 4,096 code units; escaped records are bounded
to 8,192. The newest 32 records fit within 16,384 record code units. Oversized,
malformed or omitted candidates require the complete source archive. Nested
fragments of oversized JSON are not promoted to independent observations.
Without an archive writer or a valid existing archived artifact, the original
wire is retained when that archive is required. Subsequent rewrites carry the
recorded block without asking the summarizer to regenerate its values.

Reuse reconstructs this block from the actual projected source and compares
its complete text, values, provenance and ordering, in addition to the existing
digest/configuration checks. Missing or changed evidence regenerates the
summary. Generated narrative cannot supply its own recorded-source block.
`summary-v5-source-observations` rejects older cached policies. The complete
restored projection must still shrink, with the existing persistence,
source-change and context-budget refusal paths intact. This conservative
lexical selection is not a general semantic field extractor: arbitrary unquoted
words, cross-line relationships and correctness of narrative prose remain open
acceptance criteria. It does not establish universal provider fidelity.

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
v4 source still fails Super Free at round five, so this is not a same-model causal
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

The subsequent [v5 source-observation result](compaction-source-observations-2026-10-15.json)
retests the original unhinted receipt question on the same explicit Super Free
model as that retained failure. Ten successive review rounds pass with ten
persisted summaries, nine value changes, ten verified exact defining lines and
source archive hashes, twelve canonical snapshots, and restarts after rounds
five and ten. The first source and review match the retained original failure.
The source block now interleaves plaintext updates after older JSON replies;
cache reuse checks the complete selected evidence and provenance. This is a
controlled stochastic result, not a deterministic general semantic guarantee.

Local typecheck, source/touched/harness lint and 81 focused cases pass. The new
plaintext-after-JSON regression fails with the previous production collector.
Twelve unchanged journey-guard cases are reused with matching file hashes.
The inspected non-container build takes 336.423 seconds and the journey takes
464.257 seconds, measured separately. All 20 new approved OpenRouter Free calls
report USD 0 with no missing cost fields; every owned app epoch closes. The
[compressed trace](compaction-source-observations-provider-trace-2026-10-15.json.gz)
retains requests, replies, original source payloads and canonical snapshots.
Arbitrary unquoted fields, cross-line relationships, narrative correctness,
every-transform/native/session/signature/visual and release acceptance remain
open. No broad suite, remote CI, container or release checks were dispatched.

### Unquoted fields and adjacent source lines

`summary-v6-source-spans` extends lexical selection to unquoted colon/equal
fields, such as `Status: pending`. A selected field retains its surrounding
bounded paragraph, including adjacent subject, value, negation and cause lines.
Text records include the ordinal text part and original UTF-16 start/end offsets.
Blank lines and code fences separate spans; standalone JSON retains its existing
exact lexical representation. Paragraphs split at complete lines within the
4,096-character value bound, with archive recovery required for a selected split.
Oversized selected lines are omitted whole. Record/block bounds remain unchanged.
The complete reconstructed block participates in cache validation; v5 artifacts
regenerate under the new policy.

The existing compatibility harness accepts
`COMPACTION_ACCEPTANCE_MODE=field-fidelity` for five fresh summaries of unquoted
multiline destination/status/reason fields. It changes current values, returns
to the original values, checks original no-send authority and source positions,
and verifies archive hashes, canonical history and an application restart.
Run through flujo-bash using the documented qualified-build, private-profile and
explicit approved Free-provider configuration. The
[frozen selected-field result](compaction-source-spans-2026-10-15.json) retains
the tested configuration, timings, costs and complete compressed trace.

This is still lexical source selection. It does not establish a general semantic
validator for unlabelled prose, omitted/cross-paragraph relationships or generated
narrative. Earlier ten-round receipt/cache/recovery proofs retain their original
revision and scope. Every-transform, Native/session/signature, visual-benefit and
release acceptance remain open in #1091.

The rebuilt application passes this five-round selected-field check on explicit
Ultra Free: five persisted summaries and exact replies, four changes returning
to the first values, five source-span/archive checks, six canonical snapshots
and a restart. The frozen trace retains the earlier Super transport timeouts
and harness failures. The harness now pairs its installed HTTP client/agent,
preserves failed SSE envelopes and distinguishes failed retries from duplicate
completed responses. Four captured correct rounds also pass offline replay.
This is not a same-model causal comparison with the earlier Super attempt.

Local typecheck, source/touched/harness lint, 85 focused cases and 24 harness
guards pass. The previous collector fails the new multiline field regression;
duplicate completions and incomplete output remain rejected. The inspected
non-container build takes 333.572 seconds; the accepted journey takes 194.684
seconds, measured separately. Across all attempts, 18 completed approved Free
responses report USD 0; eight failed/timeout requests return no usage/cost fields.
Both explicitly selected routes have verified zero-price catalogs. Every app
epoch closes. The frozen record retains each failed attempt and separate timing.
No full suite, remote workflow, container or release check was dispatched.

### Bounded recovery of ordinary prose

`COMPACTION_ACCEPTANCE_MODE=prose-recovery` extends the existing built-application
harness with five unlabelled Spanish source updates. Destination, status, reason
and the statement that no send occurred occupy separate paragraphs, without the
lexical characters selected by the exact-source collector. The values change
and return to their initial state. A conflicting reported permission remains
observation data; the original user prohibition stays authoritative.

Each review supplies a real archive URI, SHA-256 and UTF-16 range, without answer
values. It requires an actual `read_resource` request beyond the default archive
prefix, at most 1,200 returned characters, verified original payload bytes, exact
current replies and canonical tool pairing. The original user instruction must
remain verbatim on both the read and final-answer requests. The harness also
checks canonical preservation and a built-application restart. Introducing the
reader may change the tool fingerprint and safely regenerate the summary; this
does not require a cache hit or invalidate the earlier immutable source archive.

The [frozen result](compaction-prose-recovery-2026-10-15.json) and its complete
compressed trace identify all requests, retries, source payloads and snapshots.
This qualifies recovery using a supplied locator. Autonomous locator discovery,
arbitrary narrative validation, exhaustive transform/provider coverage and the
Native/session/signature/visual/release criteria remain open in #1091. Existing
five/ten-round/cache/action/interruption/persistence proofs keep their original
revision and scope.

The rebuilt application passes all five updates on explicit Ultra Free, with six
persisted summaries, five bounded verified reads, exact replies, eleven canonical
snapshots and restart durability. The first reader introduction regenerates the
summary safely; subsequent reads reuse it. Independent verification checks all
six source archives and 920 canonical fields against the frozen trace. Application
source and dependencies are unchanged.

Fresh local typecheck, source/harness lint and 39 harness guards pass. The 85
unchanged runtime regressions retain their earlier pinned results. The inspected
non-container build takes 327.148 seconds and this journey takes 262.529 seconds,
measured separately. Of 29 approved Free requests, 21 completed responses report
USD 0; eight failed provider responses have no returned usage/cost fields. Failed
attempts remain in the trace and do not cause additional archive reads. Both
application epochs close. No full suite, remote workflow, container or release
check was dispatched.

## Ten-round generic text-transform authority acceptance

The October 15 [frozen result](compaction-protected-state-2026-10-15.json) and
complete compressed provider trace qualify ten successive rounds each of
summaries, resource-backed result shortening and emergency omission in the
actual built application. Each route preserves the original no-send user
instruction, developer instruction and the order and literal text of all user
corrections. Thirty qualified replies retain the latest destination, Windows path and
status, with no inferred send permission or generated tool call. Conflicting
historical claims of permission do not replace the user's prohibition.

The trace proves each intended transform actually reaches the continuation.
All ten result masks refer to their hash-verified original archives. Provider
tool pairing and canonical history remain valid; independent replay compares
6292 canonical fields.
Three route restarts after round five, two explicit interruption resumes and a final restart preserve the stored
histories. The first seven summary rounds are reused; an overloaded eighth generation falls back to complete canonical history and remains unqualified until its resumed summary succeeds. An infeasible protected input returns an explicit context-budget
error without a provider request or shortened canonical instruction.

The initial mechanical prompt did not declare the permission output type. One masking reply returned null despite intact original instructions and is retained as a failed attempt. Before the mechanical matrix, sendAllowed was pinned as boolean without supplying its value; only unknown may be null. This revised protocol is recorded separately from the original summary prompt.

Configuration is explicit: ten rounds per transform, two recent wire messages,
4,096 kept summary tokens, 4,000 output tokens and configured windows of
1,000,000 / 24,000 / 16,000 for summary / masking / emergency. The selected
approved OpenRouter Ultra Free catalog advertises a 1,000,000-token window and
zero input/output pricing. All 67 recorded requests retain that
exact route without fallback; 42 completed responses
contribute to USD 0 reported cost; 25
requests lack cost fields. Timings and all failed attempts remain in the result.

Fresh typecheck, source/harness lint, the inspected non-container application
build and 47 focused harness guards pass. The unchanged 85 runtime cases retain
their earlier pinned evidence. This tests synthetic historical exchanges and
one Responses route; developer maps to system on that adapter. It adds no
external-action, provider-overflow retry, Native/session/signature, visual or
release acceptance claim. Earlier accepted proofs retain their scopes and
#1091 remains open. Application source and dependencies are unchanged.

## Responses reasoning ownership and projection invalidation

The existing #1091 native-state review reproduced opaque reasoning replay after
changing the selected model, connection, provider, endpoint, credential, tools,
instructions, source text or function arguments. Conversation/node IDs alone
were insufficient, including on the streaming route. Eleven new adapter
regressions failed against main before the repair.

The Responses and OpenRouter Agent SDK adapters now capture a workspace-local
cache owner before dispatch. Its digest binds the concrete adapter, selected
connection/model/provider/endpoint, credential scope, reasoning policy, output
modalities, tools and name bindings. Credential bytes are not retained in the
cache. Every anchor also binds the provider-visible input prefix and generated
assistant/function-call group. A changed or summarized prefix discards that
anchor; an unchanged appended tail can retain its exact opaque items.

A late completion cannot repopulate a forgotten, evicted or replaced owner.
Conversation/node keys are encoded as tuples. The existing bounds remain 200
sessions per workspace and 64 anchors per session, with active-owner LRU refresh.
The existing streamed canonical JSON digest avoids a whole-history serialized
copy when fingerprinting the prefix. Canonical history remains available when
this optional process-local cache is empty, including after application restart.

[The frozen evidence](responses-reasoning-ownership-2026-10-15.json) records the
source tree, local typecheck/lint/non-container build, 88 focused checks and 40
controlled HTTP cases through the production Chat route's emitted adapter
registry and real SDKs. The 80 loopback requests cover both adapters, ordinary
and streaming continuation, exact opaque-byte reuse and configuration/projection
invalidation. The initial equipment failures are retained separately; the
successful fixture uses the installed SDK's complete Responses/SSE schema.
Run through flujo-bash with an absolute task-owned report path:
`node scripts/responses-reasoning-acceptance.mjs <report.json>`.

The loopback opaque strings are synthetic, and no tool executes. Four genuine
OpenRouter Nemotron Super Free turns also pass through the emitted adapters:
each requests the read-only tool, then returns its exact receipt after a saved
connection change. All four report zero cost and return no opaque items, so
they establish canonical continuation rather than real opaque-state replay.
The earlier Ultra Free provider error and timed-out diagnostic attempt remain
failed in the evidence; neither supplies monetary cost fields. The
[Responses state protocol](https://developers.openai.com/api/docs/guides/conversation-state)
describes complete output replay; this repair covers the existing bounded
tool-anchored reasoning cache. These results do not establish durable native compaction windows,
provider signatures, every resolved backend behind a router/alias, CLI session
resume, visual benefit or release acceptance. Those #1091 criteria stay open.

## Complete Responses output replay

The next existing #1091 repair addresses reconstruction of native output. Six
new regressions fail before repair: interleaved reasoning moves ahead of all
calls, native message IDs/phases disappear, final answers have no tool anchor,
and incomplete output can enter the reasoning cache. The
[Responses state contract](https://developers.openai.com/api/docs/guides/conversation-state)
requires preserving the complete output array for stateless continuation.

Both Responses SDK adapters now retain the complete output of completed
responses whose assistant projection exists in canonical history. On unchanged
continuations, that window replaces the synthetic Chat Completion projection
at its original boundary. Reasoning, assistant messages, refusals, function
items, IDs, phases and their original order stay together. Tool results remain
separate and retain their original call IDs. Provider aliases remain in native
items while the conversation keeps canonical tool names. Final answers can
carry a window without a function-call anchor.

Reuse requires the captured route/authority owner, exact canonical source and
assistant projection, plus the normalized native input that produced the
window. A late sibling can return the same text with different native IDs;
dependent windows then invalidate. Eviction also invalidates windows whose
native ancestors are missing. Incomplete/failed responses do not enter this
cache. The returned output is cloned; replay never mutates canonical history.

The existing 200-session/workspace and 64-window/session bounds now also cap
retained output at 1,048,576 serialized JSON UTF-16 code units per session.
Oversized windows are skipped and older windows are evicted. Calls without a
conversation-owned checkpoint use a process-local cache and canonical fallback
on restart. Ordinary Process execution now checkpoints bounded output as
described below. This does not introduce a provider compaction endpoint.

The [frozen full-output evidence](responses-output-replay-2026-10-16.json)
records 100 focused checks, local typecheck/lint and the non-container build on
source tree `5eee4cbf2caa95a1c2124664a5b44f3999bf7ad2`. Fifty-six emitted HTTP
cases / 116 loopback requests verify exact windows through both SDKs and
streaming modes, provider aliases, rewrite/configuration fallback, final
answers, incomplete responses and three-turn lineage. Six genuine Super Free
turns through the same emitted adapters perform four exact replays of actual
returned output and preserve the exact supplied receipt. No tool executes.
The provider returns no encrypted items; synthetic encrypted strings qualify
controlled replay only. Durable native compaction, real provider signatures,
CLI resume, broader semantic/provider coverage and release acceptance remain
open in #1091.

## Durable Responses output checkpoints — October 16, 2026

Ordinary Process calls checkpoint complete native Responses output alongside
their canonical conversation through the existing state persistence path. Both
Responses SDK adapters restore this derived state after application restart.
The checkpoint is versioned and bound to workspace, conversation, node, adapter,
connection, model, provider, endpoint, credential fingerprint, tools and effective
reasoning configuration. Credential bytes and tool execution authority are never
stored in it. Exact canonical source/assistant and normalized native-input
digests still govern each window's reuse.

Checkpoint records have an integrity digest for accidental corruption. Schema,
scope, policy, payload and size validation run on restore and before reuse.
Missing, corrupt, oversized or incompatible state uses canonical history;
derived metadata never repairs or replaces canonical messages. Each session
retains at most 64 windows, and the aggregate conversation checkpoint retains
at most 64 nodes and 1,048,576 serialized JSON UTF-16 code units, including
metadata. The current conversation checkpoint takes precedence over disposable
process-local state. Stop and superseding invocations fence late publications;
chat rewind, graph reset and meeting exit clear the corresponding checkpoints.

The [frozen persistence evidence](responses-durable-state-2026-10-16.json)
records application source tree `b2c9f244b88ef960a0344e173a6685fda31a2c3b`,
264 focused checks across ten suites, typecheck/lint and the inspected
non-container build. Two restart regressions fail before repair. Twelve actual
built HTTP cases across five application epochs cover normal owner enrollment,
scoped execution, exact opaque bytes/IDs/phases/order after restart, same-size
corruption fallback, changed credentials and unchanged canonical messages.
The 56 emitted real-SDK HTTP cases also pass. All application epochs exit with
their output pipes drained. Earlier fixture/readiness/type failures remain in
the evidence and receive no acceptance credit.

Run the controlled built-app check through flujo-bash with a fresh absolute
report path: `node scripts/responses-durable-acceptance.mjs <report.json>`.
The owner must remove its private profiles after their observed epochs close.
Four genuine explicit Nemotron Super Free turns run through separate processes:
both adapters replay actual provider output after a JSON checkpoint and retain
the exact receipt. Each reports USD 0; no tool executes or model fallback occurs.
That provider returns no encrypted items, so genuine encrypted/signature/CLI
resume, provider compaction windows, broader semantic/position/visual and release
acceptance remain open in #1091.

## Continuing completed handoffs — October 16, 2026

A later deterministic edge must not answer an already completed handoff or reuse its old caller brief/session key. The runtime now captures and answers pending calls only. With none pending, it skips caller-input capture entirely, including the Signal caller-body marker. Partially completed batches still handle their pending calls.

The [frozen handoff and fidelity evidence](responses-restart-fidelity-2026-10-16.json) records 80 focused runtime checks across five suites, 32 harness guards, fresh typecheck/lint and the inspected non-container build. Two initial regressions and the adjacent Signal regression fail before repair.

The six actual built-app cases use approved Claude Haiku 5.5 through OpenRouter. Each ledger fsyncs every invocation and has no deduplication. Both sequential cases replay the actual native provider output after process restart. Stop/crash cases reconcile the real committed writes after their acknowledgement is lost; the source/corrections rotate through early, middle and late positions.

| Adapter / case | Exact replies | Physical writes |
|---|---:|---:|
| openai-responses / sequential | 10/10 | 2 |
| openai-responses / cancel | 3/10 | 2 |
| openai-responses / crash | 2/10 | 2 |
| openrouter-agent / sequential | 10/10 | 2 |
| openrouter-agent / cancel | 10/10 | 2 |
| openrouter-agent / crash | 10/10 | 2 |

All 60 captured rounds preserve trusted user authority and valid tool pairing on every continuation; all six selected ledgers have two writes from two authorizations. Ten incomplete later summary sources were rejected while valid summaries and safe canonical fallback remained available. The 15 non-exact OpenAI Responses recovery replies remain failed acceptance, including `sendAllowed:null` instead of `false` and extra prose. No answer is repaired for scoring. #1091 remains open.

Matrix source `783a3522c1d0ac36fa56e3bdb86cc4aee70b47ce` and final guarded source `31678cb7e11b9d1d5db0ec03544e640dc3faf8f7` are recorded separately. The final Signal guard skips an otherwise empty capture block; its branch is covered by the new regression and fresh final build. The compressed trace includes the matrix source patch, all provider traffic/canonical snapshots, earlier failures, aborted baselines and the unusable old receipt.

The selected matrix reports USD 0.916433. Across usable attempts, reported charges total USD 1.230976; 7 requests lack reported cost, and the unusable old receipt supplies no cost evidence. Overlapping case timings are recorded per case rather than added into a wall-clock claim.

Free was attempted first; its over-issued write batch and path error stay unqualified. DeepSeek sometimes exhausted the fixed 4,000-token summary ceiling on reasoning. Genuine provider compaction endpoints, encrypted/signature/CLI and Claude Agent SDK lifecycle, visual benefit, installed/endurance and release acceptance remain unqualified. No full suite, remote CI, container/image build or release was dispatched.

## Returned compaction and hosted-tool checkpoints — October 16, 2026

The next existing #1091 review reproduced a native replay gap: the checkpoint
validator accepted only reasoning, messages and function calls. A completed
response containing a compaction or hosted-tool item lost its whole durable
window. Replaying raw output also retained SDK-only parsed values and output
provenance that do not belong in a later input request.

Both Responses adapters now preserve known output kinds from the installed
OpenAI SDK. The stored window stays exact; a separate replay copy uses the SDK's
input conversion to remove output-only fields and omit items that cannot be
replayed without changing their meaning. Unknown and input-only output kinds
still use canonical fallback. Existing owner/prefix checks, integrity digests,
size limits and tool-execution authority remain in force.

The installed OpenRouter SDK accepts a compaction input but represents that
returned output as `UNKNOWN` with its original payload in `raw`. The adapter
restores only a recognized compaction item with an ID and nonempty opaque
content. Malformed or unrelated unknown output remains ineligible for replay.

The [frozen compatibility evidence](responses-returned-compaction-2026-10-16.json)
binds source, harnesses, before/after failures and local qualification. Five new
regressions fail on the prior main. All 137 focused checks across four affected
suites, typecheck and lint pass on the repaired application inputs.

The inspected non-container application/five-MCP build passes in 350.500 seconds
on application source tree `129ddcece518bf67f8d9f87b1331687f613de62f`.
Both real SDKs pass 56 emitted HTTP cases / 116 local requests, including
streaming and three-turn lineage. The actual built app passes 14 checks over
five application epochs / eight local requests: exact compaction bytes and
hosted-search receipts after restart, clean replay fields, unchanged canonical
messages, same-size corruption fallback and credential invalidation. Every
owned epoch exits with drained pipes. These phases overlap; their measured
durations in the receipt must not be added together. No inference is dispatched.

This changes handling of returned output; it does not request a provider
compaction endpoint or introduce a new tool. Synthetic protocol checks do not
qualify genuine provider compaction, encrypted state, native SDK/CLI sessions,
visual benefit, installed/endurance or release acceptance. #1091 remains open.

## Genuine encrypted Responses checkpoints — October 16, 2026

The [frozen live evidence](responses-genuine-encrypted-state-2026-10-16.json)
adds genuine provider-encrypted reasoning to the existing checkpoint acceptance.
The prior approved Free runs returned no encrypted items. Explicit GPT Luna
through OpenRouter supplies nonempty opaque output; the strict relay forwards
the original request and response bodies without substituting answers or models.

Both `openai-responses` and `openrouter-agent` pass the actual built HTTP journey
with normal owner enrollment, scoped execution and a saved model-only flow.
After the application exits and restarts, its durable checkpoint supplies the
exact encrypted bytes, item IDs and ordering to a new provider request. The
provider accepts that request and returns the exact Unicode receipt. Deliberate
same-size corruption of the derived checkpoint and a changed connection
credential each invalidate its native windows; canonical-history continuation
still returns the same receipt and preserves all earlier canonical messages.
No tools or third-party side effects execute.

The application source remains main `42ad5ba1`, source tree
`f70d21d034f35682da403387d5ff5d702969247f`; this batch adds acceptance and evidence.
All 22 live checks pass across eight genuine provider calls and five application
epochs, with observed exits and drained output pipes. Typecheck, whole-source
lint, final harness lint/syntax and the inspected non-container five-MCP/Next
build pass. Build time is 337.045 seconds; the live journey is 37.692 seconds.
Overlapping phases are measured separately. The eight calls report USD 0.0005214;
the capability probe reports USD 0.0000263, totaling USD 0.0005477 with no missing
cost fields. The complete redacted provider/canonical trace is retained beside
the receipt.

The first harness attempt supplied an optional reasoning-effort setting that
the ordinary OpenRouter profile does not expose. Model creation rejected it
before any provider call. Its failed receipt remains in the trace and receives
no acceptance credit. The corrected harness uses the normal provider default;
no product validation gate is changed.

Reproduce through flujo-bash with a fresh absolute report path:
`node scripts/responses-live-state-acceptance.mjs <report.json>`. Set
`OPENROUTER_API_KEY` (or the existing read-only configured-provider loader),
`COMPACTION_ACCEPTANCE_MODEL=openai/gpt-6-luna` and an available
`COMPACTION_ACCEPTANCE_PORT`. The harness defaults to an approved Free model,
requires genuine encrypted output for a pass, and never changes models after
a refusal. Remove its private profile and authority only after all epochs close.

This qualifies genuine encrypted checkpoint replay and invalidation on the two
non-streaming HTTP routes. Encrypted contents remain opaque. It does not call
a provider compaction endpoint or qualify native CLI/Claude Agent SDK sessions,
broader semantic/position/visual behavior, installed/endurance or release
acceptance. #1091 stays open for those existing criteria. No full/remote CI,
container build, release or automation change is introduced.

## OpenRouter native compaction availability — October 16, 2026

The [capability evidence](responses-compaction-capability-2026-10-16.json)
checks the remaining genuine provider-compaction requirement before a runtime
change. Both explicit `openrouter/free` and `openai/gpt-6-luna` requests use the
existing OpenRouter credential in memory, without fallback, tools or an
application profile. Full request/response bodies are retained in the linked
compressed trace. This is direct provider evidence, not built-app acceptance.

On October 17, 2026 UTC (October 16 in Bogota), both
`https://openrouter.ai/api/v1/responses/compact` requests return HTTP 404 with
`Not Found`, no generation ID and no usage. The corresponding `/responses`
requests include `context_management: [{ type: "compaction",
compact_threshold: 1024 }]`. They complete with 10,201 Free input tokens and
8,611 Luna input tokens, return the exact synthetic Unicode receipt, and contain
no `compaction` output item. The response does not echo `context_management`.
These observations do not establish that the field was honored, or prove
support on every model. They cannot qualify a genuine compacted provider window.

The two completed inference responses report USD 0 and USD 0.0009356;
both include cost evidence. The two 404 responses have no billing record in
their bodies; they are recorded separately rather than assigned a measured
zero charge. No direct OpenAI call or unapproved model is used. The probe
defaults to Free and never retries or changes models after a refusal.

The existing exact encrypted reasoning acceptance remains valid. Encrypted
reasoning and a provider-generated `compaction` item are distinct protocol
objects. Genuine provider compaction stays unqualified on these tested
OpenRouter routes. Revisit this capability when relevant provider support
changes; do not repeatedly infer availability from a successful ordinary reply.

Backlog reconciliation also corrects a stale next-action note: the 15 Responses
Stop/crash reply failures in the historical #1188 matrix were addressed by
merged #1189/#1190/#1191. The final
[receipt-selection evidence](recovery-receipt-selection-2026-10-16.json)
scores 40/40 exact Haiku/Luna replies. The later
[native fallback evidence](native-fallback-replay-2026-10-16.json) records
20/20 exact replies and 20/20 ordinary signed-output replay windows; forced
canonical-fallback transitions remain regression-only. Historical failures
stay in their original evidence and do not become current defects merely
because an older handover still points to them.

No product source or acceptance criterion changes in this batch. #1091 remains
open for genuine provider compaction, native SDK/CLI, broader semantic/position
and visual behavior, installed/endurance and release acceptance. No full/remote
CI, container build, release or automation change is introduced.

## Codex native compaction and durable resume — October 16, 2026

The owned app-server transport omitted the documented `thread/compact/start`
method from its admission list. A live capability probe completed an ordinary
Terra subscription reply, then FLUJO refused the compaction locally before
dispatch. The new process-boundary regression reproduces that refusal. The
repair admits this specific method through the existing owned transport.

The [bound source, full traces, failures and limits](codex-native-compaction-2026-10-16.json)
record ten successive genuine native compactions and eleven exact production
adapter replies on **GPT-5.6 Terra low**, with Codex CLI/SDK **0.162.1**.
Twenty-one fresh workers verify native `account/read = chatgpt`, cleared API-key
environment, managed credentials/configuration and containment in the owned
profile. The CLI binary hash stays identical. One durable thread survives every
process restart.

Each native operation must finish its typed `contextCompaction` lifecycle and
append a durable full replacement window containing an encrypted `compaction`
item. Earlier native records remain byte-equivalent. After every compaction,
the emitted production adapter resumes the same thread, leaves every native
window unchanged, and sends only the new question. The native rollout confirms
that the exact receipt is not reinjected. All eleven replies preserve the JSON,
Spanish/Unicode path, UUID, SHA-256, revoked permission, accepted correction,
completed-operation state and unknown-field null. Canonical caller input hashes
remain intact.

The final two focused suites pass 47 checks; the new regression fails before
repair. Fresh typecheck, source/test/harness lint and the inspected non-container
five-MCP/Next build pass. Measured build time is 354.053 seconds, typecheck
63.188 seconds and lint 104.348 seconds. Final worker timings are p50/p95
6.224/7.783 seconds for compaction and 6.563/7.700 seconds for adapter turns;
these include startup, account verification and binary hashing. The final
cumulative adapter/native counter is 96,034 input / 1,775 output tokens. Native
compactor counters are retained separately; do not add overlapping counters or
infer a per-call dollar invoice. No separately billed provider request is made.

The initial helper-lookup attempt failed before inference and receives no
acceptance credit. The next probe's local method refusal also receives no
compaction credit. A successful one-round capability check preceded the frozen
ten-round run. Across these probes and the final run there are fourteen completed
adapter turns and eleven completed native compaction operations, all using the
verified approved subscription route. Full failed attempts remain in the trace.

To reproduce through flujo-bash after an application build, set
`CODEX_ACCEPTANCE_ROUTE=subscription`,
`COMPACTION_ACCEPTANCE_MODEL=gpt-5.6-terra` and
`CODEX_ACCEPTANCE_NATIVE_COMPACTIONS=10`, then run
`node scripts/codex-native-lifecycle-acceptance.mjs <new-absolute-private-report.json>`.
The harness sets and asserts both FLUJO data-root markers before loading the
emitted runtime. It never falls back to another model or API-key billing.

This qualifies controlled manual native compaction and durable adapter resume
for the tested route. Automatic thresholds, real external actions/tool replay,
Claude SDK lifecycle, broader semantic/position/visual comparisons and
installed/endurance/release acceptance remain outside this result. #1091 stays
open for those existing criteria. No full/remote CI, container build, release,
deployment or automation change is introduced.

## Paired semantic recovery and provider failures — October 16, 2026

Repeated summarization could copy the runtime's source-observation and execution-receipt sections into generated narrative. Validation correctly rejected that output and retained complete history. The prompt now explicitly leaves those sections, records and archive footers to FLUJO. Existing rejection and exact-source restoration stay active.

The [frozen evidence](compaction-semantic-2026-10-16.json) and [provider/source corpus](compaction-semantic-provider-trace-2026-10-16.json.gz) contain five paired ten-round matrices. Each round shares its original update and question across four treatments. Early/middle/late observations, temporal reversals, Spanish names and relationships, an original user prohibition, unsupported-date null and bounded source recovery are tested. Every inference uses a fresh emitted adapter worker. Earlier generated answers are discarded from subsequent rewrite sources. Narrative ablation is a diagnostic projection; production applies protected source restoration.

Cells show exact task answers; parentheses count genuine model summaries, excluding canonical fallback. Masking performs ten mechanical transforms per matrix.

| Treatment | Free before | Free repaired | DeepSeek 0731 before | DeepSeek 0731 repaired | DeepSeek v4.1 repaired |
| --- | --- | --- | --- | --- | --- |
| Full history | 7/10 | 9/10 | 8/10 | 7/10 | 10/10 |
| Selective masking | 9/10 | 10/10 | 9/10 | 7/10 | 10/10 |
| Narrative ablation | 9/10 (10 summaries) | 8/10 (10 summaries) | 10/10 (8 summaries) | 9/10 (7 summaries) | 6/10 (10 summaries) |
| Protected summary | 7/10 (5 summaries) | 4/10 (10 summaries) | 10/10 (1 summary) | 9/10 (7 summaries) | 10/10 (10 summaries) |

The repaired protected route qualifies on explicit `deepseek/deepseek-v4.1-flash` through OpenRouter: five-round and ten-round checkpoints both retain every tested field, prohibition and unknown null, with ten genuine successive summaries. All 26 recovery reads request hash verification and return exact original ranges of at most 1,200 UTF-16 code units. Full history and selective masking also answer 10/10. The narrative ablation's four failed cases include invalid recovery requests; those requests are refused and retained as failures.

Free completes ten summaries after the repair but its protected continuation answers remain unqualified, including permission errors. One Free request also returned HTTP 200 with provider status `failed`; the adapter incorrectly exposed an empty successful completion. The shared Responses translator now raises an error for failed, cancelled and nonterminal responses, and for an explicit provider error. Valid incomplete-response handling remains covered. The [official terminal-event contract](https://developers.openai.com/api/reference/resources/responses/streaming-events) distinguishes provider failure from completion.

Seven new regressions fail on the old translator. The final focused checks pass: 158 summary/Responses/dependent OpenRouter cases plus four scorer/protocol cases. The built SDK replay forwards the genuine captured failure through JSON and streaming HTTP 200, verifies that the last valid checkpoint survives both errors, then recovers on explicit retry. Its seed/retry/opaque items are controlled fixtures and incur zero upstream requests.

The ten-round real-model run uses source tree `62e11530`; final tree `60e6df08` adds only the Responses failure guard. All 93 actual completed responses from the qualifying run produce identical IDs, reply text, tool calls and usage through the final emitted translator. This checks the affected translation boundary while reusing genuine model evidence for unchanged successful paths. Final typecheck, changed-source lint and the inspected five-MCP/Next non-container build pass. No full/remote CI, image build or release runs.

Offline replay verifies 200 source chains, original user/system authority on actual continuation requests, tool pairing, unchanged model replies/scores and all 283 persisted source payloads. Failed provider output earns no successful acceptance credit. Explicit initial/previous/current source locators are supplied; retrieval discovery is outside this protocol. Read-only synthetic recovery does not establish genuine external-tool/duplicate-effect safety, Claude lifecycle, visual benefit, installed-release or endurance acceptance. #1091 remains open for those criteria and unqualified model routes.

Provider-reported cost across all retained attempts: USD 0.299765383; 6 requests lack reported cost. The qualifying v4.1 matrix reports USD 0.133784436. Ordinary Codex subscription usage was exhausted; Free was tried first, then approved DeepSeek routes selected using the measured token mix and live catalogs. Model-selection prices are estimates; reported charges come from actual responses. Four treatments overlap within a matrix, and repaired model matrices overlap; measured phase/case times are not added into a wall-clock claim.

## External MCP discovery and effect recovery — October 17, 2026

A cold resource listing could force a reconnect while a parallel tool call was
authorizing on the same MCP client. The captured first write was refused before
dispatch with `Not connected`; lookup confirmed absence and the genuine write
then succeeded. Multiple model attempts did not establish duplicate execution.
Resource/prompt discovery and native reads now hold runtime leases. Read-only
recovery preserves active borrowers and pinned Apps, reuses replacement clients,
rejects stale catalogs and permits retry after busy work finishes. Explicit owner
reconnect and existing security gates retain their behavior.

The [receipt](external-tool-compaction-2026-10-17.json) and
[complete provider/canonical/source corpus](external-tool-compaction-2026-10-17-trace.json.gz)
bind each attempt to actual source trees, frozen equipment, requests, responses,
summary artifacts, immutable archives and every ledger invocation. Three cold
HTTP SDK repetitions through the actual emitted MCP service complete six fsynced
writes with no interrupted tool call or duplicate effect, and zero model inference.
Four concurrency regressions fail before repair. The final 55 affected MCP cases
and 14 equipment controls pass (69 distinct checks). Typecheck, baseline whole-source
lint with changed inputs checked again, and the inspected five-MCP/Next non-container
build pass. Reused unchanged application source is
`5e689159436573748cb8efc2025f2679aea02aa8`; build time is
335.165 seconds and incremental typecheck is
10.887 seconds. Current source/test/script
and package hashes are recorded separately from the base revision. The later
experimental build/checks are not counted as delivered-source qualification.

The existing built-app equipment now obtains changing semantic facts through an
actual authenticated external MCP server. The model chooses its calls and uses
normal resource discovery; the harness supplies no source locators. Facts rotate
between early/middle/late positions and include temporal reversals, Spanish values,
an unsupported date and an external claim that sending is permitted. Original
user instructions still prohibit sending. The ledger executes every invocation
without deduplication. One write completes and another is fsynced with its
acknowledgement suppressed; the application restarts before reconciliation and,
when reached, again after five reviews. Every original observation must be read
once, including after the final review. Exact answers cannot conceal rereads.

| Attempt | Exact/scored reviews | Raw status | Physical writes/commit calls | Reported USD |
| --- | --- | --- | --- | --- |
| Free baseline | 1/1 | failed | 2/2 | 0.000000000 |
| DeepSeek before connection repair | 0/0 | failed | 2/2 | 0.016246186 |
| DeepSeek after connection repair | 9/10 | failed-semantic-fields | 2/2 | 0.125598509 |
| DeepSeek chronology experiment | 9/10 | failed-semantic-fields | 2/2 | 0.107235998 |
| Haiku / 4,000 output tokens | 8/8 | failed | 2/2 | 0.516710700 |
| Haiku / ambiguous unknown scope | 1/6 | failed | 2/2 | 0.277109300 |
| Haiku / scoped action unknown | 0/0 | failed | 2/2 | 0.013335100 |

Free's one exact review depends on a prohibited original-observation reread and
earns no acceptance credit. The first DeepSeek attempt exposes the connection
race and an equipment guard that counted a legitimate lookup before the uncertain
write as premature reconciliation. The guard now applies after that actual write.
After the connection repair, DeepSeek answers 9/10 but misses the previous
destination in round 5. Source events and archive order are correct; the generated
summary derives a contradictory previous state and the continuation follows it.
A chronology-guidance/cache-policy experiment still scores 9/10, missing round 8.
Its exact patch and validation are retained in the corpus; it is not shipped.

Haiku answers eight scored reviews exactly, then the ninth summary exhausts its
4,000 output tokens, including 2,590 reasoning tokens. FLUJO retains full history;
the incomplete summary receives no fresh-compaction credit. Increasing the
equipment allowance to 8,000 exposes another contract ambiguity: `unknown` is not
limited to action evidence, so Haiku reports an actually unavailable museum
responsible person outside the requested delivery fields. Those mismatches are
ambiguous equipment outcomes, not conclusive semantic model failures. Protocol v2
now scopes `unknown` to unresolved action states/receipts, with expected objects
and scoring unchanged. The fresh scoped-contract run and the preceding attempt
both stop on HTTP 402 before completing the required ten rounds. Their original
statuses, requests, replies and effects remain intact; no ten-round pass is claimed.

Native inspection verifies ChatGPT subscription authentication with API-key
environment cleared, but ordinary weekly usage is exhausted. Free is tried first,
then approved DeepSeek and explicit OpenRouter Haiku 5.5. Haiku and Luna tie at
catalog base prices; prior receipt evidence and a prior Luna UUID miss inform the
choice. Haiku's actual 130,395-token source crosses its higher-price tier, beyond
the earlier estimate based on an 81,581-token maximum. Reported inference cost
across all retained attempts is USD 1.056235793; 3 rejected requests lack
reported cost and are not assigned a measured zero. Account inspection confirms
exhausted OpenRouter credits and no configured-key spending limit. No blocked
model, automatic fallback or direct Claude OAuth is used.

After account funding, reproduce through flujo-bash after an application build
with a fresh absolute `COMPACTION_ACCEPTANCE_RUN_DIR`, an available port,
`COMPACTION_ACCEPTANCE_SCENARIO=semantic`, the approved configured-provider loader
and model, and `COMPACTION_ACCEPTANCE_MAX_TOKENS=8000` for Haiku, then run
`node scripts/compaction-action-acceptance.mjs`. The script creates its report
directory, uses normal owner enrollment and closes all application epochs.

This delivers the reproduced connection repair and improved acceptance equipment.
Full semantic/ten-round acceptance remains unfinished. Controlled local effects
do not establish third-party delivery or crash-midcommit atomicity. Native
CLI/Claude SDK ownership, genuine provider compaction, visual benefit,
installed/endurance and release criteria remain open in #1091/#1093. No full/remote
CI, workflow dispatch, container build, release, deployment, new issue or automation
change occurs. Model and build phases overlap; measured phase times are not added.
