# FlowSpec ↔ FlowBuilder UI Coverage

> **Issue #186** — Review & document the gaps between what the **FlowBuilder UI** can
> author and what is expressible through the **Flow DSL (FlowSpec)** / AI flow generation.

This document is the authoritative audit of which FlowSpec capabilities the visual
**FlowBuilder** can currently author, versus those that today are only reachable through
the **AI generator** or the **`POST /api/flow/compile`** endpoint.

Keep it in sync with the canonical DSL text in
[`src/utils/shared/flowSpecDoc.ts`](../../src/utils/shared/flowSpecDoc.ts) and the
compiler in [`src/utils/shared/flowSpecCompiler.ts`](../../src/utils/shared/flowSpecCompiler.ts).

## TL;DR

FLUJO's FlowSpec DSL and the deterministic `FlowSpec → Flow` compiler are effectively
feature-complete, and the AI generator can emit the full DSL. The FlowBuilder UI, however,
exposes only a **subset** of these capabilities. The most impactful missing editors are:

- **Edge conditions** (deterministic, model-free routing).
- **Process-node input/output modes** and **prompt-exclusion flags** (state exists, no rendered controls).
- **Named-variable / resource / KV capture** (`captureVariable` / `captureResource` / `captureKv`).
- **Per-node `maxTurns` and `allowedTools`.**
- **Dynamic subflow fan-out** (`parallelFlowsVariable`, `mapOverList`) — today read-only alerts.

Until these editors ship, the way to author what the UI can't yet is the AI generator or a
FlowSpec posted to **`POST /api/flow/compile`** (also exposed through the built-in `flujo`
MCP server's `create_flow` / `validate_flow_spec` tools).

## Relevant modules

- **DSL / schema (authoritative):** `src/utils/shared/flowSpecCompiler.ts` — `FlowSpecNode`, `FlowSpecEdge`, `FlowSpec`, `compileFlowSpec()`, `applyGenerationDefaults()`.
- **DSL docs (generator prompt & `/docs`):** `src/utils/shared/flowSpecDoc.ts`.
- **Edge conditions (Tier 2b):** `src/utils/shared/edgeConditions.ts` — `EdgeCondition`, `evaluateCondition()`.
- **Generator:** `src/backend/services/flow/generateFlow.ts`; compile endpoint `src/backend/services/flow/compileFlow.ts` (`POST /api/flow/compile`).
- **FlowBuilder UI root:** `src/frontend/components/Flow/FlowManager/FlowBuilder/` (Canvas, CustomNodes, CustomEdges, Modals, ContextMenu, NodePalette).
- **Node property modals:** `Modals/ProcessNodePropertiesModal.tsx`, `SubflowNodePropertiesModal.tsx`, `FinishNodePropertiesModal.tsx`, `StartNodePropertiesModal.tsx`, `MCPNodePropertiesModal.tsx`, `ResourceNodePropertiesModal.tsx`, `SignalNodePropertiesModal.tsx`.
- **Edge creation / rules:** `Canvas/utils/edgeUtils.ts`, `connectionRules.ts`, `nodeUtils.ts`.
- **UI node factory:** `src/frontend/services/flow/index.ts` (`createNode`).

## Capability matrix — DSL vs. FlowBuilder UI

Legend: ✅ supported · ⚠️ partial (state loaded / read-only) · ❌ not in UI

| Capability | DSL / Generation | FlowBuilder UI | Gap |
|---|---|---|---|
| 7 node types (start/process/finish/mcp/subflow/resource/signal) | ✅ | ✅ create/delete | — |
| Process: model binding, prompt template, server tools | ✅ | ✅ | — |
| Process: `inputMode` (full-history/latest-message/isolated) | ✅ | ⚠️ state loaded, no editor | **Gap** |
| Process: `outputMode` (full-conversation/latest-message) | ✅ | ⚠️ state loaded, no editor | **Gap** |
| Process: `excludeModelPrompt` / `excludeStartNodePrompt` / `excludeSystemPrompt` | ✅ | ⚠️ state vars exist, not rendered | **Gap** |
| Process: `maxTurns` | ✅ | ❌ | **Gap** |
| Process: `allowedTools` (step-level allowlist) | ✅ | ❌ | **Gap** |
| Process/Subflow: `captureVariable` (`${var:NAME}`) | ✅ | ❌ (insert-only in prompt) | **Gap** |
| Process/Subflow: `captureResource` (`${res:NAME}`) | ✅ | ❌ | **Gap** |
| Process/Subflow: `captureKv` (`${kv:NAME}`) | ✅ | ❌ | **Gap** |
| Edge conditions (contains/regex/equals/always, target, ignoreCase, negate) | ✅ (infra in `edgeUtils.ts`) | ❌ no editor; edge context menu has no "Edit Properties" | **Gap (high value)** |
| Bidirectional edge toggle | ✅ | ⚠️ right-click exists but undiscoverable | **Gap (discoverability)** |
| Resource-edge (data-flow) creation | ✅ | ⚠️ shown read-only; not user-creatable via context menu | **Gap** |
| Subflow: single/parallel-static/spawnBriefs/allowCallerFanout/allowCallerPrompt/concurrency/errorStrategy/joinSeparator | ✅ | ✅ | — |
| Subflow: `inputMode` / `outputMode` | ✅ | ✅ | — |
| Subflow: `parallelFlowsVariable` (dynamic fan-out) | ✅ | ⚠️ read-only alert | **Gap** |
| Subflow: `mapOverList` + `itemSplit` + `sequential` | ✅ | ⚠️ read-only alert | **Gap** |
| Signal node (`topic`, `payloadTemplate`) | ✅ | ⚠️ modal exists; wiring/coverage to verify | **Verify** |
| Finish node label normalization | ✅ (generator may emit any label) | ✅ hardcoded "Finish Node" | **Fixed (#188)** |

## Finish-node label normalization (#188 — implemented)

Finish nodes are identified by **type** (`'finish'`), not label. The UI always renders the
canonical `"Finish Node"` label (`createNode` in `src/frontend/services/flow/index.ts`,
read-only modal), but the AI generator may emit **any** custom `label` for a finish node via
FlowSpec, producing inconsistent naming.

**Fix:** `applyGenerationDefaults()` in `src/utils/shared/flowSpecCompiler.ts` now forces
`node.data.label = 'Finish Node'` for every `node.type === 'finish'`, alongside the existing
process-node input/output defaults. Because `applyGenerationDefaults()` is called for the root
flow and every nested subflow bundle in `generateFlow.ts`, finish nodes are normalized at all
nesting levels.

## How to author what the UI can't yet

Anything marked ⚠️ or ❌ above can still be authored **outside the canvas**:

1. **AI generator** — describe the flow; the generator emits the full DSL (edge conditions,
   capture fields, dynamic fan-out, etc.).
2. **`POST /api/flow/compile`** — send a hand-written FlowSpec (see `flowSpecDoc.ts` for the
   full grammar) and the deterministic compiler produces a canvas-compatible flow.
3. **Built-in `flujo` MCP server** — `validate_flow_spec` / `create_flow` accept the same
   FlowSpec contract.

Flows authored this way round-trip through the canvas: the compiler only writes optional fields
(e.g. `edge.data.condition`) when present, so plain edges/nodes stay byte-compatible with
UI-authored ones.

## Prioritized backlog to close the UI gaps

Each slice is independently reviewable and a candidate sub-issue. The issue is titled
"review and document", so this document (Phase 0) plus #188 is the committed deliverable; the
following are proposed follow-ups.

1. **Phase 1 — quick wins (half-built):** render process `inputMode` / `outputMode`,
   `excludeModelPrompt` / `excludeStartNodePrompt` / `excludeSystemPrompt` toggles, and a
   numeric `maxTurns` field in `ProcessNodePropertiesModal.tsx`.
2. **Phase 2 — edge conditions (highest-value net-new UI):** an "Edit Properties" edge context
   menu entry + a new `EdgePropertiesModal` editing `EdgeCondition`, persisted to
   `edge.data.condition`; a visual badge on conditional edges; make the bidirectional toggle
   discoverable.
3. **Phase 3 — data-flow capture editors:** `captureVariable` / `captureResource` / `captureKv`
   fields (with `${var:}` / `${res:}` / `${kv:}` insert helpers and a KV scope selector) in the
   process & subflow modals.
4. **Phase 4 — dynamic subflow fan-out editors:** turn the read-only `parallelFlowsVariable` and
   `mapOverList` (+ `itemSplit`, `sequential`) alerts in `SubflowNodePropertiesModal.tsx` into
   real editors.
5. **Phase 5 — signal / resource node coverage verification:** confirm `SignalNodePropertiesModal`
   and `ResourceNodePropertiesModal` are fully wired into the canvas/palette; document or fix gaps.

## Constraints observed by the follow-up work

- **UI/compiler parity:** edges/nodes authored in the UI must stay byte-compatible with compiler
  output (`edgeUtils` spreads `condition` only when present — preserve this).
- **Backward compatibility:** new optional fields default to current behavior; never break saved flows.
- **Keep this doc in sync** with `flowSpecDoc.ts` whenever the DSL grows or a gap closes.
