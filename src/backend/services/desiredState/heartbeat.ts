/**
 * Optional, off unless a URL is set: tells someone looking after many instances which
 * version this one is on and whether it is fine. It sends version and status only, with
 * no workspace name, no content and nothing about what the instance does.
 *
 * A heartbeat that fails changes nothing else and is simply tried again next time.
 */
import { getWorkerCompatibility } from '@/backend/services/workspace/workerCompatibility';
import { isWorkerMode } from '@/backend/services/workspace/workerMode';
import { StorageKey, type Settings } from '@/shared/types/storage';
import { isEncryptionLocked } from '@/utils/encryption/secure';
import { createLogger } from '@/utils/logger';
import { loadItem } from '@/utils/storage/backend';
import { DEFAULT_WORKSPACE, getCurrentWorkspace, listWorkspaces, runWithWorkspace } from '@/utils/workspace';
import { loadStatus, updateStatus } from './store';

const log = createLogger('backend/services/desiredState/heartbeat');

export const HEARTBEAT_URL_ENV = 'FLUJO_HEARTBEAT_URL';
export const HEARTBEAT_TOKEN_ENV = 'FLUJO_HEARTBEAT_TOKEN';
const DEFAULT_INTERVAL_MINUTES = 15;
const TICK_MS = 60_000;
const SEND_TIMEOUT_MS = 10_000;

declare global {
  var __flujo_heartbeat_timer: ReturnType<typeof setInterval> | undefined;
  var __flujo_heartbeat_next_due: Map<string, number> | undefined;
}

const nextDue = (): Map<string, number> => (global.__flujo_heartbeat_next_due ??= new Map());

function usableUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return url.protocol === 'https:' || (url.protocol === 'http:' && loopback) ? url : null;
  } catch {
    return null;
  }
}

/** The environment speaks for the default workspace only, so it cannot leak across groups. */
function configuredUrl(settings: Settings | null): unknown {
  const fromEnv = getCurrentWorkspace() === DEFAULT_WORKSPACE ? process.env[HEARTBEAT_URL_ENV]?.trim() : undefined;
  return fromEnv || settings?.heartbeat?.url;
}

async function sendOne(now: number): Promise<void> {
  const settings = await loadItem<Settings | null>(StorageKey.SPEECH_SETTINGS, null);
  const configured = configuredUrl(settings);
  if (!configured) return;
  const workspace = getCurrentWorkspace();
  const due = nextDue().get(workspace);
  if (due !== undefined && now < due) return;
  const minutes = settings?.heartbeat?.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES;
  // A little spread, so many instances started together do not all report at once.
  nextDue().set(workspace, now + minutes * 60_000 * (0.9 + Math.random() * 0.2));

  const url = usableUrl(configured);
  let ok = false;
  if (url) {
    const status = await loadStatus();
    const locked = await isEncryptionLocked();
    const body = {
      schemaVersion: 1,
      flujoVersion: getWorkerCompatibility().applicationVersion,
      desiredStateVersion: status.appliedVersion,
      appliedAt: status.appliedAt,
      lastApplyFailed: status.lastApplyFailed,
      status: locked ? 'locked'
        : status.lastApplyFailed || status.interruptedApply === 'needs-attention' ? 'attention' : 'ok',
    };
    const token = workspace === DEFAULT_WORKSPACE ? process.env[HEARTBEAT_TOKEN_ENV]?.trim() : undefined;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
        // A redirect could carry the token somewhere else, so it counts as a failure.
        redirect: 'manual',
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      ok = response.ok;
    } catch {
      ok = false;
    }
  }
  // The address may name the installation, and the token is secret. Neither goes in a log.
  if (!ok) log.debug('A heartbeat was not delivered');
  await updateStatus({ heartbeat: { lastSentAt: new Date(now).toISOString(), lastOk: ok } });
}

/** One pass over every workspace. Each decides for itself whether it reports. */
export async function sendDesiredStateHeartbeats(now = Date.now()): Promise<void> {
  if (isWorkerMode()) return;
  const workspaces = await listWorkspaces();
  for (const { name } of workspaces) {
    try {
      await runWithWorkspace(name, () => sendOne(now));
    } catch (error) {
      log.debug(`Heartbeat pass failed for workspace ${name}`, error);
    }
  }
}

/** Once per process. The timer never keeps the process alive. */
export function armDesiredStateHeartbeat(): void {
  if (global.__flujo_heartbeat_timer || isWorkerMode()) return;
  global.__flujo_heartbeat_timer = setInterval(() => {
    void sendDesiredStateHeartbeats().catch((error) => log.debug('Heartbeat pass failed', error));
  }, TICK_MS);
  global.__flujo_heartbeat_timer.unref?.();
}
