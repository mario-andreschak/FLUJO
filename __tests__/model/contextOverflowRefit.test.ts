/**
 * Tests for the context-length overflow recovery in ModelHandler.
 *
 * compactForWire already shrinks OLD oversized tool results on the wire, but it
 * keeps the RECENT tail verbatim for prefix-cache stability. A single
 * unexpectedly-large NEW tool result (a big search dump, a large file read) can
 * therefore still overflow the model's context window on the very turn it is
 * produced — the provider rejects the whole request for length.
 *
 * ModelHandler.generateCompletion now catches that specific error and retries
 * ONCE, this time shrinking every oversized tool result on the wire (recent
 * included) to a head excerpt + a dereferenceable flujo://run/... URI that names
 * the full size, capturing any not-yet-captured result on the fly so the model
 * can read the whole thing back via read_resource.
 */
import type { FlowExecutionAuthority, SharedState } from '@/backend/execution/flow/types';
import type OpenAI from 'openai';
import { COMPACTION_SUMMARY_SECTIONS } from '@/backend/execution/flow/handlers/summarizingCompaction';

const loadItemMock = jest.fn();
jest.mock('@/utils/storage/backend', () => ({
  ...jest.requireActual('@/utils/storage/backend'),
  loadItem: (...args: unknown[]) => loadItemMock(...args),
}));
jest.mock('@/backend/execution/flow/persistConversationState', () => ({ persistConversationState: jest.fn(async () => undefined) }));

jest.mock('@/backend/execution/flow/FlowExecutor', () => ({
  FlowExecutor: { conversationStates: new Map() },
}));

const getModelMock = jest.fn();
const resolveKeyMock = jest.fn();
jest.mock('@/backend/services/model', () => ({
  modelService: {
    getModel: (...a: unknown[]) => getModelMock(...(a as [])),
    resolveAndDecryptApiKey: (...a: unknown[]) => resolveKeyMock(...(a as [])),
  },
}));

const listRunResourcesMock = jest.fn();
const writeRunResourceMock = jest.fn();
const getRunResourceSettingsMock = jest.fn();
const readRunResourceBoundedMock = jest.fn();
jest.mock('@/backend/services/runResources', () => ({
  listRunResources: (...a: unknown[]) => listRunResourcesMock(...(a as [])),
  writeRunResource: (...a: unknown[]) => writeRunResourceMock(...(a as [])),
  getRunResourceSettings: (...a: unknown[]) => getRunResourceSettingsMock(...(a as [])),
  readRunResourceBounded: (...a: unknown[]) => readRunResourceBoundedMock(...a),
  parseRunResourceUri: (uri: string) => {
    const match = /^flujo:\/\/run\/([\w-]+)\/([\w-]+)$/.exec(uri);
    return match ? { conversationId: match[1], id: match[2] } : null;
  },
}));

const OVERFLOW_MESSAGE =
  "This endpoint's maximum context length is 262144 tokens. However, you requested about " +
  '351213 tokens (347939 of text input, 3274 of tool input). Please reduce the length of ' +
  'either one, or use the context-compression plugin to compress your prompt automatically.';

// The programmable adapter rejects only an oversized wire payload. This lets
// the tests distinguish the proactive first-call refit from the reactive retry.
let calls: OpenAI.ChatCompletionMessageParam[][] = [];
const createCompletionMock = jest.fn((input: { messages: OpenAI.ChatCompletionMessageParam[] }) => {
  calls.push(input.messages);
  if (toolContentOf(input.messages).length > 3000) {
    return Promise.resolve({ completion: { error: { message: OVERFLOW_MESSAGE } } });
  }
  return Promise.resolve({
    completion: {
      id: 'cmpl-2',
      object: 'chat.completion',
      created: 2,
      model: 'test-model',
      choices: [
        { index: 0, finish_reason: 'stop', logprobs: null, message: { role: 'assistant', content: 'ok', refusal: null } },
      ],
    },
  });
});
const defaultCreateCompletion = createCompletionMock.getMockImplementation()!;
jest.mock('@/backend/services/model/adapters', () => ({
  getCompletionAdapter: () => ({ createCompletion: createCompletionMock }),
}));

import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { persistConversationState } from '@/backend/execution/flow/persistConversationState';

const conversationStates = FlowExecutor.conversationStates as Map<string, SharedState>;

const HUGE = 'x'.repeat(400_000);

const seedState = (conversationId: string): SharedState => {
  const state = {
    trackingInfo: { executionId: 'e1', startTime: 1, nodeExecutionTracker: [] },
    messages: [],
    flowId: 'flow-1',
    conversationId,
    status: 'running',
    title: 'T',
    createdAt: 1,
    updatedAt: 1,
  } as unknown as SharedState;
  conversationStates.set(conversationId, state);
  return state;
};

const callModel = (conversationId: string) =>
  ModelHandler.callModel({
    modelId: 'model-1',
    prompt: 'search',
    messages: [
      { role: 'user', content: 'search everything', id: 'u1', timestamp: 1 },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'search', arguments: '{}' } }],
        id: 'a1',
        timestamp: 2,
      },
      { role: 'tool', tool_call_id: 'call-1', content: HUGE, id: 't1', timestamp: 3 },
    ],
    iteration: 1,
    maxIterations: 1,
    nodeName: 'Node',
    nodeId: 'node-1',
    conversationId,
  } as Parameters<typeof ModelHandler.callModel>[0]);

const toolContentOf = (msgs: OpenAI.ChatCompletionMessageParam[]): string => {
  const tool = msgs.find((m) => m.role === 'tool') as OpenAI.ChatCompletionToolMessageParam | undefined;
  return typeof tool?.content === 'string' ? tool.content : '';
};

beforeEach(() => {
  readRunResourceBoundedMock.mockReset();
  loadItemMock.mockReset().mockImplementation(async (_key: unknown, fallback: unknown) => fallback);
  conversationStates.clear();
  jest.mocked(persistConversationState).mockReset().mockResolvedValue(undefined);
  calls = [];
  createCompletionMock.mockReset().mockImplementation(defaultCreateCompletion);
  getModelMock.mockReset().mockResolvedValue({ id: 'model-1', name: 'test-model', provider: 'openai' });
  resolveKeyMock.mockReset().mockResolvedValue('sk-test');
  listRunResourcesMock.mockReset().mockResolvedValue([]); // no prior captures → no markers
  getRunResourceSettingsMock.mockReset().mockResolvedValue({
    autoCaptureEnabled: true,
    textThresholdChars: 8192,
    maxResourceBytes: 50 * 1024 * 1024,
    maxConversationBytes: 256 * 1024 * 1024,
    replaceLargeTextWithStub: false,
  });
  writeRunResourceMock.mockReset().mockResolvedValue({
    uri: 'flujo://run/conv-of/res-1',
    size: HUGE.length,
    kind: 'text',
    mimeType: 'text/plain',
  });
});

afterEach(() => jest.restoreAllMocks());

describe('runtime compaction policy settings', () => {
  const runtime = ModelHandler as unknown as {
    getCompactionGlobalSettings: () => Promise<{ compactionEnabled?: boolean; compactionThresholdPercent?: number }>;
    maybeCompactWire: (...args: unknown[]) => Promise<unknown>;
    generateCompletion: (...args: unknown[]) => Promise<{ success: true; value: { content: string } }>;
  };

  it('keeps a verified summary through tool follow-ups to the same user request', async () => {
    loadItemMock.mockResolvedValue({ experimental: { compactionEnabled: true, compactionKeepTokens: 20 } });
    const state = seedState('tool-followup');
    const summary = COMPACTION_SUMMARY_SECTIONS.map(section => section + '\n- None.').join('\n\n');
    const generate = jest.spyOn(runtime, 'generateCompletion').mockResolvedValue({ success: true, value: { content: summary } });
    const model = { id: 'model-1', contextWindow: 16_000, compactionThreshold: 1_000 };
    const source: SharedState['messages'] = [
      { id: 'u-old', role: 'user', content: 'Never publish.', timestamp: 1 },
      { id: 'a-old', role: 'assistant', content: 'historical observation '.repeat(800), timestamp: 2 },
      { id: 'a-tail', role: 'assistant', content: 'recent observation '.repeat(80), timestamp: 3 },
      { id: 'u-current', role: 'user', content: 'Check the receipt ID. Return only JSON with receipt as the exact ID string.', timestamp: 4 },
    ];
    const compact = (messages: SharedState['messages']) => runtime.maybeCompactWire(
      messages, 'tool-followup', 'node-1', 'full-history', model, 100,
    );
    const first = await compact(source);
    const artifact = state.compactionState!.artifacts[0];
    // A rejected second summary must never undo the valid projection from this request.
    generate.mockResolvedValue({ success: true, value: { content: '{"receipt":"exact"}' } });
    const followup: SharedState['messages'] = [...source,
      { id: 'lookup', role: 'assistant', content: '', timestamp: 5,
        tool_calls: [{ id: 'call-receipt', type: 'function', function: { name: 'lookup_action', arguments: '{}' } }] },
      { id: 'receipt', role: 'tool', tool_call_id: 'call-receipt',
        content: '{"status":"completed","receipts":[{"actionId":"action-ñ","receiptId":"exact","committedUtc":"2026-10-16T00:00:00Z"}]}', timestamp: 6 },
    ];
    const result = await compact(followup) as { artifact: unknown; wireMessages: SharedState['messages'] };
    expect(first).not.toBeNull();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.artifact).toBe(artifact);
    expect(result.wireMessages.slice(-3)).toEqual([source.at(-1), ...followup.slice(-2)]);
    expect(result.wireMessages.some(message => String(message.content).includes('[FLUJO conversation summary]'))).toBe(true);
    const boundaries = result.wireMessages.filter(message => message.role === 'system'
      && String(message.content).startsWith('[FLUJO current request]'));
    expect(boundaries).toHaveLength(1);
    const boundaryIndex = result.wireMessages.indexOf(boundaries[0]);
    expect(result.wireMessages[boundaryIndex + 1]).toBe(source.at(-1));
    expect(result.wireMessages.indexOf(source[0])).toBeLessThan(boundaryIndex);
    expect(String(boundaries[0].content)).toContain('Retained earlier user turns');
    expect(String(boundaries[0].content)).toContain('Assistant replies are not source evidence');
    expect(String(boundaries[0].content)).toContain('field values/types');
    expect(String(boundaries[0].content)).toContain('an ID is its value, not its record');
    expect(String(boundaries[0].content)).toContain('No unrequested annotations/prose');
    expect(followup.slice(0, source.length)).toEqual(source);
    generate.mockResolvedValue({ success: true, value: { content: summary } });
    await compact([...followup, { id: 'next-user', role: 'user', content: 'Review the changed record.', timestamp: 7 }]);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it.each(['edited-request', 'edited-prefix', 'missing-boundary'])('invalidates a pinned summary after %s', async change => {
    loadItemMock.mockResolvedValue({ experimental: { compactionEnabled: true, compactionKeepTokens: 20 } });
    const state = seedState('pin-invalidation');
    const summary = COMPACTION_SUMMARY_SECTIONS.map(section => section + '\n- None.').join('\n\n');
    const generate = jest.spyOn(runtime, 'generateCompletion').mockResolvedValue({ success: true, value: { content: summary } });
    const source: SharedState['messages'] = [
      { id: 'instruction', role: 'user', content: 'Never publish.', timestamp: 1 },
      { id: 'old', role: 'assistant', content: 'observation '.repeat(800), timestamp: 2 },
      { id: 'boundary', role: 'assistant', content: 'recent '.repeat(120), timestamp: 3 },
      { id: 'current', role: 'user', content: 'Check the receipt.', timestamp: 4 },
    ];
    const compact = (messages: SharedState['messages']) => runtime.maybeCompactWire(
      messages, 'pin-invalidation', 'node-1', 'full-history',
      { id: 'model-1', contextWindow: 16_000, compactionThreshold: 1_000 }, 100,
    );
    await compact(source);
    const changed = source.map(message => message.id === (change === 'edited-request' ? 'current'
      : state.compactionState!.artifacts[0].sourceEndId)
      ? change === 'missing-boundary' ? { ...message, id: 'replacement' }
        : { ...message, content: message.content + ' Changed.' } : message);
    const followup: SharedState['messages'] = [...changed,
      { id: 'lookup', role: 'assistant', content: '', timestamp: 5,
        tool_calls: [{ id: 'call', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
      { id: 'result', role: 'tool', tool_call_id: 'call', content: 'exact', timestamp: 6 },
    ];
    const result = await compact(followup) as { wireMessages: SharedState['messages'] };
    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.wireMessages).toContain(changed[0]);
    expect(result.wireMessages.slice(-2)).toEqual(followup.slice(-2));
  });

  it('loads a saved percentage and keeps the documented disabled policy after a settings error', async () => {
    loadItemMock.mockResolvedValueOnce({ experimental: { compactionThresholdPercent: 60 } });
    expect(await runtime.getCompactionGlobalSettings()).toMatchObject({ compactionThresholdPercent: 60 });
    loadItemMock.mockRejectedValueOnce(new Error('settings unavailable'));
    expect(await runtime.getCompactionGlobalSettings()).toMatchObject({ compactionEnabled: false });
  });

  it('uses the model percentage and current tools/new history despite an old tiny prompt count', async () => {
    loadItemMock.mockResolvedValue({ experimental: { compactionEnabled: true, compactionKeepTokens: 20,
      compactionThresholdPercent: 90 } });
    const summary = COMPACTION_SUMMARY_SECTIONS.map(section => section + '\n- None.').join('\n\n');
    const generate = jest.spyOn(runtime, 'generateCompletion').mockResolvedValue({
      success: true, value: { content: summary },
    });
    const source = [
      { id: 'old-user', role: 'user', content: 'No enviar correo.', timestamp: 1 },
      { id: 'old-prose', role: 'assistant', content: 'x'.repeat(6_000), timestamp: 2 },
      { id: 'last-usage', role: 'assistant', content: 'ok', timestamp: 3, usage: { promptTokens: 1 } },
      { id: 'new-user', role: 'user', content: 'Continue.', timestamp: 4 },
    ];
    const tools: OpenAI.ChatCompletionFunctionTool[] = [{ type: 'function', function: {
      name: 'read', description: 'schema '.repeat(700), parameters: { type: 'object', properties: {} },
    } }];
    const model = { id: 'model-1', contextWindow: 5_000, compactionThresholdPercent: 20 };
    const result = await runtime.maybeCompactWire(source, 'settings-test', 'node-1', 'full-history', model,
      100, undefined, {}, tools);
    expect(result).not.toBeNull();
    expect(generate).toHaveBeenCalledTimes(1);
    generate.mockClear();
    await runtime.maybeCompactWire(source, 'settings-test', 'node-1', 'full-history',
      { ...model, compactionThresholdPercent: undefined }, 100, undefined, {}, tools);
    expect(generate).not.toHaveBeenCalled();
  });

  it('reuses an unchanged old prefix as the recent tail grows and invalidates an edited prefix', async () => {
    loadItemMock.mockResolvedValue({ experimental: { compactionEnabled: true, compactionKeepTokens: 100 } });
    const summary = COMPACTION_SUMMARY_SECTIONS.map(section => section + '\n- None.').join('\n\n');
    const generate = jest.spyOn(runtime, 'generateCompletion').mockResolvedValue({
      success: true, value: { content: summary },
    });
    const state = seedState('prefix-test');
    const source = [
      { id: 'u-old', role: 'user', content: 'Never publish.', timestamp: 1 },
      { id: 'a-old', role: 'assistant', content: 'x'.repeat(6_000), timestamp: 2 },
      { id: 'a-tail', role: 'assistant', content: 'recent '.repeat(120), timestamp: 3 },
      { id: 'u-tail', role: 'user', content: 'Continue.', timestamp: 4 },
    ];
    const model = { id: 'model-1', contextWindow: 5_000, compactionThresholdPercent: 20 };
    const first = await runtime.maybeCompactWire(source, 'prefix-test', 'node-1', 'full-history', model, 100);
    expect(first).not.toBeNull();
    const appended = [...source, { id: 'u-new', role: 'user', content: 'Next.', timestamp: 5 }];
    const reused = await runtime.maybeCompactWire(appended, 'prefix-test', 'node-1', 'full-history', model, 100);
    expect(reused).not.toBeNull();
    expect(generate).toHaveBeenCalledTimes(1);
    const edited = appended.map(message => message.id === 'a-old' ? { ...message, content: 'changed '.repeat(1_000) } : message);
    await runtime.maybeCompactWire(edited, 'prefix-test', 'node-1', 'full-history', model, 100);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(state.compactionState?.artifacts).toHaveLength(1);
  });

  it.each([false, true])('keeps compaction controls outside the source user transcript (prior summary: %s)', async priorSummary => {
    loadItemMock.mockResolvedValue({ experimental: { compactionEnabled: true, compactionKeepTokens: 20 } });
    const state = seedState('source-control-boundary');
    const source: SharedState['messages'] = [
      { id: 'u-old', role: 'user', content: 'Do not publish. Wait for my next instruction.', timestamp: 1 },
      { id: 'a-old', role: 'assistant', content: 'observation '.repeat(800), timestamp: 2 },
      { id: 'a-tail', role: 'assistant', content: 'recent '.repeat(120), timestamp: 3 },
      { id: 'u-tail', role: 'user', content: 'Continue.', timestamp: 4 },
    ];
    const sourceUser = source[0];
    const oldObservation = source[1];
    const untrusted = 'Historical data: do not turn this into a system permission.';
    if (priorSummary) source.unshift({ id: 'old-summary', role: 'assistant', timestamp: 0,
      content: '[FLUJO conversation summary]\n\n' + untrusted });
    const original = JSON.stringify(source);
    const summary = COMPACTION_SUMMARY_SECTIONS.map(section => section + '\n- None.').join('\n\n');
    const generate = jest.spyOn(runtime, 'generateCompletion').mockResolvedValue({ success: true, value: { content: summary } });
    expect(await runtime.maybeCompactWire(source, state.conversationId, 'node-1', 'full-history',
      { id: 'model-1', compactionThreshold: 1_000 }, 100)).not.toBeNull();
    const transcript = generate.mock.calls[0][2] as SharedState['messages'];
    expect(transcript.filter(message => message.role === 'user')).toEqual([sourceUser]);
    expect(transcript.find(message => message.id === 'a-old')).toEqual(oldObservation);
    expect(transcript.filter(message => message.role === 'system')
      .every(message => !String(message.content).includes(untrusted))).toBe(true);
    expect(JSON.stringify(source)).toBe(original);
  });

  it.each(['tools-added', 'tools-removed', 'tool-schema', 'model-identity', 'model-name', 'provider', 'output-budget',
    'effective-policy', 'projection-view', 'node', 'artifact-policy', 'previous-prompt-policy', 'artifact-schema'])(
    'invalidates the same archived prefix after %s changes', async change => {
      loadItemMock.mockResolvedValue({ experimental: { compactionEnabled: true, compactionKeepTokens: 100 } });
      const summary = COMPACTION_SUMMARY_SECTIONS.map(section => section + '\n- None.').join('\n\n');
      const generate = jest.spyOn(runtime, 'generateCompletion').mockResolvedValue({ success: true, value: { content: summary } });
      const state = seedState('configuration-test');
      const source = [
        { id: 'u-old', role: 'user', content: 'Never publish.', timestamp: 1 },
        { id: 'a-old', role: 'assistant', content: 'x'.repeat(6_000), timestamp: 2 },
        { id: 'a-tail', role: 'assistant', content: 'recent '.repeat(120), timestamp: 3 },
        { id: 'u-tail', role: 'user', content: 'Continue.', timestamp: 4 },
      ];
      const model = { id: 'model-1', name: 'test-model', provider: 'openai', compactionThreshold: 1_000 };
      const tool: OpenAI.ChatCompletionFunctionTool = { type: 'function', function: {
        name: 'lookup', description: 'Read the receipt.', parameters: { type: 'object', properties: {} },
      } };
      const initialTools = change === 'tools-added' ? undefined : [tool];
      await runtime.maybeCompactWire(source, 'configuration-test', 'node-1', 'full-history', model, 100, undefined, {}, initialTools);
      const original = state.compactionState!.artifacts[0];
      await runtime.maybeCompactWire(source, 'configuration-test', 'node-1', 'full-history', model, 100, undefined, {}, initialTools);
      expect(generate).toHaveBeenCalledTimes(1);
      if (change === 'artifact-policy') original.policyVersion = 'summary-v2-legacy';
      if (change === 'previous-prompt-policy') original.policyVersion = 'summary-v5-source-observations';
      if (change === 'artifact-schema') Object.assign(original, { schemaVersion: 0 });
      const changedModel = { ...model,
        ...(change === 'model-identity' ? { id: 'model-2' } : {}),
        ...(change === 'model-name' ? { name: 'replacement-model' } : {}),
        ...(change === 'provider' ? { provider: 'replacement-provider' } : {}),
        ...(change === 'effective-policy' ? { compactionThreshold: 1_100 } : {}),
      };
      const changedTools = change === 'tools-removed' ? undefined : change === 'tool-schema'
        ? [{ ...tool, function: { ...tool.function, parameters: { type: 'object', properties: { receipt: { type: 'string' } } } } }]
        : [tool];
      await runtime.maybeCompactWire(source, 'configuration-test', change === 'node' ? 'node-2' : 'node-1',
        change === 'projection-view' ? 'node-projected' : 'full-history', changedModel,
        change === 'output-budget' ? 200 : 100, undefined, {}, changedTools);
      expect(generate).toHaveBeenCalledTimes(2);
      const next = state.compactionState!.artifacts.at(-1)!;
      expect(next.artifactId).not.toBe(original.artifactId);
      expect(next.sourceDigest).toBe(original.sourceDigest);
      expect(next.policyVersion).toBe('summary-v7-authority');
      expect(next.schemaVersion).toBe(1);
      expect(source[0].content).toBe('Never publish.');
    },
  );

  it('refuses provider-truncated summaries even when all five section headings are present', async () => {
    loadItemMock.mockResolvedValue({ experimental: { compactionEnabled: true, compactionKeepTokens: 20 } });
    const summary = COMPACTION_SUMMARY_SECTIONS.map(section => section + '\n- None.').join('\n\n');
    jest.spyOn(runtime, 'generateCompletion').mockResolvedValue({ success: true, value: {
      content: summary, fullResponse: { choices: [{ finish_reason: 'length' }] },
    } } as unknown as Awaited<ReturnType<typeof runtime.generateCompletion>>);
    const source = [
      { id: 'u1', role: 'user', content: 'Never publish.', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: 'x'.repeat(8_000), timestamp: 2 },
      { id: 'a2', role: 'assistant', content: 'recent', timestamp: 3 },
      { id: 'u2', role: 'user', content: 'Continue.', timestamp: 4 },
    ];
    expect(await runtime.maybeCompactWire(source, 'truncated-test', 'node-1', 'full-history',
      { id: 'model-1', compactionThreshold: 1_000 }, 100)).toBeNull();
    expect(writeRunResourceMock).not.toHaveBeenCalled();
  });

  it('discards a summary generated across a source edit and retries from the changed history', async () => {
    loadItemMock.mockResolvedValue({ experimental: { compactionEnabled: true, compactionKeepTokens: 20 } });
    const state = seedState('edited-during-summary');
    const source: SharedState['messages'] = [
      { id: 'u1', role: 'user', content: 'Never publish.', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: 'old observation '.repeat(800), timestamp: 2 },
      { id: 'a2', role: 'assistant', content: 'recent', timestamp: 3 },
      { id: 'u2', role: 'user', content: 'Continue.', timestamp: 4 },
    ];
    state.messages = source;
    const summary = COMPACTION_SUMMARY_SECTIONS.map(section => section + '\n- None.').join('\n\n');
    const generate = jest.spyOn(runtime, 'generateCompletion').mockImplementationOnce(async () => {
      source[1].content = 'corrected observation '.repeat(800);
      return { success: true, value: { content: summary } };
    }).mockResolvedValue({ success: true, value: { content: summary } });
    const model = { id: 'model-1', compactionThreshold: 1_000 };
    expect(await runtime.maybeCompactWire(source, state.conversationId, 'node-1', 'full-history', model, 100)).toBeNull();
    expect(state.compactionState).toBeUndefined();
    expect(persistConversationState).not.toHaveBeenCalled();
    const corrected = JSON.stringify(source);
    expect(await runtime.maybeCompactWire(source, state.conversationId, 'node-1', 'full-history', model, 100)).not.toBeNull();
    expect(generate).toHaveBeenCalledTimes(2);
    expect(state.compactionState?.artifacts).toHaveLength(1);
    expect(JSON.stringify(source)).toBe(corrected);
  });

  it.each(['anchor', 'metadata'])('keeps the last durable artifact after %s persistence fails and can recover', async failure => {
    loadItemMock.mockResolvedValue({ experimental: { compactionEnabled: true, compactionKeepTokens: 20 } });
    const state = seedState('persistence-' + failure);
    const source: SharedState['messages'] = [
      { id: 'u1', role: 'user', content: 'Never publish.', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: 'old observation '.repeat(800), timestamp: 2 },
      { id: 'a2', role: 'assistant', content: 'recent', timestamp: 3 },
      { id: 'u2', role: 'user', content: 'Continue.', timestamp: 4 },
    ];
    state.messages = source;
    const summary = COMPACTION_SUMMARY_SECTIONS.map(section => section + '\n- None.').join('\n\n');
    const generate = jest.spyOn(runtime, 'generateCompletion').mockResolvedValue({ success: true, value: { content: summary } });
    const model = { id: 'model-1', compactionThreshold: 1_000 };
    const args = [state.conversationId, 'node-1', 'full-history', model, 100];
    expect(await runtime.maybeCompactWire(source, ...args)).not.toBeNull();
    const previous = state.compactionState;
    source[1].content = 'updated observation '.repeat(800);
    const canonical = JSON.stringify(source);
    if (failure === 'anchor') writeRunResourceMock.mockRejectedValueOnce(new Error('Disk unavailable'));
    else jest.mocked(persistConversationState).mockRejectedValueOnce(new Error('Disk unavailable'));
    expect(await runtime.maybeCompactWire(source, ...args)).toBeNull();
    expect(state.compactionState).toBe(previous);
    expect(JSON.stringify(source)).toBe(canonical);
    expect(await runtime.maybeCompactWire(source, ...args)).not.toBeNull();
    expect(state.compactionState?.artifacts).toHaveLength(1);
    expect(state.compactionState?.artifacts[0].artifactId).not.toBe(previous?.artifacts[0].artifactId);
    expect(JSON.stringify(source)).toBe(canonical);
    expect(generate).toHaveBeenCalledTimes(3);
    expect(await runtime.maybeCompactWire(source, ...args)).not.toBeNull();
    expect(generate).toHaveBeenCalledTimes(3);
  });
});

describe('context-length overflow refit', () => {
  it('provides a scoped in-loop executor for a reader armed after native call preparation', async () => {
    getModelMock.mockResolvedValue({ id: 'model-1', name: 'test-codex', provider: 'codex',
      adapter: 'codex-cli', contextWindow: 10_000, maxTokens: 100 });
    const uri = 'flujo://run/late-reader/res-1';
    writeRunResourceMock.mockResolvedValue({ uri, size: HUGE.length, kind: 'text', mimeType: 'text/plain',
      producedBy: { toolCallId: 'call-1' } });
    readRunResourceBoundedMock.mockResolvedValue({ entry: { uri, kind: 'text', size: HUGE.length },
      content: 'tail receipt', truncated: false, range: { startChar: 390_000, endChar: 390_012 } });
    createCompletionMock.mockImplementationOnce(async (input: { messages: OpenAI.ChatCompletionMessageParam[];
      tools?: OpenAI.ChatCompletionFunctionTool[];
      localToolExecutors?: Record<string, (args: Record<string, unknown>) => Promise<unknown>> }) => {
      calls.push(input.messages);
      expect(input.tools?.some(tool => tool.function.name === 'read_resource')).toBe(true);
      expect(await input.localToolExecutors!.read_resource({ uri, start_char: 390_000, max_chars: 100 }))
        .toMatchObject({ content: 'tail receipt' });
      return { completion: { id: 'cmpl-native-recovery', object: 'chat.completion', created: 1, model: 'test-codex',
        choices: [{ index: 0, finish_reason: 'stop', logprobs: null,
          message: { role: 'assistant', content: 'recovered', refusal: null } }] } };
    });
    seedState('late-reader');
    const result = await callModel('late-reader');
    if (!result.success) throw new Error(result.error.message);
    expect(result).toMatchObject({ success: true });
    expect(readRunResourceBoundedMock).toHaveBeenCalledWith(uri,
      expect.objectContaining({ startChar: 390_000, maxChars: 100 }));
    expect(createCompletionMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry by discarding an observation when its exact capture fails', async () => {
    seedState('capture-failed');
    writeRunResourceMock.mockRejectedValue(new Error('resource disk unavailable'));
    const result = await callModel('capture-failed');
    expect(result.success).toBe(false);
    expect(createCompletionMock).toHaveBeenCalledTimes(1);
    expect(toolContentOf(calls[0])).toBe(HUGE);
  });

  it('retains the reader for captured small results introduced only by the emergency receipt', async () => {
    getModelMock.mockResolvedValue({ id: 'model-1', name: 'test-model', provider: 'openai', contextWindow: 6_100, maxTokens: 100 });
    listRunResourcesMock.mockResolvedValue(Array.from({ length: 8 }, (_, index) => ({
      uri: 'flujo://run/small-receipt/resource-' + index, kind: 'text', size: 1_500,
      producedBy: { source: 'tool-result', toolCallId: 'call-' + index, payloadRole: 'tool-message' },
    })));
    let offered: OpenAI.ChatCompletionFunctionTool[] | undefined;
    createCompletionMock.mockImplementationOnce(async (input: { messages: OpenAI.ChatCompletionMessageParam[];
      tools?: OpenAI.ChatCompletionFunctionTool[] }) => {
      calls.push(input.messages);
      offered = input.tools;
      return { completion: { id: 'cmpl-small-recovery', object: 'chat.completion', created: 1, model: 'test-model',
        choices: [{ index: 0, finish_reason: 'stop', logprobs: null,
          message: { role: 'assistant', content: 'continued', refusal: null } }] } };
    });
    const messages = [
      { role: 'user', content: 'Do not repeat any completed action.', id: 'u-old', timestamp: 1 },
      ...Array.from({ length: 8 }, (_, index) => [
        { role: 'assistant', content: '', id: 'a-' + index, timestamp: 2 + index,
          tool_calls: [{ id: 'call-' + index, type: 'function', function: { name: 'read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call-' + index, content: 'x'.repeat(1_500), id: 't-' + index, timestamp: 2 + index },
      ]).flat(),
      { role: 'user', content: 'Continue.', id: 'u-now', timestamp: 20 },
    ];
    seedState('small-receipt');
    const result = await ModelHandler.callModel({ modelId: 'model-1', prompt: '', messages,
      tools: [{ type: 'function', function: { name: 'optional', description: 'schema '.repeat(8_000),
        parameters: { type: 'object', properties: {} } } }],
      iteration: 1, maxIterations: 1, nodeId: 'node-1', nodeName: 'Node', conversationId: 'small-receipt',
    } as Parameters<typeof ModelHandler.callModel>[0]);
    if (!result.success) throw new Error(result.error.message);
    expect(JSON.stringify(calls[0])).toContain('flujo://run/small-receipt/');
    expect(offered?.map(tool => tool.function.name)).toEqual(['read_resource']);
    expect(createCompletionMock).toHaveBeenCalledTimes(1);
  });

  it('retries once, shrinking the oversized recent tool result to a size-naming URI marker', async () => {
    seedState('conv-of');
    const result = await callModel('conv-of');

    // Retried exactly once (two provider calls total).
    expect(createCompletionMock).toHaveBeenCalledTimes(2);

    // First attempt carried the full result verbatim; the refit shrank it.
    expect(toolContentOf(calls[0]).length).toBe(400_000);
    const refit = toolContentOf(calls[1]);
    expect(refit.length).toBeLessThan(3000);
    expect(refit).toContain('flujo://run/conv-of/res-1');
    expect(refit).toContain('read_resource');
    expect(refit).toContain('400000'); // the full size is announced to the model

    // The uncaptured result was written to the store on the fly so it is recoverable.
    expect(writeRunResourceMock).toHaveBeenCalledTimes(1);
    const writeArg = writeRunResourceMock.mock.calls[0][0];
    expect(writeArg.data.text.length).toBe(400_000);
    expect(writeArg.producedBy.toolCallId).toBe('call-1');

    // The retry succeeded.
    expect(result.success).toBe(true);
    if (result.success) expect(result.value.content).toBe('ok');
  });

  it('refits a known-context request before its first provider call', async () => {
    getModelMock.mockResolvedValue({
      id: 'model-1',
      name: 'test-model',
      provider: 'openai',
      contextWindow: 20_000,
      maxTokens: 4_096,
    });
    seedState('conv-budget');
    const result = await callModel('conv-budget');

    expect(createCompletionMock).toHaveBeenCalledTimes(1);
    const sent = toolContentOf(calls[0]);
    expect(sent.length).toBeLessThan(3000);
    expect(sent).toContain('flujo://run/conv-of/res-1');
    expect(writeRunResourceMock).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  it('does not retry on a non-overflow provider error', async () => {
    // A generic 400 must NOT trigger the (lossy) refit path.
    createCompletionMock.mockImplementationOnce((input: { messages: OpenAI.ChatCompletionMessageParam[] }) => {
      calls.push(input.messages);
      return Promise.resolve({ completion: { error: { message: 'Invalid request: bad tool schema' } } });
    });
    seedState('conv-plain');
    const result = await callModel('conv-plain');

    expect(createCompletionMock).toHaveBeenCalledTimes(1);
    expect(writeRunResourceMock).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it('recognizes Codex input_too_large and retries a self-orchestrating adapter with an emergency marker', async () => {
    getModelMock.mockResolvedValue({
      id: 'model-1',
      name: 'test-codex',
      provider: 'codex',
      adapter: 'codex-cli',
    });
    createCompletionMock
      .mockImplementationOnce((input: { messages: OpenAI.ChatCompletionMessageParam[] }) => {
        calls.push(input.messages);
        return Promise.resolve({
          completion: {
            error: {
              message: 'turn/start failed: Input exceeds the maximum length of 1048576 characters.',
              code: -32602,
              data: { input_error_code: 'input_too_large' },
            },
          },
        });
      })
      .mockImplementationOnce((input: { messages: OpenAI.ChatCompletionMessageParam[] }) => {
        calls.push(input.messages);
        return Promise.resolve({
          completion: {
            id: 'cmpl-codex-retry',
            object: 'chat.completion',
            created: 2,
            model: 'test-codex',
            choices: [
              { index: 0, finish_reason: 'stop', logprobs: null, message: { role: 'assistant', content: 'recovered', refusal: null } },
            ],
          },
        });
      });
    seedState('conv-codex-overflow');

    const messages = [
      { role: 'user' as const, content: 'original task', id: 'u0', timestamp: 1 },
      ...Array.from({ length: 12 }, (_, index) => ({
        role: 'assistant' as const,
        content: `old-${index}-${'x'.repeat(4_000)}`,
        id: `a${index}`,
        timestamp: index + 2,
      })),
      { role: 'user' as const, content: 'latest task', id: 'u1', timestamp: 20 },
    ];
    const result = await ModelHandler.callModel({
      modelId: 'model-1',
      prompt: 'continue',
      messages,
      iteration: 1,
      maxIterations: 1,
      nodeName: 'Node',
      nodeId: 'node-1',
      conversationId: 'conv-codex-overflow',
    });

    expect(result.success).toBe(true);
    expect(createCompletionMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(calls[1])).toContain('[FLUJO emergency context compaction]');
    expect(JSON.stringify(calls[1]).length).toBeLessThan(JSON.stringify(calls[0]).length);
  });

  it('does not dispatch the provider when preflight outlives the current Persona lease', async () => {
    let current = true;
    const lost = new Error('Persona generation replaced during provider preflight');
    const assertCurrent = jest.fn(async () => {
      if (!current) throw lost;
    });
    const commitWhileCurrent = jest.fn(async <T>(task: () => Promise<T>): Promise<T> => {
      if (!current) throw lost;
      return task();
    }) as unknown as jest.MockedFunction<NonNullable<FlowExecutionAuthority['commitWhileCurrent']>>;
    resolveKeyMock.mockImplementationOnce(async () => {
      current = false;
      return 'sk-test';
    });
    seedState('conv-preflight');

    const pending = ModelHandler.callModel({
      modelId: 'model-1',
      prompt: 'hello',
      messages: [{ role: 'user', content: 'hello', id: 'u1', timestamp: 1 }],
      iteration: 1,
      maxIterations: 1,
      nodeName: 'Node',
      nodeId: 'node-1',
      conversationId: 'conv-preflight',
      executionAuthority: {
        assertCurrent,
        commitWhileCurrent,
        signal: new AbortController().signal,
      },
      personaAttribution: { personaId: 'persona-1', activityId: 'activity-1' },
    });

    await expect(pending).rejects.toMatchObject({ code: 'flow_execution_authority_lost' });
    expect(createCompletionMock).not.toHaveBeenCalled();
    expect(writeRunResourceMock).not.toHaveBeenCalled();
    expect(commitWhileCurrent).not.toHaveBeenCalled();
  });

  it('drops late provider media before resource creation when the Persona lease is lost in flight', async () => {
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    let markStarted!: () => void;
    const providerStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    createCompletionMock.mockImplementationOnce(async (input: { messages: OpenAI.ChatCompletionMessageParam[] }) => {
      calls.push(input.messages);
      markStarted();
      await providerGate;
      return {
        completion: {
          id: 'late-media',
          object: 'chat.completion',
          created: 3,
          model: 'test-model',
          choices: [
            { index: 0, finish_reason: 'stop', logprobs: null, message: { role: 'assistant', content: '', refusal: null } },
          ],
        },
        media: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }],
      };
    });

    let current = true;
    const lost = new Error('Persona generation replaced during provider call');
    const assertCurrent = jest.fn(async () => {
      if (!current) throw lost;
    });
    const commitWhileCurrent = jest.fn(async <T>(task: () => Promise<T>): Promise<T> => {
      if (!current) throw lost;
      return task();
    }) as unknown as jest.MockedFunction<NonNullable<FlowExecutionAuthority['commitWhileCurrent']>>;
    seedState('conv-late-media');

    const pending = ModelHandler.callModel({
      modelId: 'model-1',
      prompt: 'draw',
      messages: [{ role: 'user', content: 'draw', id: 'u1', timestamp: 1 }],
      iteration: 1,
      maxIterations: 1,
      nodeName: 'Node',
      nodeId: 'node-1',
      conversationId: 'conv-late-media',
      executionAuthority: {
        assertCurrent,
        commitWhileCurrent,
        signal: new AbortController().signal,
      },
      personaAttribution: { personaId: 'persona-1', activityId: 'activity-1' },
    });

    await providerStarted;
    current = false;
    releaseProvider();

    await expect(pending).rejects.toMatchObject({ code: 'flow_execution_authority_lost' });
    expect(createCompletionMock).toHaveBeenCalledTimes(1);
    expect(writeRunResourceMock).not.toHaveBeenCalled();
    expect(commitWhileCurrent).not.toHaveBeenCalled();
  });
});
