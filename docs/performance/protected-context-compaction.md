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
