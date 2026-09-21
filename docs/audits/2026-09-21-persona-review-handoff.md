# Persona implementation review — 2026-09-21

## Delivery correction

The previous handoff stopped at local verification. That did not complete delivery. The implementation is now committed, pushed and merged in [PR #522](https://github.com/mario-andreschak/FLUJO/pull/522), with the browser History selector corrected in merged [PR #523](https://github.com/mario-andreschak/FLUJO/pull/523). Both merged revisions passed full CI. The original 30 unrelated staged outreach/research paths remain excluded and preserved. Historical local evidence below retains its original provenance.

### Release verification findings and correction

The full runtime run on `b50ec2cfd908c8430bf2a40a77b6f90b1ddacd47` passed 560 Activities and all 13 criteria; the matching 50k recall p95 was 81.5028 ms. A repeat on `4c79a7d4009d875eb03d1afa6d5fe8bd5951fb7d`, whose application source was unchanged, failed the resident-memory growth bound: 361,476,096 bytes against 268,435,456. The failed report remains retained, and #489/#448 were reopened. This variability must be resolved before numeric acceptance is closed again.

On `4c79a7d4`, all nine ordered browser steps covering the ten-step product journey passed without retry or skip. Independent semantic/source validation passed, but the downloaded archive lacked the hidden Playwright state file listed in its checksum manifest. [PR #524](https://github.com/mario-andreschak/FLUJO/pull/524) includes hidden files from the three bounded evidence directories and adds checksum/semantic verification of the downloaded artifact to the workflow itself.

Allocation profiling before Jest teardown identified heavy filesystem/promise allocation. Storage statistics started one read per retained record without a concurrency limit; the regression fixture reproduced 1,200 simultaneous reads. PR #524 bounds these reads to 32 per record kind, preserves full counts and legacy/shard identity checks, and rejects missing records even in the final batch. Workspace setup now creates only missing directories while revalidating every boundary/subtree on every call. Tests verify both recreation and rejection of a replacement junction; no success cache or relaxed path checks were introduced.

The changes pass 45 focused tests, 15 process-boundary tests, all 26 workspace suites / 158 tests (overlapping selections), typecheck and changed-file lint. Diagnostic profiling is explicitly non-authoritative: cumulative allocation samples are not live memory, and an instrumented pass cannot close acceptance. The workload, RSS limits, assertion set and retry policy remain unchanged. Final selected-commit CI, unprofiled runtime/recall runs and published browser archive validation are tracked in the [current acceptance record](https://github.com/mario-andreschak/FLUJO/issues/489#issuecomment-5757260619).

The controlled diagnostic comparison used the same 560-Activity workload, learning/fault matrix and Node 22.23.2. Before the fix ([run 35609387134](https://github.com/mario-andreschak/FLUJO/actions/runs/35609387134)), peak RSS was 680,710,144 bytes and growth was 181,940,224. After the fix ([run 35611160170](https://github.com/mario-andreschak/FLUJO/actions/runs/35611160170)), peak RSS was 499,027,968 bytes and growth was 85,127,168; all 13 runtime criteria passed. Cumulative sampled allocation fell from 32.14 GB to 31.25 GB. These are single instrumented samples on hosted runners, not proof that the intermittent failure is eliminated; unprofiled exact-release verification remains necessary.

The sections below are historical checkpoints. Their pending-publication statements do not describe current Git state. Remaining native accessibility, locale, recovery-upload and real-world autonomy limitations are still explicit; successful infrastructure tests do not supply those observations.

### Earlier delivery verification checkpoints

- The PR's complete isolated stage passed all nine suites / 103 tests, including the two browser-driving suites excluded from the earlier local selection. Typecheck, lint, cross-platform release safety, all installer checks and the offline goal lifecycle also passed. The main suite was still running when this update was written.
- A production API fixture with 100 Personas and 50 Memories each exposed a gallery summary defect: the route opened private Memory payloads merely to count them. Thirty warm requests measured p95 1,547.6203 ms. The fix reads current index metadata once, preserves workspace/Persona filtering and reflects Memory status changes. A regression test checks that private payload files are not opened.
- The same fixture and unchanged predeclared budgets passed on rebuilt production build `aHP3sAgh4drEZEgN5Sqhq`: gallery p95 185.4008 ms / 44,137 bytes; detail p95 219.4681 ms / 47,566 bytes. Both latency budgets are 250 ms; payload budgets are 512 KiB and 256 KiB. These measurements cover HTTP response transfer and JSON parsing, not rendering or cold startup. The baseline and after reports are retained in `.tmp/persona-delivery-20260921/`.
- The fix passed 22 focused tests, full typecheck, changed-file lint and a production build. Browser journey selectors now wait for the visible Persona target before typing and match filter labels that include their current selected value; the complete release browser run remains pending.
- The manual soak workflow is enabled again. Selected-release soak, 50k recall and browser artifacts must still be generated and independently validated before their acceptance criteria are closed.
- The 100-Persona browser check also found a pagination defect: cursor comparison used code-unit ordering while stored records used `localeCompare`, repeating pages after 72 distinct Personas. Aligning those comparisons passed two regressions (including a removed boundary record), the existing gallery/isolation tests, typecheck, lint and rebuilt production build `yCsUoH1z5csvbsX_L5ULD`. CUA then reached 24/48/72/96/100 cards, all unique with 50 Memories each, and no remaining Load more control or browser warning/error. Read-only API traversal independently returned pages of 24/24/24/24/4 with zero duplicates; the owned server stopped with zero model/App fixture events.
- PR CI on `a713629f7d0de5337848b791fc1bd16432260a00` executed 806 suites / 7,269 tests with zero assertion failures, including the complete 20,000-event scaling test. The baseline guard correctly rejected a Windows-only delayed-child-close test skipped on Linux. The test now exercises either mocked Windows tree termination or mocked POSIX signals while retaining the delayed-close assertions; no baseline or quarantine exemption was added. The failed CI report is retained.

The intended product is a persistent, editable AI teammate: choose a Role, configure its ordinary Core/Behavior Flows and Apps, give it an objective, and let it maintain work and Memory, verify results, recover after interruption and obey owner controls. A Role supplies instructions; it does not supply accounts or tools. The requirements come from #505, #489 and the 45-issue inventory in the [full audit](2026-09-19-persona-audit.md).

## What the local work delivers

| Area | Result to review | Main entry points |
| --- | --- | --- |
| Creation and first use | Validate generated Core/required Behaviors before creation; preserve blocked drafts; expose model setup/retry and the next goal action | `PersonaCreationWizard.tsx`, `factory.ts`, `/v1/personas/readiness` |
| Editable composition | Repair Core/editor navigation, add/copy specialist Behaviors, and preserve Activity bindings to the content they started with | `PersonaFlowsArea.tsx`, `personaComposition.ts`, `personaOwnedFlows.ts`, `behaviorCallPins.ts` |
| Everyday use | Persona chat attribution/search, clear History outcomes, saved Task conflict recovery, retained dialog drafts and deterministic keyboard focus | `ChatHistory.tsx`, `PersonaMemoryArea.tsx`, `workItems.ts`, `personaPresentation.ts` |
| First-use accessibility and language | Seven-language copy, responsive controls, named panels, contextual status announcements, focus/history repair and accurate chat loading | Persona/Role components, catalogs, `PersonaStatusUpdates.tsx`, `muiTheme.ts` |
| Recovery and privacy | Integrity-checked Persona ZIP restored into a new frozen workspace; erase owned Flow/history/private payloads with writer fencing | `/api/persona-recovery`, `personaRecovery*.ts`, `personaDeletion.ts` |
| Runtime and Memory | Bounded detailed state, full-candidate 50k recall, cross-process ownership fixes, reliable migration reporting and measured recovery/rollback evidence | enduring-agent services, `workspaceMutationGate.ts`, `migration.ts` |
| Acceptance tooling | Source/run/build checks, full-journey report validation, controlled genuine-model evidence and independent artifact validators | `scripts/persona-*`, `scripts/validate-persona-*`, Persona workflows and `e2e/personas` |

The filenames above are review entry points, not an exhaustive change list. The local review package contains `changes/manifest.json` and a complete `changes/integration.patch` for its selected code/test/tooling/documentation paths.

## Change ownership and reconstruction

The starting checkout already contained staged and unstaged shared Flow, subflow, model and chat work. There is no trustworthy complete pre-task snapshot from which to extract only this task's authorship. The integration patch therefore records the tested combined changes in its listed paths against `cb891f54792dd59aa807a8f95ea3cab7da0315c6`. It includes pre-existing shared changes. It is not a Persona-only cherry-pick or a release-approved commit.

The original index is unchanged. Patch construction and reconstruction checks use separate temporary Git indexes. The manifest records each included path, its original index/worktree status, current raw SHA-256 and normalized Git blob identity. Changes in outreach/research material, runtime data, local secrets and unrelated local artifacts are outside the package. The source manifest identifies all application/MCP files against the v38 production build `HvXnyyZz09I8nHxDiHPK9`.

Review the manifest before applying the patch in an isolated checkout of the recorded base. Shared-file changes need joint review with the existing work. Do not apply the integration patch back onto this already-modified checkout. No commit, push, workflow dispatch or deployment is implied by packaging it.

## Verification evidence

| Checkpoint | Measured result | Scope |
| --- | --- | --- |
| V38 standard main selection | 807 suites / 7,274 tests passed; unchanged published baseline passed | Windows local combined working tree; six existing intentional skipped assertions |
| V38 build and static checks | Production build, full typecheck, lint and 201-route inventory passed | All five MCP packages and 116 application pages |
| V39 isolated selection | Seven suites / 95 tests passed | Two browser-driving suites excluded under the session's CUA-only restriction; not the complete isolated stage |
| V39 wizard | Eight interactions, including notice dismissal; saved ready Persona with owned Core/required Behaviors and both suggested Apps | Role/model/Apps already configured; no Activities or model/App calls |
| V44 complete local functional journey | Role and Persona creation, App choices, owned Behavior execution, Memory correction/Forget, queued Task across a real restart, filtered History, fingerprint-matched configuration download and isolation; 17 independent checks passed | CUA on the matching v38 build; deterministic model/Apps preconfigured; no recovery upload/reconnection or standalone release CI claim |
| V43 complete current-source runtime infrastructure checkpoint | 560/560 Activities, all 13 criteria, fault recovery and learning rollback passed; maximum daily append p95 77.5682 ms | Three suites / 24 tests, 608.554 seconds; infrastructure mode, authoritative=false; earlier V5 record retained |
| V43 full current-source 50k recall | 20 searches considered all 50,000 candidates each; p95 93.0949 ms, maximum 96.7809 ms | Benchmark passed in 97.274 seconds; commit unreported and source snapshot retained; earlier 94.9127 ms checkpoint retained |
| Corrected default-Role endurance | 70 minutes, 13 autonomous rounds, three process epochs, one reconciled controlled effect, no unscheduled intervention | Genuine model with production Role factory; output quality not evaluated and no public-world reliability claim |

The package retains raw reports and their source identities. Its `verification.json` records independently checked results from the copied artifacts. Earlier failures remain in the full audit and selected failure reports; a later pass does not erase them. Packaging or checksum success is not a new product test pass.

## First-time user assessment

The owner can create a Role, retain a Persona draft when a model is missing, configure the model, retry readiness and create the Persona. The Overview offers an explicit goal action. The configured wizard path meets the under-ten-interaction target; configuring the prerequisites is additional work. V44 now exercises the connected first-use functional path from Role creation through Memory, actual selected-Behavior/App execution, a queued Task surviving an OS-process restart, History and a configuration download. Deletion was previewed and cancelled, not performed.

The remaining comprehension risk is the distinction between Role instructions, model execution, App access, a mission description and an active goal. This assessment used observed software behavior, not recruited novice participants. Screen-reader speech, actual 200% browser zoom, independent translation quality and the complete creation/recovery keyboard journey remain unverified. The observed early automated chat fill did not persist until the chat loaded; this retains the intermittent loading/draft concern rather than proving a new root cause. Review text also doubles a trailing purpose period. The native date filter was successfully set and read through CUA accessibility after locator-based interaction failed.

## Remaining acceptance work

| Requirement | Concrete next action | Completion evidence |
| --- | --- | --- |
| Selected release source | Review the combined patch, integrate the intended changes into a clean release commit and select its full SHA | Clean-source checks and the actual commit, not this dirty checkout's base SHA |
| #489 infrastructure and recall | Run the selected-commit soak and 50k workflows; the remote soak workflow is currently manually disabled | Retained reports, checksums, matching commit/run identities and independent validation |
| Selected-release beginner browser journey | Publish and run `persona-browser-journey.yml` for the selected release | Full JSON journey report and validator pass; V44 supplies the local CUA functional checkpoint, while the authored CI workflow is currently local |
| Recovery UI | Complete ZIP upload, restore into a new workspace, frozen-state/isolation checks, deliberate fixture reconnection and one new Activity | The recovery section of the manual checklist, with semantic records and App receipt |
| Human review | Perform the screen-reader/zoom, novice, language and output-quality assessments | Named reviewers and observations; component tests cannot supply these |
| Operational release | Record recovery selection, performance budgets, retention-rollout observations and release authority | The completed [manual acceptance and recovery checklist](../planning/personas-redesign/manual-acceptance-and-recovery.md) and rollout runbook evidence |

The [browser runbook](../performance/persona-browser-journey.md), [runtime acceptance runbook](../performance/persona-runtime-soak-acceptance.md) and [retention rollout runbook](../architecture/persona-runtime-retention-rollout.md) contain the actual commands and evidence contracts. Their release approval fields remain unfilled. The local audit does not invent those decisions.

## How to inspect the local package

The package is `.tmp/persona-review-v43` with a ZIP alongside it. From an extracted copy, run `node verify.mjs` to check every packaged file against `SHA256SUMS.json`. The package includes the repository's independent validators and a recorded invocation/result for each copied runtime, recall and endurance checkpoint. Source reports are copied byte-for-byte; their original identity and limits are preserved.

The later `.tmp/persona-review-v44-supplement.zip` adds the completed CUA journey, persisted snapshots, verified download, cleanup evidence and this updated assessment. It does not replace or relabel the frozen V43 source/verification archive. The local audit and implementation task is complete; the release requirements listed above remain open in GitHub.

GitHub status is maintained in the existing audit comments on [#505](https://github.com/mario-andreschak/FLUJO/issues/505#issuecomment-5757260417), [#489](https://github.com/mario-andreschak/FLUJO/issues/489#issuecomment-5757260619), [#435](https://github.com/mario-andreschak/FLUJO/issues/435#issuecomment-5757300931) and [#448](https://github.com/mario-andreschak/FLUJO/issues/448#issuecomment-5757273230). No issue is closed by this handoff.
