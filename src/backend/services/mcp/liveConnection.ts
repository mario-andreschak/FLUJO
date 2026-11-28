import { createLogger } from '@/utils/logger';

const log = createLogger('backend/services/mcp/liveConnection');

const PING_TIMEOUT_MS = 5_000;

interface PingableClient {
  ping(options?: { timeout?: number }): Promise<unknown>;
}

export interface LiveConnectionBackend {
  getClient(serverName: string): PingableClient | undefined;
  forceReconnect(serverName: string): Promise<{ success: boolean; error?: string }>;
}

/*
 * A registered client is no proof of a live connection. A Streamable HTTP
 * server that restarted has forgotten the session, and the SDK gives up on a
 * broken notification stream without closing the client, so every later
 * request fails the same way until the connection is rebuilt. These helpers
 * are for servers FLUJO keeps connected for an automation (event streams,
 * polls, channel messages), which must heal on their own.
 */

async function answersPing(client: PingableClient): Promise<boolean> {
  try {
    await client.ping({ timeout: PING_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/** Rebuilds the connection unless someone already replaced the dead client. */
async function replaceDeadClient(backend: LiveConnectionBackend, serverName: string, dead: PingableClient): Promise<boolean> {
  if (backend.getClient(serverName) !== dead) return backend.getClient(serverName) !== undefined;
  log.info(`${serverName} no longer answers on its connection; reconnecting`);
  const reconnected = await backend.forceReconnect(serverName);
  if (!reconnected.success) log.info(`Reconnecting ${serverName} failed: ${reconnected.error ?? 'unknown error'}`);
  return reconnected.success;
}

/** Rebuilds the connection when its client no longer answers a ping. */
export async function healDeadConnection(backend: LiveConnectionBackend, serverName: string): Promise<void> {
  const client = backend.getClient(serverName);
  if (client && !await answersPing(client)) await replaceDeadClient(backend, serverName, client);
}

/**
 * Runs a request and, when it failed because the connection died, rebuilds
 * the connection and tries once more. A server that still answers a ping
 * refused the request itself, so that error stands.
 */
export async function withLiveConnection<T>(
  backend: LiveConnectionBackend,
  serverName: string,
  request: () => Promise<T>,
): Promise<T> {
  const client = backend.getClient(serverName);
  try {
    return await request();
  } catch (error) {
    if (!client) throw error;
    if (backend.getClient(serverName) === client && await answersPing(client)) throw error;
    if (!await replaceDeadClient(backend, serverName, client)) throw error;
    return request();
  }
}
