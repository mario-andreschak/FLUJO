import {
  ListArgumentError,
  paginateList,
  parseListArgs,
} from '@/backend/services/mcp/listQuery';

describe('MCP list query contract', () => {
  it('round-trips opaque cursors without duplicating or skipping items', () => {
    const firstArgs = parseListArgs({ limit: 2 }, { defaultLimit: 50 });
    const first = paginateList(['a', 'b', 'c'], firstArgs);
    expect(first).toMatchObject({ items: ['a', 'b'], total: 3, hasMore: true });

    const secondArgs = parseListArgs({ limit: 2, cursor: first.nextCursor }, { defaultLimit: 50 });
    expect(paginateList(['a', 'b', 'c'], secondArgs)).toEqual({
      items: ['c'], total: 3, hasMore: false,
    });
  });

  it('rejects malformed cursors, excessive limits, and unknown filters', () => {
    expect(() => parseListArgs({ cursor: 'not-a-cursor' })).toThrow(ListArgumentError);
    expect(() => parseListArgs({ limit: 201 })).toThrow('between 1 and 200');
    expect(() => parseListArgs({ surprise: true })).toThrow('Unsupported list argument');
  });
});
