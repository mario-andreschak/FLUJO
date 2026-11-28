/**
 * #1091: Anthropic's own (on-demand) compaction through the real Anthropic SDK
 * against `scripts/anthropic-stand-in.mjs`, a local stand-in of Anthropic's
 * service that applies the documented compaction rules and signs every
 * summary. Proves the request shape, the byte-for-byte round trip of the
 * signed block, and every fallback: a gateway without the beta, a cut-off
 * summary, an overload, a refused replay.
 */
import OpenAI from 'openai';
import { AnthropicAdapter, __resetApiVersionSupport, __resetCacheControlSupport } from '@/backend/services/model/adapters/anthropicAdapter';
import {
  ANTHROPIC_COMPACTION_BETA,
  ANTHROPIC_COMPACTION_MAX_TOKENS,
  AnthropicCompactionMissingError,
  NATIVE_COMPACTION_RETRY_MS,
  __resetAnthropicCompactionSupport,
  anthropicCompactionAvailable,
} from '@/backend/services/model/adapters/anthropicCompaction';
import { COMPACTION_SUMMARY_MARKER } from '@/backend/execution/flow/handlers/summarizingCompaction';
import type { CompletionInput } from '@/backend/services/model/adapters/types';
import type { Model } from '@/shared/types/model';
import type { AnthropicCompactionRecord } from '@/shared/types/openai';
import { COMPACTION_BETA, signSummary, startAnthropicStandIn } from '../../scripts/anthropic-stand-in.mjs';

jest.mock('@/utils/logger', () => ({
  createLogger: () => ({ verbose: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

type StandIn = Awaited<ReturnType<typeof startAnthropicStandIn>>;
type Sent = {
  model: string; max_tokens: number; stream?: boolean; system?: unknown;
  compaction?: { type: string; instructions?: string };
  messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>;
};
let standIn: StandIn;

const messageRequests = () => standIn.requests.filter(record => record.path === '/v1/messages' && record.body)
  .map(record => ({ ...record, body: record.body as Sent }));
const compactionRequests = () => messageRequests().filter(record => record.body.compaction !== undefined);
const ordinaryRequests = () => messageRequests().filter(record => record.body.compaction === undefined);

const model = (extra: Partial<Model> = {}): Model => ({
  id: 'saved-claude', name: 'claude-opus-5-5', provider: 'anthropic', adapter: 'anthropic',
  baseUrl: standIn.baseUrl, ApiKey: 'fixture-key', contextWindow: 1_000_000, ...extra,
});

const history: OpenAI.ChatCompletionMessageParam[] = [
  { role: 'system', content: 'You help with orders.' },
  { role: 'user', content: 'Do not email the customer. Order pedido-ñ-001.' },
  { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"id":"pedido-ñ-001"}' } }] },
  { role: 'tool', tool_call_id: 'call-1', content: '{"status":"shipped"}' },
  { role: 'assistant', content: 'The order shipped.' },
];

const input = (extra: Partial<CompletionInput> = {}): CompletionInput => ({
  model: model(), apiKey: 'fixture-key', maxTokens: 512, messages: history, ...extra,
});

async function compact(): Promise<AnthropicCompactionRecord> {
  const result = await new AnthropicAdapter().createCompletion(input({
    maxTokens: ANTHROPIC_COMPACTION_MAX_TOKENS, nativeCompaction: { instructions: 'Keep every order id.' },
  }));
  return result.providerMetadata!.anthropicCompaction!;
}

/** The FLUJO summary turn that carries a signed block, as compaction puts it on the wire. */
const summaryTurn = (record: AnthropicCompactionRecord, records = '\n\n## Execution Receipts\n{"call_id":"call-1"}') => ({
  role: 'assistant', content: `${COMPACTION_SUMMARY_MARKER}\n\n${record.block.content}${records}`,
  providerMetadata: { anthropicCompaction: record },
} as OpenAI.ChatCompletionMessageParam);

beforeEach(async () => {
  __resetApiVersionSupport();
  __resetCacheControlSupport();
  __resetAnthropicCompactionSupport();
  standIn = await startAnthropicStandIn({ reply: () => ({ blocks: [{ type: 'text', text: 'ok' }] }) });
});

afterEach(async () => {
  await standIn.close();
});

describe('a compaction request', () => {
  it('asks for a summary of every message, the final reply included, and returns the block exactly as sent', async () => {
    expect(ANTHROPIC_COMPACTION_BETA).toBe(COMPACTION_BETA);
    const result = await new AnthropicAdapter().createStreamCompletion(input({
      maxTokens: ANTHROPIC_COMPACTION_MAX_TOKENS, nativeCompaction: { instructions: 'Keep every order id.' },
      onModelDelta: jest.fn(),
    }));
    const [request] = compactionRequests();
    expect(request.betas).toContain(ANTHROPIC_COMPACTION_BETA);
    expect(request.body.compaction).toEqual({ type: 'summarize', instructions: 'Keep every order id.' });
    expect(request.body.max_tokens).toBe(ANTHROPIC_COMPACTION_MAX_TOKENS);
    expect(request.body.stream).toBeUndefined();
    // The final assistant reply is summarized too; it is not stripped as a prefill.
    expect(request.body.messages.at(-1)).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'The order shipped.', cache_control: { type: 'ephemeral' } }] });
    expect(request.body.system).toEqual([{ type: 'text', text: 'You help with orders.', cache_control: { type: 'ephemeral' } }]);

    const record = result.providerMetadata!.anthropicCompaction!;
    const [signed] = standIn.compaction.signed;
    expect(record.model).toBe('claude-opus-5-5');
    expect(record.block).toEqual(signed);
    expect(result.completion.choices[0].message.content).toBe(signed.content);
    // A compaction call reports its tokens in usage.iterations only.
    expect(result.completion.usage!.prompt_tokens).toBeGreaterThan(0);
    expect(result.completion.usage!.completion_tokens).toBeGreaterThan(0);
  });

  it('throws on a gateway that does not know the beta, and leaves the model to FLUJO summaries for a while', async () => {
    standIn.compaction.knownBeta = false;
    await expect(compact()).rejects.toMatchObject({ status: 400 });
    expect(anthropicCompactionAvailable('saved-claude')).toBe(false);
    expect(anthropicCompactionAvailable('saved-claude', Date.now() + NATIVE_COMPACTION_RETRY_MS + 1)).toBe(true);
  });

  it('throws when the summary is cut off instead of answering with an empty reply', async () => {
    standIn.compaction.reply = () => ({ stopReason: 'max_tokens' });
    await expect(compact()).rejects.toBeInstanceOf(AnthropicCompactionMissingError);
    expect(anthropicCompactionAvailable('saved-claude')).toBe(false);
    expect(ordinaryRequests()).toHaveLength(0);
  });

  it('keeps native compaction available after an overload: the next compaction tries again', async () => {
    standIn.compaction.reply = () => ({ error: { status: 529, type: 'overloaded_error', message: 'Overloaded',
      code: 'compaction_unavailable', headers: { 'retry-after-ms': '1' } } });
    await expect(compact()).rejects.toMatchObject({ status: 529 });
    // The SDK's own retries ran, honouring retry-after-ms.
    expect(compactionRequests().length).toBeGreaterThan(1);
    expect(anthropicCompactionAvailable('saved-claude')).toBe(true);
  });

  it('is refused by the stand-in when a tool call has no result yet, as the real API refuses it', async () => {
    await expect(new AnthropicAdapter().createCompletion(input({
      messages: history.slice(0, 3), nativeCompaction: { instructions: 'x' },
    }))).rejects.toMatchObject({ status: 400 });
  });
});

describe('a later request that carries the signed summary', () => {
  it('sends the block first and unchanged, the exact records after it, with the beta header', async () => {
    const record = await compact();
    const reply = await new AnthropicAdapter().createStreamCompletion(input({
      messages: [history[0], summaryTurn(record), { role: 'user', content: 'Status of pedido-ñ-001?' }],
      onModelDelta: jest.fn(),
    }));
    expect(reply.completion.choices[0].message.content).toBe('ok');
    const [request] = ordinaryRequests();
    expect(request.status).toBe(200);
    expect(request.betas).toContain(ANTHROPIC_COMPACTION_BETA);
    const [first] = request.body.messages;
    expect(first.role).toBe('assistant');
    const [block, records] = first.content as Array<Record<string, unknown>>;
    // Field for field what the stand-in signed, plus the documented cache breakpoint after the summary.
    expect(block).toEqual({ ...record.block, cache_control: { type: 'ephemeral' } });
    expect(block.signature).toBe(signSummary(String(block.content)));
    expect(records).toEqual({ type: 'text', text: '## Execution Receipts\n{"call_id":"call-1"}' });
    expect(JSON.stringify(request.body.messages)).not.toContain(COMPACTION_SUMMARY_MARKER);
  });

  it('puts the block in a turn of its own when no records follow it', async () => {
    const record = await compact();
    await new AnthropicAdapter().createCompletion(input({
      messages: [summaryTurn(record, ''), { role: 'user', content: 'Next?' }],
    }));
    const [request] = ordinaryRequests();
    expect(request.status).toBe(200);
    expect(request.body.messages[0]).toEqual({ role: 'assistant', content: [{ ...record.block, cache_control: { type: 'ephemeral' } }] });
    expect(request.body.messages[1].role).toBe('user');
  });

  it('sends the summary as plain text when the endpoint refuses the block, and the turn still succeeds', async () => {
    const record = await compact();
    standIn.compaction.refuseReplay = true;
    const reply = await new AnthropicAdapter().createCompletion(input({
      messages: [history[0], summaryTurn(record), { role: 'user', content: 'Status?' }],
    }));
    expect(reply.completion.choices[0].message.content).toBe('ok');
    const [refused, retried] = ordinaryRequests();
    expect(refused.status).toBe(400);
    expect(retried.status).toBe(200);
    expect(retried.betas).not.toContain(ANTHROPIC_COMPACTION_BETA);
    expect(JSON.stringify(retried.body.messages)).not.toContain('"compaction"');
    const [summary] = retried.body.messages[0].content as Array<{ type: string; text: string }>;
    expect(summary.text).toBe(`${COMPACTION_SUMMARY_MARKER}\n\n${record.block.content}\n\n## Execution Receipts\n{"call_id":"call-1"}`);
    expect(anthropicCompactionAvailable('saved-claude')).toBe(false);
  });

  it('never sends a block that is not first, or one whose summary text was changed', async () => {
    const record = await compact();
    const changed = { ...summaryTurn(record), content: `${COMPACTION_SUMMARY_MARKER}\n\nA different summary.` } as OpenAI.ChatCompletionMessageParam;
    await new AnthropicAdapter().createCompletion(input({
      messages: [{ role: 'user', content: 'First.' }, summaryTurn(record), { role: 'user', content: 'Next?' }],
    }));
    await new AnthropicAdapter().createCompletion(input({ messages: [changed, { role: 'user', content: 'Next?' }] }));
    for (const request of ordinaryRequests()) {
      expect(request.status).toBe(200);
      expect(JSON.stringify(request.body.messages)).not.toContain('"compaction"');
    }
  });
});
