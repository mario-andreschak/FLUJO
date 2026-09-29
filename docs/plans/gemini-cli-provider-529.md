# Gemini CLI provider — issue #529

Issue: https://github.com/mario-andreschak/FLUJO/issues/529

## Outcome and acceptance

Add the official Gemini CLI as a distinct model connection, alongside Codex
and Claude CLI. Existing native Gemini and OpenAI-format connections keep their
API-key behavior. Both guided and advanced Add Model paths must save, reload,
test, and execute the new connection. FLUJO must continue to own the selected
flow tools, hidden presets, approvals, run attribution, transcripts, and usage.

Acceptance requires automated regression checks, a real Google browser login,
a recorded FLUJO model/tool demonstration, a commit and pushed PR, and passing
repository CI. Use the Google account explicitly authorized by the operator.
Until the successful model/tool demonstration happens, report live acceptance
as pending. Controlled local subprocess tests verify integration separately.

## Repository and coordination boundary

- Work only in `C:/Users/Moe/.codex/worktrees/gemini-cli-provider/FLUJO`, branch
  `codex/gemini-cli-provider`, based on origin/main `bd41f469` (3.46.1).
- Preserve unrelated changes in the primary checkout. The banking chat owns
  `flujo-banking-identity/FLUJO` and a running worker; do not edit its checkout,
  restart its containers, replace saved models/flows, or share its data root.
- Once this plan is complete, send it to chat
  `01a0e385-6ac5-7601-8d56-69cf957e8428`, agree on independent files/runtime use,
  and report the final integration and test evidence there.
- Use an isolated local data directory and port for browser validation. Any
  runtime integration requested by that chat follows its explicit constraints.

## Design decisions

1. Add provider/adapter `gemini-cli`, with a distinct profile and CLI aliases.
   Do not route the CLI profile through `@google/genai` or Google private
   subscription endpoints. Gemini's CLI owns its internal model/tool loop.
2. Pin official `@google/gemini-cli` 0.61.0 as a production dependency. Spawn its
   bundled JavaScript entry point with `process.execPath`, `shell: false`, and
   hidden Windows process windows. This works with Windows, Linux, Docker, and
   npm installs without depending on a global `.cmd` shim or fetching a binary
   during each completion. Reconfirm entry point against the installed version.
3. Feed normalized FLUJO history through stdin; use headless `stream-json` output.
   Fresh invocations carry the complete scoped history. Native CLI session
   resume is deferred because it is unnecessary for correct multi-turn behavior
   and would expand the durable session contract. Never silently ignore media:
   support what the CLI safely accepts or return an explicit capability error.
4. Prepare an invocation-private CLI home and neutral working directory inside
   the selected workspace. Only supported Google authentication cache files may
   seed it. Do not inherit personal settings, MCP servers, hooks, extensions,
   memories, project instructions, or system configuration. Strip inherited
   Google API/Vertex credentials when Google-login mode is selected, so the
   connection does not silently become API-billed execution.
5. Enforce tool isolation using the pinned CLI's verified policy/settings
   contract. Deny native shell/filesystem/web/delegation tools and allow only
   the per-run `flujo` MCP bridge. Configure only this bridge; do not rely on a
   system prompt for enforcement. Inspect the published source and prove the
   effective configuration in tests before considering isolation complete.
6. Reuse the existing loopback, random-token Streamable HTTP tool bridge.
   Each invocation has its own endpoint and handler closures. Dispatch declared
   MCP tools, virtual/local tools, and handoffs through FLUJO, applying presets,
   approval callbacks, cancellation and execution fences. Preserve tool timeout,
   owner scope, progress, result limits/resources, media, and MCP UI metadata.
   Unknown names must fail; a model argument must never bypass a hidden preset.
7. Translate CLI events into stable FLUJO assistant/tool messages and live
   deltas. Count actual tool results once. Map reported input/output/cached/
   reasoning tokens without pretending aggregate run usage is current context.
   Return `contextUsage: null` if no current-context snapshot is available.
8. Bound child process output, failure details and cleanup. Handle split NDJSON,
   malformed records, auth failures, nonzero exit, cancellation before/during
   execution, and maximum agent turns. Stop the child and close its bridge/home
   on every exit path. Capture request diagnostics without credentials.

## Implementation ownership and order

### Backend adapter and private runtime

Create `geminiCliAdapter.ts` and supporting runtime/event modules under
`src/backend/services/model/adapters`, register in `adapters/index.ts`, and add
focused adapter/runtime tests. Reuse normalization and tool-result helpers.
Keep changes to existing Codex/Claude implementations minimal. Tests must
verify that authentication files and runtime sessions never enter an ordinary
workspace snapshot; add Gemini runtime exclusion in `snapshotArchive.ts`.

### Shared model definitions and both wizards

Extend `shared/types/model/provider.ts`: profile, provider label, CLI model hints,
self-orchestration gate, unsupported-generation controls, and a shared predicate
for CLI connections supporting local authentication. Extend guided templates in
`connectionWizardCatalog.ts`, guided wizard, advanced modal, diagnostics labels,
and all seven locale columns in `i18n/catalogs/models.ts`.

Offer a Gemini API key or licensed Code Assist Standard/Enterprise Google login,
with Google's consumer-access deprecation notice. Show official npm installation
and `gemini` → Sign in with Google instructions for the licensed login path.
The existing installer API is a Windows WinGet allow-list; do not invent a Gemini
WinGet package or promise its one-click support. Explain that sign-in runs on
the server/worker host. Empty API keys are valid only for local-auth CLI paths;
native Gemini still requires a key. Saving must not require unsupported controls.

### Execution and ancillary model callers

Replace Codex-only empty-key exceptions in `ModelHandler`, model test/generation,
flow generation, visual generation, assisted authoring and MCP assisted install
with the shared local-auth predicate, preserving decryption failure behavior for
nonempty/bound keys. Apply self-orchestration gates consistently for transcript,
steering, compaction and context reporting. Do not enable Codex-specific native
session resume for Gemini. Add clear auth/tool failure diagnosis and tests for
direct test, chat and assisted flows.

### Packaging, documentation and integration review

Update production package/lockfile once, verify fresh install and JS-bin
resolution on both supported operating systems, document sign-in/runtime
behavior, and refresh API inventory only if routes change. Independently review
security and release behavior after the parallel implementation finishes.

## Decisive automated tests

- Factory/profile mapping, separate native/CLI profiles, local-auth validation,
  supported controls, guided model bundles, advanced save validation and i18n.
- NDJSON split/coalesced events, incremental text, final reconciliation,
  error/result statuses, usage mapping and invocation-unique transcript IDs.
- Real MCP bridge round-trip for local/MCP tools and handoffs; hidden presets
  win; approval denial has no side effect; cancelled/stale runs cannot dispatch;
  tool errors, timeouts, bounded results and UI/progress survive normalization.
- Two concurrent invocations have distinct homes/endpoints/callbacks; no foreign
  tools, settings, credential env vars or personal files are inherited.
- Child cancellation and errors clean up exactly once. Missing Google login
  yields actionable instructions. Bad/nonempty keys are not treated as keyless.
- Google credentials and CLI transcripts are excluded from snapshot export.
- Regression tests for Codex, Claude, native Gemini, context/compaction,
  generated flows, model diagnostics and both Add Model surfaces.
- Run typecheck, lint, API inventory check, production build, relevant Jest
  suites and package/release checks. Use the PR's complete verify workflow for
  Ubuntu/Windows build, full Jest baseline and isolated process suites. Fix
  attributable failures; document unrelated baseline failures with evidence.

## Live acceptance and evidence

1. Start isolated FLUJO from this branch with a separate data directory and port.
   Confirm the banking worker stays healthy and its configuration is unchanged.
2. Use the official CLI's Google browser flow with the operator-provided account.
   Do not record passwords, OAuth codes, tokens, or personal account pages.
3. Record the FLUJO guided model setup, saved profile, real connection diagnostic
   (including synthetic tool round-trip), and a minimal tool-capable graphical
   flow chat with a unique nonce. Test follow-up history and cancellation.
4. Check advanced creation/editing and reload persistence; a native Gemini API
   connection must still ask for its key. Record run/tool/usage evidence.
5. Save a local playable video and a short evidence record listing branch/SHA,
   actual model, CLI version, tests performed and limitations. Keep credentials
   and runtime data out of Git and public PR artifacts.
6. Commit only issue work, push, create/attach PR with `Fixes #529`, wait for
   complete CI results, and merge when green within the user's issue scope.
   Verify post-merge CI/CD status and report the resulting commit and evidence.

## Primary references

- https://github.com/google-gemini/gemini-cli/releases/tag/v0.61.0
- https://geminicli.com/docs/get-started/installation/
- https://geminicli.com/docs/get-started/authentication/
- https://geminicli.com/docs/cli/headless/
- https://geminicli.com/docs/tools/mcp-server/
- https://geminicli.com/docs/reference/configuration/
- https://geminicli.com/docs/reference/policy-engine/

Published 0.61.0 source is authoritative for the runtime settings/event contract;
website documentation may describe newer behavior. This file will retain final
decisions and acceptance results as implementation reveals them.

## Implementation findings — September 28, 2026

- The published 0.61.0 npm manifest declares `bundle/gemini.js`, not the source
  repository's `dist/index.js`; the runtime resolves and validates the actual
  manifest. The package embeds its dependencies, so FLUJO's Zod override does
  not replace Gemini's bundled Zod. The genuine packaged `--version` check passes.
- Disable the official launcher's automatic relaunch using
  `GEMINI_CLI_NO_RELAUNCH=1`. Otherwise it creates another process and suppresses
  termination signals, undermining Stop/cancellation.
- Actual runtime location is `db/gemini-cli-runtime/invocation-*`; snapshot
  exclusions and tests use this exact subtree.
- Provider-only records also need resolved adapter checks at keyless/tool gates.
  Failed explicit draft keys must never fall back to saved credentials.
- Browser authentication with the specifically authorized personal Google
  account completed, but the official CLI rejected model access
  with `UNSUPPORTED_CLIENT` / “no longer supported for Gemini Code Assist for
  individuals.” This is an upstream product restriction, not a FLUJO failure.
  Google's primary notice confirms consumer access ended June 18, 2026:
  https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals
- API-key usage and licensed Code Assist Standard/Enterprise access remain the
  applicable Gemini CLI paths. A successful personal-account demonstration
  requires Google's replacement, Antigravity CLI. User direction on API-key
  testing versus replacement integration is pending. No successful model/video
  acceptance is claimed, and no credential or authorization-code artifact is
  included in this repository.
- The pinned headless CLI expands `@file` input by constructing a native reader
  directly, outside its tool registry and policy engine. Every request is framed
  as inert FLUJO conversation text and escapes at-sign preprocessing. A test
  against the shipped CLI proves that a synthetic workspace sentinel is read by
  an unprotected prompt and is not read by the FLUJO prompt; leading slash
  commands are also neutralized.
- Trust only the generated invocation workspace. The CLI otherwise refuses
  headless startup. An owned empty `.gemini/.env` in the private home stops its
  trusted-directory ancestor search, which ignores `ignoreLocalEnv` for that
  filename. The shipped settings loader test proves no ancestor environment
  or machine settings fallback is consulted.
- The pinned CLI's MCP transport attempts to reinterpret JSON text as structured
  content. Primitive, array and null results need a Gemini-only object wrapper
  on the bridge; the original FLUJO transcript and media remain intact. Spilled
  results discard original structured payloads so the resource receipt bounds
  both representations.

## Validation and acceptance status

- 74 model/affected-backend suites passed: 731 tests, including the actual pinned
  CLI subprocess, approved random-nonce MCP round-trip, streaming, usage,
  cancellation and private-home cleanup against a controlled local response
  endpoint. These tests make no cloud model request and use a synthetic key.
- Wizard/client/modal checks passed, including API-key mode, licensed-login
  confirmation, provider-only records, credential clearing, and switching back
  from CLI restrictions to native capabilities.
- Full typecheck, full lint, API inventory (201 routes), packaged CLI launch,
  production build and package release validation passed during implementation.
  Final-source production build and pushed-commit CI are required before merge.
- Browser validation used a fresh data root and port 4299. Guided setup saved all
  four models with a clearly synthetic key; reload preserved them. The advanced
  form saved the Auto model with an empty key. Its real Google-login diagnostic
  produced the sanitized consumer-access rejection described above.
- A 28.56-second edited recording of actual UI steps and the access blocker was
  saved locally, together with setup, saved-model and diagnostic screenshots.
  It contains no Google credential pages or tokens. It is UI/failure evidence;
  successful live model/tool video acceptance remains pending.
- Create a draft PR referencing #529 without closing it. Wait for supported live
  credentials or explicit replacement scope before satisfying live acceptance,
  marking the PR ready, merging, or claiming the goal complete.
