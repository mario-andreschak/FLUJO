import type { FlujoChatMessage } from '@/shared/types/chat';
import {
  buildCompactionPrompt,
  splitHistoryForCompaction,
  preserveResourceUris,
  compactHistory,
  isCompactionSummary,
  COMPACTION_SUMMARY_MARKER,
  COMPACTION_SUMMARY_SECTIONS,
  estimateTokens,
  type CompactHistoryOptions,
} from '@/backend/execution/flow/handlers/summarizingCompaction';

jest.mock('@/utils/logger', () => {
  const log = { verbose: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { createLogger: () => log };
});

let seq = 0;
const msg = (partial: Record<string, unknown>): FlujoChatMessage =>
  ({ id: `m${seq++}`, timestamp: 1, ...partial } as unknown as FlujoChatMessage);

const user = (content: string, o: Record<string, unknown> = {}) => msg({ role: 'user', content, ...o });
const assistant = (content: string, o: Record<string, unknown> = {}) => msg({ role: 'assistant', content, ...o });
const asstCall = (content: string, callId: string, o: Record<string, unknown> = {}) =>
  msg({ role: 'assistant', content, tool_calls: [{ id: callId, type: 'function', function: { name: 'do', arguments: '{}' } }], ...o });
const toolResult = (callId: string, content: string, o: Record<string, unknown> = {}) =>
  msg({ role: 'tool', tool_call_id: callId, content, ...o });

const bulk = (n: number) => 'x'.repeat(n);

beforeEach(() => {
  seq = 0;
});

describe('buildCompactionPrompt (issue #248)', () => {
  it('always emits all sections and the verbatim-preservation rules', () => {
    const { system, user: u } = buildCompactionPrompt();
    for (const section of COMPACTION_SUMMARY_SECTIONS) expect(system).toContain(section);
    expect(system).toMatch(/VERBATIM/);
    expect(system).toMatch(/never mention/i);
    expect(u).not.toContain('<previous-summary>');
  });

  it('update-previous-summary mode wraps the prior summary in <previous-summary> tags', () => {
    const { user: u } = buildCompactionPrompt({ previousSummary: 'old anchor text' });
    expect(u).toContain('<previous-summary>');
    expect(u).toContain('old anchor text');
    expect(u).toMatch(/UPDATE it/);
  });
});

describe('splitHistoryForCompaction (issue #248)', () => {
  it('keeps the recent tail verbatim and summarizes older messages', () => {
    const messages = [
      user(bulk(4000)), // ~1000 tokens, old
      assistant(bulk(4000)),
      user('recent question'),
      assistant('recent answer'),
    ];
    const { toSummarize, toKeep } = splitHistoryForCompaction(messages, 50);
    // keepTokens 50 is tiny; accumulating from the end, the first big message
    // that crosses the budget becomes the boundary and is KEPT, so only the
    // oldest message (m0) is summarized.
    expect(toSummarize.length).toBeGreaterThan(0);
    expect(toKeep[toKeep.length - 1].content).toBe('recent answer');
    expect(toSummarize.map((m) => m.id)).toContain(messages[0].id);
    // the boundary message is kept verbatim, not summarized
    expect(toKeep.map((m) => m.id)).toContain(messages[1].id);
  });

  it('never splits a tool_call turn from its tool result (rounds outward)', () => {
    const messages = [
      user(bulk(4000)),
      asstCall('calling', 'call_1'),
      toolResult('call_1', 'result'),
      user('recent'),
    ];
    // Force a boundary that would otherwise fall between the assistant call and its result.
    const { toSummarize, toKeep } = splitHistoryForCompaction(messages, 20);
    const summarizedIds = new Set(toSummarize.map((m) => m.id));
    // If the assistant call is summarized, its tool result must be too (and vice versa).
    const callSummarized = summarizedIds.has(messages[1].id);
    const resultSummarized = summarizedIds.has(messages[2].id);
    expect(callSummarized).toBe(resultSummarized);
    // A kept assistant tool_calls turn must keep its result in the tail.
    if (!callSummarized) {
      expect(toKeep.some((m) => m.role === 'tool' && (m as any).tool_call_id === 'call_1')).toBe(true);
    }
  });

  it('never summarizes leading system messages or depth>0 subflow steps', () => {
    const messages = [
      msg({ role: 'system', content: 'sys' }),
      user(bulk(4000)),
      assistant(bulk(4000), { depth: 1 }),
      user('recent'),
    ];
    const { toSummarize, leadingSystem, preservedSubflow } = splitHistoryForCompaction(messages, 20);
    expect(leadingSystem).toHaveLength(1);
    expect(preservedSubflow.every((m) => (m.depth ?? 0) > 0)).toBe(true);
    expect(toSummarize.some((m) => m.role === 'system')).toBe(false);
    expect(toSummarize.some((m) => (m.depth ?? 0) > 0)).toBe(false);
  });

  it('returns nothing to summarize when the whole history fits the keep budget', () => {
    const messages = [user('a'), assistant('b')];
    const { toSummarize } = splitHistoryForCompaction(messages, 100000);
    expect(toSummarize).toHaveLength(0);
  });

  it('extracts a previous compaction summary as previousSummary', () => {
    const messages = [
      assistant(`${COMPACTION_SUMMARY_MARKER}\n\nprior anchor`, {}),
      user(bulk(4000)),
      assistant(bulk(4000)),
      user('recent'),
    ];
    const { previousSummary } = splitHistoryForCompaction(messages, 20);
    expect(previousSummary).toBe('prior anchor');
  });
});

describe('preserveResourceUris (issue #248)', () => {
  it('appends flujo://run/ URIs referenced by summarized messages verbatim', () => {
    const uri = 'flujo://run/conv1/abc-123';
    const summarized = [toolResult('call_1', `see ${uri} for the full dump`)];
    const out = preserveResourceUris('## Objective\n- do things', summarized);
    expect(out).toContain(uri);
    expect(out).toContain('## Preserved Resources');
  });

  it('does not duplicate a URI already present in the summary', () => {
    const uri = 'flujo://run/conv1/abc-123';
    const summarized = [toolResult('call_1', uri)];
    const out = preserveResourceUris(`kept ${uri} inline`, summarized);
    expect(out).not.toContain('## Preserved Resources');
  });

  it('is a no-op when nothing references a resource', () => {
    const out = preserveResourceUris('summary', [user('hi')]);
    expect(out).toBe('summary');
  });
});

describe('compactHistory orchestrator (issue #248)', () => {
  const deps = (summary: string) => ({
    summarize: jest.fn(async () => summary),
    now: () => 123,
    uuid: () => 'summary-id',
  });

  const longHistory = () => [
    user(bulk(4000)),
    assistant(bulk(4000)),
    user('recent question'),
    assistant('recent answer'),
  ];
  const options = (overrides: Partial<CompactHistoryOptions> = {}): CompactHistoryOptions => ({
    keepTokens: 20,
    conversationId: 'conv1',
    projection: {
      conversationId: 'conv1',
      nodeId: 'node-x',
      view: 'node-projected' as const,
      handoffPolicy: 'strip-v1' as const,
      version: 1 as const,
    },
    sourceDigest: 'source-digest',
    projectionDigest: 'projection-digest',
    policyVersion: 'summary-v1',
    modelId: 'model-1',
    ...overrides,
  });
  const summaryOf = (result: NonNullable<Awaited<ReturnType<typeof compactHistory>>>) =>
    result.wireMessages.find(isCompactionSummary)!;

  it('builds a wire-only artifact without mutating canonical input', async () => {
    const messages = longHistory();
    const d = deps('## Objective\n- ship it');
    const before = JSON.parse(JSON.stringify(messages));
    const result = await compactHistory(messages, options({ nodeId: 'node-x' }), d);

    expect(result).not.toBeNull();
    expect(messages).toEqual(before);
    const summary = summaryOf(result!);
    expect(summary.processNodeId).toBe('node-x');
    expect(result!.wireMessages[result!.wireMessages.length - 1].content).toBe('recent answer');
    expect(result!.artifact.sourceDigest).toBe('source-digest');
    expect(result).not.toHaveProperty('removedIds');
    expect(result).not.toHaveProperty('newMessages');
  });

  it('aborts (no mutation) on an empty summary', async () => {
    const result = await compactHistory(longHistory(), options(), deps('   '));
    expect(result).toBeNull();
  });

  it('aborts (no mutation) when the model call throws', async () => {
    const result = await compactHistory(longHistory(), options(), {
      summarize: jest.fn(async () => { throw new Error('boom'); }),
    });
    expect(result).toBeNull();
  });

  it('is a no-op when there is nothing old enough to summarize', async () => {
    const d = deps('summary');
    const result = await compactHistory([user('a'), assistant('b')], options({ keepTokens: 100000 }), d);
    expect(result).toBeNull();
    expect(d.summarize).not.toHaveBeenCalled();
  });

  it('passes the previous summary to the model (update-previous-summary) and embeds an anchor URI', async () => {
    const messages = [
      assistant(`${COMPACTION_SUMMARY_MARKER}\n\nold facts`),
      user(bulk(4000)),
      assistant(bulk(4000)),
      user('recent'),
    ];
    const summarize = jest.fn(async (_m: FlujoChatMessage[], _p: { system: string; user: string }) => 'merged anchor');
    const writeAnchor = jest.fn(async (_text: string) => 'flujo://run/conv1/anchor-1');
    const result = await compactHistory(messages, options(), {
      summarize,
      writeAnchor,
      now: () => 1,
      uuid: () => 'sid',
    });
    // The prompt handed to summarize must carry the previous summary.
    const promptArg = summarize.mock.calls[0][1];
    expect(promptArg!.user).toContain('old facts');
    // The anchor URI must be embedded in the head for recoverability.
    expect(summaryOf(result!).content).toContain('flujo://run/conv1/anchor-1');
    expect(writeAnchor).toHaveBeenCalledTimes(1);
  });

  it('does not lose facts across two consecutive compactions (fact carried through)', async () => {
    // First compaction produces a head containing FACT_A.
    const first = await compactHistory(longHistory(), options(), {
      summarize: jest.fn(async () => '## Important Details\n- FACT_A: /etc/config.yaml'),
      now: () => 1,
      uuid: () => 'sum1',
    });
    const firstSummary = summaryOf(first!);
    expect(firstSummary.content).toContain('FACT_A: /etc/config.yaml');

    // Second compaction over history that starts with the first summary head.
    const second = await compactHistory(
      [firstSummary, user(bulk(4000)), assistant(bulk(4000)), user('recent')],
      options({ sourceDigest: 'source-digest-2' }),
      {
        // A well-behaved model preserves the still-true fact from <previous-summary>.
        summarize: jest.fn(async (_m: FlujoChatMessage[], prompt: { system: string; user: string }) => {
          expect(prompt.user).toContain('FACT_A: /etc/config.yaml');
          return '## Important Details\n- FACT_A: /etc/config.yaml\n- FACT_B: new';
        }),
        now: () => 2,
        uuid: () => 'sum2',
      },
    );
    expect(summaryOf(second!).content).toContain('FACT_A: /etc/config.yaml');
    expect(summaryOf(second!).content).toContain('FACT_B: new');
  });
});

describe('estimateTokens', () => {
  it('is monotonic in content size', () => {
    const small = estimateTokens([user('hi')]);
    const large = estimateTokens([user(bulk(8000))]);
    expect(large).toBeGreaterThan(small);
  });
});
