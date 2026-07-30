import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
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
  name: 'filesystem' | 'bash' | 'flujo',
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
        'run', 'start', 'status', 'wait', 'write_stdin', 'kill', 'list_sessions',
      ]));
    } finally {
      await client.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('serves flujo tools through the authenticated local backend bridge', async () => {
    const token = randomUUID();
    const endpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\flujo-mcp-test-${process.pid}-${randomUUID()}`
      : path.join(os.tmpdir(), `flujo-mcp-test-${process.pid}-${randomUUID()}.sock`);
    const bridge = net.createServer((socket) => {
      socket.setEncoding('utf8');
      socket.once('data', (chunk: string) => {
        const request = JSON.parse(chunk.trim()) as { id: string; token: string; operation: string };
        const result = request.operation === 'listTools'
          ? { tools: [{ name: 'ping', description: 'bridge test', inputSchema: { type: 'object', properties: {} } }] }
          : { content: [{ type: 'text', text: 'pong' }] };
        socket.end(`${JSON.stringify({ id: request.id, result: request.token === token ? result : undefined, error: request.token === token ? undefined : 'unauthorized' })}\n`);
      });
    });
    await new Promise<void>((resolve, reject) => {
      bridge.once('error', reject);
      bridge.listen(endpoint, resolve);
    });
    const client = await connectPackage('flujo', {
      FLUJO_MCP_BRIDGE_ENDPOINT: endpoint,
      FLUJO_MCP_BRIDGE_TOKEN: token,
    });
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(['ping']);
      const called = await client.callTool({ name: 'ping', arguments: {} });
      expect(called.content).toEqual([{ type: 'text', text: 'pong' }]);
    } finally {
      await client.close();
      await new Promise<void>((resolve) => bridge.close(() => resolve()));
      if (process.platform !== 'win32') await fs.rm(endpoint, { force: true });
    }
  });
});
