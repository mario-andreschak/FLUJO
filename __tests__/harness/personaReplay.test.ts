import { ProcessNode } from '@/backend/execution/flow/nodes/ProcessNode';
import { createProcessNativeOriginalHost } from '@/backend/execution/flow/handlers/nativeOriginalHost';
import { getPersonaActivity } from '@/backend/services/enduringAgents/store';
import { guardHarnessAdapter, withHarnessExecution, type HarnessExecutionScope } from '@/backend/services/harness/executionScope';
import type { CompletionAdapter, CompletionInput, CompletionResult } from '@/backend/services/model/adapters/types';
import type { ProcessNodeParams, SharedState } from '@/backend/execution/flow/types';
import type { HarnessRuntimeSnapshot } from '@/shared/types/harnessIntegration';
import { saveItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';

const model = { id: 'replay-model', name: 'gpt-6-luna', provider: 'codex', adapter: 'codex-cli' as const, ApiKey: '' };
const attribution = { personaId: 'persona-replay', activityId: 'harness-synthetic', behaviorRevisionId: 'revision-replay' };
jest.mock('@/backend/utils/PromptRenderer', () => ({ promptRenderer: { renderPrompt: jest.fn(async () => 'Authored operational instructions') } }));
jest.mock('@/backend/services/flow/index', () => ({ flowService: { getFlow: jest.fn(async (id: string) => ({ id, name: id, nodes: [], edges: [] })) } }));
jest.mock('@/backend/services/model', () => ({ modelService: { getModel: jest.fn(async () => model) } }));
jest.mock('@/backend/services/enduringAgents/store', () => ({ getPersonaActivity: jest.fn(async () => null) }));

function scope(maintenanceMemoryProposal = false): HarnessExecutionScope {
  return { runtime: { personaAttribution: attribution, maxModelCallsPerProbe: 2 } as HarnessRuntimeSnapshot,
    personaToolPolicy: { maintenanceMemoryProposal }, tools: [], calls: 0, replayed: 0, prompts: [], trace: [],
    signal: new AbortController().signal, authorize: jest.fn(async () => {}), beforeCall: jest.fn(async () => {}), afterCall: jest.fn(async () => {}) };
}
const authority = () => ({ signal: new AbortController().signal, assertCurrent: jest.fn(async () => {}) });
function state(executionAuthority = authority()): SharedState {
  return { trackingInfo: { executionId: 'execution-replay', startTime: 1, nodeExecutionTracker: [] },
    messages: [], flowId: 'flow-replay', conversationId: 'conversation-replay', title: 'Replay', createdAt: 1, updatedAt: 1,
    personaAttribution: attribution, executionAuthority,
    behaviorRules: [{ effect: 'deny', action: 'suggest_improvement', resource: '*' }],
  } as SharedState;
}
const params: ProcessNodeParams = { id: 'process-replay', label: 'Process', type: 'process', properties: {
  boundModel: model.id, personaTools: ['remember', 'report_activity_outcome', 'suggest_improvement'],
} };

beforeEach(async () => { jest.clearAllMocks(); await saveItem(StorageKey.MODELS, [model]); });

it('skips native admission only inside server-owned replay, before looking up a synthetic Codex Activity', async () => {
  const input = { modelId: model.id, personaAttribution: attribution, authority: authority() };
  await expect(withHarnessExecution(scope(), () => createProcessNativeOriginalHost(input))).resolves.toBeUndefined();
  expect(getPersonaActivity).not.toHaveBeenCalled();
  // Serialized attribution and a caller-created authority alone still fail admission.
  await expect(createProcessNativeOriginalHost(input)).rejects.toThrow('Native Original authority');
  expect(getPersonaActivity).toHaveBeenCalledWith(attribution.personaId, attribution.activityId);
});

it.each([false, true])('preserves real Process Persona schemas and denial rules with maintenance=%s, without mutation authority', async maintenance => {
  const liveAuthority = { ...authority(), commitPersonaMutation: jest.fn(),
    ...(maintenance ? { proposePersonaMemoryMaintenance: jest.fn() } : {}) };
  const live = await new ProcessNode().prep(state(liveAuthority), params);
  const replayState = state();
  const replay = await withHarnessExecution(scope(maintenance), () => new ProcessNode().prep(replayState, params));
  expect(replay.availableTools).toEqual(live.availableTools);
  expect(replay.availableTools?.map(tool => tool.name)).toEqual(['remember', 'report_activity_outcome']);
  expect(replayState.executionAuthority?.commitPersonaMutation).toBeUndefined();
  expect(liveAuthority.commitPersonaMutation).not.toHaveBeenCalled();
  const ordinaryUnprivileged = await new ProcessNode().prep(state(), params);
  expect(ordinaryUnprivileged.availableTools).toEqual([]);
});

it('replays a prepared Persona outcome tool without invoking its live executor', async () => {
  const current = scope(), live = jest.fn();
  const args = { resolution: 'succeeded', summary: 'Verified result' };
  current.tools.push({ name: 'report_activity_outcome', arguments: args, output: '{"success":true}' });
  await withHarnessExecution(current, async () => {
    const prep = await new ProcessNode().prep(state(), params);
    const adapter: CompletionAdapter = { createCompletion: jest.fn(async (actual: CompletionInput): Promise<CompletionResult> => {
      expect(actual.tools?.map(tool => tool.function.name)).toContain('report_activity_outcome');
      expect(await actual.localToolExecutors!.report_activity_outcome(args)).toBe('{"success":true}');
      return { completion: { id: 'completion', object: 'chat.completion', created: 1, model: model.name,
        choices: [{ index: 0, message: { role: 'assistant', content: 'Verified result', refusal: null }, finish_reason: 'stop', logprobs: null }] } };
    }) };
    await guardHarnessAdapter(adapter).createCompletion({ model, apiKey: '', messages: [],
      tools: prep.availableTools?.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
      localToolExecutors: { report_activity_outcome: live },
    } as CompletionInput);
  });
  expect(live).not.toHaveBeenCalled();
  expect(current.trace).toEqual([{ name: 'report_activity_outcome', arguments: args, matched: true }]);
});
