const loadServerConfigsMock = jest.fn();
const updateServerConfigMock = jest.fn();
const listServerToolsMock = jest.fn();
const deleteServerConfigMock = jest.fn();
jest.mock('@/backend/services/mcp', () => ({
  mcpService: {
    loadServerConfigs: (...args: unknown[]) => loadServerConfigsMock(...args),
    updateServerConfig: (...args: unknown[]) => updateServerConfigMock(...args),
    listServerTools: (...args: unknown[]) => listServerToolsMock(...args),
    deleteServerConfig: (...args: unknown[]) => deleteServerConfigMock(...args),
  },
}));

const installGithubServerMock = jest.fn();
jest.mock('@/backend/services/mcp/githubInstall', () => {
  const actual = jest.requireActual('@/backend/services/mcp/githubInstall');
  return {
    ...actual,
    installGithubServer: (...args: unknown[]) => installGithubServerMock(...args),
  };
});

import {
  installResolvedDirectMcp,
  looksLikeRegistryName,
  parseMcpCommandLine,
  resolveDirectMcpInstall,
} from '@/backend/services/mcp/directInstall';

const fetchMock = jest.fn();
const originalFetch = global.fetch;

beforeAll(() => {
  global.fetch = fetchMock as typeof fetch;
});

afterAll(() => {
  global.fetch = originalFetch;
});

beforeEach(() => {
  jest.clearAllMocks();
  loadServerConfigsMock.mockResolvedValue([]);
  updateServerConfigMock.mockResolvedValue({ name: 'saved' });
  listServerToolsMock.mockResolvedValue({ tools: [{ name: 'ping', description: 'Ping' }] });
  deleteServerConfigMock.mockResolvedValue(undefined);
  installGithubServerMock.mockResolvedValue({ installed: true, serverName: 'repo' });
  fetchMock.mockImplementation(async (url: string) => {
    if (url.includes('/commits/')) {
      return { ok: true, json: async () => ({ sha: 'a'.repeat(40) }) } as Response;
    }
    if (url.includes('/contents/package.json')) {
      const body = Buffer.from(JSON.stringify({
        main: 'dist/index.js',
        packageManager: 'npm@11',
        scripts: { build: 'tsc' },
      })).toString('base64');
      return { ok: true, json: async () => ({ content: body }) } as Response;
    }
    if (url.includes('/contents?')) {
      return { ok: true, json: async () => [{ name: 'package-lock.json' }] } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  });
});

describe('specific MCP source resolution', () => {
  it('keeps owner/name-shaped Registry ids distinct from GitHub URLs', () => {
    expect(looksLikeRegistryName('ai.keenable/web-search')).toBe(true);
    expect(looksLikeRegistryName('https://github.com/acme/mcp-server')).toBe(false);
  });

  it('turns an npx line into an exact argv plan without a shell', async () => {
    expect(parseMcpCommandLine('npx -y "@acme/mcp server" --stdio')).toEqual({
      command: 'npx',
      args: ['-y', '@acme/mcp server', '--stdio'],
    });
    const resolved = await resolveDirectMcpInstall({ source: 'npx -y @acme/mcp', serverName: 'acme' });
    expect(resolved).toEqual(expect.objectContaining({
      kind: 'command',
      plan: expect.objectContaining({ command: 'npx', args: ['-y', '@acme/mcp'], serverName: 'acme' }),
    }));
    expect(() => parseMcpCommandLine('npx -y a; whoami')).toThrow('Shell operators');
    await expect(resolveDirectMcpInstall({
      source: 'npx -y @acme/mcp --token secret-value',
      env: { API_TOKEN: 'secret-value' },
    })).rejects.toThrow('Credential values must be passed only through env or headers');
  });

  it('accepts a hosted URL and a GitHub repository as distinct plans', async () => {
    const remote = await resolveDirectMcpInstall({
      source: 'https://mcp.example.com/v1',
      serverName: 'hosted',
      headers: { Authorization: '${global:TOKEN}' },
    });
    expect(remote).toEqual(expect.objectContaining({
      kind: 'remote',
      plan: expect.objectContaining({ transport: 'streamable', serverUrl: 'https://mcp.example.com/v1' }),
    }));

    const github = await resolveDirectMcpInstall({
      source: 'https://github.com/acme/mcp-server.git',
      serverName: 'acme-github',
      ref: 'v1.2.3',
    });
    expect(github).toEqual(expect.objectContaining({
      kind: 'github',
      plan: expect.objectContaining({
        command: 'git',
        serverName: 'acme-github',
        steps: expect.arrayContaining([
          expect.objectContaining({ label: 'install-dependencies', args: ['npm install --include=dev'] }),
          expect.objectContaining({ label: 'build', args: ['npm run build'] }),
          expect.objectContaining({ label: 'launch', command: 'node', args: ['dist/index.js'] }),
        ]),
      }),
    }));
  });

  it('accepts official server.json and Claude-style mcpServers config', async () => {
    const serverJson = await resolveDirectMcpInstall({
      source: {
        name: 'io.example/search',
        packages: [{
          registryType: 'npm',
          identifier: '@example/search-mcp',
          version: '1.0.0',
          environmentVariables: [{ name: 'SEARCH_KEY', isRequired: true, isSecret: true }],
        }],
      },
      env: { SEARCH_KEY: 'secret' },
    });
    expect(serverJson).toEqual(expect.objectContaining({
      kind: 'server-json',
      missingInputs: [],
      plan: expect.objectContaining({ command: 'npx', args: ['-y', '@example/search-mcp@1.0.0'] }),
    }));

    const config = await resolveDirectMcpInstall({
      source: {
        mcpServers: {
          local: { command: 'uvx', args: ['example-mcp'], env: { MODE: 'safe' } },
        },
      },
    });
    expect(config).toEqual(expect.objectContaining({
      kind: 'config',
      plan: expect.objectContaining({ serverName: 'local', command: 'uvx', args: ['example-mcp'] }),
    }));
  });

  it('requires serverName when a config document contains multiple servers', async () => {
    await expect(resolveDirectMcpInstall({
      source: { mcpServers: { one: { command: 'npx' }, two: { command: 'uvx' } } },
    })).rejects.toThrow('multiple servers');
    await expect(resolveDirectMcpInstall({
      source: { command: 'powershell', args: ['-Command', 'whoami'] },
      serverName: 'unsafe',
    })).rejects.toThrow('Unsupported direct MCP command');
  });

  it('normalizes VS Code servers documents and common HTTP transport aliases', async () => {
    const resolved = await resolveDirectMcpInstall({
      source: { servers: { hosted: { type: 'http', url: 'https://mcp.example.com/api' } } },
    });
    expect(resolved).toEqual(expect.objectContaining({
      kind: 'config',
      plan: expect.objectContaining({ serverName: 'hosted', transport: 'streamable' }),
    }));
  });
});

describe('specific MCP source installation', () => {
  it('saves, connects, and returns the tools for a direct command', async () => {
    const input = { source: 'npx -y @acme/mcp', serverName: 'acme' };
    const resolved = await resolveDirectMcpInstall(input);
    const result = await installResolvedDirectMcp(resolved, input);
    expect(result).toEqual(expect.objectContaining({
      installed: true,
      serverName: 'acme',
      tools: [{ name: 'ping', description: 'Ping' }],
    }));
    expect(updateServerConfigMock).toHaveBeenCalledWith('acme', expect.objectContaining({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@acme/mcp'],
    }));
  });

  it('rolls back a new config that starts with no tools', async () => {
    listServerToolsMock.mockResolvedValue({ tools: [], error: 'handshake failed' });
    const input = { source: 'https://mcp.example.com', serverName: 'dead' };
    const resolved = await resolveDirectMcpInstall(input);
    const result = await installResolvedDirectMcp(resolved, input);
    expect(result).toEqual(expect.objectContaining({ installed: false, worksGateRejected: true }));
    expect(deleteServerConfigMock).toHaveBeenCalledWith('dead');
  });
});
