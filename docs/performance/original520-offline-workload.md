# Offline large-history workload equipment for #520

This is Source equipment on qualified owned-schema baseline
`269579ab103a06cb16dc806be1debe36fbb55072`. All new execution, compiler, SDK,
memory and operational controls are **UNRUN**. The scenario does not reproduce
the unavailable original transcript or establish the cause of its fatal OOM.

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
waits for process exit and stdio closure, retains bounded raw logs, exit receipts,
samples, archives and proof beneath its identity-recorded owned temp root. Both
success and failure evidence are preserved for review. No automatic recursive
cleanup runs in this equipment. Qualification and any later cleanup remain
agent-owned; the user is not expected to prepare data, credentials or artifacts.
