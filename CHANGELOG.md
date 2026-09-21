# Changelog

## [Unreleased]

### Personas

- Keep first-start migration reports accurate after workspace-lock setup, distinguish directory moves from merges, and release the startup lock if snapshot admission fails.
- Check Role-derived Core and Behavior readiness before creation; preserve blocked drafts and provide setup/retry actions. Repair Core editor navigation, add specialist Behaviors after creation, and clarify History outcomes.
- Add an opt-in beginner browser journey with a local model/App fixture, queued-Task restart checks and configuration/privacy assertions. Let users dismiss the first-use telemetry notice without changing privacy preferences, so it no longer traps controls underneath it.
- Bind browser acceptance to a selected release commit, run and build; reject partial or mismatched journey reports and retain checksummed CI evidence for 90 days.
- Localize the default memory-maintenance Behavior heading and keep long History reset-filter labels readable alongside the filters.
- Translate untouched generated Persona Flow names and descriptions in setup and Behavior pickers while preserving custom content. Identify, group, filter and search Persona chats by the Persona, including drafts before their first run and conversations made with an earlier Core Flow.
- Keep keyboard focus on Persona Setup and Apps tabs instead of an App search field below the viewport. Align Portuguese and Chinese Role terminology with the Role library.
- Preserve keyboard focus after Memory corrections and show failed saves inside Memory and Task dialogs. Label Task dependencies and keep pending saves open. Reject corrections of replaced Memories; retain the owner's draft and require review of the current version before continuing.
- Translate concurrent Task-edit conflicts while retaining unsaved input and the original revision. Improve primary, gradient, supporting-text and status-label contrast across the four shared theme presets.
- Show default History filters and inherited Persona language explicitly. Wrap long settings choices and menus, correct section heading levels and singular blocker wording, and translate Role-change help consistently across seven languages.
- Keep failed App-tool and Role-sharing saves visible inside their dialogs, retain drafts and focus the error for keyboard users. Add descriptive, translated loading status messages for Persona surfaces and previews.
- Keep long Persona gallery names and actions within narrow screens, correct gallery/App-tool heading levels, and translate fixed-parameter controls and concurrent App-edit guidance in seven languages.
- Link Persona tabs to named, keyboard-focusable content panels. Reveal focused tabs within the narrow tab strip and keep navigation focus below the sticky header.
- Keep Skip to content focus and browser history aligned, so returning from Persona chat restores the Persona page instead of leaving Chat beneath its URL.
- Show translated chat loading statuses while a Persona conversation opens, without flashing new-conversation guidance or remounting the draft composer.
- Announce observed Task and goal state changes with their names and translated status across Persona areas, without moving focus or repeating unchanged refreshes. Bound simultaneous updates and avoid duplicate generic lifecycle announcements.
- Complete Persona translations in seven languages and improve narrow layouts, contrast, loading messages and dialog focus. Replace browser confirmations, retain failed-save drafts, localize generated History and default Role Behavior labels, correct Role page landmarks, and prevent translated navigation from overlapping workspace controls.
- Add a separate Persona recovery ZIP with integrity validation, private-data disclosure and restoration into a new disabled workspace. Model/App connections require reconnection; saved work does not resume automatically.
- Erase Persona-owned Flow copies/history, specialist-call payloads and private model archives during deletion; prevent stale writers from restoring erased data and protect Role versions referenced by historical work.
- Bound detailed specialist-call retention, improve complete 50k Memory recall, share conversation log counters across server bundles and strengthen runtime/recovery evidence. Run endurance with the production Role factory and verify its saved setup independently; preserve earlier generic-Core results with their limits. Personas remain experimental; see the [audit and verification record](docs/audits/2026-09-19-persona-audit.md) for measured results and outstanding release gates.

### Subflow collaboration

- Connected subflows automatically offer inline calls, background launches, messages and waits. Remove the global subflow activation switches and the per-node callable-tool toggle; saved session scopes work without an additional gate.
- Let children send progress, questions and results to their parent while working. Keep a finishing parent available for its background children, and identify agent senders in chat and conversation previews.
- Fix detached child IDs, cancellation propagation, concurrent launch admission and late completion races. Keep communication scoped to the current parent/child run and workspace.
- Deliver steering during quiet Claude and Codex SDK turns, preserve pending input on delivery failures, and keep tool-call/result pairs intact. See [Subflow communication](docs/SUBFLOW_COMMUNICATION.md).

## [3.46.0] — 2026-09-16

### Security and reliability

- Upgrade Next.js to 16.3.5 and sharp to 0.35.4, and refresh affected transitive dependencies.
- Reject public DNS names that resemble private IPv6 addresses in Network mode.
- Fail model, registry, and secret environment-variable saves when encryption fails; retain previous values and never store an encryption-failure prefix followed by plaintext.
- Add versioned authenticated encryption and stronger new data keys while retaining legacy ciphertext compatibility.
- Preserve tracked edits and local commits during installer reruns; validate the target repository and update only by fast-forward.
- Pin new stable Windows bootstrappers to their release tag and commit; record channel/revision and refuse unsafe in-app updates before stopping the server.
- Honor explicit Windows installer shortcut/start choices, and stop updates when dependency installation, compilation, or artifact validation fails.
- Restore the package wizard's missing build endpoint in clean installations; a broad build-output ignore rule had excluded its route source.

Encryption migration: new writes use authenticated AES-256-GCM and a 32-byte random key. Existing ciphertext remains readable through a versioned keyring; re-entering and saving a secret gives it the new format, while an unchanged masked field may retain its original ciphertext. The public default password provides obfuscation only; configure a private password for storage protection. Historical plaintext failure records also require the explicit repair steps in the migration guide. Make a complete workspace backup before upgrading: older versions cannot read migrated v2 metadata, so downgrade requires restoring that backup. See the [encryption format and migration guide](src/utils/encryption/README.md).

### First-run experience and documentation

- Require and repair model bindings before tutorial execution, and show recovery when a tutorial run fails.
- Make the longer Stage 1 tutorial optional from Onboarding settings; skipping the introduction returns to setup instead of opening another tour.
- Distinguish saved AI configurations from tested connections; preserve corrected credentials on guided setup retries.
- Return manual model creation to its originating page without reopening the connection wizard.
- Show runtime installation guidance for the server's operating system and container mode.
- Add a complete first-conversation guide, missing model/MCP/flow guides, accurate privacy and maturity descriptions, and a generated HTTP route inventory.
- Count completed tests in verification, retire all nine test quarantines with fresh passing evidence, and require verification of the release commit and official repository before publication.

### Workspace and MCP runtime

- Keep the built-in MCP package source canonical while preserving workspace edits and sharing installed dependencies safely.
- Preserve workspace isolation through MCP migration, process startup and portable-worker transfer.
- Preserve cancelled Codex resume sessions without silently starting a fresh conversation.

Known limitation: Personas remain experimental. The full offline 28-day simulation completed all 560 activities and passed recovery, retention and learning checks, but one daily event-append p95 was 169.69 ms against a 150 ms limit. Twelve of thirteen criteria passed; overall endurance acceptance did not. This release does not claim indefinite unattended reliability. See the [September 16 remediation record](docs/audits/2026-09-16-remediation.md) for validation scope and the [original audit](docs/audits/2026-09-16-project-audit.md) for the pre-fix findings.

## [3.45.2] — 2026-09-06

- Retry current-process identity lookup during cold Windows PowerShell startup, share concurrent lookup work, and cache successful results.
- Preserve Persona lock ownership/PID-reuse checks; invalid identity results fail closed.
- Report concise startup diagnostics without subprocess output or environment details.

Includes the capabilities and limitations of 3.45.1 below. [Release notes](https://github.com/mario-andreschak/FLUJO/releases/tag/v3.45.2) · [Changes](https://github.com/mario-andreschak/FLUJO/compare/v3.45.1...v3.45.2).

## [3.45.1] — 2026-09-06

- Add experimental persistent Personas, reusable Roles, durable memory, goal follow-up/recovery, and owner pause/continue/stop controls.
- Add portable authenticated cloud-worker execution, supported credential/dependency transfer, and native private discovery.
- Improve MCP credential storage, conversations, model connections, automation/meetings, corporate-network installation, and release argument handling.

Known limitation: this version's clean Windows startup test failed during process-identity initialization; 3.45.2 contains the fix. Personas and MCP Skills remain experimental. Controlled goal acceptance does not establish indefinite unattended reliability. Browser capture/recording exceptions remain tracked. Worker snapshots can contain transferable credentials and must be treated as secrets.

[Release notes](https://github.com/mario-andreschak/FLUJO/releases/tag/v3.45.1) · [Changes](https://github.com/mario-andreschak/FLUJO/compare/v3.45.0...v3.45.1). See [all earlier releases](https://github.com/mario-andreschak/FLUJO/releases) for version-specific history before these summaries.

## Earlier entries retained from the legacy changelog

The following previously unversioned entries predate the current stabilization work; their exact release attribution was not recorded here.

### Fixed
- Bash MCP now explicitly substitutes Windows PowerShell 5.1 only when an explicit `pwsh`
  request cannot find PowerShell 7, reporting the requested shell, effective shell, and reason (#314).
- Bash MCP preflights missing command heads (including pipeline stages) with locale-independent
  diagnostics and adds an exit-code hint for common executable-not-found failures (#314).
- Bash MCP ignores WSL relay launchers when resolving Git Bash and recognizes multi-letter switches
  for Windows file utilities without treating them as external POSIX paths (#314).
- Bash MCP now detects Windows slash switches per command segment, so `cd … && dir /b && rg …` and
  `echo dir /b` no longer report `/b` as a path outside the working roots, while genuine advisories
  (`echo /etc/passwd`, `dir /b && echo /etc/passwd`) are preserved. All seven calls reported in #314
  are pinned by the new `__tests__/mcp/bashIssue314.test.ts` regression suite (#314).
- OpenRouter multimodal chat models (e.g. `outputModalities: ["text","image"]`) were routed to the
  dedicated `/images` / `/videos` media endpoints and failed with a route-not-found error even for
  plain text turns (#370). Routing to the dedicated media route is now reserved for models that are
  media-only (image/video output without text), via a single shared `resolveOpenRouterMediaRoute`
  helper used by both execution and the model-card test.
- Static node `injectOnce` behaved as "once per *conversation*" instead of the documented "once per
  *run*": the injection marker was persisted on the shared run state and never reset, so an
  `injectOnce` node silently injected nothing from the second user turn onward (#381). The marker
  is now keyed by `(logicalRunId, nodeId)`, so a paused/resumed run still dedupes while every new
  user turn injects again; stale markers from earlier runs are pruned.
- Author-time validation no longer reports a hard `static-toolcall-invalid-json` error for static
  tool-call arguments that legitimately contain `${var:…}` / `${res:…}` placeholders in non-string
  positions (e.g. `{"n": ${var:COUNT}}`); such entries now raise the advisory
  `static-toolcall-unverifiable-json` warning instead and are parsed at run time (#381).

### Added
- Agents can now create guarded dashboard tickets for human review, with label pills, related conversation/flow links, a full searchable list with status/label filters, mark-as-done, multi-select and bulk deletion, fully localized in all seven UI languages; "Ask FLUJO" pre-fills the chat composer with a clearly delimited (untrusted) ticket excerpt, and the `/api/tickets` routes are local-only (#379).
- Experimental `experimental.subflowSessions` flag gating resumable Subflow child conversations, with FlowBuilder controls for `per-run` and `per-key` scopes. A Process handoff can now pass a stable `sessionKey`; reusing it appends the task as a follow-up turn to that finished child conversation while retaining its transcript (#363/#391).
- The model card "Test" dialog now shows which adapter/endpoint the flow engine actually resolves
  for a model (`Adapter used by flows`) and exercises that exact adapter, so a green test result now
  matches real chat behaviour.
- OpenRouter media adapter errors are now mapped to an actionable message naming the model and
  endpoint when a dedicated media route genuinely 404s.
- Static node re-entry semantics are now specified in
  [docs/features/flows/static-node.md](docs/features/flows/static-node.md#re-entry-semantics):
  append-on-every-traversal by default, `injectOnce` meaning once per logical run, the
  `(logicalRunId, nodeId)` dedupe key, use cases, edge cases and the validation-rule table (#381).
- New advisory validation rule `static-injectonce-without-loop`: `injectOnce` on a static node
  that is not on a control-flow cycle has no effect and is now flagged as a warning (#381).

## [0.1.3] - 2025-04-07

### Added
- Handoff tools in flowbuilder for improved flow control
- Agent Tools tab in Process Node properties modal
- Message editing functionality in chat interface
- Background execution capabilities for improved performance
- FlujoChatMessage Type for better internal message handling
- Debugging capabilities with step-by-step execution (disabled until ready)
- DebuggerCanvas component for visualizing flow execution (disabled until ready)

### Fixed
- Timestamp validation and handling issues
- Improved error handling in flow execution
- Enhanced logging for better debugging
- Fixed issues with handoff tool generation in ProcessNode

### Changed
- Refactored ProcessNodePropertiesModal for better organization
- Updated UI styling for handoff tools
- Improved API response handling

## [0.1.2] - 2025-03-14

- Flowbuilder UI Rework
- React Re-Rendering Issues
- better stop_reason handling
- better chat experience

## [0.1.1] - Initial Release
