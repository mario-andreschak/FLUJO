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
import { ensureWorkspaceLayoutReady } from '@/backend/services/workspace/migration';

const log = createLogger('instrumentation');

export async function initializeNodeRuntime(): Promise<void> {
  log.info('Server startup: preparing workspace layout');

  // Start the barrier immediately, but do not make Next's instrumentation hook
  // await a potentially long first-run inventory. In Next 16 the hook can be
  // evaluated lazily by the first request; awaiting here makes the TCP listener
  // accept connections while returning no bytes until every legacy file has
  // been hashed. The shell and the installation-wide readiness endpoint may be
  // served during migration; every data-bearing route still awaits this exact
  // promise through withWorkspaceContext().
  const layoutPreparation = ensureWorkspaceLayoutReady();

  void layoutPreparation.then(async () => {
    // MCP Apps (#97): bring up the separate-origin sandbox proxy listener only
    // after the storage barrier. If its port is unavailable, the main app stays
    // usable and reports the sandbox error normally.
    try {
      const { startSandboxServer } = await import('@/backend/mcpApps/sandboxServer');
      startSandboxServer();
    } catch (error) {
      log.error('Failed to start MCP Apps sandbox proxy', error);
    }

    // Enumerating all workspaces ensures inactive workspaces still arm
    // automations; slow MCP connections do not hold Next's readiness gate open.
    const { ensureAllWorkspacesInitialized } = await import('@/backend/init');
    await ensureAllWorkspacesInitialized();
    log.info('Server startup: all workspace initialization complete');
  }).catch(error => log.error('Server startup: workspace initialization failed', error));
}
