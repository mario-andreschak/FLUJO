/**
 * Warns before a small PC runs out of disk. It only observes: nothing is deleted.
 *
 * Reading free space is cheap and done on every status request. Measuring the data
 * directory is not, so that happens at most once an hour, in the background, in small
 * steps that leave the event loop free, and it gives up after a fixed amount of work.
 * A status request never waits for it.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '@/utils/storage/backend';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const GIB = 1024 ** 3;
const DEFAULT_LOW_BYTES = 2 * GIB;
const DEFAULT_LOW_PERCENT = 5;
const DEFAULT_GROWTH_BYTES_PER_DAY = GIB;
const MEASURE_INTERVAL_MS = HOUR_MS;
const MEASURE_MAX_ENTRIES = 500_000;
const MEASURE_MAX_MS = 5 * 60 * 1000;
const BATCH = 64;
/** Growth needs a span long enough that one big import does not read as a trend. */
const GROWTH_MIN_SPAN_MS = 6 * HOUR_MS;
const SAMPLE_WINDOW_MS = 7 * DAY_MS;
const MAX_SAMPLES = 48;
const SAMPLES_FILE = '.operations-disk-samples.json';

export interface DiskSample { at: number; bytes: number }

export interface DiskObservation {
  freeBytes: number | null;
  totalBytes: number | null;
  lowThresholdBytes: number | null;
  dataBytes: number | null;
  dataMeasuredAt: string | null;
  dataMeasurementComplete: boolean | null;
  growthBytesPerDay: number | null;
  growthWarnBytesPerDay: number;
  /** Rough, from recent growth. Null while there is no growth to go on. */
  daysUntilFull: number | null;
}

function setting(value: string | undefined, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= maximum ? parsed : fallback;
}

/** The smaller of a size and a percentage of the disk, so large disks do not warn early. */
export function lowSpaceThreshold(totalBytes: number, env: NodeJS.ProcessEnv = process.env): number {
  const bytes = setting(env.FLUJO_DISK_LOW_BYTES, DEFAULT_LOW_BYTES);
  const percent = setting(env.FLUJO_DISK_LOW_PERCENT, DEFAULT_LOW_PERCENT, 100);
  return Math.min(bytes, Math.floor(totalBytes * percent / 100));
}

/** Growth per day between the newest sample and the oldest one that is recent enough. */
export function growthPerDay(samples: readonly DiskSample[], now: number): number | null {
  const recent = samples.filter(sample => now - sample.at <= SAMPLE_WINDOW_MS).sort((a, b) => a.at - b.at);
  if (recent.length < 2) return null;
  const oldest = recent[0];
  const newest = recent[recent.length - 1];
  const span = newest.at - oldest.at;
  if (span < GROWTH_MIN_SPAN_MS) return null;
  return Math.round((newest.bytes - oldest.bytes) / span * DAY_MS);
}

/** Thin out evenly when full, so a week of history always fits in a small file. */
export function trimSamples(samples: readonly DiskSample[], now: number): DiskSample[] {
  const recent = samples.filter(sample => now - sample.at <= SAMPLE_WINDOW_MS).sort((a, b) => a.at - b.at);
  if (recent.length <= MAX_SAMPLES) return recent;
  const step = (recent.length - 1) / (MAX_SAMPLES - 1);
  return Array.from({ length: MAX_SAMPLES }, (_, index) => recent[Math.round(index * step)]);
}

/** Bounded walk. Links are not followed, so nothing is counted twice or outside the root. */
export async function measureDirectory(root: string, {
  maxEntries = MEASURE_MAX_ENTRIES, maxMs = MEASURE_MAX_MS,
}: { maxEntries?: number; maxMs?: number } = {}): Promise<{ bytes: number; complete: boolean }> {
  const deadline = Date.now() + maxMs;
  const stack = [root];
  let bytes = 0;
  let entries = 0;
  while (stack.length) {
    if (entries >= maxEntries || Date.now() > deadline) return { bytes, complete: false };
    const directory = stack.pop()!;
    let names;
    try { names = await fs.readdir(directory, { withFileTypes: true }); }
    catch { continue; }
    for (let index = 0; index < names.length; index += BATCH) {
      const batch = names.slice(index, index + BATCH);
      entries += batch.length;
      const sizes = await Promise.all(batch.map(async entry => {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          return 0;
        }
        if (!entry.isFile()) return 0;
        try { return (await fs.stat(full)).size; }
        catch { return 0; }
      }));
      for (const size of sizes) bytes += size;
      if (entries >= maxEntries || Date.now() > deadline) return { bytes, complete: false };
    }
  }
  return { bytes, complete: true };
}

interface WatchState {
  root: string;
  samples: DiskSample[];
  loaded: boolean;
  lastMeasured: { at: number; bytes: number; complete: boolean } | null;
  measuring: Promise<void> | null;
}

declare global {
  var __flujo_disk_watch: WatchState | undefined;
}

function watchState(root: string): WatchState {
  const current = global.__flujo_disk_watch;
  if (current?.root === root) return current;
  const created: WatchState = { root, samples: [], loaded: false, lastMeasured: null, measuring: null };
  global.__flujo_disk_watch = created;
  return created;
}

async function loadSamples(state: WatchState): Promise<void> {
  if (state.loaded) return;
  state.loaded = true;
  try {
    const stored = JSON.parse(await fs.readFile(path.join(state.root, SAMPLES_FILE), 'utf8'));
    if (Array.isArray(stored?.samples)) {
      state.samples = stored.samples.filter((sample: DiskSample) => Number.isSafeInteger(sample?.at) && Number.isSafeInteger(sample?.bytes));
      const last = state.samples[state.samples.length - 1];
      if (last) state.lastMeasured = { at: last.at, bytes: last.bytes, complete: true };
    }
  } catch { /* First run, or an unreadable file: start again. */ }
}

async function refresh(state: WatchState, now: () => number): Promise<void> {
  await loadSamples(state);
  if (state.lastMeasured && now() - state.lastMeasured.at < MEASURE_INTERVAL_MS) return;
  const measured = await measureDirectory(state.root);
  const at = now();
  state.lastMeasured = { at, ...measured };
  // A partial measurement would read as data shrinking, so it is not kept for trends.
  if (!measured.complete) return;
  state.samples = trimSamples([...state.samples, { at, bytes: measured.bytes }], at);
  await writeFileAtomic(path.join(state.root, SAMPLES_FILE), JSON.stringify({ samples: state.samples })).catch(() => undefined);
}

/** Returns what is known now and starts a new measurement if one is due. */
export async function observeDisk(root: string, {
  env = process.env, now = () => Date.now(), statfs = fs.statfs,
}: { env?: NodeJS.ProcessEnv; now?: () => number; statfs?: typeof fs.statfs } = {}): Promise<DiskObservation> {
  const state = watchState(root);
  state.measuring ??= refresh(state, now).catch(() => undefined).finally(() => { state.measuring = null; });
  let freeBytes: number | null = null;
  let totalBytes: number | null = null;
  try {
    const space = await statfs(root);
    freeBytes = Number(space.bavail) * Number(space.bsize);
    totalBytes = Number(space.blocks) * Number(space.bsize);
  } catch { /* Reported as unknown, and the caller says so. */ }
  const growth = growthPerDay(state.samples, now());
  return {
    freeBytes,
    totalBytes,
    lowThresholdBytes: totalBytes === null ? null : lowSpaceThreshold(totalBytes, env),
    dataBytes: state.lastMeasured?.bytes ?? null,
    dataMeasuredAt: state.lastMeasured ? new Date(state.lastMeasured.at).toISOString() : null,
    dataMeasurementComplete: state.lastMeasured?.complete ?? null,
    growthBytesPerDay: growth,
    growthWarnBytesPerDay: setting(env.FLUJO_DATA_GROWTH_WARN_BYTES_PER_DAY, DEFAULT_GROWTH_BYTES_PER_DAY),
    daysUntilFull: growth !== null && growth > 0 && freeBytes !== null ? Math.floor(freeBytes / growth) : null,
  };
}

export function diskAlerts(disk: DiskObservation): Array<{ code: string; severity: 'info' | 'warning' }> {
  const alerts: Array<{ code: string; severity: 'info' | 'warning' }> = [];
  if (disk.freeBytes === null) alerts.push({ code: 'disk-space-unknown', severity: 'info' });
  else if (disk.lowThresholdBytes !== null && disk.freeBytes < disk.lowThresholdBytes) alerts.push({ code: 'disk-space-low', severity: 'warning' });
  if (disk.growthBytesPerDay !== null && disk.growthWarnBytesPerDay > 0 && disk.growthBytesPerDay >= disk.growthWarnBytesPerDay) {
    alerts.push({ code: 'data-growing-fast', severity: 'warning' });
  }
  return alerts;
}
