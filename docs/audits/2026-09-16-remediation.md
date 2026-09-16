# September 16 audit remediation

This work follows the [original audit](2026-09-16-project-audit.md), which remains a record of the pre-fix state. At audit finalization, the changes were uncommitted development work on top of `26cd39856fd8a5580c77025ee0ec95732572045d`, not a published release. This historical record describes that validation snapshot; see the [changelog](../../CHANGELOG.md) for subsequent versioned release notes. The parallel task's workspace/MCP/Codex-adapter changes were retained and included in validation.

## Changes and acceptance

| Finding | Implemented change | Acceptance evidence |
| --- | --- | --- |
| F01 Dependencies | Next.js 16.3.5, sharp 0.35.4, patched compatible transitive dependencies | Isolated installation: npm audit reports zero vulnerabilities across production and development; production build passes |
| F02 Plaintext fallback | Model, registry and global-environment secret writes abort on encryption failure and retain existing values; batch environment updates are all-or-nothing. Explicit re-saving repairs historical failure-marked model secrets; affected environment secrets must be re-entered and saved | Credential-failure, model REST and registry integration tests; new single/batch environment regressions cover null, thrown errors and failed initialization |
| F03 Host parsing | Require a valid IPv6 literal and actual private/link-local range | 146 guard/security tests passed, including public DNS lookalikes and short hextets |
| F04 Encryption | Random 32-byte keys, AES-256-GCM, authenticated password-wrapped v2 keyrings, legacy read compatibility, atomic metadata upgrade | Mixed legacy/v2 password, restart, tamper, backup and worker snapshot tests; malformed existing metadata refuses replacement |
| F05 Installer safety | Validate repository identity, clean state, branch and ancestry before mutation; fast-forward only; updater checks before stopping the server and aborts if install/build/validation fails. Honor explicit Windows shortcut/start choices | Disposable real-Git fixtures preserve dirty/untracked files, divergent commits, unrelated targets and pinned tags; native exit-37 and GUI flag regressions pass |
| F06 Tutorial binding | Gate missing connections, repair deleted/unbound model references before sending; make Stage 1 optional from Onboarding settings | Onboarding component/context/builder regressions |
| F07 Connection readiness | Saved configurations explicitly remain unverified; guided retry applies the corrected key while preserving custom settings | Wizard/conversion tests; no automatic provider call or charge |
| F08 Runtime guidance | Read-only server-platform/install-mode discovery; Windows-only WinGet actions, native/container guidance elsewhere | Platform endpoint/wizard regressions |
| F09 False tutorial success | Failed runs remain in recovery; completion must belong to the tutorial conversation | Event and DOM fallback regressions with failure/retry paths |
| F10 Missing docs | Complete beginner/API/architecture/contributing indexes; seven missing feature guides added | Relative links checked; generated route inventory checked |
| F11 Release identity | New stable Windows bootstrappers pin tag and full SHA; manifests report channel/ref/revision; current changelog restored | Installer provenance tests; older already-published installers are explicitly distinguished |
| F12 Privacy claims | Explain local storage, provider/tool requests, telemetry and the public default password | README, landing page and in-app documentation corrected |
| F13 Status/prerequisites | Node 22 throughout; capability/maturity matrix; persistent Personas remain experimental | Source and documentation aligned |
| F14 API coverage | Curated supported reference plus generated inventory of 197 route files | AST-based generator and CI/release freshness check |
| F15 Test evidence | Count completed assertions/suites; exact reasoned skips; real DEK invariants; retire all nine quarantines and raise executed-test minima | Main 763 suites/6,874 tests and isolated nine suites/101 tests pass; both baseline gates pass with zero exemptions; all-pending and quarantined parse failures rejected |
| F16 Publication | Verify exact version commit and official fetch/push remotes locally for npm; image/installer publication requires authoritative exact-SHA main verification | Release safety tests reject wrong/stale/failed verification, changed worktrees and unofficial/multiple push destinations |

## Migration and deployment limits

New encryption writes use the authenticated v2 format. Existing CBC ciphertext and historical plaintext failure records are not silently rewritten. Re-entering and saving a secret uses the new format; saving an unchanged masked field may retain its original ciphertext. The encryption guide lists the explicit repair steps for historical model, registry and environment-variable plaintext records. A private password improves protection of stored keys. The public default remains obfuscation. Back up the complete workspace before upgrading; downgrading requires restoring pre-upgrade metadata and data together. See the [encryption guide](../../src/utils/encryption/README.md).

The user's running server and its installed dependencies/build were left intact while validation ran in a temporary checkout. A passing source build does not mean that existing server has been upgraded. Provider authentication, paid-model behavior, clean-Windows installer execution and real-world unattended autonomy require their own acceptance; no provider charge, release or public deployment was performed by this remediation.

## Validation record

The included evidence summaries are sanitized for public source control. Artifact-relative paths refer to raw files retained locally, not files shipped in this repository; checksum scope and removed private metadata are explained in the [public evidence policy](README.md).

Application validation passed in an isolated Windows checkout with its own patched dependencies. The [machine-readable validation record](2026-09-16-validation.json) records result hashes, source-change hashes, scope and artifact locations. The final production build ID is `ArSIS-l3naGYQvxNtiX3n`.

| Check | Result |
| --- | --- |
| Complete main regression run | 763 suites / 6,874 tests passed; four skipped suites contain six explicitly allowed opt-in assertions; 512.644 seconds |
| Complete serial isolated group | Nine suites / 101 tests passed; no failures or skips; 149.076 seconds |
| Final crypto/environment/security/registry checks | Nine suites / 140 tests passed, including eight new environment-save regressions; 44.882 seconds |
| Release and installer safety | 73 Node tests passed, including real disposable Git repositories and intercepted native Windows command failures |
| Windows installer helper suite | 52 Pester tests passed on Windows PowerShell 5.1; no real prerequisite installation or persistent execution-policy changes |
| TypeScript and lint | Full typecheck and `lint:all` passed on the final source |
| Production/package checks | Final Next.js build, app plus four MCP package inventories, isolated packed consumer installation, MCP processes and installed-app proxy smoke all passed |
| Dependency advisories | Zero production or development vulnerabilities in the recorded npm audit |
| Documentation | 343 relative file links and 13 local anchors resolved in the final documentation review; API inventory freshness check covers 197 route files |

Counts overlap and must not be added as unique test totals. The full main/isolated runs preceded the final narrowly scoped environment-write and installer/release refinements. Those refinements then passed their targeted suites, full typecheck/lint, final production build and packed-artifact smoke. Raw pre-fix and interrupted/failed diagnostic runs are retained separately; they are not presented as passing runs. The [quarantine review](quarantine-status.md) explains the repaired remote-root mock and relocation of artifact-dependent or intensive integration suites into the serial job. No test timeout or performance threshold was weakened.

The [post-fix browser acceptance](2026-09-16-ui-acceptance.json) used blank isolated data and a deterministic local provider: skip introduction without opening Stage 1, reject a wrong key with HTTP 401, correct and test the key, require an AI binding, create an agent, complete a real dispatched conversation, restart and reuse the encrypted credential, and save a manual model without reopening the wizard. This ran on build `3B_sneoUMRRE3b2a1XCZe`; subsequent application code changes affect only the environment API, while UI/conversation code is unchanged. The final build was independently rebuilt and package-smoked. No paid/cloud-provider account was used. Saved model configuration is explicitly unverified until tested; a successful test result is not persisted as a mandatory tutorial prerequisite.

The [full offline Persona simulation](2026-09-16-persona-soak.json) completed against synthetic temporary snapshot commit `df485400e72f5772f50b1caa9674db22bfb3bf42`: 28 simulated days, 560 activities, seed 459 and learning enabled. **Overall acceptance failed: 12 of 13 criteria passed.** All 560 inputs were accepted and completed, with zero failed, duplicate or unresolved activities. All five fault recoveries, the real child-process crash, memory/retention bounds, zero split-brain/stranded/stuck checks, and learning auto-rollback passed. Peak RSS was 483,946,496 bytes (461.5 MiB), below the 768 MiB cap.

The remaining failure is `flat-event-append-cost`: day 12's append p95 was **169.6893 ms**, above the unchanged requirement that every daily p95 be below **150 ms**. The first/final seven-day medians were 17.5931/18.33 ms, and no other day breached the cap. The test runner and independent artifact validator both rejected this criterion; this is not a passing endurance result. Persona reliability remains experimental.

Static diagnosis found no proven cause. The harness completes the graceful-restart fault before measuring five independent real append calls; nearest-rank p95 of five samples equals their maximum. Those calls did not cross segment rotation, and replacing the dispatcher does not reset event-log caches. The retained daily aggregate cannot distinguish filesystem, lock-wait, garbage-collection or background-work delay. The concrete next diagnostic is to retain each probe's event ID, sequence, duration and event-log work-counter changes, adding lock-phase timing if still necessary. Keep the measured operations and current limits unchanged; do not rerun solely to obtain a green result. A passing full run with retained evidence is still required to close this acceptance item.

This is a preserved local snapshot, not a published/upstream commit. The final checkout additionally incorporates Next.js's generated `root-params.d.ts` type import and documentation/evidence updates; runtime/harness source is unchanged. An earlier attempt was deliberately interrupted after two successful activity days because simultaneous build/test work exceeded the latency cap; it is retained separately and is not counted as passing.

At audit finalization, the parallel task's 16 recorded source hashes were unchanged, and the user's original server remained on its original build; patched dependencies and runtime had been exercised only in isolated temporary installations. The work was then uncommitted and unreleased. Acceptance still outstanding at that time included a clean-Windows EXE installation, current-source Linux CI and actual provider/account behavior; later release validation is separate evidence. Offline simulation and controlled local chat cannot establish indefinite real-world unattended autonomy.

The pre-fix UI was exercised in a new `audit-first-user-20260916` workspace on the user's running server: skipping the introductory tour opened Stage 1, which created an unbound Chat agent. A generic greeting failed with `flow_invalid` / HTTP 400 and “Ask AI has no model bound.” No provider request was made. This live baseline corroborates F06; it is not a post-fix acceptance result.
