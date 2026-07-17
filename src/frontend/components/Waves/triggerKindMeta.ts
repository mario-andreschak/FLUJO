import type { WaveTriggerKind } from '@/shared/types/waves/waves';

export interface TriggerKindMeta {
  label: string;
  /** MUI-ish accent color for the node header / lane. */
  color: string;
  /** Whether this kind is placed on the drifting timeline. */
  timeline: boolean;
}

/**
 * Per-trigger-kind display metadata for the Waves canvas. Phrasing kept
 * consistent with the Planned Executions section.
 */
export const TRIGGER_KIND_META: Record<WaveTriggerKind, TriggerKindMeta> = {
  schedule: { label: 'Periodic', color: '#1976d2', timeline: true },
  'mcp-poll': { label: 'MCP Poll', color: '#7b1fa2', timeline: true },
  'url-watch': { label: 'URL Watch', color: '#0288d1', timeline: true },
  webhook: { label: 'Webhook', color: '#2e7d32', timeline: false },
  'file-watch': { label: 'File Watcher', color: '#ed6c02', timeline: false },
  'flow-event': { label: 'Event', color: '#616161', timeline: false },
};

export function triggerKindMeta(kind: WaveTriggerKind): TriggerKindMeta {
  return TRIGGER_KIND_META[kind] ?? { label: kind, color: '#616161', timeline: false };
}

/** Format the milliseconds until `nextRun` as "HH:MM until next run" (or similar). */
export function formatUntil(nextRun: string | null, now: number): string {
  if (!nextRun) return 'no scheduled run';
  const diff = new Date(nextRun).getTime() - now;
  if (Number.isNaN(diff)) return 'no scheduled run';
  if (diff <= 0) return 'due now';
  const totalMinutes = Math.floor(diff / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h until next run`;
  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  return `${hh}:${mm} until next run`;
}
