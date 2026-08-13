import { promises as fs } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

jest.setTimeout(45_000);

function processEnv(extra: Record<string, string>): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    ...extra,
  };
}

type BrowserToolContentItem = {
  type: string;
  resource?: { mimeType?: string };
};

function browserToolContent(value: unknown): BrowserToolContentItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is BrowserToolContentItem => (
    typeof item === 'object'
    && item !== null
    && 'type' in item
    && typeof item.type === 'string'
  ));
}

async function connectBrowser(dataDir: string): Promise<Client> {
  const client = new Client({ name: 'browser-capture-recording-test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve('mcp-servers/browser/dist/index.js')],
    env: processEnv({
      FLUJO_DATA_DIR: dataDir,
      FLUJO_BROWSER_SCREENSHOT_DIR: path.join(dataDir, 'screenshots'),
      FLUJO_BROWSER_RECORD_DIR: path.join(dataDir, 'recordings'),
      FLUJO_BROWSER_STREAM_ENABLED: '0',
      FLUJO_FFMPEG_PATH: path.join(dataDir, 'definitely-not-ffmpeg'),
    }),
    stderr: 'pipe',
  }));
  return client;
}

async function localPage(html: string): Promise<{ server: HttpServer; url: string }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` };
}

async function closeServer(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe('browser capture and recording process boundary', () => {
  it('captures localhost, local files, and active sessions without policy flags', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-browser-capture-e2e-'));
    const page = await localPage('<!doctype html><h1 id="ready">local capture</h1>');
    const localFile = path.join(root, 'local-page.html');
    await fs.writeFile(localFile, '<!doctype html><h1>file capture</h1>');
    const client = await connectBrowser(root);
    try {
      for (const source of [page.url, localFile]) {
        const result = await client.callTool({
          name: 'browser_capture_page',
          arguments: { source, resolution: 'not-a-resolution' },
        });
        expect(result.isError).not.toBe(true);
        expect(browserToolContent(result.content).some((item) => item.type === 'image')).toBe(true);
        expect(result.structuredContent).toMatchObject({
          success: true,
          effectiveResolution: { width: 1920, height: 1080 },
          mimeType: 'image/png',
        });
        const outputPath = (result.structuredContent as { path: string }).path;
        await expect(fs.stat(outputPath)).resolves.toMatchObject({ size: expect.any(Number) });
      }

      const opened = await client.callTool({ name: 'browser_open', arguments: { url: page.url } });
      const sessionId = (opened.structuredContent as { sessionId: string }).sessionId;
      const active = await client.callTool({
        name: 'browser_capture_page',
        arguments: { sessionId, selector: '#ready', resolution: '720p' },
      });
      expect(active.isError).not.toBe(true);
      expect(active.structuredContent).toMatchObject({ success: true, selector: '#ready' });
    } finally {
      await client.close();
      await closeServer(page.server);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('returns a drivable timed session, captures navigated audio, survives auto-stop races, and emits video media', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-browser-record-e2e-'));
    const page = await localPage(`<!doctype html>
      <button id="tone">tone</button>
      <script>
        document.querySelector('#tone').onclick = () => {
          const context = new AudioContext();
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          gain.gain.value = 0.2;
          oscillator.connect(gain).connect(context.destination);
          oscillator.start();
          setTimeout(() => { oscillator.stop(); context.close(); }, 900);
        };
      </script>`);
    const client = await connectBrowser(root);
    try {
      const started = await client.callTool({
        name: 'browser_record_start',
        arguments: { source: page.url, resolution: '4k', durationMs: 1_500, audio: true },
      });
      expect(started.isError).not.toBe(true);
      expect(started.structuredContent).toMatchObject({
        success: true,
        status: 'recording',
        sourceLoaded: true,
        requestedResolution: { width: 3840, height: 2160 },
        effectiveResolution: { width: 1920, height: 1080 },
        audio: true,
      });
      const recordingId = (started.structuredContent as { recordingId: string }).recordingId;

      await client.callTool({
        name: 'browser_click',
        arguments: { sessionId: recordingId, selector: '#tone' },
      });
      await new Promise((resolve) => setTimeout(resolve, 700));
      const running = await client.callTool({
        name: 'browser_record_status',
        arguments: { recordingId },
      });
      expect((running.structuredContent as { audioBytes: number }).audioBytes).toBeGreaterThan(0);

      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const stopped = await client.callTool(
        { name: 'browser_record_stop', arguments: { recordingId } },
        undefined,
        { timeout: 30_000 },
      );
      expect(stopped.isError).not.toBe(true);
      expect(stopped.structuredContent).toMatchObject({
        success: true,
        status: 'stopped',
        recordingId,
        audioPath: expect.any(String),
        outputPath: expect.any(String),
      });
      expect(browserToolContent(stopped.content).some((item) =>
        item.type === 'resource' && item.resource?.mimeType === 'video/webm'
      )).toBe(true);
      const outputPath = (stopped.structuredContent as { outputPath: string }).outputPath;
      expect((await fs.stat(outputPath)).size).toBeGreaterThan(0);
    } finally {
      await client.close();
      await closeServer(page.server);
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
