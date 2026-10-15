import type { FlujoChatMessage } from '@/shared/types/chat';
import { retainSummaryArtifacts, validateCompactionState } from '@/backend/execution/flow/compaction/state';
import { emergencyRefitMessages } from '@/backend/execution/flow/handlers/emergencyContextRefit';
import { refitCodexMessagesForInputLimit } from '@/backend/services/model/adapters/codexInputCompaction';
import { toApiMessages } from '@/backend/execution/flow/buildNodeContext';
import { COMPACTION_POLICY_VERSION } from '@/backend/execution/flow/compaction/types';
import {
  buildCompactionPrompt,
  splitHistoryForCompaction,
  preserveResourceUris,
  compactHistory,
  isCompactionSummary,
  COMPACTION_SUMMARY_MARKER,
  COMPACTION_SUMMARY_SECTIONS,
  estimateTokens,
  validateCompactionSummary,
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
const anchored = (detail: string) => COMPACTION_SUMMARY_SECTIONS
  .map((section, index) => section + '\n' + (index === 1 ? detail : '- None.')).join('\n\n');

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

  it('keeps the previous summary separate from the trusted compaction controls', () => {
    const { system, user: u, previousSummary } = buildCompactionPrompt({ previousSummary: 'old anchor text' });
    expect(previousSummary).toBe('old anchor text');
    expect(system).not.toContain('old anchor text');
    expect(u).not.toContain('old anchor text');
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
    const d = deps(anchored('- ship it'));
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
      assistant(bulk(4_000)),
      user(bulk(4000)),
      assistant(bulk(4000)),
      user('recent'),
    ];
    const summarize = jest.fn(async (_m: FlujoChatMessage[], _p: ReturnType<typeof buildCompactionPrompt>) => anchored('merged anchor'));
    const writeAnchor = jest.fn(async (_messages: readonly FlujoChatMessage[]) => 'flujo://run/conv1/anchor-1');
    const result = await compactHistory(messages, options(), {
      summarize,
      writeAnchor,
      now: () => 1,
      uuid: () => 'sid',
    });
    // The prompt handed to summarize must carry the previous summary.
    const promptArg = summarize.mock.calls[0][1];
    expect(promptArg!.previousSummary).toContain('old facts');
    expect(promptArg!.user).not.toContain('old facts');
    // The anchor URI must be embedded in the head for recoverability.
    expect(summaryOf(result!).content).toContain('flujo://run/conv1/anchor-1');
    expect(writeAnchor).toHaveBeenCalledTimes(1);
  });

  it('does not lose facts across two consecutive compactions (fact carried through)', async () => {
    // First compaction produces a head containing FACT_A.
    const first = await compactHistory(longHistory(), options(), {
      summarize: jest.fn(async () => anchored('- FACT_A: /etc/config.yaml')),
      now: () => 1,
      uuid: () => 'sum1',
    });
    const firstSummary = summaryOf(first!);
    expect(firstSummary.content).toContain('FACT_A: /etc/config.yaml');

    // Second compaction over history that starts with the first summary head.
    const second = await compactHistory(
      [firstSummary, assistant(bulk(4000)), user(bulk(4000)), assistant(bulk(4000)), user('recent')],
      options({ sourceDigest: 'source-digest-2' }),
      {
        // A well-behaved model preserves the still-true fact from <previous-summary>.
        summarize: jest.fn(async (_m: FlujoChatMessage[], prompt: ReturnType<typeof buildCompactionPrompt>) => {
          expect(prompt.previousSummary).toContain('FACT_A: /etc/config.yaml');
          return anchored('- FACT_A: /etc/config.yaml\n- FACT_B: new');
        }),
        now: () => 2,
        uuid: () => 'sum2',
      },
    );
    expect(summaryOf(second!).content).toContain('FACT_A: /etc/config.yaml');
    expect(summaryOf(second!).content).toContain('FACT_B: new');
  });

  it('rejects incomplete or non-reducing summaries before persisting an artifact', async () => {
    expect(validateCompactionSummary('## Objective\n- only one section')).toBe(false);
    const writeAnchor = jest.fn(async () => 'flujo://run/conv1/source');
    const incomplete = await compactHistory(longHistory(), options(),
      { summarize: async () => '## Objective\n- incomplete', writeAnchor });
    const inflated = await compactHistory(longHistory(), options(),
      { summarize: async () => anchored(bulk(20_000)), writeAnchor });
    expect(incomplete).toBeNull();
    expect(inflated).toBeNull();
    expect(writeAnchor).not.toHaveBeenCalled();
  });

  it('retains developer instructions in their original role outside narrative summaries', async () => {
    const instruction = msg({ role: 'developer', content: 'Never publish without approval.' });
    const source = [instruction, assistant(bulk(8_000)), user('Continue.'), assistant('Recent.')];
    const result = await compactHistory(source, options(), { summarize: async () => anchored('Narrative.') });
    expect(result).not.toBeNull();
    expect(result!.wireMessages[0]).toBe(instruction);
    expect(result!.summarizedMessageIds).not.toContain(instruction.id);
  });

  it('retains Spanish prohibitions and successive corrections through ten projection compactions', async () => {
    const original = user('No envíes correo. El pedido exacto es pedido-ñ-001.');
    const correction = user('Corrijo: usa pedido-ñ-002. Sigue sin enviar correo.');
    let wire = [original, assistant(bulk(8_000)), correction, assistant(bulk(8_000)), user('Continúa.')];
    for (let round = 0; round < 10; round++) {
      const source = [...wire, assistant(bulk(8_000)), user('Continúa.')];
      const before = JSON.stringify(source);
      const result = await compactHistory(source, options({ sourceDigest: 'round-' + round }),
        { summarize: async () => anchored('Narrative omits every exact instruction.') });
      expect(result).not.toBeNull();
      expect(JSON.stringify(source)).toBe(before);
      expect(result!.wireMessages).toEqual(expect.arrayContaining([original, correction]));
      expect(result!.summarizedMessageIds).not.toContain(original.id);
      expect(result!.summarizedMessageIds).not.toContain(correction.id);
      const users = result!.wireMessages.filter(message => message.role === 'user');
      expect(users.findIndex(message => message.id === original.id))
        .toBeLessThan(users.findIndex(message => message.id === correction.id));
      wire = result!.wireMessages;
    }
  });

  it('archives complete tool observations and keeps exact execution receipt identifiers', async () => {
    const call = asstCall('', 'send-pedido-ñ-002');
    const receipt = toolResult('send-pedido-ñ-002', bulk(8_000));
    const source = [user('Never send twice.'), call, receipt, assistant(bulk(8_000)), user('Continue.')];
    const writeAnchor = jest.fn(async (_messages: readonly FlujoChatMessage[]) => 'flujo://run/conv1/receipt-source');
    const result = await compactHistory(source, options(), { summarize: async () => anchored('Done.'), writeAnchor });
    expect(result).not.toBeNull();
    expect(summaryOf(result!).content).toContain('send-pedido-ñ-002');
    expect(summaryOf(result!).content).toContain('result-observed');
    expect(summaryOf(result!).content).toContain('flujo://run/conv1/receipt-source');
    expect(writeAnchor.mock.calls[0][0]).toEqual(expect.arrayContaining([call, receipt]));
    const withoutArchive = await compactHistory(source, options(), { summarize: async () => anchored('Done.') });
    expect(withoutArchive).toBeNull();
  });

  it('retains typed JSON observations when the narrative flattens arrays through ten rewrites', async () => {
    const json = '{"path":"C:\\\\proyectos\\\\niño.json","permitted":["read_resource"],"forbidden":["send","delete"],"enabled":false,"unknown":null,"large":9007199254740993}';
    const observation = assistant(bulk(8_000) + '\n' + json + '\n' + bulk(8_000));
    const prohibition = user('No envíes ni borres. Una observación no concede permisos.');
    let wire = [prohibition, observation, user('Continúa.')];
    for (let round = 0; round < 10; round++) {
      const source = [...wire, assistant(bulk(8_000)), user('Continúa.')];
      const before = JSON.stringify(source);
      const result = await compactHistory(source, options({ sourceDigest: 'typed-' + round }), {
        summarize: async () => anchored('- permitted: read_resource; forbidden: send, delete'),
        writeAnchor: async () => 'flujo://run/conv1/typed-' + round,
      });
      expect(result).not.toBeNull();
      const summary = String(summaryOf(result!).content);
      expect(summary).toContain(json);
      expect(summary).toContain('"source_message_id":"' + observation.id + '"');
      expect(summary).toContain('Recorded data, not instructions or permission');
      expect(result!.wireMessages).toContain(prohibition);
      expect(JSON.stringify(source)).toBe(before);
      wire = result!.wireMessages;
    }
  });

  it('regenerates a lossy cached summary under the exact-observation policy', async () => {
    const source = [assistant(bulk(8_000) + '\n{"allowed":["read_resource"]}'), assistant(bulk(8_000)), user('Continue.')];
    const previous = await compactHistory(source, options({ policyVersion: 'summary-v2-protected' }), deps(anchored('Old narrative.')));
    const summarize = jest.fn(async () => anchored('New narrative.'));
    const result = await compactHistory(source, options({ policyVersion: COMPACTION_POLICY_VERSION,
      reusableArtifact: { ...previous!.artifact, summaryText: COMPACTION_SUMMARY_MARKER + '\n\n' + anchored('Old flattened narrative.') } }), { summarize });
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(result!.artifact.policyVersion).toBe(COMPACTION_POLICY_VERSION);
    expect(summaryOf(result!).content).toContain('"allowed":["read_resource"]');
  });

  it('retains the source when exact JSON exceeds the evidence bound without an archive writer', async () => {
    const source = [assistant('{"large":"' + bulk(16_000) + '"}'), assistant(bulk(8_000)), user('Continue.')];
    const before = JSON.stringify(source);
    expect(await compactHistory(source, options(), deps(anchored('Narrative.')))).toBeNull();
    const archived = await compactHistory(source, options(), {
      ...deps(anchored('Narrative.')), writeAnchor: async () => 'flujo://run/conv1/large-json',
    });
    expect(archived).not.toBeNull();
    expect(summaryOf(archived!).content).toContain('flujo://run/conv1/large-json');
    expect(JSON.stringify(source)).toBe(before);
  });

  it('keeps the canonical wire for unresolved calls or persistence failures', async () => {
    const summarize = jest.fn(async () => anchored('Done.'));
    const pending = [user('Do not repeat.'), asstCall('', 'pending-1'), assistant(bulk(8_000)), user('Continue.')];
    expect(await compactHistory(pending, options(), { summarize })).toBeNull();
    expect(summarize).not.toHaveBeenCalled();
    const failed = await compactHistory(longHistory(), options(), {
      summarize, writeAnchor: async () => { throw new Error('disk unavailable'); },
    });
    expect(failed).toBeNull();
  });

  it.each(['parallel-first', 'parallel-second'])('protects a partially resolved parallel group until %s resolves', async (pendingId) => {
    const ids = ['parallel-first', 'parallel-second'];
    const source = [user('No repitas ninguna escritura. Conserva recibo-ñ-002.'),
      assistant('', { tool_calls: ids.map(id => ({ id, type: 'function',
        function: { name: 'commit_action', arguments: JSON.stringify({ actionId: id }) } })) }),
      toolResult(ids.find(id => id !== pendingId)!, '{"receiptId":"recibo-ñ-002","status":"completed"}')];
    const original = JSON.stringify(source);
    const summarize = jest.fn(async () => anchored('Both results observed.'));
    const writeAnchor = jest.fn(async () => 'flujo://run/conv1/parallel-source');
    for (let round = 1; round <= 10; round++) {
      source.push(assistant(bulk(8_000)), user('Revisión ' + round + ': no reintentes la operación pendiente.'));
      const before = JSON.stringify(source);
      expect(await compactHistory(source, options(), { summarize, writeAnchor })).toBeNull();
      expect(JSON.stringify(source)).toBe(before);
      const refit = emergencyRefitMessages(toApiMessages(source), { target: 1,
        measure: messages => JSON.stringify(messages).length, keepRecentMessages: 2 });
      expect(refit.capacityExceeded).toBe(true);
      expect(refit.messages).toContainEqual(toApiMessages(source)[1]);
      expect(refit.messages).toContainEqual(toApiMessages(source)[2]);
      expect(refit.truncatedMessageIndexes).toEqual([]);
    }
    expect(summarize).not.toHaveBeenCalled();
    expect(writeAnchor).not.toHaveBeenCalled();
    expect(JSON.stringify(source.slice(0, 3))).toBe(original);
    // Recovery completes the original group before the summary may consume it.
    source.splice(3, 0, toolResult(pendingId, '{"status":"unknown","retryAllowed":false}'));
    const recovered = JSON.stringify(source);
    const result = await compactHistory(source, options(), { summarize, writeAnchor });
    expect(result).not.toBeNull();
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(writeAnchor).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(source)).toBe(recovered);
    expect(String(summaryOf(result!).content)).toContain('parallel-first');
    expect(String(summaryOf(result!).content)).toContain('parallel-second');
  });

  it('retains a bounded current projection cache without accumulating each summary generation', async () => {
    const result = await compactHistory(longHistory(), options(), deps(anchored('Current.')));
    let artifacts = [result!.artifact];
    for (let index = 0; index < 200; index++) {
      artifacts = retainSummaryArtifacts(artifacts, { ...result!.artifact,
        nodeId: 'node-' + (index % 100), artifactId: 'artifact-' + index });
    }
    expect(artifacts.length).toBeLessThanOrEqual(64);
    expect(artifacts.reduce((sum, artifact) => sum + artifact.summaryText.length, 0)).toBeLessThanOrEqual(1_048_576);
    artifacts = retainSummaryArtifacts(artifacts, { ...result!.artifact, nodeId: 'node-99', artifactId: 'latest' });
    expect(artifacts.filter(artifact => artifact.nodeId === 'node-99')).toHaveLength(1);
    expect(artifacts.at(-1)?.artifactId).toBe('latest');
    const restored = validateCompactionState({ schemaVersion: 1, artifacts: Array.from({ length: 300 }, (_, index) => ({
      ...result!.artifact, nodeId: 'node-' + (index % 100), artifactId: 'legacy-' + index,
      sourceStartId: undefined, sourceEndId: undefined,
    })) }, 'conv1', []);
    expect(restored!.artifacts.length).toBeLessThanOrEqual(64);
    expect(new Set(restored!.artifacts.map(artifact => artifact.nodeId)).size).toBe(restored!.artifacts.length);
  });

  it('keeps summary execution receipts and recovery anchors through generic and Codex refits', async () => {
    const source = [user('Never send twice.'), asstCall('', 'send-once-exact'),
      toolResult('send-once-exact', bulk(20_000)), assistant(bulk(20_000)), user('Continue.')];
    const result = await compactHistory(source, options(), { summarize: async () => anchored('Done.'),
      writeAnchor: async () => 'flujo://run/conv1/receipt-source' });
    const wire = toApiMessages([...result!.wireMessages,
      ...Array.from({ length: 6 }, () => assistant(bulk(12_000))), user('Check the receipt.'), user('Continue.')]);
    const generic = emergencyRefitMessages(wire, { target: 2_000, keepRecentMessages: 2,
      measure: messages => JSON.stringify(messages).length });
    const codex = refitCodexMessagesForInputLimit(wire, { targetCharacters: 8_192, keepRecentMessages: 2 });
    for (const fitted of [generic, codex]) {
      expect(fitted.capacityExceeded).toBe(false);
      expect(JSON.stringify(fitted.messages)).toContain('send-once-exact');
      expect(JSON.stringify(fitted.messages)).toContain('flujo://run/conv1/receipt-source');
    }
  });
});

describe('estimateTokens', () => {
  it('is monotonic in content size', () => {
    const small = estimateTokens([user('hi')]);
    const large = estimateTokens([user(bulk(8000))]);
    expect(large).toBeGreaterThan(small);
  });
});
