import type { McpEventOccurrence, McpEventPollResult } from '@/backend/services/mcp/serverEvents';
import type { HeldDeliveryOutcome } from './heldEventQueue';
import type { ArmedTrigger } from './types';

/**
 * "A tool server reports an event" with poll delivery (#1401, MCP events
 * extension `events/poll`). A protocol request at the pace the server asks
 * for, never a tool call a model makes.
 *
 * - A batch is handed over as one run. While the automation is busy FLUJO
 *   keeps that one batch and tries again; it does not poll further, so
 *   nothing piles up and nothing is skipped.
 * - The cursor is saved only after the batch was accepted, so a restart polls
 *   from the last accepted position and the "already seen" list drops repeats.
 * - `hasMore` drains a backlog at once; otherwise the next poll waits
 *   `nextPollMs`, never less than one second.
 */
export interface McpEventPollDeps {
  poll: (cursor: string | null) => Promise<McpEventPollResult>;
  loadCursor: () => Promise<string | null>;
  saveCursor: (cursor: string) => Promise<void>;
  deliver: (batch: McpEventOccurrence[]) => Promise<HeldDeliveryOutcome>;
  pin: () => void | Promise<void>;
  unpin: () => void | Promise<void>;
  onError: (message: string) => void;
  onSuccess: () => void;
  minIntervalMs?: number;
  defaultIntervalMs?: number;
  retryDelaysMs?: number[];
  busyDelaysMs?: number[];
}

const MIN_INTERVAL_MS = 1_000;
const DEFAULT_INTERVAL_MS = 30_000;
const RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 300_000];
const BUSY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

export function armMcpEventPoll(deps: McpEventPollDeps): ArmedTrigger {
  const minInterval = deps.minIntervalMs ?? MIN_INTERVAL_MS;
  const defaultInterval = deps.defaultIntervalMs ?? DEFAULT_INTERVAL_MS;
  const retryDelays = deps.retryDelaysMs ?? RETRY_DELAYS_MS;
  const busyDelays = deps.busyDelaysMs ?? BUSY_DELAYS_MS;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let busyAttempts = 0;
  let cursor: string | null | undefined;
  let held: { events: McpEventOccurrence[]; cursor: string | null } | null = null;

  const schedule = (delayMs: number) => {
    if (disposed) return;
    timer = setTimeout(() => void tick(), delayMs);
    timer.unref?.();
  };

  /** True when the held batch is done with (accepted, a repeat, or no longer wanted). */
  const deliverHeld = async (): Promise<boolean> => {
    if (!held) return true;
    const outcome = await deps.deliver(held.events);
    if (outcome === 'busy') return false;
    busyAttempts = 0;
    if (held.cursor !== null && outcome !== 'gone') await deps.saveCursor(held.cursor);
    cursor = held.cursor;
    held = null;
    return true;
  };

  const tick = async () => {
    if (disposed) return;
    try {
      if (!await deliverHeld()) {
        schedule(busyDelays[Math.min(busyAttempts++, busyDelays.length - 1)]);
        return;
      }
      if (cursor === undefined) cursor = await deps.loadCursor();
      const result = await deps.poll(cursor);
      if (disposed) return;
      failures = 0;
      deps.onSuccess();
      if (result.truncated && result.cursor !== null) deps.onError('The server skipped some events. Runs for them did not happen.');
      if (result.malformed > 0) deps.onError(`The server sent ${result.malformed} event(s) FLUJO could not read; they were skipped.`);
      if (result.events.length > 0) {
        held = { events: result.events, cursor: result.cursor };
        if (!await deliverHeld()) {
          schedule(busyDelays[Math.min(busyAttempts++, busyDelays.length - 1)]);
          return;
        }
      } else {
        if (result.cursor !== null && result.cursor !== cursor) await deps.saveCursor(result.cursor);
        cursor = result.cursor;
      }
      const drain = result.hasMore && result.events.length > 0;
      schedule(drain ? 0 : Math.max(minInterval, result.nextPollMs ?? defaultInterval));
    } catch (error) {
      if (disposed) return;
      deps.onError(error instanceof Error ? error.message : String(error));
      schedule(retryDelays[Math.min(failures++, retryDelays.length - 1)]);
    }
  };

  void Promise.resolve(deps.pin()).catch(() => undefined).then(tick);

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer) clearTimeout(timer);
      void Promise.resolve(deps.unpin()).catch(() => undefined);
    },
  };
}
