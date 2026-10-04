import { readFileSync } from 'node:fs';
import path from 'node:path';
import { encryptedSnapshotSizeLimit, getSnapshotLimits } from '@/backend/services/workspace/snapshotLimits';

const names = ['FLUJO_SNAPSHOT_MAX_FILE_BYTES', 'FLUJO_SNAPSHOT_MAX_BYTES'] as const;
let previous: Array<string | undefined>;
beforeEach(() => { previous = names.map(name => process.env[name]); names.forEach(name => { delete process.env[name]; }); });
afterEach(() => names.forEach((name, index) => {
  if (previous[index] === undefined) delete process.env[name];
  else process.env[name] = previous[index];
}));

test('configured limits describe plaintext, ZIP and padded encrypted wire separately', () => {
  process.env.FLUJO_SNAPSHOT_MAX_FILE_BYTES = '7';
  process.env.FLUJO_SNAPSHOT_MAX_BYTES = '101';
  const limits = getSnapshotLimits();
  expect(limits).toMatchObject({ maxFileBytes: 7, maxUncompressedBytes: 101, maxMembers: 65_534 });
  expect(limits.maxArchiveBytes).toBe(101 + 8 * 1024 * 1024);
  expect(limits.maxEncryptedBytes).toBe(4 * Math.ceil(limits.maxArchiveBytes / 3) + 4096);
  for (const bytes of [0, 1, 2, 3, 4, 101]) {
    expect(encryptedSnapshotSizeLimit(bytes)).toBe(Buffer.alloc(bytes).toString('base64').length + 4096);
  }
});

test('official worker image labels carry the actual native default restore bounds', () => {
  const dockerfile = readFileSync(path.join(process.cwd(), 'Dockerfile'), 'utf8');
  const label = dockerfile.match(/io\.flujo\.worker\.snapshot\.restore\.limits='([^']+)'/);
  expect(label).not.toBeNull();
  expect(JSON.parse(label![1])).toEqual(getSnapshotLimits());
  Object.values(JSON.parse(label![1])).forEach(value => {
    expect(Number.isSafeInteger(value)).toBe(true);
    expect(value).toBeGreaterThan(0);
  });
});

test.each(['0', '-1', '4.5', '16KiB', 'NaN', 'Infinity'])('uses the same defaults for invalid configured limit %s', value => {
  process.env.FLUJO_SNAPSHOT_MAX_BYTES = value;
  process.env.FLUJO_SNAPSHOT_MAX_FILE_BYTES = value;
  expect(getSnapshotLimits()).toMatchObject({ maxFileBytes: 256 * 1024 * 1024, maxUncompressedBytes: 1024 * 1024 * 1024 });
});

test.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])('refuses invalid or overflowing encrypted bounds %s', value => {
  expect(() => encryptedSnapshotSizeLimit(value)).toThrow('Snapshot limits configuration is invalid.');
});

test('refuses overflowing configuration before it can be advertised or used', () => {
  process.env.FLUJO_SNAPSHOT_MAX_BYTES = String(Number.MAX_SAFE_INTEGER);
  expect(() => getSnapshotLimits()).toThrow('Snapshot limits configuration is invalid.');
});
