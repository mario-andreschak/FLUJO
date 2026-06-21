import { resolveServerCwd, isPackageRunnerCommand } from '@/utils/mcp/resolveServerCwd';

// Issue #40: `npx -y @softeria/ms-365-mcp-server` failed with "command not found"
// because FLUJO ran it from inside a same-named package clone at
// mcp-servers/ms-365-mcp-server, so npx resolved the local bin instead of fetching.
describe('isPackageRunnerCommand (#40)', () => {
  it.each([
    'npx',
    'npx.cmd',
    'C:\\Program Files\\nodejs\\npx.cmd',
    '/usr/local/bin/npx',
    'uvx',
    'bunx',
    'pipx',
  ])('treats "%s" as a package runner', (command) => {
    expect(isPackageRunnerCommand(command)).toBe(true);
  });

  it.each([
    ['pnpm', ['dlx', 'some-pkg']],
    ['yarn', ['dlx', 'some-pkg']],
    ['bun', ['x', 'some-pkg']],
    ['npm', ['exec', 'some-pkg']],
  ])('treats "%s %s" as a package runner', (command, args) => {
    expect(isPackageRunnerCommand(command, args as string[])).toBe(true);
  });

  it.each([
    ['node', ['dist/index.js']],
    ['python', ['-m', 'mcp_server_fetch']],
    ['pnpm', ['start']], // package manager, but not a dlx/exec/x run
    ['npm', ['run', 'start']],
    ['', []],
  ])('does not treat "%s %s" as a package runner', (command, args) => {
    expect(isPackageRunnerCommand(command, args as string[])).toBe(false);
  });
});

describe('resolveServerCwd (#40)', () => {
  it('drops the package-named leaf dir for npx (the reported bug)', () => {
    expect(
      resolveServerCwd({
        command: 'npx',
        args: ['-y', '@softeria/ms-365-mcp-server', '--toon'],
        rootPath: 'C:/Users/me/Documents/GitHub/FLUJO/mcp-servers/ms-365-mcp-server',
        serverName: 'ms-365-mcp-server',
        defaultCwd: 'mcp-servers/ms-365-mcp-server',
      })
    ).toBe('C:/Users/me/Documents/GitHub/FLUJO/mcp-servers');
  });

  it('handles Windows backslash paths too', () => {
    expect(
      resolveServerCwd({
        command: 'npx.cmd',
        args: ['-y', '@softeria/ms-365-mcp-server'],
        rootPath: 'C:\\Users\\me\\FLUJO\\mcp-servers\\ms-365-mcp-server',
        serverName: 'ms-365-mcp-server',
        defaultCwd: 'mcp-servers/ms-365-mcp-server',
      })
    ).toBe('C:\\Users\\me\\FLUJO\\mcp-servers');
  });

  it('falls back to the parent of the default cwd when no rootPath is set', () => {
    expect(
      resolveServerCwd({
        command: 'npx',
        args: ['-y', 'some-server'],
        serverName: 'some-server',
        defaultCwd: 'mcp-servers/some-server',
      })
    ).toBe('mcp-servers');
  });

  it('applies to pnpm dlx as well', () => {
    expect(
      resolveServerCwd({
        command: 'pnpm',
        args: ['dlx', 'some-server'],
        rootPath: '/srv/mcp-servers/some-server',
        serverName: 'some-server',
        defaultCwd: 'mcp-servers/some-server',
      })
    ).toBe('/srv/mcp-servers');
  });

  it('leaves node/python servers in their package directory untouched', () => {
    expect(
      resolveServerCwd({
        command: 'node',
        args: ['dist/index.js'],
        rootPath: 'C:/Users/me/FLUJO/mcp-servers/everything',
        serverName: 'everything',
        defaultCwd: 'mcp-servers/everything',
      })
    ).toBe('C:/Users/me/FLUJO/mcp-servers/everything');
  });

  it('leaves a custom neutral rootPath untouched (leaf name != server name)', () => {
    expect(
      resolveServerCwd({
        command: 'npx',
        args: ['-y', '@softeria/ms-365-mcp-server'],
        rootPath: 'C:/tools/workdir',
        serverName: 'ms-365-mcp-server',
        defaultCwd: 'mcp-servers/ms-365-mcp-server',
      })
    ).toBe('C:/tools/workdir');
  });

  it('does not strip when there is no parent directory to fall back to', () => {
    // Bare package-named path with no separator: nothing better to use, keep as-is.
    expect(
      resolveServerCwd({
        command: 'npx',
        args: ['-y', 'some-server'],
        rootPath: 'some-server',
        serverName: 'some-server',
        defaultCwd: 'mcp-servers/some-server',
      })
    ).toBe('some-server');
  });
});
