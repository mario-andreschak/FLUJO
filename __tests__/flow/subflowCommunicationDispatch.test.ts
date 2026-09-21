import type { SharedState, ToolDefinition } from '@/backend/execution/flow/types';
import type { CompletionInput } from '@/backend/services/model/adapters/types';
import type OpenAI from 'openai';

const liveStates = new Map<string, SharedState>();
jest.mock('@/backend/execution/flow/FlowExecutor', () => ({ FlowExecutor: { get conversationStates() { return liveStates; } } }));
const getModel = jest.fn();
jest.mock('@/backend/services/model', () => ({ modelService: {
  getModel: (...args: unknown[]) => getModel(...args), resolveAndDecryptApiKey: async () => 'test-key',
} }));
const completion = jest.fn();
jest.mock('@/backend/services/model/adapters', () => ({ getCompletionAdapter: () => ({ createCompletion: completion }) }));
const mcpCall = jest.fn();
jest.mock('@/backend/services/mcp', () => ({ mcpService: { loadServerConfigs: async () => [], callTool: (...args: unknown[]) => mcpCall(...args) } }));
jest.mock('@/backend/services/subflowTasks', () => ({ listTasks: async () => [], getTask: async () => null }));
const start = jest.fn(async () => ({ success: true, data: { childConversationId: 'child' } }));
const get = jest.fn(async () => ({ success: true, data: { task: { status: 'working' } } }));
const cancel = jest.fn(async () => ({ success: true, data: { status: 'cancelled' } }));
jest.mock('@/backend/execution/flow/handlers/subflowDetachedInvocation', () => ({
  SUBFLOW_DETACHED_TOOL_PREFIX: 'start_subflow_',
  executeDetachedSubflowStart: (...args: unknown[]) => (start as (...args: unknown[]) => unknown)(...args),
  executeTaskGet: (...args: unknown[]) => (get as (...args: unknown[]) => unknown)(...args),
  executeTaskCancel: (...args: unknown[]) => (cancel as (...args: unknown[]) => unknown)(...args),
}));
import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import { buildSubflowCommunicationTools } from '@/backend/execution/flow/subflowCommunication';
import { clearSteeringInbox, peekSteeringMessages } from '@/backend/execution/flow/steeringInbox';

const call = (name: string, args: unknown): OpenAI.ChatCompletionMessageFunctionToolCall => ({ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const wire = (tool: ToolDefinition): OpenAI.ChatCompletionFunctionTool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } });
beforeEach(() => {
  jest.clearAllMocks(); liveStates.clear(); clearSteeringInbox('child');
  liveStates.set('parent', { conversationId: 'parent', flowId: 'flow-parent', status: 'running', messages: [] } as unknown as SharedState);
  liveStates.set('child', { conversationId: 'child', parentRunId: 'parent', flowId: 'flow-child', status: 'running', messages: [] } as unknown as SharedState);
});

it('dispatches communication in the request/response tool loop without MCP routing', async () => {
  const result = await ModelHandler.processToolCalls({ conversationId: 'parent', toolCalls: [call('subflow_send_message', { target: 'child', message: 'Follow this correction' })] });
  expect(result.success).toBe(true);
  if (!result.success) throw new Error(result.error.message);
  expect(result.value.toolCallMessages[0].content).toContain('queued');
  expect(peekSteeringMessages('child')[0].content).toContain('Follow this correction');
  expect(mcpCall).not.toHaveBeenCalled();
});

it.each(['claude-cli', 'codex-cli'])('provides communication and background execution to %s automatically', async adapter => {
  getModel.mockResolvedValue({ id: 'model', name: 'test-model', provider: 'anthropic', adapter });
  completion.mockImplementationOnce(async (input: CompletionInput) => {
    const executors = input.localToolExecutors!;
    expect(Object.keys(executors)).toEqual(expect.arrayContaining(['subflow_list', 'subflow_send_message', 'subflow_wait', 'start_subflow_worker', 'subflow_task_get', 'subflow_task_cancel']));
    await executors.subflow_send_message({ target: 'child', message: 'Native correction' });
    await executors.start_subflow_worker({ task: 'Research' });
    await executors.subflow_task_get({ taskId: 'task' });
    await executors.subflow_task_cancel({ taskId: 'task' });
    expect(input.steering).toBeDefined();
    return { completion: { id: 'c', object: 'chat.completion', created: 1, model: 'test', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }] } };
  });
  const tools = [...buildSubflowCommunicationTools(), ...['start_subflow_worker', 'subflow_task_get', 'subflow_task_cancel'].map(name => ({ name, description: name, inputSchema: { type: 'object', properties: {} } }))];
  const result = await ModelHandler.callModel({ modelId: 'model', prompt: 'Coordinate', messages: [{ id: 'u', role: 'user', content: 'Work', timestamp: 1 }], tools: tools.map(wire), iteration: 1, maxIterations: 1, nodeId: 'process', nodeName: 'Parent', conversationId: 'parent' });
  expect(result.success).toBe(true);
  expect(completion).toHaveBeenCalledTimes(1);
  expect(peekSteeringMessages('child')[0].content).toContain('Native correction');
  expect(get).toHaveBeenCalledWith('task', expect.objectContaining({ conversationId: 'parent' }));
  expect(cancel).toHaveBeenCalledWith('task', expect.objectContaining({ conversationId: 'parent' }));
  expect(start).toHaveBeenCalledWith('start_subflow_worker', { task: 'Research' }, expect.objectContaining({ conversationId: 'parent' }));
  expect(mcpCall).not.toHaveBeenCalled();
});
