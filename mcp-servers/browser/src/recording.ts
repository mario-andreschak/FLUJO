/**
 * `browser_record_start` / `browser_record_stop` / `browser_record_status`
 * (#366) — screen recording with optional audio, per the owner's direction:
 * "a screenrecord functionality (with audio; start, stop or start with ms
 * parameter)".
 *
 * Design (plan §Phase 3, decision D6):
 *  - **Video** is Patchright/Playwright's built-in `recordVideo` (WebM). A
 *    recording always gets its own dedicated context (recommendation (a) in
 *    the plan) so that `context.close()` — required to finalise the video —
 *    does not have to reason about whether some *other* caller is still using
 *    the session. The resulting session is registered in the ordinary session
 *    map, so the caller can drive it with `browser_navigate`/`browser_click`/
 *    etc. between `record_start` and `record_stop`.
 *  - **Audio** reuses `audioTap.ts`'s in-page tap, driven over its own CDP
 *    session, accumulated into a canonical WAV file on stop.
 *  - **Muxing** is opt-in and never required: if an `ffmpeg` binary is
 *    discoverable (`FLUJO_FFMPEG_PATH` or PATH), video+audio are combined with
 *    a bounded, argv-array `ffmpeg` invocation; otherwise both artifacts are
 *    returned separately with `muxed: false`. Nothing is ever downloaded or
 *    installed.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { Browser, BrowserContext, CDPSession, Page } from 'patchright';
import { getDataDir, isInside } from './capture.js';
import { audioTapSource } from './audioTap.js';
import {
  BrowserMcpError,
  acquireBrowser,
  defaultViewport,
  ensureScratchDir,
  closeSession,
  integerEnv,
  recordingRoot,
  registerSession,
  type BrowserSession,
} from './runtime.js';

const MAX_CONCURRENT_RECORDINGS = 2;
const DEFAULT_RECORD_MAX_MS = 120_000;
/** Hard memory cap for buffered PCM per recording (~roughly 17 minutes of stereo 16-bit 48kHz audio). */
const MAX_AUDIO_BYTES = 200_000_000;
const FFMPEG_TIMEOUT_MS = 60_000;
const AUDIO_BINDING_PREFIX = '__flujoRecordAudio_';

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type RecordingState = {
  id: string;
  context: BrowserContext;
  page: Page;
  cdp?: CDPSession;
  videoDir: string;
  startedAt: number;
  audio: boolean;
  audioRate?: number;
  audioChunks: Buffer[];
  audioBytes: number;
  stopping: boolean;
  durationTimer?: ReturnType<typeof setTimeout>;
  done: Deferred<Record<string, unknown>>;
};

const recordings = new Map<string, RecordingState>();

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

async function attachAudioTap(state: RecordingState): Promise<void> {
  const cdp = await state.context.newCDPSession(state.page);
  state.cdp = cdp;
  const binding = `${AUDIO_BINDING_PREFIX}${state.id.replace(/[^A-Za-z0-9]/g, '')}`;
  cdp.on('Runtime.bindingCalled', (event) => {
    if (event.name !== binding) return;
    try {
      const parsed = JSON.parse(event.payload) as { rate?: unknown; pcm?: unknown };
      if (typeof parsed.rate !== 'number' || typeof parsed.pcm !== 'string') return;
      if (state.audioRate === undefined) state.audioRate = Math.trunc(parsed.rate);
      const buf = Buffer.from(parsed.pcm, 'base64');
      if (state.audioBytes + buf.length <= MAX_AUDIO_BYTES) {
        state.audioChunks.push(buf);
        state.audioBytes += buf.length;
      }
    } catch {
      // A malformed chunk is dropped rather than crashing the recording.
    }
  });
  const source = audioTapSource(binding);
  await cdp.send('Runtime.enable');
  await cdp.send('Runtime.addBinding', { name: binding });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source });
  await cdp.send('Runtime.evaluate', { expression: source }).catch(() => undefined);
}

async function detachAudioTap(state: RecordingState): Promise<void> {
  if (!state.cdp) return;
  await state.cdp.detach().catch(() => undefined);
  state.cdp = undefined;
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

/** Argv array only; every path here is server-generated (never a caller string), so there is nothing to interpolate. */
function runFfmpegMux(ffmpeg: string, videoPath: string, audioPath: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(ffmpeg, ['-y', '-i', videoPath, '-i', audioPath, '-c:v', 'copy', '-c:a', 'libopus', '-shortest', dest], {
        stdio: 'ignore',
      });
    } catch (error) {
      reject(error);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('ffmpeg timed out.'));
    }, FFMPEG_TIMEOUT_MS);
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

function resolveRecordingState(
  args: { recordingId?: unknown; sessionId?: unknown },
  allowMissing: boolean,
): RecordingState | undefined {
  const id = typeof args.recordingId === 'string' && args.recordingId
    ? args.recordingId
    : (typeof args.sessionId === 'string' && args.sessionId ? args.sessionId : undefined);
  if (id) {
    const state = recordings.get(id);
    if (!state) {
      if (allowMissing) return undefined;
      throw new BrowserMcpError('NOT_FOUND', 'No matching recording is running.');
    }
    return state;
  }
  if (recordings.size === 1) return [...recordings.values()][0];
  if (recordings.size === 0) {
    if (allowMissing) return undefined;
    throw new BrowserMcpError('NOT_FOUND', 'No recording is running.');
  }
  throw new BrowserMcpError('INVALID_ARGUMENT', 'Multiple recordings are running; specify recordingId.');
}

async function finalizeRecording(state: RecordingState, outputPathOverride?: string): Promise<Record<string, unknown>> {
  if (state.stopping) return state.done.promise;
  state.stopping = true;
  if (state.durationTimer) clearTimeout(state.durationTimer);
  recordings.delete(state.id);

  await detachAudioTap(state).catch(() => undefined);
  const durationMs = Date.now() - state.startedAt;

  let videoPath: string | undefined;
  const video = state.page.video();
  await closeSession(state.id).catch(() => undefined);
  if (video) {
    try {
      const dest = path.join(recordingRoot(), `${state.id}.webm`);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await video.saveAs(dest);
      videoPath = dest;
    } catch {
      videoPath = undefined;
    }
  }
  await fs.rm(state.videoDir, { recursive: true, force: true }).catch(() => undefined);

  let audioPath: string | undefined;
  if (state.audio && state.audioBytes > 0) {
    const rate = state.audioRate ?? 48_000;
    const pcm = Buffer.concat(state.audioChunks);
    const header = wavHeader(pcm.length, rate, 2, 16);
    const dest = path.join(recordingRoot(), `${state.id}.wav`);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, Buffer.concat([header, pcm]));
    audioPath = dest;
  }

  let mergedPath: string | undefined;
  let muxed = false;
  let reason: string | undefined;
  if (videoPath && audioPath) {
    const ffmpeg = await resolveFfmpeg();
    if (ffmpeg) {
      const dest = path.join(recordingRoot(), `${state.id}.mux.webm`);
      try {
        await runFfmpegMux(ffmpeg, videoPath, audioPath, dest);
        mergedPath = dest;
        muxed = true;
      } catch {
        reason = 'mux-failed';
      }
    } else {
      reason = 'ffmpeg-not-available';
    }
  } else if (videoPath && !audioPath) {
    reason = state.audio ? 'no-audio-captured' : 'audio-disabled';
  } else if (!videoPath && audioPath) {
    reason = 'no-video-captured';
  }

  let outputPath = mergedPath ?? videoPath;
  if (outputPathOverride && outputPath) {
    try {
      const dest = await confineOutputPath(outputPathOverride);
      await fs.copyFile(outputPath, dest);
      outputPath = dest;
    } catch {
      // Keep the artifact under the recording root if the override is rejected or fails.
    }
  }

  const stat = outputPath ? await fs.stat(outputPath).catch(() => undefined) : undefined;
  const result: Record<string, unknown> = {
    success: true,
    recordingId: state.id,
    sessionId: state.id,
    status: 'stopped',
    durationMs,
    videoPath,
    audioPath,
    mergedPath,
    outputPath,
    muxed,
    bytes: stat?.size ?? 0,
    ...(reason ? { reason } : {}),
  };
  state.done.resolve(result);
  return result;
}

export type StartRecordingArgs = {
  width?: unknown;
  height?: unknown;
  audio?: unknown;
  durationMs?: unknown;
  outputPath?: unknown;
};

export async function startRecording(args: StartRecordingArgs, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (recordings.size >= MAX_CONCURRENT_RECORDINGS) {
    throw new BrowserMcpError('SESSION_LIMIT', `The recording limit (${MAX_CONCURRENT_RECORDINGS}) has been reached.`);
  }
  const defaults = defaultViewport();
  const width = typeof args.width === 'number' && Number.isFinite(args.width) ? Math.trunc(args.width) : defaults.width;
  const height = typeof args.height === 'number' && Number.isFinite(args.height) ? Math.trunc(args.height) : defaults.height;
  if (width < 320 || width > 3840 || height < 240 || height > 2160) {
    throw new BrowserMcpError('INVALID_ARGUMENT', 'width/height must be within the supported viewport range (320-3840 x 240-2160).');
  }
  const maxMs = integerEnv('FLUJO_BROWSER_RECORD_MAX_MS', DEFAULT_RECORD_MAX_MS, 1_000, 30 * 60_000);
  let durationMs: number | undefined;
  if (args.durationMs !== undefined) {
    if (typeof args.durationMs !== 'number' || !Number.isFinite(args.durationMs) || args.durationMs < 250) {
      throw new BrowserMcpError('INVALID_ARGUMENT', 'durationMs must be a finite number of at least 250ms.');
    }
    durationMs = Math.min(maxMs, Math.trunc(args.durationMs));
  }
  const audioRequested = args.audio !== false;
  const outputPath = typeof args.outputPath === 'string' && args.outputPath.length > 0 ? args.outputPath : undefined;

  if (signal.aborted) throw new BrowserMcpError('CANCELLED', 'The browser request was cancelled.');
  const browser: Browser = await acquireBrowser();
  if (signal.aborted) throw new BrowserMcpError('CANCELLED', 'The browser request was cancelled.');

  const id = randomUUID();
  const videoDir = await ensureScratchDir(path.join('recordings', id));
  const context = await browser.newContext({
    viewport: { width, height },
    acceptDownloads: false,
    recordVideo: { dir: videoDir, size: { width, height } },
  });
  let page: Page;
  try {
    page = await context.newPage();
    await page.goto('about:blank', { waitUntil: 'load' }).catch(() => undefined);
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }
  if (signal.aborted) {
    await context.close().catch(() => undefined);
    throw new BrowserMcpError('CANCELLED', 'The browser request was cancelled.');
  }

  const session: BrowserSession = {
    id,
    context,
    page,
    touchedAt: Date.now(),
    documentRequests: 0,
    navigationBlocked: false,
  };
  registerSession(session);

  const state: RecordingState = {
    id,
    context,
    page,
    videoDir,
    startedAt: Date.now(),
    audio: audioRequested,
    audioChunks: [],
    audioBytes: 0,
    stopping: false,
    done: createDeferred<Record<string, unknown>>(),
  };
  recordings.set(id, state);

  if (audioRequested) {
    await attachAudioTap(state).catch(() => undefined);
  }

  if (durationMs !== undefined) {
    state.durationTimer = setTimeout(() => {
      void finalizeRecording(state, outputPath);
    }, durationMs);
    state.durationTimer.unref?.();
    return state.done.promise;
  }

  return { success: true, recordingId: id, sessionId: id, status: 'recording', startedAt: state.startedAt };
}

export type StopRecordingArgs = { recordingId?: unknown; sessionId?: unknown; outputPath?: unknown };

export async function stopRecording(args: StopRecordingArgs): Promise<Record<string, unknown>> {
  const state = resolveRecordingState(args, false);
  if (!state) throw new BrowserMcpError('NOT_FOUND', 'No recording is running.');
  const outputPath = typeof args.outputPath === 'string' && args.outputPath.length > 0 ? args.outputPath : undefined;
  return finalizeRecording(state, outputPath);
}

export type RecordingStatusArgs = { recordingId?: unknown; sessionId?: unknown };

export function recordingStatus(args: RecordingStatusArgs): Record<string, unknown> {
  const state = resolveRecordingState(args, true);
  if (!state) return { success: true, recordingId: null, running: false };
  return {
    success: true,
    recordingId: state.id,
    sessionId: state.id,
    running: !state.stopping,
    elapsedMs: Date.now() - state.startedAt,
    audioBytes: state.audioBytes,
  };
}

/** Finalise (never silently drop) every in-flight recording during process shutdown. */
export async function shutdownAllRecordings(): Promise<void> {
  const states = [...recordings.values()];
  await Promise.all(states.map((state) => finalizeRecording(state).catch(() => undefined)));
}
