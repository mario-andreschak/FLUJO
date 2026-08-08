import { createHmac, randomBytes, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import {
  sanitizeStatisticsEvent,
  STATISTICS_SCHEMA_VERSION,
  type StatisticsErrorClass,
  type StatisticsEvent,
  type StatisticsSkipReason,
} from '@/shared/types/statistics';
import { createLogger } from '@/utils/logger';
import { getWorkspaceDataDir, workspaceCacheKey } from '@/utils/workspace';

const log = createLogger('backend/services/statistics');
const SAFE_UTC_DAY = /^\d{4}-\d{2}-\d{2}$/;
export const STATISTICS_RETENTION_DAYS = 90;

type StatisticsEventInput = StatisticsEvent extends infer Event
  ? Event extends StatisticsEvent
    ? Omit<Event, 'schemaVersion' | 'eventId' | 'timestamp'> & { timestamp?: string }
    : never
  : never;

// Per-call resolution: statistics live in the selected workspace's db/ (#406).
let statisticsDirOverride: string | undefined;
const statisticsDir = () =>
  statisticsDirOverride ?? path.join(getWorkspaceDataDir(), 'db', 'statistics');
// All three of these are keyed by workspace: a day partition, an installation
// HMAC key and a "already pruned today" marker all belong to ONE workspace's
// statistics directory.
const appendChains = new Map<string, Promise<void>>();
const keyPromises = new Map<string, Promise<Buffer>>();
const lastPrunedDay = new Map<string, string>();

export function _setStatisticsDirForTests(dir: string): string {
  const previous = statisticsDir();
  statisticsDirOverride = dir;
  appendChains.clear();
  keyPromises.clear();
  lastPrunedDay.clear();
  return previous;
}

export function createStatisticsEvent(input: StatisticsEventInput): StatisticsEvent {
  const event = sanitizeStatisticsEvent({
    ...input,
    schemaVersion: STATISTICS_SCHEMA_VERSION,
    eventId: randomUUID(),
    timestamp: input.timestamp ?? new Date().toISOString(),
  });
  if (!event) throw new TypeError('Invalid statistics event');
  return event;
}

function utcDay(timestamp: string): string {
  const day = timestamp.slice(0, 10);
  if (!SAFE_UTC_DAY.test(day) || !Number.isFinite(Date.parse(`${day}T00:00:00.000Z`))) {
    throw new TypeError('Statistics event timestamp does not contain a valid UTC day');
  }
  return day;
}

function eventFile(day: string): string {
  if (!SAFE_UTC_DAY.test(day)) throw new TypeError('Invalid statistics day');
  return path.join(statisticsDir(), `${day}.jsonl`);
}

async function pruneOldPartitions(today: string): Promise<void> {
  const pruneKey = workspaceCacheKey('statistics-prune');
  if (lastPrunedDay.get(pruneKey) === today) return;
  lastPrunedDay.set(pruneKey, today);
  const cutoff = Date.parse(`${today}T00:00:00.000Z`) - STATISTICS_RETENTION_DAYS * 86_400_000;
  try {
    const entries = await fs.readdir(statisticsDir(), { withFileTypes: true });
    await Promise.all(entries.map(async entry => {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) return;
      const day = entry.name.slice(0, -'.jsonl'.length);
      if (!SAFE_UTC_DAY.test(day)) return;
      if (Date.parse(`${day}T00:00:00.000Z`) < cutoff) {
        await fs.unlink(path.join(statisticsDir(), entry.name));
      }
    }));
  } catch {
    // Retention is best-effort, like event writes themselves.
  }
}

export function appendStatisticsEvent(event: StatisticsEvent): Promise<void> {
  const sanitized = sanitizeStatisticsEvent(event);
  if (!sanitized) {
    return Promise.reject(new TypeError('Invalid or unsupported statistics event'));
  }
  const day = utcDay(sanitized.timestamp);
  // Same UTC day in two workspaces = two different files, so the append chain is
  // per (workspace, day) rather than per day (#406).
  const chain = workspaceCacheKey('statistics', day);
  const previous = appendChains.get(chain) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      await fs.mkdir(statisticsDir(), { recursive: true });
      await fs.appendFile(eventFile(day), `${JSON.stringify(sanitized)}\n`, 'utf8');
      void pruneOldPartitions(day);
    });
  appendChains.set(chain, next);
  void next.finally(() => {
    if (appendChains.get(chain) === next) appendChains.delete(chain);
  }).catch(() => undefined);
  return next;
}

/** Enqueue an event without allowing storage failure to alter execution. */
export function recordStatisticsEvent(event: StatisticsEvent): void {
  void appendStatisticsEvent(event).catch(() => {
    log.warn('Statistics event append failed', { type: event.type });
  });
}

export async function flushStatisticsEvents(): Promise<void> {
  await Promise.allSettled([...appendChains.values()]);
}

export interface StatisticsPartitionMetadata {
  day: string;
  exists: boolean;
  mtimeMs?: number;
  size?: number;
}

/** Reads freshness for one selected partition without enumerating history. */
export async function getStatisticsPartitionMetadata(day: string): Promise<StatisticsPartitionMetadata> {
  try {
    const stat = await fs.stat(eventFile(day));
    return { day, exists: true, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { day, exists: false };
    throw error;
  }
}

export async function readStatisticsEvents(day: string): Promise<StatisticsEvent[]> {
  let body: string;
  try {
    body = await fs.readFile(eventFile(day), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const events: StatisticsEvent[] = [];
  let invalidRecords = 0;
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = sanitizeStatisticsEvent(JSON.parse(line) as unknown);
      if (parsed) events.push(parsed);
      else invalidRecords += 1;
    } catch {
      invalidRecords += 1;
      // Corrupt middle records and truncated tails are ignored independently.
    }
  }
  if (invalidRecords > 0) {
    log.warn('Ignored invalid statistics records', { day, count: invalidRecords });
  }
  return events;
}

async function loadInstallationKey(): Promise<Buffer> {
  const keyFile = path.join(statisticsDir(), '.installation-key');
  await fs.mkdir(statisticsDir(), { recursive: true });
  try {
    return await fs.readFile(keyFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const generated = randomBytes(32);
  try {
    await fs.writeFile(keyFile, generated, { flag: 'wx', mode: 0o600 });
    return generated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return fs.readFile(keyFile);
    throw error;
  }
}

/** Stable installation-local grouping. Neither the credential nor HMAC key is serialized. */
export async function credentialFingerprint(credential: string | undefined | null): Promise<string | undefined> {
  if (!credential) return undefined;
  const installationKeyId = workspaceCacheKey('statistics-installation-key');
  let keyPromise = keyPromises.get(installationKeyId);
  if (!keyPromise) {
    keyPromise = loadInstallationKey();
    keyPromises.set(installationKeyId, keyPromise);
  }
  const key = await keyPromise;
  return `cred_${createHmac('sha256', key).update(credential).digest('base64url').slice(0, 22)}`;
}

export function classifyStatisticsError(value: unknown): StatisticsErrorClass {
  const code = typeof value === 'object' && value !== null
    ? String((value as { code?: unknown; type?: unknown }).code ?? (value as { type?: unknown }).type ?? '')
    : '';
  const name = value instanceof Error ? value.name : '';
  const text = `${code} ${name}`.toLowerCase();
  if (/cancel|abort/.test(text)) return 'cancelled';
  if (/401|authenticat|api_key/.test(text)) return 'authentication';
  if (/403|permission|authoriz/.test(text)) return 'authorization';
  if (/429|rate.?limit/.test(text)) return 'rate_limit';
  if (/context|token.?limit/.test(text)) return 'context_limit';
  if (/timeout/.test(text)) return 'timeout';
  if (/network|fetch|socket|econn/.test(text)) return 'network';
  if (/config|model_not_found/.test(text)) return 'configuration';
  if (/valid|parse|schema/.test(text)) return 'validation';
  if (/provider|api_error/.test(text)) return 'provider';
  return 'unknown';
}

export function classifySchedulerSkip(reason: string): StatisticsSkipReason {
  const value = reason.toLowerCase();
  if (value.includes('disabled')) return 'disabled';
  if (value.includes('deleted')) return 'deleted';
  if (value.includes('encryption locked')) return 'encryption_locked';
  if (value.includes('queue full') || value.includes('queue cap')) return 'queue_full';
  if (value.includes('exclusive')) return 'exclusive_lock';
  if (value.includes('overlap') || value.includes('previous run')) return 'overlap';
  if (value.includes('pause')) return 'paused';
  if (value.includes('duplicate')) return 'duplicate';
  if (value.includes('ineligible') || value.includes('no longer')) return 'ineligible';
  return 'unknown';
}
