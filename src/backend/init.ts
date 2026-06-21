import { verifyStorage } from '@/utils/storage/backend';
import { mcpService } from '@/backend/services/mcp';
import { createLogger } from '@/utils/logger';

const log = createLogger('backend/init');

declare global {
  // The in-flight (or settled) initialization promise. Global-backed so the
  // startup hook (instrumentation) and the /api/init route share the SAME run
  // instead of each kicking off their own server-startup sweep and racing.
  // eslint-disable-next-line no-var
  var __flujo_init_promise: Promise<void> | undefined;
}

/**
 * Run server-side startup tasks exactly once per process: verify storage and
 * start all enabled MCP servers.
 *
 * Memoized via a global promise so it is safe to call from multiple places
 * (the instrumentation startup hook and the /api/init route) without racing or
 * double-connecting servers. On failure the memo is cleared so a later caller
 * can retry.
 */
export function ensureBackendInitialized(): Promise<void> {
  if (!global.__flujo_init_promise) {
    global.__flujo_init_promise = runInitialization().catch(error => {
      // Allow a subsequent call (e.g. the /api/init route) to retry after a
      // failed startup instead of being stuck with a permanently rejected memo.
      global.__flujo_init_promise = undefined;
      throw error;
    });
  }
  return global.__flujo_init_promise;
}

async function runInitialization(): Promise<void> {
  // Verify storage first - if this throws, callers (e.g. the route) surface it.
  await verifyStorage();

  log.info('Initializing MCP servers');
  // startEnabledServers() never rejects in practice (it catches per-server
  // failures) and always clears the startup flag in its own finally, so we
  // don't need to manage that flag here - just guard against the unexpected.
  await mcpService.startEnabledServers().catch(error => {
    log.error('Failed to start enabled servers:', error);
  });
}
