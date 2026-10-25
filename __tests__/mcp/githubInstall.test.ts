import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { EventEmitter } from 'events';

const spawnMock = jest.fn();
jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return { ...actual, spawn: (...args: unknown[]) => spawnMock(...args) };
});

const cloneMock = jest.fn();
const remoteMock = jest.fn();
const statusMock = jest.fn();
const rawMock = jest.fn();
const gitEnvMock = jest.fn();
jest.mock('simple-git', () => ({
  __esModule: true,
  simpleGit: jest.fn(() => ({
    env(value: unknown) { gitEnvMock(value); return this; },
    clone: (...args: unknown[]) => cloneMock(...args),
    remote: (...args: unknown[]) => remoteMock(...args),
    status: (...args: unknown[]) => statusMock(...args),
    raw: (...args: unknown[]) => rawMock(...args),
  })),
}));

let mockDataDir = '';
let mockWorkspaceDataDir = '';
jest.mock('@/utils/workspace', () => ({
  getWorkspaceDataDir: () => mockWorkspaceDataDir,
}));

const updateServerConfigMock = jest.fn();
jest.mock('@/backend/services/mcp', () => ({
  mcpService: {
    updateServerConfig: (...args: unknown[]) => updateServerConfigMock(...args),
  },
}));

import {
  installGithubServer,
  prepareGithubServerRuntime,
  parseGithubRepositoryReference,
} from '@/backend/services/mcp/githubInstall';

let mockPackageJson: Record<string, unknown>;
let mockCreateEntry = true;

function successfulChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    pid: number;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 1234;
  setImmediate(() => {
    child.stdout.emit('data', Buffer.from('command output\n'));
    child.stderr.emit('data', Buffer.from('command warning\n'));
    child.emit('close', 0);
  });
  return child;
}

async function writeProject(repoPath: string): Promise<void> {
  await fs.mkdir(path.join(repoPath, '.git'), { recursive: true });
  for (const relative of ['', 'packages/server']) {
    const projectPath = path.join(repoPath, relative);
    await fs.mkdir(path.join(projectPath, 'dist'), { recursive: true });
    await fs.writeFile(path.join(projectPath, 'package.json'), JSON.stringify(mockPackageJson));
    if (mockCreateEntry) {
      await fs.writeFile(path.join(projectPath, 'dist/server.js'), 'console.log("server")');
    }
  }
}

beforeEach(async () => {
  jest.clearAllMocks();
  mockDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-github-install-'));
  mockWorkspaceDataDir = path.join(mockDataDir, 'workspaces', 'default-workspace');
  mockPackageJson = {
    bin: { server: './dist/server.js' },
    packageManager: 'pnpm@10.0.0',
    scripts: { compile: 'tsc' },
  };
  mockCreateEntry = true;
  cloneMock.mockImplementation(async (_url: unknown, target: unknown) => {
    await writeProject(String(target));
  });
  remoteMock.mockResolvedValue('https://github.com/acme/server.git\n');
  statusMock.mockResolvedValue({ isClean: () => true });
  rawMock.mockResolvedValue('');
  spawnMock.mockImplementation(() => successfulChild());
  updateServerConfigMock.mockResolvedValue({ success: true });
});

afterEach(async () => {
  await fs.rm(mockDataDir, { recursive: true, force: true });
});

describe('parseGithubRepositoryReference', () => {
  it('separates legacy owner/repo@ref syntax', () => {
    expect(parseGithubRepositoryReference('acme/server@v2.1.0')).toEqual({
      repositoryUrl: 'https://github.com/acme/server',
      ref: 'v2.1.0',
    });
  });

  it('keeps a URL and explicit ref separate', () => {
    expect(parseGithubRepositoryReference(
      'https://github.com/acme/server.git',
      'release/2.x',
    )).toEqual({
      repositoryUrl: 'https://github.com/acme/server.git',
      ref: 'release/2.x',
    });
  });

  it('rejects unsafe repository transports and refs', () => {
    expect(() => parseGithubRepositoryReference('file:///tmp/server')).toThrow(/unsafe/i);
    expect(() => parseGithubRepositoryReference('acme/server', '--upload-pack=x')).toThrow(/ref/i);
  });
});

describe('installGithubServer', () => {
  it.each([
    { isolation: null },
    { isolation: {
      schemaVersion: 1, kind: 'docker-deny-egress', image: `sha256:${'a'.repeat(64)}`,
      dockerExecutable: path.join(os.tmpdir(), 'docker'),
      daemon: process.platform === 'win32' ? 'npipe:////./pipe/dockerDesktopLinuxEngine' : 'unix:///var/run/docker.sock',
      command: ['node', 'server.js'], environmentNames: [], mounts: [], memoryMiB: 128, cpus: 0.5, pidsLimit: 32,
    } },
    { trustedHost: null },
    { trustedHost: {
      schemaVersion: 1, kind: 'trusted-host', privileges: 'owner-account', runtime: 'native',
      entryPoint: process.execPath, sourceRoot: os.tmpdir(), runtimeHome: 'host',
      sourceDigest: 'a'.repeat(64), executableDigest: 'b'.repeat(64), environmentNames: [],
    } },
  ])('refuses explicit runtime profile selection before cloning: %j', async selection => {
    const envReplacement = jest.replaceProperty(process, 'env', { NODE_ENV: 'production' });
    try {
      const result = await prepareGithubServerRuntime({
        name: 'server', repositoryUrl: 'https://github.com/acme/server.git', env: {}, ...selection,
      });
      expect(result).toEqual({
        installed: false,
        error: expect.stringMatching(/Host install\/build is not supported by runtime execution grants/),
      });
      expect(cloneMock).not.toHaveBeenCalled();
      expect(rawMock).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      envReplacement.restore();
    }
  });

  it.each([
    ['FLUJO_OWNER_AUTH_FILE', ''], ['FLUJO_OWNER_AUTH_FILE', 'missing-synthetic-policy'],
    ['FLUJO_MCP_TRUSTED_HOST_FILE', ''], ['FLUJO_MCP_TRUSTED_HOST_FILE', 'missing-synthetic-policy'],
    ['FLUJO_MCP_ISOLATION_FILE', ''], ['FLUJO_MCP_ISOLATION_FILE', 'missing-synthetic-policy'],
    ['FLUJO_WORKER_MODE', '1'],
  ])('refuses protected host installation before cloning for %s=%s', async (name, value) => {
    const envReplacement = jest.replaceProperty(process, 'env', { NODE_ENV: 'production', [name]: value });
    try {
      const result = await prepareGithubServerRuntime({
        name: 'server', repositoryUrl: 'https://github.com/acme/server.git', env: {},
      });
      expect(result).toEqual({
        installed: false,
        error: expect.stringMatching(/Host install\/build is not supported by runtime execution grants/),
      });
      expect(cloneMock).not.toHaveBeenCalled();
      expect(rawMock).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
      expect(updateServerConfigMock).not.toHaveBeenCalled();
    } finally {
      envReplacement.restore();
    }
  });

  it('scopes the host environment for both install and build commands', async () => {
    const envReplacement = jest.replaceProperty(process, 'env', {
      NODE_ENV: 'production',
      PATH: 'synthetic-toolchain-path',
      HOME: 'synthetic-installer-home',
      OPENAI_API_KEY: 'synthetic-provider-secret',
      FLUJO_API_KEY: 'synthetic-flujo-secret',
      NODE_OPTIONS: '--require synthetic-loader',
      NPM_CONFIG_USERCONFIG: 'synthetic-auth-config',
      npm_config_include: 'optional',
    });
    try {
      const result = await prepareGithubServerRuntime({
        name: 'server', repositoryUrl: 'https://github.com/acme/server.git',
        ref: 'release/2.x',
        env: { API_TOKEN: 'synthetic-server-secret', LOG_LEVEL: 'debug' },
        secretEnvNames: ['API_TOKEN'],
      });

      expect(result.installed).toBe(true);
      expect(gitEnvMock).toHaveBeenCalledTimes(2);
      for (const [gitEnv] of gitEnvMock.mock.calls) {
        expect(gitEnv).toEqual({
          NODE_ENV: 'production',
          PATH: 'synthetic-toolchain-path',
          HOME: 'synthetic-installer-home',
          npm_config_include: 'dev',
        });
      }
      expect(rawMock).toHaveBeenCalledWith(['fetch', '--depth=1', 'origin', 'release/2.x']);
      expect(spawnMock).toHaveBeenCalledTimes(2);
      for (const [, options] of spawnMock.mock.calls) {
        expect(options.env).toEqual({
          NODE_ENV: 'production',
          PATH: 'synthetic-toolchain-path',
          HOME: 'synthetic-installer-home',
          npm_config_include: 'dev',
        });
      }
      expect(process.env.npm_config_include).toBe('optional');
    } finally {
      envReplacement.restore();
    }
  });

  it('prepares a target runtime without saving or connecting a partially restored server', async () => {
    const result = await prepareGithubServerRuntime({
      name: 'restored-server', repositoryUrl: 'https://github.com/acme/server.git', env: {},
    });
    expect(result.installed).toBe(true);
    expect(result.config?.rootPath).toContain(mockWorkspaceDataDir);
    expect(result.config?.name).toBe('restored-server');
    expect(spawnMock).toHaveBeenCalled();
    expect(updateServerConfigMock).not.toHaveBeenCalled();
  });

  it('runs reviewed commands portably in the requested ref/subdirectory and saves secret metadata', async () => {
    const result = await installGithubServer({
      name: 'server',
      repositoryUrl: 'https://github.com/acme/server.git',
      ref: 'release/2.x',
      subdirectory: 'packages/server',
      installCommand: 'pnpm install --frozen-lockfile',
      buildCommand: 'pnpm run compile',
      env: { API_TOKEN: 'super-secret', LOG_LEVEL: 'debug' },
      secretEnvNames: ['API_TOKEN'],
      disabled: true,
      folder: 'package-folder',
    });

    expect(result).toEqual({ installed: true, serverName: 'server' });
    expect(cloneMock).toHaveBeenCalledWith(
      'https://github.com/acme/server.git',
      expect.stringMatching(/acme-server-[a-f0-9]{10}$/),
      { '--depth': 1 },
    );
    expect(rawMock).toHaveBeenNthCalledWith(
      1,
      ['fetch', '--depth=1', 'origin', 'release/2.x'],
    );
    expect(rawMock).toHaveBeenNthCalledWith(2, ['checkout', '--detach', 'FETCH_HEAD']);

    expect(spawnMock).toHaveBeenNthCalledWith(
      1,
      'pnpm install --frozen-lockfile',
      expect.objectContaining({
        shell: true,
        cwd: expect.stringMatching(/[\\/]packages[\\/]server$/),
      }),
    );
    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      'pnpm run compile',
      expect.objectContaining({ shell: true }),
    );
    expect(spawnMock.mock.calls[0][1]).toEqual(expect.objectContaining({
      env: expect.objectContaining({ npm_config_include: 'dev' }),
    }));

    expect(updateServerConfigMock).toHaveBeenCalledWith(
      'server',
      expect.objectContaining({
        command: 'node',
        args: ['./dist/server.js'],
        disabled: true,
        folder: 'package-folder',
        env: {
          API_TOKEN: { value: 'super-secret', metadata: { isSecret: true } },
          LOG_LEVEL: 'debug',
        },
        source: {
          type: 'github',
          repositoryUrl: 'https://github.com/acme/server.git',
          ref: 'release/2.x',
          subdirectory: 'packages/server',
        },
        _installCommand: 'pnpm install --frozen-lockfile',
        _buildCommand: 'pnpm run compile',
      }),
    );
  });

  it('derives package-manager-specific commands for legacy manifests', async () => {
    mockPackageJson = {
      main: 'dist/server.js',
      packageManager: 'yarn@4.5.0',
      scripts: { build: 'tsc' },
    };

    const result = await installGithubServer({
      name: 'server',
      repositoryUrl: 'acme/server',
      env: {},
    });

    expect(result.installed).toBe(true);
    expect(spawnMock.mock.calls.map((call) => call[0])).toEqual([
      'yarn install',
      'yarn build',
    ]);
  });

  it('uses distinct clone paths for repositories with the same basename', async () => {
    await installGithubServer({
      name: 'one',
      repositoryUrl: 'https://github.com/one/server.git',
      env: {},
    });
    remoteMock.mockResolvedValue('https://github.com/two/server.git\n');
    await installGithubServer({
      name: 'two',
      repositoryUrl: 'https://github.com/two/server.git',
      env: {},
    });

    const firstPath = cloneMock.mock.calls[0][1];
    const secondPath = cloneMock.mock.calls[1][1];
    expect(firstPath).not.toBe(secondPath);
  });

  it('does not save a server when the built entry point is missing', async () => {
    mockCreateEntry = false;

    const result = await installGithubServer({
      name: 'server',
      repositoryUrl: 'https://github.com/acme/server.git',
      env: {},
    });

    expect(result).toEqual(expect.objectContaining({
      installed: false,
      error: expect.stringMatching(/entry point/i),
    }));
    expect(updateServerConfigMock).not.toHaveBeenCalled();
  });
});
