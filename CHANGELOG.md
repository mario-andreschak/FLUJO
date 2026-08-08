# Changelog

## [Unreleased]

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
- Experimental `experimental.subflowSessions` flag gating resumable Subflow child conversations, with an Experimental-features toggle and user documentation for the `per-run` session scope (#391, follow-up to #363).
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
