/**
 * Where-used lookups for the Models and Agents pages (#1278): which agents
 * (flows) bind a model, which fallback policies include it, and which agents
 * call a flow as a subflow. Pure functions over already-loaded data.
 */
export interface WhereUsedRef {
  kind: 'flow' | 'policy';
  id: string;
  name: string;
}

interface FlowLike {
  id: string;
  name?: string;
  nodes?: Array<{ data?: { type?: string; properties?: Record<string, unknown> } }>;
}
interface ModelLike {
  id: string;
  name?: string;
  displayName?: string;
  fallbackPolicy?: { modelIds?: string[] };
}

const byName = (left: WhereUsedRef, right: WhereUsedRef) => left.name.localeCompare(right.name);

function add(map: Record<string, WhereUsedRef[]>, key: string, ref: WhereUsedRef): void {
  const list = map[key] ??= [];
  if (!list.some(existing => existing.kind === ref.kind && existing.id === ref.id)) list.push(ref);
}

/** Model id -> agents that bind it on a node, and fallback policies that list it. */
export function modelUsage(flows: readonly FlowLike[], models: readonly ModelLike[] = []): Record<string, WhereUsedRef[]> {
  const usage: Record<string, WhereUsedRef[]> = {};
  for (const flow of flows) {
    for (const node of flow.nodes ?? []) {
      const bound = node.data?.properties?.boundModel;
      if (typeof bound === 'string' && bound) add(usage, bound, { kind: 'flow', id: flow.id, name: flow.name || flow.id });
    }
  }
  for (const model of models) {
    for (const member of model.fallbackPolicy?.modelIds ?? []) {
      add(usage, member, { kind: 'policy', id: model.id, name: model.displayName || model.name || model.id });
    }
  }
  for (const list of Object.values(usage)) list.sort(byName);
  return usage;
}

/** Flow id -> agents that call it through a subflow node. */
export function subflowUsage(flows: readonly FlowLike[]): Record<string, WhereUsedRef[]> {
  const usage: Record<string, WhereUsedRef[]> = {};
  for (const flow of flows) {
    for (const node of flow.nodes ?? []) {
      const target = node.data?.properties?.subflowId;
      if (node.data?.type === 'subflow' && typeof target === 'string' && target && target !== flow.id) {
        add(usage, target, { kind: 'flow', id: flow.id, name: flow.name || flow.id });
      }
    }
  }
  for (const list of Object.values(usage)) list.sort(byName);
  return usage;
}

export function whereUsedHref(ref: WhereUsedRef): string {
  return ref.kind === 'flow' ? `/flows?flow=${encodeURIComponent(ref.id)}&mode=edit` : `/models?edit=${encodeURIComponent(ref.id)}`;
}
