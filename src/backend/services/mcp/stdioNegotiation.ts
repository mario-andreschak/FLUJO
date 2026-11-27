import { SdkError, SdkErrorCode, type VersionNegotiationOptions } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { MCPServerConfig } from '@/shared/types/mcp';
import { createLogger } from '@/utils/logger';

/**
 * Protocol negotiation for stdio servers, as the 2026-07-28 specification asks
 * (basic/transports/stdio, "Backward compatibility"): send `server/discover`
 * first on the same process, use the stateless protocol when the server answers
 * it, and fall back to the classic `initialize` on any other reply or silence.
 *
 * The SDK probes its own base stdio class on a hidden second process. That
 * process would skip FLUJO's isolation, host checks and process tracking, so
 * FLUJO hands the SDK a subclass, which the SDK probes in place.
 *
 * Some older servers quit when the first message is not `initialize`. FLUJO
 * remembers those servers and starts them again at once with the classic
 * handshake. The memory heals itself: a classic start that fails forgets the
 * server, so the next start asks again.
 */

const log = createLogger('backend/services/mcp/stdioNegotiation');

export class InPlaceProbeStdioClientTransport extends StdioClientTransport {}

/** Long enough for a first `npx` start; a silent old server costs this once per start. */
export const STDIO_PROBE_TIMEOUT_MS = 20_000;

/** Only bounds memory: a forgotten server is simply asked again on its next start. */
const MAX_REMEMBERED_CLASSIC_SERVERS = 512;

const classicServers = new Map<string, number>();
const pendingClassicRetries = new Set<string>();

type StdioIdentity = Pick<MCPServerConfig, 'name'> & { command?: string; args?: string[]; cwd?: string; rootPath?: string };

function identity(config: StdioIdentity): string {
  return JSON.stringify([config.name, config.command ?? '', config.args ?? [], config.cwd ?? config.rootPath ?? '']);
}

export function stdioVersionNegotiation(config: StdioIdentity): VersionNegotiationOptions {
  return classicServers.has(identity(config))
    ? { mode: 'legacy' }
    : { mode: 'auto', probe: { timeoutMs: STDIO_PROBE_TIMEOUT_MS } };
}

/** The server process ended while it was being asked `server/discover`. */
export function isStdioProbeExit(error: unknown): boolean {
  return SdkError.isInstance(error)
    && error.code === SdkErrorCode.EraNegotiationFailed
    && error.message.includes('closed during the server/discover probe');
}

/**
 * Record what a failed stdio connect says about the server. A server that quit
 * on the probe is remembered and gets one immediate classic restart (see
 * {@link takeClassicHandshakeRetry}); a classic start that failed is forgotten.
 */
export function noteStdioConnectFailure(config: StdioIdentity, error: unknown): void {
  const key = identity(config);
  if (classicServers.has(key)) {
    classicServers.delete(key);
    return;
  }
  if (!isStdioProbeExit(error)) return;
  if (classicServers.size >= MAX_REMEMBERED_CLASSIC_SERVERS) {
    classicServers.delete(classicServers.keys().next().value!);
  }
  classicServers.set(key, Date.now());
  pendingClassicRetries.add(config.name);
  log.info(`MCP server ${config.name} quit when asked server/discover; starting it again with the classic handshake`);
}

/** One-shot: true once after {@link noteStdioConnectFailure} remembered this server. */
export function takeClassicHandshakeRetry(serverName: string): boolean {
  return pendingClassicRetries.delete(serverName);
}

export function forgetStdioNegotiationForTests(): void {
  classicServers.clear();
  pendingClassicRetries.clear();
}
