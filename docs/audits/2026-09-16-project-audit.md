# FLUJO project audit — 2026-09-16

This is the original pre-fix snapshot. See the [remediation and validation record](2026-09-16-remediation.md) for subsequent implementation work; the historical findings and original test evidence below have been retained.

Publication note: local paths and private task metadata have been removed. Source links are repository-relative; quoted line numbers describe the original pre-fix snapshot above, not a new audit of the current file. See the [public evidence policy](README.md).

## Assessment

FLUJO has substantial, working engineering behind it: a visual execution engine, MCP lifecycle management, workspace isolation, provider adapters, persistence, and extensive automated coverage. Its current weaknesses are consequential security defects, an unreliable path to a new user's first successful result, and documentation/release claims that have drifted away from the implementation.

**Recommendation: prioritize a stabilization release before broader promotion.** The immediate dependency issue is especially significant for the Windows installation path. Localhost defaults are valuable, but they do not justify a blanket security endorsement. Persistent Persona autonomy also needs clearer separation from the better-established interactive workbench.

This audit reviewed the [shared Grok conversation](https://grok.com/share/bGVnYWN5LWNvcHk_3a159d0c-0e61-44db-a2f6-bd33af634db1), current source, installation scripts, documentation, release history, current GitHub CI artifacts, focused local tests, and production dependency advisories. It is not a binary malware certification or a completed live UI acceptance run.

## Snapshot and concurrent work

| Item | Observed state |
| --- | --- |
| Checkout | `main`, HEAD `26cd39856fd8a5580c77025ee0ec95732572045d`, latest commit September 13 |
| Visible package version | `3.45.2` |
| Latest GitHub release | [v3.45.2](https://github.com/mario-andreschak/FLUJO/releases/tag/v3.45.2), published September 6, 2026 UTC |
| Source beyond release | HEAD is 29 commits after `v3.45.2` |
| Existing work in progress | 15 modified tracked files plus untracked MCP workspace package code/tests and outreach/research documents |
| Size | 1,187 tracked TS/TSX source files; 772 test/spec files under `__tests__`; file counts are not passing-test counts |
| Other task supplied by user | A concurrent task was inspected; its initial metadata did not identify it as a FLUJO task |

Existing changes involve MCP migration/runtime packages, workspace handling, Codex adapter behavior, tests, and workspace documentation. They were preserved. Findings below are in existing tracked code rather than assertions that those pending changes are released. Only this audit and its evidence files were added by this task.

## Findings requiring prompt action

### F01 — P1: the pinned production framework has critical security advisories

[package.json:109](../../package.json#L109) pins Next.js `16.2.12`; the lockfile resolves `sharp` to `0.35.3`. A current `npm audit --package-lock-only --omit=dev --ignore-scripts --json` reports **eight affected packages: one critical, three high, four moderate**. These are affected-package counts, not eight independently demonstrated exploits.

The vendor lists Next.js 16.x before `16.3.3` as affected by a critical Windows filesystem RCE affecting Pages/App Router applications without Cache Components. FLUJO uses App Router, supports Windows, and does not enable Cache Components. This is a directly relevant deployment profile. No exploit was attempted. [Vercel advisory](https://github.com/vercel/next.js/security/advisories/GHSA-p293-qw3h-jr36).

Next.js also has an AVIF image-optimization RCE advisory; sharp versions before `0.35.4` carry related libheif risk. Actual AVIF exploitability depends on processing attacker-controlled input and the runtime platform; this audit did not demonstrate that path. [Vercel image advisory](https://github.com/vercel/next.js/security/advisories/GHSA-2xp9-vwfh-vxw4), [sharp advisory](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c).

**Action:** upgrade Next to a supported patched version at least `16.3.3`, resolve sharp to at least `0.35.4`, refresh the lockfile, and rerun production builds, Windows installation, image handling, and MCP/package smoke checks. npm currently proposes Next `16.3.5`. Triage the additional `fast-uri`, `nanoid`, `hono`, `qs`, `body-parser`, and `express` findings by their actual call paths. No automatic dependency changes were made.

### F02 — P1: an encryption failure can persist an API key in plaintext

[model/encryption.ts:84](../../src/backend/services/model/encryption.ts#L84) returns `encrypted_failed:<original secret>` when initialization/encryption fails; the exception handler does the same. A prefix does not encrypt its payload. [model/index.ts:180](../../src/backend/services/model/index.ts#L180) accepts that representation, and the save path persists it. [registry/index.ts:87](../../src/backend/services/registry/index.ts#L87) also saves returned credential values without rejecting the failure representation.

A module-level failure simulation returned the literal fake secret behind this marker. This is a reproduced helper behavior plus a verified persistence path, not a test with a real credential. The MCP save path already rejects the marker at [mcp/index.ts:2705](../../src/backend/services/mcp/index.ts#L2705).

**Action:** fail the save, retain the previous encrypted value, and show an actionable error. Explicitly handle existing failure-marked values through a controlled migration. Acceptance must cover encryption exceptions and failed initialization without writing the submitted plaintext.

### F03 — P1: Network mode's host guard mistakes public domains for private IPv6

[localRequest.ts:84](../../src/utils/http/localRequest.ts#L84) tests only whether a hostname starts with `fc`, `fd`, or `fe8`–`feb`. It never verifies that the input is an IPv6 literal.

Executing the actual transpiled guard with Network mode selected returned `true` for both the host and same-origin checks for `fc.attacker.example`, `fd.attacker.example`, and `fe80.attacker.example`. The ordinary `attacker.example` control returned `false`; Localhost mode rejected the prefixed domains.

This defeats the intended application-level DNS-rebinding hostname restriction in opt-in Network mode. It is not proof of a completed browser exploit or a default-Localhost bypass.

**Action:** validate an actual IPv6 address before checking private/link-local ranges, and cover domain lookalikes in guard tests. Review the shared helper wherever it establishes a trust boundary.

### F04 — P1: encryption strength and integrity fall short of the documented contract

[secure.ts:29](../../src/utils/encryption/secure.ts#L29) defines `KEY_SIZE = 256 / 32`, a word count, but [line 81](../../src/utils/encryption/secure.ts#L81) passes it to `WordArray.random`, which expects bytes. New DEKs therefore have **eight random bytes / 64 bits of entropy**. The unwrap path returns the UTF-8 bytes of the hexadecimal text, yielding 16 effective key bytes with only that 64-bit randomness. A CryptoJS probe confirmed these lengths.

[secure.ts:658](../../src/utils/encryption/secure.ts#L658) serializes unauthenticated CBC as `iv:ciphertext`. The public default wrapping password at line 42 provides no meaningful protection against an attacker who has the stored metadata and ciphertext. A user password improves wrapping protection but does not repair DEK entropy or add ciphertext authentication. The [encryption README:190](../../src/utils/encryption/README.md#L190) overstates the effective AES-256 data protection.

**Action:** design a versioned migration to a cryptographically random 32-byte key and authenticated encryption. Preserve access to existing ciphertext and exercise migration, password change, restart/unlock, backup/restore, and tamper failures. Merely changing the constant would break legacy validation and key interpretation.

**Correction to Grok:** installed CryptoJS 4.2.0 defaults PBKDF2 to SHA-256, not SHA-1. FLUJO explicitly uses 100,000 iterations. The serious key-generation defect remains.

### F05 — P1: rerunning installers can discard tracked user changes

Windows accepts any selected directory containing `.git` as an existing installation at [installer-functions.ps1:55](../../scripts/installer-functions.ps1#L55). [install.ps1:655](../../scripts/install.ps1#L655) runs fetch, checkout, and `git reset --hard origin/$Branch`. Unix has the equivalent sequence at [install.sh:498](../../scripts/install.sh#L498).

Neither path first verifies repository identity, installation ownership, a clean working tree, or whether local commits would be discarded. There is no specific discard warning. For a checkout already on the requested branch with ordinary tracked edits, checkout can succeed and the reset then destroys those edits. An unrelated repository with an appropriate origin branch is also affected: it is reset to its own origin, not to FLUJO's upstream.

**Action:** validate identity, refuse dirty/diverged checkouts with recovery instructions, and update using a fast-forward-only operation. Do not perform an implicit reset as a normal installer repair. This finding was independently source-reviewed; no destructive installation/update was executed.

### F06 — P1: the tutorial can create a first agent that cannot run

The introduction can finish without configuring a model. [TourContext.tsx:449](../../src/frontend/contexts/TourContext.tsx#L449) then starts the larger tutorial. [TourContext.tsx:198](../../src/frontend/contexts/TourContext.tsx#L198) loads the empty model list and passes an undefined model ID to the Chat builder. Executing the builder confirmed that the resulting AI node has no bound model. Existing unbound Chat flows can also bypass repair through the reuse branch.

[ProcessNode.ts:421](../../src/backend/execution/flow/nodes/ProcessNode.ts#L421) rejects a missing model at execution time. Thus the tutorial can guide a new user into a failure it created.

**Action:** require an available, tested AI connection before constructing the tutorial agent. If Chat already exists but is unbound, offer model selection/repair. The normal Home setup cards already gate later steps on model presence; align the tutorial with that behavior.

## First-user experience

The product has useful setup UI, but it currently equates saved configuration with successful operation. The best first-user objective is one completed, understandable chat response before introducing tools, flow editing, or persistent Personas.

| Journey stage | Current evidence | Required improvement |
| --- | --- | --- |
| Choose an installation | Moving-main installers and versioned npm releases can deliver different code under the same displayed version | Clearly label stable/development channels and display the build revision |
| Meet prerequisites | README manual section says Node 18+ while package requires 22+ | One consistent, checked prerequisite |
| Connect AI | Saving validates configuration, not an authenticated provider response | Test connection and offer recovery before claiming readiness |
| Retry a wrong key | Matching provider/adapter/model reuses the old record and ignores the newly entered credential | Explicitly update/test credentials or explain reuse |
| Start tutorial | Empty model list can create an unbound Chat | Gate and repair model binding |
| Observe failure | Tutorial advances on both completed and error states | Remain in recovery until a successful answer exists |
| Learn more | Beginner guide is a topic outline; seven feature-guide links point to missing files | One complete walkthrough with working links |

Additional concrete defects:

- **F07 — P2: false readiness and broken credential retry.** [ModelConnectionWizard.tsx:439](../../src/frontend/components/models/ModelConnectionWizard.tsx#L439) accepts a nonempty key and saves the bundle. [ModelClient.tsx:253](../../src/app/models/ModelClient.tsx#L253) treats a matching configuration as already complete and ignores new credentials. A mistyped key can reach the success screen, and repeating setup with the correct key does not fix it. These are source-confirmed paths; no paid/provider request was made.
- **F08 — P2: guided tool installation assumes Windows.** [ModelConnectionWizard.tsx:685](../../src/frontend/components/models/ModelConnectionWizard.tsx#L685) and line 723 present WinGet commands for Ollama/Claude/Codex regardless of host platform. [setup/ai-cli/route.ts:35](../../src/app/api/setup/ai-cli/route.ts#L35) rejects non-Windows hosts. Detect the server OS and install mode and provide appropriate instructions, including containers.
- **F09 — P2: the tutorial treats an execution error as success.** [BigTutorialOverlay.tsx:193](../../src/frontend/components/Tour/BigTutorialOverlay.tsx#L193) advances on `completed` or `error`, including its DOM fallback. [bigTutorialSteps.ts:257](../../src/frontend/components/Tour/bigTutorialSteps.ts#L257) then presents a positive result message. Require an actual answer before the success state and surface connection/tool failures.

The larger Stage 1 tutorial has roughly 38 main steps plus prerequisite branches, and much of its prose is hardcoded English. As a product recommendation, make it optional after first success and split it into short, resumable lessons. This is a usability judgment, not a measured completion-rate claim.

## Documentation and changelog

**F10 — P2: the beginner documentation is unfinished.** [Getting Started:5](../../docs/getting-started/README.md#L5) lists intended topics rather than instructions. API, architecture, and contributing indexes contain similar scaffolding. The feature index links to seven nonexistent files: MCP overview, local servers, GitHub servers, running flows, flow templates, model connection, and model settings. See [features/README.md:11](../../docs/features/README.md#L11), line 20, line 22, and lines 126–127. Advanced technical material exists, but navigation does not create a reliable beginner route to it.

**F11 — P2: release identity and change history are ambiguous.** [CHANGELOG.md:46](../../CHANGELOG.md#L46) jumps from Unreleased to `0.1.3 — 2025-04-07`, without entries for the current 3.x releases. The versioned Windows bootstrapper defaults to moving `main` ([flujo-setup.iss:25](../../installer/flujo-setup.iss#L25)); the install scripts also default to main, while npm serves a published package. The [release checklist:12](../../docs/windows-installer-release-checklist.md#L12) makes that intentional, but users are not given a clear channel/build identity. Publish tagged release notes and compatibility/migration notes; pin stable installers and label development-channel installs.

**F12 — P2: privacy wording exceeds the implementation.** [Landing page:776](../../githubpages/index.html#L776) claims keys and data never leave the machine. Cloud providers necessarily receive credentials and request content: [openaiAdapter.ts:124](../../src/backend/services/model/adapters/openaiAdapter.ts#L124), request at line 225. [Telemetry:103](../../src/backend/services/telemetry/index.ts#L103) defaults on and sends version/platform/install-method information. Replace the absolute claim with a clear account of local storage, selected provider/tool requests, and anonymous telemetry. The README already describes telemetry more accurately.

**F13 — P2: prerequisites and feature-status promises are stale.** [README.md:199](../../README.md#L199) says Node 18+; [package.json:13](../../package.json#L13) requires 22+. [README.md:512](../../README.md#L512) presents AI-assisted generation as unshipped despite the wired generator UI and API. Replace this with a capability/maturity matrix distinguishing interactive agents, visual generation, MCP tools, experimental functionality, and persistent Personas.

**F14 — P2: API documentation is not exhaustive.** [README.md:190](../../README.md#L190) promises every REST endpoint; [apiReference.ts:2](../../src/frontend/components/Docs/apiReference.ts#L2) is hand-maintained. There are 48 entries versus 196 route files, which are not directly equivalent counts, but major surfaces such as workspaces, tickets, Personas, and Roles are missing. Label the reference as curated until it has a maintained coverage check and explicit supported integration contracts.

Low-priority cleanup: `LOG_LEVEL: 3` has a VERBOSE comment even though 3 is ERROR; the tracked empty `$null` file is repository debris. These undermine polish but do not explain the substantive readiness issues.

## Project status and quality gates

The latest [verify run](https://github.com/mario-andreschak/FLUJO/actions/runs/34763333121) for HEAD is green, including typecheck, lint, main tests, isolated tests, and release-argument checks. Its downloaded raw artifacts show:

| CI group | Suites | Tests |
| --- | --- | --- |
| Main | 766 total: 760 passed, 1 failed, 5 pending | 6,810 total: 6,797 passed, 2 failed, 11 pending |
| Isolated | 6 passed | 77 passed |

The failed main suite is `browserCaptureRecording.test.ts`, covering capture/session/audio/recording behavior. It is quarantined. Therefore “green CI” means the configured gate passed, not that every product test passed.

**F15 — P2: the execution baseline does not prove test execution.** [verify-test-baseline.cjs:85](../../scripts/verify-test-baseline.cjs#L85) compares total collected counts, including pending items. Both `minTests` fields in [test-baseline.json:19](../../test-baseline.json#L19) are null. A synthetic result containing 682 pending suites/tests and zero passed/failed tests returned `ok: true`. This is a demonstrated hole in the gate, not a claim that current CI ran no tests.

Nine entire suites are quarantined, and [dekInvariant.test.ts:21](../../__tests__/encryption/dekInvariant.test.ts#L21) really is an `expect(true)` placeholder with intended encryption migration regressions commented out. Restore those tests; measure executed assertions, make skips explicit, and assign quarantine owners/exit conditions.

**F16 — P2: release publication is not bound to a verified commit.** [release.mjs:129](../../scripts/release.mjs#L129) builds and validates artifacts, then publishes at line 149 without requiring full verification on the exact release commit. Build/package smoke is useful but does not replace test/lint gates. Require the approved verification results and artifact provenance for the revision being distributed.

The most recent [full Persona soak run](https://github.com/mario-andreschak/FLUJO/actions/runs/34747374577) failed on the earlier `1eb55ada` revision. HEAD contains subsequent repairs, and isolated smoke is green. However, the workflow is now manual-only and no newer successful full soak appeared in its latest runs. The correct state is **fixes committed, short smoke passing, full endurance proof outstanding**. The September 14 [memory benchmark](https://github.com/mario-andreschak/FLUJO/actions/runs/34831408031) passed, which supports that specific subsystem rather than proving unattended autonomy.

Current open project issues also preserve this distinction: [#505](https://github.com/mario-andreschak/FLUJO/issues/505) and [#489](https://github.com/mario-andreschak/FLUJO/issues/489) carry test-fail status; [#435](https://github.com/mario-andreschak/FLUJO/issues/435) still calls for manual acceptance; [#517](https://github.com/mario-andreschak/FLUJO/issues/517) reports a Tool Tester crash. Labels are project-tracking evidence, not independently reproduced diagnoses.

## What the Grok review got right, wrong, and omitted

| Claim/topic | Audit conclusion |
| --- | --- |
| Substantial local agent/MCP workbench | Supported by source architecture and extensive real tests |
| Absolute clean-malware verdict | Too strong: this audit does not certify all dependencies, binaries, or installation supply chains |
| No ordinary user authentication | Correct for the main single-user app; worker mode has a separate bearer boundary |
| Localhost defaults and fail-closed internal route guard | Correct and valuable; Network-mode hostname bug still needs repair |
| OpenAI-compatible endpoint accepts arbitrary client API keys | Correct; wildcard CORS and exposure boundary are deliberate, not authentication |
| Shell/git features can execute code | Correct by design; command execution alone does not prove a default-localhost remote exploit |
| 64-bit random DEK | Correct; effective stored-data key interpretation is also inconsistent with AES-256 claims |
| PBKDF2 uses SHA-1 | Incorrect for the installed library: SHA-256 |
| DEK invariant test is a placeholder | Correct |
| Changelog is stale | Correct; install-channel/build identity drift is broader than the changelog |
| Safe enough overall on localhost | Too confident without accounting for current framework advisories, encryption failure behavior, and the scope of testing |
| Important omissions | Current dependency advisories, plaintext fallback, Network hostname parsing, installer data loss, first-run tutorial failure, credential retry, and baseline-gate weakness |

The OpenAI compatibility endpoints pass the configured Host boundary but deliberately bypass the ordinary same-origin test ([proxy.ts:74](../../src/proxy.ts#L74)). The rate limiter uses a caller-controlled `x-forwarded-for` and allows 6,000 requests/minute ([route.ts:27](../../src/app/v1/chat/completions/route.ts#L27), line 84). It is not an authentication or spending-control mechanism. Some Persona/control-plane operations have additional checks; it would be inaccurate to declare every endpoint equally exposed. Reverse-proxy authentication is necessary for deliberate shared exposure, and default loopback binding remains useful defense in depth.

## Stabilization order and acceptance criteria

1. **Patch dependency and data-protection issues.** Update affected runtime packages; fix plaintext fallback and Network hostname parsing; plan the versioned crypto migration. Require applicable security regressions and production/Windows smoke on the resulting revision.
2. **Protect installation/update data.** Test clean installs, safe repeat installs, dirty/diverged repositories, unrelated target repositories, and migration rollback using disposable fixtures.
3. **Make the first success deterministic.** Fresh workspace → select provider → validate connection → create a bound agent → complete one reply. Include wrong key then corrected key, provider offline, no models, missing runtime, and reload/resume. Errors must never trigger success copy. Introduce one tool only after the plain chat succeeds.
4. **Make docs describe that exact path.** Publish one working quickstart, repair seven links, unify Node requirements, explain stable versus main, fix privacy text, and publish current release notes and known limitations.
5. **Make release evidence trustworthy.** Restore DEK invariant coverage, establish executed-test minima, resolve or explicitly own quarantines, and require exact-commit verification before publishing. Run the repaired full Persona soak and record its limits separately from interactive-agent readiness.

Preserve the existing strengths: loopback defaults, explicit exposure settings, central fail-closed routing, worker bearer authentication, AsyncLocalStorage workspace selection, path checks, atomic storage, and MCP artifact/process-boundary validation. These are a useful foundation for the stabilization work.

## Validation and limits

Executed locally against the current working tree using Node `22.13.1`:

- TypeScript: `node node_modules/typescript/bin/tsc --noEmit --incremental false -p tsconfig.json` — passed.
- Encryption, security, startup gating/barrier, workspace bootstrap, and onboarding-doc suites — **24 suites / 302 tests passed**, 191.226 seconds.
- Home setup, model wizard, TourContext, BigTutorialOverlay, Stage 1 builder, and connection catalog suites — **6 suites / 34 tests passed**, 16.166 seconds.
- Read-only guard/crypto/baseline probes — reproduced the findings above; [probe evidence](../../docs/audits/2026-09-16-probes.json).
- Production lockfile advisory scan — exit 1 with eight affected packages; [raw audit evidence](../../docs/audits/2026-09-16-npm-audit.json).
- GitHub release/workflow/issues read using `gh`; raw CI artifacts downloaded and summarized above.

The focused passing tests do not demonstrate that the untested defect paths work. This task did not run a complete fresh dependency installation/build, the entire local suite, destructive installer updates, paid model calls, a fresh full Persona soak, or Windows EXE analysis.

An isolated copy of the existing production build was prepared under the temporary directory for a browser walkthrough. The execution policy rejected the server-launch command with “blocked by policy” and supplied no more specific reason. The rejected launch was not retried through another mechanism. Consequently first-user findings are source/helper/component-test evidence, not a live end-to-end browser result; no new audit server was started. The shared Grok page itself was read successfully in the browser.

No application fixes, dependency upgrades, releases, commits, or changes to existing work-in-progress files were performed.
