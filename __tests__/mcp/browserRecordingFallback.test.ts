import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shutdownAllRecordings, startRecording, stopRecording } from '../../mcp-servers/browser/src/recording';
import { shutdownBrowserRuntime } from '../../mcp-servers/browser/src/runtime';

const mockLaunchBrowser = jest.fn();
jest.mock('patchright', () => ({
  chromium: {
    launch: (...args: unknown[]) => mockLaunchBrowser(...args),
    launchPersistentContext: jest.fn(),
  },
}));

describe('browser recording recovery', () => {
  const savedEnv = { ...process.env };

  afterEach(async () => {
    await shutdownAllRecordings();
    await shutdownBrowserRuntime();
    mockLaunchBrowser.mockReset();
    process.env = { ...savedEnv };
  });

  it('retries a failed encoder size and keeps a safe WebM when MP4 conversion is unavailable', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-record-fallback-'));
    process.env.FLUJO_DATA_DIR = root;
    process.env.FLUJO_BROWSER_RECORD_DIR = path.join(root, 'recordings');
    process.env.FLUJO_FFMPEG_PATH = path.join(root, 'missing-ffmpeg');

    let closed = false;
    let videoPath = '';
    const screencast = {
      start: jest.fn(async (options: { path: string }) => { videoPath = options.path; }),
      stop: jest.fn(async () => fs.writeFile(videoPath, Buffer.from('WEBM_BYTES'))),
    };
    const page = {
      evaluate: jest.fn(async () => ({ width: 1280, height: 720, dpr: 1 })),
      isClosed: jest.fn(() => closed),
      mainFrame: jest.fn(() => ({})),
      on: jest.fn(),
      url: jest.fn(() => 'about:blank'),
      screencast,
    };
    const context = {
      close: jest.fn(async () => { closed = true; }),
      newPage: jest.fn(async () => page),
      route: jest.fn(async () => undefined),
    };
    const newContext = jest.fn()
      .mockRejectedValueOnce(new Error('Chromium encoder rejected 1920x1080'))
      .mockResolvedValueOnce(context);
    mockLaunchBrowser.mockResolvedValue({
      close: jest.fn(async () => undefined),
      isConnected: jest.fn(() => true),
      newContext,
      once: jest.fn(),
    });

    try {
      const started = await startRecording(
        { resolution: '1080p', audio: false },
        new AbortController().signal,
      );
      expect(started).toMatchObject({
        success: true,
        status: 'recording',
        requestedResolution: { width: 1920, height: 1080 },
        effectiveResolution: { width: 1280, height: 720 },
        actualViewport: { width: 1280, height: 720 },
        deviceScaleFactor: 1,
        configuredVideoResolution: { width: 1280, height: 720 },
        geometryMismatch: false,
        attempts: [expect.stringContaining('encoder rejected')],
      });
      expect(newContext).toHaveBeenNthCalledWith(1, expect.objectContaining({
        viewport: { width: 1920, height: 1080 },
      }));
      expect(newContext).toHaveBeenNthCalledWith(2, expect.objectContaining({
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 1,
      }));
      expect(screencast.start).toHaveBeenCalledWith(expect.objectContaining({ size: { width: 1280, height: 720 } }));

      const stopped = await stopRecording({
        recordingId: started.recordingId,
        outputPath: path.join(root, 'requested.mp4'),
      });
      expect(stopped).toMatchObject({
        success: true,
        status: 'stopped',
        outputPath: expect.stringMatching(/\.webm$/),
        warnings: expect.arrayContaining([
          expect.stringContaining('ffmpeg is unavailable'),
        ]),
      });
      expect((await fs.stat(stopped.outputPath as string)).size).toBeGreaterThan(0);
    } finally {
      await shutdownAllRecordings();
      await shutdownBrowserRuntime();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
