import { boundedEventSnapshot } from '@/backend/execution/flow/engine/boundedEventSnapshot';

it.each([
  'ascii', '漢字🙂', '"\\\n\t\u0000\u001f', '\ud800', '\udc00', 'a\ud800b',
])('preserves JSON wire values and measures UTF-8 bytes for %p', value => {
  const input = { value };
  const snapshot = boundedEventSnapshot(input, 1024)!;
  expect(snapshot.json).toBe(JSON.stringify(input));
  expect(snapshot.utf8Bytes).toBe(Buffer.byteLength(snapshot.json, 'utf8'));
  expect(snapshot.utf8Bytes).toBeLessThanOrEqual(1024);
});

it('preserves data-only JSON omission, arrays and number normalization', () => {
  const input = {
    omitted: undefined,
    values: [undefined, null, true, false, -0, NaN, Infinity, 1e30],
  };
  expect(boundedEventSnapshot(input, 1024)?.json).toBe(JSON.stringify(input));
});

it('refuses a large scalar before JSON returns a complete serialized copy', () => {
  const input = { before: 'small', value: 'x'.repeat(1024 * 1024) };
  const stringify = jest.spyOn(JSON, 'stringify');
  try {
    expect(boundedEventSnapshot(input, 1024)).toBeUndefined();
    expect(stringify).not.toHaveBeenCalled();
  } finally {
    stringify.mockRestore();
  }
});

it('refuses oversized escaped strings, large property keys and array aggregates', () => {
  expect(boundedEventSnapshot({ value: '\u0000'.repeat(500) }, 1024)).toBeUndefined();
  expect(boundedEventSnapshot({ ['x'.repeat(2048)]: 1 }, 1024)).toBeUndefined();
  expect(boundedEventSnapshot(Array.from({ length: 1000 }, () => 'small'), 1024)).toBeUndefined();
});

it('does not retain cycles, BigInt or throwing getter output', () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  expect(boundedEventSnapshot(cycle, 1024)).toBeUndefined();
  expect(boundedEventSnapshot({ value: BigInt(1) }, 1024)).toBeUndefined();
  expect(boundedEventSnapshot({ get value() { throw new Error('uncacheable'); } }, 1024)).toBeUndefined();
});

it('refuses accessors, JSON hooks, proxies and custom prototypes without invoking callbacks', () => {
  const read = jest.fn(() => 'x'.repeat(2048));
  const convert = jest.fn(() => 'x'.repeat(2048));
  expect(boundedEventSnapshot({ get value() { return read(); } }, 1024)).toBeUndefined();
  expect(boundedEventSnapshot({ toJSON: convert }, 1024)).toBeUndefined();
  expect(read).not.toHaveBeenCalled();
  expect(convert).not.toHaveBeenCalled();
  const trap = jest.fn();
  expect(boundedEventSnapshot(new Proxy({}, { ownKeys: trap }), 1024)).toBeUndefined();
  expect(trap).not.toHaveBeenCalled();
  expect(boundedEventSnapshot(new Date('2026-10-05T00:00:00Z'), 1024)).toBeUndefined();
});

it('preserves repeated aliases, sparse arrays and data keys without prototype mutation', () => {
  const shared = { value: 'same' };
  const sparse = new Array<unknown>(3);
  sparse[0] = 1;
  sparse[2] = 3;
  const input = {
    aliases: [shared, shared],
    sparse,
    data: JSON.parse('{"__proto__":{"payload":"data"},"constructor":7}'),
  };
  const snapshot = boundedEventSnapshot(input, 1024)!;
  expect(snapshot.json).toBe(JSON.stringify(input));
  expect(JSON.parse(snapshot.json).data.__proto__.payload).toBe('data');
  expect(Object.getOwnPropertyDescriptor(Object.prototype, 'payload')).toBeUndefined();
});
