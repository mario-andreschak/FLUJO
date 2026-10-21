import { flowService } from '@/backend/services/flow';
import { hashBehaviorFlow, snapshotBehaviorFlow, snapshotBehaviorFlowDependencies } from '@/backend/services/enduringAgents/behaviorRevisions';
import { resolveEffectiveBehaviorRevision } from '@/backend/services/enduringAgents/behaviorFlowResolver';
import { resolvePersonaCoreRevision } from '@/backend/services/enduringAgents/personaCoreResolver';
import { authoredCoreFlowRef } from '@/backend/services/enduringAgents/personaComposition';
import { buildPersonaInstructionContext } from '@/backend/services/enduringAgents/personaInstructionContext';
import { snapshotPersonaCoreAppRefs, projectPersonaCoreAppsIntoFlow } from '@/backend/services/enduringAgents/personaCoreApps';
import { buildBehaviorToolRegistry } from '@/backend/execution/flow/handlers/behaviorToolInvocation';
import { getBehaviorBinding, getPersona, getRoleVersion } from '@/backend/services/enduringAgents/store';
import { getCoreMemory } from '@/backend/services/enduringAgents/memoryKernel';
import { loadItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import type { Flow } from '@/shared/types/flow';
import type { HarnessRuntimeSnapshot, HarnessTarget } from '@/shared/types/harnessIntegration';
import { getHarnessModel, modelFingerprint } from './model';
import { harnessDigest } from './executionScope';

export const harnessTargetId = (target: HarnessTarget) => harnessDigest(target);
export const snapshotHarnessFlow = (flow: Flow) => flow.executionDependencies
  ? Promise.resolve(snapshotBehaviorFlow(flow)) : snapshotBehaviorFlowDependencies(flow);
export function harnessTargetPrompt(flow: Flow, nodeId: string): string {
  const node = flow.nodes.find(item => item.id === nodeId && item.type === 'process');
  if (!node || typeof node.data.properties?.promptTemplate !== 'string') throw new Error('Choose a saved Process step with authored instructions.');
  if (node.data.properties.promptTemplate.length > 12000) throw new Error('Harness Lab supports authored step instructions up to 12,000 characters.');
  return node.data.properties.promptTemplate;
}
export function harnessCandidateFlow(runtime: HarnessRuntimeSnapshot, prompt: string): Flow {
  const flow = structuredClone(runtime.flow);
  const node = flow.nodes.find(item => item.id === runtime.target.nodeId)!;
  node.data.properties = { ...node.data.properties, promptTemplate: prompt };
  return flow;
}

/** Capture the same immutable graph and Persona instruction builder used at admission. */
export async function captureHarnessTarget(target: HarnessTarget, maxModelCallsPerProbe = 4, mode: 'evaluation' | 'source' = 'evaluation',
  invocationOverride?: Exclude<HarnessRuntimeSnapshot['invocation'], 'flow'>): Promise<HarnessRuntimeSnapshot> {
  let flow: Flow;
  let baseRevision: string;
  let personaContext: HarnessRuntimeSnapshot['personaContext'];
  let authoredFlow: HarnessRuntimeSnapshot['authoredFlow'];
  let invocation: HarnessRuntimeSnapshot['invocation'] = 'flow';
  let evaluationFlow: Flow | undefined;
  let personaCoreAppRefs: string[] | undefined;
  let behaviorToolRegistry: HarnessRuntimeSnapshot['behaviorToolRegistry'];
  let personaAttribution: HarnessRuntimeSnapshot['personaAttribution'];
  if (target.kind === 'flow') {
    const found = (await flowService.readFlowExecutionSnapshot(target.flowId))?.flow;
    if (!found || found.personaOwnership) throw new Error('Select a normal agent, or select its owning Persona behavior.');
    flow = await snapshotHarnessFlow(found);
    baseRevision = hashBehaviorFlow(flow);
  } else {
    const persona = await getPersona(target.personaId);
    const binding = await getBehaviorBinding(target.behaviorId);
    if (!persona || persona.provisioningState !== 'ready' || !binding || binding.personaId !== persona.id) throw new Error('The Persona behavior is unavailable.');
    const revision = binding.slotKey === 'primary' ? await resolvePersonaCoreRevision(persona.id)
      : (await resolveEffectiveBehaviorRevision(persona.id, binding.slotKey)).revision;
    if (revision.behaviorId !== binding.id) throw new Error('The Persona behavior binding changed.');
    const roleVersion = await getRoleVersion(persona.roleVersionId);
    if (!roleVersion) throw new Error('The Persona Role version is unavailable.');
    flow = structuredClone(revision.flowSnapshot);
    baseRevision = revision.id;
    const activityId = `harness-${harnessTargetId(target).slice(0, 32)}`;
    personaAttribution = { personaId: persona.id, activityId, behaviorRevisionId: revision.id };
    invocation = invocationOverride ?? (binding.slotKey === 'primary' ? 'persona-activity' : 'persona-behavior');
    if (invocation === 'persona-activity' && mode === 'evaluation') {
      personaContext = buildPersonaInstructionContext({ persona, roleVersion, revision,
        activityId, coreMemoryItems: await getCoreMemory(persona.id) });
      personaCoreAppRefs = await snapshotPersonaCoreAppRefs(persona.id, persona);
      evaluationFlow = await projectPersonaCoreAppsIntoFlow(persona.id, personaCoreAppRefs, flow);
      behaviorToolRegistry = buildBehaviorToolRegistry({ personaId: persona.id,
        behaviors: persona.composition?.behaviors ?? [], excludeBehaviorId: binding.id });
    }
    const composition = persona.composition?.behaviors?.find(item => item.ref === binding.id);
    const sourceFlowRef = composition?.binding ? composition.binding.sharedFlowRef : composition?.sourceFlowRef;
    const overrideFlowRef = composition?.binding?.mode === 'persona_copy' ? composition.binding.personaFlowRef : composition?.overrideFlowRef;
    const flowRef = binding.slotKey === 'primary' ? authoredCoreFlowRef(persona)
      : overrideFlowRef ?? sourceFlowRef;
    if (flowRef) {
      const authored = (await flowService.readFlowExecutionSnapshot(flowRef))?.flow;
      if (!authored) throw new Error('The Persona authoring flow is unavailable.');
      authoredFlow = { flowRef, contentHash: hashBehaviorFlow(await snapshotBehaviorFlowDependencies(authored)), updatedAt: authored.updatedAt };
    }
  }
  harnessTargetPrompt(flow, target.nodeId);
  const modelFingerprints: Record<string, string> = {};
  const graphs = [flow, ...(flow.executionDependencies?.flows.map(item => item.flowSnapshot) ?? [])];
  for (const graph of graphs) {
    for (const node of graph.nodes) {
      if (mode === 'source') continue; // Version navigation requires no live model or MCP connection.
      // Evaluation preserves authored executable graphs; it never silently drops a node.
      if (!['start', 'process', 'finish', 'mcp', 'resource', 'subflow', 'static', 'note'].includes(node.type ?? '')) {
        throw new Error(`Evaluation does not yet support the ${node.type} node in ${graph.name}.`);
      }
      if (node.type !== 'process') continue;
      const modelId = node.data.properties?.boundModel;
      if (typeof modelId !== 'string') throw new Error('Every evaluated Process step needs an explicit approved model connection.');
      const { model } = await getHarnessModel(modelId);
      modelFingerprints[modelId] = modelFingerprint(model);
    }
  }
  const contextHash = harnessDigest({ flow, modelFingerprints, persona: personaContext?.instruction,
    role: personaContext?.roleVersionId, memory: personaContext?.coreMemoryDigest, authoredFlow,
    evaluationFlow, personaCoreAppRefs, behaviorToolRegistry,
    globals: await loadItem(StorageKey.GLOBAL_ENV_VARS, {}), kvPolicy: await loadItem(StorageKey.KV_STORE_SETTINGS, {}) });
  return { target, flow, baseRevision, contextHash, modelFingerprints, personaContext, authoredFlow, maxModelCallsPerProbe,
    invocation, evaluationFlow, personaCoreAppRefs, behaviorToolRegistry, personaAttribution };
}

export async function assertHarnessTargetCurrent(runtime: HarnessRuntimeSnapshot) {
  const current = await captureHarnessTarget(runtime.target, runtime.maxModelCallsPerProbe, 'evaluation',
    runtime.invocation === 'flow' ? undefined : runtime.invocation);
  if (current.baseRevision !== runtime.baseRevision || current.contextHash !== runtime.contextHash) {
    throw new Error('The agent, Persona context, or model configuration changed. Start a new comparison.');
  }
}
