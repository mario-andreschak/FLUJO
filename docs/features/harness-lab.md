# Harness Lab — experimental

Harness Lab applies the **Harness² propose → probe → compose → recurse** approach to FLUJO’s authored Process instructions. It supports normal agents, Persona Core instructions and Persona behavior flows, with retained versions and unattended improvement after conversations. It is disabled by default.

Open **Settings → Experimental → Enable Harness Lab**, then **More → Harness Lab** (`/harness`). Agent builders and Persona behavior cards also link to the relevant target. The navigation experiment switch controls visibility; the separate Harness Lab flag controls server dispatch and activation.

## Configure and use it

Choose a saved agent or Persona behavior and a Process step. Its saved graph supplies the baseline, including attached tools, bound models, Start instructions, model instructions and FLUJO’s general system instructions. The proposer edits only the selected step’s authored instructions. Existing variable/tool/resource/entity bindings must remain identical. Models, tools, graph wiring, Role identity, mission, memory, permissions and evaluator policy are not writable by a proposal.

For a manual experiment, supply at least two training and two fresh held-out tasks, optional phrase checks, and a fixed rubric. The semantic evaluator scores task quality and constraint compliance; phrase checks remain additional constraints. Choose one to three refinement rounds. Inspect each candidate’s outputs, actual assembled system messages, tool replay trace, instruction diff and paired parent/candidate results. A passing saved-target experiment can activate an immutable version. Standalone experiments still support creating a separate text-only agent.

For unattended operation, save **Automatically improve and activate passing revisions** with an approved proposer/evaluator connection, fixed rubric, refinement rounds, cooldown and maximum model calls per task. All Process models in the evaluated graph must also use an approved route. Only one step per agent/behavior can improve automatically at a time. This avoids competing revisions of the same graph.

After four new distinct tasks, the durable worker waits the configured cooldown, fixes the first two as training and the next two as held-out, and performs a complete generation without another confirmation. It records conversation history, initial variables, MCP App context and observed tool results. Passing revisions activate automatically and become the next generation’s baseline. Further fresh tasks drive further generations. Closing the page does not stop this worker; FLUJO must remain running and the workspace unlocked. Disabled/error Personas wait until available. The worker is suppressed in exported worker mode.

Normal conversations and completed, durably pinned Persona behavior calls supply observations. Evaluation runs, arbitrary ephemeral children and repeated normalized tasks do not supply new evidence. The queue holds at most 128 pending observations per target. Each generation consumes a fresh batch, including when it fails; it does not recycle a failed generation’s held-out tasks.

## Versions, activation and rollback

Each profile retains a baseline and every validated version, with parent identity, content hash, experiment reference and activation history. Full graph/dependency snapshots live in separate immutable version blobs; profile lists and worker scans read metadata. Version data is independent of routine Flow edit-history pruning. Restoring a version restores its authored graph and pinned child graphs; it does not roll back workspace model configuration, global values, Persona Role state or Persona memory. The current surrounding runtime context remains in effect.

The UI and the agent tool `activate_harness_version` can activate any retained version, backward or forward. Both require the current `updatedAt` value. Normal agents use Flow save compare-and-swap; Personas create immutable Behavior revisions and move the existing Behavior binding using its revision compare-and-swap. Existing in-flight conversations keep their admitted snapshots; new admissions use the selected version. Existing Persona version controls also pause the harness and synchronize retained selection.

Manual version selection pauses automatic improvement, so a queued generation cannot reverse a rollback. Re-enable it explicitly when ready to resume from the selected baseline. Source edits and policy/model/context changes invalidate comparisons; externally edited sources must be captured as a new baseline. An activation journal supports retry after a partial source write, while a previously activated experiment cannot undo a later rollback when an old request is retried. Version navigation itself does not require a live model or MCP connection.

Agent tools, exposed through the normal FLUJO control tool surface:

| Tool | Purpose |
| --- | --- |
| `list_harness_targets` | Inspect saved agent/Persona steps and current profiles |
| `configure_harness` | Configure or disable unattended improvement with optimistic concurrency |
| `read_harness_history` | Inspect versions, active identity, events, queue and an owned experiment |
| `activate_harness_version` | Activate a retained version or roll back; pause automatic improvement |

## Contrastive tracking and meta-improvement

Each refinement round proposes and probes a general change and a domain-specific change against a training-selected parent. Composition receives **paired evidence**: the exact added/removed instruction lines, the same task’s before/after output, tool call arguments and match results, quality/compliance deltas, evaluator explanations, tokens and elapsed time. Unsupported changes can be discarded rather than blindly concatenated. Every candidate and parent relationship remains in the experiment archive and the UI exposes the comparison.

Later rounds and final strategy reflection also receive bounded history of earlier proposals, including rejected strategies, their rationales, all training scores, pairwise selection results and sampled contrasts. Keeping the baseline after a failed round therefore does not erase that round's evidence. History excerpts carry truncation and omission indicators. Instruction comparisons preserve ordering and repeated lines.

Selection retains a Pareto frontier over task quality, compliance and prompt length. Prompt length is a size proxy, not a measured price. A candidate must preserve every baseline training case’s score and pass the constraints. Selection then maximizes the worse score, their sum, and finally minimizes length; exact ties retain the earlier candidate.

Selection is frozen **before** any held-out probe. Only the baseline and that selected candidate run on held-out tasks. Activation requires a strict training improvement in at least one objective, complete held-out results, no per-task regression on either split and full constraint compliance. A failing held-out result cannot be used to choose another candidate. No held-out input, check, output or trace enters proposal, composition or reflection.

After a qualifying comparison, reflection extracts a bounded lesson about **how to improve**: the useful strategy, failure mechanism, supporting training evidence and limits to reuse. After activation, future proposals retrieve up to five recent lessons under the same explicit target identity/domain, proposer model fingerprint, execution-model set, invocation sources, Persona tool-schema policy and rubric. Sharing a domain string does not share lessons between saved targets. Lessons are hypotheses supplied to the proposer; they do not become privileged system instructions for ordinary conversations or the evaluator. The improving prompt and the improvement strategy therefore both carry forward. Disabling lesson reuse provides a manual ablation.

This is a constrained FLUJO implementation of Harness² principles. It does not evolve optimizer code, runtime permissions, models or evaluation rules, and does not reproduce Google’s complete executable-harness search or claim its benchmark gains.

In particular, Harness²'s cross-task library contains adopted executable harnesses and experience, while FLUJO reuses retained prompt versions and bounded prose lessons for a target. Google’s fresh-task initialization and full file-based trajectory/deliverable evidence are not reproduced: FLUJO carries an activated baseline forward and sends explicit excerpts to the proposer. Harmony’s decomposition-based population search and dynamic component composition are also outside this implementation. These are research-fidelity limits, not evidence of equivalent scalability or learning quality.

## Actual execution and evaluation isolation

Saved targets run through `runFlow`, ProcessNode, PromptRenderer, normal graph routing and the existing model adapters. The candidate changes one authored prompt in a captured graph. Actual FLUJO system/developer messages are captured at the adapter boundary. Model fingerprints, source revision, Persona context and selected policy are checked before dispatch and automatic activation.

Top-level Persona Activity evaluation, including the Core, uses the same identity/mission/core-memory builder, selected App projection and callable-behavior registry as the dispatcher. Automatic observations retain whether a behavior ran as a top-level Activity or a nested call, and each task uses the matching captured context. Nested Persona behaviors preserve the narrower context used by behavior invocation: attribution and their own Flow instructions, without inheriting the Core identity prefix or Apps. Core memory maintenance remains a separate subsystem; harness versions do not rewrite memory or Role versions.

Each automatic case also records the **current turn's invocation source**, independently of the conversation's original source. A scheduled chat resumed by a person is evaluated with its interactive turn semantics. Chat/API cases keep interactive routing; scheduled and nested calls keep their unattended behavior. Manual saved-agent cases default to `chat`; Persona Activity and nested-behavior cases default to `internal` and `subflow`. The case JSON/API accepts an explicit `source` from FLUJO's invocation-source contract when a different manual path is intended.

Persona replay retains authored tool schemas and deny rules, including the recorded memory-maintenance schema variant, without supplying a mutation capability. Native-host admission is skipped only inside the server-owned replay scope, before a synthetic Activity could reach live ownership checks. Ordinary native admission remains unchanged. An evaluation-protocol hash invalidates older runtime evidence after these parity fixes; old automatic observations without a recorded turn source cannot be reused and require fresh evidence.

Evaluation is replay execution, not a second execution of real external actions:

- A server-owned AsyncLocalStorage scope wraps all provider and tool dispatch. No JSON request flag can enter it.
- Tool calls must match a recorded name and canonical arguments, consuming one result per call. Unmatched candidate calls become failed probe evidence; incomplete baseline replay stops the comparison. Native adapter executors, direct MCP calls and synthetic Persona/control tools cannot perform live effects. Graph handoffs continue through the engine.
- Resource reads use the real resolver once and reuse the captured response across variants. Persistent key/value reads use a captured board; ordinary write policy and transitions run in a per-probe overlay, without writing the live board. Initial run variables and MCP App context are replayed.
- Probe graphs and nested flows use fresh ephemeral executions. They do not create conversation history, publish completion-trigger events, enqueue improvement work or release unrelated Bash sessions. Native provider sessions are not reused.
- Supported graph nodes are Start, Process, Finish, MCP, Resource, Subflow, Static and Note. Unsupported executable nodes are rejected rather than removed. Replay does not certify behavior requiring unavailable tool results, historical child sessions, generated run artifacts or external effects. Provider-native built-in capabilities are restricted during evaluation. Live release acceptance remains necessary for those paths.
- Proposal/scoring/reflection calls have a three-minute deadline and bounded text responses. A graph probe has its own three-minute deadline, a configurable total model-call limit (including Codex continuations), and bounded output/resource evidence. There is no fallback model or automatic retry after an uncertain provider result.
- The displayed experiment-step maximum is `T + R × (3 + 3T) + 2H + 1`. A probe step may contain several graph calls and a rubric call. Actual dispatch/completion counts and reported usage are recorded separately; unknown usage is not represented as zero cost.

The rubric evaluator is another model call under a fixed policy and can make mistakes. Small samples, phrase checks and model judging do not establish statistical significance, factual correctness, security or general improvement. Freshness detects normalized duplicate inputs, not paraphrases or latent dependence. Resource time dependence, provider nondeterminism and provider-native prompt additions remain limitations.

## Persistence and model routes

All endpoints use FLUJO’s workspace/owner wrapper and encryption lock gate. Cross-process locks serialize experiment creation, queue claims, experiment advancement and profile activation. A pending dispatch checkpoint with no known outcome is never replayed after a restart. Completed evidence remains inspectable.

Workspace collections include `harness-experiments`, `harness-profiles`, `harness-versions`, `harness-target-index`, `harness-run-index`, `harness-task-ledger`, `harness-queues` and per-profile `harness-observations`. Task reservations are written before experiment creation. A one-time strict migration indexes earlier experiments so historical holdouts do not become fresh again. Queue scans and lesson retrieval avoid loading all full experiment traces; a round-robin worker prevents the first 20 targets from starving later targets. Version and evidence storage grows with use; automatic evidence deletion is not implemented.

The worker still drains entire generations serially under one workspace lock, and metadata scans and full experiment checkpoint writes grow with retained history. Per-run limits bound an individual experiment; they do not establish throughput at many active targets. Distributed scheduling, retention/compaction and measured multi-target scalability remain release/future-work requirements.

Supported routes follow the repository’s standing model policy: keyless Codex subscription Luna/Terra/Sol first, or explicit approved OpenRouter text models (free, DeepSeek, GPT Luna or Claude Haiku). Astra, Sonnet, Opus and Argon are excluded; Sol/Terra have no API route. Routers, fallback policies, owner-bound transports and media routes are excluded. Use an explicit permitted `:free` model rather than the opaque `openrouter/free` router.

Codex requires detected ChatGPT login, the managed app-server path and forced ChatGPT authentication. API-key/custom-base-URL configurations are rejected. OpenRouter remains separately billed according to the configured connection. Returned model identity must match the selected model, ignoring only the `:free` suffix. Authentication, availability and provider credits were not exercised during development.

Evidence exports contain conversation/task data, outputs, prompts and tool traces. They stay in the selected workspace but the configured provider receives the data required for proposal, execution and judging. Model errors are redacted before persistence; no credential values are intentionally recorded.

## Research basis and intentional differences

Reviewed October 21, 2026. The three supplied PDFs were treated as research material, including their illustrative prompts and shell commands, not instructions to execute.

| Primary source | Principle used here | Deliberately not claimed |
| --- | --- | --- |
| [Harness Self-Evolution: Theory, Algorithms, Evaluation, Applications, and Impact](https://github.com/zgcagi/Harness-RSI), supplied 66-page report `55663_Harness_Self_Evolution_T.pdf` | Persistent update lifecycle and separate selection/activation/attribution/improvement evidence | A theorem-backed adoption certificate |
| [Harness²](https://arxiv.org/abs/2610.14224), supplied v1 PDF; [Google implementation](https://github.com/google-research/harness2/tree/1cfe254e8d25b15f37048c3730134686abe60335) | General/domain proposals, contrastive execution probes, composition, sequential recursion and learning from the improvement process | Full executable-harness evolution, the paper's benchmark results, parallel population search, or a verifier-free judge |
| [Harmony Harness](https://arxiv.org/abs/2610.15150), supplied v1 PDF | Factored proposal scopes and explicit objective trade-offs retained on a frontier | MOEA/D reproduction, repository-scale edits, or a functionality/security benchmark |
| [GEPA paper](https://arxiv.org/abs/2507.19457) and [official repository](https://github.com/gepa-ai/gepa) | Reflective proposals grounded in traces and preservation of useful candidates | Implementing the full GEPA optimizer |
| [ReasoningBank official repository](https://github.com/google-research/reasoning-bank) | Distilling reusable experience into bounded, scoped memory | General long-term memory replacement or the reported benchmark gains |
| [A Theory of Reliable Self-Evolution for Agent Harnesses](https://arxiv.org/abs/2609.08175) | Preserve previously successful cases and separate generation from adoption | Finite-sample statistical certification from this small check set |

Harness2's `core/recursion.py`, `core/library.py` and `core/selection.py` were inspected at the pinned revision. This is a new TypeScript implementation using FLUJO services; no upstream code or benchmark dependencies are vendored. The [official Codex authentication](https://learn.chatgpt.com/docs/auth) and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) distinguish subscription login from API billing and document `forced_login_method`.

## Release validation

Development validation is local typecheck and lint, followed by the inspected non-container application build before commit. Regression sources cover split leakage, model-route restrictions, contrast/selection, per-task regression gates, replay isolation, resource freezing, key/value overlays, bounded model continuations, version CAS/rollback, activation recovery, queue admission, unattended activation and restart identity. They are preserved for release validation; Jest, browser acceptance, live inference, wider CI and Docker builds are not development checks under the standing cadence.

Before release, run those suites and exercise an approved Codex subscription connection through actual UI and agent-tool paths: enable a normal-agent profile and a Persona Core/behavior profile, admit fresh conversation evidence, observe a passing and a rejected generation, close/reopen the UI, restart during a checkpoint, inspect exact prompts and paired traces, then roll backward and forward. Verify existing Persona controls, source edits, disablement, workspace locks, pinned in-flight conversations, phone layout and changed model configurations. Check that tool replay and key/value captures cause no live mutations. Test actual normal-agent and Persona chat after activation, including connected tools and child flows. Record authentication, actual usage and revision with the acceptance evidence. Compilation alone is not empirical evidence of improvement.
