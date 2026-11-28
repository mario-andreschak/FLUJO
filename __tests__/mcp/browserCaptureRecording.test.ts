import { promises as fs } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { bundledMcpEntry } from '../helpers/bundledMcpEntry';

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
  const entry = bundledMcpEntry('browser');
  const client = new Client({ name: 'browser-capture-recording-test', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: processEnv({
      FLUJO_DATA_DIR: dataDir,
      FLUJO_BROWSER_SCREENSHOT_DIR: path.join(dataDir, 'screenshots'),
      FLUJO_BROWSER_RECORD_DIR: path.join(dataDir, 'recordings'),
      FLUJO_BROWSER_STREAM_ENABLED: '0',
      FLUJO_FFMPEG_PATH: path.join(dataDir, 'definitely-not-ffmpeg'),
    }),
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    stderr = (stderr + chunk.toString()).slice(-8_000);
  });
  try {
    await client.connect(transport);
  } catch (error) {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    throw new Error(`Browser MCP startup failed: ${error instanceof Error ? error.message : String(error)}\n${stderr || '(no stderr output)'}`);
  }
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
    let client: Client | undefined;
    try {
      client = await connectBrowser(root);
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
      await client?.close().catch(() => undefined);
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
    let client: Client | undefined;
    try {
      client = await connectBrowser(root);
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
      await client?.close().catch(() => undefined);
      await closeServer(page.server);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the page and its state open after stop, then records a second part on the same page', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-browser-record-parts-'));
    const page = await localPage(`<!doctype html>
      <button id="count" onclick="this.textContent = String(Number(this.textContent) + 1)">0</button>`);
    let client: Client | undefined;
    try {
      client = await connectBrowser(root);
      const started = await client.callTool({
        name: 'browser_record_start',
        arguments: { source: page.url, resolution: '720p', audio: false, durationMs: 360_000 },
      });
      expect(started.isError).not.toBe(true);
      const first = started.structuredContent as {
        sessionId: string; recordingId: string; durationMs: number; maxDurationMs: number | null; warnings: string[];
      };
      expect(first).toMatchObject({ status: 'recording', sourceLoaded: true, durationMs: 360_000 });
      expect(first.warnings.join(' ')).not.toMatch(/adjusted/i);
      const { sessionId } = first;

      for (let click = 0; click < 3; click += 1) {
        await client.callTool({ name: 'browser_click', arguments: { sessionId, selector: '#count' } });
      }
      const firstStop = await client.callTool(
        { name: 'browser_record_stop', arguments: { recordingId: first.recordingId } },
        undefined,
        { timeout: 30_000 },
      );
      expect(firstStop.isError).not.toBe(true);
      const firstResult = firstStop.structuredContent as { outputPath: string; warnings: string[] };
      expect(firstStop.structuredContent).toMatchObject({ success: true, status: 'stopped', sessionClosed: false, segment: 1 });
      expect(firstResult.warnings.join(' ')).not.toMatch(/raw recording file|temporary copy/);
      expect((await fs.stat(firstResult.outputPath)).size).toBeGreaterThan(0);

      const snapshot = await client.callTool({ name: 'browser_snapshot', arguments: { sessionId } });
      expect(snapshot.isError).not.toBe(true);
      expect((snapshot.structuredContent as { text: string }).text.trim()).toBe('3');

      const second = await client.callTool({ name: 'browser_record_start', arguments: { sessionId, audio: false } });
      expect(second.isError).not.toBe(true);
      expect(second.structuredContent).toMatchObject({ status: 'recording', sessionId, segment: 2 });
      await client.callTool({ name: 'browser_click', arguments: { sessionId, selector: '#count' } });
      const secondStop = await client.callTool(
        { name: 'browser_record_stop', arguments: { sessionId, closeSession: true } },
        undefined,
        { timeout: 30_000 },
      );
      expect(secondStop.structuredContent).toMatchObject({ success: true, sessionClosed: true, segment: 2 });
      const secondResult = secondStop.structuredContent as { outputPath: string };
      expect(secondResult.outputPath).not.toBe(firstResult.outputPath);
      expect((await fs.stat(secondResult.outputPath)).size).toBeGreaterThan(0);
      const listed = await client.callTool({ name: 'browser_list_sessions', arguments: {} });
      expect((listed.structuredContent as { sessions: unknown[] }).sessions).toEqual([]);
    } finally {
      await client?.close().catch(() => undefined);
      await closeServer(page.server);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('records a page opened with browser_open without reloading it, and leaves it open with its state', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-browser-record-open-'));
    const page = await localPage(`<!doctype html>
      <p id="load"></p>
      <div><button id="count" onclick="this.textContent = String(Number(this.textContent) + 1)">0</button></div>
      <div><button id="tone">tone</button></div>
      <script>
        document.querySelector('#load').textContent = 'load-' + Math.random().toString(36).slice(2);
        document.querySelector('#tone').onclick = () => {
          const context = new AudioContext();
          const oscillator = context.createOscillator();
          oscillator.connect(context.destination);
          oscillator.start();
          setTimeout(() => { oscillator.stop(); context.close(); }, 900);
        };
      </script>`);
    let client: Client | undefined;
    try {
      client = await connectBrowser(root);
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await client!.callTool({ name, arguments: args }, undefined, { timeout: 30_000 });
        expect(result.isError).not.toBe(true);
        return result.structuredContent as Record<string, unknown>;
      };
      const pageText = async (sessionId: string) => String((await call('browser_snapshot', { sessionId })).text);
      const videoSize = async (file: string) => (await fs.stat(file)).size;

      const { sessionId } = await call('browser_open', { url: page.url }) as { sessionId: string };
      await call('browser_click', { sessionId, selector: '#count' });
      await call('browser_click', { sessionId, selector: '#count' });
      const loadMark = /load-\w+/.exec(await pageText(sessionId))?.[0];
      expect(loadMark).toBeDefined();

      const started = await call('browser_record_start', { sessionId, audio: true });
      expect(started).toMatchObject({
        success: true,
        status: 'recording',
        sessionId,
        segment: 1,
        effectiveResolution: { width: 1280, height: 720 },
        actualViewport: { width: 1280, height: 720 },
      });
      expect(started).not.toHaveProperty('sourceLoaded');
      expect(started.warnings).toEqual(expect.arrayContaining([expect.stringContaining('the live view is turned off')]));
      await call('browser_click', { sessionId, selector: '#count' });
      await call('browser_click', { sessionId, selector: '#tone' });
      const during = await call('browser_screenshot', { sessionId });
      expect(during).toMatchObject({ recordingId: started.recordingId, recordingGeometry: expect.objectContaining({ viewportPolicy: 'fixed' }) });
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect((await call('browser_record_status', { sessionId })).audioBytes as number).toBeGreaterThan(0);

      const stopped = await call('browser_record_stop', { sessionId });
      expect(stopped).toMatchObject({
        success: true,
        status: 'stopped',
        sessionId,
        segment: 1,
        sessionClosed: false,
        actualEncodedVideoResolution: { width: 1280, height: 720 },
        audioPath: expect.any(String),
      });
      expect(await videoSize(stopped.outputPath as string)).toBeGreaterThan(0);
      expect(await videoSize(stopped.audioPath as string)).toBeGreaterThan(44);

      const afterFirst = await pageText(sessionId);
      expect(afterFirst).toContain(loadMark);
      expect(afterFirst).toMatch(/^3$/m);
      const listed = await call('browser_list_sessions', {});
      expect(listed.sessions).toEqual([expect.objectContaining({ sessionId, purpose: 'interactive' })]);
      const idle = await call('browser_screenshot', { sessionId });
      expect(idle).toMatchObject({ viewport: { width: 1280, height: 720 } });
      expect(idle).not.toHaveProperty('recordingId');

      const second = await call('browser_record_start', { sessionId, audio: false, resolution: '640x360' });
      expect(second).toMatchObject({ status: 'recording', sessionId, segment: 2, effectiveResolution: { width: 640, height: 360 } });
      expect(second.warnings).toEqual(expect.arrayContaining([expect.stringContaining('resized from 1280x720 to 640x360')]));
      await call('browser_click', { sessionId, selector: '#count' });
      const secondStop = await call('browser_record_stop', { sessionId });
      expect(secondStop).toMatchObject({
        success: true,
        sessionClosed: false,
        segment: 2,
        actualEncodedVideoResolution: { width: 640, height: 360 },
      });
      expect(secondStop.outputPath).not.toBe(stopped.outputPath);
      expect(await videoSize(secondStop.outputPath as string)).toBeGreaterThan(0);

      const afterSecond = await pageText(sessionId);
      expect(afterSecond).toContain(loadMark);
      expect(afterSecond).toMatch(/^4$/m);
      expect(await call('browser_screenshot', { sessionId })).toMatchObject({ viewport: { width: 1280, height: 720 } });
      expect(await call('browser_close', { sessionId })).toMatchObject({ closed: true });
    } finally {
      await client?.close().catch(() => undefined);
      await closeServer(page.server);
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
