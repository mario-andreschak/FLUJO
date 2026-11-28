/**
 * Issue #1094 / #1449: an Antigravity CLI node continues its CLI conversation
 * across turns by default. There is no setting; the adapter falls back to
 * sending the whole chat whenever the saved conversation cannot be reopened.
 */
import type { SharedState } from '@/backend/execution/flow/types';

jest.mock('@/utils/logger', () => ({
  createLogger: () => ({ verbose: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));
jest.mock('@/backend/execution/flow/FlowExecutor', () => ({ FlowExecutor: { conversationStates: new Map() } }));

const getModelMock = jest.fn();
jest.mock('@/backend/services/model', () => ({
  modelService: {
    getModel: (...args: unknown[]) => getModelMock(...(args as [])),
    resolveAndDecryptApiKey: async () => '',
  },
}));
const createCompletionMock = jest.fn();
jest.mock('@/backend/services/model/adapters', () => ({
  getCompletionAdapter: () => ({ createCompletion: createCompletionMock }),
}));
jest.mock('@/backend/execution/flow/engine/ExecutionEventBus', () => ({ executionEventBus: { emitterFor: () => jest.fn() } }));
const loadItemMock = jest.fn();
jest.mock('@/utils/storage/backend', () => ({
  ...jest.requireActual('@/utils/storage/backend'),
  loadItem: (...args: unknown[]) => loadItemMock(...args),
}));

import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import { StorageKey } from '@/shared/types/storage';

const conversationStates = FlowExecutor.conversationStates as Map<string, SharedState>;

async function callModel(conversationId: string, extra: Partial<Parameters<typeof ModelHandler.callModel>[0]> = {}) {
  conversationStates.set(conversationId, {
    trackingInfo: { executionId: 'e1', startTime: 1, nodeExecutionTracker: [] },
    messages: [], flowId: 'flow-1', conversationId, status: 'running', title: 'Test', createdAt: 1, updatedAt: 1,
  } as unknown as SharedState);
  return ModelHandler.callModel({
    modelId: 'antigravity', prompt: 'Which word?',
    messages: [{ role: 'user', content: 'Which word?', id: 'u1', timestamp: 1 }],
    nodeName: 'Process', nodeId: 'process-node', conversationId, ...extra,
  } as Parameters<typeof ModelHandler.callModel>[0]);
}

beforeEach(() => {
  conversationStates.clear();
  createCompletionMock.mockReset().mockResolvedValue({ completion: {
    id: 'antigravity_cli_test', object: 'chat.completion', created: 1, model: 'gemini-3.1-pro',
    choices: [{ index: 0, finish_reason: 'stop', logprobs: null, message: { role: 'assistant', content: 'apple', refusal: null } }],
  } });
  getModelMock.mockReset().mockResolvedValue({ id: 'antigravity', name: 'gemini-3.1-pro', provider: 'antigravity-cli', adapter: 'antigravity-cli', ApiKey: '' });
  loadItemMock.mockReset().mockImplementation(async (_key: unknown, fallback: unknown) => fallback);
});

it('continues the CLI conversation with no setting saved', async () => {
  const result = await callModel('no-settings');
  expect(result.success).toBe(true);
  expect(createCompletionMock).toHaveBeenCalledTimes(1);
  expect(createCompletionMock.mock.calls[0][0]).toMatchObject({ sessionResume: true, conversationId: 'no-settings', nodeId: 'process-node' });
});

it('ignores the removed experimental switch that an older FLUJO saved as off', async () => {
  const saved = { experimental: { antigravitySessionResume: false, claudeSessionResume: false } };
  loadItemMock.mockImplementation(async (key: unknown, fallback: unknown) => key === StorageKey.SPEECH_SETTINGS ? saved : fallback);
  await callModel('old-switch-off');
  expect(createCompletionMock.mock.calls[0][0].sessionResume).toBe(true);
});

it('sends the whole chat when the node passes a scoped view of the conversation', async () => {
  await callModel('scoped-view', { wireMessages: [{ role: 'user', content: 'Which word?' }] } as Partial<Parameters<typeof ModelHandler.callModel>[0]>);
  expect(createCompletionMock.mock.calls[0][0].sessionResume).toBe(false);
});
