import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

jest.setTimeout(30_000);

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    ...extra,
  };
}

async function connectPackage(
  name: 'filesystem' | 'bash' | 'browser' | 'flujo',
  env: Record<string, string> = {},
  roots: string[] = [],
): Promise<Client> {
  const client = new Client(
    { name: 'flujo-stdio-package-test', version: '1.0.0' },
    { capabilities: { roots: { listChanged: true } } },
  );
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: roots.map((root) => ({ uri: pathToFileURL(path.resolve(root)).toString() })),
  }));
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve(process.cwd(), 'mcp-servers', name, 'dist', 'index.js')],
    env: cleanEnv(env),
    stderr: 'pipe',
  }));
  return client;
}

describe('standalone stdio MCP packages', () => {
  it('serves the filesystem schema and confined structured results', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-mcp-filesystem-'));
    const client = await connectPackage('filesystem', { FLUJO_FS_ROOTS: root, FLUJO_DATA_DIR: root }, [root]);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        'read_file', 'write_file', 'edit_file', 'list_dir', 'search', 'get_allowed_directories',
      ]));
      const called = await client.callTool({ name: 'get_allowed_directories', arguments: {} });
      expect(called.structuredContent).toEqual({ directories: [path.resolve(root)] });

      await fs.writeFile(path.join(root, 'searchable.txt'), 'first\npackaged search token\nlast');
      const searched = await client.callTool({
        name: 'search',
        arguments: { path: root, content: 'search token' },
      });
      expect(searched.isError).not.toBe(true);
      expect(searched.structuredContent).toEqual(expect.objectContaining({
        matches: [expect.objectContaining({
          path: path.join(root, 'searchable.txt'),
          line: 2,
          text: 'packaged search token',
        })],
        truncated: false,
      }));
    } finally {
      await client.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('serves bash tools from an independent child process', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-mcp-bash-'));
    const client = await connectPackage('bash', { FLUJO_BASH_ROOTS: root, FLUJO_DATA_DIR: root }, [root]);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        'run', 'start', 'status', 'wait', 'sleep', 'write_stdin', 'kill', 'list_sessions',
      ]));
      const slept = await client.callTool({ name: 'sleep', arguments: { seconds: 0.02 } });
      expect(slept.isError).not.toBe(true);
      const sleepContent = (slept as { content?: Array<{ type?: string; text?: unknown }> }).content;
      const sleepText = sleepContent?.[0]?.text;
      expect(typeof sleepText).toBe('string');
      expect(JSON.parse(String(sleepText))).toEqual(expect.objectContaining({
        slept: true,
        requestedSeconds: 0.02,
      }));
      const quickCommand = process.platform === 'win32'
        ? "Write-Output 'wait-finished'"
        : "printf 'wait-finished\\n'";
      const started = await client.callTool({
        name: 'start',
        arguments: { command: quickCommand, cwd: root },
      });
      const startText = (started as { content?: Array<{ type?: string; text?: unknown }> }).content?.[0]?.text;
      expect(typeof startText).toBe('string');
      const sessionId = (JSON.parse(String(startText)) as { sessionId?: string }).sessionId;
      expect(sessionId).toBeTruthy();
      const waited = await client.callTool({
        name: 'wait',
        arguments: { sessionId, timeout: 10 },
      });
      const waitText = (waited as { content?: Array<{ type?: string; text?: unknown }> }).content?.[0]?.text;
      expect(typeof waitText).toBe('string');
      expect(JSON.parse(String(waitText))).toEqual(expect.objectContaining({
        running: false,
        timedOut: false,
        requestedTimeoutMs: 10_000,
        returnedEarly: true,
        remainingSeconds: expect.any(Number),
        hint: expect.stringContaining('call sleep'),
      }));
      const progressMessages: string[] = [];
      const command = process.platform === 'win32'
        ? "Write-Output 'progress-one'; Start-Sleep -Milliseconds 150; Write-Output 'progress-two'"
        : "printf 'progress-one\\n'; sleep 0.15; printf 'progress-two\\n'";
      const called = await client.callTool(
        { name: 'run', arguments: { command, cwd: root, timeout: 10 } },
        undefined,
        {
          timeout: 15_000,
          resetTimeoutOnProgress: true,
          onprogress: (progress) => {
            if (progress.message) progressMessages.push(progress.message);
          },
        },
      );
      expect(called.isError).not.toBe(true);
      expect(progressMessages.join('')).toContain('progress-one');
      expect(progressMessages.join('')).toContain('progress-two');

      const runtime = await client.callTool({
        name: 'run',
        arguments: { command: 'node --version', cwd: root, timeout: 10 },
      });
      expect(runtime.isError).not.toBe(true);
      const runtimeContent = (runtime as { content?: Array<{ type?: string; text?: unknown }> }).content;
      const runtimeText = runtimeContent?.[0]?.text;
      expect(runtimeContent?.[0]?.type).toBe('text');
      expect(typeof runtimeText).toBe('string');
      if (typeof runtimeText !== 'string') throw new Error('Expected the run tool to return text content');
      const runtimePayload = JSON.parse(runtimeText) as { output?: string };
      expect(runtimePayload.output).toMatch(/^v\d+/);
    } finally {
      await client.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('serves the interactive browser and reports an absolute screenshot artifact', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-mcp-browser-'));
    const client = await connectPackage('browser', { FLUJO_DATA_DIR: dataDir });
    let sessionId = '';
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        'browser_open', 'browser_click', 'browser_type', 'browser_press', 'browser_scroll',
      ]));
      const opened = await client.callTool({ name: 'browser_open', arguments: {} });
      if (opened.isError) {
        const errorCode = (opened.structuredContent as {
          error?: { code?: string };
        } | undefined)?.error?.code;
        if (errorCode === 'BROWSER_UNAVAILABLE') return;
        throw new Error(
          `browser_open failed unexpectedly: ${JSON.stringify(opened.structuredContent)}`,
        );
      }
      sessionId = (opened.structuredContent as { sessionId: string }).sessionId;
      expect(sessionId).toBeTruthy();
      const reopened = await client.callTool({ name: 'browser_open', arguments: {} });
      expect((reopened.structuredContent as { sessionId: string }).sessionId).toBe(sessionId);

      const screenshot = await client.callTool({
        name: 'browser_screenshot',
        arguments: {},
      });
      const screenshotPath = (screenshot.structuredContent as { path: string }).path;
      expect(path.isAbsolute(screenshotPath)).toBe(true);
      expect(screenshotPath).toBe(path.join(
        path.resolve(dataDir),
        'screenshots',
        'browser',
        sessionId,
        'viewport.png',
      ));
      expect((await fs.stat(screenshotPath)).isFile()).toBe(true);
    } finally {
      if (sessionId) {
        await client.callTool({ name: 'browser_close', arguments: {} }).catch(() => undefined);
      }
      await client.close();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it('serves flujo tools through the localhost control API', async () => {
    const backend = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.method === 'GET' && request.url === '/api/mcp/flujo/tools') {
        response.end(JSON.stringify({
          tools: [{ name: 'list_flows', description: 'HTTP test', inputSchema: { type: 'object', properties: {} } }],
        }));
        return;
      }
      if (request.method === 'POST' && request.url === '/api/mcp/flujo/flows') {
        response.end(JSON.stringify({ content: [{ type: 'text', text: 'pong' }] }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'not found' }));
    });
    await new Promise<void>((resolve, reject) => {
      backend.once('error', reject);
      backend.listen(0, '127.0.0.1', resolve);
    });
    const { port } = backend.address() as AddressInfo;
    const client = await connectPackage('flujo', {
      FLUJO_BASE_URL: `http://127.0.0.1:${port}`,
    });
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(['list_flows']);
      const called = await client.callTool({ name: 'list_flows', arguments: {} });
      expect(called.content).toEqual([{ type: 'text', text: 'pong' }]);
    } finally {
      await client.close();
      await new Promise<void>((resolve) => backend.close(() => resolve()));
    }
  });
});
