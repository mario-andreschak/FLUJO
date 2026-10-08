import type { ContextCompactionEvent } from '@/shared/types/contextCompaction';
import type { ModelInputSnapshot, WireStatus } from '../types';

type CompactionWireStatus = Extract<
  WireStatus,
  'summarized' | 'visually-archived' | 'emergency-stripped' | 'content-truncated'
>;

const COUNT_KEY: Record<CompactionWireStatus, keyof ModelInputSnapshot['counts']> = {
  summarized: 'summarized',
  'visually-archived': 'visuallyArchived',
  'emergency-stripped': 'emergencyStripped',
  'content-truncated': 'contentTruncated',
};

export function cloneModelInputSnapshot(
  snapshot: ModelInputSnapshot | undefined,
): ModelInputSnapshot | undefined {
  return snapshot ? structuredClone(snapshot) : undefined;
}

/** Mark canonical provenance without mutating the canonical conversation. */
export function markModelInputMessages(
  snapshot: ModelInputSnapshot | undefined,
  messageIds: Iterable<string | undefined>,
  status: CompactionWireStatus,
  reason: string,
): void {
  if (!snapshot) return;
  const ids = new Set([...messageIds].filter((id): id is string => Boolean(id)));
  if (ids.size === 0) return;

  let changed = 0;
  for (const entry of snapshot.provenance) {
    if (!entry.id || !ids.has(entry.id) || entry.status === 'system') continue;
    if (entry.status === status) {
      entry.reason = reason;
      continue;
    }
    if ((entry.status === 'sent' || entry.status === 'content-truncated') && status !== 'content-truncated') {
      snapshot.counts.sent = Math.max(0, snapshot.counts.sent - 1);
    }
    if (entry.status in COUNT_KEY) {
      const previousKey = COUNT_KEY[entry.status as CompactionWireStatus];
      snapshot.counts[previousKey] = Math.max(0, (snapshot.counts[previousKey] ?? 0) - 1);
    }
    entry.status = status;
    entry.reason = reason;
    changed += 1;
  }
  if (changed > 0) {
    const key = COUNT_KEY[status];
    snapshot.counts[key] = (snapshot.counts[key] ?? 0) + changed;
  }
}

export function recordContextCompaction(
  snapshot: ModelInputSnapshot | undefined,
  event: ContextCompactionEvent,
): void {
  if (!snapshot) return;
  snapshot.contextCompaction ??= { events: [] };
  snapshot.contextCompaction.events.push(event);
}
