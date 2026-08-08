import { formatPartialJson } from '@/frontend/utils/partialJson';

describe('formatPartialJson', () => {
  it('pretty-prints complete JSON', () => {
    expect(formatPartialJson('{"query":"hello","limit":2}')).toEqual({
      text: '{\n  "query": "hello",\n  "limit": 2\n}',
      complete: true,
    });
  });

  it('never throws while a representative payload is truncated', () => {
    const payload = '{"query":"hello","filters":["open","assigned"],"limit":2}';
    for (let offset = 0; offset < payload.length; offset += 1) {
      expect(() => formatPartialJson(payload.slice(0, offset))).not.toThrow();
      expect(formatPartialJson(payload.slice(0, offset)).complete).toBe(false);
    }
  });

  it('does not claim malformed input is complete', () => {
    const preview = formatPartialJson('{"query":');
    expect(preview.complete).toBe(false);
  });
});
