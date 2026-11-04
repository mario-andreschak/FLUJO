/** The name a person sees when a Static node waits for a decision with no tool involved. */
export const HUMAN_GATE_TOOL_NAME = 'human_decision';
/** Conversation result of an approved wait. An edge condition can route on it. */
export const HUMAN_GATE_APPROVED_RESULT = 'approved';
/** Conversation result of a rejected wait, the same fixed text a rejected tool call gets. */
export const HUMAN_GATE_REJECTED_RESULT = 'tool denied';

/** Whether any step of a flow requires a person to decide something during a run. */
export function flowRequiresStepApproval(flow: {
  nodes?: ReadonlyArray<{ data?: { properties?: Record<string, unknown> | object | null } | null }> | null;
} | null | undefined): boolean {
  return (flow?.nodes ?? []).some((node) => {
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
