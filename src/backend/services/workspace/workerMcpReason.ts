import { TrustedHostMcpError } from '@/backend/services/security/trustedHostMcp';
import { McpIsolationError } from '@/backend/services/security/isolatedMcp';
import type { PublishedWorkerMcpServers, WorkerMcpReason, WorkerMcpReasonCode, WorkerMcpServerReport } from './workerMode';

/** A preparation step that already knows which fixed reason applies. */
export class WorkerMcpPreparationError extends Error {
  constructor(readonly code: WorkerMcpReasonCode, message: string) {
    super(message);
    this.name = 'WorkerMcpPreparationError';
  }
}

/** Waiting servers need something outside FLUJO and start by themselves once it appears. */
const WAITING = new Set<WorkerMcpReasonCode>([
  'HOST_CONSENT_REQUIRED', 'HOST_SOURCE_CHANGED', 'HOST_POLICY_INVALID',
  'ISOLATION_RECONSENT_REQUIRED', 'ISOLATION_POLICY_INVALID', 'ISOLATION_UNAVAILABLE',
]);
const CODES = new Set<string>([...WAITING, 'RUNTIME_MISMATCH', 'RECIPE_MISSING', 'INSTALL_FAILED',
  'CONFIG_CHANGED', 'CONNECT_FAILED', 'PREPARE_FAILED']);

export interface WorkerMcpReasonOptions {
  /** After readiness the worker retries by itself; before it, /api/init or a restart does. */
  afterReady?: boolean;
}

function ownerApproval(serverName: string): string {
  const route = `GET, then POST /api/mcp/servers/${encodeURIComponent(serverName)}/host-consent`;
  return process.env.FLUJO_OWNER_AUTH_FILE && process.env.FLUJO_MCP_TRUSTED_HOST_FILE
    ? `approve it as the owner (${route})`
    : `start the worker with an owner key file (FLUJO_OWNER_AUTH_FILE) and an approval file (FLUJO_MCP_TRUSTED_HOST_FILE), then approve it as the owner (${route})`;
}

/** The only place worker MCP reasons are worded. Never pass an error's own text in here. */
export function workerMcpReason(code: WorkerMcpReasonCode, serverName: string, options: WorkerMcpReasonOptions = {}): WorkerMcpReason {
  const retry = options.afterReady
    ? 'The worker tries again by itself.'
    : 'Then call /api/init or restart the worker to try again.';
  const startsAlone = 'It starts by itself once approved, without a restart.';
  switch (code) {
    case 'HOST_CONSENT_REQUIRED': return { code,
      message: 'This server needs the owner\'s approval before it can run on this worker.',
      action: `To use it, ${ownerApproval(serverName)}. ${startsAlone} Or turn it off in the source workspace before you copy it.` };
    case 'HOST_SOURCE_CHANGED': return { code,
      message: 'This server\'s program changed after the owner approved it.',
      action: `Check the change, then ${ownerApproval(serverName)} again. ${startsAlone}` };
    case 'HOST_POLICY_INVALID': return { code,
      message: 'This server\'s approval does not match how it starts on this worker.',
      action: `Check its command and settings, then ${ownerApproval(serverName)} again. ${startsAlone}` };
    case 'ISOLATION_RECONSENT_REQUIRED': return { code,
      message: 'This server\'s container settings changed after they were approved.',
      action: `Add a new matching approval to the isolation approval file (FLUJO_MCP_ISOLATION_FILE). ${startsAlone}` };
    case 'ISOLATION_POLICY_INVALID': return { code,
      message: 'This server\'s container settings are not valid.',
      action: 'Fix its Docker program, image, folders or limits, then approve them again in the isolation approval file. It starts by itself once they are valid.' };
    case 'ISOLATION_UNAVAILABLE': return { code,
      message: 'The container runtime this server needs is not available.',
      action: 'Start Docker and install the approved image. The server starts by itself once Docker is ready.' };
    case 'RUNTIME_MISMATCH': return { code,
      message: 'The worker\'s copy of this server differs from the one in the snapshot.',
      action: 'Run the worker with the same FLUJO version as the computer that made the snapshot.' };
    case 'RECIPE_MISSING': return { code,
      message: 'The snapshot does not say how to install this server.',
      action: 'Reinstall it from GitHub or the Registry in the source workspace, or turn it off, then take a new snapshot.' };
    case 'INSTALL_FAILED': return { code,
      message: 'Installing this server on the worker failed.',
      action: `Check that the worker can reach GitHub and the package registry. ${retry}` };
    case 'CONFIG_CHANGED': return { code,
      message: 'This server\'s settings changed while the worker was preparing it.',
      action: options.afterReady ? retry : 'Call /api/init or restart the worker to try again.' };
    case 'CONNECT_FAILED': return { code,
      message: 'The server is installed but did not start.',
      action: `Check this server's start-up output in the worker log. ${retry}` };
    case 'PREPARE_FAILED': return { code,
      message: 'Preparing this server on the worker failed.',
      action: options.afterReady ? retry
        : 'Call /api/init or restart the worker to try again. If it keeps failing, restore the worker from a new snapshot.' };
  }
}

export function isWaitingReason(code: WorkerMcpReasonCode): boolean {
  return WAITING.has(code);
}

/** A status entry for a server that is not running. */
export function workerMcpServerReport(name: string, code: WorkerMcpReasonCode, options?: WorkerMcpReasonOptions): WorkerMcpServerReport {
  const reason = workerMcpReason(code, name, options);
  return { name, status: isWaitingReason(code) ? 'waiting' : 'failed', error: reason.message, reason };
}

function knownCode(value: unknown): WorkerMcpReasonCode | undefined {
  return typeof value === 'string' && CODES.has(value) ? value as WorkerMcpReasonCode : undefined;
}

/**
 * Rebuild every entry from its name, status and code alone. Whatever text a
 * caller put in `error`, `message` or `action` is dropped, so the status and
 * the log only ever show the fixed wording above.
 */
export function normalizeWorkerMcpServers(servers: readonly WorkerMcpServerReport[], options?: WorkerMcpReasonOptions): PublishedWorkerMcpServers {
  const published: readonly WorkerMcpServerReport[] = servers.map((server): WorkerMcpServerReport => {
    if (server.status === 'ready' || server.status === 'disabled') return { name: server.name, status: server.status };
    const code = knownCode('reason' in server ? server.reason?.code : undefined)
      ?? (server.status === 'waiting' ? 'HOST_CONSENT_REQUIRED' : 'PREPARE_FAILED');
    return workerMcpServerReport(server.name, code, options);
  });
  return published as PublishedWorkerMcpServers;
}

/** Read only an error's class and fixed code, never its message. */
export function workerMcpReasonCode(error: unknown, fallback: WorkerMcpReasonCode): WorkerMcpReasonCode {
  if (error instanceof WorkerMcpPreparationError || error instanceof TrustedHostMcpError || error instanceof McpIsolationError) {
    return knownCode(error.code) ?? fallback;
  }
  return fallback;
}

/** A refused connection keeps only its fixed approval code. */
export function workerMcpConnectReasonCode(response: { errorCode?: string; requiresApproval?: boolean }): WorkerMcpReasonCode {
  const code = knownCode(response.errorCode);
  if (code && isWaitingReason(code)) return code;
  return response.requiresApproval ? 'HOST_CONSENT_REQUIRED' : 'CONNECT_FAILED';
}
