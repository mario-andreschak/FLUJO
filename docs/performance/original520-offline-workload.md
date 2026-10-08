# Offline large-history workload equipment for #520

This equipment builds on qualified owned-schema baseline
`269579ab103a06cb16dc806be1debe36fbb55072`. On 2026-10-08, canonical TypeScript,
changed-file lint, all six lexer controls, and both complete workload controls
passed on Node 22.23.3 / Windows with the default 4,345,298,944-byte heap limit.
The scenario does not reproduce
the unavailable original transcript or establish the cause of its fatal OOM.

The complete comparison took 110.945 seconds. Both children exited with code
zero, no signal or timeout, and independently observed stdout/stderr ends and
close. The guarded run refused two queued jobs before HTTP; the comparison
completed all four queued jobs but retained three actual production archive-read
LIMIT refusals after independent streamed history witnesses. Both archive write
ledgers drained to zero bytes, writers, and quarantines. Raw logs, samples,
archives and receipts remain in the qualification fixtures.

The 127 guarded samples observed maximum RSS 615,493,632 bytes and heap used
427,861,048 bytes; the 179 comparison samples observed RSS 605,945,856 bytes and
heap used 411,242,080 bytes. These sampled maxima are not exact peaks and do not
demonstrate a memory reduction, OOM prevention, original-workload support, or
readability of the refused comparison archives.

The first actual integrated run failed both controls: guarded execution reached
proof emission but Jest could not resolve the unexported `openai/package.json`
subpath; admission-off initialization eagerly evaluated a circular SWC export
getter. Those raw failures and owned roots remain preserved. This successor
reads bounded installed package metadata by walking at most six directories
up from the supported `openai` entry, verifies checkout-local containment and
the package name, and records its real version/hash. Its test-only admission
mock copies lazy export descriptors and replaces only the named budget controls,
without enumerating getter values during module initialization. These repairs
have not yet been executed or qualified.

The next actual repaired run passed guarded execution (72.816 s) but the
admission-off process hit the unchanged production archive read limit while
checking its large archives. That failure and both process roots are preserved.
This successor retains the real production reader and separates readability
from byte fidelity. Each archive first receives an independent streaming gzip
witness: checked file containment/identity, compressed SHA256, decoded byte
count, and decoded canonical ASCII history hash at the root canonicalMessages
entry. The witness holds at most 32 KiB decoded hash text plus bounded token/id
metadata and stream buffers; it does not parse or retain a complete snapshot.
It is a narrow test witness for writer-produced JSON with id before content,
not a generic JSON reader or a replacement SDK archive API. Its independent
allowances are 64 MiB compressed, 512 MiB decoded, depth64 and 100,000 strings.
Small controls cover chunked escapes, decoys, missing history and corruption.
The real reader is then called. Only admission-off may record an actual typed
MODEL_TURN_ARCHIVE_READ_LIMIT after a successful canonical witness; every other
error fails and guarded reads must remain admitted. The proof records each
archive's production readability separately. A byte-fidelity witness does not
establish reader support, an OOM cause or full #520 closure. New controls are
Source-only and UNRUN until exact-pin qualification.

The original report describes approximately 500k parent tokens, 900–1400k child
tokens, three completed children, one AtlasCloud 400 failure and four queued
children. This fixture retains a 2,000,000-character parent and eight independent
3,600,000–5,600,000-character histories. Four characters per token is an explicit
proxy, not a tokenizer. A deterministic 64 KiB ASCII block repeats within each
history; its compressibility differs from a real conversation. No history is
truncated, summarized, evicted or discarded to pass a memory check. The Process
node explicitly disables compaction in both controls.

The setup parent and first four children use actual `runFlow`, FlowExecutor,
PocketFlow, ProcessNode, ModelHandler, canonical clones, archive compression and
conversation persistence with small 1024-character setup histories. Three
children complete and the fourth receives a local provider 400. Their durable
starting states are explicitly populated with the retained full-size proxy
histories through real persistence. Those histories did not produce the setup
outcomes; this represents already-completed work without disabling the guarded
budget to manufacture success. A durable invocation record represents that
three-completed/one-error/four-pending topology. Production `runSubflowLanes`
skips completed durable children and drains the pending jobs with concurrency
four through the real `runFlow`. This explicit record is a controlled starting
state; the scenario does not claim to reproduce the model's original handoff
generation or wall-clock residence of roughly 74 minutes.
The full-size parent separately enters actual ModelHandler/canonical archive
admission and may either complete or return the typed memory refusal.

Only model/key and flow-definition lookup are fixtures. Provider requests use
the ordinary OpenAI adapter/client and installed SDK against a fresh loopback
HTTP server, with both JSON and SSE responses. Client creation and SDK retry
configuration are unchanged. A first-attempt 429 followed by success exercises
the default SDK retry, with a separate small retry control guaranteed to reach
that path even when a large queued child is refused. It requires two physical
HTTP attempts inside one application request observation. Physical HTTP counts and application request observations
are recorded separately. No live provider or paid call is made. No production
memory bypass or environment flag is added.

Two fresh disposable Node/Jest processes run the same complete workload, one
with production admission and one with a test-only archive admission mock.
The negative control bypasses snapshot/write reservation and recheck functions;
other queue, flow, provider, archive and persistence code remains real. It also
bypasses local-media admission if used, although this scenario's media control
uses inline bytes. It measures the effect of these archive guards, not every
application allocation. The negative control need not OOM. Any timeout, signal,
spawn failure, unknown exit or ordinary test failure fails qualification and
preserves evidence; none is silently accepted as an OOM proof.

A separate 7,000,000-character canonical history verifies typed refusal before
SDK/HTTP dispatch in the guarded process and successful dispatch in the control.
The scenario checks original history hashes in any admitted large archive
snapshots and separately checks the identified setup histories in setup snapshots, verifies
that completed jobs were not dispatched again, and checks ledger drainage. A
64 KiB media archive/write/read checks actual media persistence. Queued large
children may be refused by the conservative budget; their refusal is evidence
of bounded admission, not proof that the original workload is operationally
supported. Any admitted retry lane must produce two physical requests.
All three previously completed children must retain exactly one physical request.
Every queued child must complete in the admission-off control. A guarded queued
failure must carry the actual `runFlow` result's typed archive LIMIT/BUSY code
and have zero physical HTTP requests; ordinary unrelated errors fail the suite.
Every durable lane must settle completed/error, with no pending, running or
cancelled lane silently accepted as drainage.

Each child emits 100 ms samples with RSS, heap used/total, external memory,
ArrayBuffers, GC count/duration and archive pressure. Phase markers expose the
retained queue topology. Timers cannot sample while JS is synchronously blocked;
these are observations, not exact peaks. Proof includes actual heap limit,
Node/OS/architecture, installed SDK version/entry hash, package-lock hash and
cgroup v2 memory values where available. Missing cgroup values are explicitly
null. This is the qualification host's environment, not an asserted match to
the original machine. Default heap is preserved: fresh child argv has no heap
override and the environment omits `NODE_OPTIONS`.

The whole suite is registered in the isolated inventory:

```text
node node_modules/jest/bin/jest.js --selectProjects node --runInBand --runTestsByPath __tests__/flow/original520OfflineWorkload.test.ts
```

Run only after Source review and the queue's resource grant, on an installed
checkout whose own Jest resolves beneath its own `node_modules`. Do not select
test names or combine this intensive suite with parallel workers. The parent
independently records the actual process exit event, stdout end and stderr end,
then waits for close. Successful qualification requires all three independent
observations and no stream error; close alone proves none of them. It retains
bounded raw logs, exit receipts,
samples, archives and proof beneath its identity-recorded owned temp root. Both
success and failure evidence are preserved for review. No automatic recursive
cleanup runs in this equipment. Qualification and any later cleanup remain
agent-owned; the user is not expected to prepare data, credentials or artifacts.
