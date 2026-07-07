/**
 * Timeout selection for the "Test Run" MCP handshake probe (issue #43).
 *
 * The Test Run button spawns the server through the real production transport and waits
 * for the initialize handshake. A single hardcoded 15s window was too short for
 * package-runner commands (`npx`, `uvx`, `bunx`, `pnpm dlx`, ...): their FIRST invocation
 * may need to DOWNLOAD the package from the registry before the MCP handshake can even
 * begin, which routinely exceeds 15s and produced spurious "Connection timeout after 15s"
 * failures even though the server would eventually have started fine.
 *
 * This is a pure function (no fs / no node built-ins) so the browser-side Test Run path
 * can reuse it to inform the user about the applicable timeout, exactly like the shared
 * `resolveServerCwd` helper it builds on.
 */

import { MCPServerConfig, MCPStdioConfig } from '@/shared/types/mcp';
import { isPackageRunnerCommand } from './resolveServerCwd';

/** Handshake timeout for already-resolved local commands (`node`, absolute paths, `.bat`)
 *  and for HTTP/WebSocket transports. This is the historical Test Run default. */
export const DEFAULT_TEST_CONNECTION_TIMEOUT_MS = 15000;

/** Handshake timeout for package-runner stdio commands, long enough to absorb a cold
 *  `npx`/`uvx` package download before the handshake starts (issue #43). */
export const RUNNER_TEST_CONNECTION_TIMEOUT_MS = 90000;

/**
 * @returns true when this is a stdio config whose command is a package runner that may
 *          have to download the package on first run (`npx`, `uvx`, `bunx`, `pnpm dlx`, ...).
 */
export function isRunnerStdioConfig(config: MCPServerConfig): boolean {
  if (config.transport !== 'stdio') {
    return false;
  }
  const stdio = config as MCPStdioConfig;
  return isPackageRunnerCommand(stdio.command, stdio.args ?? []);
}

/**
 * Pick the Test Run handshake timeout (ms) for a config.
 *
 * Only package-runner stdio commands get the longer window; every other transport and
 * command keeps the historical default so existing local/`node`/HTTP Test Runs are
 * unchanged in behavior.
 */
export function getTestConnectionTimeoutMs(config: MCPServerConfig): number {
  return isRunnerStdioConfig(config)
    ? RUNNER_TEST_CONNECTION_TIMEOUT_MS
    : DEFAULT_TEST_CONNECTION_TIMEOUT_MS;
}
