# FlowSpec node-type inclusion policy

Decision record for issue #380 ("Formalize Static Node FlowSpec Decision"), and the
reusable rule for classifying every future `NodeType` addition.

User guide: [Static node](../features/flows/static-node.md).

## Context

FLUJO has two authoring surfaces for the same runtime:

- **FlowSpec** (`src/utils/shared/flowSpecCompiler.ts`, documented for authors/models in
  `src/utils/shared/flowSpecDoc.ts`) — the semantic authoring contract used by the AI flow
  generator, AI-Improve, and the MCP flow-authoring tools (`create_flow` / `validate_flow_spec`
  in advanced mode).
- **ReactFlow definition** (`Flow.nodes` / `Flow.edges`) — the runtime/canvas format the
  FlowBuilder UI edits directly and the engine executes.

`compileFlowSpec` turns a FlowSpec into a ReactFlow definition; `flowToSpec` does the reverse
(used by AI-Improve to re-summarize an existing flow before asking the model to edit it, and by
the MCP `draft_flow`/inspection tools). **Every node type in the ReactFlow `NodeType` union must
either appear in the `FlowSpecNode.type` union with real compile/decompile branches, or be
deliberately excluded with a documented reason** — there is no third option. Silently omitting a
type from the union means `flowToSpec` skips it, which **deletes that node** the next time the
flow round-trips through AI-Improve. This is not a doc gap, it's a data-loss bug — it happened to
`signal` (issue #117) and, until this decision, to `static` (issue #358/#380).

## Inclusion criteria

A node type belongs in the `FlowSpecNode.type` union — and must ship a compile branch, a
decompile branch, and a round-trip test — when **all** of the following hold:

1. **Graph-visible control node.** It sits on the canvas and is reached by ordinary
   (non-attachment) edges that participate in flow control or explicit data wiring.
2. **Fully declarative semantics.** Everything the node needs is expressible as serializable
   properties — no ids, coordinates, or handle wiring the compiler has to invent on the author's
   behalf.
3. **Author-selectable.** An author (human or the generator model) can reasonably choose this
   node type when describing intent in a spec, independent of any other node's configuration.

## Exclusion criteria

A node type is deliberately kept OUT of the `FlowSpecNode.type` union when it is:

- **An attachment**, configured through another node's properties rather than placed on the
  graph as its own authored step (`mcp` — attached via a process node's `servers` list; a spec
  never emits an `mcp` node, and the compiler rejects one that tries with `mcp-node-not-allowed`).
- **An externally-triggered entry point** whose configuration lives outside the flow graph
  proper (`trigger` — schedule/webhook/event configuration, not a step an author places inline).

Every exclusion MUST carry an inline rationale comment next to the `FlowSpecNode.type` union
(see `flowSpecCompiler.ts`) so a future reader does not mistake an omission for "not yet gotten to.”

## Current classification table

| Node type | FlowSpec status | Authoring profile | Reason |
|---|---|---|---|
| `start` | Included | Guided | Core control node; every flow has exactly one. |
| `process` | Included | Guided | Core control node; the primary authored step. |
| `finish` | Included | Guided | Core control node; terminal step. |
| `subflow` | Included | Guided | Core control node; child-flow invocation. |
| `resource` | Included | **Advanced** | Data artifact; declarative binding (`server`+`uri` or `runName`). Fixed for round-trip loss like `signal`. |
| `signal` | Included | **Advanced** | Pass-through event emitter (`topic`+`payloadTemplate`); fixed for round-trip loss in issue #117. |
| `static` | Included | **Advanced** | Pass-through conversation injector (`entries`+`injectOnce`); this decision (#380) fixes the same class of round-trip loss. |
| `mcp` | Excluded | — | Attachment configured via a process node's `servers`, never authored as a standalone spec node. |
| `trigger` | Excluded | — | Externally-triggered entry point configured outside the flow graph. |

## Decision for #380: `static` is INCLUDED, Advanced profile

`static` (issue #358) is a plain pass-through control node — like `signal` and `resource`, it
carries no LLM call and its entire behavior fits in two declarative properties (`entries`,
`injectOnce`). It satisfies all three inclusion criteria and none of the exclusion criteria.
Before this change it was implemented everywhere at runtime (`StaticNode.ts`, `flowValidation.ts`,
`connectionRules.ts`, UI palette, property modal, i18n) but missing from the `FlowSpecNode.type`
union, the compile guard, and the decompile guard — an omission, not a deliberate exclusion, with
the concrete consequence that any flow containing a static node lost that node when round-tripped
through AI-Improve (`flowToSpec` silently drops unknown node types).

**Resolution:**
- `static` is added to the `FlowSpecNode.type` union with `entries?: FlowSpecStaticEntry[]` and
  `injectOnce?: boolean`, mirroring the runtime `StaticEntry` shape
  (`src/backend/execution/flow/types.ts`).
- Both the compile guard and the decompile guard accept `static`; both directions have a real
  branch, so a static node now survives `compileFlowSpec` → `flowToSpec` → `compileFlowSpec`
  unchanged (entries and `injectOnce` included).
- `entries` is untrusted spec input (may originate from the generator model or an external MCP
  authoring client) and is sanitized field-by-field at compile time rather than spread verbatim:
  only `message` entries with an allow-listed `role` and string `content`, and `toolCall` entries
  with string `toolName`/`argumentsJson`/`result`, survive; malformed entries are dropped with a
  `static-invalid-entry` warning, invalid tool-call JSON is flagged with
  `static-toolcall-invalid-json`, and the entry count is capped (`MAX_STATIC_ENTRIES`) so a
  generated spec cannot balloon a flow definition.
- Classified **Advanced** profile: it is documented in `FLOWSPEC_DOC` marked OPTIONAL/advanced,
  and it is intentionally absent from the Guided allow-list in
  `src/utils/shared/flowAuthoringProfile.ts` (`flowUsesAdvancedFeatures`) and from
  `src/utils/shared/simpleFlowSpec.ts`'s `SimpleFlowStep` — a flow containing a `static` node is
  correctly flagged as using advanced features, and Guided/simple authoring cannot emit one
  directly. This matches how `resource` and `signal` are already handled.

## Implications for future node types

Whenever a new `NodeType` is added to the runtime (`src/backend/execution/flow/types.ts`), before
the feature is considered done:

1. **Classify it** against the inclusion/exclusion criteria above.
2. **If included:**
   - Add it to the `FlowSpecNode.type` union, the compile guard (`compileFlowSpec`), and the
     decompile guard (`flowToSpec`), plus a real compile branch and a real decompile branch —
     never just widen the union without both branches.
   - Sanitize any structured/untrusted property field-by-field on compile; never spread spec
     input verbatim into node properties.
   - Add a round-trip test asserting `flowToSpec(compileFlowSpec(spec).flow)` preserves the new
     node and its properties (see `__tests__/flow/flowSpecCompilerStatic.test.ts` and
     `flowSpecCompilerSignal.test.ts` for the pattern).
   - Document it in `FLOWSPEC_DOC` (`flowSpecDoc.ts`), stating its authoring profile.
   - Decide and document its Guided vs. Advanced classification (usually Advanced unless it is a
     core control node every flow needs).
3. **If excluded:** add an inline rationale comment next to the `FlowSpecNode.type` union
   explaining why (attachment? externally-configured entry point? something else — but it must be
   a real reason, not "not yet implemented").
4. **Update this document's classification table** either way, so the next person doesn't have to
   re-derive the decision from the source.

**Round-trip invariant:** any node type present in the `FlowSpecNode.type` union must survive
`compileFlowSpec` → `flowToSpec` without data loss. If a type is in the union without a decompile
branch (or vice versa), that is a bug, not a valid intermediate state.

## Out of scope

- Adding `mcp` or `trigger` to FlowSpec — both remain attachments/external entry points.
- Promoting `static` (or `signal`/`resource`) into the Guided/`SimpleFlowSpec` profile.
- Any change to static-node runtime execution semantics.
