/**
 * Tests for issue 52: remote servers must not default their "server root dir"
 * (rootPath) to '/'.
 *
 * Contract points:
 *  - the Marketplace/registry remote install option defaults rootPath to
 *    mcp-servers/<name> (matching the stdio convention), never '/'
 *  - loadServerConfigs() normalizes already-saved remote configs whose rootPath is a
 *    bare filesystem root ('/', '\', 'C:\') to mcp-servers/<name>; stdio configs and
 *    custom remote rootPaths are untouched
 *  - the /api/git route refuses to run git operations (checkUpdates / pullUpdates /
 *    clone) against a filesystem root
 */

jest.mock('simple-git', () => {
  const git: any = {
    clone: jest.fn(),
    revparse: jest.fn(),
    remote: jest.fn(),
    listRemote: jest.fn(),
    raw: jest.fn(),
  };
  return {
    __esModule: true,
    default: jest.fn(() => git),
    __git: git,
  };
});

jest.mock('uuid', () => ({ v4: () => 'test-request-id' }));
jest.mock('@/utils/mcp', () => ({ processPathLikeArgument: (p: string) => p }));
jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(),
  saveItem: jest.fn(),
}));

import path from 'path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { RegistryServer, getInstallOptions, buildConfigFromOption } from '@/utils/mcp/registry';
import { loadServerConfigs } from '@/backend/services/mcp/config';
import { MCPServerConfig } from '@/shared/types/mcp';
import { POST } from '@/app/api/git/route';
import { getDataDir } from '@/utils/paths';
import { getWorkspaceDataDir } from '@/utils/workspace';

const { loadItem } = jest.requireMock('@/utils/storage/backend') as { loadItem: jest.Mock };
const { __git: mockGit } = jest.requireMock('simple-git') as any;

// The route enforces the localhost origin guard (#131), which reads
// request.headers.get('host'|'origin'); supply a localhost Host so these
// git-action tests exercise the real handler, not the 403 short-circuit.
const req = (body: unknown) =>
  ({ json: async () => body, headers: new Headers({ host: 'localhost:4200' }) }) as any;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('registry buildRemoteConfig rootPath default (issue 52)', () => {
  const server: RegistryServer = {
    name: 'io.github.example/weather-mcp',
    description: 'Weather data for MCP',
    version: '1.0.0',
    remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp' }],
  };

  it('defaults rootPath to mcp-servers/<name>, never "/"', () => {
    const options = getInstallOptions(server);
    const remoteOption = options.find(o => o.kind === 'remote');
    expect(remoteOption).toBeDefined();

    const config = buildConfigFromOption(server, remoteOption!);
    expect(config.rootPath).toBe('mcp-servers/weather-mcp');
    expect(config.rootPath).not.toBe('/');
  });
});

describe('loadServerConfigs rootPath normalization (issue 52)', () => {
  const load = async (stored: Record<string, unknown>) => {
    loadItem.mockResolvedValue(stored);
    const result = await loadServerConfigs();
    expect(Array.isArray(result)).toBe(true);
    return result as MCPServerConfig[];
  };

  it('rewrites a "/" rootPath on remote transports to mcp-servers/<name>', async () => {
    const configs = await load({
      'api-example': { transport: 'streamable', serverUrl: 'https://x.example/mcp', rootPath: '/' },
      'sse-example': { transport: 'sse', serverUrl: 'https://y.example/sse', rootPath: '\\' },
      'drive-example': { transport: 'streamable', serverUrl: 'https://z.example/mcp', rootPath: 'C:\\' },
    });
    expect(configs.find(c => c.name === 'api-example')!.rootPath).toBe('mcp-servers/api-example');
    expect(configs.find(c => c.name === 'sse-example')!.rootPath).toBe('mcp-servers/sse-example');
    expect(configs.find(c => c.name === 'drive-example')!.rootPath).toBe('mcp-servers/drive-example');
  });

  it('leaves custom remote rootPaths and stdio configs untouched', async () => {
    const configs = await load({
      'custom-remote': { transport: 'streamable', serverUrl: 'https://x.example/mcp', rootPath: 'C:\\work\\my-folder' },
      'stdio-slash': { transport: 'stdio', command: 'node', args: [], rootPath: '/' },
      'stdio-normal': { transport: 'stdio', command: 'node', args: [], rootPath: 'mcp-servers/stdio-normal' },
    });
    expect(configs.find(c => c.name === 'custom-remote')!.rootPath).toBe('C:\\work\\my-folder');
    // stdio configs keep whatever they had — the normalization is remote-only.
    expect(configs.find(c => c.name === 'stdio-slash')!.rootPath).toBe('/');
    expect(configs.find(c => c.name === 'stdio-normal')!.rootPath).toBe('mcp-servers/stdio-normal');
  });

  it('remaps migrated managed paths throughout launch specs, roots and argv flags', async () => {
    const owner = 'legacy-launch-remap';
    const legacyOwner = path.join(getDataDir(), 'mcp-servers', owner);
    const migratedOwner = path.join(getWorkspaceDataDir(), 'mcp-servers', owner);
    await fs.rm(legacyOwner, { recursive: true, force: true });
    await fs.mkdir(path.join(migratedOwner, 'bin'), { recursive: true });
    const legacyEntry = path.join(legacyOwner, 'bin', 'server.js');
    const migratedEntry = path.join(migratedOwner, 'bin', 'server.js');
    const configs = await load({
      legacy: {
        transport: 'streamable',
        serverUrl: 'http://localhost:4321/mcp',
        rootPath: legacyOwner,
        roots: [pathToFileURL(legacyOwner).href],
        env: {
          CONFIG_PATH: path.join(legacyOwner, 'config.json'),
          SECRET_PATH: { value: legacyEntry, metadata: { isSecret: true } },
        },
        launch: {
          command: legacyEntry,
          cwd: legacyOwner,
          args: [`--config=${path.join(legacyOwner, 'config.json')}`],
          env: { LAUNCH_CONFIG: path.join(legacyOwner, 'launch.json') },
        },
      },
    });
    const config = configs[0] as MCPServerConfig & {
      launch: { command: string; cwd: string; args: string[] };
    };
    expect(config.rootPath).toBe(migratedOwner);
    expect(config.roots).toEqual([pathToFileURL(migratedOwner).href]);
    expect(config.env).toEqual(expect.objectContaining({
      CONFIG_PATH: path.join(migratedOwner, 'config.json'),
      SECRET_PATH: { value: migratedEntry, metadata: { isSecret: true } },
    }));
    expect(config.launch).toEqual(expect.objectContaining({
      command: migratedEntry,
      cwd: migratedOwner,
      args: [`--config=${path.join(migratedOwner, 'config.json')}`],
      env: { LAUNCH_CONFIG: path.join(migratedOwner, 'launch.json') },
    }));
    await fs.rm(migratedOwner, { recursive: true, force: true });
  });
});

describe('/api/git filesystem-root guard (issue 52)', () => {
  const fsRoot = path.parse(process.cwd()).root; // '/' on POSIX, 'C:\' on Windows

  it('checkUpdates reports an error for a filesystem root without touching git', async () => {
    const res = await POST(req({ action: 'checkUpdates', savePath: fsRoot }));
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.isGitRepo).toBe(false);
    expect(body.error).toMatch(/filesystem root/i);
    expect(mockGit.revparse).not.toHaveBeenCalled();
    expect(mockGit.raw).not.toHaveBeenCalled();
  });

  it('pullUpdates rejects a filesystem root with 400 without touching git', async () => {
    const res = await POST(req({ action: 'pullUpdates', savePath: fsRoot }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/filesystem root/i);
    expect(mockGit.raw).not.toHaveBeenCalled();
  });

  it('clone rejects a filesystem root save path with 400 without touching git', async () => {
    const res = await POST(req({
      action: 'clone',
      repoUrl: 'https://github.com/foo/bar.git',
      savePath: fsRoot,
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/filesystem root/i);
    expect(mockGit.clone).not.toHaveBeenCalled();
  });
});
