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
import { RegistryServer, getInstallOptions, buildConfigFromOption } from '@/utils/mcp/registry';
import { loadServerConfigs } from '@/backend/services/mcp/config';
import { MCPServerConfig } from '@/shared/types/mcp';
import { POST } from '@/app/api/git/route';

const { loadItem } = jest.requireMock('@/utils/storage/backend') as { loadItem: jest.Mock };
const { __git: mockGit } = jest.requireMock('simple-git') as any;

const req = (body: unknown) => ({ json: async () => body }) as any;

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
