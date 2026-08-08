/**
 * Anonymous daily-active installation telemetry.
 *
 * Privacy properties:
 * - default-on but locally configurable (opt-out);
 * - one attempt per UTC day;
 * - a fresh random id every UTC day, so the collector cannot link activity
 *   across days;
 * - no flow, prompt, model, key, filename, account, or hardware identifier;
 * - failures are swallowed and can never affect normal FLUJO operation.
 */
import { randomUUID } from 'crypto';
import packageJson from '../../../../package.json';
import { DEFAULT_REGISTRY_URL } from '@/shared/types/registry';
import {
  Settings,
  StorageKey,
  TelemetrySettings,
} from '@/shared/types/storage';
import { getInstallMode } from '@/utils/paths';
import { createLogger } from '@/utils/logger';
import { loadItem, saveItem } from '@/utils/storage/backend';
import { bindToCurrentWorkspace, getCurrentWorkspace } from '@/utils/workspace';

const log = createLogger('backend/services/telemetry');
const TELEMETRY_PATH = '/v1/telemetry/daily-active';
const REQUEST_TIMEOUT_MS = 5_000;

export const DEFAULT_TELEMETRY_SETTINGS: TelemetrySettings = {
  enabled: true,
  notifyDaily: true,
};

interface TelemetryState {
  dailyId?: string;
  dailyIdDate?: string;
  lastAttemptDate?: string;
  lastSentDate?: string;
  lastNotificationDate?: string;
}

export interface DailyTelemetryResult {
  enabled: boolean;
  attempted: boolean;
  sent: boolean;
  shouldNotify: boolean;
}

export interface DailyActivityCount {
  date: string;
  count: number;
}

const checksInFlight = new Map<string, Promise<DailyTelemetryResult>>();

export function utcDateKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function resolveTelemetryUrl(): string {
  const override = process.env.FLUJO_TELEMETRY_URL?.trim();
  return override || `${DEFAULT_REGISTRY_URL}${TELEMETRY_PATH}`;
}

/** Fetch the collector's public aggregate without exposing collector details to the browser. */
export async function fetchDailyActivityCount(
  date: string = utcDateKey(),
): Promise<DailyActivityCount | null> {
  const url = new URL(resolveTelemetryUrl());
  url.searchParams.set('date', date);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Partial<DailyActivityCount>;
    if (
      body.date !== date ||
      typeof body.count !== 'number' ||
      !Number.isSafeInteger(body.count) ||
      body.count < 0
    ) {
      return null;
    }
    return { date: body.date, count: body.count };
  } catch (error) {
    log.debug(
      'Daily activity count could not be read from the collector',
      error instanceof Error ? error.message : String(error),
    );
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeSettings(settings: Settings): TelemetrySettings {
  return {
    enabled: settings.telemetry?.enabled !== false,
    notifyDaily: settings.telemetry?.notifyDaily !== false,
  };
}

async function runDailyCheck(now: Date): Promise<DailyTelemetryResult> {
  const date = utcDateKey(now);
  const settings = await loadItem<Settings>(
    StorageKey.SPEECH_SETTINGS,
    { speech: { enabled: true } },
  );
  const telemetry = normalizeSettings(settings);

  if (!telemetry.enabled) {
    return { enabled: false, attempted: false, sent: false, shouldNotify: false };
  }

  const state = await loadItem<TelemetryState>(StorageKey.TELEMETRY_STATE, {});
  const shouldNotify =
    telemetry.notifyDaily && state.lastNotificationDate !== date;
  const alreadyAttempted = state.lastAttemptDate === date;

  if (shouldNotify) {
    state.lastNotificationDate = date;
  }

  if (alreadyAttempted) {
    if (shouldNotify) await saveItem(StorageKey.TELEMETRY_STATE, state);
    return {
      enabled: true,
      attempted: false,
      sent: state.lastSentDate === date,
      shouldNotify,
    };
  }

  if (state.dailyIdDate !== date || !state.dailyId) {
    state.dailyId = randomUUID();
    state.dailyIdDate = date;
  }

  // Persist before network I/O. Even a failed collector request is attempted
  // only once that day, avoiding repeated background traffic.
  state.lastAttemptDate = date;
  await saveItem(StorageKey.TELEMETRY_STATE, state);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let sent = false;
  try {
    const response = await fetch(resolveTelemetryUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        anonymousDailyId: state.dailyId,
        date,
        version: packageJson.version,
        platform: process.platform,
        installMethod: getInstallMode(),
      }),
      signal: controller.signal,
      cache: 'no-store',
    });
    sent = response.ok;
    if (sent) {
      state.lastSentDate = date;
      await saveItem(StorageKey.TELEMETRY_STATE, state);
    } else {
      log.debug('Daily telemetry collector returned a non-success status', {
        status: response.status,
      });
    }
  } catch (error) {
    log.debug(
      'Daily telemetry check could not reach the collector',
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    clearTimeout(timeout);
  }

  return {
    enabled: true,
    attempted: true,
    sent,
    shouldNotify,
  };
}

/**
 * Process-local single-flight wrapper. The persisted last-attempt date supplies
 * the cross-reload guard; this wrapper prevents duplicate calls during one boot.
 */
export function checkDailyActivity(
  now: Date = new Date(),
): Promise<DailyTelemetryResult> {
  const workspace = getCurrentWorkspace();
  const existing = checksInFlight.get(workspace);
  if (existing) return existing;
  const check = bindToCurrentWorkspace(runDailyCheck)(now);
  const guarded = check.finally(bindToCurrentWorkspace(() => {
    if (checksInFlight.get(workspace) === guarded) checksInFlight.delete(workspace);
  }));
  checksInFlight.set(workspace, guarded);
  return guarded;
}

/** Test helper: clear only the process-local guard, never persisted state. */
export function _resetTelemetrySingleFlight(): void {
  checksInFlight.delete(getCurrentWorkspace());
}
