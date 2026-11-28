/**
 * "/compact" (#1225): a person's request makes the next model call summarize
 * older messages even below the automatic threshold, and later calls keep
 * reusing that summary without calling the summarizer again.
 */
import type { SharedState } from '@/backend/execution/flow/types';
import { COMPACTION_SUMMARY_MARKER, COMPACTION_SUMMARY_SECTIONS } from '@/backend/execution/flow/handlers/summarizingCompaction';
import {
  manualCompactionMode,
  markManualCompactionAttempted,
  previewManualCompaction,
} from '@/backend/execution/flow/compaction/manualRequest';

const loadItemMock = jest.fn();
jest.mock('@/utils/storage/backend', () => ({
  ...jest.requireActual('@/utils/storage/backend'),
  loadItem: (...args: unknown[]) => loadItemMock(...args),
}));
jest.mock('@/backend/execution/flow/persistConversationState', () => ({ persistConversationState: jest.fn(async () => undefined) }));
jest.mock('@/backend/execution/flow/FlowExecutor', () => ({
  FlowExecutor: { conversationStates: new Map() },
}));
jest.mock('@/backend/execution/flow/conversationStateRegistry', () => ({
  getConversationStates: () => jest.requireMock<{ FlowExecutor: { conversationStates: Map<string, unknown> } }>('@/backend/execution/flow/FlowExecutor').FlowExecutor.conversationStates,
}));
jest.mock('@/backend/services/model', () => ({
  modelService: { getModel: jest.fn(), resolveAndDecryptApiKey: jest.fn() },
}));
const writeRunResourceMock = jest.fn();
jest.mock('@/backend/services/runResources', () => ({
  listRunResources: jest.fn(async () => []),
  writeRunResource: (...a: unknown[]) => writeRunResourceMock(...a),
  getRunResourceSettings: jest.fn(),
  readRunResourceBounded: jest.fn(),
  parseRunResourceUri: () => null,
}));
jest.mock('@/backend/services/model/adapters', () => ({
  getCompletionAdapter: () => ({ createCompletion: jest.fn() }),
}));

import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';

const conversationStates = FlowExecutor.conversationStates as Map<string, SharedState>;
const runtime = ModelHandler as unknown as {
  maybeCompactWire: (...args: unknown[]) => Promise<{ wireMessages: SharedState['messages'] } | null>;
  generateCompletion: (...args: unknown[]) => Promise<{ success: true; value: { content: string } }>;
};
const summary = COMPACTION_SUMMARY_SECTIONS.map(section => section + '\n- None.').join('\n\n');
// A large window keeps every call far below the automatic threshold.
const model = { id: 'model-1', contextWindow: 1_000_000 };

const source: SharedState['messages'] = [
  { id: 'u-old', role: 'user', content: 'Never publish.', timestamp: 1 },
  { id: 'a-old', role: 'assistant', content: 'historical observation '.repeat(800), timestamp: 2 },
  { id: 'a-tail', role: 'assistant', content: 'recent observation '.repeat(40), timestamp: 3 },
  { id: 'u-now', role: 'user', content: 'Continue.', timestamp: 4 },
];

function seed(conversationId: string, request?: SharedState['compactionRequest']): SharedState {
  const state = {
    trackingInfo: { executionId: 'e1', startTime: 1, nodeExecutionTracker: [] },
    messages: [], flowId: 'flow-1', conversationId, status: 'running', title: 'T', createdAt: 1, updatedAt: 1,
    ...(request ? { compactionRequest: request } : {}),
  } as unknown as SharedState;
  conversationStates.set(conversationId, state);
  return state;
}

const compact = (conversationId: string, messages: SharedState['messages']) =>
  runtime.maybeCompactWire(messages, conversationId, 'node-1', 'full-history', model, 100);
const hasSummary = (wire: SharedState['messages'] | undefined) =>
  Boolean(wire?.some(message => String(message.content).startsWith(COMPACTION_SUMMARY_MARKER)));

let generate: jest.SpiedFunction<typeof runtime.generateCompletion>;

beforeEach(() => {
  conversationStates.clear();
  loadItemMock.mockReset().mockResolvedValue({ experimental: { compactionKeepTokens: 20 } });
  writeRunResourceMock.mockReset().mockImplementation(async (input: { conversationId: string; name: string }) => ({
    uri: `flujo://run/${input.conversationId}/${input.name}`, size: 1, kind: 'text', mimeType: 'application/json',
  }));
  generate = jest.spyOn(runtime, 'generateCompletion').mockResolvedValue({ success: true, value: { content: summary } });
});

afterEach(() => jest.restoreAllMocks());

describe('manual compaction request', () => {
  it('leaves a chat below the threshold alone when nobody asked', async () => {
    seed('plain');
    expect(await compact('plain', source)).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });

  it('summarizes below the threshold once a person asked, and uses the request up', async () => {
    const state = seed('asked', { requestedAt: 1 });
    const result = await compact('asked', source);
    expect(generate).toHaveBeenCalled();
    expect(hasSummary(result?.wireMessages)).toBe(true);
    // The original instruction and the recent tail stay word for word.
    expect(result?.wireMessages).toEqual(expect.arrayContaining([source[0], source[2], source[3]]));
    expect(result?.wireMessages).not.toContainEqual(source[1]);
    expect(state.compactionRequest?.attemptedAt).toEqual(expect.any(Number));
    expect(state.compactionState?.artifacts).toHaveLength(1);
  });

  it('keeps reusing that summary on later turns without summarizing again', async () => {
    seed('kept', { requestedAt: 1 });
    await compact('kept', source);
    const calls = generate.mock.calls.length;
    const later: SharedState['messages'] = [...source,
      { id: 'a-answer', role: 'assistant', content: 'Done.', timestamp: 5 },
      { id: 'u-next', role: 'user', content: 'And now the next part.', timestamp: 6 },
    ];
    const result = await compact('kept', later);
    expect(generate).toHaveBeenCalledTimes(calls);
    expect(hasSummary(result?.wireMessages)).toBe(true);
    expect(result?.wireMessages).toEqual(expect.arrayContaining(later.slice(2)));
    expect(result?.wireMessages).not.toContainEqual(source[1]);
  });

  it('never retries a request that found nothing to summarize', async () => {
    loadItemMock.mockResolvedValue({ experimental: { compactionKeepTokens: 1_000_000 } });
    const state = seed('small', { requestedAt: 1 });
    expect(await compact('small', source)).toBeNull();
    expect(state.compactionRequest?.attemptedAt).toEqual(expect.any(Number));
    expect(await compact('small', source)).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });

  it('respects a Process node that switched summaries off, and still uses the request up', async () => {
    const state = seed('off', { requestedAt: 1 });
    expect(await runtime.maybeCompactWire(source, 'off', 'node-1', 'full-history', model, 100, { compactionMode: 'off' })).toBeNull();
    expect(generate).not.toHaveBeenCalled();
    expect(state.compactionRequest?.attemptedAt).toEqual(expect.any(Number));
  });
});

describe('manual compaction helpers', () => {
  it('forces once, then keeps only a summary made since the request', () => {
    expect(manualCompactionMode(undefined)).toBeUndefined();
    expect(manualCompactionMode({ requestedAt: 'soon' })).toBeUndefined();
    expect(manualCompactionMode({ requestedAt: 10 })).toBe('force');
    const attempted = markManualCompactionAttempted({ requestedAt: 10 }, 20);
    expect(manualCompactionMode(attempted)).toBeUndefined();
    expect(manualCompactionMode(attempted, { createdAt: 9 })).toBeUndefined();
    expect(manualCompactionMode(attempted, { createdAt: 15 })).toBe('keep');
  });

  it('previews what is summarized and what stays word for word', () => {
    expect(previewManualCompaction(source, 20)).toEqual({
      estimatedTokens: expect.any(Number),
      keepTokens: 20,
      summarizedMessages: 1,
      keptRecentMessages: 2,
      keptEarlierUserMessages: 1,
      standingInstructions: 1,
      earlierUserMessagesFit: true,
    });
    expect(previewManualCompaction(source, 1_000_000).summarizedMessages).toBe(0);
    expect(previewManualCompaction(source, 20, 10).earlierUserMessagesFit).toBe(false);
  });
});
