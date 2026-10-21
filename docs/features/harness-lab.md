# Harness Lab — experimental

Harness Lab evolves **plain-text agent instructions** around one fixed model connection. It is off by default and does not change existing agents automatically. Open **Settings → Experimental → Enable Harness Lab**, then **More → Harness Lab** (`/harness`). The general experimental-navigation setting controls whether More shows the entry; the separate Harness Lab flag controls dispatch and agent creation on the server.

## Use it

1. Choose a connection, name the experiment and specify its domain. Paste instructions or import the instructions from one saved agent step. Importing a step does not import its tools, model-level prompt, start prompt, memory or graph.
2. Provide at least two training inputs and two new held-out inputs. For each, enter required phrases and optional forbidden phrases, one per line. Checks are Unicode-normalized, case-insensitive substring checks. Use cases with meaningful variation and review their independence yourself.
3. Choose one to three refinement rounds. The screen shows the maximum number of completion invocations before starting. Each invocation consumes the selected connection's allowance or billing. There is no automatic model upgrade or fallback.
4. Run the experiment. Each advance performs at most one model completion and saves its result. Pause after the current step, continue a saved experiment, or cancel it. An uncertain interrupted request is counted and never automatically replayed.
5. Compare the original, general, domain-specific and composed prompts and their exact probe outputs. Inspect required-check coverage, forbidden-output checks, prompt length, reported tokens and measured time.
6. If the predeclared gate passes, review the result and select **Create evolved agent**. This creates a separate text-only Start → Agent → Finish flow. The original remains available for rollback by choosing it again. The new flow has no attached tools or resources and uses the selected prompt, fixed connection, latest-message input, one agentic turn and a 4,096-token request limit. It excludes inherited model, start and workflow prompts. Further user edits are ordinary flow edits and are outside the experiment's evidence.

The evidence download includes inputs and model outputs. Treat it as workspace data. Avoid putting secrets into examples. The selected provider receives proposal context, the current probe input or reflection context as appropriate. No background learning runs after the page stops advancing an experiment.

## Algorithm and evidence

For each round, generate and probe a general-purpose revision and a domain-specific revision of the current training-selected parent. Compose their supported changes and probe the composition separately. Later rounds use the best eligible earlier candidate. The archive retains every candidate, including rejected trade-offs.

Selection maintains a Pareto frontier over three distinct measures: required-check coverage (maximize), absence of forbidden phrases (maximize), and instruction characters (minimize). The last is an explicit **size proxy**, not a monetary-cost or latency estimate. Candidates must preserve each baseline training case's required-check score and pass all configured forbidden-output checks. Among eligible frontier members, selection maximizes the worse of the two check scores, then their sum, then minimizes prompt length. Exact ties keep the earlier candidate. Latency and tokens are reported separately and do not decide promotion.

The selected identity is fixed before running any held-out probe. Only the original and that one candidate run on held-out inputs. Creation requires a strict training gain in a measured objective, complete held-out results, no per-example required-check regression on either split, and no forbidden-output violation. If this fails, the result stays inspectable and no alternative candidate is selected using the held-out results.

Held-out inputs must be fresh across this workspace's experiment records. Case/whitespace-normalized duplicates across splits and prior experiments are rejected. This detects exact leakage; it cannot detect paraphrases, shared latent tasks, contamination in model pretraining, or a user manually tuning against earlier held-out results. Two examples are a usability minimum, not a statistically sufficient sample size. Repeated executions of a single task do not create independent tasks.

After a qualifying comparison, reflection extracts a short lesson from **training evidence only**. Once the user creates the evolved agent, future experiments may retrieve up to five recent lessons from the same domain and unchanged model configuration. Lessons are labeled hypotheses and supplied as evidence to the proposer. They are not injected as instructions into probes or ordinary chat. Turning off lesson reuse creates a memory ablation. No held-out input, criterion or output enters proposal, composition or reflection prompts.

| Evidence claim from the survey | What this feature records | Limit |
| --- | --- | --- |
| Selection | All candidates, fixed training-only selection, retained frontier and one frozen selected ID | Search scores are selected estimates, not unbiased gains |
| Activation | SHA-256 of each candidate's actual probe system-prompt input; exact prompt and experiment ID on the created flow | Creating a flow does not establish that it subsequently ran; provider-native wrappers may add fixed context |
| Attribution | Same model configuration fingerprint, same examples and runner settings; original retained | Provider nondeterminism, time-dependent service behavior and hidden model revisions remain |
| Improvement | Baseline versus selected candidate on fresh held-out inputs, per-example gates and retained outputs | These checks do not establish general ability, factual accuracy, security or statistical significance |

No forbidden phrases means no such criterion was supplied for that example. A 100% score means only that the supplied text checks passed. Correctness and security require suitable independent evaluators and release acceptance work; neither is inferred from this UI.

## Runtime boundaries

- All endpoints use FLUJO's workspace/owner route wrapper and encryption lock gate. Persistence uses the existing workspace collection store, with cross-process runtime locks for creation and each experiment's mutations.
- Records are in `workspaces/<workspace>/db/harness-experiments/`. No credentials are saved in them. Model configuration hashes are opaque; key values are never returned. Invalid history records fail closed during held-out admission.
- Provider requests use existing adapters. Supported connections are keyless Codex subscription Luna/Terra/Sol, or explicit approved OpenRouter text models (free models, DeepSeek, GPT Luna or Claude Haiku). Astra, Sonnet, Opus and Argon are excluded. Sol/Terra have no API route. Opaque routers, fallback policies, owner-bound model-step transports and media routes are excluded. `openrouter/free` cannot guarantee a fixed model, so use an explicit permitted `:free` ID instead.
- Codex requires a detected ChatGPT login and the managed app-server path; API keys and custom base URLs are rejected. The text-only request supplies the existing restricted capability configuration and forces ChatGPT authentication at startup. It supplies no MCP server, tool executor or reusable session. This source boundary is not a new operating-system isolation certification.
- OpenRouter uses the existing bounded, cancellable read-only assessment path. The response's model identity must match the selected ID (ignoring only the `:free` suffix). A different returned model stops the experiment. Named models must be available through the selected account; the list is not an entitlement guarantee.
- Each completion has a three-minute deadline, a 4,096-token request limit and a 32,000-character response guard. Codex runtime enforcement of output tokens can differ from request/response adapters; cancellation and output-size guards remain. Proposal context includes at most 3,000 characters of each training output, marked when truncated; complete probe output remains in the record.
- Maximum completion invocations are `T + R × (3 + 3T) + 2H + 1`, with `T` training examples, `H` held-out examples and `R` rounds. It may use fewer when the baseline wins or no lesson is needed. SDK/service-internal network attempts are not counted as separate completion invocations. Unknown usage, including incomplete requests, is not recorded as zero cost.
- Dispatch is checkpointed before calling the model. If that checkpoint survives without a result, continuing fails closed rather than resubmitting. Failure retains completed evidence. Pause stops after the current request; leaving the page may abort it. Creating the evolved flow reserves its ID before saving, so retrying does not create duplicates or overwrite later human edits.
- FLUJO variable/tool/resource/entity bindings are rejected in original and proposed instructions. Proposals cannot edit tools, evaluation criteria, model selection, auth, budgets, code, permissions or runtime settings. Document and model content is evidence, not authorization.

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

Development uses local typecheck and lint. The regression sources in `__tests__/harness/` cover split contamination, model routing, candidate selection, per-case regressions, interruption accounting and idempotent promotion. Their execution, browser acceptance, live subscription inference and wider suites are deferred to release pre-flight under the repository's validation cadence.

Release acceptance must exercise the visible path from enabling the experiment through probes, pause/continue, a deliberately rejected candidate and creation/chat use of an accepted candidate. Use an approved subscription model first and verify actual authentication and usage. Compare the created flow's executed prompt with the recorded hash. Include phone layout, reload/interruption, workspace switching, disabled dispatch, changed model configuration and malformed upstream output. Do not claim an empirical FLUJO improvement until those results are recorded.
