import type { SharedState } from '@/backend/execution/flow/types';
import type { FlujoChatMessage } from '@/shared/types/chat';
import { buildContextInfo } from '@/backend/execution/flow/conversationContextInfo';
import { toApiMessages } from '@/backend/execution/flow/buildNodeContext';

const getModel = jest.fn();
jest.mock('@/backend/services/model', () => ({ modelService: { getModel: (...args: unknown[]) => getModel(...args) } }));
jest.mock('@/backend/services/flow', () => ({ flowService: { getFlow: async () => ({ nodes: [{ id: 'node', data: { properties: { boundModel: 'model' } } }] }) } }));

const usage = { promptTokens: 5606187, completionTokens: 27510, totalTokens: 5633697 };
const contextUsage = { promptTokens: 165897, completionTokens: 390, totalTokens: 166287, contextWindow: 258400 };
const state = (message: Partial<FlujoChatMessage>) => ({
  flowId: 'flow', messages: [{ id: 'message', timestamp: 1, role: 'assistant', content: 'done', processNodeId: 'node', usage, ...message }],
}) as SharedState;

beforeEach(() => getModel.mockReset().mockResolvedValue({ adapter: 'codex-cli', name: 'Codex', contextWindow: 1000000 }));

it('uses the last request and runtime window independently from cumulative usage and catalog metadata', async () => {
  expect(await buildContextInfo(state({ contextUsage }))).toEqual({ ...contextUsage, nodeId: 'node', modelDisplayName: 'Codex' });
});

it('reports old SDK records and explicitly unavailable snapshots as unknown', async () => {
  expect(await buildContextInfo(state({}))).not.toHaveProperty('promptTokens');
  getModel.mockResolvedValue({ adapter: 'openai', name: 'Other', contextWindow: 1000000 });
  expect(await buildContextInfo(state({ contextUsage: null }))).not.toHaveProperty('promptTokens');
});

it('does not replace an unknown runtime limit with the configured 1M', async () => {
  const { contextWindow: _window, ...snapshot } = contextUsage;
  expect(await buildContextInfo(state({ contextUsage: snapshot }))).not.toHaveProperty('contextWindow');
});

it('retains snapshots on terminal tool messages and after model lookup fails', async () => {
  getModel.mockRejectedValue(new Error('removed model'));
  expect(await buildContextInfo(state({ role: 'tool', contextUsage }))).toEqual({ ...contextUsage, nodeId: 'node' });
});

it('preserves single-request adapter context including cached input', async () => {
  getModel.mockResolvedValue({ adapter: 'openai', name: 'OpenAI', contextWindow: 1000000 });
  expect(await buildContextInfo(state({ usage: { promptTokens: 100000, completionTokens: 200, totalTokens: 100200, cacheReadTokens: 90000 } })))
    .toMatchObject({ promptTokens: 100000, totalTokens: 100200, contextWindow: 1000000, contextWindowSource: 'configured' });
});

it('compares Gemini input against its input limit, keeping generated output separate', async () => {
  getModel.mockResolvedValue({ adapter: 'gemini', name: 'Gemini', contextWindow: 1000000 });
  const info = await buildContextInfo(state({ usage: { promptTokens: 100000, completionTokens: 200, totalTokens: 100200 } }));
  expect(info).toMatchObject({ promptTokens: 100000, completionTokens: 200, contextWindow: 1000000 });
  expect(info).not.toHaveProperty('totalTokens');
});

it('does not show an older snapshot when the latest run cannot report context', async () => {
  const conversation = state({ contextUsage });
  conversation.messages.push({ id: 'new', timestamp: 2, role: 'assistant', content: 'new', processNodeId: 'node', contextUsage: null });
  expect(await buildContextInfo(conversation)).not.toHaveProperty('promptTokens');
});

it('keeps context telemetry out of provider messages', () => {
  expect(toApiMessages(state({ contextUsage }).messages)).toEqual([{ role: 'assistant', content: 'done' }]);
});
