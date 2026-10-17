import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FlujoChatMessage } from '@/shared/types/chat';
import { digestProjectedMessages, digestProjectionIdentity } from '@/backend/execution/flow/compaction/digest';

// The pre-streaming persisted digest contract, independently retained here so
// a serialization change cannot silently reuse or invalidate saved artifacts.
function legacyDigest(value: unknown): string {
  const canonicalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(canonicalize);
    if (entry && typeof entry === 'object') return Object.fromEntries(Object.entries(entry)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]));
    return entry;
  };
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

const messages = (metadata: unknown, content = 'Keep this instruction'): FlujoChatMessage[] => [
  { id: 'instruction', role: 'system', content, metadata, timestamp: 1 },
] as unknown as FlujoChatMessage[];

describe('complete compaction fingerprints (#569/#1091)', () => {
  it.each([
    { empty: '', absent: undefined, nil: null, array: [undefined, null, NaN, Infinity, -0] },
    { '10': 'ten', '2': 'two', '0': 'zero', '4294967294': 'index', '4294967295': 'key', '01': 'leading', '-1': 'negative' },
    JSON.parse('{"__proto__":{"safe":true},"constructor":"data","é":1,"é":2,"中":3}'),
    { sparse: Array(3), ignored: Symbol('value'), callback: () => 'unused', date: new Date(0), bytes: new Uint8Array([3, 2]) },
    { nested: { z: [{ b: 2, a: 1 }], a: true }, escaped: '\b\t\n\f\r\u0000"\\\u2028\u2029' },
  ])('retains the persisted JSON contract for %p', metadata => {
    const input = messages(metadata);
    expect(digestProjectedMessages(input)).toBe(legacyDigest(input));
  });

  it.each([16382, 16383, 16384, 32767])('preserves paired and lone surrogates at code-unit %i', length => {
    const content = 'x'.repeat(length) + '🧭\ud800\udc00\ud800x\udc00保留"\\\n';
    const input = messages({ ['key' + content]: content }, content);
    expect(digestProjectedMessages(input)).toBe(legacyDigest(input));
  });

  it('keeps the unusual callable toJSON behavior of the old canonical clone', () => {
    const callable = Object.assign(() => undefined, { toJSON: (key: string) => ({ key }) });
    const input = messages({ value: { z: 'retained', toJSON(key: string) { return { key, value: this.z }; } }, callable, array: [callable] });
    expect(digestProjectedMessages(input)).toBe(legacyDigest(input));
  });

  it('matches saved hashes across deterministic mixed JSON payloads', () => {
    let seed = 0x5691091;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    const atoms = ['"', '\\', '\n', '\u0000', '🧭', '\ud800', '\udc00', '保留', 'é', '\u2028'];
    const value = (depth: number): unknown => {
      const kind = next() % (depth ? 7 : 5);
      if (kind === 0) return null;
      if (kind === 1) return next() % 2 === 0;
      if (kind === 2) return next() / 13;
      if (kind === 3) return undefined;
      if (kind === 4) return Array.from({ length: next() % 20 }, () => atoms[next() % atoms.length]).join('');
      if (kind === 5) return Array.from({ length: next() % 5 }, () => value(depth - 1));
      return Object.fromEntries(Array.from({ length: next() % 8 }, (_, index) => [
        ['10', '2', '01', '__proto__', '中', 'é', 'é', 'key'][index], value(depth - 1),
      ]));
    };
    for (let index = 0; index < 128; index += 1) {
      const input = messages(value(4));
      expect(digestProjectedMessages(input)).toBe(legacyDigest(input));
    }
  });

  it('retains the old refusal of bigint and circular data', () => {
    expect(() => digestProjectedMessages(messages({ big: BigInt(1) }))).toThrow(TypeError);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => digestProjectedMessages(messages(circular))).toThrow(RangeError);
  });

  it('ignores key insertion order while retaining message order and all metadata', () => {
    const first = messages({ z: { b: 2, a: 1 }, a: 3 });
    const same = messages({ a: 3, z: { a: 1, b: 2 } });
    const changed = messages({ a: 4, z: { a: 1, b: 2 } });
    expect(digestProjectedMessages(first)).toBe(digestProjectedMessages(same));
    expect(digestProjectedMessages(first)).not.toBe(digestProjectedMessages(changed));
    const pair: FlujoChatMessage[] = [...first, { id: 'second', role: 'user', content: 'Second message', timestamp: 1 }];
    expect(digestProjectedMessages(pair)).not.toBe(digestProjectedMessages([...pair].reverse()));
    expect(digestProjectedMessages(pair)).not.toBe(digestProjectedMessages([{ ...pair[0], id: 'edited' }, pair[1]]));
  });

  it('retains projection-identity fingerprints without changing frozen source', () => {
    const identity = Object.freeze({ conversationId: 'run', view: 'full-history' as const, handoffPolicy: 'strip-v1' as const, version: 1 as const, nodeId: undefined });
    const input = Object.freeze(messages(Object.freeze({ receipt: Object.freeze({ toolCallId: 'exact-id', completed: false }) })));
    Object.freeze(input[0]);
    expect(digestProjectionIdentity(identity)).toBe(legacyDigest(identity));
    expect(digestProjectedMessages(input)).toBe(legacyDigest(input));
  });

  it('streams repeated 48 MiB transcripts within the transient allocation envelope', () => {
    const source = pathToFileURL(path.resolve('src/backend/execution/flow/compaction/digest.ts')).href;
    const result = spawnSync(process.execPath, [
      '--experimental-strip-types', '--expose-gc', '--max-old-space-size=32', '--max-semi-space-size=1', '--input-type=module', '-e', `
        import { createHash } from 'node:crypto';
        import { getHeapStatistics } from 'node:v8';
        const { digestProjectedMessages } = await import(${JSON.stringify(source)});
        const payload = 'x'.repeat(2 * 1024 * 1024 - 15) + '🧭\\ud800\\n"\\\\保留';
        const input = Array.from({ length: 24 }, (_, index) => ({
          id: 'message-' + index, role: index === 0 ? 'system' : 'user', content: payload,
          metadata: { instruction: 'Keep the exact instruction', index },
        }));
        const fingerprint = createHash('sha256').update(payload).digest('hex');
        globalThis.gc();
        const before = process.memoryUsage();
        const samples = [];
        for (let round = 0; round < 3; round += 1) {
          const digest = digestProjectedMessages(input);
          const transient = process.memoryUsage();
          if (digest !== 'ae1e7cc4701f31d711eccdbee488a31e34328ae470e754c80e99ad6693e01264') throw new Error('Persisted hash changed');
          if (transient.heapUsed - before.heapUsed > 24 * 1024 * 1024 || transient.rss - before.rss > 48 * 1024 * 1024) throw new Error('Full-transcript allocation returned');
          globalThis.gc();
          const retained = process.memoryUsage();
          if (retained.heapUsed - before.heapUsed > 4 * 1024 * 1024) throw new Error('Transcript retained between batches');
          samples.push({ transient, retained });
        }
        if (input.some((message, index) => message.id !== 'message-' + index || message.content !== payload) || createHash('sha256').update(payload).digest('hex') !== fingerprint) throw new Error('Canonical input changed');
        console.log(JSON.stringify({ complete: true, heapLimit: getHeapStatistics().heap_size_limit, before, samples }));
      `,
    ], { encoding: 'utf8', timeout: 30_000, maxBuffer: 128 * 1024, env: { ...process.env, NODE_OPTIONS: '' } });
    expect({ error: result.error?.message, status: result.status, stderr: result.stderr }).toEqual({
      error: undefined, status: 0, stderr: expect.any(String),
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ complete: true, samples: expect.any(Array) });
  }, 35_000);
});
