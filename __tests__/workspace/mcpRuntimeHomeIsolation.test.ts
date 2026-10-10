import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveStdioLaunch } from '@/backend/services/mcp/connection';
import { createShippedServerConfig, SHIPPED_MCP_SERVERS } from '@/backend/services/mcp/shippedServers';
import {
  ensureWorkspaceDirs,
  getWorkspaceDataDir,
  remapLegacyDefaultWorkspacePath,
  remapLegacyDefaultWorkspaceReference,
  runWithWorkspace,
} from '@/utils/workspace';
import type { MCPStdioConfig } from '@/shared/types/mcp';
import { fingerprintTrustedHostSource, trustedHostEnvironment, trustedHostMcpPolicySchema } from '@/backend/services/security/trustedHostMcp';
import { installTrustedHostProfile } from '../mcp/fixtures/trustedHostProfile';
import { materializeProtectedPackageRunner } from '../mcp/fixtures/protectedPackageRunner';

const priorDataDir = process.env.FLUJO_DATA_DIR;
const priorParentDataDir = process.env.FLUJO_PARENT_DATA_DIR;
const priorPlaywrightBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
let dataRoot: string;

beforeAll(async () => {
  dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-mcp-runtime-isolation-'));
  process.env.FLUJO_PARENT_DATA_DIR = dataRoot;
  process.env.FLUJO_DATA_DIR = dataRoot;
  await ensureWorkspaceDirs();
  await ensureWorkspaceDirs('runtime-a');
  await ensureWorkspaceDirs('runtime-b');
});

afterAll(async () => {
  if (priorParentDataDir === undefined) delete process.env.FLUJO_PARENT_DATA_DIR;
  else process.env.FLUJO_PARENT_DATA_DIR = priorParentDataDir;
  if (priorDataDir === undefined) delete process.env.FLUJO_DATA_DIR;
  else process.env.FLUJO_DATA_DIR = priorDataDir;
  if (priorPlaywrightBrowsersPath === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
  else process.env.PLAYWRIGHT_BROWSERS_PATH = priorPlaywrightBrowsersPath;
  await fs.rm(dataRoot, { recursive: true, force: true });
});

afterEach(() => {
  if (priorPlaywrightBrowsersPath === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
  else process.env.PLAYWRIGHT_BROWSERS_PATH = priorPlaywrightBrowsersPath;
});

const config: MCPStdioConfig = {
  name: 'same/user-controlled-server',
  transport: 'stdio',
  command: 'node',
  args: [],
  env: {
    HOME: 'C:\\host-home',
    USERPROFILE: 'C:\\host-profile',
    XDG_CONFIG_HOME: '/host/config',
    NPM_CONFIG_CACHE: '/host/npm-cache',
    FLUJO_PARENT_DATA_DIR: 'C:\\stale-parent',
  },
  disabled: false,
  rootPath: '',
  _buildCommand: '',
  _installCommand: '',
};

const resolveIsolatedLaunch = (server: MCPStdioConfig) =>
  resolveStdioLaunch(server, { isolateRuntimeHome: true });

// These existing Node positives use a fixed real source and a private grant.
// This helper does not authorize the distinct dynamic package-runner contract.
function resolveApprovedFixedNode(server: MCPStdioConfig, isolated = false) {
  const sourceRoot = path.join(getWorkspaceDataDir(), server.rootPath || 'mcp-servers/runtime-home-fixture');
  const entryPoint = path.join(sourceRoot, 'runtime-home-fixture.cjs');
  syncFs.mkdirSync(sourceRoot, { recursive: true });
  syncFs.writeFileSync(entryPoint, 'process.exitCode = 0;\n');
  const fixture = installTrustedHostProfile({ name: server.name, nodeSource: 'process.exitCode = 0;\n',
    environment: Object.fromEntries(trustedHostEnvironment(server)), runtimeHome: isolated ? 'isolated' : 'host' });
  try {
    process.env.FLUJO_PARENT_DATA_DIR = dataRoot;
    process.env.FLUJO_DATA_DIR = dataRoot;
    const approved: MCPStdioConfig = { ...server, ...fixture.config, rootPath: server.rootPath,
      cwd: sourceRoot, args: [entryPoint], trustedHost: { ...fixture.config.trustedHost!,
        entryPoint, sourceRoot, sourceDigest: fingerprintTrustedHostSource(sourceRoot) } };
    fixture.approve(approved);
    return resolveStdioLaunch(approved, { isolateRuntimeHome: isolated });
  } finally {
    fixture.restore();
  }
}

describe('stdio MCP runtime homes', () => {
  it('does not isolate runtime homes unless the resolved policy opts in', () => {
    const launch = runWithWorkspace('runtime-a', () => resolveApprovedFixedNode(config));

    expect(launch.env.HOME).toBe(config.env.HOME);
    expect(launch.env.USERPROFILE).toBe(config.env.USERPROFILE);
    expect(launch.env.NPM_CONFIG_CACHE).toBe(config.env.NPM_CONFIG_CACHE);
    expect(launch.cwd).not.toContain(`${path.sep}userdata${path.sep}mcp-runtime${path.sep}`);
  });

  it('requires private consent before applying runtime-home launch policy', () => {
    expect(() => runWithWorkspace('runtime-a', () => resolveStdioLaunch(config)))
      .toThrow(expect.objectContaining({ code: 'HOST_CONSENT_REQUIRED' }));
  });

  it('rejects legacy bundled Bash redirects until its host launch is reviewed', () => {
    const bash = SHIPPED_MCP_SERVERS.find(item => item.defaultName === 'bash')!;
    const tracked = ['HOME', 'USERPROFILE', 'APPDATA', 'GH_CONFIG_DIR', 'FLUJO_BASH_HOST_ENV_TEST'] as const;
    const previous = new Map(tracked.map(key => [key, process.env[key]]));
    const hostHome = path.join(dataRoot, 'real-host-home');
    const hostAppData = path.join(hostHome, 'AppData', 'Roaming');

    try {
      process.env.HOME = hostHome;
      process.env.USERPROFILE = hostHome;
      process.env.APPDATA = hostAppData;
      process.env.FLUJO_BASH_HOST_ENV_TEST = 'visible-from-host';
      delete process.env.GH_CONFIG_DIR;

      const shipped = createShippedServerConfig(bash);
      // Existing installations used this package ID. They must still be
      // recognized as the bundled host terminal instead of a third-party MCP.
      shipped.source = { type: 'marketplace', id: '@flujo-ai/mcp-bash' };
      shipped.env = {
        ...shipped.env,
        HOME: path.join(dataRoot, 'stale-private-home'),
        USERPROFILE: path.join(dataRoot, 'stale-private-profile'),
        APPDATA: path.join(dataRoot, 'stale-private-appdata'),
        GH_CONFIG_DIR: path.join(dataRoot, 'stale-gh-config'),
      };

      expect(() => runWithWorkspace('runtime-a', () => resolveIsolatedLaunch(shipped)))
        .toThrow(expect.objectContaining({ code: 'HOST_CONSENT_REQUIRED' }));
    } finally {
      for (const key of tracked) {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('forces conventional home, config, cache, temp and FLUJO roots per workspace', () => {
    const launchA = runWithWorkspace('runtime-a', () => resolveApprovedFixedNode(config, true));
    const launchB = runWithWorkspace('runtime-b', () => resolveApprovedFixedNode(config, true));
    const rootA = getWorkspaceDataDir('runtime-a');
    const rootB = getWorkspaceDataDir('runtime-b');

    for (const [launch, root] of [[launchA, rootA], [launchB, rootB]] as const) {
      expect(path.relative(root, launch.env.HOME)).not.toMatch(/^\.\.(?:[\\/]|$)/);
      expect(launch.env.USERPROFILE).toBe(launch.env.HOME);
      expect(launch.env.FLUJO_PARENT_DATA_DIR).toBe(dataRoot);
      expect(launch.env.FLUJO_DATA_DIR).toBe(root);
      expect(launch.env.XDG_CONFIG_HOME).toBe(path.join(launch.env.HOME, '.config'));
      expect(launch.env.NPM_CONFIG_CACHE).toBe(path.join(launch.env.HOME, '.npm'));
      expect(launch.env.TMP).toBe(path.join(launch.env.HOME, 'tmp'));
    }
    expect(launchA.env.HOME).not.toBe(launchB.env.HOME);
  });

  it('keeps reviewed npx package runners in private runtime cwd outside their managed source roots', () => {
    const resolveRunner = (name: string) => {
      const fixture = installTrustedHostProfile({ name, runtimeHome: 'isolated' });
      try {
        process.env.FLUJO_PARENT_DATA_DIR = dataRoot;
        process.env.FLUJO_DATA_DIR = dataRoot;
        const runner = materializeProtectedPackageRunner(name, 'process.exitCode = 0;\n');
        fixture.approve(runner);
        return { runner, launch: resolveIsolatedLaunch(runner) };
      } finally { fixture.restore(); }
    };
    const first = runWithWorkspace('runtime-a', () => resolveRunner('weather-mcp'));
    const second = runWithWorkspace('runtime-a', () => resolveRunner('search-mcp'));
    const otherWorkspace = runWithWorkspace('runtime-b', () => resolveRunner('weather-mcp'));
    for (const { runner, launch } of [first, second, otherWorkspace]) {
      const policy = trustedHostMcpPolicySchema.parse(runner.trustedHost);
      expect(launch.command).toBe(process.execPath);
      expect(launch.args[0]).toBe(policy.entryPoint);
      expect(launch.args).toContain('--offline');
      expect(launch.args).toContain('owned-probe@1.0.0');
      expect(launch.cwd).toContain(`${path.sep}userdata${path.sep}mcp-runtime${path.sep}`);
      expect(path.relative(policy.sourceRoot, launch.cwd)).toMatch(/^\.\.(?:[\\/]|$)/);
    }
    expect(first.launch.cwd).not.toBe(second.launch.cwd);
    expect(first.runner.name).toBe(otherWorkspace.runner.name);
    expect(first.launch.cwd).not.toBe(otherWorkspace.launch.cwd);
    for (const name of ['HOME', 'NPM_CONFIG_CACHE', 'TMP', 'TEMP']) {
      expect(first.launch.env[name]).not.toBe(otherWorkspace.launch.env[name]);
    }
  });

  // A stdio server inherits an explicit env, and the MCP SDK's Windows defaults
  // carry no ComSpec. npm takes its script shell from ComSpec without a fallback,
  // so omitting it makes every `npm run` inside a server abort at spawn time with
  // ERR_INVALID_ARG_TYPE and no diagnostics.
  (process.platform === 'win32' ? it : it.skip)(
    'passes the Windows launch essentials a child needs to spawn its own tools',
    () => {
      const reviewed = { ...config, env: { ...config.env,
        ComSpec: process.env.ComSpec ?? process.env.COMSPEC!,
        SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT!,
        PATHEXT: process.env.PATHEXT!,
      } };
      const launch = runWithWorkspace('runtime-a', () => resolveApprovedFixedNode(reviewed, true));
      const comSpec = launch.env.ComSpec ?? launch.env.COMSPEC;
      expect(comSpec).toBeTruthy();
      expect(path.basename(comSpec!).toLowerCase()).toBe('cmd.exe');
      expect(launch.env.SystemRoot ?? launch.env.SYSTEMROOT).toBeTruthy();
      expect(launch.env.PATHEXT).toContain('.CMD');
    },
  );

  // Windows launch values must be reviewed, rather than silently repaired from
  // the ambient host environment before consent.
  (process.platform === 'win32' ? it : it.skip)(
    'rejects unreviewed blank Windows launch essentials',
    () => {
      const blanked: MCPStdioConfig = {
        ...config,
        name: 'server-with-blank-comspec',
        env: { ...config.env, COMSPEC: '', SYSTEMROOT: '   ' },
      };
      // Persisted values cannot gain ambient launch authority through backfill.
      expect(() => runWithWorkspace('runtime-a', () => resolveIsolatedLaunch(blanked)))
        .toThrow(expect.objectContaining({ code: 'HOST_CONSENT_REQUIRED' }));
    },
  );

  it('keeps ordinary stdio commands in their configured server root', () => {
    const ordinary: MCPStdioConfig = {
      ...config,
      name: 'local-node-server',
      rootPath: 'mcp-servers/local-node-server',
    };
    const launch = runWithWorkspace('runtime-a', () => resolveApprovedFixedNode(ordinary, true));
    expect(launch.cwd).toBe(
      path.join(getWorkspaceDataDir('runtime-a'), 'mcp-servers', 'local-node-server'),
    );
  });

  it('rejects stale shipped-browser output paths before host consent', () => {
    const browser = SHIPPED_MCP_SERVERS.find(item => item.defaultName === 'browser')!;
    const shipped = createShippedServerConfig(browser, {
      FLUJO_DATA_DIR: dataRoot,
      FLUJO_BROWSER_ENABLED: '1',
      FLUJO_BROWSER_PROFILE_DIR: 'C:\\shared-profile',
      FLUJO_BROWSER_SCREENSHOT_DIR: 'C:\\shared-shots',
      FLUJO_BROWSER_RECORD_DIR: 'C:\\shared-recordings',
    });
    // Simulate a persisted pre-workspace record that still carries old values.
    shipped.env = {
      ...shipped.env,
      FLUJO_BROWSER_PROFILE_DIR: 'C:\\shared-profile',
      FLUJO_BROWSER_SCREENSHOT_DIR: 'C:\\shared-shots',
      FLUJO_BROWSER_RECORD_DIR: 'C:\\shared-recordings',
    };

    expect(() => runWithWorkspace('runtime-b', () => resolveIsolatedLaunch(shipped)))
      .toThrow(expect.objectContaining({ code: 'HOST_CONSENT_REQUIRED' }));
  });

  it('rejects an unreviewed host browser-binary cache', () => {
    const browser = SHIPPED_MCP_SERVERS.find(item => item.defaultName === 'browser')!;
    const shipped = createShippedServerConfig(browser, {
      FLUJO_DATA_DIR: dataRoot,
    });
    delete (shipped.env as Record<string, unknown>).PLAYWRIGHT_BROWSERS_PATH;
    process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(dataRoot, 'shared-browser-binaries');

    expect(() => runWithWorkspace('runtime-b', () => resolveIsolatedLaunch(shipped)))
      .toThrow(expect.objectContaining({ code: 'HOST_CONSENT_REQUIRED' }));
  });

  it('requires host consent even with an explicit workspace browser-binary path', () => {
    const browser = SHIPPED_MCP_SERVERS.find(item => item.defaultName === 'browser')!;
    const shipped = createShippedServerConfig(browser, {
      FLUJO_DATA_DIR: dataRoot,
      PLAYWRIGHT_BROWSERS_PATH: path.join(dataRoot, 'configured-browser-binaries'),
    });
    process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(dataRoot, 'host-browser-binaries');

    expect(() => runWithWorkspace('runtime-b', () => resolveIsolatedLaunch(shipped)))
      .toThrow(expect.objectContaining({ code: 'HOST_CONSENT_REQUIRED' }));
  });

  it('remaps only unambiguous absolute paths left by a legacy managed MCP clone', async () => {
    const legacy = path.join(dataRoot, 'mcp-servers', 'legacy-clone', 'packages', 'server');
    const migratedOwner = path.join(getWorkspaceDataDir(), 'mcp-servers', 'legacy-clone');
    await fs.mkdir(path.join(migratedOwner, 'packages', 'server'), { recursive: true });

    expect(remapLegacyDefaultWorkspacePath(legacy, 'mcp-servers')).toBe(
      path.join(migratedOwner, 'packages', 'server'),
    );
    expect(runWithWorkspace('runtime-a', () =>
      remapLegacyDefaultWorkspacePath(legacy, 'mcp-servers'))).toBe(legacy);

    // Copy-only EBUSY/EXDEV migrations intentionally leave an empty mount root;
    // it is safe to remap because the populated workspace owner is authoritative.
    await fs.mkdir(path.join(dataRoot, 'mcp-servers', 'legacy-clone'), { recursive: true });
    expect(remapLegacyDefaultWorkspacePath(legacy, 'mcp-servers')).toBe(
      path.join(migratedOwner, 'packages', 'server'),
    );

    // A non-empty original owner may be an explicit operator path or shipped
    // package. Ambiguity always preserves the configured value.
    await fs.writeFile(path.join(dataRoot, 'mcp-servers', 'legacy-clone', 'keep.txt'), 'legacy', 'utf8');
    expect(remapLegacyDefaultWorkspacePath(legacy, 'mcp-servers')).toBe(legacy);
  });

  it('remaps file URLs and flag-assignment argv references to a migrated clone', async () => {
    const legacy = path.join(dataRoot, 'mcp-servers', 'legacy-reference', 'config.json');
    const migrated = path.join(getWorkspaceDataDir(), 'mcp-servers', 'legacy-reference', 'config.json');
    await fs.mkdir(path.dirname(migrated), { recursive: true });
    await fs.writeFile(migrated, '{}', 'utf8');

    expect(remapLegacyDefaultWorkspaceReference(pathToFileURL(legacy).href, 'mcp-servers'))
      .toBe(pathToFileURL(migrated).href);
    expect(remapLegacyDefaultWorkspaceReference(`--config=${legacy}`, 'mcp-servers'))
      .toBe(`--config=${migrated}`);
    expect(remapLegacyDefaultWorkspaceReference(`--config="${legacy}"`, 'mcp-servers'))
      .toBe(`--config="${migrated}"`);
    expect(runWithWorkspace('runtime-a', () =>
      remapLegacyDefaultWorkspaceReference(`--config=${legacy}`, 'mcp-servers')))
      .toBe(`--config=${legacy}`);
  });
});
