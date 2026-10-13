import { allowanceFlowModelIds, allowanceEntityModels } from '@/backend/services/model/allowance/entities';
import { flowService } from '@/backend/services/flow';
import { listPersonasStrict, listBehaviorBindings, getBehaviorRevision } from '@/backend/services/enduringAgents/store';
import type { Flow } from '@/shared/types/flow';

jest.mock('@/backend/services/flow', () => ({ flowService: { loadFlows: jest.fn() } }));
jest.mock('@/backend/services/enduringAgents/store', () => ({ listPersonasStrict: jest.fn(), listBehaviorBindings: jest.fn(), getBehaviorRevision: jest.fn() }));
jest.mock('@/backend/services/enduringAgents/personaComposition', () => ({ authoredCoreFlowRef: (persona: { composition?: { coreFlowRef: string } }) => persona.composition?.coreFlowRef }));

function flow(id: string, modelId: string): Flow {
  return { id, name: id, nodes: [{ id: `${id}-node`, position: { x: 0, y: 0 }, data: { label: 'Process', type: 'process', properties: { boundModel: modelId } } }], edges: [] };
}

test('includes authored subflows and handles cycles without repeated models', () => {
  const parent = flow('parent', 'claude');
  const child = flow('child', 'codex');
  parent.nodes.push({ id: 'sub', position: { x: 0, y: 0 }, data: { label: 'Subflow', type: 'subflow', properties: { subflowId: 'child' } } });
  child.nodes.push({ id: 'back', position: { x: 0, y: 0 }, data: { label: 'Subflow', type: 'subflow', properties: { subflowId: 'parent' } } });
  expect(allowanceFlowModelIds(parent, [parent, child])).toEqual(['claude', 'codex']);
});

test('immutable dependencies retain captured models instead of mutable authoring replacements', () => {
  const parent = flow('parent', 'claude');
  parent.nodes.push({ id: 'sub', position: { x: 0, y: 0 }, data: { label: 'Subflow', type: 'subflow', properties: { subflowId: 'child' } } });
  parent.executionDependencies = { schemaVersion: 1, workspaceId: 'test', flows: [{ flowId: 'child', contentHash: 'fixture', flowSnapshot: flow('child', 'captured-codex') }] };
  expect(allowanceFlowModelIds(parent, [flow('child', 'mutable-other-account')])).toEqual(['claude', 'captured-codex']);
});

test('Persona projection includes Core and active owned revision only, returning IDs without graph payloads', async () => {
  jest.mocked(flowService.loadFlows).mockResolvedValue([flow('core', 'core-model')]);
  jest.mocked(listPersonasStrict).mockResolvedValue([{ id: 'persona', composition: { coreFlowRef: 'core' } }] as never);
  jest.mocked(listBehaviorBindings).mockResolvedValue([{ activeRevisionId: 'active' }, { activeRevisionId: 'other-owner' }] as never);
  jest.mocked(getBehaviorRevision).mockImplementation(async id => ({ personaId: id === 'active' ? 'persona' : 'other', flowSnapshot: flow(id, id === 'active' ? 'fallback-policy' : 'private-other-model') }) as never);
  const result = await allowanceEntityModels();
  expect(result).toEqual({ flows: { core: ['core-model'] }, personas: { persona: ['core-model', 'fallback-policy'] } });
  expect(JSON.stringify(result)).not.toContain('private-other-model');
  expect(JSON.stringify(result)).not.toContain('nodes');
});
