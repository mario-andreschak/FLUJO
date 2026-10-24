/** Real FlowConverter/Pocketflow/runFlow, with only owner relay and storage
 * fixtures. No inference, container-isolation or installed-runtime claim. */
import { installPrivateProfileFixture } from '../utils/privateProfileFixture';
import type { Flow } from '@/shared/types/flow';
import type { FlowExecutionAuthority, SharedState } from '@/backend/execution/flow/types';
import type { TeamFlowBundle } from '../../packages/shared-controller/src/shared-flow';
import { teamFlowId } from '../../packages/shared-controller/src/shared-flow';

const store = new Map<string, unknown>(); let bundle: TeamFlowBundle;
jest.mock('@/utils/storage/backend', () => ({ ...jest.requireActual('@/utils/storage/backend'),
  loadItem: jest.fn(async (key: string, fallback: unknown) => store.has(key) ? structuredClone(store.get(key)) : fallback),
  saveItem: jest.fn(async (key: string, value: unknown) => { store.set(key, JSON.parse(JSON.stringify(value))); }),
  clearItem: jest.fn(async (key: string) => { store.delete(key); }),
}));
jest.mock('@/backend/services/flow/teamCatalogue', () => ({ ...jest.requireActual('@/backend/services/flow/teamCatalogue'),
  resolveTeamFlowBundle: jest.fn(async () => structuredClone(bundle)), assertTeamFlowCurrent: jest.fn(async () => {}),
}));
jest.mock('@/backend/services/flow', () => ({ flowService: {
  getFlow: jest.fn(async (id: string) => jest.requireActual('@/backend/services/flow/teamCatalogue').projectTeamFlow(bundle, id.split(':')[2])),
  loadFlows: jest.fn(async () => []),
} }));
jest.mock('@/backend/services/model', () => ({ modelService: {
  listModels: jest.fn(async () => ({ success: true, models: [] })), getModel: jest.fn(async () => null),
} }));
jest.mock('@/backend/services/mcp', () => ({ mcpService: {
  callTool: jest.fn(), loadServerConfigs: jest.fn(async () => []), listServerTools: jest.fn(async () => ({ tools: [] })),
} }));
jest.mock('@/backend/utils/resolveDynamicReferences', () => ({ ...jest.requireActual('@/backend/utils/resolveDynamicReferences'),
  resolvePromptDynamicReferences: jest.fn(async () => { throw new Error('Private dynamic lookup must not run'); }),
}));

import { runFlow } from '@/backend/execution/flow/runFlow';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { bindTeamFlowExecution } from '@/backend/execution/flow/teamExecution';
import { assertTeamFlowCurrent, projectTeamFlow } from '@/backend/services/flow/teamCatalogue';
import { compileFlowSpec } from '@/utils/shared/flowSpecCompiler';
import { projectSharedFlow } from '../../packages/shared-controller/src/shared-flow';
import { mcpService } from '@/backend/services/mcp';
import { flushStatisticsEvents } from '@/backend/services/statistics';
import { resolvePromptDynamicReferences } from '@/backend/utils/resolveDynamicReferences';

const reference = { teamId: 't'.repeat(43), resourceId: 'r'.repeat(43), teamName: 'Offline team', generation: 'a'.repeat(64), version: 1 };
function authored(name: string, child?: string) {
  const result = compileFlowSpec({ name, nodes: [
    { key: 'start', type: 'start' },
    child ? { key: 'step', type: 'subflow', flow: child } : { key: 'step', type: 'static',
      entries: [{ kind: 'message', role: 'assistant', content: 'Static team answer' }], outputTemplate: 'Static team answer' },
    { key: 'finish', type: 'finish' },
  ], edges: [{ from: 'start', to: 'step' }, { from: 'step', to: 'finish' }] });
  if (!result.flow) throw new Error('Invalid fixture');
  const document = projectSharedFlow(result.flow).document;
  if (child) document.flow.nodes.find(node => node.type === 'subflow')!.data.properties.subflowId = child;
  return document;
}
let profile: Awaited<ReturnType<typeof installPrivateProfileFixture>>;
beforeEach(async () => {
  store.clear(); profile = await installPrivateProfileFixture(metadata => { store.set('encryption_key', metadata); });
  jest.clearAllMocks(); (assertTeamFlowCurrent as jest.Mock).mockResolvedValue(undefined);
  bundle = { reference, models: [], flows: [{ resourceId: reference.resourceId, version: 1, document: authored('Static team') }] };
  FlowExecutor.clearFlowCache(); FlowExecutor.conversationStates.clear();
});
afterEach(async () => {
  jest.restoreAllMocks(); FlowExecutor.conversationStates.clear();
  await flushStatisticsEvents(); await profile?.restore();
});

it('runs a static shared graph through the real engine without private dynamic lookups or MCP calls', async () => {
  const result = await runFlow({ flowId: teamFlowId(reference), mode: 'ephemeral', source: 'api', prompt: 'Run' });
  expect(result).toMatchObject({ status: 'completed', outputText: 'Static team answer' });
  expect(result.sharedState.flowSnapshot?.teamFlow).toEqual(reference);
  expect(assertTeamFlowCurrent).toHaveBeenCalled(); expect(mcpService.callTool).not.toHaveBeenCalled();
  expect(resolvePromptDynamicReferences).not.toHaveBeenCalled();
  expect([...store.keys()].filter(key => key.startsWith('conversations/'))).toEqual([]);
});

it('executes a nested graph from the admitted closure and rejects modified or old root snapshots before dispatch', async () => {
  const childId = 'c'.repeat(43); const childRef = teamFlowId({ ...reference, resourceId: childId });
  bundle.flows.push({ resourceId: childId, version: 1, document: authored('Child') });
  bundle.flows[0].document = authored('Parent', childRef);
  const result = await runFlow({ flowId: teamFlowId(reference), mode: 'ephemeral', source: 'api', prompt: 'Run' });
  expect(result).toMatchObject({ status: 'completed', outputText: expect.stringContaining('Static team answer') });
  const execute = jest.spyOn(FlowExecutor, 'executeStep'); execute.mockClear();
  const snapshot = projectTeamFlow(bundle); snapshot.name = 'tampered';
  await expect(runFlow({ flowDefinition: snapshot, mode: 'ephemeral', source: 'api', prompt: 'Run' })).rejects.toThrow(/Shared Flows/);
  const old = projectTeamFlow(bundle); bundle.reference = { ...reference, generation: 'b'.repeat(64) };
  await expect(runFlow({ flowDefinition: old, mode: 'ephemeral', source: 'api', prompt: 'Run' })).rejects.toThrow(/Shared Flows/);
  expect(execute).not.toHaveBeenCalled();
});

it('reacquires authority for persisted state and denies a stripped shared snapshot', async () => {
  const snapshot = projectTeamFlow(bundle);
  const state = { flowId: snapshot.id, flowSnapshot: snapshot } as SharedState;
  const committed = jest.fn();
  const prior: FlowExecutionAuthority = { signal: new AbortController().signal, assertCurrent: jest.fn(async () => {}),
    commitWhileCurrent: async task => { committed(); return task(); } };
  const input = { source: 'api' as const, executionAuthority: prior };
  const close = await bindTeamFlowExecution(input, state);
  try {
    const effect = jest.fn(async () => 'written');
    expect(await state.executionAuthority!.commitWhileCurrent!(effect)).toBe('written');
    expect(prior.assertCurrent).toHaveBeenCalled(); expect(committed).toHaveBeenCalled();
    (assertTeamFlowCurrent as jest.Mock).mockRejectedValue(new Error('Membership ended'));
    await expect(state.executionAuthority!.commitWhileCurrent!(effect)).rejects.toThrow(/permission ended/);
    expect(effect).toHaveBeenCalledTimes(1); expect(state.executionAuthority!.signal?.aborted).toBe(true);
    expect(JSON.stringify(state)).not.toContain('executionAuthority');
  } finally { close?.(); }
  const stripped = { ...snapshot, teamFlow: undefined, teamFlowBundle: undefined } as Flow;
  await expect(bindTeamFlowExecution({ source: 'api' }, { flowId: stripped.id, flowSnapshot: stripped } as SharedState)).rejects.toThrow();
});

it('aborts a waiting execution when the controller ends permission, even without another engine step', async () => {
  const snapshot = projectTeamFlow(bundle); const state = { flowId: snapshot.id, flowSnapshot: snapshot } as SharedState;
  const close = await bindTeamFlowExecution({ source: 'api' }, state);
  try {
    (assertTeamFlowCurrent as jest.Mock).mockRejectedValue(new Error('permission ended'));
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('Cancellation watch did not fire')), 3000);
      state.executionAuthority!.signal.addEventListener('abort', () => { clearTimeout(deadline); resolve(); }, { once: true });
    });
    await expect(state.executionAuthority!.assertCurrent()).rejects.toThrow(/permission ended/);
  } finally { close?.(); }
});
