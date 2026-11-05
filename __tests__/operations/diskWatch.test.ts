import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  diskAlerts, growthPerDay, lowSpaceThreshold, measureDirectory, observeDisk, trimSamples, type DiskObservation,
} from '@/backend/services/operations/diskWatch';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const GIB = 1024 ** 3;

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-disk-'));
  (global as Record<string, unknown>).__flujo_disk_watch = undefined;
});
afterEach(async () => {
  await (global as { __flujo_disk_watch?: { measuring?: Promise<void> | null } }).__flujo_disk_watch?.measuring;
  (global as Record<string, unknown>).__flujo_disk_watch = undefined;
  await fs.rm(root, { recursive: true, force: true });
});

const observation = (patch: Partial<DiskObservation>): DiskObservation => ({
  freeBytes: 100 * GIB, totalBytes: 500 * GIB, lowThresholdBytes: 2 * GIB, dataBytes: GIB, dataMeasuredAt: null,
  dataMeasurementComplete: true, growthBytesPerDay: 0, growthWarnBytesPerDay: GIB, daysUntilFull: null, ...patch,
});

it('low space means the smaller of a size and a share of the disk', () => {
  expect(lowSpaceThreshold(500 * GIB, {})).toBe(2 * GIB);
  expect(lowSpaceThreshold(20 * GIB, {})).toBe(GIB);
  expect(lowSpaceThreshold(500 * GIB, { FLUJO_DISK_LOW_BYTES: String(10 * GIB), FLUJO_DISK_LOW_PERCENT: '50' })).toBe(10 * GIB);
  expect(lowSpaceThreshold(500 * GIB, { FLUJO_DISK_LOW_BYTES: 'lots', FLUJO_DISK_LOW_PERCENT: '500' })).toBe(2 * GIB);
  expect(lowSpaceThreshold(500 * GIB, { FLUJO_DISK_LOW_BYTES: '0' })).toBe(0);
});

it('alerts name low space and fast growth, and say so when space is unknown', () => {
  expect(diskAlerts(observation({}))).toEqual([]);
  expect(diskAlerts(observation({ freeBytes: GIB }))).toEqual([{ code: 'disk-space-low', severity: 'warning' }]);
  expect(diskAlerts(observation({ growthBytesPerDay: 2 * GIB }))).toEqual([{ code: 'data-growing-fast', severity: 'warning' }]);
  expect(diskAlerts(observation({ growthBytesPerDay: 2 * GIB, growthWarnBytesPerDay: 0 }))).toEqual([]);
  expect(diskAlerts(observation({ freeBytes: null }))).toEqual([{ code: 'disk-space-unknown', severity: 'info' }]);
});

it('growth needs enough time to mean anything, and ignores old samples', () => {
  const now = 100 * DAY;
  expect(growthPerDay([], now)).toBeNull();
  expect(growthPerDay([{ at: now - HOUR, bytes: 0 }, { at: now, bytes: GIB }], now)).toBeNull();
  expect(growthPerDay([{ at: now - DAY, bytes: 0 }, { at: now, bytes: GIB }], now)).toBe(GIB);
  expect(growthPerDay([{ at: now - 30 * DAY, bytes: 0 }, { at: now - DAY, bytes: 5 * GIB }, { at: now, bytes: 5 * GIB }], now)).toBe(0);
  expect(growthPerDay([{ at: now - DAY, bytes: GIB }, { at: now, bytes: 0 }], now)).toBe(-GIB);
});

it('samples stay few, and keep both ends of the week', () => {
  const now = 100 * DAY;
  const many = Array.from({ length: 500 }, (_, index) => ({ at: now - index * 1000, bytes: index }));
  const kept = trimSamples(many, now);
  expect(kept).toHaveLength(48);
  expect(kept[0].at).toBe(now - 499 * 1000);
  expect(kept[47].at).toBe(now);
  expect(trimSamples([{ at: now - 8 * DAY, bytes: 1 }], now)).toEqual([]);
});

it('measures a real folder, and stops at its limits rather than running on', async () => {
  await fs.mkdir(path.join(root, 'a', 'b'), { recursive: true });
  await fs.writeFile(path.join(root, 'one.txt'), 'x'.repeat(10));
  await fs.writeFile(path.join(root, 'a', 'b', 'two.txt'), 'y'.repeat(20));
  expect(await measureDirectory(root)).toEqual({ bytes: 30, complete: true });
  expect((await measureDirectory(root, { maxEntries: 1 })).complete).toBe(false);
  expect((await measureDirectory(root, { maxMs: -1 })).complete).toBe(false);
  expect(await measureDirectory(path.join(root, 'missing'))).toEqual({ bytes: 0, complete: true });
});

it('never makes a status request wait, keeps samples across restarts, and reports real free space', async () => {
  await fs.writeFile(path.join(root, 'data.bin'), Buffer.alloc(1000));
  let clock = 1000 * DAY;
  const first = await observeDisk(root, { now: () => clock });
  expect(first.freeBytes).toBeGreaterThan(0);
  expect(first.totalBytes).toBeGreaterThan(0);
  const state = (global as { __flujo_disk_watch?: { measuring?: Promise<void> | null } }).__flujo_disk_watch;
  await state?.measuring;
  const second = await observeDisk(root, { now: () => clock });
  expect(second.dataBytes).toBe(1000);
  expect(second.dataMeasurementComplete).toBe(true);
  await (global as { __flujo_disk_watch?: { measuring?: Promise<void> | null } }).__flujo_disk_watch?.measuring;

  // A new process, a day later, with more data: the old sample is still there.
  (global as Record<string, unknown>).__flujo_disk_watch = undefined;
  await fs.writeFile(path.join(root, 'more.bin'), Buffer.alloc(5000));
  clock += DAY;
  await observeDisk(root, { now: () => clock });
  await (global as { __flujo_disk_watch?: { measuring?: Promise<void> | null } }).__flujo_disk_watch?.measuring;
  const third = await observeDisk(root, { now: () => clock });
  expect(third.growthBytesPerDay).toBeGreaterThanOrEqual(5000);
});

it('free space that cannot be read is reported as unknown, not as zero', async () => {
  const seen = await observeDisk(root, { statfs: (async () => { throw new Error('no'); }) as never });
  expect(seen.freeBytes).toBeNull();
  expect(seen.lowThresholdBytes).toBeNull();
});
