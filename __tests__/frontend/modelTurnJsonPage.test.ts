import { MODEL_TURN_TEXT_PAGE_CHARS, modelTurnJsonPage } from '@/frontend/components/Chat/modelTurnJsonPage';

function complete(value: unknown) {
  const pages: string[] = [];
  for (let page = 0; ; page++) {
    const result = modelTurnJsonPage(value, page);
    expect(result.text.length).toBeLessThanOrEqual(MODEL_TURN_TEXT_PAGE_CHARS);
    pages.push(result.text);
    if (!result.hasNext) return pages.join('');
  }
}

it('keeps complete escaped and Unicode history across token and page boundaries', () => {
  const value = { request: [{ role: 'user', content: ('a'.repeat(4095) + '🌍\n"\\').repeat(40) }], final: 'last-field' };
  expect(complete(value)).toBe(JSON.stringify(value, null, 2));
  expect(JSON.parse(complete(value))).toEqual(value);
});
it('preserves plain-string display without constructing a serialized copy', () => {
  const value = 'first' + 'x'.repeat(MODEL_TURN_TEXT_PAGE_CHARS * 2) + 'last';
  expect(complete(value)).toBe(value);
});
it('handles deep JSON without recursive stack overflow', () => {
  let value: unknown = 'end';
  for (let i = 0; i < 15000; i++) value = [value];
  expect(modelTurnJsonPage(value, 0).text.length).toBe(MODEL_TURN_TEXT_PAGE_CHARS);
});
it('preserves ordinary archive JSON formatting and optional values', () => {
  const value = { a: [], b: {}, omitted: undefined, list: [null, true, 0, undefined], escaped: '\u0000' };
  expect(complete(value)).toBe(JSON.stringify(value, null, 2));
});
