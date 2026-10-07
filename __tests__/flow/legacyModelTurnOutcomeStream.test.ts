import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { LegacyModelTurnOutcomeTransform } from '@/backend/execution/flow/legacyModelTurnOutcomeStream';

async function transform(text: string, size = 1) {
  const input = Buffer.from(text);
  const chunks = function* () { for (let i = 0; i < input.length; i += size) yield input.subarray(i, i + size); };
  const output: Buffer[] = [];
  const edit = new LegacyModelTurnOutcomeTransform('completed');
  edit.on('data', (chunk: Buffer) => output.push(chunk));
  await pipeline(Readable.from(chunks()), edit);
  return Buffer.concat(output).toString('utf8');
}

describe('streamed legacy outcome compatibility', () => {
  it.each([1, 2, 7, 64 * 1024])('preserves every non-outcome byte across %i-byte boundaries', async size => {
    const input = ' \n{"canonicalMessages":[{"content":"á🌍\\n\\u0100","outcome":"running"}], "entry" : {"id":"dispatch", "outcome" : "running"}, "sdkRequest":{"n":-12.3e+4,"zero":0,"values":[true,false,null,[],{}]}}\n';
    const expected = input.replace('"outcome" : "running"', '"outcome" : "completed"');
    expect(await transform(input, size)).toBe(expected);
  });

  it('recognizes escaped entry/outcome keys and replaces a whole nested old outcome value', async () => {
    const input = '{"\\u0065ntry":{"\\u006futcome":{"nested":[1,"\\\"",{}]},"id":"dispatch"},"history":["retained"]}';
    expect(JSON.parse(await transform(input))).toEqual({ entry: { outcome: 'completed', id: 'dispatch' }, history: ['retained'] });
  });

  it.each(['{}', '{"id":"dispatch"}'])('adds a missing outcome without dropping metadata: %s', async entry => {
    const result = await transform(`{"history":[1,2],"entry":${entry}}`);
    expect(JSON.parse(result)).toEqual({ history: [1, 2], entry: { ...JSON.parse(entry), outcome: 'completed' } });
  });

  it('preserves duplicate unknown keys and makes every duplicate outcome consistent', async () => {
    const input = '{"entry":{"outcome":"error","outcome":"running"},"unknown":1,"unknown":2}';
    expect(await transform(input)).toBe('{"entry":{"outcome":"completed","outcome":"completed"},"unknown":1,"unknown":2}');
  });

  it.each([
    '', '[]', '{}', '{"entry":null}', '{"entry":[]}', '{"entry":{},}',
    '{"entry":{},"bad":[1,]}', '{"entry":{},"bad":01}', '{"entry":{},"bad":1.}',
    '{"entry":{},"bad":1e+}', '{"entry":{},"bad":tru}', '{"entry":{},"bad":"\\x00"}',
    '{"entry":{},"bad":"\\u0xyz"}', '{"entry":{},"bad":"line\nbreak"}',
    '{"entry":{},"bad":[}', '{"entry":{}} garbage', '{"entry":{"outcome":"running"}}{}',
  ])('refuses malformed JSON before any final publication: %s', async input => {
    await expect(transform(input)).rejects.toBeInstanceOf(SyntaxError);
  });

  it('matches native JSON semantics across varied request structures and chunk boundaries', async () => {
    for (let i = 0; i < 100; i++) {
      const input = { sdkRequest: { [i % 2 ? 'entry' : 'outcome']: { content: `Á🌍\\" ${i}`, n: i * -1.25e-12 },
        values: [null, true, false, 0, -0, 1e21, [], {}, [i, { a: 'b' }]] },
        canonicalMessages: [{ role: 'user', content: 'complete history' }],
        entry: { id: 'dispatch', outcome: i % 2 ? 'error' : 'running', attempt: i + 1 }, media: [] };
      expect(JSON.parse(await transform(JSON.stringify(input), 1 + i % 17)))
        .toEqual(JSON.parse(JSON.stringify({ ...input, entry: { ...input.entry, outcome: 'completed' } })));
    }
  });
});
