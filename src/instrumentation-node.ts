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

  // This is the startup barrier: no sandbox or backend service may open a
  // runtime path until the transactional migration has completed or recovered.
  await ensureWorkspaceLayoutReady();

  // MCP Apps (#97): bring up the separate-origin sandbox proxy listener so
  // interactive apps can render in a foreign-origin iframe. Never blocks startup
  // and never throws — if the port is taken or binding fails, apps just won't
  // render and the rest of FLUJO is unaffected.
  try {
    const { startSandboxServer } = await import('@/backend/mcpApps/sandboxServer');
    startSandboxServer();
  } catch (error) {
    log.error('Failed to start MCP Apps sandbox proxy', error);
  }

  // Fire-and-forget after the layout barrier. Enumerating all workspaces ensures
  // inactive workspaces still arm automations; slow MCP connections do not hold
  // Next's readiness gate open.
  const { ensureAllWorkspacesInitialized } = await import('@/backend/init');
  void ensureAllWorkspacesInitialized()
    .then(() => log.info('Server startup: all workspace initialization complete'))
    .catch(error => log.error('Server startup: workspace initialization failed', error));
}
