import { spawnSync } from 'child_process';
import { assertMcpHostInstallationAllowed, createMcpInstallerEnvironment, McpHostInstallationError } from '@/backend/services/mcp/installerEnvironment';

describe('assertMcpHostInstallationAllowed', () => {
  it('allows unconfigured native localhost installs', () => {
    expect(() => assertMcpHostInstallationAllowed(undefined, {})).not.toThrow();
  });

  it.each([
    ['FLUJO_OWNER_AUTH_FILE', ''], ['FLUJO_OWNER_AUTH_FILE', 'missing-synthetic-policy'],
    ['FLUJO_MCP_TRUSTED_HOST_FILE', ''], ['FLUJO_MCP_TRUSTED_HOST_FILE', 'missing-synthetic-policy'],
    ['FLUJO_MCP_ISOLATION_FILE', ''], ['FLUJO_MCP_ISOLATION_FILE', 'missing-synthetic-policy'],
    ['FLUJO_WORKER_MODE', '1'],
  ])('refuses a protected environment selected by %s=%s', (name, value) => {
    expect(() => assertMcpHostInstallationAllowed(undefined, { [name]: value }))
      .toThrow(McpHostInstallationError);
    expect(() => assertMcpHostInstallationAllowed(undefined, { [name]: value }))
      .toThrow(/externally materialized reviewed source or a preinstalled immutable image/);
  });

  it.each([{ isolation: null }, { isolation: {} }, { trustedHost: false }, { trustedHost: {} }])(
    'refuses explicit profile selection without an installer grant: %j', selection => {
      expect(() => assertMcpHostInstallationAllowed(selection, {})).toThrow(McpHostInstallationError);
    },
  );
});

describe('createMcpInstallerEnvironment', () => {
  it('preserves Linux command discovery, home, temporary directories and locale', () => {
    expect(createMcpInstallerEnvironment({
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/home/installer',
      TMPDIR: '/tmp/installer',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C.UTF-8',
      TZ: 'UTC',
      UNRELATED_SETTING: 'omit-me',
      TEMP: undefined,
    }, 'linux')).toEqual({
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/home/installer',
      TMPDIR: '/tmp/installer',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C.UTF-8',
      TZ: 'UTC',
      NODE_ENV: 'production',
      npm_config_include: 'dev',
    });
  });

  it('keeps Windows shell and native build paths with one case-insensitive key each', () => {
    expect(createMcpInstallerEnvironment({
      PATH: 'C:\\node;C:\\Windows\\System32',
      Path: 'duplicate-path',
      pathext: '.COM;.EXE;.BAT;.CMD',
      systemroot: 'C:\\Windows',
      windir: 'C:\\Windows',
      COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
      USERPROFILE: 'C:\\Users\\installer',
      TEMP: 'C:\\Temp',
      TMP: 'C:\\Temp',
      LOCALAPPDATA: 'C:\\Users\\installer\\AppData\\Local',
      'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
      INCLUDE: 'C:\\VS\\include',
      LIB: 'C:\\VS\\lib',
      VCTOOLSINSTALLDIR: 'C:\\VS\\tools',
      WINDOWSSDKDIR: 'C:\\Windows Kits\\10',
    }, 'win32')).toEqual({
      PATH: 'C:\\node;C:\\Windows\\System32',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      SystemRoot: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      USERPROFILE: 'C:\\Users\\installer',
      TEMP: 'C:\\Temp',
      TMP: 'C:\\Temp',
      LOCALAPPDATA: 'C:\\Users\\installer\\AppData\\Local',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      INCLUDE: 'C:\\VS\\include',
      LIB: 'C:\\VS\\lib',
      VCToolsInstallDir: 'C:\\VS\\tools',
      WindowsSdkDir: 'C:\\Windows Kits\\10',
      NODE_ENV: 'production',
      npm_config_include: 'dev',
    });
  });

  it.each(['linux', 'win32'] as const)('strips ambient credentials and execution controls on %s', platform => {
    const blockedNames = [
      'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'AWS_SECRET_ACCESS_KEY',
      'FLUJO_API_KEY', 'FLUJO_DATA_DIR', 'FLUJO_INTERNAL_TOKEN', 'MCP_RUNTIME_TOKEN',
      'GITHUB_TOKEN', 'GH_TOKEN', 'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'SSH_AUTH_SOCK',
      'npm_config_registry', 'NPM_CONFIG_USERCONFIG', 'npm_config__authToken',
      'npm_config_script_shell', 'NPM_CONFIG_INCLUDE', 'npm_config_omit',
      'NODE_ENV', 'NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE',
      'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'PYTHONPATH', 'PYTHONSTARTUP',
      'BASH_ENV', 'ENV', 'SHELLOPTS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0',
      'GIT_CONFIG_VALUE_0', 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'SSH_ASKPASS',
      'ARBITRARY_APP_CREDENTIAL',
    ];
    const baseEnv = Object.fromEntries(blockedNames.map(name => [name, 'synthetic-value']));

    expect(createMcpInstallerEnvironment(baseEnv, platform)).toEqual({ NODE_ENV: 'production', npm_config_include: 'dev' });
  });

  it('does not read excluded values or mutate the caller environment', () => {
    const baseEnv: Record<string, string | undefined> = { PATH: '/tools/bin', npm_config_include: 'optional' };
    Object.defineProperty(baseEnv, 'OPENAI_API_KEY', {
      enumerable: true,
      get: () => { throw new Error('Excluded values must not be read'); },
    });
    Object.freeze(baseEnv);

    const env = createMcpInstallerEnvironment(baseEnv, 'linux');
    expect(env).toEqual({ PATH: '/tools/bin', NODE_ENV: 'production', npm_config_include: 'dev' });
    env.PATH = '/another/path';
    expect(baseEnv.PATH).toBe('/tools/bin');
    expect(baseEnv.npm_config_include).toBe('optional');
  });

  it('does not turn differently cased Linux variables into command search paths', () => {
    expect(createMcpInstallerEnvironment({ Path: '/unintended', home: '/unintended' }, 'linux'))
      .toEqual({ NODE_ENV: 'production', npm_config_include: 'dev' });
  });

  it('passes the scoped values to a real child without ambient credentials', () => {
    const env = createMcpInstallerEnvironment({
      PATH: 'synthetic-build-path',
      HOME: 'synthetic-installer-home',
      OPENAI_API_KEY: 'synthetic-provider-secret',
      FLUJO_API_KEY: 'synthetic-flujo-secret',
      NODE_OPTIONS: '--require synthetic-loader',
    });
    const child = spawnSync(process.execPath, ['-e', `
      process.stdout.write(JSON.stringify({
        path: process.env.PATH,
        home: process.env.HOME,
        include: process.env.npm_config_include,
        provider: process.env.OPENAI_API_KEY,
        flujo: process.env.FLUJO_API_KEY,
        loader: process.env.NODE_OPTIONS,
      }));
    `], { env, encoding: 'utf8', windowsHide: true });

    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({
      path: 'synthetic-build-path',
      home: 'synthetic-installer-home',
      include: 'dev',
    });
  });
});
