# Shared model-input and wire-preview contract

`src/shared/types/execution/modelInput.ts` owns the seven data shapes used by
debugger producers and frontend readers: wire status, message provenance,
model-input snapshots, preview availability reasons, warning codes/warnings,
and preview responses. Its imports and exports are type-only.

Backend execution types retain compatibility type reexports. Debugger components
and the frontend chat service import the shared shapes directly. Chat's debugger
state uses the separate [shared state view](./debugger-state-view.md).

`ModelInputSnapshot` retains the existing bounded message/provenance fields and
late-wire compaction diagnostics. Its producers remain `buildNodeContext.ts`,
`ModelHandler.ts` and their snapshot helpers. Those producers own projection,
content limits and privacy; a type definition does not enforce redaction.

`WirePreviewResponse.mode` remains `current-preview`, with explicit available
or unavailable status, warnings and unavailable reasons. Provider finalization,
resource resolution, tool configuration and historical projection can be
omitted from a current preview. Readers retain those qualifications. Actual SDK
dispatch/archive identity remains with the separate `modelTurn` contract.

The extraction preserves the seven declaration bodies and changes consumer
type imports. It changes no request/response fields, renderer, event handling,
dispatch, privacy filter or permission. The import guard no longer needs the
wire-DTO frontend-to-backend allowances.
