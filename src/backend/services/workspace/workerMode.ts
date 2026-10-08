/** Lightweight worker state shared by the startup graph and HTTP routes. */
export interface WorkerBootstrapStatus {
  mode: 'local' | 'worker';
  state: 'not-started' | 'restoring' | 'locked' | 'installing' | 'ready' | 'error';
  workspace?: string;
  archiveSha256?: string;
  error?: string;
  servers?: Array<{ name: string; status: string; error?: string }>;
}

declare global {
  var __flujo_worker_bootstrap_status: WorkerBootstrapStatus | undefined;
}

export function isWorkerMode(): boolean {
  return process.env.FLUJO_WORKER_MODE === '1';
}

export function getWorkerBootstrapStatus(): WorkerBootstrapStatus {
  if (!isWorkerMode()) return { mode: 'local', state: 'not-started' };
  return global.__flujo_worker_bootstrap_status ?? { mode: 'worker', state: 'not-started' };
}

export function setWorkerBootstrapStatus(update: Partial<WorkerBootstrapStatus>): void {
  if (!isWorkerMode()) return;
  global.__flujo_worker_bootstrap_status = {
    ...getWorkerBootstrapStatus(),
    ...update,
    mode: 'worker',
  };
}

/** Route-runtime gate; proxy authentication must not depend on shared globals. */
export function assertWorkerRequestReady(request: Request, workspace: string): Response | null {
  if (!isWorkerMode()) return null;
  const status = getWorkerBootstrapStatus();
  if (status.workspace && workspace !== status.workspace) {
    return Response.json({ error: 'This workspace is not assigned to the worker.' }, { status: 404 });
  }
  const pathname = new URL(request.url).pathname;
  const bootstrapRead = request.method === 'GET' && [
    '/api/mcp/flujo/tools', '/api/mcp/flujo/resources', '/api/mcp/flujo/skills',
  ].includes(pathname);
  if (status.state === 'ready' || bootstrapRead || pathname === '/api/init'
      || pathname === '/api/encryption/secure') return null;
  return Response.json({ error: 'Worker is not ready.', code: 'WORKER_NOT_READY' }, {
    status: 503, headers: { 'Cache-Control': 'no-store' },
  });
}
