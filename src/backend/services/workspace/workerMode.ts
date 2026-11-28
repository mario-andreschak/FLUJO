import { startupChanged, waitForStartup, type StartupWait } from './startupWait';

/** Why an MCP server is not running on the worker. Built only by `workerMcpReason.ts`. */
export type WorkerMcpReasonCode =
  | 'HOST_CONSENT_REQUIRED' | 'HOST_SOURCE_CHANGED' | 'HOST_POLICY_INVALID'
  | 'ISOLATION_RECONSENT_REQUIRED' | 'ISOLATION_POLICY_INVALID' | 'ISOLATION_UNAVAILABLE'
  | 'RUNTIME_MISMATCH' | 'RECIPE_MISSING' | 'INSTALL_FAILED' | 'CONFIG_CHANGED'
  | 'CONNECT_FAILED' | 'PREPARE_FAILED';

export interface WorkerMcpReason {
  code: WorkerMcpReasonCode;
  /** One plain sentence from a fixed list; never an error's own text. */
  message: string;
  /** What the operator can do about it. */
  action: string;
}

/**
 * A server that is not running always says why. `waiting` servers do not block
 * the worker and start by themselves once their approval or runtime appears.
 */
export type WorkerMcpServerReport =
  | { name: string; status: 'ready' | 'disabled' }
  | { name: string; status: 'waiting' | 'failed'; error: string; reason: WorkerMcpReason };

declare const rebuiltFromFixedWording: unique symbol;

/**
 * The server list the status shows. Only `normalizeWorkerMcpServers` in
 * `workerMcpReason.ts` makes one, so a hand-built entry with an error's own
 * text cannot reach the status.
 */
export type PublishedWorkerMcpServers = readonly WorkerMcpServerReport[] & { readonly [rebuiltFromFixedWording]: true };

/** Lightweight worker state shared by the startup graph and HTTP routes. */
export interface WorkerBootstrapStatus {
  mode: 'local' | 'worker';
  state: 'not-started' | 'restoring' | 'locked' | 'installing' | 'ready' | 'error';
  workspace?: string;
  archiveSha256?: string;
  error?: string;
  servers?: PublishedWorkerMcpServers;
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
  startupChanged();
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

/** States a worker passes through on its own while it starts; `locked` and `error` need someone. */
const STARTING_STATES: ReadonlySet<WorkerBootstrapStatus['state']> = new Set(['not-started', 'restoring', 'installing']);

/**
 * Like assertWorkerRequestReady, but a request that arrives while the worker is
 * still starting waits for it (#757) instead of getting 503 at once.
 */
export async function waitForWorkerRequestReady(request: Request, workspace: string, wait: StartupWait): Promise<Response | null> {
  const refused = assertWorkerRequestReady(request, workspace);
  if (!refused || refused.status !== 503 || !STARTING_STATES.has(getWorkerBootstrapStatus().state)) return refused;
  await waitForStartup(() => !STARTING_STATES.has(getWorkerBootstrapStatus().state), wait);
  return assertWorkerRequestReady(request, workspace);
}
