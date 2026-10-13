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

Local regression coverage is source/runtime plumbing evidence. It is not
real-model fidelity, native opaque-window/signature roundtrip, original
[#520](https://github.com/mario-andreschak/FLUJO/issues/520) crash confirmation,
cross-platform/default-heap endurance, or an installed-release acceptance claim.
Those issue criteria remain open. Broader/provider/release suites follow release
pre-flight policy; the existing capped-child/HTTP-400 fixes are not reimplemented.
