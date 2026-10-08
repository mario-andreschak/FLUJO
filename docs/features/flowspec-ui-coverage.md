# Flow authoring profiles

FLUJO has one flow runtime and two authoring profiles. Both profiles compile to
the same ReactFlow-compatible definition and execute through the same engine.

## Guided profile

Guided is the default for the Flow Builder, MCP authoring tools, and automatic
generation. It is designed for humans who want to describe work and for compact
models that should not have to choose runtime plumbing.

The guided builder exposes:

- Process steps: label, task, model, and server tools.
- Finish steps.
- Run Another Flow steps: helper flow, label, and task.
- A compact `SimpleFlowSpec` with ordered steps and optional routes.

Start and Finish nodes, ordinary history handoff, layout, node ids, handles,
edges, and common input/output defaults are inferred.

## Advanced profile

Advanced is opt-in and preserves the complete FlowSpec and builder surface:

- MCP, Resource, Signal, Trigger, and Static nodes (see
  `docs/architecture/flowspec-node-inclusion-policy.md` for why each node type
  is Guided vs. Advanced vs. excluded from FlowSpec entirely).
- Prompt composition and input/output modes.
- Conditional/bidirectional edges.
- Variables, subflow resource capture, persistent KV state, and explicit
  Process → Resource artifact production.
- Subflow child-job queues and their maximum simultaneous-child setting.
- Unattended execution.

The builder preference is stored under `flujo-ui:flow-builder:mode`. When a flow
contains advanced behavior while Guided is selected, the builder shows a
non-destructive notice. Hidden properties remain in the saved node data; Guided
editors do not seed, clear, or rewrite them.

## Programmatic authoring

| Operation | Default | Advanced access |
|---|---|---|
| `create_flow` | SimpleFlowSpec | `profile: "advanced"` or legacy `nodes` + `edges` auto-detection |
| `validate_flow_spec` | SimpleFlowSpec | same compatibility behavior |
| `draft_flow` | SimpleFlowSpec, never saves | same compatibility behavior |
| `get_flow_authoring_guide` | compact schema and rules | `profile: "advanced"` returns the complete FlowSpec guide |
| `POST /api/flow/compile` | existing advanced contract | unchanged for backward compatibility |

The canonical guided schema and lowerer live in
`src/utils/shared/simpleFlowSpec.ts`. The complete DSL remains in
`src/utils/shared/flowSpecCompiler.ts` and `src/utils/shared/flowSpecDoc.ts`.

## Data handoff

Guided flows use conversation history for ordinary step-to-step data. They do
not expose variable, resource, or KV capture.

In Advanced mode:

- `${var:NAME}` reads a run variable.
- `${res:NAME}` reads a run resource.
- `${kv:NAME}` reads persistent cross-run state.
- Subflows may passively capture their concrete folded output as a resource.
- Processes produce tracked artifacts through an explicit Resource node and the
  `write_resource` tool; passive Process `captureResource` is unsupported.

`read_resource` dereferences run-resource or native MCP URIs. It is unrelated to
KV resolution, and ordinary `${res:...}` / `${kv:...}` prompt references are
resolved by the backend before the model call.

## Compatibility rules

- Switching profiles never removes properties or nodes.
- Existing advanced FlowSpecs continue to compile.
- Legacy Subflow fan-out, map-over-list, authored briefs, joins, and error
  strategies remain readable but are no longer part of normal authoring.
- Existing saved flows open in Guided mode with an advanced-feature notice.
- The vendored Flow Generator is seeded only when missing and is never
  overwritten on startup. Restoring its bundled definition is explicit.
- Generated drafts are not saved until the user opens them in the builder and
  chooses Save.
