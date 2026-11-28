/**
 * #1091 end to end: a long conversation on an Anthropic (Native) model through
 * ModelHandler.callModel, the real Anthropic adapter and SDK, and
 * `scripts/anthropic-stand-in.mjs`, a local stand-in of Anthropic's service.
 * No real provider and no paid call: the stand-in applies the documented
 * on-demand compaction rules and signs every summary.
 *
 * Proven here: Anthropic writes the summary when it can; the signed block is
 * kept with the summary, survives a restart and goes back byte for byte; ten
 * successive compactions build on the previous block; FLUJO's exact records
 * (standing instructions, receipts) stay after every native summary; and
 * every failure falls back to FLUJO's own summary, or to the full history,
 * then heals by itself. Each summary records what it cost and saved.
 */
import type OpenAI from 'openai';
import type { SharedState } from '@/backend/execution/flow/types';
import type { FlujoChatMessage } from '@/shared/types/chat';
import type { ModelInputSnapshot } from '@/shared/types/execution/modelInput';
import type { ContextCompactionEvent } from '@/shared/types/contextCompaction';
import { COMPACTION_SUMMARY_MARKER, COMPACTION_SUMMARY_SECTIONS } from '@/backend/execution/flow/handlers/summarizingCompaction';
import { COMPACTION_POLICY_VERSION } from '@/backend/execution/flow/compaction/types';
import { validateCompactionState } from '@/backend/execution/flow/compaction/state';
import {
  ANTHROPIC_COMPACTION_BETA,
  NATIVE_COMPACTION_RETRY_MS,
  __resetAnthropicCompactionSupport,
} from '@/backend/services/model/adapters/anthropicCompaction';
import { __resetApiVersionSupport, __resetCacheControlSupport } from '@/backend/services/model/adapters/anthropicAdapter';
import { startAnthropicStandIn } from '../../scripts/anthropic-stand-in.mjs';
import applicationPackage from '../../package.json';

jest.mock('@/utils/logger', () => {
  const log = { verbose: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { createLogger: () => log };
});

const loadItemMock = jest.fn();
jest.mock('@/utils/storage/backend', () => ({
  ...jest.requireActual('@/utils/storage/backend'),
  loadItem: (...args: unknown[]) => loadItemMock(...args),
}));
jest.mock('@/backend/execution/flow/persistConversationState', () => ({ persistConversationState: jest.fn(async () => undefined) }));
jest.mock('@/backend/execution/flow/FlowExecutor', () => ({ FlowExecutor: { conversationStates: new Map() } }));
jest.mock('@/backend/execution/flow/conversationStateRegistry', () => ({
  getConversationStates: () => jest.requireMock<{ FlowExecutor: { conversationStates: Map<string, unknown> } }>('@/backend/execution/flow/FlowExecutor').FlowExecutor.conversationStates,
}));

const getModelMock = jest.fn();
jest.mock('@/backend/services/model', () => ({
  modelService: {
    getModel: (...args: unknown[]) => getModelMock(...args),
    resolveAndDecryptApiKey: async () => 'fixture-key',
  },
}));

let resourceSeq = 0;
jest.mock('@/backend/services/runResources', () => ({
  listRunResources: async () => [],
  writeRunResource: async (input: { conversationId: string }) => ({
    uri: `flujo://run/${input.conversationId}/archive-${++resourceSeq}`, size: 1, kind: 'text', mimeType: 'application/json',
  }),
  getRunResourceSettings: async () => ({ autoCaptureEnabled: true, textThresholdChars: 8192, maxResourceBytes: 50 << 20,
    maxConversationBytes: 256 << 20, replaceLargeTextWithStub: false }),
  readRunResourceBounded: async () => ({ text: '' }),
  parseRunResourceUri: (uri: string) => {
    const match = /^flujo:\/\/run\/([\w-]+)\/([\w-]+)$/.exec(uri);
    return match ? { conversationId: match[1], id: match[2] } : null;
  },
}));

import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { persistConversationState } from '@/backend/execution/flow/persistConversationState';

const conversationStates = FlowExecutor.conversationStates as Map<string, SharedState>;
const CONVERSATION = 'native-conv';
const FLUJO_SUMMARY = COMPACTION_SUMMARY_SECTIONS.map(section => section + '\n- Orders are being checked.').join('\n\n');
const PROHIBITION = 'Do not email the customer until I say so.';

type StandIn = Awaited<ReturnType<typeof startAnthropicStandIn>>;
type Block = { type: string; [key: string]: unknown };
type SentMessage = { role: string; content: string | Block[] };
type Sent = { system?: unknown; compaction?: { type: string; instructions?: string }; messages: SentMessage[] };
type StandInRecord = { status: number; betas: string[]; body: Sent };

let standIn: StandIn;
const textOf = (message: SentMessage) => (typeof message.content === 'string' ? [{ type: 'text', text: message.content } as Block] : message.content)
  .map(block => block.type === 'text' ? String(block.text) : block.type === 'compaction' ? String(block.content) : JSON.stringify(block)).join('\n');
const messageRequests = (): StandInRecord[] => standIn.requests.filter(record => record.path === '/v1/messages' && record.body)
  .map(record => ({ status: record.status, betas: record.betas, body: record.body as Sent }));
const compactionRequests = () => messageRequests().filter(record => record.body.compaction !== undefined);
const ordinaryRequests = () => messageRequests().filter(record => record.body.compaction === undefined);
const signed = () => standIn.compaction.signed;
let seq = 0;
const message = (partial: Record<string, unknown>): FlujoChatMessage =>
  ({ id: `m${seq++}`, timestamp: seq, ...partial } as unknown as FlujoChatMessage);

function opening(): FlujoChatMessage[] {
  return [
    message({ role: 'user', content: PROHIBITION }),
    message({ role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function',
      function: { name: 'lookup', arguments: '{"id":"pedido-ñ-001","path":"C:\\\\Kunden\\\\Ärger"}' } }] }),
    message({ role: 'tool', tool_call_id: 'call-1', content: '{"status":"shipped"}' }),
    message({ role: 'assistant', content: 'Order pedido-ñ-001 shipped.' }),
  ];
}

/** Letters only: numbers, quotes and "field: value" lines would become exact recorded observations. */
const word = (n: number) => 'abcdefghijklmnopqrstuvwxyz'[n % 26] + 'abcdefghijklmnopqrstuvwxyz'[Math.floor(n / 26) % 26];

function rounds(count: number, label: string): FlujoChatMessage[] {
  const added: FlujoChatMessage[] = [];
  for (let n = 0; n < count; n++) {
    added.push(message({ role: 'user', content: `Check the ${label} item ${word(n)} and tell me how it looks. `.repeat(6) }));
    added.push(message({ role: 'assistant', content: `The ${label} item ${word(n)} looks fine. `.repeat(30) }));
  }
  added.push(message({ role: 'user', content: `Continue after the ${label} items.` }));
  return added;
}

const seedState = (compactionState?: SharedState['compactionState']): SharedState => {
  const state = {
    trackingInfo: { executionId: 'e1', startTime: 1, nodeExecutionTracker: [] }, messages: [], flowId: 'flow-1',
    conversationId: CONVERSATION, status: 'running', title: 'T', createdAt: 1, updatedAt: 1,
    ...(compactionState ? { compactionState } : {}),
  } as unknown as SharedState;
  conversationStates.set(CONVERSATION, state);
  return state;
};

const snapshot = (): ModelInputSnapshot => ({
  systemMessage: null, wireMessages: [], provenance: [],
  counts: { threaded: 0, sent: 0, folded: 0, scopedOut: 0, handoffStripped: 0 },
});

async function call(messages: FlujoChatMessage[]): Promise<{ events: ContextCompactionEvent[]; content?: string }> {
  const events: ContextCompactionEvent[] = [];
  const result = await ModelHandler.callModel({
    modelId: 'claude-native', prompt: 'Help with orders.', messages,
    nodeName: 'Orders', nodeId: 'node-1', conversationId: CONVERSATION, modelInputForArchive: snapshot(),
    onFinalWire: (_wire: OpenAI.ChatCompletionMessageParam[], input?: ModelInputSnapshot) => {
      events.push(...(input?.contextCompaction?.events ?? []));
    },
  } as Parameters<typeof ModelHandler.callModel>[0]);
  expect(result.success).toBe(true);
  return { events, content: result.success ? result.value.content : undefined };
}

const blockOf = (record: StandInRecord) => {
  const first = record.body.messages[0];
  const block = Array.isArray(first?.content) ? first.content[0] : undefined;
  return block?.type === 'compaction' ? block : undefined;
};
const isFlujoSummarizerBody = (body: Sent) => JSON.stringify(body.system ?? '').includes('You are compacting a long agentic conversation');
const isFlujoSummarizerCall = (record: StandInRecord) => isFlujoSummarizerBody(record.body);
const dialogueRequests = () => ordinaryRequests().filter(record => record.status === 200 && !isFlujoSummarizerCall(record));
const answer = (text: string) => ({ blocks: [{ type: 'text', text }] });
const summaryEvent = (events: ContextCompactionEvent[]) => events.find(event => event.kind === 'summary');

beforeEach(async () => {
  seq = 0;
  resourceSeq = 0;
  conversationStates.clear();
  __resetAnthropicCompactionSupport();
  __resetApiVersionSupport();
  __resetCacheControlSupport();
  jest.mocked(persistConversationState).mockReset().mockResolvedValue(undefined);
  loadItemMock.mockReset().mockImplementation(async (_key: unknown, fallback: unknown) => (
    _key === 'speech_settings' || String(_key).includes('settings') ? { experimental: { compactionKeepTokens: 200 } } : fallback));
  standIn = await startAnthropicStandIn({ reply: ({ body }) => answer(isFlujoSummarizerBody(body as Sent) ? FLUJO_SUMMARY : 'Next record checked.') });
  getModelMock.mockReset().mockResolvedValue({
    id: 'claude-native', name: 'claude-opus-5-5', provider: 'anthropic', adapter: 'anthropic', baseUrl: standIn.baseUrl,
    ApiKey: 'fixture-key', contextWindow: 200_000, compactionThreshold: 1_000,
  });
  seedState();
});

afterEach(async () => {
  jest.restoreAllMocks();
  await standIn.close();
});

describe('Anthropic native compaction in a real model call (#1091)', () => {
  it('lets Anthropic write the summary, keeps FLUJO records after it and measures it', async () => {
    const messages = [...opening(), ...rounds(12, 'alpha')];
    const canonical = JSON.stringify(messages);
    const { events, content } = await call(messages);
    expect(content).toBe('Next record checked.');
    expect(JSON.stringify(messages)).toBe(canonical);

    const [compaction] = compactionRequests();
    expect(compactionRequests()).toHaveLength(1);
    expect(compaction.betas).toContain(ANTHROPIC_COMPACTION_BETA);
    expect(compaction.body.compaction?.instructions).toContain('## Objective');
    expect(ordinaryRequests().some(isFlujoSummarizerCall)).toBe(false);

    const [turn] = dialogueRequests();
    expect(turn.betas).toContain(ANTHROPIC_COMPACTION_BETA);
    expect(blockOf(turn)).toEqual({ ...signed()[0], cache_control: { type: 'ephemeral' } });
    const sent = turn.body.messages.map(textOf).join('\n');
    // FLUJO's exact records follow the summary, whoever wrote it.
    expect(turn.body.messages.some(entry => entry.role === 'user' && textOf(entry) === PROHIBITION)).toBe(true);
    expect(sent).toContain('## Execution Receipts');
    expect(sent).toContain('"call_id":"call-1"');
    expect(sent).toContain('"arguments":"{\\"id\\":\\"pedido-ñ-001\\",\\"path\\":\\"C:\\\\\\\\Kunden\\\\\\\\Ärger\\"}"');

    const state = conversationStates.get(CONVERSATION)!;
    expect(state.compactionState?.artifacts[0].anthropicCompaction?.block).toEqual({ ...signed()[0] });
    expect(persistConversationState).toHaveBeenCalled();

    const measurement = summaryEvent(events)!.measurement!;
    expect(measurement).toMatchObject({
      engine: 'anthropic-native', reused: false, summarizerCalls: 1,
      appVersion: applicationPackage.version, policyVersion: COMPACTION_POLICY_VERSION, retainedUserTurns: expect.any(Number), receipts: 1,
    });
    expect(measurement.promptDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(measurement.latencyMs).toBeGreaterThanOrEqual(0);
    expect(measurement.usage?.inputTokens).toBeGreaterThan(0);
    expect(measurement.estimatedTokensAfter).toBeLessThan(measurement.estimatedTokensBefore);
    expect(measurement.nativeFallback).toBeUndefined();
  });

  it('sends the same signed block again, byte for byte, after a restart, without summarizing again', async () => {
    const messages = [...opening(), ...rounds(12, 'alpha')];
    await call(messages);
    const again = await call(messages);
    expect(summaryEvent(again.events)!.measurement).toMatchObject({ engine: 'anthropic-native', reused: true, latencyMs: 0, summarizerCalls: 0 });

    // Restart: only the persisted, re-validated metadata survives.
    const saved = JSON.parse(JSON.stringify(conversationStates.get(CONVERSATION)!.compactionState));
    conversationStates.clear();
    seedState(validateCompactionState(saved, CONVERSATION, messages));
    await call(messages);

    expect(compactionRequests()).toHaveLength(1);
    const turns = dialogueRequests();
    expect(turns).toHaveLength(3);
    const exact = JSON.stringify(blockOf(turns[0]));
    for (const turn of turns) expect(JSON.stringify(blockOf(turn))).toBe(exact);
  });

  it('builds ten successive native summaries, each on the block before it, with the prohibition intact every time', async () => {
    let messages = [...opening(), ...rounds(12, 'round aa')];
    for (let round = 0; round < 10; round++) {
      if (round) messages = [...messages, ...rounds(8, `round ${word(round)}`)];
      await call(messages);
      const compactions = compactionRequests();
      expect(compactions).toHaveLength(round + 1);
      if (round) {
        // "Compact again": the previous signed block opens the new request.
        const previous = signed()[round - 1];
        expect(blockOf(compactions[round])).toMatchObject({ ...previous });
      }
      const turn = dialogueRequests().at(-1)!;
      expect(blockOf(turn)).toMatchObject({ ...signed()[round] });
      expect(turn.body.messages.filter(entry => entry.role === 'user' && textOf(entry) === PROHIBITION)).toHaveLength(1);
      expect(turn.body.messages.map(textOf).join('\n')).toContain('"call_id":"call-1"');
      expect(messageRequests().every(record => record.status === 200)).toBe(true);
    }
  });

  it('falls back to FLUJO\'s own summary on a gateway without the beta, then skips the native try for a while', async () => {
    standIn.compaction.knownBeta = false;
    const { events } = await call([...opening(), ...rounds(12, 'alpha')]);
    expect(compactionRequests().map(record => record.status)).toEqual([400]);
    expect(ordinaryRequests().filter(isFlujoSummarizerCall)).toHaveLength(1);
    const [turn] = dialogueRequests();
    expect(blockOf(turn)).toBeUndefined();
    expect(turn.betas).not.toContain(ANTHROPIC_COMPACTION_BETA);
    expect(turn.body.messages.map(textOf).join('\n')).toContain(`${COMPACTION_SUMMARY_MARKER}\n\n## Objective`);
    expect(summaryEvent(events)!.measurement).toMatchObject({ engine: 'flujo', summarizerCalls: 2, nativeFallback: expect.stringContaining('anthropic-beta') });

    const later = await call([...opening(), ...rounds(12, 'alpha'), ...rounds(8, 'bravo')]);
    expect(compactionRequests()).toHaveLength(1);
    expect(summaryEvent(later.events)!.measurement).toMatchObject({ engine: 'flujo', nativeFallback: 'The endpoint refused native compaction recently.' });
  });

  it('falls back in the same call when the summary is cut off', async () => {
    standIn.compaction.reply = () => ({ stopReason: 'max_tokens' });
    const { events, content } = await call([...opening(), ...rounds(12, 'alpha')]);
    expect(content).toBe('Next record checked.');
    expect(ordinaryRequests().filter(isFlujoSummarizerCall)).toHaveLength(1);
    expect(summaryEvent(events)!.measurement).toMatchObject({ engine: 'flujo', nativeFallback: expect.stringContaining('max_tokens') });
  });

  it('keeps the conversation going when a saved block is refused later: the same summary goes as text', async () => {
    const messages = [...opening(), ...rounds(12, 'alpha')];
    await call(messages);
    standIn.compaction.refuseReplay = true;
    const { content } = await call(messages);
    expect(content).toBe('Next record checked.');
    const [refused] = ordinaryRequests().filter(record => record.status === 400);
    expect(blockOf(refused)).toBeDefined();
    const retried = dialogueRequests().at(-1)!;
    expect(blockOf(retried)).toBeUndefined();
    expect(retried.body.messages.map(textOf).join('\n')).toContain(signed()[0].content);
  });

  it('dispatches the full history when no summary can be made, and summarizes again by itself later', async () => {
    standIn.compaction.reply = () => ({ stopReason: 'max_tokens' });
    standIn.reply = ({ body }) => answer(isFlujoSummarizerBody(body as Sent) ? 'not a summary' : 'Next record checked.');
    const messages = [...opening(), ...rounds(12, 'alpha')];
    const failed = await call(messages);
    expect(failed.content).toBe('Next record checked.');
    expect(summaryEvent(failed.events)).toBeUndefined();
    expect(dialogueRequests().at(-1)!.body.messages.some(entry => textOf(entry).includes(COMPACTION_SUMMARY_MARKER))).toBe(false);

    // No restart and no setting: the native try comes back on its own.
    standIn.compaction.reply = undefined;
    const later = Date.now() + NATIVE_COMPACTION_RETRY_MS + 1;
    jest.spyOn(Date, 'now').mockReturnValue(later);
    const healed = await call([...messages, ...rounds(2, 'bravo')]);
    expect(summaryEvent(healed.events)!.measurement!.engine).toBe('anthropic-native');
    expect(blockOf(dialogueRequests().at(-1)!)).toBeDefined();
  });
});
