import type { FlujoChatMessage } from '@/shared/types/chat';
import { compactHistory, COMPACTION_SUMMARY_SECTIONS, estimateTokens, splitHistoryForCompaction } from '@/backend/execution/flow/handlers/summarizingCompaction';
import type { CompactHistoryOptions } from '@/backend/execution/flow/handlers/summarizingCompaction';
import type { SummaryRangePayload } from '@/backend/execution/flow/compaction/summaryHierarchy';
import { digestProjectedMessages } from '@/backend/execution/flow/compaction/digest';
import { validateCompactionState } from '@/backend/execution/flow/compaction/state';

jest.mock('@/utils/logger', () => ({ createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn() }) }));
const narrative = COMPACTION_SUMMARY_SECTIONS.map(section => section + '\n- Task continues; use source records for exact facts.').join('\n\n');
const message = (index: number): FlujoChatMessage => ({ id: 'm-' + index, timestamp: index,
  role: index % 2 ? 'assistant' : 'user', content: 'Record ' + index + ': this one-off status check completed.' });
const options = (messages: FlujoChatMessage[], extra: Partial<CompactHistoryOptions> = {}): CompactHistoryOptions => ({
  keepTokens: 800, inputBudgetTokens: 32000, nodeId: 'node', conversationId: 'scale', modelId: 'free',
  policyVersion: 'hierarchy', projectionDigest: 'projection',
  projection: { conversationId: 'scale', nodeId: 'node', view: 'full-history', handoffPolicy: 'strip-v1', version: 1 },
  sourceDigest: digestProjectedMessages(splitHistoryForCompaction(messages, 800).toSummarize), ...extra,
});

it('recovers 200,000 originals through persistent ranges, then summarizes only the appended suffix after restart', async () => {
  const source = Array.from({ length: 200_000 }, (_, index) => message(index));
  source[0].content = 'Never send anything outside this workspace.';
  source[130_000].content = 'Correction: keep the destination Bogotá for the ongoing task.';
  const store = new Map<string, SummaryRangePayload>();
  const summarized = new Set<string>();
  const summarize = jest.fn(async (messages: FlujoChatMessage[], prompt: { selectUserInstructions?: boolean; mergingRanges?: boolean }) => {
    expect(estimateTokens(messages)).toBeLessThan(21_000);
    if (!prompt.mergingRanges) for (const message of messages) {
      expect(summarized.has(message.id)).toBe(false);
      summarized.add(message.id);
    }
    return prompt.selectUserInstructions ? JSON.stringify({ summary: narrative,
      protectedUserIds: messages.filter(message => message.id === 'm-0' || message.id === 'm-130000').map(message => message.id) }) : narrative;
  });
  const writeSummaryRange = async (payload: SummaryRangePayload) => {
    const uri = 'flujo://run/scale/range-' + store.size;
    store.set(uri, structuredClone(payload));
    return uri;
  };
  const first = await compactHistory(source, options(source), { summarize, writeSummaryRange });
  expect(first).not.toBeNull();
  expect(estimateTokens(first!.wireMessages)).toBeLessThan(32000);
  expect(first!.wireMessages).toContain(source[0]);
  expect(first!.wireMessages).toContain(source[130_000]);
  expect(first!.artifact.summaryRanges!.some(range => range.level >= 2)).toBe(true);
  const recover = (uri: string): FlujoChatMessage[] => {
    const payload = store.get(uri)!;
    return payload.messages ? [...payload.messages] : payload.children!.flatMap(child => recover(child.resourceUri));
  };
  expect(recover(first!.artifact.summaryResourceUri!)).toEqual(splitHistoryForCompaction(source, 800).toSummarize);
  const restored = validateCompactionState(JSON.parse(JSON.stringify({ schemaVersion: 1, artifacts: [first!.artifact] })), 'scale', source)!;
  expect(restored.artifacts).toHaveLength(1);
  const secondSource = [...source, ...Array.from({ length: 2000 }, (_, offset) => message(source.length + offset))];
  const callsBefore = summarize.mock.calls.length;
  const second = await compactHistory(secondSource, options(secondSource, { reusableArtifact: restored.artifacts[0] }), { summarize, writeSummaryRange });
  expect(second).not.toBeNull();
  expect(summarize.mock.calls.length - callsBefore).toBeLessThan(12);
  expect(second!.artifact.summaryRanges!.length).toBeLessThan(30);
  expect(recover(second!.artifact.summaryResourceUri!)).toEqual(splitHistoryForCompaction(secondSource, 800).toSummarize);
  expect(second!.wireMessages).toContain(source[0]);
  expect(source).toHaveLength(200000);
}, 60_000);

it('does not publish a summary tree whose original source failed to persist', async () => {
  const source = Array.from({ length: 1000 }, (_, index) => message(index));
  const result = await compactHistory(source, options(source), { summarize: async () => narrative,
    writeSummaryRange: async () => undefined });
  expect(result).toBeNull();
});

it('recovers malformed and oversized summaries before publishing a persistent range', async () => {
  const source = Array.from({ length: 1000 }, (_, index) => message(index));
  const summarize = jest.fn().mockResolvedValueOnce('{"summary":')
    .mockResolvedValueOnce(JSON.stringify({ summary: narrative + 'x'.repeat(8000), protectedUserIds: ['m-0'] }))
    .mockImplementation(async (_messages: FlujoChatMessage[], prompt: { selectUserInstructions?: boolean }) =>
      prompt.selectUserInstructions ? JSON.stringify({ summary: narrative, protectedUserIds: [] }) : narrative);
  const writeSummaryRange = jest.fn(async () => 'flujo://run/scale/recovered');
  const result = await compactHistory(source, options(source), { summarize, writeSummaryRange });
  expect(result).not.toBeNull();
  expect(summarize.mock.calls.length).toBe(writeSummaryRange.mock.calls.length + 2);
  expect(summarize.mock.calls[0][0]).toEqual(summarize.mock.calls[2][0]);
  expect(result!.artifact.protectedUserIds).toEqual([]);
});
