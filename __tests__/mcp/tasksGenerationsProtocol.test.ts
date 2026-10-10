jest.mock('@/backend/services/mcp/tasksExtensionSession', () => ({ getTasksExtensionSession: (client: { taskSession?: unknown }) => client.taskSession, wasModernTasksExtensionClient: () => false }));
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { z } from 'zod';
jest.mock('@/config/features', () => ({ FEATURES: { ENABLE_MCP_TASKS_CLIENT: true } }));
jest.mock('@/backend/services/mcp/remoteTaskStore', () => ({ getMcpRemoteTaskSettings: async () => ({ requestedTtlMs: 60000 }) }));
import { MCP_TASKS_EXTENSION_ID, classifyToolCallResult, parseCreateTaskResult, parseTaskStatusResult, computeTaskExpiresAt } from '@/shared/types/mcp/tasks';
import { buildTaskAugmentation, decideTaskAugmentation, discoverTaskNegotiation, fetchTaskStatus,
  fetchTaskPayload, cancelRemoteTask, updateRemoteTask, modernToolResultSchema } from '@/backend/services/mcp/tasksProtocol';

const generation = '2026-07-28' as const;
const modern = { resultType: 'task', taskId: 'task-modern', status: 'working', ttlMs: 60000,
  pollIntervalMs: 1234, createdAt: '2026-10-09T00:00:00Z', lastUpdatedAt: '2026-10-09T00:00:01Z' };
function client(capabilities: object, results: Record<string, unknown> = {}) {
  const request = jest.fn(async (req: { method: string }, schema: z.ZodType) => {
    if (!(req.method in results)) throw new Error('MethodNotFound');
    return schema.parse(results[req.method]);
  });
  const modern = 'extensions' in capabilities || Object.keys(results).some(method => method.startsWith('tasks/') || method === 'server/discover');
  const meta = { 'io.modelcontextprotocol/clientCapabilities': { extensions: { [MCP_TASKS_EXTENSION_ID]: {} } } };
  const invoke = (method: string, taskId: string, extra = {}) => request({ method, params: { taskId, ...extra, _meta: meta } } as { method: string }, z.unknown());
  return { request, getServerCapabilities: () => capabilities, getProtocolEra: () => modern ? 'modern' : 'legacy',
    taskSession: modern ? {
      getTask: (taskId: string) => invoke('tasks/get', taskId),
      cancelTask: async (taskId: string) => { z.object({ resultType: z.literal('complete') }).parse(await invoke('tasks/cancel', taskId)); },
      updateTask: async (taskId: string, inputResponses: unknown) => { z.object({ resultType: z.literal('complete') }).parse(await invoke('tasks/update', taskId, { inputResponses })); },
    } : undefined,
    listTools: jest.fn(async () => ({ tools: [{ name: 'legacy', execution: { taskSupport: 'optional' } }] })) };
}
const cast = (value: ReturnType<typeof client>) => value as unknown as Client;

it('uses the owned modern discovery without repeating negotiation and advertises per-request metadata without legacy task preference', async () => {
  const c = client({}, { 'server/discover': { capabilities: { extensions: { [MCP_TASKS_EXTENSION_ID]: {} } } } });
  expect((await decideTaskAugmentation(cast(c), 'any')).negotiation.generation).toBe(generation);
  await discoverTaskNegotiation(cast(c));
  expect(c.request).not.toHaveBeenCalled();
  expect(c.listTools).not.toHaveBeenCalled();
  expect(buildTaskAugmentation(1, generation)).toEqual({ _meta: {
    'io.modelcontextprotocol/clientCapabilities': { extensions: { [MCP_TASKS_EXTENSION_ID]: {} } },
  } });
});

it('preserves legacy and classic behavior when discovery fails', async () => {
  const legacy = client({ tasks: { requests: { tools: { call: {} } }, cancel: {} } });
  const choice = await decideTaskAugmentation(cast(legacy), 'legacy');
  expect(choice).toMatchObject({ request: true, ttlMs: 60000, negotiation: { generation: '2025-11-25' } });
  expect(buildTaskAugmentation(choice.ttlMs)).toEqual({ task: { ttl: 60000 } });
  expect((await decideTaskAugmentation(cast(client({})), 'anything')).request).toBe(false);
});

it('classifies negotiated flattened modern creation and rejects cross-generation handles', () => {
  expect(classifyToolCallResult(modern, { taskRequested: true, generation })).toMatchObject({ kind: 'task', task: { generation, ttl: 60000, pollInterval: 1234 } });
  expect(classifyToolCallResult(modern, { taskRequested: false, generation }).kind).toBe('protocol-invalid');
  expect(parseCreateTaskResult(modern).ok).toBe(false);
  expect(parseCreateTaskResult({ task: { taskId: 'x', status: 'working' } }, generation).ok).toBe(false);
  expect(classifyToolCallResult({ content: [], task: {} }, { taskRequested: true, generation })).toEqual({ kind: 'classic' });
  expect(modernToolResultSchema.safeParse(modern).success).toBe(true);
  expect(modernToolResultSchema.safeParse({ ...modern, ttl: 10 }).success).toBe(false);
  expect(modernToolResultSchema.safeParse({ content: [] }).success).toBe(true);
});

it.each([
  { ttlMs: -1 }, { ttlMs: 1.5 }, { createdAt: 'invalid' }, { pollIntervalMs: -1 },
  { task: {} }, { status: 'completed', result: { invalid: true } },
  { status: 'failed', error: { code: 'bad', message: 'error' } },
  { status: 'input_required', inputRequests: { x: { method: 'tools/call', params: {} } } },
  { status: 'working', result: { content: [] } },
])('rejects invalid modern status fields %j', change => {
  expect(parseTaskStatusResult({ ...modern, resultType: 'complete', ...change }, generation).ok).toBe(false);
});

it('validates keyed elicitation, structured failure, byte bounds and creation-based expiry', () => {
  const input = parseTaskStatusResult({ ...modern, resultType: 'complete', status: 'input_required', inputRequests: {
    question: { method: 'elicitation/create', params: { message: 'Name?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } } },
  } }, generation);
  expect(input.ok).toBe(true);
  const failed = parseTaskStatusResult({ ...modern, resultType: 'complete', status: 'failed', error: { code: -32603, message: 'failure', data: { diagnostic: 'known' } } }, generation);
  expect(failed).toMatchObject({ ok: true, task: { error: { code: -32603, data: { diagnostic: 'known' } } } });
  expect(parseTaskStatusResult({ ...modern, resultType: 'complete', extra: 'x'.repeat(1024 * 1024) }, generation).ok).toBe(false);
  const created = parseCreateTaskResult(modern, generation);
  if (!created.ok) throw new Error(created.reason);
  expect(computeTaskExpiresAt(created.task, Date.now(), 1000)).toBe(Date.parse(modern.createdAt) + 60000);
});

it('uses inline modern terminal results and empty cancel/update acknowledgements', async () => {
  const c = client({ extensions: { [MCP_TASKS_EXTENSION_ID]: {} } }, {
    'tasks/get': { ...modern, resultType: 'complete', status: 'completed', result: { content: [{ type: 'text', text: 'done' }] } },
    'tasks/cancel': { resultType: 'complete' }, 'tasks/update': { resultType: 'complete' },
  });
  const status = await fetchTaskStatus(cast(c), modern.taskId, { generation });
  expect(status.ok).toBe(true);
  expect(await fetchTaskPayload(cast(c), modern.taskId, { generation })).toEqual({ content: [{ type: 'text', text: 'done' }] });
  expect(await cancelRemoteTask(cast(c), modern.taskId, 100, generation)).toEqual({ ok: true, acknowledged: true });
  await updateRemoteTask(cast(c), modern.taskId, { question: { action: 'accept', content: { name: 'Local' } } }, { generation });
  expect(c.request.mock.calls.map(([req]) => req.method)).toEqual(['tasks/get', 'tasks/get', 'tasks/cancel', 'tasks/update']);
  for (const [req] of c.request.mock.calls) expect(req).toMatchObject({ params: { _meta: buildTaskAugmentation(undefined, generation)._meta } });
  await expect(updateRemoteTask(cast(c), modern.taskId, { question: { bogus: true } }, { generation })).rejects.toThrow();
  expect(c.request).toHaveBeenCalledTimes(4);
});

it('rejects a polled task with a different identity', async () => {
  const c = client({}, { 'tasks/get': { ...modern, resultType: 'complete', taskId: 'other' } });
  expect(await fetchTaskStatus(cast(c), modern.taskId, { generation })).toEqual({ ok: false, reason: 'task identity mismatch' });
});

it.each([null, false, 42, 'scalar', ['one', 2], { nested: ['json'] }])('preserves modern structured JSON %j through direct and terminal results', async structuredContent => {
  const result = { resultType: 'complete', content: [], structuredContent };
  expect(modernToolResultSchema.parse(result)).toEqual(result);
  const creation = { ...modern, status: 'completed', result };
  const created = parseCreateTaskResult(creation, generation);
  expect(created).toMatchObject({ ok: true, task: { result } });
  expect(modernToolResultSchema.parse(creation)).toEqual(creation);
  const terminal = { ...modern, resultType: 'complete', status: 'completed', result };
  const parsed = parseTaskStatusResult(terminal, generation);
  expect(parsed).toMatchObject({ ok: true, task: { result } });
  const c = client({}, { 'tasks/get': terminal });
  expect(await fetchTaskPayload(cast(c), modern.taskId, { generation })).toEqual(result);
  if (!created.ok) throw new Error(created.reason);
  const inline = client({ extensions: { [MCP_TASKS_EXTENSION_ID]: {} } });
  expect(await fetchTaskPayload(cast(inline), modern.taskId, { generation, terminalTask: created.task })).toEqual(result);
  expect(inline.request).not.toHaveBeenCalled();
});

it('fetches terminal status when a completed creation has no inline result', async () => {
  const created = parseCreateTaskResult({ ...modern, status: 'completed' }, generation);
  if (!created.ok) throw new Error(created.reason);
  const c = client({}, { 'tasks/get': { ...modern, resultType: 'complete', status: 'completed', result: { content: [], structuredContent: null } } });
  expect(await fetchTaskPayload(cast(c), modern.taskId, { generation, terminalTask: created.task })).toEqual({ content: [], structuredContent: null });
  expect(c.request).toHaveBeenCalledTimes(1);
});

it('requires modern content and rejects invalid content/structured values without widening legacy classification', () => {
  expect(modernToolResultSchema.safeParse({ structuredContent: {} }).success).toBe(false);
  expect(modernToolResultSchema.safeParse({ content: [{ type: 'invalid' }], structuredContent: null }).success).toBe(false);
  expect(modernToolResultSchema.safeParse({ content: [], structuredContent: Number.NaN }).success).toBe(false);
  expect(modernToolResultSchema.safeParse({ content: [], structuredContent: 'x'.repeat(1024 * 1024) }).success).toBe(false);
  // Legacy classification continues to defer ordinary results to its SDK path.
  expect(classifyToolCallResult({ content: [], structuredContent: 'scalar' }, { taskRequested: false })).toEqual({ kind: 'classic' });
});
