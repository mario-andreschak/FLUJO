import {
  chunkToolArguments,
  paceToolCallArguments,
  MAX_TOOL_ARGUMENT_CHUNKS,
} from '@/backend/services/model/adapters/toolArgumentPacing';
import type { ModelStreamDelta } from '@/backend/services/model/adapters/types';

describe('progressive tool-argument pacing (#337)', () => {
  const collect = async (
    argsJson: string,
    overrides: Partial<Parameters<typeof paceToolCallArguments>[0]> = {},
  ): Promise<ModelStreamDelta[]> => {
    const deltas: ModelStreamDelta[] = [];
    await paceToolCallArguments({
      messageId: 'stream_codex_1_toolcall_call-1',
      callId: 'call-1',
      name: 'filesystem__read_file',
      argsJson,
      delayMs: 0,
      onModelDelta: delta => { deltas.push(delta); },
      ...overrides,
    });
    return deltas;
  };

  it('emits the tool name before any argument fragment', async () => {
    const deltas = await collect('{"path":"README.md"}');

    expect(deltas[0]).toEqual({
      messageId: 'stream_codex_1_toolcall_call-1',
      toolCallDelta: { index: 0, id: 'call-1', nameDelta: 'filesystem__read_file' },
    });
    expect(deltas.slice(1).every(delta => delta.toolCallDelta?.argumentsDelta)).toBe(true);
    expect(deltas.slice(1).every(delta => delta.toolCallDelta?.nameDelta === undefined)).toBe(true);
  });

  it('reassembles losslessly no matter how large the payload is', async () => {
    const argsJson = JSON.stringify({ content: 'x'.repeat(20_000), path: 'big.txt' });
    const deltas = await collect(argsJson, { chunkChars: 64 });

    const reassembled = deltas
      .map(delta => delta.toolCallDelta?.argumentsDelta ?? '')
      .join('');
    expect(reassembled).toBe(argsJson);
    // Bounded: a huge payload becomes fewer, larger chunks, never thousands.
    expect(deltas.length - 1).toBeLessThanOrEqual(MAX_TOOL_ARGUMENT_CHUNKS);
  });

  it('never splits a surrogate pair, so every prefix stays renderable', () => {
    const argsJson = JSON.stringify({ note: '🙂🙂🙂🙂🙂🙂' });
    const chunks = chunkToolArguments(argsJson, 5);

    expect(chunks.join('')).toBe(argsJson);
    for (const chunk of chunks) {
      // A lone surrogate would make the rendered prefix an invalid string.
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(chunk)).toBe(false);
      expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(chunk)).toBe(false);
    }
    let prefix = '';
    for (const chunk of chunks) {
      prefix += chunk;
      expect(() => JSON.stringify(prefix)).not.toThrow();
    }
  });

  it('emits nothing for an empty argument string and no consumer', async () => {
    expect(chunkToolArguments('')).toEqual([]);
    expect(await collect('')).toHaveLength(1);
    await expect(
      paceToolCallArguments({
        messageId: 'm',
        callId: 'call-1',
        name: 'noop',
        argsJson: '{}',
        delayMs: 0,
      }),
    ).resolves.toBeUndefined();
  });

  it('waits between chunks but never blocks dispatch on a failing consumer', async () => {
    const waits: number[] = [];
    const deltas: ModelStreamDelta[] = [];
    let emitted = 0;

    await paceToolCallArguments({
      messageId: 'm',
      callId: 'call-1',
      name: 'search',
      argsJson: JSON.stringify({ query: 'y'.repeat(400) }),
      chunkChars: 64,
      delayMs: 5,
      sleep: async ms => { waits.push(ms); },
      onModelDelta: delta => {
        emitted += 1;
        deltas.push(delta);
        if (emitted === 2) throw new Error('subscriber exploded');
      },
    });

    expect(deltas.length).toBeGreaterThan(3);
    expect(waits).toEqual(Array(deltas.length - 2).fill(5));
    expect(
      deltas.map(delta => delta.toolCallDelta?.argumentsDelta ?? '').join(''),
    ).toBe(JSON.stringify({ query: 'y'.repeat(400) }));
  });
});
