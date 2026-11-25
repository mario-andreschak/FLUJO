/**
 * How much disk a browser recording may use (#1390).
 *
 * Video frames go from Chromium straight into Patchright's encoder, which
 * writes the WebM file as it goes, and page audio is appended to a WAV file as
 * it arrives. A recording's memory use therefore stays flat however long it
 * runs; only its files grow. That is why the recording limit follows the free
 * space on the disks a recording writes to instead of a fixed number of
 * minutes, and why it heals by itself as soon as space is freed.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

type FrameSize = { width: number; height: number };

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** Page audio from the tap is stored as 48 kHz, two-channel, 16-bit WAV. */
export const AUDIO_BYTES_PER_MS = (48_000 * 2 * 2) / 1_000;

/**
 * Patchright caps its VP9 bitrate at 1 Mbit/s per 800x450 frame area at 25
 * frames per second. Real files are usually much smaller; the extra quarter
 * covers short bursts above the cap.
 */
const ENCODER_HEADROOM = 1.25;

/**
 * Right before a recording finishes, its video can exist three times: the
 * encoder's own file, the copy in the recordings folder, and a muxed or
 * converted copy.
 */
const VIDEO_COPIES_AT_FINISH = 3;

/** Copies still to be written once the encoder's file exists. */
const VIDEO_COPIES_STILL_TO_WRITE = VIDEO_COPIES_AT_FINISH - 1;

export type DiskSpace = { path: string; freeBytes: number; totalBytes: number };

export type RecordingDiskBudget = {
  /** How long a recording can run before the disk gets too full; null when free space could not be read. */
  maxDurationMs: number | null;
  /** The folder with the least room left, which sets the limit. */
  path: string | null;
  freeBytes: number | null;
  /** Space every recording leaves free so the computer keeps working. */
  keepFreeBytes: number | null;
  /** Expected file growth per minute at this size (upper bound). */
  estimatedBytesPerMinute: number;
};

export type LowDisk = { path: string; freeBytes: number; keepFreeBytes: number; finishBytes: number };

/** Free and total bytes for the disk holding `dir`, or the nearest folder above it that exists. */
export async function readDiskSpace(dir: string): Promise<DiskSpace | undefined> {
  const target = path.resolve(dir);
  let current = target;
  for (;;) {
    try {
      const stats = await fs.statfs(current);
      return { path: target, freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize };
    } catch (error) {
      const parent = path.dirname(current);
      if (parent === current || (error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') return undefined;
      current = parent;
    }
  }
}

/** Space a recording always leaves free: 2% of the disk, at least 256 MiB and at most 2 GiB. */
export function keepFreeBytes(totalBytes: number): number {
  return Math.min(2 * GIB, Math.max(256 * MIB, Math.round(totalBytes * 0.02)));
}

/** Upper bound of the video bytes Patchright writes per millisecond at this frame size. */
export function videoBytesPerMs(size: FrameSize): number {
  const pixelRateScale = Math.max(1, (size.width * size.height) / (800 * 450));
  const kilobitsPerSecond = Math.round(pixelRateScale * 1_000) * ENCODER_HEADROOM;
  return kilobitsPerSecond / 8;
}

function uniqueFolders(dirs: string[]): string[] {
  return [...new Set(dirs.map((dir) => path.resolve(dir)))];
}

/** How long a recording of this size fits on the disks it writes to, measured now. */
export async function recordingDiskBudget(dirs: string[], size: FrameSize, audio: boolean): Promise<RecordingDiskBudget> {
  const videoPerMs = videoBytesPerMs(size);
  const audioPerMs = audio ? AUDIO_BYTES_PER_MS : 0;
  const neededPerMs = videoPerMs * VIDEO_COPIES_AT_FINISH + audioPerMs;
  const estimatedBytesPerMinute = Math.round((videoPerMs + audioPerMs) * 60_000);
  let tightest: { space: DiskSpace; usable: number; keep: number } | undefined;
  for (const dir of uniqueFolders(dirs)) {
    const space = await readDiskSpace(dir);
    if (!space) continue;
    const keep = keepFreeBytes(space.totalBytes);
    const usable = Math.max(0, space.freeBytes - keep);
    if (!tightest || usable < tightest.usable) tightest = { space, usable, keep };
  }
  if (!tightest) {
    return { maxDurationMs: null, path: null, freeBytes: null, keepFreeBytes: null, estimatedBytesPerMinute };
  }
  return {
    maxDurationMs: Math.floor(tightest.usable / neededPerMs),
    path: tightest.space.path,
    freeBytes: tightest.space.freeBytes,
    keepFreeBytes: tightest.keep,
    estimatedBytesPerMinute,
  };
}

/** Free bytes per folder, taken when a recording starts. */
export async function diskBaseline(dirs: string[]): Promise<Map<string, number>> {
  const baseline = new Map<string, number>();
  for (const dir of uniqueFolders(dirs)) {
    const space = await readDiskSpace(dir);
    if (space) baseline.set(space.path, space.freeBytes);
  }
  return baseline;
}

/**
 * Whether a running recording must stop now to leave the disk usable.
 *
 * It stops once free space drops below the space every recording leaves free
 * plus the room still needed to save what was recorded. That room is the
 * smaller of the bitrate estimate and the space actually used since the
 * recording started, so a quiet page that compresses well can run longer.
 */
export async function checkLowDisk(baseline: Map<string, number>, elapsedMs: number, size: FrameSize): Promise<LowDisk | undefined> {
  const recordedEstimate = elapsedMs * videoBytesPerMs(size);
  for (const [dir, startFree] of baseline) {
    const space = await readDiskSpace(dir);
    if (!space) continue;
    const keep = keepFreeBytes(space.totalBytes);
    const usedSinceStart = Math.max(0, startFree - space.freeBytes);
    const finishBytes = Math.round(VIDEO_COPIES_STILL_TO_WRITE * Math.min(recordedEstimate, usedSinceStart));
    if (space.freeBytes < keep + finishBytes) {
      return { path: space.path, freeBytes: space.freeBytes, keepFreeBytes: keep, finishBytes };
    }
  }
  return undefined;
}

export function formatBytes(bytes: number): string {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)} GB`;
  return `${Math.max(0, Math.round(bytes / MIB))} MB`;
}

export function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return `${Math.max(0, Math.round(ms / 1_000))} seconds`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const minuteText = `${minutes} minute${minutes === 1 ? '' : 's'}`;
  if (hours === 0) return minuteText;
  const hourText = `${hours} hour${hours === 1 ? '' : 's'}`;
  return minutes === 0 ? hourText : `${hourText} ${minuteText}`;
}
