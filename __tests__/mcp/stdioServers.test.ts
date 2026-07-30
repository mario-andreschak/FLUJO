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
