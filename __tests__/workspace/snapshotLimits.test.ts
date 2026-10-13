import { getSnapshotLimits, SNAPSHOT_DEFAULT_LIMITS } from '@/backend/services/workspace/snapshotTransfer';

const names = ['FLUJO_SNAPSHOT_MAX_FILE_BYTES', 'FLUJO_SNAPSHOT_MAX_BYTES'] as const;
let previous: Array<string | undefined>;
beforeEach(() => {
  previous = names.map(name => process.env[name]);
  names.forEach(name => { delete process.env[name]; });
});
afterEach(() => names.forEach((name, index) => {
  if (previous[index] === undefined) delete process.env[name];
  else process.env[name] = previous[index];
}));

test('advertises exact defaults and padded encrypted wire bounds', () => {
  expect(getSnapshotLimits()).toEqual(SNAPSHOT_DEFAULT_LIMITS);
  for (const bytes of [1, 2, 3, 4, 101]) {
    process.env.FLUJO_SNAPSHOT_MAX_BYTES = String(bytes);
    process.env.FLUJO_SNAPSHOT_MAX_FILE_BYTES = '7';
    const limits = getSnapshotLimits();
    expect(limits.maxFileBytes).toBe(7);
    expect(limits.maxUncompressedBytes).toBe(bytes);
    expect(limits.maxArchiveBytes).toBe(bytes + 8 * 1024 * 1024);
    expect(limits.maxEncryptedBytes).toBe(Buffer.alloc(limits.maxArchiveBytes).toString('base64').length + 4096);
    expect(limits.maxMembers).toBe(65_534);
  }
});

test.each(['0', '-1', '4.5', '16KiB', 'NaN', 'Infinity', '', ' 7', '07', String(Number.MAX_SAFE_INTEGER)])(
  'fails closed for invalid or overflowing configured total bound %s', value => {
    process.env.FLUJO_SNAPSHOT_MAX_BYTES = value;
    expect(() => getSnapshotLimits()).toThrow('Snapshot limits are invalid');
  },
);
test.each(['0', '-1', '4.5', 'NaN', 'Infinity', '', ' 7', '07'])('fails closed for invalid member bound %s', value => {
  process.env.FLUJO_SNAPSHOT_MAX_FILE_BYTES = value;
  expect(() => getSnapshotLimits()).toThrow('Snapshot limits are invalid');
});
