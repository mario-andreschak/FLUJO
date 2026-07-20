/**
 * Handoff-pill migration on node rename (issue #178).
 *
 * A handoff tool's name is derived from the *slug of its target node's label*
 * (see `handoffNaming.ts`). When a handoff-target node (ProcessNode,
 * SubflowNode, Signal/Stop Node, Finish Node) is renamed in the FlowBuilder,
 * that derived tool name changes — but the pills that reference it inside a
 * *predecessor* node's `promptTemplate` (e.g. `${tool:handoff__handoff_to_process_b}`)
 * are not rewritten, so they silently point at a tool name that no longer
 * exists. This module rewrites those pills as part of the same state update
 * that applies the rename.
 *
 * The naming is recomputed *per predecessor node* using the SAME target-set
 * logic as `useHandoffTools` (the hook that generates the pills the user
 * inserts in the first place): a node's handoff targets are the targets of its
 * outgoing non-attachment edges, plus the sources of bidirectional edges
 * pointing at it. This keeps collision suffixes (`handoff_to_x`,
 * `handoff_to_x_2`, …) consistent with what the user actually sees and inserts,
 * and mirrors how the runtime scopes handoff tools to a single source node.
 *
 * Pure and React-free so it can be unit tested and run inside a `setNodes`
 * updater (making the rewrite a single, undoable history step with the rename).
 */
import type { FlowNode } from '@/shared/types/flow';
import type { Edge } from '@xyflow/react';
import { buildHandoffToolNameMap, type HandoffTargetRef } from '@/shared/utils/handoffNaming';
import { findBindings, encodeBindingPill } from '@/utils/shared/mcpBinding';

/**
 * Handoff targets of `nodeId`: targets of its outgoing non-attachment edges,
 * plus the sources of bidirectional edges pointing at it. Order is preserved
 * (deduped, first occurrence wins) so it matches `useHandoffTools`'
 * `findConnectedNonMCPNodes` and therefore the collision-suffix assignment.
 */
export function findHandoffTargetIds(nodeId: string, edges: Edge[]): string[] {
  const targets: string[] = [];
  for (const edge of edges) {
    // Attachment edges (MCP tool wiring / resource data wiring) are never
    // handoff targets.
    const isAttachmentEdge =
      typeof edge.data?.edgeType === 'string' &&
      (edge.data.edgeType.includes('mcp') || edge.data.edgeType === 'resource');
    if (isAttachmentEdge) continue;
    if (edge.source === nodeId) {
      targets.push(edge.target);
    } else if (
      edge.target === nodeId &&
      (edge.data as { bidirectional?: boolean } | undefined)?.bidirectional
    ) {
      targets.push(edge.source);
    }
  }
  return [...new Set(targets)];
}

/** Build the `{ id, label, type }` ref a target node contributes to the name map. */
function toTargetRef(node: FlowNode): HandoffTargetRef {
  return { id: node.id, label: node.data.label, type: node.type || node.data.type };
}

/**
 * Rewrite handoff pills inside a single prompt template.
 *
 * Only pills whose parsed handoff tool name is a key of `renameMap` are
 * touched; every other pill (regular MCP tool/resource pills, unrelated handoff
 * pills) and all free-text is preserved byte-for-byte. A renamed pill is always
 * re-emitted in the canonical `${tool:handoff__<name>}` form, which normalizes
 * any legacy-format handoff pill on the way through. Returns the original
 * string reference when nothing changed.
 */
function rewritePromptTemplate(text: string, renameMap: Map<string, string>): string {
  if (!text || renameMap.size === 0) return text;
  const matches = findBindings(text);
  if (matches.length === 0) return text;

  let result = '';
  let cursor = 0;
  let changed = false;
  for (const m of matches) {
    result += text.slice(cursor, m.index);
    const newName =
      m.kind === 'tool' && m.server === 'handoff' ? renameMap.get(m.name) : undefined;
    if (newName) {
      result += encodeBindingPill('tool', 'handoff', newName);
      changed = true;
    } else {
      result += m.fullMatch;
    }
    cursor = m.index + m.fullMatch.length;
  }
  result += text.slice(cursor);
  return changed ? result : text;
}

/**
 * Given the node arrays before and after a label edit (plus the flow's edges),
 * return a new node array in which every predecessor's `promptTemplate` has its
 * handoff pills updated to the new tool names. When no handoff tool name
 * actually changed, `nextNodes` is returned unchanged.
 *
 * @param prevNodes nodes as they were before the edit (used to derive old names)
 * @param nextNodes nodes after the edit (used to derive new names; returned, patched)
 * @param edges     the flow's edges (unchanged by a rename)
 */
export function migrateHandoffPills(
  prevNodes: FlowNode[],
  nextNodes: FlowNode[],
  edges: Edge[]
): FlowNode[] {
  const prevById = new Map(prevNodes.map(n => [n.id, n]));
  const nextById = new Map(nextNodes.map(n => [n.id, n]));

  // Nothing can have changed if no label actually changed.
  let anyLabelChanged = false;
  for (const [id, next] of nextById) {
    const prev = prevById.get(id);
    if (prev && prev.data.label !== next.data.label) {
      anyLabelChanged = true;
      break;
    }
  }
  if (!anyLabelChanged) return nextNodes;

  return nextNodes.map(node => {
    const template = node.data.properties?.promptTemplate;
    if (typeof template !== 'string' || !template) return node;

    const targetIds = findHandoffTargetIds(node.id, edges);
    if (targetIds.length === 0) return node;

    // Old names use the pre-edit labels; new names use the post-edit labels.
    // Fall back to the post-edit node when a target didn't exist before, so a
    // brand-new target never registers as a rename.
    const beforeRefs: HandoffTargetRef[] = [];
    const afterRefs: HandoffTargetRef[] = [];
    for (const id of targetIds) {
      const nextTarget = nextById.get(id);
      if (!nextTarget) continue; // target no longer exists; leave pills as-is
      const prevTarget = prevById.get(id) || nextTarget;
      beforeRefs.push(toTargetRef(prevTarget));
      afterRefs.push(toTargetRef(nextTarget));
    }
    if (afterRefs.length === 0) return node;

    const beforeMap = buildHandoffToolNameMap(beforeRefs);
    const afterMap = buildHandoffToolNameMap(afterRefs);

    // oldName -> newName for every target whose derived tool name changed.
    const renameMap = new Map<string, string>();
    for (const id of targetIds) {
      const oldName = beforeMap.get(id);
      const newName = afterMap.get(id);
      if (oldName && newName && oldName !== newName) {
        renameMap.set(oldName, newName);
      }
    }
    if (renameMap.size === 0) return node;

    const rewritten = rewritePromptTemplate(template, renameMap);
    if (rewritten === template) return node;

    return {
      ...node,
      data: {
        ...node.data,
        properties: { ...node.data.properties, promptTemplate: rewritten },
      },
    };
  });
}
