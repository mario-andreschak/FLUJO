/**
 * `browser_record_start` / `browser_record_stop` / `browser_record_status`
 * (#366) — screen recording with optional audio, per the owner's direction:
 * "a screenrecord functionality (with audio; start, stop or start with ms
 * parameter)".
 *
 * Design (plan §Phase 3, decision D6, and #1390):
 *  - **Video** uses Patchright's page screencast recorder (WebM). Frames go
 *    from Chromium straight into the encoder, which writes the file as it
 *    goes, so memory use stays flat however long a recording runs. A new
 *    recording gets its own dedicated context and page, registered in the
 *    ordinary session map, so the caller can drive it with `browser_navigate`/
 *    `browser_click`/etc. between `record_start` and `record_stop`.
 *  - **Segments**: stopping finalises the video without closing the page, so
 *    the page keeps its state. `browser_record_start` with that `sessionId`
 *    records the next segment on the same page; `closeSession: true` on stop
 *    closes it.
 *  - **Open pages**: `browser_record_start` with the `sessionId` of a
 *    `browser_open` session borrows that page. The screencast attaches to the
 *    live page, so nothing reloads and its state is kept. While a part records,
 *    the page size is fixed (resized without reloading only when the video
 *    needs another size); afterwards the page gets its own size and resizable
 *    viewport back and stays open.
 *  - **Duration**: there is no fixed time limit. The limit follows free disk
 *    space (`recordingDisk.ts`), is reported up front, and a running recording
 *    stops early only when the disk is actually running low.
 *  - **Audio** reuses `audioTap.ts`'s in-page tap, driven over its own CDP
 *    session, appended to a WAV file on disk while recording. The tap is
 *    shared with the live view; the recording's listener is switched on only
 *    while a part records.
 *  - **Muxing** is opt-in and never required: if an `ffmpeg` binary is
 *    discoverable (`FLUJO_FFMPEG_PATH` or PATH), video+audio are combined with
 *    an argv-array `ffmpeg` invocation; otherwise both artifacts are returned
 *    separately with `muxed: false`. Nothing is ever downloaded or installed.
 */
import { createWriteStream, promises as fs, type WriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { Browser, BrowserContext, CDPSession, Disposable, Page } from 'patchright';
import {
  getDataDir,
  isInside,
  navigateCaptureSource,
  normalizeResolution,
  resolutionFallbacks,
  resolveCaptureSource,
  type Resolution,
} from './capture.js';
import {
  AUDIO_TAP_PRESENT_EXPRESSION,
  audioSinkMutedExpression,
  audioTapSource,
  evaluateInMainWorlds,
  trackMainWorlds,
} from './audioTap.js';
import {
  checkLowDisk,
  diskBaseline,
  formatBytes,
  formatDuration,
  recordingDiskBudget,
  type RecordingDiskBudget,
} from './recordingDisk.js';
import {
  BrowserMcpError,
  acquireBrowser,
  defaultViewport,
  effectiveBrowserOwnerScope,
  closeSession,
  closeSessionObject,
  getSession,
  integerEnv,
  installRequestPolicy,
  listSessions,
  recordingRoot,
  registerSession,
  releaseSessionReservation,
  reserveSession,
  type BrowserSession,
} from './runtime.js';

const MAX_CONCURRENT_RECORDINGS = 2;
/** The longest delay a Node.js timer can wait (about 24.8 days). */
const MAX_TIMER_MS = 2_147_483_647;
const MIN_DURATION_MS = 250;
/** ffmpeg gets at least this long, or as long as the recording itself if that is longer. */
const FFMPEG_MIN_TIMEOUT_MS = 60_000;
const DISK_CHECK_INTERVAL_MS = 5_000;
/** A WAV file stores its length in 32 bits, so its audio data stays below 4 GiB (about six hours). */
const WAV_MAX_DATA_BYTES = 0xffff_ffff - 36;
const AUDIO_BINDING_PREFIX = '__flujoRecordAudio_';
const COMPLETED_RECORDING_TTL_MS = 30 * 60_000;
const MAX_COMPLETED_RECORDINGS = 16;

type StopReason = 'requested' | 'auto-stop' | 'low-disk' | 'session-closed' | 'shutdown';

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** The encoder's own temporary video file, through Patchright's public Artifact methods. */
type EncoderArtifact = {
  saveAs(destination: string): Promise<void>;
  pathAfterFinished(): Promise<string>;
  delete(): Promise<void>;
};

type Geometry = {
  requestedResolution: Resolution;
  effectiveResolution: Resolution;
  actualViewport: Resolution;
  deviceScaleFactor: number;
};

/** The session settings a part changes on a borrowed `browser_open` page, put back when the part ends. */
type PageSettings = Pick<BrowserSession, 'viewportPolicy' | 'configuredViewport' | 'configuredVideoResolution' | 'deviceScaleFactor'>;

type BorrowedPage = {
  settings: PageSettings;
  /** The page size before this part resized the page to record it exactly. */
  restoreViewport?: Resolution;
};

/** The recording's listener on the page audio tap, connected once per recording session. */
type AudioTap = { cdp: CDPSession; binding: string; mainWorlds: Set<number> };

/** One recording browser session; it outlives its segments unless asked to close. */
type RecordingSession = Geometry & {
  sessionId: string;
  ownerScope: string;
  session: BrowserSession;
  context: BrowserContext;
  page: Page;
  audioTap?: AudioTap;
  setupAttempts: string[];
  active?: RecordingState;
  /** Settles when the part being set up on this session has started (or failed to). */
  starting?: Promise<void>;
  segmentCount: number;
  closed: boolean;
  /** Set when the session was opened with browser_open and recording borrows its page. */
  borrowed?: BorrowedPage;
};

type AudioWriter = { path: string; stream: WriteStream; rate: number };

/** One recorded segment (one video file). */
type RecordingState = {
  id: string;
  sessionId: string;
  ownerScope: string;
  owner: RecordingSession;
  segment: number;
  startedAt: number;
  audio: boolean;
  /** The init script that switches the recording's audio listener on in pages loaded during this part. */
  audioOn?: Disposable;
  audioWriter?: AudioWriter;
  audioBytes: number;
  audioFull: boolean;
  videoDest: string;
  artifact?: EncoderArtifact;
  outputPath?: string;
  stopping: boolean;
  stopReason?: StopReason;
  durationMs?: number;
  autoStopAt?: number;
  durationTimer?: ReturnType<typeof setTimeout>;
  diskTimer?: ReturnType<typeof setInterval>;
  diskChecking: boolean;
  diskBaseline: Map<string, number>;
  disk: RecordingDiskBudget;
  lastFreeBytes?: number;
  done: Deferred<Record<string, unknown>>;
  warnings: string[];
};

type CompletedRecording = {
  result: Record<string, unknown>;
  completedAt: number;
  ownerScope: string;
  sessionId: string;
};

const recordingSessions = new Map<string, RecordingSession>();
const recordings = new Map<string, RecordingState>();
const recordingReservations = new Set<string>();
const finalizingRecordings = new Map<string, RecordingState>();
const completedRecordings = new Map<string, CompletedRecording>();
const latestCompletedIds = new Map<string, string>();

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

function wavHeader(dataLength: number, sampleRate: number, channels: number, bitsPerSample: number): Buffer {
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const buffer = Buffer.alloc(44);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataLength, 40);
  return buffer;
}

function recordingFolders(): string[] {
  return [recordingRoot(), os.tmpdir()];
}

/** Append one tapped PCM chunk to the segment's WAV file. */
function acceptAudioChunk(state: RecordingState, payload: string): void {
  if (state.audioFull) return;
  let parsed: { rate?: unknown; pcm?: unknown };
  try {
    parsed = JSON.parse(payload) as { rate?: unknown; pcm?: unknown };
  } catch {
    return;
  }
  if (typeof parsed.rate !== 'number' || typeof parsed.pcm !== 'string') return;
  const chunk = Buffer.from(parsed.pcm, 'base64');
  if (state.audioBytes + chunk.length > WAV_MAX_DATA_BYTES) {
    state.audioFull = true;
    state.warnings.push(`The audio track ends after ${formatDuration(Date.now() - state.startedAt)} because a WAV file cannot hold more than 4 GB. The video keeps recording.`);
    return;
  }
  if (!state.audioWriter) {
    const rate = Math.trunc(parsed.rate);
    const destination = path.join(recordingRoot(), `${state.id}.wav`);
    const stream = createWriteStream(destination);
    stream.on('error', () => undefined);
    // Until the recording stops, the header claims the largest size, which
    // players read as "stream until the end of the file".
    stream.write(wavHeader(WAV_MAX_DATA_BYTES, rate, 2, 16));
    state.audioWriter = { path: destination, stream, rate };
  }
  state.audioWriter.stream.write(chunk);
  state.audioBytes += chunk.length;
}

/** Close the WAV file and write its real length into the header. */
async function finishAudio(state: RecordingState): Promise<string | undefined> {
  const writer = state.audioWriter;
  if (!writer) return undefined;
  state.audioWriter = undefined;
  writer.stream.end();
  await finished(writer.stream);
  const handle = await fs.open(writer.path, 'r+');
  try {
    await handle.write(wavHeader(state.audioBytes, writer.rate, 2, 16), 0, 44, 0);
  } finally {
    await handle.close();
  }
  return writer.path;
}

async function discardAudio(state: RecordingState): Promise<void> {
  const writer = state.audioWriter;
  if (!writer) return;
  state.audioWriter = undefined;
  writer.stream.end();
  await finished(writer.stream).catch(() => undefined);
  await fs.rm(writer.path, { force: true }).catch(() => undefined);
}

/** Connect the recording's listener to the page audio tap once per recording session; chunks go to the part that is recording. */
async function ensureAudioTap(owner: RecordingSession, warnings: string[]): Promise<AudioTap> {
  if (owner.audioTap) return owner.audioTap;
  const cdp = await owner.context.newCDPSession(owner.page);
  const binding = `${AUDIO_BINDING_PREFIX}${owner.sessionId.replace(/[^A-Za-z0-9]/g, '')}`;
  const mainWorlds = new Set<number>();
  trackMainWorlds(cdp, mainWorlds);
  cdp.on('Runtime.bindingCalled', (event) => {
    if (event.name !== binding) return;
    const state = owner.active;
    if (!state || !state.audio || state.stopping) return;
    acceptAudioChunk(state, event.payload);
  });
  try {
    await cdp.send('Runtime.enable');
    await cdp.send('Runtime.addBinding', { name: binding });
    if (owner.borrowed) {
      const present = await cdp.send('Runtime.evaluate', { expression: AUDIO_TAP_PRESENT_EXPRESSION, returnByValue: true });
      if (present.result.value !== true) {
        warnings.push(
          'If this page started sound with Web Audio before the recording began, that sound is missing from the audio track: FLUJO\'s audio hook was not on the page yet because the live view is turned off. '
          + 'Audio and video elements, and any sound started from now on, are recorded. Start that sound again to include it.',
        );
      }
    }
    // Page.addInitScript is the durable main-world hook; a CDP-only install
    // can stay behind in about:blank's context when the real page loads. It
    // runs before every later navigation with this listener switched off, so
    // sound a page sets up between parts is still heard in the next part.
    await owner.page.addInitScript({ content: audioTapSource(binding, true) });
    const tap: AudioTap = { cdp, binding, mainWorlds };
    owner.audioTap = tap;
    return tap;
  } catch (error) {
    await cdp.detach().catch(() => undefined);
    throw error;
  }
}

/** Switch the recording's audio listener on for this part, including pages it loads. */
async function startSegmentAudio(state: RecordingState): Promise<void> {
  if (!state.audio) return;
  try {
    const tap = await ensureAudioTap(state.owner, state.warnings);
    const on = audioTapSource(tap.binding, false);
    state.audioOn = await state.owner.page.addInitScript({ content: on });
    if (await evaluateInMainWorlds(tap.cdp, tap.mainWorlds, on) === 0) {
      throw new Error('Chromium rejected the recording audio initialization script.');
    }
    // A stop that arrived while the listener was being switched on found nothing to switch off.
    if (state.stopping) await stopSegmentAudio(state);
  } catch (error) {
    state.audio = false;
    await stopSegmentAudio(state);
    state.warnings.push(`Audio capture could not initialize; video recording continues without audio (${errorText(error)}).`);
  }
}

/** Switch the listener off again, so the page stops sending sound nobody records. */
async function stopSegmentAudio(state: RecordingState): Promise<void> {
  const on = state.audioOn;
  state.audioOn = undefined;
  await on?.dispose().catch(() => undefined);
  const tap = state.owner.audioTap;
  if (!tap || state.owner.page.isClosed()) return;
  await evaluateInMainWorlds(tap.cdp, tap.mainWorlds, audioSinkMutedExpression(tap.binding, true));
}

async function resolveFfmpeg(): Promise<string | undefined> {
  const configured = process.env.FLUJO_FFMPEG_PATH?.trim();
  if (configured) {
    try {
      await fs.access(configured);
      return configured;
    } catch {
      return undefined;
    }
  }
  return new Promise((resolve) => {
    let probe;
    try {
      probe = spawn(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg']);
    } catch {
      resolve(undefined);
      return;
    }
    let out = '';
    probe.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    probe.on('error', () => resolve(undefined));
    probe.on('close', (code) => {
      if (code !== 0) {
        resolve(undefined);
        return;
      }
      const first = out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];
      resolve(first || 'ffmpeg');
    });
  });
}

function ffmpegTimeoutMs(recordedMs: number): number {
  return Math.max(FFMPEG_MIN_TIMEOUT_MS, recordedMs);
}

/** Argv array only; every path here is server-generated (never a caller string), so there is nothing to interpolate. */
function runFfmpeg(ffmpeg: string, args: string[], timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(ffmpeg, args, { stdio: 'ignore' });
    } catch (error) {
      reject(error);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ffmpeg did not finish within ${formatDuration(timeout)}.`));
    }, timeout);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}.`));
    });
  });
}

function runFfmpegMux(ffmpeg: string, videoPath: string, audioPath: string, dest: string, timeout: number): Promise<void> {
  return runFfmpeg(ffmpeg, ['-y', '-i', videoPath, '-i', audioPath, '-c:v', 'copy', '-c:a', 'libopus', '-shortest', dest], timeout);
}

function runFfmpegTranscode(ffmpeg: string, source: string, dest: string, timeout: number): Promise<void> {
  const extension = path.extname(dest).toLowerCase();
  const codecArgs = extension === '.mp4' || extension === '.mov'
    ? ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart']
    : ['-c:v', 'copy', '-c:a', 'libopus'];
  return runFfmpeg(ffmpeg, ['-y', '-i', source, ...codecArgs, dest], timeout);
}

async function confineOutputPath(outputPath: string): Promise<string> {
  const resolved = path.resolve(outputPath);
  const root = recordingRoot();
  const dataDir = getDataDir();
  if (!isInside(root, resolved) && !isInside(dataDir, resolved)) {
    throw new BrowserMcpError('INVALID_ARGUMENT', 'outputPath must be inside the FLUJO data directory or the browser recording root.');
  }
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  return resolved;
}

function requestedId(args: { recordingId?: unknown; sessionId?: unknown }): { recordingId?: string; sessionId?: string } {
  return {
    recordingId: typeof args.recordingId === 'string' && args.recordingId ? args.recordingId : undefined,
    sessionId: typeof args.sessionId === 'string' && args.sessionId ? args.sessionId : undefined,
  };
}

function findActive(id: string): RecordingState | undefined {
  return recordings.get(id) ?? [...recordings.values()].find((state) => state.sessionId === id);
}

function resolveRecordingState(
  args: { recordingId?: unknown; sessionId?: unknown },
  allowMissing: boolean,
  ownerScopeInput?: string,
): RecordingState | undefined {
  const ownerScope = effectiveBrowserOwnerScope(ownerScopeInput);
  const { recordingId, sessionId } = requestedId(args);
  const id = recordingId ?? sessionId;
  if (id) {
    const state = findActive(id);
    if (!state || state.ownerScope !== ownerScope) {
      if (allowMissing) return undefined;
      throw new BrowserMcpError('NOT_FOUND', 'No matching recording is running.');
    }
    return state;
  }
  const owned = [...recordings.values()].filter((state) => state.ownerScope === ownerScope);
  if (owned.length === 1) return owned[0];
  if (owned.length === 0) {
    if (allowMissing) return undefined;
    throw new BrowserMcpError('NOT_FOUND', 'No recording is running.');
  }
  throw new BrowserMcpError('INVALID_ARGUMENT', 'Multiple recordings are running; specify recordingId.');
}

function rememberCompleted(state: RecordingState, result: Record<string, unknown>): void {
  const now = Date.now();
  for (const [recordingId, entry] of completedRecordings) {
    if (now - entry.completedAt > COMPLETED_RECORDING_TTL_MS) completedRecordings.delete(recordingId);
  }
  while (completedRecordings.size >= MAX_COMPLETED_RECORDINGS) {
    const oldest = completedRecordings.keys().next().value as string | undefined;
    if (!oldest) break;
    completedRecordings.delete(oldest);
  }
  completedRecordings.set(state.id, { result, completedAt: now, ownerScope: state.ownerScope, sessionId: state.sessionId });
  latestCompletedIds.set(state.ownerScope, state.id);
}

function completedEntry(
  args: { recordingId?: unknown; sessionId?: unknown },
  ownerScopeInput?: string,
): CompletedRecording | undefined {
  const ownerScope = effectiveBrowserOwnerScope(ownerScopeInput);
  const { recordingId, sessionId } = requestedId(args);
  let entry: CompletedRecording | undefined;
  if (recordingId) {
    entry = completedRecordings.get(recordingId)
      ?? [...completedRecordings.values()].filter((candidate) => candidate.sessionId === recordingId).at(-1);
  } else if (sessionId) {
    entry = [...completedRecordings.values()].filter((candidate) => candidate.sessionId === sessionId).at(-1);
  } else {
    const latest = latestCompletedIds.get(ownerScope);
    entry = latest ? completedRecordings.get(latest) : undefined;
  }
  return entry?.ownerScope === ownerScope ? entry : undefined;
}

function finalizingRecording(
  args: { recordingId?: unknown; sessionId?: unknown },
  ownerScopeInput?: string,
): RecordingState | undefined {
  const ownerScope = effectiveBrowserOwnerScope(ownerScopeInput);
  const { recordingId, sessionId } = requestedId(args);
  const id = recordingId ?? sessionId;
  if (id) {
    const state = finalizingRecordings.get(id) ?? [...finalizingRecordings.values()].find((candidate) => candidate.sessionId === id);
    return state?.ownerScope === ownerScope ? state : undefined;
  }
  const owned = [...finalizingRecordings.values()].filter((state) => state.ownerScope === ownerScope);
  if (owned.length === 1 && ![...recordings.values()].some((state) => state.ownerScope === ownerScope)) return owned[0];
  return undefined;
}

function mimeForPath(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.mp4') return 'video/mp4';
  if (extension === '.mov') return 'video/quicktime';
  if (extension === '.webm') return 'video/webm';
  if (extension === '.wav') return 'audio/wav';
  return undefined;
}

async function readWebmDimensions(filePath: string | undefined): Promise<Resolution | null> {
  if (!filePath) return null;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(filePath, 'r');
    const stat = await handle.stat();
    const bytes = Math.min(stat.size, 2 * 1024 * 1024);
    const buffer = Buffer.alloc(bytes);
    await handle.read(buffer, 0, bytes, 0);
    let width: number | undefined;
    let height: number | undefined;
    for (let index = 0; index < buffer.length - 2 && (!width || !height); index += 1) {
      const id = buffer[index];
      if (id !== 0xb0 && id !== 0xba) continue;
      const first = buffer[index + 1];
      let length = 1;
      let mask = 0x80;
      while (length <= 4 && (first & mask) === 0) {
        length += 1;
        mask >>= 1;
      }
      if (length > 4 || index + 1 + length >= buffer.length) continue;
      let size = first & (mask - 1);
      for (let cursor = 1; cursor < length; cursor += 1) size = (size << 8) | buffer[index + 1 + cursor];
      if (size < 1 || size > 4 || index + 1 + length + size > buffer.length) continue;
      let value = 0;
      for (let cursor = 0; cursor < size; cursor += 1) {
        value = (value << 8) | buffer[index + 1 + length + cursor];
      }
      if (value < 1 || value > 16_384) continue;
      if (id === 0xb0) width = value;
      else height = value;
    }
    return width && height ? { width, height } : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function geometryPayload(geometry: Geometry, encoded: Resolution | null = null): Record<string, unknown> {
  const viewportMismatch = geometry.actualViewport.width !== geometry.effectiveResolution.width
    || geometry.actualViewport.height !== geometry.effectiveResolution.height
    || geometry.deviceScaleFactor !== 1;
  const encodedMismatch = encoded !== null
    && (encoded.width !== geometry.effectiveResolution.width || encoded.height !== geometry.effectiveResolution.height);
  return {
    requestedViewport: geometry.requestedResolution,
    actualViewport: geometry.actualViewport,
    deviceScaleFactor: geometry.deviceScaleFactor,
    configuredVideoResolution: geometry.effectiveResolution,
    actualEncodedVideoResolution: encoded,
    contentBounds: {
      x: 0,
      y: 0,
      width: geometry.effectiveResolution.width,
      height: geometry.effectiveResolution.height,
    },
    letterboxInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    geometryMismatch: viewportMismatch || encodedMismatch,
  };
}

async function nonEmptyFile(filePath: string): Promise<boolean> {
  const stat = await fs.stat(filePath).catch(() => undefined);
  return Boolean(stat?.isFile() && stat.size > 0);
}

function isEncoderArtifact(value: unknown): value is EncoderArtifact {
  if (typeof value !== 'object' || value === null) return false;
  return ['saveAs', 'pathAfterFinished', 'delete'].every((method) => typeof Reflect.get(value, method) === 'function');
}

/**
 * Patchright keeps the encoder's temporary file in a private field. Reading it
 * lets a stop delete that copy once the video is saved (it would otherwise
 * stay in the browser's temp folder until the browser exits) and recover the
 * raw file when the normal save fails.
 */
function encoderArtifact(page: Page): EncoderArtifact | undefined {
  const candidate: unknown = Reflect.get(page.screencast, '_artifact');
  return isEncoderArtifact(candidate) ? candidate : undefined;
}

/** Stop the screencast and move the finished video into the recordings folder, without closing the page. */
async function saveSegmentVideo(state: RecordingState, warnings: string[]): Promise<string | undefined> {
  const { page } = state.owner;
  const destination = state.videoDest;
  let saved = false;
  if (!page.isClosed()) {
    try {
      await page.screencast.stop();
      saved = await nonEmptyFile(destination);
      if (!saved) warnings.push('The saved video file was empty; trying Chromium\'s raw recording file.');
    } catch (error) {
      warnings.push(`The normal video save failed; trying Chromium's raw recording file (${errorText(error)}).`);
    }
  } else {
    warnings.push('The page closed before the recording was stopped; saving what was recorded until then.');
  }
  const artifact = state.artifact;
  if (!saved && !artifact) {
    warnings.push('Chromium did not expose a video artifact for this recording.');
    return undefined;
  }
  if (!saved && artifact) {
    let rawPath: string | undefined;
    try {
      await artifact.saveAs(destination);
      saved = await nonEmptyFile(destination);
      if (!saved) {
        rawPath = await artifact.pathAfterFinished();
        await fs.copyFile(rawPath, destination);
        saved = await nonEmptyFile(destination);
      }
      if (saved) warnings.push('Recovered the video from Chromium\'s raw recording file.');
    } catch (fallbackError) {
      warnings.push(`Raw video recovery also failed: ${errorText(fallbackError)}.`);
    }
    if (!saved) {
      rawPath ??= await artifact.pathAfterFinished().catch(() => undefined);
      if (rawPath && await nonEmptyFile(rawPath)) {
        warnings.push(`The video could not be copied into the recordings folder, so it stays at ${rawPath}. Move it somewhere safe: that folder is emptied when the browser closes.`);
        return rawPath;
      }
      return undefined;
    }
  }
  if (artifact) await artifact.delete().catch(() => undefined);
  else warnings.push('Chromium\'s temporary copy of this video could not be found to remove it; it is deleted when the browser closes.');
  return destination;
}

async function closeRecordingSession(owner: RecordingSession): Promise<void> {
  if (owner.closed) return;
  owner.closed = true;
  if (recordingSessions.get(owner.sessionId) === owner) recordingSessions.delete(owner.sessionId);
  const tap = owner.audioTap;
  owner.audioTap = undefined;
  await tap?.cdp.detach().catch(() => undefined);
  await closeSessionObject(owner.session);
}

/** Close the session through the recording when its page closes or it expires, so a running part is saved first. */
function watchRecordingSession(owner: RecordingSession): void {
  owner.session.keepAlive = () => Boolean(owner.active && !owner.active.stopping);
  owner.session.onExpire = () => { void endRecordingSession(owner, 'session-closed'); };
  owner.page.on('close', () => { void endRecordingSession(owner, 'session-closed'); });
}

/** Let recording use a page opened with browser_open, without reloading it. */
function borrowSession(session: BrowserSession, ownerScope: string): RecordingSession {
  const viewport = session.page.viewportSize() ?? defaultViewport();
  const owner: RecordingSession = {
    sessionId: session.id,
    ownerScope,
    session,
    context: session.context,
    page: session.page,
    requestedResolution: viewport,
    effectiveResolution: viewport,
    actualViewport: viewport,
    deviceScaleFactor: session.deviceScaleFactor ?? 1,
    setupAttempts: [],
    segmentCount: 0,
    closed: false,
    borrowed: {
      settings: {
        viewportPolicy: session.viewportPolicy,
        configuredViewport: session.configuredViewport,
        configuredVideoResolution: session.configuredVideoResolution,
        deviceScaleFactor: session.deviceScaleFactor,
      },
    },
  };
  recordingSessions.set(session.id, owner);
  watchRecordingSession(owner);
  return owner;
}

function sameSize(left: Resolution | null | undefined, right: Resolution): boolean {
  return Boolean(left && left.width === right.width && left.height === right.height);
}

function sizeText(size: Resolution): string {
  return `${size.width}x${size.height}`;
}

function recordingSizeLimits(): { maxWidth: number; maxHeight: number } {
  return {
    maxWidth: integerEnv('FLUJO_BROWSER_RECORD_MAX_WIDTH', 1920, 640, 3840),
    maxHeight: integerEnv('FLUJO_BROWSER_RECORD_MAX_HEIGHT', 1080, 360, 2160),
  };
}

type ObservedViewport = Resolution & { dpr: number };
const OBSERVE_VIEWPORT = '({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio })';

/**
 * Start a part on a borrowed page. The video has the page's own size (or the
 * size asked for), so nothing is scaled. When the size has to change, the page
 * is resized without reloading and gets its old size back when the part ends.
 */
async function startBorrowedScreencast(
  owner: RecordingSession,
  args: StartRecordingArgs,
  videoPath: string,
  warnings: string[],
): Promise<void> {
  const { page, session } = owner;
  const before = page.viewportSize() ?? await page.evaluate<Resolution>('({ width: window.innerWidth, height: window.innerHeight })');
  const { maxWidth, maxHeight } = recordingSizeLimits();
  const resolution = normalizeResolution(args.resolution, args.width, args.height, {
    defaultValue: before,
    minWidth: 320,
    minHeight: 240,
    maxWidth,
    maxHeight,
    even: true,
  });
  if (resolution.explicit || args.resolution !== undefined) warnings.push(...resolution.warnings);
  const attempts: string[] = [];
  let chosen: Resolution | undefined;
  let observed: ObservedViewport | undefined;
  const candidates = resolutionFallbacks(resolution.effective)
    .filter(({ width, height }) => width <= maxWidth && height <= maxHeight);
  for (const candidate of candidates) {
    try {
      if (!sameSize(page.viewportSize(), candidate)) await page.setViewportSize(candidate);
      observed = await page.evaluate<ObservedViewport>(OBSERVE_VIEWPORT);
      await page.screencast.start({ path: videoPath, size: candidate });
      chosen = candidate;
      break;
    } catch (error) {
      attempts.push(`${sizeText(candidate)}: ${errorText(error)}`);
    }
  }
  if (!chosen || !observed) {
    if (!page.isClosed() && !sameSize(page.viewportSize(), before)) await page.setViewportSize(before).catch(() => undefined);
    throw new BrowserMcpError('BROWSER_UNAVAILABLE', `Could not start video recording on this page after safe resolution fallbacks. ${attempts.join(' | ')}`);
  }
  if (attempts.length > 0) {
    warnings.push(`Recording recovered at ${sizeText(chosen)} after ${attempts.length} failed resolution attempt(s).`);
  }
  if (!sameSize(before, chosen)) {
    if (owner.borrowed) owner.borrowed.restoreViewport = before;
    warnings.push(`The page was resized from ${sizeText(before)} to ${sizeText(chosen)} for this recording, without reloading it. It goes back to ${sizeText(before)} when the recording stops.`);
  }
  if (!sameSize(observed, chosen)) {
    warnings.push(`The page reports a ${sizeText(observed)} window instead of ${sizeText(chosen)}, so the video is scaled to fit.`);
  }
  if (observed.dpr !== 1) {
    warnings.push(`This page draws ${observed.dpr} screen pixels per CSS pixel, so the video is scaled down to ${sizeText(chosen)}.`);
  }
  owner.requestedResolution = resolution.requested;
  owner.effectiveResolution = chosen;
  owner.actualViewport = { width: observed.width, height: observed.height };
  owner.deviceScaleFactor = observed.dpr;
  owner.setupAttempts = attempts;
  session.viewportPolicy = 'fixed';
  session.configuredViewport = chosen;
  session.configuredVideoResolution = chosen;
  session.deviceScaleFactor = observed.dpr;
}

/** Give a borrowed page its own settings and size back once a part ends. */
async function releaseBorrowedPage(owner: RecordingSession): Promise<void> {
  const borrowed = owner.borrowed;
  if (!borrowed) return;
  Object.assign(owner.session, borrowed.settings);
  const restore = borrowed.restoreViewport;
  borrowed.restoreViewport = undefined;
  if (restore && !owner.page.isClosed()) await owner.page.setViewportSize(restore).catch(() => undefined);
}

/** The page or session went away: save the running segment, then release the session. */
async function endRecordingSession(owner: RecordingSession, reason: StopReason): Promise<void> {
  const active = owner.active;
  if (active && !active.stopping) {
    await finalizeSegment(active, { closeSession: true, reason }).catch(() => undefined);
    return;
  }
  if (active) await active.done.promise.catch(() => undefined);
  await closeRecordingSession(owner);
}

function refreshIdleWindow(owner: RecordingSession): void {
  try {
    getSession(owner.sessionId, owner.ownerScope);
  } catch {
    // The session already expired; the caller sees sessionClosed in the result.
  }
}

function stopNextAction(success: boolean, sessionClosed: boolean, sessionId: string): string {
  if (!success) {
    return 'Retry browser_record_start with resolution="720p" and audio=false; warnings contains every attempted recovery.';
  }
  if (sessionClosed) return 'Use outputPath directly; the video is also returned as MCP media when it is small enough.';
  return `Use outputPath directly. The browser session ${sessionId} is still open and keeps its page state: record the next part with browser_record_start { sessionId: "${sessionId}" }, keep using it with the browser tools, or close it with browser_close.`;
}

async function finalizeSegment(
  state: RecordingState,
  options: { outputPath?: string; closeSession: boolean; reason: StopReason },
): Promise<Record<string, unknown>> {
  if (state.stopping) return state.done.promise;
  const owner = state.owner;
  // Saving can take a while for a long video; start a fresh idle window while
  // the session is still held open, before the hold ends with `stopping`.
  if (!options.closeSession && !owner.page.isClosed()) refreshIdleWindow(owner);
  state.stopping = true;
  state.stopReason = options.reason;
  if (state.durationTimer) clearTimeout(state.durationTimer);
  if (state.diskTimer) clearInterval(state.diskTimer);
  recordings.delete(state.id);
  finalizingRecordings.set(state.id, state);

  const durationMs = Date.now() - state.startedAt;
  const videoPath = await saveSegmentVideo(state, state.warnings);
  await stopSegmentAudio(state);

  let audioPath: string | undefined;
  if (state.audio && state.audioBytes > 0) {
    try {
      audioPath = await finishAudio(state);
    } catch (error) {
      state.warnings.push(`Audio was captured but could not be saved: ${errorText(error)}.`);
    }
  } else {
    await discardAudio(state);
    if (state.audio) state.warnings.push('No audible page signal was captured; returning the video without an audio track.');
  }
  const warnings = [...state.warnings];

  const keepOpen = !options.closeSession && !owner.page.isClosed();
  if (keepOpen) await releaseBorrowedPage(owner);
  if (owner.active === state) owner.active = undefined;
  if (owner.session.recordingId === state.id) owner.session.recordingId = undefined;
  if (keepOpen) refreshIdleWindow(owner);
  else await closeRecordingSession(owner);
  const sessionClosed = owner.closed;

  let mergedPath: string | undefined;
  let muxed = false;
  let reason: string | undefined;
  if (videoPath && audioPath) {
    const ffmpeg = await resolveFfmpeg();
    if (ffmpeg) {
      const dest = path.join(recordingRoot(), `${state.id}.mux.webm`);
      try {
        await runFfmpegMux(ffmpeg, videoPath, audioPath, dest, ffmpegTimeoutMs(durationMs));
        mergedPath = dest;
        muxed = true;
      } catch (error) {
        reason = 'mux-failed';
        warnings.push(`ffmpeg could not mux audio and video; both original files remain available (${errorText(error)}).`);
      }
    } else {
      reason = 'ffmpeg-not-available';
      warnings.push('ffmpeg was not available, so video and audio are returned as separate artifacts.');
    }
  } else if (videoPath && !audioPath) {
    reason = state.audio ? 'no-audio-captured' : 'audio-disabled';
  } else if (!videoPath && audioPath) {
    reason = 'no-video-captured';
  }

  let outputPath = mergedPath ?? videoPath;
  const outputPathOverride = options.outputPath ?? state.outputPath;
  if (outputPathOverride && outputPath) {
    try {
      let requested = outputPathOverride;
      if (!path.extname(requested)) {
        requested += '.webm';
        warnings.push(`outputPath had no extension; wrote ${requested} instead.`);
      }
      const dest = await confineOutputPath(requested);
      const destinationExtension = path.extname(dest).toLowerCase();
      const sourceExtension = path.extname(outputPath).toLowerCase();
      if (destinationExtension === sourceExtension) {
        await fs.copyFile(outputPath, dest);
        outputPath = dest;
      } else if (['.mp4', '.mov', '.webm'].includes(destinationExtension)) {
        const ffmpeg = await resolveFfmpeg();
        if (ffmpeg) {
          await runFfmpegTranscode(ffmpeg, outputPath, dest, ffmpegTimeoutMs(durationMs));
          outputPath = dest;
          warnings.push(`ffmpeg converted the recording to ${destinationExtension}.`);
        } else {
          warnings.push(`Could not create ${destinationExtension} because ffmpeg is unavailable; keeping ${sourceExtension || '.webm'}.`);
        }
      } else {
        warnings.push(`Unsupported output extension ${destinationExtension}; keeping the WebM artifact instead.`);
      }
    } catch (error) {
      warnings.push(`The requested outputPath could not be used; the safe recording-root artifact was kept (${errorText(error)}).`);
    }
  }

  const stat = outputPath ? await fs.stat(outputPath).catch(() => undefined) : undefined;
  const actualEncodedVideoResolution = await readWebmDimensions(videoPath);
  if (!actualEncodedVideoResolution) {
    warnings.push('The finalized WebM dimensions could not be verified in-process; actualEncodedVideoResolution is null.');
  } else if (
    actualEncodedVideoResolution.width !== owner.effectiveResolution.width
    || actualEncodedVideoResolution.height !== owner.effectiveResolution.height
  ) {
    warnings.push(`Encoded geometry mismatch: configured ${owner.effectiveResolution.width}x${owner.effectiveResolution.height}, observed ${actualEncodedVideoResolution.width}x${actualEncodedVideoResolution.height}. Exact evidence is invalid.`);
  }
  const success = Boolean(outputPath && stat?.isFile() && stat.size > 0);
  const artifacts = [
    outputPath ? { kind: 'video', path: outputPath, mimeType: mimeForPath(outputPath) ?? 'video/webm', bytes: stat?.size ?? 0 } : undefined,
    audioPath ? { kind: 'audio', path: audioPath, mimeType: 'audio/wav' } : undefined,
  ].filter(Boolean);
  const result: Record<string, unknown> = {
    success,
    recordingId: state.id,
    sessionId: state.sessionId,
    segment: state.segment,
    status: success ? 'stopped' : 'failed',
    stopReason: options.reason,
    sessionClosed,
    durationMs,
    ...(state.durationMs !== undefined ? { requestedDurationMs: state.durationMs } : {}),
    requestedResolution: owner.requestedResolution,
    effectiveResolution: owner.effectiveResolution,
    ...geometryPayload(owner, actualEncodedVideoResolution),
    videoPath,
    audioPath,
    mergedPath,
    outputPath,
    muxed,
    bytes: stat?.size ?? 0,
    artifacts,
    warnings,
    ...(owner.setupAttempts.length ? { attempts: owner.setupAttempts } : {}),
    ...(reason ? { reason } : {}),
    ...(!success ? {
      error: {
        code: 'RECORDING_FAILED',
        message: 'Chromium did not produce a usable video after the normal save and raw-file recovery attempts.',
        recovery: { suggestedResolution: '1280x720', audio: false },
      },
    } : {}),
    nextAction: stopNextAction(success, sessionClosed, state.sessionId),
  };
  state.done.resolve(result);
  rememberCompleted(state, result);
  finalizingRecordings.delete(state.id);
  return result;
}

async function runDiskCheck(state: RecordingState): Promise<void> {
  if (state.diskChecking || state.stopping) return;
  state.diskChecking = true;
  try {
    const low = await checkLowDisk(state.diskBaseline, Date.now() - state.startedAt, state.owner.effectiveResolution);
    if (!low || state.stopping) return;
    state.lastFreeBytes = low.freeBytes;
    state.warnings.push(
      `The recording stopped early because the disk is almost full: ${formatBytes(low.freeBytes)} free in ${low.path}. `
      + `Recordings always leave ${formatBytes(low.keepFreeBytes)} free so the computer keeps working, plus room to save the video. `
      + 'Everything recorded so far was saved and the page is still open. Free some space, then call browser_record_start with this sessionId to record the next part.',
    );
    await finalizeSegment(state, { closeSession: false, reason: 'low-disk' });
  } catch {
    // A failed disk reading is retried on the next check.
  } finally {
    state.diskChecking = false;
  }
}

function scheduleAutoStop(state: RecordingState, durationMs: number): void {
  if (state.durationTimer) clearTimeout(state.durationTimer);
  state.autoStopAt = Date.now() + durationMs;
  state.durationTimer = setTimeout(() => {
    void finalizeSegment(state, { closeSession: false, reason: 'auto-stop' });
  }, durationMs);
  state.durationTimer.unref?.();
}

function startTimers(state: RecordingState, durationMs: number | undefined): void {
  if (durationMs !== undefined) scheduleAutoStop(state, durationMs);
  state.diskTimer = setInterval(() => {
    void runDiskCheck(state);
  }, DISK_CHECK_INTERVAL_MS);
  state.diskTimer.unref?.();
}

function configuredMaxMs(): number | undefined {
  if (!process.env.FLUJO_BROWSER_RECORD_MAX_MS?.trim()) return undefined;
  return integerEnv('FLUJO_BROWSER_RECORD_MAX_MS', MAX_TIMER_MS, 1_000, MAX_TIMER_MS);
}

function parseDuration(value: unknown, warnings: string[]): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new BrowserMcpError(
      'INVALID_ARGUMENT',
      'durationMs must be a number of milliseconds, for example 360000 for six minutes. Leave it out to stop the recording yourself with browser_record_stop.',
    );
  }
  const whole = Math.trunc(parsed);
  if (whole > MAX_TIMER_MS) {
    throw new BrowserMcpError(
      'INVALID_ARGUMENT',
      `durationMs can be at most ${MAX_TIMER_MS} (about 24 days). Leave it out and call browser_record_stop when you are done instead.`,
    );
  }
  const ceiling = configuredMaxMs();
  if (ceiling !== undefined && whole > ceiling) {
    throw new BrowserMcpError(
      'INVALID_ARGUMENT',
      `This FLUJO allows at most ${formatDuration(ceiling)} per recording (FLUJO_BROWSER_RECORD_MAX_MS=${ceiling}), and ${formatDuration(whole)} was asked for. `
      + 'Ask for a shorter durationMs, or record in parts: browser_record_stop keeps the page open and browser_record_start with its sessionId records the next part.',
    );
  }
  if (whole < MIN_DURATION_MS) {
    warnings.push(`durationMs ${whole} is below the ${MIN_DURATION_MS} ms minimum, so the recording stops after ${MIN_DURATION_MS} ms.`);
    return MIN_DURATION_MS;
  }
  return whole;
}

function booleanArg(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  if (/^(1|true|yes|on)$/i.test(value.trim())) return true;
  if (/^(0|false|no|off)$/i.test(value.trim())) return false;
  return undefined;
}

/** Refuse only when the disk is already below what every recording leaves free. */
function assertDiskRoom(disk: RecordingDiskBudget): void {
  if (disk.maxDurationMs === null || disk.maxDurationMs >= 1_000) return;
  throw new BrowserMcpError(
    'DISK_LOW',
    `The disk is almost full: ${formatBytes(disk.freeBytes ?? 0)} free in ${disk.path}. `
    + `Recordings always leave ${formatBytes(disk.keepFreeBytes ?? 0)} free so the computer keeps working. Free some space, then start the recording again.`,
  );
}

function diskWarningFor(disk: RecordingDiskBudget, durationMs: number | undefined): string | undefined {
  if (disk.maxDurationMs === null || durationMs === undefined || durationMs <= disk.maxDurationMs) return undefined;
  return `The free disk space (${formatBytes(disk.freeBytes ?? 0)} in ${disk.path}) lasts for about ${formatDuration(disk.maxDurationMs)} at this size, `
    + `less than the ${formatDuration(durationMs)} asked for. The recording keeps going and only stops early if the disk really runs low; `
    + 'what was recorded is then saved. A smaller resolution or audio=false makes it last longer.';
}

function diskPayload(disk: RecordingDiskBudget, durationMs: number | undefined): Record<string, unknown> {
  const diskWarning = diskWarningFor(disk, durationMs);
  return {
    maxDurationMs: disk.maxDurationMs,
    disk: {
      path: disk.path,
      freeBytes: disk.freeBytes,
      keepFreeBytes: disk.keepFreeBytes,
      estimatedBytesPerMinute: disk.estimatedBytesPerMinute,
      ...(configuredMaxMs() !== undefined ? { configuredMaxMs: configuredMaxMs() } : {}),
      note: disk.maxDurationMs === null
        ? 'Free disk space could not be read, so no estimate is available; the recording still stops safely if writing fails.'
        : 'maxDurationMs is an estimate from free disk space right now. It is not a fixed limit: the recording only stops early if the disk actually runs low.',
    },
    ...(diskWarning ? { diskWarning } : {}),
  };
}

function remainingMs(state: RecordingState): number | undefined {
  return state.autoStopAt === undefined ? undefined : Math.max(0, state.autoStopAt - Date.now());
}

function startNextAction(state: RecordingState): string {
  const keepOpen = 'The page stays open after the recording stops unless you pass closeSession: true to browser_record_stop.';
  const remaining = remainingMs(state);
  if (remaining !== undefined) {
    return `Drive this session now. The recording stops by itself in ${formatDuration(remaining)} (autoStopAt); `
      + `then call browser_record_stop or browser_record_status with recordingId to get the video. ${keepOpen}`;
  }
  return `Drive this session with browser_navigate/click/type, then call browser_record_stop with recordingId. ${keepOpen}`;
}

function startPayload(state: RecordingState, extra: Record<string, unknown>): Record<string, unknown> {
  const owner = state.owner;
  return {
    success: true,
    recordingId: state.id,
    sessionId: state.sessionId,
    status: 'recording',
    segment: state.segment,
    startedAt: state.startedAt,
    requestedResolution: owner.requestedResolution,
    effectiveResolution: owner.effectiveResolution,
    ...geometryPayload(owner),
    audio: state.audio,
    ...(state.autoStopAt !== undefined ? { durationMs: state.durationMs, autoStopAt: state.autoStopAt } : {}),
    ...diskPayload(state.disk, remainingMs(state)),
    ...extra,
    warnings: state.warnings,
    ...(owner.setupAttempts.length ? { attempts: owner.setupAttempts } : {}),
    nextAction: startNextAction(state),
  };
}

function newSegmentState(
  owner: RecordingSession,
  init: { id: string; audio: boolean; outputPath?: string; disk: RecordingDiskBudget; baseline: Map<string, number>; warnings: string[] },
): RecordingState {
  owner.segmentCount += 1;
  return {
    id: init.id,
    sessionId: owner.sessionId,
    ownerScope: owner.ownerScope,
    owner,
    segment: owner.segmentCount,
    startedAt: Date.now(),
    audio: init.audio,
    audioBytes: 0,
    audioFull: false,
    videoDest: path.join(recordingRoot(), `${init.id}.webm`),
    artifact: encoderArtifact(owner.page),
    outputPath: init.outputPath,
    stopping: false,
    diskChecking: false,
    diskBaseline: init.baseline,
    disk: init.disk,
    done: createDeferred<Record<string, unknown>>(),
    warnings: init.warnings,
  };
}

async function loadSource(page: Page, args: StartRecordingArgs, warnings: string[]): Promise<boolean | undefined> {
  const hasSource = [args.source, args.url, args.html, args.filePath]
    .some((value) => typeof value === 'string' && value.trim().length > 0);
  if (!hasSource) return undefined;
  try {
    const source = await resolveCaptureSource({
      source: args.source,
      url: typeof args.url === 'string' ? args.url : undefined,
      html: typeof args.html === 'string' ? args.html : undefined,
      filePath: typeof args.filePath === 'string' ? args.filePath : undefined,
    });
    warnings.push(...source.warnings);
    const rawTimeout = typeof args.timeoutMs === 'number' ? args.timeoutMs : Number(args.timeoutMs);
    const navigationTimeout = Number.isFinite(rawTimeout) ? Math.min(60_000, Math.max(1_000, Math.trunc(rawTimeout))) : 30_000;
    await navigateCaptureSource(page, source, navigationTimeout);
    return true;
  } catch (error) {
    warnings.push(`The source could not be loaded; the recording session remains open for browser_navigate (${errorText(error)}).`);
    return false;
  }
}

/** Kept-open recording sessions stay until idle cleanup; reuse the room of the oldest one before refusing a new recording. */
async function makeRoomForRecordingSession(ownerScope: string, warnings: string[]): Promise<void> {
  const listing = listSessions(ownerScope) as {
    sessions: Array<{ sessionId: string; purpose?: string; idleMs?: number }>;
    capacity: { used: number; limit: number };
  };
  if (listing.capacity.used < listing.capacity.limit) return;
  const idle = listing.sessions
    .filter((entry) => entry.purpose === 'recording')
    .map((entry) => ({ entry, owner: recordingSessions.get(entry.sessionId) }))
    .filter(({ owner }) => owner && !owner.active && !owner.closed)
    .sort((left, right) => (right.entry.idleMs ?? 0) - (left.entry.idleMs ?? 0));
  const oldest = idle[0]?.owner;
  if (!oldest) return;
  await closeRecordingSession(oldest);
  warnings.push(`Closed the idle recording session ${oldest.sessionId} (its recording had already stopped) to make room for this one.`);
}

export type StartRecordingArgs = {
  sessionId?: unknown;
  source?: unknown;
  resolution?: unknown;
  width?: unknown;
  height?: unknown;
  audio?: unknown;
  durationMs?: unknown;
  outputPath?: unknown;
  url?: unknown;
  html?: unknown;
  filePath?: unknown;
  timeoutMs?: unknown;
};

/**
 * Record the next segment on an open session (a kept-open recording session or
 * a browser_open page), or change when its running segment stops.
 */
async function continueRecording(
  sessionId: string,
  args: StartRecordingArgs,
  durationMs: number | undefined,
  warnings: string[],
  ownerScope: string,
): Promise<Record<string, unknown>> {
  const openOwner = (): RecordingSession => {
    let session: BrowserSession;
    try {
      session = getSession(sessionId, ownerScope);
    } catch (error) {
      if (error instanceof BrowserMcpError && error.code === 'NOT_FOUND') {
        throw new BrowserMcpError(
          'NOT_FOUND',
          'No open browser session has this sessionId. Pass the sessionId of a page opened with browser_open or of an earlier recording, or leave sessionId out to start a new recording session.',
        );
      }
      throw error;
    }
    const found = recordingSessions.get(sessionId);
    if (found && found.session === session && !found.closed) return found;
    return borrowSession(session, ownerScope);
  };
  let owner = openOwner();
  if (owner.starting) {
    await owner.starting;
    owner = openOwner();
  }
  if (owner.active && !owner.active.stopping) {
    const state = owner.active;
    if (durationMs === undefined) {
      state.warnings.push('This session is already recording, so nothing changed. Pass durationMs to change when it stops.');
      return startPayload(state, { alreadyRecording: true });
    }
    scheduleAutoStop(state, durationMs);
    state.durationMs = Date.now() - state.startedAt + durationMs;
    const disk = await recordingDiskBudget(recordingFolders(), owner.effectiveResolution, state.audio);
    state.disk = disk;
    return startPayload(state, { autoStopChanged: true });
  }
  if (owner.active) {
    await owner.active.done.promise.catch(() => undefined);
    owner = openOwner();
  }
  if (owner.active || owner.starting) {
    throw new BrowserMcpError('INVALID_ARGUMENT', 'Another call started recording on this session at the same time; use its recordingId.');
  }
  if (recordings.size + recordingReservations.size >= MAX_CONCURRENT_RECORDINGS) {
    throw new BrowserMcpError('SESSION_LIMIT', `The recording limit (${MAX_CONCURRENT_RECORDINGS}) has been reached. Stop another recording first.`);
  }
  const id = randomUUID();
  recordingReservations.add(id);
  const starting = createDeferred<void>();
  owner.starting = starting.promise;
  let state: RecordingState;
  try {
    const audio = booleanArg(args.audio) !== false;
    let disk = await recordingDiskBudget(recordingFolders(), owner.effectiveResolution, audio);
    assertDiskRoom(disk);
    const baseline = await diskBaseline(recordingFolders());
    await fs.mkdir(recordingRoot(), { recursive: true });
    if (owner.closed) {
      throw new BrowserMcpError('INVALID_ARGUMENT', 'The session closed while this recording was starting; check browser_record_status.');
    }
    const videoPath = path.join(recordingRoot(), `${id}.webm`);
    if (owner.borrowed) {
      const sizeBefore = owner.effectiveResolution;
      await startBorrowedScreencast(owner, args, videoPath, warnings);
      if (!sameSize(sizeBefore, owner.effectiveResolution)) {
        disk = await recordingDiskBudget(recordingFolders(), owner.effectiveResolution, audio);
      }
    } else {
      if (args.resolution !== undefined || args.width !== undefined || args.height !== undefined) {
        warnings.push(`A recording session keeps its page size, so this part is recorded at ${sizeText(owner.effectiveResolution)}.`);
      }
      await owner.page.screencast.start({ path: videoPath, size: owner.effectiveResolution });
    }
    const outputPath = typeof args.outputPath === 'string' && args.outputPath.length > 0 ? args.outputPath : undefined;
    state = newSegmentState(owner, { id, audio, outputPath, disk, baseline, warnings });
    owner.active = state;
    owner.session.recordingId = id;
    recordings.set(id, state);
  } finally {
    owner.starting = undefined;
    starting.resolve();
    recordingReservations.delete(id);
  }
  await startSegmentAudio(state);
  const sourceLoaded = await loadSource(owner.page, args, state.warnings);
  startTimers(state, durationMs);
  if (durationMs !== undefined) state.durationMs = durationMs;
  return startPayload(state, sourceLoaded === undefined ? {} : { sourceLoaded });
}

export async function startRecording(
  args: StartRecordingArgs,
  signal: AbortSignal,
  ownerScopeInput?: string,
): Promise<Record<string, unknown>> {
  const ownerScope = effectiveBrowserOwnerScope(ownerScopeInput);
  const startWarnings: string[] = [];
  const durationMs = parseDuration(args.durationMs, startWarnings);
  const continueId = typeof args.sessionId === 'string' && args.sessionId.trim() ? args.sessionId.trim() : undefined;
  if (continueId) return continueRecording(continueId, args, durationMs, startWarnings, ownerScope);

  if (recordings.size + recordingReservations.size >= MAX_CONCURRENT_RECORDINGS) {
    throw new BrowserMcpError('SESSION_LIMIT', `The recording limit (${MAX_CONCURRENT_RECORDINGS}) has been reached.`);
  }
  const defaults = defaultViewport();
  const { maxWidth, maxHeight } = recordingSizeLimits();
  const resolution = normalizeResolution(args.resolution, args.width, args.height, {
    defaultValue: defaults,
    minWidth: 320,
    minHeight: 240,
    maxWidth,
    maxHeight,
    even: true,
  });
  resolution.warnings.push(...startWarnings);
  const audioRequested = booleanArg(args.audio) !== false;
  const outputPath = typeof args.outputPath === 'string' && args.outputPath.length > 0 ? args.outputPath : undefined;
  let disk = await recordingDiskBudget(recordingFolders(), resolution.effective, audioRequested);
  assertDiskRoom(disk);
  await makeRoomForRecordingSession(ownerScope, resolution.warnings);

  if (signal.aborted) throw new BrowserMcpError('CANCELLED', 'The browser request was cancelled.');
  const id = randomUUID();
  recordingReservations.add(id);
  try {
    reserveSession(id, ownerScope, 'recording');
  } catch (error) {
    recordingReservations.delete(id);
    throw error;
  }
  let browser: Browser;
  try {
    browser = await acquireBrowser();
  } catch (error) {
    recordingReservations.delete(id);
    releaseSessionReservation(id, ownerScope);
    throw error;
  }
  if (signal.aborted) {
    recordingReservations.delete(id);
    releaseSessionReservation(id, ownerScope);
    throw new BrowserMcpError('CANCELLED', 'The browser request was cancelled.');
  }
  const setupAttempts: string[] = [];
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let effectiveResolution: Resolution | undefined;
  let actualViewport: Resolution | undefined;
  const baseline = await diskBaseline(recordingFolders());
  await fs.mkdir(recordingRoot(), { recursive: true });
  const candidates = resolutionFallbacks(resolution.effective)
    .filter(({ width, height }) => width <= maxWidth && height <= maxHeight);
  for (const candidate of candidates) {
    try {
      context = await browser.newContext({
        viewport: candidate,
        deviceScaleFactor: 1,
        acceptDownloads: false,
      });
      page = await context.newPage();
      const observed = await page.evaluate<{ width: number; height: number; dpr: number }>(
        '({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio })',
      );
      if (observed.width !== candidate.width || observed.height !== candidate.height || observed.dpr !== 1) {
        throw new BrowserMcpError(
          'BROWSER_UNAVAILABLE',
          `Recording geometry mismatch during startup: requested ${candidate.width}x${candidate.height} DPR 1, observed ${observed.width}x${observed.height} DPR ${observed.dpr}.`,
        );
      }
      await page.screencast.start({ path: path.join(recordingRoot(), `${id}.webm`), size: candidate });
      effectiveResolution = candidate;
      actualViewport = { width: observed.width, height: observed.height };
      break;
    } catch (error) {
      setupAttempts.push(`${candidate.width}x${candidate.height}: ${errorText(error)}`);
      await context?.close().catch(() => undefined);
      context = undefined;
      page = undefined;
    }
  }
  if (!context || !page || !effectiveResolution || !actualViewport) {
    recordingReservations.delete(id);
    releaseSessionReservation(id, ownerScope);
    throw new BrowserMcpError(
      'BROWSER_UNAVAILABLE',
      `Could not start video recording after safe resolution fallbacks. ${setupAttempts.join(' | ')}`,
    );
  }
  if (setupAttempts.length > 0) {
    resolution.warnings.push(`Recording recovered at ${effectiveResolution.width}x${effectiveResolution.height} after ${setupAttempts.length} failed resolution attempt(s).`);
    disk = await recordingDiskBudget(recordingFolders(), effectiveResolution, audioRequested);
  }
  if (signal.aborted) {
    recordingReservations.delete(id);
    releaseSessionReservation(id, ownerScope);
    await context.close().catch(() => undefined);
    throw new BrowserMcpError('CANCELLED', 'The browser request was cancelled.');
  }

  const now = Date.now();
  const session: BrowserSession = {
    id,
    mode: 'sandbox',
    ownerScope,
    purpose: 'recording',
    lifecycleState: 'active',
    viewportPolicy: 'fixed',
    createdAt: now,
    gatewayToken: randomUUID(),
    recordingId: id,
    configuredViewport: effectiveResolution,
    configuredVideoResolution: effectiveResolution,
    deviceScaleFactor: 1,
    context,
    page,
    touchedAt: now,
    documentRequests: 0,
    navigationBlocked: false,
    blockedRequestCount: 0,
  };
  try {
    registerSession(session, ownerScope);
  } catch (error) {
    recordingReservations.delete(id);
    releaseSessionReservation(id, ownerScope);
    await context.close().catch(() => undefined);
    throw error;
  }
  try {
    await installRequestPolicy(context);
  } catch (error) {
    recordingReservations.delete(id);
    await closeSession(id, ownerScope).catch(() => undefined);
    throw error;
  }

  const owner: RecordingSession = {
    sessionId: id,
    ownerScope,
    session,
    context,
    page,
    requestedResolution: resolution.requested,
    effectiveResolution,
    actualViewport,
    deviceScaleFactor: 1,
    setupAttempts,
    segmentCount: 0,
    closed: false,
  };
  const state = newSegmentState(owner, { id, audio: audioRequested, outputPath, disk, baseline, warnings: [...resolution.warnings] });
  owner.active = state;
  recordingSessions.set(id, owner);
  watchRecordingSession(owner);
  recordingReservations.delete(id);
  recordings.set(id, state);

  await startSegmentAudio(state);
  const sourceLoaded = await loadSource(page, args, state.warnings) ?? false;
  if (durationMs !== undefined) state.durationMs = durationMs;
  startTimers(state, durationMs);
  return startPayload(state, { sourceLoaded });
}

export type StopRecordingArgs = { recordingId?: unknown; sessionId?: unknown; outputPath?: unknown; closeSession?: unknown };

export async function stopRecording(
  args: StopRecordingArgs,
  ownerScopeInput?: string,
): Promise<Record<string, unknown>> {
  const ownerScope = effectiveBrowserOwnerScope(ownerScopeInput);
  const closeAfter = booleanArg(args.closeSession) === true;
  const existing = completedEntry(args, ownerScopeInput);
  const state = resolveRecordingState(args, true, ownerScopeInput);
  const outputPath = typeof args.outputPath === 'string' && args.outputPath.length > 0 ? args.outputPath : undefined;
  let result: Record<string, unknown>;
  if (state) {
    result = await finalizeSegment(state, { outputPath, closeSession: closeAfter, reason: 'requested' });
  } else {
    const finalizing = finalizingRecording(args, ownerScopeInput);
    if (finalizing) result = await finalizing.done.promise;
    else if (existing) result = existing.result;
    else throw new BrowserMcpError('NOT_FOUND', 'No matching recording is running or recently completed. Start one with browser_record_start.');
  }
  if (!closeAfter || result.sessionClosed === true) return result;
  const sessionId = typeof result.sessionId === 'string' ? result.sessionId : undefined;
  const owner = sessionId ? recordingSessions.get(sessionId) : undefined;
  if (owner && owner.ownerScope === ownerScope && owner.active) {
    return {
      ...result,
      warnings: [...(Array.isArray(result.warnings) ? result.warnings : []), 'The session was not closed because a newer recording is running on it; stop that one with closeSession: true.'],
    };
  }
  if (owner && owner.ownerScope === ownerScope) await closeRecordingSession(owner);
  const closedResult = {
    ...result,
    sessionClosed: true,
    nextAction: stopNextAction(result.success === true, true, sessionId ?? ''),
  };
  const recordingId = typeof result.recordingId === 'string' ? result.recordingId : undefined;
  const entry = recordingId ? completedRecordings.get(recordingId) : undefined;
  if (entry) entry.result = closedResult;
  return closedResult;
}

export type RecordingStatusArgs = { recordingId?: unknown; sessionId?: unknown };

export function recordingStatus(
  args: RecordingStatusArgs,
  ownerScopeInput?: string,
): Record<string, unknown> {
  const state = resolveRecordingState(args, true, ownerScopeInput);
  if (!state) {
    const finalizing = finalizingRecording(args, ownerScopeInput);
    if (finalizing) {
      return {
        success: true,
        recordingId: finalizing.id,
        sessionId: finalizing.sessionId,
        segment: finalizing.segment,
        running: false,
        status: 'finalizing',
        stopReason: finalizing.stopReason,
        elapsedMs: Date.now() - finalizing.startedAt,
        audioBytes: finalizing.audioBytes,
        effectiveResolution: finalizing.owner.effectiveResolution,
        ...geometryPayload(finalizing.owner),
        warnings: finalizing.warnings,
        nextAction: 'Call browser_record_stop with this recordingId; it will wait for finalization and return the artifact.',
      };
    }
    const completed = completedEntry(args, ownerScopeInput);
    if (completed) return { ...completed.result, running: false };
    return {
      success: true,
      recordingId: null,
      running: false,
      nextAction: 'Call browser_record_start; source and durationMs can make this a one-call setup.',
    };
  }
  return {
    success: true,
    recordingId: state.id,
    sessionId: state.sessionId,
    segment: state.segment,
    running: !state.stopping,
    elapsedMs: Date.now() - state.startedAt,
    ...(state.autoStopAt !== undefined ? { durationMs: state.durationMs, autoStopAt: state.autoStopAt } : {}),
    maxDurationMs: state.disk.maxDurationMs,
    audioBytes: state.audioBytes,
    effectiveResolution: state.owner.effectiveResolution,
    ...geometryPayload(state.owner),
    warnings: state.warnings,
    nextAction: 'Continue driving the session, or call browser_record_stop to finalize and retrieve the video.',
  };
}

export async function releaseRecordingsForOwner(ownerScopeInput?: string): Promise<number> {
  const ownerScope = effectiveBrowserOwnerScope(ownerScopeInput);
  const owned = [...recordingSessions.values()].filter((owner) => owner.ownerScope === ownerScope);
  const active = owned.filter((owner) => owner.active && !owner.active.stopping).length;
  await Promise.all(owned.map((owner) => endRecordingSession(owner, 'shutdown')));
  return active;
}

/** Finalise (never silently drop) every in-flight recording during process shutdown. */
export async function shutdownAllRecordings(): Promise<void> {
  await Promise.all([
    ...[...recordingSessions.values()].map((owner) => endRecordingSession(owner, 'shutdown')),
    ...[...finalizingRecordings.values()].map((state) => state.done.promise.catch(() => undefined)),
  ]);
  recordingReservations.clear();
  finalizingRecordings.clear();
  completedRecordings.clear();
  latestCompletedIds.clear();
  recordingSessions.clear();
}
