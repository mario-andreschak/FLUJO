/**
 * Regression: node-level MCP roots (issue 46) contributed by a FlowBuilder MCP
 * node bound to the built-in `filesystem` server must actually confine/allow the
 * filesystem tools.
 *
 * Built-in servers enforce confinement directly via loadEffectiveRoots — they
 * never go through the `roots/list` protocol handler — so before the fix a root
 * added on an MCP node was silently ignored and every path read as "outside the
 * configured filesystem roots." This locks in that the node overlay is honored,
 * including relative entries (resolved against the FLUJO data dir).
 */
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// Registry (storage-backed) mocked: no PERSISTED server-level roots, so the only
// confinement comes from the node overlay under test.
jest.mock('@/backend/services/mcp/internal/registry', () => ({
  FILESYSTEM_SERVER_NAME: 'filesystem',
  getInternalServerRoots: jest.fn().mockResolvedValue([]),
}));

// Keep global-var resolution a pure passthrough (no storage/crypto).
jest.mock('@/backend/utils/resolveGlobalVars', () => ({
  resolveGlobalVars: jest.fn(async (v: unknown) => v),
}));

// Point the data dir at a temp dir so relative node roots resolve somewhere real.
// The fallback is needed while Jest evaluates hoisted imports, before beforeEach
// installs the per-test directory.
jest.mock('@/utils/paths', () => ({
  getDataDir: jest.fn(() => (
    (globalThis as typeof globalThis & { __flujoFilesystemNodeDataDir?: string })
      .__flujoFilesystemNodeDataDir ?? process.cwd()
  )),
}));

import { filesystemCallTool } from '@/backend/services/mcp/internal/filesystemTools';
import { setNodeRoots, _resetNodeRootsForTests } from '@/backend/services/mcp/roots';

function text(r: CallToolResult): string {
  return (r.content[0] as { text: string }).text;
}

describe('filesystem confinement honors node-level roots', () => {
  let dataDir: string;
  let workspace: string;

  beforeEach(async () => {
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'flujo-datadir-'));
    (globalThis as typeof globalThis & { __flujoFilesystemNodeDataDir?: string })
      .__flujoFilesystemNodeDataDir = dataDir;
    workspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'flujo-ws-'));
    _resetNodeRootsForTests();
    delete process.env.FLUJO_FS_ROOTS;
  });
  afterEach(async () => {
    _resetNodeRootsForTests();
    delete (globalThis as typeof globalThis & { __flujoFilesystemNodeDataDir?: string })
      .__flujoFilesystemNodeDataDir;
    await fsp.rm(dataDir, { recursive: true, force: true });
    await fsp.rm(workspace, { recursive: true, force: true });
  });

  it('allows an absolute node root and blocks paths outside it', async () => {
    setNodeRoots('filesystem', 'node-1', [workspace]);

    const inside = await filesystemCallTool('write_file', {
      path: path.join(workspace, 'ok.txt'),
      content: 'x',
    });
    expect(inside.isError).toBeUndefined();

    const outside = path.join(os.tmpdir(), `flujo-node-outside-${process.pid}.txt`);
    const blocked = await filesystemCallTool('write_file', { path: outside, content: 'x' });
    expect(blocked.isError).toBe(true);
    expect(text(blocked)).toMatch(/outside/i);
  });

  it('resolves a RELATIVE node root against the FLUJO data dir', async () => {
    // A relative node root like "proj" must map to <dataDir>/proj.
    await fsp.mkdir(path.join(dataDir, 'proj'), { recursive: true });
    setNodeRoots('filesystem', 'node-1', ['proj']);

    const inside = await filesystemCallTool('write_file', {
      path: path.join(dataDir, 'proj', 'ok.txt'),
      content: 'x',
    });
    expect(inside.isError).toBeUndefined();

    // A sibling under the data dir but outside "proj" stays blocked.
    const sibling = await filesystemCallTool('write_file', {
      path: path.join(dataDir, 'elsewhere.txt'),
      content: 'x',
    });
    expect(sibling.isError).toBe(true);
    expect(text(sibling)).toMatch(/outside/i);
  });

  it('honors a file:// node root URI', async () => {
    const { pathToFileURL } = await import('url');
    setNodeRoots('filesystem', 'node-1', [pathToFileURL(workspace).href]);

    const inside = await filesystemCallTool('write_file', {
      path: path.join(workspace, 'via-uri.txt'),
      content: 'x',
    });
    expect(inside.isError).toBeUndefined();
  });
});
