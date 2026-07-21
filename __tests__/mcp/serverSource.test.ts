/**
 * Tests for install-origin metadata (#193).
 *
 * Two contract points:
 *  1. Every server built from a registry entry (Marketplace / Spotlight / headless
 *     installRegistryServer all funnel through buildConfigFromOption) carries a
 *     machine-readable `source: { type: 'registry', ... }`.
 *  2. loadServerConfigs() backfills `source` for existing configs that predate the
 *     field: remote transports -> `remote`; a stdio clone under mcp-servers/ whose
 *     git origin resolves -> `github`; everything else (incl. git failure) -> `local`.
 *     An already-present `source` is never overwritten.
 */

import path from 'path';

// config.ts computes REPOS_BASE_DIR from getDataDir() at module load, so getDataDir
// must be mocked before it is imported. Pin it to a deterministic absolute dir.
const DATA_DIR = path.join(process.cwd(), '__source_test_data');
jest.mock('@/utils/paths', () => ({
  getDataDir: () => path.join(process.cwd(), '__source_test_data'),
  getAppDir: () => process.cwd(),
}));

// A shared fake git object whose `remote` behaviour each test controls.
jest.mock('simple-git', () => {
  const git: { remote: jest.Mock } = { remote: jest.fn() };
  return { __esModule: true, default: jest.fn(() => git), __git: git };
});

jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(),
  saveItem: jest.fn(),
}));

import { RegistryServer, getInstallOptions, buildConfigFromOption } from '@/utils/mcp/registry';
import { loadServerConfigs } from '@/backend/services/mcp/config';
import { MCPServerConfig, MCPServerSource } from '@/shared/types/mcp';

const { loadItem } = jest.requireMock('@/utils/storage/backend') as { loadItem: jest.Mock };
const { __git: mockGit } = jest.requireMock('simple-git') as { __git: { remote: jest.Mock } };

const REPOS_BASE = path.join(DATA_DIR, 'mcp-servers');

beforeEach(() => {
  jest.clearAllMocks();
});

const sourceOf = (c: MCPServerConfig): MCPServerSource | undefined =>
  (c as MCPServerConfig & { source?: MCPServerSource }).source;

describe('buildConfigFromOption install-origin (#193)', () => {
  it('stamps a registry source (with version) on an npm package install', () => {
    const server: RegistryServer = {
      name: 'io.github.acme/voice',
      packages: [
        { registryType: 'npm', identifier: '@acme/voice', version: '2.1.0', transport: { type: 'stdio' } },
      ],
    };
    const option = getInstallOptions(server).find(o => o.kind === 'package')!;
    const config = buildConfigFromOption(server, option);
    expect(sourceOf(config as MCPServerConfig)).toEqual({
      type: 'registry',
      registryName: 'io.github.acme/voice',
      version: '2.1.0',
    });
  });

  it('stamps a registry source on a remote install (no package version)', () => {
    const server: RegistryServer = {
      name: 'io.github.acme/weather',
      version: '1.0.0',
      remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp' }],
    };
    const option = getInstallOptions(server).find(o => o.kind === 'remote')!;
    const config = buildConfigFromOption(server, option);
    expect(sourceOf(config as MCPServerConfig)).toEqual({
      type: 'registry',
      registryName: 'io.github.acme/weather',
      version: '1.0.0',
    });
  });
});

describe('loadServerConfigs install-origin backfill (#193)', () => {
  const load = async (stored: Record<string, unknown>) => {
    loadItem.mockResolvedValue(stored);
    const result = await loadServerConfigs();
    expect(Array.isArray(result)).toBe(true);
    return result as MCPServerConfig[];
  };

  it('backfills a stdio server outside mcp-servers/ as local (no git call)', async () => {
    const configs = await load({
      'hand-rolled': {
        transport: 'stdio',
        command: 'node',
        args: [],
        rootPath: path.join(DATA_DIR, 'somewhere-else', 'hand-rolled'),
      },
    });
    expect(sourceOf(configs.find(c => c.name === 'hand-rolled')!)).toEqual({ type: 'local' });
    expect(mockGit.remote).not.toHaveBeenCalled();
  });

  it('backfills a clone under mcp-servers/ as github from its origin remote', async () => {
    mockGit.remote.mockResolvedValue('https://github.com/acme/cloned-server.git\n');
    const configs = await load({
      'cloned-server': {
        transport: 'stdio',
        command: 'node',
        args: [],
        rootPath: path.join(REPOS_BASE, 'cloned-server'),
      },
    });
    expect(sourceOf(configs.find(c => c.name === 'cloned-server')!)).toEqual({
      type: 'github',
      repositoryUrl: 'https://github.com/acme/cloned-server.git',
    });
    expect(mockGit.remote).toHaveBeenCalledWith(['get-url', 'origin']);
  });

  it('falls back to local when the git remote lookup fails', async () => {
    mockGit.remote.mockRejectedValue(new Error('not a git repository'));
    const configs = await load({
      'broken-clone': {
        transport: 'stdio',
        command: 'node',
        args: [],
        rootPath: path.join(REPOS_BASE, 'broken-clone'),
      },
    });
    expect(sourceOf(configs.find(c => c.name === 'broken-clone')!)).toEqual({ type: 'local' });
  });

  it('backfills remote transports as remote without touching git', async () => {
    const configs = await load({
      'hosted': { transport: 'streamable', serverUrl: 'https://x.example/mcp', rootPath: 'mcp-servers/hosted' },
    });
    expect(sourceOf(configs.find(c => c.name === 'hosted')!)).toEqual({ type: 'remote' });
    expect(mockGit.remote).not.toHaveBeenCalled();
  });

  it('never overwrites an already-persisted source', async () => {
    const configs = await load({
      'already-sourced': {
        transport: 'stdio',
        command: 'node',
        args: [],
        rootPath: path.join(REPOS_BASE, 'already-sourced'),
        source: { type: 'registry', registryName: 'io.github.acme/thing', version: '3.0.0' },
      },
    });
    expect(sourceOf(configs.find(c => c.name === 'already-sourced')!)).toEqual({
      type: 'registry',
      registryName: 'io.github.acme/thing',
      version: '3.0.0',
    });
    expect(mockGit.remote).not.toHaveBeenCalled();
  });
});
