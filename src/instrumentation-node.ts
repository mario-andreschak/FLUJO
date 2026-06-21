/**
 * Node.js-only side of the instrumentation hook (see src/instrumentation.ts).
 *
 * This module is imported exclusively from the `NEXT_RUNTIME === 'nodejs'`
 * branch of register(), so it (and the Node-only backend code it pulls in,
 * e.g. the MCP stdio transport's child_process usage) never reaches the Edge
 * bundle. Importing it at module scope here is fine - the module itself only
 * runs in the Node.js runtime.
 */
import { createLogger } from '@/utils/logger';
import { ensureBackendInitialized } from '@/backend/init';

const log = createLogger('instrumentation');

log.info('Server startup: initializing backend (storage + MCP servers)');

// Fire-and-forget: we deliberately do NOT await this. MCP servers can take
// several seconds (and retry with backoff) to connect, and blocking the
// server's "ready" on every one of them would make startup feel frozen.
// getServerStatus() reports each as "connecting" until it settles, and the
// MCP page polls and refreshes its cards automatically.
ensureBackendInitialized()
  .then(() => log.info('Server startup: backend initialization complete'))
  .catch(error => log.error('Server startup: backend initialization failed', error));
