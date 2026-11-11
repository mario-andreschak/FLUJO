import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import type { McpEventTriggerConfig } from '@/shared/types/plannedExecution';
import { DEFAULT_WORKSPACE } from '@/utils/workspace';
import type { ArmedTrigger } from './types';

/**
 * "When a tool server reports an event": FLUJO asks the MCP server to send signed
 * webhooks to a local URL. The server keeps the events and retries, so reliability
 * lives with the sender; FLUJO only has to keep the subscription fresh.
 */

/** Refreshing often means a receiver that came back gets its backlog within minutes. */
const REFRESH_MS = 5 * 60_000;
const SUBSCRIPTION_TTL_MS = 7 * 86_400_000;
const RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 300_000];
const SIGNATURE_TOLERANCE_SECONDS = 300;

export interface McpEventDeps {
  subscribe: (ttlMs: number) => Promise<{ refreshBefore: string | null }>;
  /** Keeps the server running while the trigger is armed. */
  pin: () => void | Promise<void>;
  unpin: () => void | Promise<void>;
  onError: (message: string) => void;
  onSuccess: () => void;
  now?: () => number;
  retryDelaysMs?: number[];
  refreshMs?: number;
}

export function newMcpEventSecret(): string {
  return `whsec_${randomBytes(32).toString('base64')}`;
}

/** Part of the delivery URL, so a subscription from an older configuration is refused and stops. */
export function mcpEventFingerprint(trigger: Pick<McpEventTriggerConfig, 'serverName' | 'eventName' | 'arguments'>): string {
  const key = JSON.stringify([trigger.serverName, trigger.eventName, trigger.arguments ?? {}]);
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** Always this machine: event content never needs to leave it to reach FLUJO. */
export function mcpEventDeliveryUrl(executionId: string, trigger: McpEventTriggerConfig, workspace: string): string {
  const configured = process.env.FLUJO_BASE_URL ? new URL(process.env.FLUJO_BASE_URL) : undefined;
  const port = process.env.FLUJO_PORT || configured?.port || '4200';
  const url = new URL(`http://127.0.0.1:${port}/api/webhooks/mcp/${encodeURIComponent(executionId)}`);
  url.searchParams.set('v', mcpEventFingerprint(trigger));
  if (workspace !== DEFAULT_WORKSPACE) url.searchParams.set('workspace', workspace);
  return url.toString();
}

/** Standard Webhooks verification. Any listed `v1` signature may match, which allows rotation. */
export function verifyMcpEventSignature(
  secret: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  body: string,
  nowMs: number = Date.now(),
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest();
  return signature.split(' ').some((entry) => {
    if (!entry.startsWith('v1,')) return false;
    const provided = Buffer.from(entry.slice(3), 'base64');
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  });
}

export function armMcpEvent(deps: McpEventDeps): ArmedTrigger {
  const now = deps.now ?? Date.now;
  const retryDelays = deps.retryDelaysMs ?? RETRY_DELAYS_MS;
  const refreshMs = deps.refreshMs ?? REFRESH_MS;
  let disposed = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (delayMs: number) => {
    timer = setTimeout(() => void tick(), delayMs);
    timer.unref?.();
  };

  const tick = async () => {
    if (disposed) return;
    try {
      const { refreshBefore } = await deps.subscribe(SUBSCRIPTION_TTL_MS);
      if (disposed) return;
      failures = 0;
      deps.onSuccess();
      const remaining = refreshBefore ? Date.parse(refreshBefore) - now() : Infinity;
      schedule(Math.max(1_000, Math.min(refreshMs, remaining / 2)));
    } catch (error) {
      if (disposed) return;
      deps.onError(error instanceof Error ? error.message : String(error));
      schedule(retryDelays[Math.min(failures, retryDelays.length - 1)]);
      failures++;
    }
  };

  void Promise.resolve(deps.pin()).catch(() => undefined).then(tick);

  return {
    // The subscription stays: events that arrive while FLUJO is down wait for it.
    // A disabled or changed automation answers 410, which ends the subscription.
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      void Promise.resolve(deps.unpin()).catch(() => undefined);
    },
  };
}
