# Shared model-input and wire-preview contract

`src/shared/types/execution/modelInput.ts` owns the seven data shapes used by
debugger producers and frontend readers: wire status, message provenance,
model-input snapshots, preview availability reasons, warning codes/warnings,
and preview responses. It exports types only. The existing shared chat,
compaction-diagnostic and OpenAI message types remain its type dependencies.

The backend execution types retain compatibility type reexports. Debugger
conversation/model-input components and the frontend chat service import the
shared shapes directly. The main Chat component imports these DTOs from shared
while its existing `SharedState` dependency remains named debt. Runtime state,
authority and execution capabilities remain backend contracts.

`ModelInputSnapshot` retains the existing bounded message/provenance fields and
late-wire compaction diagnostics. Its producers remain `buildNodeContext.ts`,
`ModelHandler.ts` and their snapshot helpers. Those producers own projection,
content limits and privacy; a type definition does not enforce redaction.

`WirePreviewResponse.mode` remains `current-preview`, with explicit available
or unavailable status, warnings and unavailable reasons. Provider finalization,
resource resolution, tool configuration and historical projection can be
omitted from a current preview. Readers retain those qualifications. Actual SDK
dispatch/archive identity remains with the separate `modelTurn` contract.

The extraction preserves all seven declaration bodies and emitted JavaScript
of the five affected backend/frontend modules. The new shared module emits only
`export {}`. It changes no request/response fields, renderer, event handling,
dispatch, privacy filter or permission. Maturity's stream-recovery work can be
sequenced independently because this slice changes only consumer type imports.

Use the debugger-input, node-context, debugger-frame, wire-compaction,
visual-compaction and dispatch-archive regressions when changing these shapes.
The import guard removes three old wire-DTO crossings and narrows the existing
Chat allowance to `SharedState`; it adds no allowance. A reviewed shared view
for the remaining Chat/DebuggerCanvas runtime-state imports is still needed.
The source comparison supplies neither installed-release nor human-maintenance
or agreed-performance acceptance for #571.
