# Shared debugger state view

`src/shared/types/execution/debuggerState.ts` describes the fields Chat and
DebuggerCanvas read from existing debug responses. It owns the consumer state,
completed-step and safe-boundary views. Its dependencies are shared chat, flow,
tracking, invocation and model-input types, plus OpenAI tool-call types. All
imports and exports are type-only.

The backend `SharedState` interface extends `DebuggerStateView`, retaining its
existing fields and private execution capabilities. Typecheck enforces producer
compatibility, including trace and boundary shapes. Frontend consumers and the
shared graph-edge helper use the views directly.

The view names no execution authority, abort signal, provider client, extension
context or MCP dispatch capability. Completed-step state/results remain opaque
values for the existing JSON inspector. The boundary snapshot exposes its
message count; the inspector still displays the full supplied snapshot. These
types neither copy nor filter responses. Existing producers retain serialization,
redaction, persistence and privacy ownership.

This migration changes type declarations, imports and annotations. Runtime
payloads and debugger behavior remain the same. The frontend/backend import
guard now has no named exceptions.
