import {
  getTestConnectionTimeoutMs,
  isRunnerStdioConfig,
  DEFAULT_TEST_CONNECTION_TIMEOUT_MS,
  RUNNER_TEST_CONNECTION_TIMEOUT_MS,
} from '@/utils/mcp/testConnectionTimeout';
import { MCPServerConfig, MCPStdioConfig } from '@/shared/types/mcp';

// Issue #43: a cold `npx`/`uvx` Test Run may need to download the package before the MCP
// handshake starts, blowing past the old hardcoded 15s timeout. The timeout is now
// runner-aware: package-runner stdio commands get a longer window; everything else keeps
// the historical default.

/** Minimal stdio config for the helper (only command/args/transport are read). */
function stdio(command: string, args: string[] = []): MCPStdioConfig {
  return {
    name: 'test-server',
    transport: 'stdio',
    command,
    args,
    env: {},
    disabled: false,
    autoApprove: [],
    rootPath: '',
    _buildCommand: '',
    _installCommand: '',
  } as unknown as MCPStdioConfig;
}

describe('getTestConnectionTimeoutMs (#43)', () => {
  it.each([
    ['npx', ['-y', '@scope/pkg']],
    ['npx.cmd', ['some-pkg']],
    ['uvx', ['mcp-server']],
    ['bunx', ['pkg']],
    ['pnpm', ['dlx', 'pkg']],
    ['yarn', ['dlx', 'pkg']],
    ['bun', ['x', 'pkg']],
    ['npm', ['exec', 'pkg']],
  ])('uses the longer runner timeout for "%s %s"', (command, args) => {
    const config = stdio(command, args as string[]);
    expect(isRunnerStdioConfig(config)).toBe(true);
    expect(getTestConnectionTimeoutMs(config)).toBe(RUNNER_TEST_CONNECTION_TIMEOUT_MS);
  });

  it.each([
    ['node', ['dist/index.js']],
    ['python', ['-m', 'mcp_server_fetch']],
    ['/usr/local/bin/my-server', []],
    ['pnpm', ['start']], // package manager, but not a dlx/exec/x run
    ['npm', ['run', 'start']],
  ])('uses the default timeout for non-runner stdio command "%s %s"', (command, args) => {
    const config = stdio(command, args as string[]);
    expect(isRunnerStdioConfig(config)).toBe(false);
    expect(getTestConnectionTimeoutMs(config)).toBe(DEFAULT_TEST_CONNECTION_TIMEOUT_MS);
  });

  it('treats missing args as no args (bare npx still counts as a runner)', () => {
    const config = { name: 's', transport: 'stdio', command: 'npx' } as unknown as MCPServerConfig;
    expect(getTestConnectionTimeoutMs(config)).toBe(RUNNER_TEST_CONNECTION_TIMEOUT_MS);
  });

  it.each(['websocket', 'sse', 'streamable'] as const)(
    'uses the default timeout for %s (HTTP/WS) transports even if a runner-like string appears',
    (transport) => {
      const config = {
        name: 'remote',
        transport,
        serverUrl: 'https://example.com/mcp',
        websocketUrl: 'wss://example.com',
        command: 'npx', // ignored: not a stdio transport
      } as unknown as MCPServerConfig;
      expect(isRunnerStdioConfig(config)).toBe(false);
      expect(getTestConnectionTimeoutMs(config)).toBe(DEFAULT_TEST_CONNECTION_TIMEOUT_MS);
    }
  );

  it('the runner timeout is strictly longer than the default', () => {
    expect(RUNNER_TEST_CONNECTION_TIMEOUT_MS).toBeGreaterThan(DEFAULT_TEST_CONNECTION_TIMEOUT_MS);
  });
});
