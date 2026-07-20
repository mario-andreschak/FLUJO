/**
 * Resolve a flow's Start node by its TYPE, not by array position.
 *
 * The flow "start" node is the node whose kind is `'start'` — it is NOT
 * guaranteed to be at `nodes[0]`. Flows can be reordered in the FlowBuilder,
 * produced by the flow generator, or imported/auto-repaired, none of which
 * preserve index-0 ordering. Picking `nodes[0]` therefore attaches the wrong
 * node id to a turn (including the error-resume path) — see issue #174.
 *
 * This mirrors the canonical pattern already used across the backend
 * (`runFlow.ts`, `FlowConverter.ts`, `PromptRenderer.ts`, `flowAutoRepair.ts`),
 * which all resolve the start node via `node.type === 'start'`.
 *
 * The node kind lives at the top-level `type` on the ReactFlow node, but is
 * also mirrored on `data.type` (see `FlowNode` in `@/shared/types/flow`). This
 * helper checks top-level `type` first and falls back to `data?.type` so it is
 * tolerant of either shape.
 *
 * Pure data-in/data-out: synchronous, no crypto, no side effects, no logging.
 * Safe for both backend and browser.
 */
import { Flow, FlowNode } from '@/shared/types/flow';

/** Return the flow's Start node (by `type === 'start'`), or `undefined`. */
export function getStartNode(flow: Flow | undefined | null): FlowNode | undefined {
  return flow?.nodes?.find((n) => (n?.type ?? n?.data?.type) === 'start');
}

/** Return the id of the flow's Start node, or `undefined`. */
export function getStartNodeId(flow: Flow | undefined | null): string | undefined {
  return getStartNode(flow)?.id;
}
