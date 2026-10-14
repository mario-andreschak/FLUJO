import { ProcessNode } from '@/backend/execution/flow/nodes/ProcessNode';
import { promptRenderer } from '@/backend/utils/PromptRenderer';
import { modelService } from '@/backend/services/model';
import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import type { ProcessNodeParams, SharedState } from '@/backend/execution/flow/types';
import type { Flow } from '@/shared/types/flow';
import { saveItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';

afterEach(() => jest.restoreAllMocks());

it('materializes fresh authority from actual ProcessNode preparation and passes the policy to execution', async () => {
  const state = {
    trackingInfo: { executionId: 'prompt-policy', startTime: 1, nodeExecutionTracker: [] },
    messages: [{ id: 'user', role: 'user', content: 'Remember ticket 123', timestamp: 1 }],
    flowId: 'flow', conversationId: 'prompt-conversation', ephemeral: true,
    flowSnapshot: { id: 'flow', name: 'Flow', nodes: [], edges: [] } as unknown as Flow,
    title: 'Prompt policy', createdAt: 1, updatedAt: 1, frozenSystemPrompts: { process: 'old instructions' },
  } as SharedState;
  jest.spyOn(promptRenderer, 'renderPrompt').mockResolvedValue('new instructions');
  jest.spyOn(promptRenderer, 'resolveChatMessageReferences').mockImplementation(async text => text);
  const model = { id: 'model', name: 'Model', adapter: 'claude-cli', provider: 'claude-subscription', ApiKey: '' } as const;
  await saveItem(StorageKey.MODELS, [model]);
  jest.spyOn(modelService, 'getModel').mockResolvedValue(model as Awaited<ReturnType<typeof modelService.getModel>>);
  jest.spyOn(ModelHandler, 'isClaudeSessionResumeEnabled').mockResolvedValue(false);
  const params: ProcessNodeParams = { id: 'process', label: 'Process', type: 'process', properties: { boundModel: 'model', systemPromptPolicy: 'per-turn' } };
  const node = new ProcessNode();
  const prep = await node.prep(state, params);
  expect(prep.currentPrompt).toBe('new instructions');
  expect(prep.systemPromptPolicy).toBe('per-turn');
  expect(prep.messages.find(message => message.role === 'system')?.content).toBe('new instructions');
  expect(state.messages.some(message => typeof message.content === 'string' && message.content.startsWith('[System update]'))).toBe(false);
  const call = jest.spyOn(ModelHandler, 'callModel').mockRejectedValue(new Error('isolated-policy-boundary'));
  await node.execCore(prep, params).catch(() => undefined);
  expect(call).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'new instructions', systemPromptPolicy: 'per-turn' }));
});
