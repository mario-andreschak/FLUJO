# Context and image scale acceptance, 23 October 2026

This follows #1263. It qualifies specific recovery and scale paths, not universal
long-running agent accuracy. The [sanitized receipt index](context-scale-2026-10-23.json)
includes failed attempts and hashes of the retained private raw receipts.

The production webpack modules, `ModelHandler`, `FlowExecutor`, persistence,
resource tools and model adapters ran against synthetic histories and images.
An observation-only wrapper recorded logical completions without changing their
arguments or results. Each fresh Codex process verified ChatGPT subscription
authentication with an empty model API key. The other route was `openrouter/free`,
with no paid fallback. Test data and credential copies lived outside the repository.

| Case | Observed result |
| --- | --- |
| Codex subscription Luna, approximately 200,000 original messages | Recovered destination, receipt and restriction; originals preserved |
| Free, 79,999 original messages, then restart and continuation to 81,003 | Passed; later warm continuation recovered automatically from empty output/provider rejection |
| First two-hour-target run | Failed at 234,179 messages after 33 successful restarts over 43m55s; required checkpoint was absent from the outgoing projection |
| Exact first failure replay after literal-source retrieval repair | Passed in 61.364s |
| Second two-hour-target run | Failed at 258,282 messages after 23 successful restarts over 29m23s; the correct excerpt was present, but the model selected an older checkpoint |
| Exact second failure replay after record-authority wording repair | Passed in 65.605s; this does not replace the failed endurance result |
| Ten-round follow-up with 5,000 new messages per round | Stopped in round 2 at 273,296 messages with a wrong checkpoint ID; correct original reached a fresh Codex thread. Round 1 at 268,293 passed without resummarizing archived originals |
| Five recall holdouts | Four passed: temporal destination, receipt, restriction and abstention; exact original-message-ID lookup failed |
| Exact message-ID replay after identity lookup repair | Passed in 48.246s |
| Real 7680 x 4320 image through Chat UI on Free | Correct code after native crop read; no user Retry |
| Earlier simulated 2,048-token image cases | Correct text, but 2,623 and 2,375 reported tokens exceeded the advertised window; failures retained |
| Later simulated 2,048-token crop continuation | Passed: correct text, 1,587 prompt + 9 output = 1,596 tokens; empty response recovered automatically |
| Image suite requiring an autonomous crop | One later tiny-window case read the overview correctly but skipped the required crop; this suite remains failed |
| Chat UI with 212,070 messages | Bounded initial 250-message page and responsive composer |

The tiny-window case advertises 2,048 tokens to FLUJO while using the real Free
router. It does not establish support for a native 2K vision model. The successful
crop continuation replays the exact saved read-only crop call through the production
tool executor; it does not establish that every model will choose the crop itself.
Native clipboard paste remains unqualified; browser file selection was exercised.

The repairs preserve the 50,000-token default compaction reserve, adapting it only
when it cannot fit the selected window. Persisted bounded range summaries compose
into parent summaries and retain immutable original-source links. New turns reuse
verified prefixes. Exact-source text/message-ID search and bounded literal retrieval
supplement lossy summaries. Images retain durable originals, bounded overviews and
native crop access. Empty reasoning-exhausted Free replies retry on the same route
with reasoning disabled for that recovery attempt. Partial visible output or tool
execution still prevents unsafe replay.

Operational bounds and factual accuracy are distinct acceptance criteria. These
changes remove reproduced context/archive failures, but neither two-hour run nor
the later ten-round regression passed its semantic checks. Canonical JSON loading remains linear in history size, selection
of old user instructions remains model-dependent, and three invalid summaries can
still leave an oversized canonical projection for the existing refit/refusal path.
No every-provider, native-paste or flawless multi-hour claim is made.

The approach follows immutable source storage and hierarchical summaries described
in [LCM](https://papers.voltropy.com/LCM), while retaining separate retrieval and
answering checks as motivated by [LongMemEval](https://arxiv.org/abs/2410.10813).
Those papers do not prove FLUJO superior or make model recall deterministic.
The [Free router documentation](https://openrouter.ai/docs/guides/routing/model-variants/free)
informs the model-routing restriction; paid fallback arrays were not configured.

## Reproduction

The opt-in [live harness](../../scripts/context-scale-acceptance.mjs) requires an
existing `gpt-6-luna` Codex subscription connection and an `openrouter/free`
connection without fallback policies. It never substitutes a paid route. Set
`FLUJO_CONTEXT_SCALE_ACCEPTANCE=1`, `FLUJO_CONTEXT_SCALE_SOURCE_ROOT` to that
installation, and `FLUJO_CONTEXT_SCALE_ROOT` to a private absolute output directory
outside the installation and checkout. After a non-container application build,
run `node scripts/context-scale-acceptance.mjs long` or `free-long`; use `regions`
for real 8K images, or `resume <profile-path> 5000 checkpoints` for an appended
history/restart check. `FLUJO_ACCEPTANCE_DIST_DIR` can select another `.next-*`
build in the checkout. Run through the approved local tool runner and clean
disposable credentials/profiles through that runner after collecting evidence.

An early 5,000-message regression attempt answered correctly but failed a harness
shortcut that allowed fewer than three large inference calls. The original guard
was calibrated to 1,000-message appends and did not prove leaf reuse. The corrected
guard observes internal summary source IDs and rejects any previously archived
original being resummarized; answer assertions remain unchanged.

## Integrated local verification

The follow-up was applied to `a1382763` (main with #1262, #1263 and #1264).
All 601 focused tests in 27 suites passed, including the affected context/archive,
image, adapter, workspace, MCP-import and scheduler paths. Typecheck, source lint
and the inspected non-container application build passed. The combined command
took 822.704 seconds; the focused tests took 208.820 seconds within that interval.
Build ID: `boanr-KR-ZBU4IDEbOyp8`. Runtime context/model/resource source is identical
to the source used for the latest live replays and failed follow-up regression.
The portable harness passed syntax and real configured-model loading checks.
No remote CI, container build, release or paid model fallback ran.
