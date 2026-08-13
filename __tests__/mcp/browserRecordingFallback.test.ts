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
    const video = {
      path: jest.fn(async () => path.join(root, 'raw.webm')),
      saveAs: jest.fn(async (destination: string) => fs.writeFile(destination, Buffer.from('WEBM_BYTES'))),
    };
    const page = {
      isClosed: jest.fn(() => closed),
      mainFrame: jest.fn(() => ({})),
      on: jest.fn(),
      url: jest.fn(() => 'about:blank'),
      video: jest.fn(() => video),
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
        attempts: [expect.stringContaining('encoder rejected')],
      });
      expect(newContext).toHaveBeenNthCalledWith(1, expect.objectContaining({
        recordVideo: expect.objectContaining({ size: { width: 1920, height: 1080 } }),
      }));
      expect(newContext).toHaveBeenNthCalledWith(2, expect.objectContaining({
        recordVideo: expect.objectContaining({ size: { width: 1280, height: 720 } }),
      }));

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
