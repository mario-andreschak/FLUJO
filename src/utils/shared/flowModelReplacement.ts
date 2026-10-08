/**
 * Shared model-binding remapping used by package installation and dashboard
 * quick-change. Flow execution binds models by `properties.boundModel`; the
 * adjacent `modelName` is only a display cache and must move with the id.
 */

export interface FlowModelReplacementTarget {
  id: string;
  name: string;
}

export type FlowModelReplacementMap = Record<string, FlowModelReplacementTarget>;

interface ModelBoundNode {
  data?: {
    properties?: Record<string, unknown>;
  };
}

interface ModelBoundFlow {
  id?: string;
  name?: string;
  nodes?: ModelBoundNode[];
}

export interface RemapFlowModelBindingsResult<T> {
  flow: T;
  replacedNodeCount: number;
}

/**
 * Immutably replace every mapped model binding in a flow. Unmapped nodes and
 * their surrounding objects retain identity, making this safe for React state
 * as well as backend package preparation.
 */
export function remapFlowModelBindings<T extends ModelBoundFlow>(
  flow: T,
  replacements: FlowModelReplacementMap,
): RemapFlowModelBindingsResult<T> {
  let replacedNodeCount = 0;

  const nodes = (flow.nodes ?? []).map((node) => {
    const properties = node.data?.properties;
    const currentModelId = properties?.boundModel;
    if (typeof currentModelId !== 'string') return node;

    const replacement = replacements[currentModelId];
    if (!replacement) return node;
    if (
      replacement.id === currentModelId
      && properties?.modelName === replacement.name
    ) {
      return node;
    }

    replacedNodeCount += 1;
    return {
      ...node,
      data: {
        ...node.data,
        properties: {
          ...properties,
          boundModel: replacement.id,
          modelName: replacement.name,
        },
      },
    };
  });

  if (replacedNodeCount === 0) return { flow, replacedNodeCount };
  return {
    flow: { ...flow, nodes } as T,
    replacedNodeCount,
  };
}

export interface FlowModelUsage {
  modelId: string;
  label: string;
  flowCount: number;
  nodeCount: number;
  missing: boolean;
}

interface AvailableModel {
  id: string;
  name: string;
  displayName?: string;
}

/** Summarize the distinct bound models used by a collection of flows. */
export function collectFlowModelUsage(
  flows: ModelBoundFlow[],
  models: AvailableModel[],
): FlowModelUsage[] {
  const modelById = new Map(models.map((model) => [model.id, model]));
  const usages = new Map<
    string,
    { flowIds: Set<string>; nodeCount: number; cachedName?: string }
  >();

  for (const flow of flows) {
    const flowIdentity = flow.id ?? flow.name ?? String(usages.size);
    for (const node of flow.nodes ?? []) {
      const properties = node.data?.properties;
      const modelId = properties?.boundModel;
      if (typeof modelId !== 'string' || modelId.length === 0) continue;
      const usage = usages.get(modelId) ?? { flowIds: new Set<string>(), nodeCount: 0 };
      usage.flowIds.add(flowIdentity);
      usage.nodeCount += 1;
      if (!usage.cachedName && typeof properties?.modelName === 'string') {
        usage.cachedName = properties.modelName;
      }
      usages.set(modelId, usage);
    }
  }

  return Array.from(usages, ([modelId, usage]) => {
    const model = modelById.get(modelId);
    return {
      modelId,
      label: model?.displayName || model?.name || usage.cachedName || modelId,
      flowCount: usage.flowIds.size,
      nodeCount: usage.nodeCount,
      missing: !model,
    };
  }).sort((a, b) => a.label.localeCompare(b.label));
}
