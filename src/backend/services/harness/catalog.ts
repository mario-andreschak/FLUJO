import { flowService } from '@/backend/services/flow';
import { listPersonas, listBehaviorBindings, getBehaviorRevision } from '@/backend/services/enduringAgents/store';
import type { Flow } from '@/shared/types/flow';
import type { HarnessTarget } from '@/shared/types/harnessIntegration';
import { harnessTargetId } from './targets';

export interface HarnessTargetOption { id: string; label: string; target: HarnessTarget; prompt: string; modelId?: string }
export async function harnessTargetOptions(): Promise<HarnessTargetOption[]> {
  const options: HarnessTargetOption[] = [];
  const add = (flow: Flow, target: Omit<Extract<HarnessTarget, { kind: 'flow' }>, 'nodeId'> | Omit<Extract<HarnessTarget, { kind: 'persona' }>, 'nodeId'>, prefix: string) => {
    for (const node of flow.nodes) {
      if (node.type !== 'process' || typeof node.data.properties?.promptTemplate !== 'string') continue;
      const complete = { ...target, nodeId: node.id } as HarnessTarget;
      options.push({ id: harnessTargetId(complete), label: `${prefix} / ${node.data.label}`, target: complete,
        prompt: node.data.properties.promptTemplate, modelId: typeof node.data.properties.boundModel === 'string' ? node.data.properties.boundModel : undefined });
    }
  };
  for (const flow of await flowService.loadFlows()) if (!flow.personaOwnership) add(flow, { kind: 'flow', flowId: flow.id }, flow.name);
  for (const persona of await listPersonas()) {
    for (const binding of await listBehaviorBindings(persona.id)) {
      const revision = await getBehaviorRevision(binding.activeRevisionId);
      if (revision) add(revision.flowSnapshot, { kind: 'persona', personaId: persona.id, behaviorId: binding.id }, `${persona.name} · ${binding.slotKey}`);
    }
  }
  return options;
}
