import { promises as fs, type StatsFs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  recordingStatus,
  shutdownAllRecordings,
  startRecording,
  stopRecording,
} from '../../mcp-servers/browser/src/recording';
import { getSession, listSessions, shutdownBrowserRuntime } from '../../mcp-servers/browser/src/runtime';

const mockLaunchBrowser = jest.fn();
jest.mock('patchright', () => ({
  chromium: {
    launch: (...args: unknown[]) => mockLaunchBrowser(...args),
    launchPersistentContext: jest.fn(),
  },
}));

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const OWNER = 'run:recording-duration';
/** A WebM fragment whose pixel width/height elements say 1280x720. */
const WEBM_1280X720 = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0xb0, 0x82, 0x05, 0x00, 0xba, 0x82, 0x02, 0xd0]);

type Fixture = ReturnType<typeof recordingFixture>;

/** One browser context with its own page, screencast and CDP session. */
function contextFixture(savedPaths: string[]) {
  let closed = false;
  let currentPath = '';
  const closeHandlers: Array<() => void> = [];
  const screencast = {
    start: jest.fn(async (options: { path: string }) => { currentPath = options.path; }),
    stop: jest.fn(async () => {
      await fs.writeFile(currentPath, WEBM_1280X720);
      savedPaths.push(currentPath);
    }),
  };
  const page = {
    evaluate: jest.fn(async () => ({ width: 1280, height: 720, dpr: 1 })),
    isClosed: jest.fn(() => closed),
    mainFrame: jest.fn(() => ({})),
    on: jest.fn((event: string, handler: () => void) => {
      if (event === 'close') closeHandlers.push(handler);
    }),
    url: jest.fn(() => 'about:blank'),
    screencast,
  };
  const cdpHandlers = new Map<string, (event: { name: string; payload: string }) => void>();
  const cdp = {
    on: jest.fn((event: string, handler: (event: { name: string; payload: string }) => void) => {
      cdpHandlers.set(event, handler);
    }),
    send: jest.fn(async () => ({})),
    detach: jest.fn(async () => undefined),
  };
  const context = {
    close: jest.fn(async () => {
      if (closed) return;
      closed = true;
      for (const handler of closeHandlers) handler();
    }),
    newPage: jest.fn(async () => page),
    route: jest.fn(async () => undefined),
    addInitScript: jest.fn(async () => undefined),
    newCDPSession: jest.fn(async () => cdp),
  };
  const emitAudio = (pcm: Buffer) => {
    const handler = cdpHandlers.get('Runtime.bindingCalled');
    if (!handler) throw new Error('The audio tap was not attached.');
    const call = (cdp.send.mock.calls as unknown[][]).find(([method]) => method === 'Runtime.addBinding');
    const binding = (call?.[1] as { name: string } | undefined)?.name ?? '';
    handler({ name: binding, payload: JSON.stringify({ rate: 48_000, pcm: pcm.toString('base64') }) });
  };
  return { page, context, screencast, emitAudio };
}

function recordingFixture() {
  const savedPaths: string[] = [];
  const contexts: Array<ReturnType<typeof contextFixture>> = [];
  mockLaunchBrowser.mockResolvedValue({
    close: jest.fn(async () => undefined),
    isConnected: jest.fn(() => true),
    newContext: jest.fn(async () => {
      const created = contextFixture(savedPaths);
      contexts.push(created);
      return created.context;
    }),
    once: jest.fn(),
  });
  const first = () => {
    if (!contexts[0]) throw new Error('No browser context was created.');
    return contexts[0];
  };
  return {
    contexts,
    savedPaths,
    get page() { return first().page; },
    get context() { return first().context; },
    get screencast() { return first().screencast; },
    emitAudio: (pcm: Buffer) => first().emitAudio(pcm),
  };
}

function diskStats(freeBytes: number, totalBytes = 500 * GIB): StatsFs {
  const bsize = 4096;
  return {
    type: 0,
    bsize,
    blocks: Math.floor(totalBytes / bsize),
    bfree: Math.floor(freeBytes / bsize),
    bavail: Math.floor(freeBytes / bsize),
    files: 0,
    ffree: 0,
  };
}

/** Pretend every disk has `free()` bytes available. */
function mockDisk(free: () => number) {
  return jest.spyOn(fs, 'statfs').mockImplementation(async () => diskStats(free()));
}

async function flushIo(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** File writes finish on the I/O thread pool; wait (bounded) until the file reaches `expected` bytes. */
async function sizeOnDisk(filePath: string, expected: number): Promise<number> {
  let size = 0;
  for (let attempt = 0; attempt < 100 && size !== expected; attempt += 1) {
    size = (await fs.stat(filePath).catch(() => undefined))?.size ?? 0;
    if (size !== expected) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return size;
}

describe('browser recording duration, disk limit and kept sessions (#1390)', () => {
  const savedEnv = { ...process.env };
  let root = '';
  let fixture: Fixture;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-record-duration-'));
    process.env.FLUJO_DATA_DIR = root;
    process.env.FLUJO_BROWSER_RECORD_DIR = path.join(root, 'recordings');
    process.env.FLUJO_FFMPEG_PATH = path.join(root, 'missing-ffmpeg');
    delete process.env.FLUJO_BROWSER_RECORD_MAX_MS;
    fixture = recordingFixture();
  });

  afterEach(async () => {
    jest.useRealTimers();
    await shutdownAllRecordings();
    await shutdownBrowserRuntime();
    jest.restoreAllMocks();
    mockLaunchBrowser.mockReset();
    process.env = { ...savedEnv };
    await fs.rm(root, { recursive: true, force: true });
  });

  function useFakeClock() {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  }

  it('honours a six-minute durationMs as given and reports the disk-based limit up front', async () => {
    mockDisk(() => 100 * GIB);
    useFakeClock();
    const startedAt = Date.now();
    const started = await startRecording({ audio: false, durationMs: 360_000 }, new AbortController().signal, OWNER);

    expect(started).toMatchObject({
      success: true,
      status: 'recording',
      durationMs: 360_000,
      autoStopAt: startedAt + 360_000,
      maxDurationMs: expect.any(Number),
      disk: expect.objectContaining({ freeBytes: 100 * GIB, keepFreeBytes: 2 * GIB }),
    });
    expect(started.maxDurationMs as number).toBeGreaterThan(360_000);
    expect(started).not.toHaveProperty('diskWarning');
    expect(JSON.stringify(started.warnings)).not.toMatch(/adjusted/i);

    await jest.advanceTimersByTimeAsync(359_000);
    expect(recordingStatus({ recordingId: started.recordingId }, OWNER)).toMatchObject({ running: true });

    await jest.advanceTimersByTimeAsync(1_500);
    await flushIo();
    const stopped = await stopRecording({ recordingId: started.recordingId }, OWNER);
    expect(stopped).toMatchObject({
      success: true,
      status: 'stopped',
      stopReason: 'auto-stop',
      sessionClosed: false,
      requestedDurationMs: 360_000,
    });
    expect(stopped.durationMs as number).toBeGreaterThanOrEqual(360_000);
  });

  it('keeps the browser session open after stop and records the next part on the same page', async () => {
    mockDisk(() => 100 * GIB);
    const first = await startRecording({ audio: false }, new AbortController().signal, OWNER);
    const sessionId = first.sessionId as string;

    const firstStop = await stopRecording({ recordingId: first.recordingId }, OWNER);
    expect(firstStop).toMatchObject({ success: true, sessionClosed: false, segment: 1, sessionId });
    expect(fixture.context.close).not.toHaveBeenCalled();
    expect(getSession(sessionId, OWNER).page).toBe(fixture.page);

    const second = await startRecording({ sessionId, audio: false }, new AbortController().signal, OWNER);
    expect(second).toMatchObject({ success: true, status: 'recording', sessionId, segment: 2 });
    expect(second.recordingId).not.toBe(first.recordingId);
    expect(fixture.contexts).toHaveLength(1);
    expect(fixture.context.newPage).toHaveBeenCalledTimes(1);
    expect(fixture.screencast.start).toHaveBeenCalledTimes(2);

    const secondStop = await stopRecording({ sessionId, closeSession: true }, OWNER);
    expect(secondStop).toMatchObject({ success: true, sessionClosed: true, segment: 2, recordingId: second.recordingId });
    expect(fixture.context.close).toHaveBeenCalledTimes(1);
    expect(() => getSession(sessionId, OWNER)).toThrow(/does not exist/);
    expect(fixture.savedPaths).toEqual([firstStop.videoPath, secondStop.videoPath]);
    for (const saved of fixture.savedPaths) expect((await fs.stat(saved)).size).toBeGreaterThan(0);
  });

  it('does not idle-expire a session while it is recording, and does once it has stopped', async () => {
    mockDisk(() => 100 * GIB);
    process.env.FLUJO_BROWSER_IDLE_TIMEOUT_MS = '10000';
    useFakeClock();
    const started = await startRecording({ audio: false }, new AbortController().signal, OWNER);
    const sessionId = started.sessionId as string;

    await jest.advanceTimersByTimeAsync(60_000);
    expect(listSessions(OWNER).sessions).toEqual([expect.objectContaining({ sessionId, purpose: 'recording' })]);
    expect(recordingStatus({ recordingId: started.recordingId }, OWNER)).toMatchObject({ running: true });

    const stopped = await stopRecording({ recordingId: started.recordingId }, OWNER);
    expect(stopped).toMatchObject({ success: true, sessionClosed: false });
    expect(listSessions(OWNER).sessions).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(11_000);
    expect(listSessions(OWNER).sessions).toEqual([]);
    await flushIo();
    expect(fixture.context.close).toHaveBeenCalled();
  });

  it('changes when a running recording stops when started again with its sessionId', async () => {
    mockDisk(() => 100 * GIB);
    useFakeClock();
    const started = await startRecording({ audio: false, durationMs: 60_000 }, new AbortController().signal, OWNER);
    await jest.advanceTimersByTimeAsync(30_000);

    const extended = await startRecording(
      { sessionId: started.sessionId, durationMs: 600_000 },
      new AbortController().signal,
      OWNER,
    );
    expect(extended).toMatchObject({ autoStopChanged: true, recordingId: started.recordingId, autoStopAt: Date.now() + 600_000 });

    await jest.advanceTimersByTimeAsync(60_000);
    expect(recordingStatus({ recordingId: started.recordingId }, OWNER)).toMatchObject({ running: true });

    await jest.advanceTimersByTimeAsync(541_000);
    await flushIo();
    expect(await stopRecording({ recordingId: started.recordingId }, OWNER)).toMatchObject({
      status: 'stopped',
      stopReason: 'auto-stop',
      sessionClosed: false,
    });
  });

  it('stops early only when the disk really runs low, keeps what was recorded and the page', async () => {
    let free = 100 * GIB;
    mockDisk(() => free);
    useFakeClock();
    const started = await startRecording({ audio: false, durationMs: 3_600_000 }, new AbortController().signal, OWNER);

    await jest.advanceTimersByTimeAsync(20_000);
    expect(recordingStatus({ recordingId: started.recordingId }, OWNER)).toMatchObject({ running: true });

    free = 300 * MIB;
    await jest.advanceTimersByTimeAsync(5_000);
    await flushIo();
    const stopped = await stopRecording({ recordingId: started.recordingId }, OWNER);
    expect(stopped).toMatchObject({ success: true, stopReason: 'low-disk', sessionClosed: false });
    expect(stopped.warnings).toEqual(expect.arrayContaining([expect.stringContaining('the disk is almost full')]));
    expect(fixture.context.close).not.toHaveBeenCalled();
  });

  it('makes room by closing the oldest kept-open recording session instead of refusing a new recording', async () => {
    mockDisk(() => 100 * GIB);
    process.env.FLUJO_BROWSER_MAX_SESSIONS = '1';
    const first = await startRecording({ audio: false }, new AbortController().signal, OWNER);
    await stopRecording({ recordingId: first.recordingId }, OWNER);

    const second = await startRecording({ audio: false }, new AbortController().signal, OWNER);
    expect(second).toMatchObject({ success: true, status: 'recording' });
    expect(second.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining(`Closed the idle recording session ${first.sessionId as string}`),
    ]));
    expect(fixture.contexts[0]?.context.close).toHaveBeenCalled();
    expect(listSessions(OWNER).sessions).toEqual([expect.objectContaining({ sessionId: second.sessionId })]);
  });

  it('refuses to start on an almost full disk with a clear message instead of failing later', async () => {
    mockDisk(() => 200 * MIB);
    await expect(startRecording({ audio: false }, new AbortController().signal, OWNER)).rejects.toMatchObject({
      code: 'DISK_LOW',
      message: expect.stringContaining('Free some space'),
    });
    expect(mockLaunchBrowser).not.toHaveBeenCalled();
  });

  it('warns up front when durationMs is longer than the free disk space lasts, but still honours it', async () => {
    mockDisk(() => 2 * GIB + 512 * MIB);
    const started = await startRecording({ audio: true, durationMs: 3_600_000, resolution: '720p' }, new AbortController().signal, OWNER);
    expect(started).toMatchObject({ durationMs: 3_600_000, diskWarning: expect.stringContaining('lasts for about') });
    expect(started.maxDurationMs as number).toBeLessThan(3_600_000);
  });

  it('rejects unusable durations with a clear message instead of adjusting them', async () => {
    mockDisk(() => 100 * GIB);
    await expect(startRecording({ durationMs: 'six minutes' }, new AbortController().signal, OWNER))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('number of milliseconds') });

    process.env.FLUJO_BROWSER_RECORD_MAX_MS = '60000';
    await expect(startRecording({ durationMs: 120_000 }, new AbortController().signal, OWNER))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('FLUJO_BROWSER_RECORD_MAX_MS=60000') });
    expect(mockLaunchBrowser).not.toHaveBeenCalled();
  });

  it('writes page audio to a WAV file on disk while recording, with the real length in its header after stop', async () => {
    mockDisk(() => 100 * GIB);
    const started = await startRecording({ audio: true }, new AbortController().signal, OWNER);
    const chunk = Buffer.alloc(4096 * 4, 7);
    fixture.emitAudio(chunk);
    fixture.emitAudio(chunk);

    const wavPath = path.join(process.env.FLUJO_BROWSER_RECORD_DIR as string, `${started.recordingId as string}.wav`);
    expect(await sizeOnDisk(wavPath, 44 + chunk.length * 2)).toBe(44 + chunk.length * 2);

    const stopped = await stopRecording({ recordingId: started.recordingId }, OWNER);
    expect(stopped).toMatchObject({ success: true, audioPath: wavPath });
    const wav = await fs.readFile(wavPath);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(4)).toBe(36 + chunk.length * 2);
    expect(wav.readUInt32LE(40)).toBe(chunk.length * 2);
    expect(wav.readUInt32LE(24)).toBe(48_000);
  });
});
