import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type { FlujoChatMessage } from '@/shared/types/chat';
import { estimateMessageTokens, estimateTokens, preserveResourceUris } from '@/backend/execution/flow/handlers/summarizingCompaction';

jest.mock('@/utils/logger', () => ({ createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn() }) }));

const message = (metadata: unknown, content = 'Exact instruction 🧭'): FlujoChatMessage =>
  ({ id: 'original', role: 'user', content, timestamp: 1, metadata }) as unknown as FlujoChatMessage;

function legacyUris(summary: string, messages: FlujoChatMessage[]): string {
  const found = new Set<string>();
  for (const item of messages) {
    let serialized: string;
    try { serialized = JSON.stringify(item); } catch { serialized = typeof item.content === 'string' ? item.content : ''; }
    for (const uri of serialized.match(/flujo:\/\/run\/[\w./-]+/g) ?? []) found.add(uri);
  }
  const missing = [...found].filter(uri => !summary.includes(uri));
  return missing.length ? summary + '\n\n## Preserved Resources\n'
    + missing.map(uri => `- ${uri} (call read_resource with this uri to read the full content)`).join('\n') : summary;
}

describe('compaction preparation allocations (#569/#1091)', () => {
  it.each([
    { empty: '', omitted: undefined, nil: null, array: [undefined, null, NaN, Infinity, -0] },
    { '10': 'flujo://run/order/ten', '2': 'flujo://run/order/two', nested: [{ path: 'flujo://run/order/nested' }] },
    { sparse: Array(3), ignored: Symbol('value'), callback: () => 'ignored' },
    JSON.parse('{"__proto__":{"safe":true},"constructor":"data","é":1,"中":3}'),
    { escaped: '\b\t\n\f\r\u0000"\\\u2028\u2029', date: new Date(0), bytes: new Uint8Array([3, 2]) },
    { toJSON(key: string) { return { key, uri: 'flujo://run/custom/json' }; } },
  ])('retains native JSON counts and resource order for %p', metadata => {
    const input = message(metadata);
    expect(estimateMessageTokens(input)).toBe(Math.ceil(JSON.stringify(input).length / 4));
    expect(preserveResourceUris('summary', [input])).toBe(legacyUris('summary', [input]));
  });

  it.each([16382, 16383, 16384, 32767])('retains escaping and resources across code-unit %i', length => {
    const text = 'x'.repeat(length) + '🧭\ud800\udc00\ud800x\udc00保留"\\\n flujo://run/chunk/tail';
    const input = message({ ['key' + text]: text }, text);
    expect(estimateMessageTokens(input)).toBe(Math.ceil(JSON.stringify(input).length / 4));
    expect(preserveResourceUris('summary', [input])).toBe(legacyUris('summary', [input]));
  });

  it('preserves serialized keys, nested values, deduplication and original URI delimiters', () => {
    const input = message({
      'flujo://run/key/first': ['flujo://run/value/second', { text: 'flujo://run/value/second' }],
      'flujo://run/omitted/undefined': undefined,
      'flujo://run/omitted/function': () => undefined,
      text: 'flujo://run/end/line\nignored flujo://run/end/slash\\ignored flujo://run/end/quote"ignored '
        + 'flujo://run/flujo://run/overlap flujo://run/! flujo://run/🧭 flujo://run/valid',
    }, 'flujo://run/content/first');
    const summary = 'Existing flujo://run/value/second';
    expect(preserveResourceUris(summary, [input, input])).toBe(legacyUris(summary, [input, input]));
  });

  it('falls back to content atomically when serialization fails', () => {
    const circular: Record<string, unknown> = { first: 'flujo://run/discard/metadata' };
    circular.self = circular;
    for (const metadata of [circular, { first: 'flujo://run/discard/metadata', bigint: BigInt(1) }]) {
      const input = message(metadata, 'Keep flujo://run/fallback/content');
      expect(estimateMessageTokens(input)).toBe(Math.ceil(String(input.content).length / 4));
      expect(preserveResourceUris('summary', [input])).toBe(legacyUris('summary', [input]));
      expect(preserveResourceUris('summary', [input])).not.toContain('discard');
    }
  });

  it('executes custom getters and toJSON once per native fallback', () => {
    let reads = 0;
    const input = message({ get uri() { reads += 1; return 'flujo://run/getter/value'; } });
    estimateMessageTokens(input);
    expect(reads).toBe(1);
    preserveResourceUris('summary', [input]);
    expect(reads).toBe(2);
    let calls = 0;
    const callable = Object.assign(() => undefined, { toJSON(key: string) { calls += 1; return { key, uri: 'flujo://run/callable/value' }; } });
    preserveResourceUris('summary', [message({ callable })]);
    expect(calls).toBe(1);
  });

  it('matches mixed persisted data without mutating frozen or shared messages', () => {
    const atoms = ['flujo://run/mixed/a', '🧭', '\ud800', '\udc00', '保留', '\n"\\', undefined, null, true, NaN, -0];
    for (let index = 0; index < 128; index += 1) {
      const metadata = Object.freeze({ ['key' + index]: atoms[index % atoms.length],
        nested: Object.freeze([atoms[(index + 3) % atoms.length], { 'flujo://run/key/nested': index }]) });
      const input = Object.freeze(message(metadata, 'Keep flujo://run/shared/content'));
      const serialized = JSON.stringify(input);
      expect(estimateMessageTokens(input)).toBe(Math.ceil(serialized.length / 4));
      expect(estimateTokens([input, input])).toBe(2 * Math.ceil(serialized.length / 4));
      expect(preserveResourceUris('summary', [input, input])).toBe(legacyUris('summary', [input, input]));
      expect(JSON.stringify(input)).toBe(serialized);
    }
  });

  it('keeps repeated large-message preparation within the transient and retained heap envelope', () => {
    const source = path.resolve('src/backend/execution/flow/handlers/summarizingCompaction.ts');
    const result = spawnSync(process.execPath, [
      '--expose-gc', '--max-old-space-size=192', '--max-semi-space-size=1', '-e', `
        const fs = require('node:fs');
        const path = require('node:path');
        const { createHash } = require('node:crypto');
        const ts = require('typescript');
        const modules = new Map();
        function load(file) {
          if (modules.has(file)) return modules.get(file).exports;
          const mod = { exports: {} };
          modules.set(file, mod);
          const emitted = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
          }).outputText;
          new Function('require', 'module', 'exports', emitted)(name => {
            if (name === '@/utils/logger') return { createLogger: () => ({ debug() {}, info() {}, warn() {} }) };
            if (name === '@/shared/types/runResources') return { RUN_RESOURCE_SCHEME: 'flujo://run/' };
            if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name + '.ts'));
            return require(name);
          }, mod, mod.exports);
          return mod.exports;
        }
        const api = load(${JSON.stringify(source)});
        const structured = load(path.resolve(path.dirname(${JSON.stringify(source)}), '../compaction/structuredObservations.ts'));
        const payload = 'flujo://run/case/start ' + 'x'.repeat(24 * 1024 * 1024)
          + ' 🧭\\ud800\\n"\\\\保留 flujo://run/case/tail';
        const input = Object.freeze({ id: 'large-tool', role: 'tool', tool_call_id: 'exact-call', content: payload, timestamp: 1,
          metadata: { 'flujo://run/case/key': ['flujo://run/case/nested'] } });
        const fingerprint = createHash('sha256').update(payload).digest('hex');
        const expected = Math.ceil(JSON.stringify(input).length / 4);
        const tailStart = input.content.lastIndexOf('\\n') + 1;
        const expectedRecords = [{ source_role: 'tool', source_message_id: 'large-tool',
          text: input.content.slice(tailStart), source_part: 0, source_start: tailStart, source_end: input.content.length }];
        global.gc();
        const before = process.memoryUsage();
        const samples = [];
        for (let round = 0; round < 3; round++) {
          for (const operation of ['tokens', 'uris', 'structured']) {
            global.gc();
            const start = process.memoryUsage();
            let incomplete = false;
            const actual = operation === 'tokens' ? api.estimateMessageTokens(input)
              : operation === 'uris' ? api.preserveResourceUris('summary', [input])
              : structured.buildStructuredObservationBlock([input], () => false, () => { incomplete = true; });
            const transient = process.memoryUsage();
            if (operation === 'tokens' && actual !== expected) throw new Error('Token estimate changed');
            if (operation === 'uris' && !['start', 'tail', 'key', 'nested'].every(id => actual.includes('flujo://run/case/' + id))) throw new Error('Resource URI lost');
            // Preserve the exact bounded tail with source offsets, and require
            // an archive notice for the oversized preceding line.
            if (operation === 'structured' && (!incomplete || actual.length > 1_024
              || !actual.startsWith('\\n\\n## Recorded Source Observations\\n')
              || !actual.endsWith('Additional source observations require read_resource on the full source archive.')
              || JSON.stringify(actual.split('\\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)))
                !== JSON.stringify(expectedRecords))) throw new Error('Invented structured observation or missing archive notice');
            if (transient.heapUsed - start.heapUsed > 16 * 1024 * 1024) throw new Error('Full-message allocation returned');
            global.gc();
            const retained = process.memoryUsage();
            if (retained.heapUsed - before.heapUsed > 4 * 1024 * 1024) throw new Error('Serialized message retained');
            samples.push({ round, operation, start, transient, retained });
          }
        }
        if (createHash('sha256').update(input.content).digest('hex') !== fingerprint) throw new Error('Canonical input changed');
        global.gc();
        const beforeRelease = process.memoryUsage();
        function summarizeReleasedSource() {
          const content = 'z'.repeat(24 * 1024 * 1024) + ' 🧭 flujo://run/released/resource';
          createHash('sha256').update(content).digest('hex');
          return api.preserveResourceUris('summary', [{ id: 'released', role: 'tool', timestamp: 1, content }]);
        }
        const summary = summarizeReleasedSource();
        global.gc();
        const afterRelease = process.memoryUsage();
        if (!summary.includes('flujo://run/released/resource') || summary.length > 256) throw new Error('Released-source URI changed');
        if (afterRelease.heapUsed - beforeRelease.heapUsed > 4 * 1024 * 1024) throw new Error('Small summary retained large source');
        function releaseStructuredSource() {
          const content = 'z'.repeat(24 * 1024 * 1024) + '\\n{"permitted":["read_resource"],"unknown":null}';
          createHash('sha256').update(content).digest('hex');
          return structured.buildStructuredObservationBlock([{ id: 'released-json', role: 'assistant', timestamp: 1, content }], () => false);
        }
        global.gc();
        const beforeStructuredRelease = process.memoryUsage();
        const structuredSummary = releaseStructuredSource();
        global.gc();
        const afterStructuredRelease = process.memoryUsage();
        if (!structuredSummary.includes('"permitted":["read_resource"]')) throw new Error('Typed observation lost');
        if (afterStructuredRelease.heapUsed - beforeStructuredRelease.heapUsed > 4 * 1024 * 1024) throw new Error('JSON record retained large source');
        console.log(JSON.stringify({ complete: true, samples, beforeRelease, afterRelease }));
      `,
    ], { encoding: 'utf8', timeout: 30_000, maxBuffer: 128 * 1024, env: { ...process.env, NODE_OPTIONS: '' } });
    expect({ error: result.error?.message, status: result.status, stderr: result.status ? result.stderr : '' }).toEqual({ error: undefined, status: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toMatchObject({ complete: true, samples: expect.any(Array) });
  }, 35_000);
});
