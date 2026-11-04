/** Whether any step of a flow requires a person to approve some of its tool calls. */
export function flowRequiresStepApproval(flow: {
  nodes?: ReadonlyArray<{ data?: { properties?: Record<string, unknown> | object | null } | null }> | null;
} | null | undefined): boolean {
  return (flow?.nodes ?? []).some((node) => {
    const properties = node.data?.properties as { requireApprovalFor?: unknown; requireApprovalForWrites?: unknown } | null | undefined;
    return properties?.requireApprovalForWrites === true
      || (Array.isArray(properties?.requireApprovalFor) && properties.requireApprovalFor.length > 0);
  });
}
