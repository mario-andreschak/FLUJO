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
import {
  getDataDir,
  isInside,
  navigateCaptureSource,
  normalizeResolution,
  resolutionFallbacks,
  resolveCaptureSource,
  type Resolution,
} from './capture.js';
import { audioTapSource } from './audioTap.js';
import {
  BrowserMcpError,
  acquireBrowser,
  defaultViewport,
  ensureScratchDir,
  closeSession,
  integerEnv,
  installRequestPolicy,
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
const COMPLETED_RECORDING_TTL_MS = 30 * 60_000;
const MAX_COMPLETED_RECORDINGS = 16;

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
  requestedResolution: Resolution;
  effectiveResolution: Resolution;
  warnings: string[];
  setupAttempts: string[];
};

const recordings = new Map<string, RecordingState>();
const finalizingRecordings = new Map<string, RecordingState>();
const completedRecordings = new Map<string, { result: Record<string, unknown>; completedAt: number }>();
let latestCompletedId: string | undefined;

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
  // BrowserContext.addInitScript is the durable main-world hook. The old CDP-
  // only install could remain in an isolated/default execution context and
  // disappear when about:blank navigated to the actual page.
  await state.context.addInitScript({ content: source });
  await cdp.send('Runtime.enable');
  await cdp.send('Runtime.addBinding', { name: binding });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source }).catch(() => undefined);
  const evaluated = await cdp.send('Runtime.evaluate', { expression: source });
  if ('exceptionDetails' in evaluated && evaluated.exceptionDetails) {
    throw new Error('Chromium rejected the recording audio initialization script.');
  }
  // about:blank can use a different execution world from the destination. The
  // durable context init script above is verified after the real navigation.
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

function rememberCompleted(result: Record<string, unknown>): void {
  const id = typeof result.recordingId === 'string' ? result.recordingId : undefined;
  if (!id) return;
  const now = Date.now();
  for (const [recordingId, entry] of completedRecordings) {
    if (now - entry.completedAt > COMPLETED_RECORDING_TTL_MS) completedRecordings.delete(recordingId);
  }
  while (completedRecordings.size >= MAX_COMPLETED_RECORDINGS) {
    const oldest = completedRecordings.keys().next().value as string | undefined;
    if (!oldest) break;
    completedRecordings.delete(oldest);
  }
  completedRecordings.set(id, { result, completedAt: now });
  latestCompletedId = id;
}

function completedRecording(args: { recordingId?: unknown; sessionId?: unknown }): Record<string, unknown> | undefined {
  const id = typeof args.recordingId === 'string' && args.recordingId
    ? args.recordingId
    : (typeof args.sessionId === 'string' && args.sessionId ? args.sessionId : latestCompletedId);
  return id ? completedRecordings.get(id)?.result : undefined;
}

function finalizingRecording(args: { recordingId?: unknown; sessionId?: unknown }): RecordingState | undefined {
  const id = typeof args.recordingId === 'string' && args.recordingId
    ? args.recordingId
    : (typeof args.sessionId === 'string' && args.sessionId ? args.sessionId : undefined);
  if (id) return finalizingRecordings.get(id);
  if (finalizingRecordings.size === 1 && recordings.size === 0) return [...finalizingRecordings.values()][0];
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

function runFfmpegTranscode(ffmpeg: string, source: string, dest: string): Promise<void> {
  const extension = path.extname(dest).toLowerCase();
  const codecArgs = extension === '.mp4' || extension === '.mov'
    ? ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart']
    : ['-c:v', 'copy', '-c:a', 'libopus'];
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(ffmpeg, ['-y', '-i', source, ...codecArgs, dest], { stdio: 'ignore' });
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

async function finalizeRecording(state: RecordingState, outputPathOverride?: string): Promise<Record<string, unknown>> {
  if (state.stopping) return state.done.promise;
  state.stopping = true;
  if (state.durationTimer) clearTimeout(state.durationTimer);
  recordings.delete(state.id);
  finalizingRecordings.set(state.id, state);

  const warnings = [...state.warnings];
  await detachAudioTap(state).catch(() => undefined);
  const durationMs = Date.now() - state.startedAt;

  let videoPath: string | undefined;
  const video = state.page.video();
  await closeSession(state.id).catch((error) => {
    warnings.push(`Closing the recording context reported: ${error instanceof Error ? error.message : 'unknown error'}.`);
  });
  if (video) {
    const dest = path.join(recordingRoot(), `${state.id}.webm`);
    try {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await video.saveAs(dest);
      videoPath = dest;
    } catch (error) {
      warnings.push(`The normal video save failed; trying Chromium's raw recording file (${error instanceof Error ? error.message : 'unknown error'}).`);
      try {
        const rawPath = await video.path();
        await fs.copyFile(rawPath, dest);
        videoPath = dest;
        warnings.push('Recovered the video from Chromium\'s raw recording file.');
      } catch (fallbackError) {
        warnings.push(`Raw video recovery also failed: ${fallbackError instanceof Error ? fallbackError.message : 'unknown error'}.`);
      }
    }
  } else {
    warnings.push('Chromium did not expose a video artifact for this recording context.');
  }
  await fs.rm(state.videoDir, { recursive: true, force: true }).catch(() => undefined);

  let audioPath: string | undefined;
  if (state.audio && state.audioBytes > 0) {
    try {
      const rate = state.audioRate ?? 48_000;
      const pcm = Buffer.concat(state.audioChunks);
      const header = wavHeader(pcm.length, rate, 2, 16);
      const dest = path.join(recordingRoot(), `${state.id}.wav`);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, Buffer.concat([header, pcm]));
      audioPath = dest;
    } catch (error) {
      warnings.push(`Audio was captured but could not be saved: ${error instanceof Error ? error.message : 'unknown error'}.`);
    }
  } else if (state.audio) {
    warnings.push('No audible page signal was captured; returning the video without an audio track.');
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
      } catch (error) {
        reason = 'mux-failed';
        warnings.push(`ffmpeg could not mux audio and video; both original files remain available (${error instanceof Error ? error.message : 'unknown error'}).`);
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
          await runFfmpegTranscode(ffmpeg, outputPath, dest);
          outputPath = dest;
          warnings.push(`ffmpeg converted the recording to ${destinationExtension}.`);
        } else {
          warnings.push(`Could not create ${destinationExtension} because ffmpeg is unavailable; keeping ${sourceExtension || '.webm'}.`);
        }
      } else {
        warnings.push(`Unsupported output extension ${destinationExtension}; keeping the WebM artifact instead.`);
      }
    } catch (error) {
      warnings.push(`The requested outputPath could not be used; the safe recording-root artifact was kept (${error instanceof Error ? error.message : 'unknown error'}).`);
    }
  }

  const stat = outputPath ? await fs.stat(outputPath).catch(() => undefined) : undefined;
  const success = Boolean(outputPath && stat?.isFile() && stat.size > 0);
  const artifacts = [
    outputPath ? { kind: 'video', path: outputPath, mimeType: mimeForPath(outputPath) ?? 'video/webm', bytes: stat?.size ?? 0 } : undefined,
    audioPath ? { kind: 'audio', path: audioPath, mimeType: 'audio/wav' } : undefined,
  ].filter(Boolean);
  const result: Record<string, unknown> = {
    success,
    recordingId: state.id,
    sessionId: state.id,
    status: success ? 'stopped' : 'failed',
    durationMs,
    requestedResolution: state.requestedResolution,
    effectiveResolution: state.effectiveResolution,
    videoPath,
    audioPath,
    mergedPath,
    outputPath,
    muxed,
    bytes: stat?.size ?? 0,
    artifacts,
    warnings,
    ...(state.setupAttempts.length ? { attempts: state.setupAttempts } : {}),
    ...(reason ? { reason } : {}),
    ...(!success ? {
      error: {
        code: 'RECORDING_FAILED',
        message: 'Chromium did not produce a usable video after the normal save and raw-file recovery attempts.',
        recovery: { suggestedResolution: '1280x720', audio: false },
      },
    } : {}),
    nextAction: success
      ? 'Use outputPath directly; the video is also returned as MCP media when it is small enough.'
      : 'Retry browser_record_start with resolution="720p" and audio=false; warnings contains every attempted recovery.',
  };
  state.done.resolve(result);
  rememberCompleted(result);
  finalizingRecordings.delete(state.id);
  return result;
}

export type StartRecordingArgs = {
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

export async function startRecording(args: StartRecordingArgs, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (recordings.size >= MAX_CONCURRENT_RECORDINGS) {
    throw new BrowserMcpError('SESSION_LIMIT', `The recording limit (${MAX_CONCURRENT_RECORDINGS}) has been reached.`);
  }
  const defaults = defaultViewport();
  const maxWidth = integerEnv('FLUJO_BROWSER_RECORD_MAX_WIDTH', 1920, 640, 3840);
  const maxHeight = integerEnv('FLUJO_BROWSER_RECORD_MAX_HEIGHT', 1080, 360, 2160);
  const resolution = normalizeResolution(args.resolution, args.width, args.height, {
    defaultValue: defaults,
    minWidth: 320,
    minHeight: 240,
    maxWidth,
    maxHeight,
    even: true,
  });
  const maxMs = integerEnv('FLUJO_BROWSER_RECORD_MAX_MS', DEFAULT_RECORD_MAX_MS, 1_000, 30 * 60_000);
  let durationMs: number | undefined;
  if (args.durationMs !== undefined) {
    const parsed = typeof args.durationMs === 'number' ? args.durationMs : Number(args.durationMs);
    if (!Number.isFinite(parsed)) {
      resolution.warnings.push('durationMs was not numeric, so auto-stop was disabled.');
    } else {
      durationMs = Math.min(maxMs, Math.max(250, Math.trunc(parsed)));
      if (durationMs !== Math.trunc(parsed)) {
        resolution.warnings.push(`durationMs was adjusted to ${durationMs}ms.`);
      }
    }
  }
  const audioRequested = !(args.audio === false || (typeof args.audio === 'string' && /^(0|false|no|off)$/i.test(args.audio.trim())));
  const outputPath = typeof args.outputPath === 'string' && args.outputPath.length > 0 ? args.outputPath : undefined;

  if (signal.aborted) throw new BrowserMcpError('CANCELLED', 'The browser request was cancelled.');
  const browser: Browser = await acquireBrowser();
  if (signal.aborted) throw new BrowserMcpError('CANCELLED', 'The browser request was cancelled.');

  const id = randomUUID();
  const setupAttempts: string[] = [];
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let videoDir = '';
  let effectiveResolution: Resolution | undefined;
  const candidates = resolutionFallbacks(resolution.effective)
    .filter(({ width, height }) => width <= maxWidth && height <= maxHeight);
  for (const candidate of candidates) {
    videoDir = await ensureScratchDir(path.join('recordings', `${id}-${candidate.width}x${candidate.height}`));
    try {
      context = await browser.newContext({
        viewport: candidate,
        acceptDownloads: false,
        recordVideo: { dir: videoDir, size: candidate },
      });
      page = await context.newPage();
      effectiveResolution = candidate;
      break;
    } catch (error) {
      setupAttempts.push(`${candidate.width}x${candidate.height}: ${error instanceof Error ? error.message : 'context creation failed'}`);
      await context?.close().catch(() => undefined);
      await fs.rm(videoDir, { recursive: true, force: true }).catch(() => undefined);
      context = undefined;
      page = undefined;
    }
  }
  if (!context || !page || !effectiveResolution) {
    throw new BrowserMcpError(
      'BROWSER_UNAVAILABLE',
      `Could not start video recording after safe resolution fallbacks. ${setupAttempts.join(' | ')}`,
    );
  }
  if (setupAttempts.length > 0) {
    resolution.warnings.push(`Recording recovered at ${effectiveResolution.width}x${effectiveResolution.height} after ${setupAttempts.length} failed resolution attempt(s).`);
  }
  if (signal.aborted) {
    await context.close().catch(() => undefined);
    throw new BrowserMcpError('CANCELLED', 'The browser request was cancelled.');
  }

  const session: BrowserSession = {
    id,
    mode: 'sandbox',
    context,
    page,
    touchedAt: Date.now(),
    documentRequests: 0,
    navigationBlocked: false,
    blockedRequestCount: 0,
  };
  registerSession(session);
  try {
    await installRequestPolicy(context);
  } catch (error) {
    await closeSession(id).catch(() => undefined);
    await fs.rm(videoDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

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
    requestedResolution: resolution.requested,
    effectiveResolution,
    warnings: [...resolution.warnings],
    setupAttempts,
  };
  recordings.set(id, state);

  if (audioRequested) {
    try {
      await attachAudioTap(state);
    } catch (error) {
      state.audio = false;
      state.warnings.push(`Audio capture could not initialize; video recording continues without audio (${error instanceof Error ? error.message : 'unknown error'}).`);
    }
  }

  let sourceLoaded = false;
  const hasSource = [args.source, args.url, args.html, args.filePath]
    .some((value) => typeof value === 'string' && value.trim().length > 0);
  if (hasSource) {
    try {
      const source = await resolveCaptureSource({
        source: args.source,
        url: typeof args.url === 'string' ? args.url : undefined,
        html: typeof args.html === 'string' ? args.html : undefined,
        filePath: typeof args.filePath === 'string' ? args.filePath : undefined,
      });
      state.warnings.push(...source.warnings);
      const rawTimeout = typeof args.timeoutMs === 'number' ? args.timeoutMs : Number(args.timeoutMs);
      const navigationTimeout = Number.isFinite(rawTimeout) ? Math.min(60_000, Math.max(1_000, Math.trunc(rawTimeout))) : 30_000;
      await navigateCaptureSource(page, source, navigationTimeout);
      sourceLoaded = true;
    } catch (error) {
      state.warnings.push(`The initial source could not be loaded; the recording session remains open for browser_navigate (${error instanceof Error ? error.message : 'unknown error'}).`);
    }
  }

  let autoStopAt: number | undefined;
  if (durationMs !== undefined) {
    autoStopAt = Date.now() + durationMs;
    state.durationTimer = setTimeout(() => {
      void finalizeRecording(state, outputPath);
    }, durationMs);
    state.durationTimer.unref?.();
  }

  return {
    success: true,
    recordingId: id,
    sessionId: id,
    status: 'recording',
    startedAt: state.startedAt,
    requestedResolution: state.requestedResolution,
    effectiveResolution: state.effectiveResolution,
    audio: state.audio,
    sourceLoaded,
    ...(autoStopAt ? { autoStopAt, durationMs } : {}),
    warnings: state.warnings,
    ...(setupAttempts.length ? { attempts: setupAttempts } : {}),
    nextAction: autoStopAt
      ? 'Drive this session now; after autoStopAt, call browser_record_stop or browser_record_status with recordingId to retrieve the artifact.'
      : 'Drive this session with browser_navigate/click/type, then call browser_record_stop with recordingId.',
  };
}

export type StopRecordingArgs = { recordingId?: unknown; sessionId?: unknown; outputPath?: unknown };

export async function stopRecording(args: StopRecordingArgs): Promise<Record<string, unknown>> {
  const existing = completedRecording(args);
  const state = resolveRecordingState(args, true);
  if (!state) {
    const finalizing = finalizingRecording(args);
    if (finalizing) return finalizing.done.promise;
    if (existing) return existing;
    throw new BrowserMcpError('NOT_FOUND', 'No matching recording is running or recently completed. Start one with browser_record_start.');
  }
  const outputPath = typeof args.outputPath === 'string' && args.outputPath.length > 0 ? args.outputPath : undefined;
  return finalizeRecording(state, outputPath);
}

export type RecordingStatusArgs = { recordingId?: unknown; sessionId?: unknown };

export function recordingStatus(args: RecordingStatusArgs): Record<string, unknown> {
  const state = resolveRecordingState(args, true);
  if (!state) {
    const finalizing = finalizingRecording(args);
    if (finalizing) {
      return {
        success: true,
        recordingId: finalizing.id,
        sessionId: finalizing.id,
        running: false,
        status: 'finalizing',
        elapsedMs: Date.now() - finalizing.startedAt,
        audioBytes: finalizing.audioBytes,
        effectiveResolution: finalizing.effectiveResolution,
        warnings: finalizing.warnings,
        nextAction: 'Call browser_record_stop with this recordingId; it will wait for finalization and return the artifact.',
      };
    }
    const completed = completedRecording(args);
    if (completed) return { ...completed, running: false };
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
    sessionId: state.id,
    running: !state.stopping,
    elapsedMs: Date.now() - state.startedAt,
    audioBytes: state.audioBytes,
    effectiveResolution: state.effectiveResolution,
    warnings: state.warnings,
    nextAction: 'Continue driving the session, or call browser_record_stop to finalize and retrieve the video.',
  };
}

/** Finalise (never silently drop) every in-flight recording during process shutdown. */
export async function shutdownAllRecordings(): Promise<void> {
  const states = [...recordings.values()];
  await Promise.all([
    ...states.map((state) => finalizeRecording(state).catch(() => undefined)),
    ...[...finalizingRecordings.values()].map((state) => state.done.promise.catch(() => undefined)),
  ]);
  finalizingRecordings.clear();
  completedRecordings.clear();
  latestCompletedId = undefined;
}
