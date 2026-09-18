# Changelog

## [Unreleased]

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
