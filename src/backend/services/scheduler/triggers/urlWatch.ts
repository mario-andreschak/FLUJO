import { Cron } from 'croner';
import {
  PlannedExecutionState,
  UrlWatchTriggerConfig,
} from '@/shared/types/plannedExecution';
import { createLogger } from '@/utils/logger';
import { ArmedTrigger } from './types';
import { hashResult } from './pollEvaluators';

const log = createLogger('backend/services/scheduler/triggers/urlWatch');

/** Abort a hung fetch after this long. */
const FETCH_TIMEOUT_MS = 30_000;
/** Cap the fetched-content excerpt handed to the flow. */
const MAX_CONTEXT_CHARS = 8192;

export interface UrlWatchDeps {
  loadState: () => Promise<PlannedExecutionState>;
  saveState: (patch: Partial<PlannedExecutionState>) => Promise<void>;
  onFire: (payload: { summary: string; context: unknown }) => void;
  onError: (message: string) => void;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Watch an online resource: fetch the URL on a cron schedule, hash the body,
 * fire when the hash differs from the last check. The first successful fetch
 * primes the baseline without firing; an immediate check runs at arm time, so
 * after a FLUJO restart a change that happened while closed fires naturally.
 * Non-2xx responses and network errors surface as trigger errors (no run).
 *
 * NOTE: pages that embed ever-changing content (timestamps, session tokens)
 * hash differently on every fetch — the UI warns about this; prefer stable
 * endpoints (APIs, feeds, raw files).
 */
export function armUrlWatch(config: UrlWatchTriggerConfig, deps: UrlWatchDeps): ArmedTrigger {
  const doFetch = deps.fetchImpl ?? fetch;
  let busy = false;
  let disposed = false;

  const check = async (): Promise<void> => {
    if (disposed || busy) {
      return;
    }
    busy = true;
    try {
      const response = await doFetch(config.url, {
        redirect: 'follow',
        headers: { 'User-Agent': 'FLUJO-url-watch' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        deps.onError(`The URL answered with HTTP ${response.status}`);
        return;
      }
      const body = await response.text();
      const hash = hashResult(body);

      const state = await deps.loadState();
      if (disposed) {
        return;
      }
      if (!state.lastHash) {
        await deps.saveState({ lastHash: hash });
        return; // first fetch primes the baseline without firing
      }
      if (state.lastHash === hash) {
        return;
      }
      await deps.saveState({ lastHash: hash });
      deps.onFire({
        summary: 'Online content changed',
        context: {
          url: config.url,
          status: response.status,
          contentType: response.headers.get('content-type') ?? undefined,
          content:
            body.length > MAX_CONTEXT_CHARS
              ? `${body.slice(0, MAX_CONTEXT_CHARS)}… (truncated, ${body.length} chars total)`
              : body,
        },
      });
    } catch (error) {
      const message =
        error instanceof Error && error.name === 'TimeoutError'
          ? `The URL did not answer within ${FETCH_TIMEOUT_MS / 1000}s`
          : error instanceof Error
            ? error.message
            : String(error);
      log.warn(`URL check failed for ${config.url}: ${message}`);
      deps.onError(message);
    } finally {
      busy = false;
    }
  };

  const job = new Cron(
    config.cron,
    { timezone: config.timezone, unref: true },
    () => void check()
  );
  // Baseline (or natural catch-up) right away, not only at the next cron tick.
  void check();

  return {
    dispose: () => {
      disposed = true;
      job.stop();
    },
    nextRun: () => job.nextRun()?.toISOString() ?? null,
  };
}
