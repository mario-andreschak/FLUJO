# Shared debugger state view

`src/shared/types/execution/debuggerState.ts` describes the fields Chat and
DebuggerCanvas read from existing debug responses. It owns the consumer state,
completed-step and safe-boundary views. Its dependencies are shared chat, flow,
tracking, invocation and model-input types, plus OpenAI tool-call types. All
imports and exports are type-only.

The backend `SharedState` interface extends `DebuggerStateView`, retaining its
existing fields and private execution capabilities. This inheritance makes
typecheck enforce producer compatibility, including trace and boundary shapes.
Frontend consumers and the shared graph-edge helper use the views directly;
they no longer depend on backend execution types.

The view names no execution authority, abort signal, provider client, extension
context or MCP dispatch capability. Completed-step state/results remain opaque
values for the existing JSON inspector. The boundary snapshot exposes its
message count; the inspector still displays the full supplied snapshot. These
types neither copy nor filter responses. Existing producers retain serialization,
redaction, persistence and privacy ownership; changing a type alone removes no
data from a response and grants no permission.

This migration changes only type declarations, imports and annotations. The
emitted JavaScript of the backend state module, Chat, DebuggerCanvas and graph
helper must remain identical. Existing boundary graph, debugger-frame,
executed-path, model-input, pause/step and Chat consumer regressions apply when
evolving the contract. The two old frontend runtime-state debt declarations are
removed without adding an allowance. Combined with the separate geometry,
package and model-input migrations, the direct-layer import debt reaches zero.

The direct import guard does not prove transitive client-bundle isolation,
installed behavior or a security sandbox. Release/operator, agreed performance,
second-human maintenance and independent scorecard acceptance remain separate
gates for #571.
