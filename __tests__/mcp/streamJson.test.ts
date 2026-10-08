import { streamJsonChunks } from '@/app/api/mcp/servers/[name]/tools/[toolName]/stream/streamJson';

describe('streamJsonChunks', () => {
  it('round-trips a complete large result without one monolithic chunk', async () => {
    const value = {
      success: true,
      data: {
        content: [
          { type: 'text', text: 'a"b\\c\n😀'.repeat(20_000) },
          ...Array.from({ length: 200 }, (_, index) => ({ index, ok: index % 2 === 0 })),
        ],
      },
    };

    const chunks: string[] = [];
    for await (const chunk of streamJsonChunks(value)) chunks.push(chunk);

    expect(chunks.length).toBeGreaterThan(2);
    expect(JSON.parse(chunks.join(''))).toEqual(value);
  });

  it('matches JSON semantics for undefined array entries and non-finite numbers', async () => {
    const value = { array: [undefined, Number.NaN, Infinity, true], omitted: undefined };
    const chunks: string[] = [];
    for await (const chunk of streamJsonChunks(value)) chunks.push(chunk);
    expect(chunks.join('')).toBe(JSON.stringify(value));
  });
});
