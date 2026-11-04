/**
 * Which models a saved flow can send data to.
 *
 * Reads the flow, the subflows it can start and the members of any fallback policy, so
 * a caller can check a flow before trusting it. Only what identifies a destination is
 * returned: no credentials, and of a base URL only its host, because a URL can carry a
 * token. `complete: false` means something could not be resolved, so the list may be
 * too short and must not be read as a guarantee.
 */
import type { Flow } from '@/shared/types/flow';
import type { Model } from '@/shared/types/model';
import { flowService } from '@/backend/services/flow';
import { modelService } from '@/backend/services/model';
import { modelsOutsideBoundary } from '@/utils/shared/flowModelBoundary';

export interface FlowModelDestination {
  id: string;
  name: string;
  displayName?: string;
  provider?: string;
  adapter?: string;
  /** Host of the model's base URL. Null when the model has none, such as a local CLI. */
  host: string | null;
  /** The steps that can reach this model. */
  usedBy: Array<{ flowId: string; nodeId: string; viaPolicy?: string }>;
  /** Whether the root flow's `allowedModels` permits it. True when the flow has no list. */
  allowed: boolean;
}

export interface FlowModelReach {
  flowId: string;
  allowedModels: string[] | null;
  models: FlowModelDestination[];
  /** Referenced models or subflows that could not be found. */
  unresolved: Array<{ kind: 'model' | 'flow'; id: string; flowId: string; nodeId: string }>;
  complete: boolean;
}

function hostOf(baseUrl: string | undefined): string | null {
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).host || null;
  } catch {
    return null;
  }
}

type FlowModelNode = { id: string; data?: { type?: string; properties?: Record<string, unknown> }; type?: string };

export async function describeFlowModelReach(rootFlowId: string): Promise<FlowModelReach | null> {
  const root = await flowService.getFlow(rootFlowId);
  if (!root) return null;

  const catalog = await modelService.loadModels();
  const byId = new Map<string, Model>(catalog.map((model) => [model.id, model]));
  const allowedModels = root.allowedModels ?? null;
  const destinations = new Map<string, FlowModelDestination>();
  const unresolved: FlowModelReach['unresolved'] = [];

  const addDestination = (model: Model, usage: FlowModelDestination['usedBy'][number]) => {
    const existing = destinations.get(model.id);
    if (existing) {
      existing.usedBy.push(usage);
      return;
    }
    destinations.set(model.id, {
      id: model.id,
      name: model.name,
      ...(model.displayName ? { displayName: model.displayName } : {}),
      ...(model.provider ? { provider: model.provider } : {}),
      ...(model.adapter ? { adapter: model.adapter } : {}),
      host: hostOf(model.baseUrl),
      usedBy: [usage],
      allowed: modelsOutsideBoundary(model, allowedModels ?? undefined).length === 0,
    });
  };

  const seenFlows = new Set<string>();
  const walk = async (flow: Flow) => {
    if (seenFlows.has(flow.id)) return;
    seenFlows.add(flow.id);
    for (const node of (flow.nodes ?? []) as unknown as FlowModelNode[]) {
      const type = node.data?.type ?? node.type;
      const properties = node.data?.properties ?? {};
      if (type === 'process' && typeof properties.boundModel === 'string' && properties.boundModel) {
        const bound = byId.get(properties.boundModel);
        if (!bound) {
          unresolved.push({ kind: 'model', id: properties.boundModel, flowId: flow.id, nodeId: node.id });
        } else if (bound.fallbackPolicy) {
          for (const memberId of bound.fallbackPolicy.modelIds) {
            const member = byId.get(memberId);
            if (member) addDestination(member, { flowId: flow.id, nodeId: node.id, viaPolicy: bound.id });
            else unresolved.push({ kind: 'model', id: memberId, flowId: flow.id, nodeId: node.id });
          }
        } else {
          addDestination(bound, { flowId: flow.id, nodeId: node.id });
        }
      }
      if (type === 'subflow') {
        const children = [
          ...(typeof properties.subflowId === 'string' && properties.subflowId ? [properties.subflowId] : []),
          ...(Array.isArray(properties.parallelSubflowIds)
            ? properties.parallelSubflowIds.filter((id): id is string => typeof id === 'string' && !!id)
            : []),
        ];
        for (const childId of children) {
          const child = await flowService.getFlow(childId);
          if (child) await walk(child);
          else unresolved.push({ kind: 'flow', id: childId, flowId: flow.id, nodeId: node.id });
        }
      }
    }
  };
  await walk(root);

  return {
    flowId: root.id,
    allowedModels,
    models: [...destinations.values()],
    unresolved,
    complete: unresolved.length === 0,
  };
}
