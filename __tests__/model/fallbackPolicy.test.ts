jest.mock('@/utils/storage/backend', () => ({ loadItem: jest.fn() }));
jest.mock('@/backend/services/model/encryption', () => ({ resolveAndDecryptApiKey: jest.fn(async key => key) }));
jest.mock('@/utils/workspace', () => ({ workspaceCacheKey: (...parts: string[]) => `${workspace}:${parts.join(':')}` }));

import { loadItem } from '@/utils/storage/backend';
import { FallbackAdapter, FallbackRoutingError, fallbackReason } from '@/backend/services/model/adapters/fallbackAdapter';
import { materializeFallbackPolicy, validateFallbackPolicy } from '@/shared/types/model/fallbackPolicy';
import type { Model } from '@/shared/types/model';
import type { CompletionInput, CompletionResult } from '@/backend/services/model/adapters/types';

let workspace = 'default';
const a: Model = { id: 'a', name: 'primary', ApiKey: 'key-a', provider: 'openai', temperature: '0.2', maxTokens: 200, contextWindow: 128000 };
const b: Model = { id: 'b', name: 'backup', ApiKey: 'key-b', provider: 'anthropic', adapter: 'anthropic', temperature: '0.7', maxTokens: 300, contextWindow: 64000 };
const policy: Model = { id: 'p', name: 'policy/prod', ApiKey: '', fallbackPolicy: { modelIds: ['a', 'b'], cooldownSeconds: 0 } };
const result: CompletionResult = { completion: { id: 'result', object: 'chat.completion', created: 1, model: 'backup', choices: [
  { index: 0, message: { role: 'assistant', content: 'OK', refusal: null }, finish_reason: 'stop', logprobs: null },
] } };
const input = (extra: Partial<CompletionInput> = {}): CompletionInput => ({ model: policy, apiKey: '', messages: [{ role: 'user', content: 'Hi' }], ...extra });
const limited = () => Object.assign(new Error('secret provider response'), { status: 429 });

beforeEach(() => {
  jest.clearAllMocks(); workspace = 'default';
  (loadItem as jest.Mock).mockResolvedValue([a, b, policy]);
});

it('falls back in order and uses each member’s credential and settings', async () => {
  const call = jest.fn().mockRejectedValueOnce(limited()).mockResolvedValueOnce(result);
  const receipt = await new FallbackAdapter(() => ({ createCompletion: call })).createCompletion(input());
  expect(call.mock.calls.map(([value]) => [value.model.id, value.apiKey, value.temperature, value.maxTokens])).toEqual([
    ['a', 'key-a', 0.2, 200], ['b', 'key-b', 0.7, 300],
  ]);
  expect(receipt.routing).toEqual({ policyId: 'p', selectedModelId: 'b', attempts: [
    { modelId: 'a', outcome: 'failed', reason: 'rate_limit' }, { modelId: 'b', outcome: 'completed' },
  ] });
  expect(JSON.stringify(receipt.routing)).not.toMatch(/key-|secret/);
});

it('preserves explicit token/temperature overrides', async () => {
  const call = jest.fn().mockResolvedValue(result);
  await new FallbackAdapter(() => ({ createCompletion: call })).createCompletion(input({ maxTokens: 42, temperatureOverride: 0.9 }));
  expect(call.mock.calls[0][0]).toMatchObject({ maxTokens: 42, temperature: 0.9 });
});

it.each([
  [429, 'rate_limit'], [503, 'unavailable'], [408, 'timeout'], [504, 'timeout'],
  [400, undefined], [401, undefined], [403, undefined],
])('classifies status %s narrowly', (status, reason) => {
  expect(fallbackReason(Object.assign(new Error('failure'), { status }))).toBe(reason);
});

it.each(['ECONNRESET', 'ENOTFOUND', 'APIConnectionError', 'overloaded_error'])('recognizes transient transport failure %s', code => {
  expect(fallbackReason({ code })).toBe('unavailable');
});

it.each(['AbortError', 'flow_execution_authority_lost', 'budget_denied'])('never falls back on %s', code => {
  expect(fallbackReason({ code, status: 503 })).toBeUndefined();
});

it.each(['delta', 'transcript', 'tool', 'local', 'steering'])('does not replay after %s activity', async kind => {
  const call = jest.fn(async (value: CompletionInput) => {
    if (kind === 'delta') value.onModelDelta!({ messageId: 'm', contentDelta: 'Hi' });
    if (kind === 'transcript') value.onTranscriptMessage!({ id: 'm', role: 'assistant', content: 'Hi' } as never);
    if (kind === 'tool') await value.beforeToolDispatch!();
    if (kind === 'local') await value.localToolExecutors!.effect({});
    if (kind === 'steering') value.consumeSteeringMessages!();
    throw limited();
  });
  await expect(new FallbackAdapter(() => ({ createCompletion: call })).createStreamCompletion(input({
    localToolExecutors: { effect: async () => 'done' },
    consumeSteeringMessages: () => [{ id: 'steer', role: 'user', content: 'change' } as never],
  }))).rejects.toMatchObject({ status: 429 });
  expect(call).toHaveBeenCalledTimes(1);
});

it('checks the dispatch fence for every member', async () => {
  const fence = jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce({ code: 'flow_execution_authority_lost' });
  const call = jest.fn().mockRejectedValue(limited());
  await expect(new FallbackAdapter(() => ({ createCompletion: call })).createCompletion(input({ beforeModelDispatch: fence })))
    .rejects.toMatchObject({ code: 'flow_execution_authority_lost' });
  expect(call).toHaveBeenCalledTimes(1);
  expect(fence).toHaveBeenCalledTimes(2);
});

it('does not dispatch after cancellation during a failed call', async () => {
  const abort = new AbortController();
  const call = jest.fn(async () => { abort.abort(); throw limited(); });
  await expect(new FallbackAdapter(() => ({ createCompletion: call })).createCompletion(input({ signal: abort.signal }))).rejects.toBeDefined();
  expect(call).toHaveBeenCalledTimes(1);
});

it('disables cross-model native session reuse', async () => {
  const call = jest.fn().mockResolvedValue(result);
  await new FallbackAdapter(() => ({ createCompletion: call })).createCompletion(input({ sessionResume: true }));
  expect(call.mock.calls[0][0]).toMatchObject({ sessionResume: false, codexSession: undefined, onCodexSessionChange: undefined });
});

it('honors trigger settings', async () => {
  const call = jest.fn().mockRejectedValue(limited());
  const model = { ...policy, fallbackPolicy: { ...policy.fallbackPolicy!, triggers: ['unavailable' as const] } };
  await expect(new FallbackAdapter(() => ({ createCompletion: call })).createCompletion(input({ model }))).rejects.toMatchObject({ status: 429 });
  expect(call).toHaveBeenCalledTimes(1);
});

it('treats HTTP-200 error bodies as failures', async () => {
  const call = jest.fn().mockResolvedValueOnce({ completion: { error: { code: 503 } } }).mockResolvedValueOnce(result);
  expect((await new FallbackAdapter(() => ({ createCompletion: call })).createCompletion(input())).routing?.selectedModelId).toBe('b');
});

it('returns a bounded, sanitized receipt when all members fail', async () => {
  const call = jest.fn().mockRejectedValue(limited());
  await expect(new FallbackAdapter(() => ({ createCompletion: call })).createCompletion(input())).rejects.toBeInstanceOf(FallbackRoutingError);
  expect(call).toHaveBeenCalledTimes(2);
});

it('scopes cooldown to workspace and invalidates it after configuration changes', async () => {
  const model = { ...policy, id: 'cooldown-policy', name: 'policy/cooldown', fallbackPolicy: { modelIds: ['a', 'b'], cooldownSeconds: 60 } };
  const call = jest.fn().mockImplementation(async (value: CompletionInput) => { if (value.model.id === 'a') throw limited(); return result; });
  const adapter = new FallbackAdapter(() => ({ createCompletion: call }));
  await adapter.createCompletion(input({ model }));
  const second = await adapter.createCompletion(input({ model }));
  expect(second.routing?.attempts[0].outcome).toBe('cooldown');
  workspace = 'other';
  await adapter.createCompletion(input({ model }));
  expect(call.mock.calls.map(([value]) => value.model.id)).toEqual(['a', 'b', 'b', 'a', 'b']);
  (loadItem as jest.Mock).mockResolvedValue([{ ...a, ApiKey: 'changed' }, b]);
  await adapter.createCompletion(input({ model }));
  expect(call.mock.calls[5][0].model.id).toBe('a');
});

it('skips self-orchestrating tools for direct API semantics', async () => {
  (loadItem as jest.Mock).mockResolvedValue([{ ...a, adapter: 'codex-cli' }, b]);
  const call = jest.fn().mockResolvedValue(result);
  const routed = await new FallbackAdapter(() => ({ createCompletion: call })).createCompletion(input({
    directCompletion: true, tools: [{ type: 'function', function: { name: 'f' } }],
  }));
  expect(routed.routing?.attempts[0].outcome).toBe('incompatible');
  expect(call.mock.calls[0][0].model.id).toBe('b');
});

it('skips a text-only member without dropping image input', async () => {
  (loadItem as jest.Mock).mockResolvedValue([{ ...a, inputModalities: ['text'] }, { ...b, inputModalities: ['text', 'image'] }]);
  const call = jest.fn().mockResolvedValue(result);
  const messages: CompletionInput['messages'] = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] }];
  const receipt = await new FallbackAdapter(() => ({ createCompletion: call })).createCompletion(input({ messages }));
  expect(receipt.routing?.selectedModelId).toBe('b');
  expect(call.mock.calls[0][0].messages).toEqual(messages);
});

describe('policy validation and metadata', () => {
  it('requires a stable stored policy ID', () => {
    expect(validateFallbackPolicy({ ...policy, id: '' }, [a, b])).toMatch(/ID is required/);
  });
  it.each([
    { modelIds: ['a'] }, { modelIds: ['a', 'a'] }, { modelIds: ['a', 'missing'] },
    { modelIds: ['a', 'p'] }, { modelIds: ['a', 'b'], cooldownSeconds: -1 },
    { modelIds: ['a', 'b'], triggers: ['anything'] },
  ])('rejects invalid policies %j', fallbackPolicy => {
    expect(validateFallbackPolicy({ ...policy, fallbackPolicy: fallbackPolicy as never }, [a, b, policy])).toBeDefined();
  });
  it('rejects nested policies and alias collisions', () => {
    expect(validateFallbackPolicy(policy, [a, { ...b, fallbackPolicy: policy.fallbackPolicy }])).toMatch(/Nested/);
    expect(validateFallbackPolicy(policy, [a, b, { ...policy, id: 'other' }])).toMatch(/exists/);
  });
  it('uses the smallest context window without copying a member credential or generation settings', () => {
    expect(materializeFallbackPolicy(policy, [a, b])).toMatchObject({ contextWindow: 64000, ApiKey: '', provider: 'openai' });
    expect(materializeFallbackPolicy(policy, [a, b]).temperature).toBeUndefined();
  });
});
