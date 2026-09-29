# Antigravity CLI provider — issue #529

Issue: https://github.com/mario-andreschak/FLUJO/issues/529

## Outcome and scope

The operator explicitly replaced the issue's Gemini CLI target with Antigravity
CLI. Add a distinct `antigravity-cli` connection alongside Codex and Claude CLI,
with both guided and advanced Add Model support. Replace the unreleased Gemini
CLI implementation in this branch; retain the native Gemini SDK connection.
FLUJO continues to own the selected flow tools, hidden presets, approvals,
execution fences, transcripts, steering, run attribution and usage reporting.

Google ended personal-account Gemini CLI access on June 18, 2026 and directs
consumers to Antigravity. The previous Google sign-in completed but model access
failed with `UNSUPPORTED_CLIENT`. This explains the replacement; the previous
Gemini test and failure recording do not satisfy Antigravity live acceptance.

Acceptance requires meaningful automated checks, browser authentication with the
operator-authorized `flujo.com.co@gmail.com` account, a successful real model and
tool demonstration, a playable recording without credential pages, a committed
and pushed change, and green CI/CD. Do not claim success from a mocked cloud
response, an OAuth callback alone, or a CLI exit code without a successful result.

## Checkout and coordination

- Reuse `C:/Users/Moe/.codex/worktrees/gemini-cli-provider/FLUJO`, branch
  `codex/gemini-cli-provider`. Existing draft PR #531 remains the review artifact.
  Rewrite its title and description around the final Antigravity implementation.
- Preserve unrelated changes in the primary checkout. The linked banking chat
  owns its `flujo-banking-identity/FLUJO` checkout and worker. Do not modify its
  files, restart its processes/containers, replace its models/flows, or share data.
- After this plan is complete, send the design and ownership boundaries to chat
  `01a0e385-6ac5-7601-8d56-69cf957e8428` before production implementation begins.
  Coordinate overlaps in provider types, ModelHandler, wizards and package files.
- Use an isolated FLUJO data root and an owned local port for browser acceptance.
  Verify process identity before stopping a server; never stop unrelated Node jobs.
- The linked chat requires Antigravity to stay out of authenticated banking
  flows until the same isolation checks pass. This work does not deploy into,
  change, or exercise its banking worker or authenticated data.

## Verified runtime facts and remaining probes

The official Windows AMD64 binary was downloaded directly from Google's
immutable release artifact and its SHA-512 matched the official updater manifest.
It reports version `1.2.13`, build `1.2.13-6662628811079680`. Its actual help
advertises `--input-format stream-json`, `--output-format stream-json`, `--agent`,
`--disable-slash-commands`, `--model`, and `--print-timeout`. Actual timeout default
is zero; FLUJO must impose an explicit deadline. No maximum agent-step flag or
auto-update suppression flag is advertised. These need executable probes rather
than assumptions carried from Gemini CLI.

The implementation must resolve these gates before acceptance:

1. Verify the private settings/agent schema, exact native tool names, explicit
   MCP grants, ambient customization isolation, and disabled delegation against
   the pinned executable. Inspect effects, because soft-denied tools may exit zero.
2. Verify account authentication works under a private invocation home. Never
   export or copy OS keyring secrets. The actual Windows artifact uses an official
   file-backed `antigravity-oauth-token` cache in this environment: support only
   that exact, validated credential file when present, with private permissions,
   race/symlink/size checks, snapshot exclusion and cleanup. No host settings or
   other credential files enter an invocation; absent cache may use native keyring.
3. Verify the artifact does not replace itself or start an uncontrolled updater
   during FLUJO runs. Use a supported setting/environment control if available;
   otherwise enforce the package-owned immutable executable and detect mutation.
4. Enumerate actual model slugs for account mode and explicit Gemini API-key
   mode. Do not reuse Gemini CLI's `auto/pro/flash/flash-lite` aliases. Unknown
   headless model slugs must fail visibly rather than select another model.
5. Verify one JSON-framed stdin prompt followed by EOF exits after the complete
   result, and cancellation terminates every owned process on Windows and Linux.
6. Define an honest agentic bound. `num_turns` counts user turns, not internal
   tool/model iterations. If no supported native bound exists, enforce bridge
   dispatch/step budgets and a hard process deadline with actionable failures.

## Runtime packaging

Create a production workspace wrapper at `packages/antigravity-cli`, referenced
by the root package. Its installer downloads only the current platform's locked
Google artifact, verifies SHA-512 before use, and stores it inside that package.
Pin all eight official targets: Windows AMD64/ARM64, Darwin AMD64/ARM64, Linux
glibc AMD64/ARM64, and Linux musl AMD64/ARM64. Unsupported platforms fail with
an actionable message. Never resolve a global `agy`, shell shim, or arbitrary PATH.

Windows artifacts are native executables; Unix artifacts are compressed tar
archives. Validate archive contents and extraction boundaries. Cache publication
excludes installed binaries; root npm publication includes the wrapper manifest,
locked artifact manifest, installer and resolver. Prove a packed production
installation can resolve and execute its own binary, including `--omit=dev`.
The root package postinstall also invokes the installer because npm does not run
the nested file-workspace lifecycle reliably for the packed consumer. Expose
`flujo-agy` as the bundled interactive login/model-listing command.

Docker copies the wrapper before builder and runtime `npm ci`. Copy the verified
builder binary into runtime so installation/startup works offline and as the
existing nonroot user. Verify the final image's resolver/version and architecture.
Add wrapper paths to release workflow filters and replace the Gemini artifact
smoke check. Do not execute Google's host installer: it also changes PATH/aliases.

Next.js automatically bundles route dependencies in the installed version.
Resolve this native package with the established Node `createRequire` pattern
or an explicit server external configuration, following the local Next guides.
Verify both the development/source and built production resolution paths.

## Backend adapter and private execution

Replace the four Gemini-specific adapter/process/runtime/event modules with
`antigravityCliAdapter`, `antigravityCliProcess`, `antigravityCliRuntime` and
`antigravityCliEvents`. Register the new adapter; remove obsolete Gemini CLI
dependencies and fixtures. Preserve common Codex bridge changes needed by FLUJO
tool results and keep existing Codex, Claude and native Gemini behavior covered.

Spawn the package-owned native executable with `shell:false` and hidden Windows
windows. Use `--input-format stream-json --output-format stream-json` and send
one `{event:"user",message:{content:prompt}}` record through stdin, then EOF.
Do not combine this with `-p` prompt text or put history into Windows argv.
Frame normalized scoped FLUJO history as inert conversation text and disable
slash/skill expansion. Reject unsupported media clearly; initially text only.

Each invocation has a fresh home, config/cache/data/temp directories and neutral
working directory inside `db/antigravity-cli-runtime/invocation-*`. Set the relevant
Windows and XDG home variables; strip inherited Google/Gemini/provider/endpoint
overrides. Do not load personal rules, hooks, plugins, skills, subagents, external
MCP definitions, workspace instructions or legacy migration assets. Account mode
uses the same OS user's verified native authentication mechanism, with the strict
single-file cache fallback described above when the native CLI writes it. API-key
mode explicitly selects `modelProvider:"gemini"` and sets only the saved
`GEMINI_API_KEY`. Production strips `GOOGLE_GEMINI_BASE_URL` and other endpoint
overrides. Controlled tests may inject a loopback endpoint through an internal
test seam, never user prompt/model arguments.

Generate a private primary agent with an explicit tool list,
`inheritCustomizations:false`, no delegated agents and no skill expansion.
Configure only `.agents/mcp_config.json` with the invocation's `flujo` bridge
using `serverUrl`. Explicitly deny native read/write, shell/unsandboxed and URL
execution permissions; grant exactly the bound `mcp(flujo/<tool>)` tools. Deny
rules override allows, so do not deny `mcp(*)` and then try to allow the bridge.
An `init.tools` assertion supplements executable enforcement; it does not replace
sentinel tests or prove that an alternate native tool path is unavailable.

Reuse the private random-token loopback MCP server and scoped closures. FLUJO
dispatch applies tool presets, approvals, run cancellation/fences, timeouts,
progress, result limits/resources, media normalization, handoffs and MCP UI
metadata. Unknown/unbound tool names fail. Record actual tool calls/results once.

Fresh processes replay scoped history for follow-ups and steering. Do not reuse
native durable sessions or enable Codex-specific resume/compaction. Preserve
steering acknowledgment behavior and prevent replayed tools from executing again.

## Event, usage and failure contract

Parse bounded, split/coalesced NDJSON records. Antigravity emits `init`,
`step_update` and terminal `result`. Only `agent_response.text_delta` enters live
assistant text. Correlate tool steps with actual bridge calls without exposing
native internal diagnostics as assistant text. Reconcile the final response and
require terminal `SUCCESS`; `ERROR`, `CANCELED`, `INTERRUPTED`, incomplete streams
and nonzero exits fail with sanitized, actionable diagnostics.

Documented input counters exclude cached tokens; output counters include thinking.
Verify these semantics against the pinned runtime and map prompt as input plus
cache, completion as output, and bounded cached/reasoning details. A single user
turn per invocation avoids cumulative-result double counting. Keep
`contextUsage:null` when only aggregate run usage is available.

Bound input/output lines, total output, stderr and execution time. Cancel before
spawn, during model work and during tool execution; terminate owned descendants
and close transports/private directories on every exit path. A timeout must not
turn the CLI's partial-output success behavior into a successful FLUJO result.
Diagnostics must not contain keys, OAuth codes, tokens or private credential paths.

## Shared definitions and model UI

Replace the unreleased `gemini-cli` provider/profile/adapter with
`antigravity-cli`. Update default-adapter, local-auth and self-orchestration
helpers, execution gates and diagnostics. Preserve explicit failed-key behavior:
a bad nonempty/bound key never silently becomes keyless or falls back to another
stored key. Native Gemini retains its API-key requirement.

Expose Antigravity on free, subscription and paid guided paths. Share setup with
an optional Gemini API key or confirmed local Antigravity account login. Explain
that sign-in occurs as the server/worker OS user; provide official platform
installation and `agy` sign-in instructions, including SSH manual-code login.
Do not invent a WinGet package or promise one-click installation.

Use the verified model catalog, with honest account/API-key entitlement wording.
Keep unsupported generation controls and attachments disabled. Update guided
bundles, advanced profile editing, test labels, resolved identity matching,
explicit credential clearing, idempotence and all seven locales. Clear obsolete
CLI restrictions when changing back to a native profile.

Include direct tests, chat, assisted flow generation, MCP sampling, scheduling,
visual/assisted authoring and MCP assisted install in the resolved-adapter audit.
Empty-key authorization applies only to supported local-auth CLI connections.

## Parallel ownership and sequence

1. Root writes this plan and coordinates the completed plan with the linked chat.
2. Backend agent owns the four native adapter modules, factory registration and
   their unit tests. It runs actual configuration/protocol probes and reports
   changes to the common bridge before touching it.
3. Frontend agent owns provider types/catalog, guided wizard, advanced modal,
   ModelClient, test dialog, seven-locale strings and affected UI/profile tests.
   Root supplies verified model/auth probe results before catalog finalization.
4. Validation agent owns native integration/security tests, snapshot exclusion,
   CI/artifact smoke checks, and README/model setup documentation. Coordinate
   runtime test seams with backend and wrapper exports with root.
5. Root owns the wrapper, root package/lock, Docker, this plan, cross-cutting
   ancillary identifier changes, deployment checks, live auth/video and final PR.
   Avoid concurrent installs/builds or edits to another owner's files.

## Validation gates

- Verify real pinned executable launch/version from source and packed production
  install on Ubuntu/Windows, plus nonroot Docker runtime. Inspect packed payload.
- Controlled loopback model endpoint plus actual MCP bridge: approved random
  nonce executes exactly once, reaches model/final response and transcript;
  hidden preset wins; denied approval has no effects; stale/cancelled run cannot
  dispatch; tool errors/resources/progress retain FLUJO behavior.
- Actual native sentinel read/write/shell/web attempts produce no effects;
  poisoned ancestor/global hooks, rules, plugins, skills, agents and foreign MCP
  configurations do not load. Prompt text cannot trigger preprocessing escapes.
- Split/malformed/truncated event streams, usage reconciliation, output bounds,
  missing login, bad key, timeout, cancellation, concurrent invocation isolation,
  process-tree cleanup and bridge/private-home cleanup.
- Snapshots exclude exactly `db/antigravity-cli-runtime`, including synthetic
  credentials/session data, while preserving adjacent ordinary workspace files.
- Guided free/subscription/paid setup, account confirmation, API-key mode,
  confirmation reset, advanced edits, save/reload, provider-only resolution,
  explicit key clearing, idempotence and native Gemini regression coverage.
- Typecheck, full lint, API inventory, production build, relevant adapter/UI/
  context/steering/authoring suites, release validation, then existing full CI
  baseline and isolated process suites. Repeat broad tests only for new changes,
  failures or material unresolved concerns.

## Live acceptance and delivery

1. Start final production output in an isolated FLUJO instance. Use the authorized
   Google account through Antigravity's official login; keep account/credential
   screens, password, consent codes and tokens out of recording artifacts.
2. Demonstrate guided Add Model setup and advanced editing/reload. Run a real
   diagnostic, including the synthetic tool round-trip, using account mode.
3. Run a minimal graphical tool-capable flow with a unique nonce; show the actual
   approved tool result, final answer, follow-up history, usage and Stop behavior.
4. Record a playable local video and evidence manifest with CLI version, actual
   model, branch/SHA and tested behavior. Separate controlled integration evidence
   from live Google acceptance. Never commit credentials or runtime data.
5. Commit and push, update attached PR #531, and wait for complete CI results.
   The issue permits push or PR+merge; a pushed tested change satisfies that
   delivery alternative. Only merge after all acceptance gates pass and verify
   any resulting CI/CD run before claiming completion.

## Primary references

- https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals
- https://github.com/google-antigravity/antigravity-cli
- https://antigravity.google/docs/cli/install/
- https://antigravity.google/docs/cli/headless/
- https://antigravity.google/docs/cli/gcli-migration/
- https://antigravity.google/docs/permissions?tab=cli
- https://antigravity.google/docs/subagents?tab=cli
- https://antigravity.google/docs/changelog/

Planning completed September 29, 2026. Runtime probe findings and final acceptance
results will be recorded below as implementation proceeds. Previous Gemini-only
CI and recordings remain historical evidence and do not establish new acceptance.

## Executable findings — September 29, 2026

- Account OAuth and Google's required phone/device verification completed using
  the authorized account. A real Gemini 3.8 Flash Medium run called a FLUJO nonce
  tool exactly once after approval, returned its random value and recalled it in
  a fresh-process follow-up. Final production UI acceptance also passed, as
  recorded below.
- This Windows environment writes the official `antigravity-oauth-token` file.
  Fresh HOME alone fails authentication; copying only that validated file makes
  the private-home account model listing and real completion work. No OS keyring
  export, settings copy, or other credential import is needed.
- Actual `models` lists 14 account slugs and 11 Gemini API-mode slugs. The UI uses
  these verified names and a Default sentinel, with a practical three-model guided
  bundle. Catalog listing describes runtime choices, not API-key entitlement.
- `AGY_CLI_DISABLE_AUTO_UPDATE` requires the literal string `true`. The value `1`
  still starts a background updater. The native regression checks invocation logs
  and executable hashes; the backend and bundled login command force `true`.
- `init.tools` reports the full registry even for `tools: []`. Actual model
  declarations for the private agent expose only MCP/resource/task housekeeping;
  sentinel tests verify native and delegated calls are rejected without effects.
- A private home and custom agent alone do not stop ancestor MCP discovery. A
  hostile ancestor repository caused foreign MCP/OAuth contacts. A private minimal
  Git repository boundary plus stripped `GIT_*` selectors removes those contacts;
  the actual adversarial fixture now passes with zero foreign requests/effects.
- Source installation and a packed Windows production consumer execute their
  verified package-owned runtime. A Linux Docker wrapper probe executes as the
  nonroot user with networking disabled. Full-image validation passed at
  `6a4c259db131eb82794709935bc5e4dc10419a1c`; it establishes distribution and
  startup before the final adapter-only handoff/output fixes.

## Final implementation and acceptance

- Current main, including the banking work from PR #528, was merged before final
  acceptance. Both ModelHandler and the direct adapter reject Antigravity in
  authenticated restricted execution. The linked banking chat confirmed that
  Antigravity remains excluded until the same attestation/isolation requirements
  are met. Existing banking workers, flows, models and data were not changed.
- Live graphical acceptance used the final production build at implementation
  revision `1a75cb004de028402c299151adc6670174bc2a15`, the pinned native CLI
  `1.2.13`, account authentication and `gemini-3.8-flash-medium`. An empty isolated
  instance created all three guided models; advanced editing persisted after
  reload. The real model diagnostic and FLUJO tool round-trip both passed.
- A saved Start → Chat → Finish flow, connected only to the synthetic nonce MCP
  fixture, executed approved `get_nonce` exactly once. Its unpredictable value
  `7d6139b5612d4aab37fa4653` appeared in the matched tool result and final answer.
  The first run recorded 12,684 input / 417 output / 13,101 total tokens. A new
  CLI process recalled the same nonce without replaying the tool, adding 10,572
  input / 2,108 output / 12,680 total tokens. Cumulative totals reconcile with
  durable message usage and the by-node ledger.
- Stop was tested after an approved slow fixture tool started. The conversation
  recorded cancelled recovery metadata and a matched cancelled tool result,
  visible again after reload. Its owned native PID exited and its private
  invocation directory was removed. No usage was invented for the interrupted
  invocation; earlier cumulative totals were preserved.
- Browser acceptance exposed a handoff bug: aborting the CLI immediately lost
  its final answer and terminal usage. Plain handoffs now close later tool and
  steering access while draining the bounded final response. Cancellation,
  execution fences and parallel spawn routing keep their existing behavior.
  An ordinary native SUCCESS with neither useful output nor dispatch is rejected;
  intentional tool-only and routing-only completions remain valid.
- Final controlled checks passed: 36 adapter tests; 13 real-native integration
  tests plus 9 snapshot tests; 37 frontend wizard/modal/conversion/diagnostic
  tests; and 108 merged model/restriction compatibility assertions. The native
  handoff regression retains all 51 terminal tokens and denies a later MCP call
  with zero executor effects. Source artifact checks, the packed Windows
  production consumer and nonroot offline Docker distribution checks passed.
  The final local production build and MCP release validation passed.
- The playable recording and its manifest are local deliverables under
  `antigravity-cli-529/final` in this chat's artifact directory. It records actual
  browser frames with long waits shortened. Nonce, recall, cancellation,
  process-cleanup and diagnostic proofs are separate from controlled native
  fixtures. Password, account consent, authorization codes, tokens and private
  runtime data are absent from the recording and Git changes.
- Delivery uses the issue's commit-and-push alternative and attached PR #531.
  Final exact-head CI results and raw suite/test counts are recorded in the PR
  and evidence manifest. Historical Gemini-only CI does not establish Antigravity
  acceptance. Ubuntu/Windows verification includes source artifacts, production
  builds and packed production consumers, alongside the existing full test,
  isolated-process, baseline, memory and release-safety gates.
- A hosted Windows installer log exposed a process-boundary assertion failure
  hidden by a later success in the same PowerShell step. Each native command now
  has its own CI step so its exit code is enforced. The PowerShell encoding
  fixture retains its exact assertions with a bounded startup budget and error
  receipt; its earlier failure cause was not observable from the old assertion.
