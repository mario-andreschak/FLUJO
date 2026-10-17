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

it.each(['Literal @receipt.txt', 'Literal ${global:UNDEFINED_PROMPT_REFERENCE}'])(
  'keeps eligible full-history Claude input when reference resolution leaves %s unchanged', async content => {
    const model = { id: 'literal-model', name: 'Model', adapter: 'claude-cli', provider: 'claude-subscription', ApiKey: '' } as const;
    await saveItem(StorageKey.MODELS, [model]);
    jest.spyOn(modelService, 'getModel').mockResolvedValue(model as Awaited<ReturnType<typeof modelService.getModel>>);
    jest.spyOn(ModelHandler, 'isClaudeSessionResumeEnabled').mockResolvedValue(true);
    jest.spyOn(promptRenderer, 'renderPrompt').mockResolvedValue('Current instructions');
    jest.spyOn(promptRenderer, 'resolveChatMessageReferences').mockImplementation(async text => text);
    const state = {
      trackingInfo: { executionId: 'literal-policy', startTime: 1, nodeExecutionTracker: [] },
      messages: [{ id: 'literal-user', role: 'user', content, timestamp: 1 }],
      flowId: 'literal-flow', conversationId: 'literal-conversation', ephemeral: true,
      flowSnapshot: { id: 'literal-flow', name: 'Literal flow', nodes: [], edges: [] } as unknown as Flow,
      title: 'Literal input', createdAt: 1, updatedAt: 1,
    } as SharedState;
    const prep = await new ProcessNode().prep(state, { id: 'literal-process', label: 'Process', type: 'process',
      properties: { boundModel: model.id, inputMode: 'full-history', systemPromptPolicy: 'per-turn' } });
    expect(prep.messages.find(message => message.id === 'literal-user')?.content).toBe(content);
    expect(prep.wireMessages).toBeUndefined();
    expect(state.messages[0].content).toBe(content);
  },
);

it('retains a wire-only projection when a chat reference actually changes', async () => {
  const model = { id: 'resolved-model', name: 'Model', adapter: 'claude-cli', provider: 'claude-subscription', ApiKey: '' } as const;
  await saveItem(StorageKey.MODELS, [model]);
  jest.spyOn(modelService, 'getModel').mockResolvedValue(model as Awaited<ReturnType<typeof modelService.getModel>>);
  jest.spyOn(ModelHandler, 'isClaudeSessionResumeEnabled').mockResolvedValue(true);
  jest.spyOn(promptRenderer, 'renderPrompt').mockResolvedValue('Current instructions');
  jest.spyOn(promptRenderer, 'resolveChatMessageReferences').mockResolvedValue('Resolved resource content');
  const state = {
    trackingInfo: { executionId: 'resolved-policy', startTime: 1, nodeExecutionTracker: [] },
    messages: [{ id: 'resolved-user', role: 'user', content: '@receipt.txt', timestamp: 1 }],
    flowId: 'resolved-flow', conversationId: 'resolved-conversation', ephemeral: true,
    flowSnapshot: { id: 'resolved-flow', name: 'Resolved flow', nodes: [], edges: [] } as unknown as Flow,
    title: 'Resolved input', createdAt: 1, updatedAt: 1,
  } as SharedState;
  const prep = await new ProcessNode().prep(state, { id: 'resolved-process', label: 'Process', type: 'process',
    properties: { boundModel: model.id, inputMode: 'full-history', systemPromptPolicy: 'per-turn' } });
  expect(prep.wireMessages?.find(message => message.id === 'resolved-user')?.content).toBe('Resolved resource content');
  expect(prep.messages.find(message => message.id === 'resolved-user')?.content).toBe('@receipt.txt');
  expect(state.messages[0].content).toBe('@receipt.txt');
});

it.each(['stable', 'per-turn'] as const)('archives the effective %s system instructions', async systemPromptPolicy => {
  const model = { id: 'archive-policy-model', name: 'Model', adapter: 'claude-cli', provider: 'claude-subscription', ApiKey: '' } as const;
  await saveItem(StorageKey.MODELS, [model]);
  jest.spyOn(modelService, 'getModel').mockResolvedValue(model as Awaited<ReturnType<typeof modelService.getModel>>);
  jest.spyOn(ModelHandler, 'isClaudeSessionResumeEnabled').mockResolvedValue(true);
  jest.spyOn(promptRenderer, 'renderPrompt').mockResolvedValue('Newly rendered instructions');
  const state = {
    trackingInfo: { executionId: 'archive-policy', startTime: 1, nodeExecutionTracker: [] },
    messages: [{ id: 'archive-user', role: 'user', content: 'Remember a ticket', timestamp: 1 }],
    flowId: 'archive-flow', conversationId: 'archive-conversation', ephemeral: true,
    flowSnapshot: { id: 'archive-flow', name: 'Archive flow', nodes: [], edges: [] } as unknown as Flow,
    title: 'Archive policy', createdAt: 1, updatedAt: 1, frozenSystemPrompts: { 'archive-process': 'Recorded instructions' },
  } as SharedState;
  const prep = await new ProcessNode().prep(state, { id: 'archive-process', label: 'Process', type: 'process',
    properties: { boundModel: model.id, systemPromptPolicy } });
  const expected = systemPromptPolicy === 'stable' ? 'Recorded instructions' : 'Newly rendered instructions';
  expect(prep.currentPrompt).toBe(expected);
  expect(prep.modelInputForArchive?.systemMessage?.content).toBe(expected);
  expect(prep.modelInputForArchive?.wireMessages.find(message => message.role === 'system')?.content).toBe(expected);
});
