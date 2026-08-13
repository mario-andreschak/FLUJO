import fs from 'node:fs/promises';
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

const priorDataDir = process.env.FLUJO_DATA_DIR;
let dataRoot: string;

beforeAll(async () => {
  dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-mcp-runtime-isolation-'));
  process.env.FLUJO_DATA_DIR = dataRoot;
  await ensureWorkspaceDirs();
  await ensureWorkspaceDirs('runtime-a');
  await ensureWorkspaceDirs('runtime-b');
});

afterAll(async () => {
  if (priorDataDir === undefined) delete process.env.FLUJO_DATA_DIR;
  else process.env.FLUJO_DATA_DIR = priorDataDir;
  await fs.rm(dataRoot, { recursive: true, force: true });
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
  },
  disabled: false,
  rootPath: '',
  _buildCommand: '',
  _installCommand: '',
};

describe('stdio MCP runtime homes', () => {
  it('forces conventional home, config, cache, temp and FLUJO roots per workspace', () => {
    const launchA = runWithWorkspace('runtime-a', () => resolveStdioLaunch(config));
    const launchB = runWithWorkspace('runtime-b', () => resolveStdioLaunch(config));
    const rootA = getWorkspaceDataDir('runtime-a');
    const rootB = getWorkspaceDataDir('runtime-b');

    for (const [launch, root] of [[launchA, rootA], [launchB, rootB]] as const) {
      expect(path.relative(root, launch.env.HOME)).not.toMatch(/^\.\.(?:[\\/]|$)/);
      expect(launch.env.USERPROFILE).toBe(launch.env.HOME);
      expect(launch.env.FLUJO_DATA_DIR).toBe(root);
      expect(launch.env.XDG_CONFIG_HOME).toBe(path.join(launch.env.HOME, '.config'));
      expect(launch.env.NPM_CONFIG_CACHE).toBe(path.join(launch.env.HOME, '.npm'));
      expect(launch.env.TMP).toBe(path.join(launch.env.HOME, 'tmp'));
    }
    expect(launchA.env.HOME).not.toBe(launchB.env.HOME);
  });

  it('launches package runners from a private per-server cwd outside the managed server root', async () => {
    const runner: MCPStdioConfig = {
      ...config,
      name: 'weather-mcp',
      command: 'npx',
      args: ['-y', '@example/weather-mcp'],
      rootPath: 'mcp-servers/weather-mcp',
    };
    const otherRunner: MCPStdioConfig = {
      ...runner,
      name: 'search-mcp',
      rootPath: 'mcp-servers/search-mcp',
    };

    const weatherLaunch = runWithWorkspace('runtime-a', () => resolveStdioLaunch(runner));
    const searchLaunch = runWithWorkspace('runtime-a', () => resolveStdioLaunch(otherRunner));
    const workspaceRoot = getWorkspaceDataDir('runtime-a');
    const serverRoot = path.join(workspaceRoot, 'mcp-servers', 'weather-mcp');

    expect(weatherLaunch.cwd).toBe(path.join(path.dirname(weatherLaunch.env.HOME), 'cwd'));
    expect(weatherLaunch.cwd).not.toBe(serverRoot);
    expect(path.relative(serverRoot, weatherLaunch.cwd)).toMatch(/^\.\.(?:[\\/]|$)/);
    expect(weatherLaunch.cwd).not.toBe(searchLaunch.cwd);
    await expect(fs.stat(weatherLaunch.cwd)).resolves.toMatchObject({});
  });

  // A stdio server inherits an explicit env, and the MCP SDK's Windows defaults
  // carry no ComSpec. npm takes its script shell from ComSpec without a fallback,
  // so omitting it makes every `npm run` inside a server abort at spawn time with
  // ERR_INVALID_ARG_TYPE and no diagnostics.
  (process.platform === 'win32' ? it : it.skip)(
    'passes the Windows launch essentials a child needs to spawn its own tools',
    () => {
      const launch = runWithWorkspace('runtime-a', () => resolveStdioLaunch(config));
      const comSpec = launch.env.ComSpec ?? launch.env.COMSPEC;
      expect(comSpec).toBeTruthy();
      expect(path.basename(comSpec!).toLowerCase()).toBe('cmd.exe');
      expect(launch.env.SystemRoot ?? launch.env.SYSTEMROOT).toBeTruthy();
      expect(launch.env.PATHEXT).toContain('.CMD');
    },
  );

  // Windows resolves env vars case-insensitively, so a persisted config holding
  // a blank `COMSPEC` must not survive next to the `ComSpec` we backfill: the
  // child would inherit the empty one and npm would crash at spawn time again.
  (process.platform === 'win32' ? it : it.skip)(
    'replaces a blank Windows essential instead of shadowing it with a second spelling',
    () => {
      const blanked: MCPStdioConfig = {
        ...config,
        name: 'server-with-blank-comspec',
        env: { ...config.env, COMSPEC: '', SYSTEMROOT: '   ' },
      };
      const launch = runWithWorkspace('runtime-a', () => resolveStdioLaunch(blanked));

      for (const key of ['ComSpec', 'SystemRoot']) {
        const spellings = Object.entries(launch.env).filter(
          ([name]) => name.toLowerCase() === key.toLowerCase(),
        );
        // Exactly one spelling survives, and it carries a usable value.
        expect(spellings).toHaveLength(1);
        expect(spellings[0][1].trim()).not.toBe('');
      }
      expect(path.basename(launch.env.ComSpec).toLowerCase()).toBe('cmd.exe');
    },
  );

  it('keeps ordinary stdio commands in their configured server root', () => {
    const ordinary: MCPStdioConfig = {
      ...config,
      name: 'local-node-server',
      rootPath: 'mcp-servers/local-node-server',
    };
    const launch = runWithWorkspace('runtime-a', () => resolveStdioLaunch(ordinary));
    expect(launch.cwd).toBe(
      path.join(getWorkspaceDataDir('runtime-a'), 'mcp-servers', 'local-node-server'),
    );
  });

  it('overrides stale shipped-browser output paths at the final child boundary', () => {
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

    const launch = runWithWorkspace('runtime-b', () => resolveStdioLaunch(shipped));
    const root = getWorkspaceDataDir('runtime-b');
    expect(launch.env.FLUJO_BROWSER_PROFILE_DIR).toBe(path.join(root, 'browser-profile', 'trusted'));
    expect(launch.env.FLUJO_BROWSER_SCREENSHOT_DIR).toBe(path.join(root, 'screenshots', 'browser'));
    expect(launch.env.FLUJO_BROWSER_RECORD_DIR).toBe(path.join(root, 'recordings', 'browser'));
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
