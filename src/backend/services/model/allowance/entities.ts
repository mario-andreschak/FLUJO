import type { Flow } from '@/shared/types/flow';
import { flowService } from '@/backend/services/flow';
import { listPersonasStrict, listBehaviorBindings, getBehaviorRevision } from '@/backend/services/enduringAgents/store';
import { authoredCoreFlowRef } from '@/backend/services/enduringAgents/personaComposition';

/** Traverse immutable dependency snapshots without exposing prompts or graph data. */
export function allowanceFlowModelIds(flow: Flow, authoredFlows: Flow[] = []): string[] {
  const ids = new Set<string>();
  const visited = new Set<Flow>();
  const pending = [flow];
  while (pending.length) {
    const item = pending.pop()!;
    if (visited.has(item)) continue;
    visited.add(item);
    for (const node of item.nodes) {
      const model = node.data?.properties?.boundModel;
      if (typeof model === 'string' && model) ids.add(model);
      const target = node.data?.properties?.subflowId;
      if (node.data?.type === 'subflow' && typeof target === 'string' && !item.executionDependencies) {
        const child = authoredFlows.find(candidate => candidate.id === target);
        if (child) pending.push(child);
      }
    }
    pending.push(...(item.executionDependencies?.flows ?? []).map(dependency => dependency.flowSnapshot));
  }
  return [...ids];
}

export async function allowanceEntityModels(): Promise<{ flows: Record<string, string[]>; personas: Record<string, string[]> }> {
  const [flows, personas] = await Promise.all([flowService.loadFlows(), listPersonasStrict()]);
  const flowModels = Object.fromEntries(flows.map(flow => [flow.id, allowanceFlowModelIds(flow, flows)]));
  const personaModels: Record<string, string[]> = {};
  for (const persona of personas) {
    const ids = new Set(flowModels[authoredCoreFlowRef(persona) ?? ''] ?? []);
    for (const binding of await listBehaviorBindings(persona.id)) {
      const revision = await getBehaviorRevision(binding.activeRevisionId);
      if (revision?.personaId === persona.id) allowanceFlowModelIds(revision.flowSnapshot).forEach(id => ids.add(id));
    }
    personaModels[persona.id] = [...ids];
  }
  return { flows: flowModels, personas: personaModels };
}
