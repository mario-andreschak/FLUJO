/** The name a person sees when a Static node waits for a decision with no tool involved. */
export const HUMAN_GATE_TOOL_NAME = 'human_decision';
/** Conversation result of an approved wait. An edge condition can route on it. */
export const HUMAN_GATE_APPROVED_RESULT = 'approved';
/** Conversation result of a rejected wait, the same fixed text a rejected tool call gets. */
export const HUMAN_GATE_REJECTED_RESULT = 'tool denied';

type FlowShape = {
  nodes?: ReadonlyArray<{ type?: string; data?: { properties?: Record<string, unknown> | object | null } | null }> | null;
} | null | undefined;

/** How deep `flowMayWaitForPerson` follows sub-flows; deeper calls are refused at run time anyway. */
const MAX_SUBFLOW_LOOKUP_DEPTH = 8;

/**
 * Whether a run of this flow may stop for a person: one of its steps does, or a sub-flow
 * it names does (#1095). Such a run must be saved, so its wait can come back.
 */
export async function flowMayWaitForPerson(
  flow: FlowShape,
  loadFlow: (id: string) => Promise<FlowShape>,
  depth = 0,
  seen: Set<string> = new Set(),
): Promise<boolean> {
  if (flowRequiresStepApproval(flow)) return true;
  if (depth >= MAX_SUBFLOW_LOOKUP_DEPTH) return false;
  for (const node of flow?.nodes ?? []) {
    if (node.type !== 'subflow') continue;
    const properties = (node.data?.properties ?? {}) as { subflowId?: unknown; parallelSubflowIds?: unknown };
    const ids = [properties.subflowId, ...(Array.isArray(properties.parallelSubflowIds) ? properties.parallelSubflowIds : [])];
    for (const id of ids) {
      if (typeof id !== 'string' || !id || seen.has(id)) continue;
      seen.add(id);
      if (await flowMayWaitForPerson(await loadFlow(id).catch(() => undefined), loadFlow, depth + 1, seen)) return true;
    }
  }
  return false;
}

/** Whether any step of a flow requires a person to decide something during a run. */
export function flowRequiresStepApproval(flow: FlowShape): boolean {
  return (flow?.nodes ?? []).some((node) => {
    if (node.type === 'human') return true;
    const properties = node.data?.properties as {
      requireApprovalFor?: unknown;
      requireApprovalForWrites?: unknown;
      entries?: unknown;
    } | null | undefined;
    return properties?.requireApprovalForWrites === true
      || (Array.isArray(properties?.requireApprovalFor) && properties.requireApprovalFor.length > 0)
      || (Array.isArray(properties?.entries) && properties.entries.some((entry: { kind?: unknown; requireApproval?: unknown } | null) =>
        entry?.kind === 'humanGate' || entry?.requireApproval === true));
  });
}
