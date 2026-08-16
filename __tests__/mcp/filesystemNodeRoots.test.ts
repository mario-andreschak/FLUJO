/**
 * Regression: node-level MCP roots (issue 46) contributed by a FlowBuilder MCP
 * node bound to the shipped `filesystem` package must actually confine/allow the
 * filesystem tools.
 *
 * Confined server packages enforce roots directly via loadEffectiveRoots — they
 * never go through the `roots/list` protocol handler — so before the fix a root
 * added on an MCP node was silently ignored and every path read as "outside the
 * configured filesystem roots." This locks in that the node overlay is honored,
 * including relative entries (resolved against the selected workspace data dir).
 */
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// Ordinary persisted-config loader mocked with no server-level roots, so the
// only confinement comes from the node overlay under test.
jest.mock('@/backend/services/mcp/config', () => ({
  loadServerRoots: jest.fn().mockResolvedValue([]),
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
jest.mock('@/utils/workspace', () => {
  const actual = jest.requireActual('@/utils/workspace');
  return {
    ...actual,
    getWorkspaceDataDir: () => (
      (globalThis as typeof globalThis & { __flujoFilesystemNodeWorkspaceDir?: string })
        .__flujoFilesystemNodeWorkspaceDir ?? actual.getWorkspaceDataDir()
    ),
  };
});

import { filesystemCallTool } from '@/backend/services/mcp/internal/filesystemTools';
import { setNodeRoots, _resetNodeRootsForTests } from '@/backend/services/mcp/roots';

function text(r: CallToolResult): string {
  return (r.content[0] as { text: string }).text;
}

describe('filesystem confinement honors node-level roots', () => {
  let dataDir: string;
  let workspace: string;
  let workspaceDataDir: string;

  beforeEach(async () => {
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'flujo-datadir-'));
    (globalThis as typeof globalThis & { __flujoFilesystemNodeDataDir?: string })
      .__flujoFilesystemNodeDataDir = dataDir;
    workspaceDataDir = path.join(dataDir, 'workspaces', 'default-workspace');
    (globalThis as typeof globalThis & { __flujoFilesystemNodeWorkspaceDir?: string })
      .__flujoFilesystemNodeWorkspaceDir = workspaceDataDir;
    workspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'flujo-ws-'));
    _resetNodeRootsForTests();
    delete process.env.FLUJO_FS_ROOTS;
  });
  afterEach(async () => {
    _resetNodeRootsForTests();
    delete (globalThis as typeof globalThis & { __flujoFilesystemNodeDataDir?: string })
      .__flujoFilesystemNodeDataDir;
    delete (globalThis as typeof globalThis & { __flujoFilesystemNodeWorkspaceDir?: string })
      .__flujoFilesystemNodeWorkspaceDir;
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

  it('resolves a RELATIVE node root against the selected workspace data dir', async () => {
    // A relative node root like "proj" maps inside the selected workspace.
    await fsp.mkdir(path.join(workspaceDataDir, 'proj'), { recursive: true });
    setNodeRoots('filesystem', 'node-1', ['proj']);

    const inside = await filesystemCallTool('write_file', {
      path: path.join(workspaceDataDir, 'proj', 'ok.txt'),
      content: 'x',
    });
    expect(inside.isError).toBeUndefined();

    // A sibling in the workspace but outside "proj" stays blocked.
    const sibling = await filesystemCallTool('write_file', {
      path: path.join(workspaceDataDir, 'elsewhere.txt'),
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
