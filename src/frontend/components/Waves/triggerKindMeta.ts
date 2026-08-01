import type { WaveTriggerKind } from '@/shared/types/waves/waves';
import type { TranslationKey } from '@/frontend/i18n/messages';
import type { Translator } from '@/frontend/i18n/core';

export interface TriggerKindMeta {
  label: string;
  labelKey?: TranslationKey;
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
  schedule: { label: 'Periodic', labelKey: 'waves.kind.schedule', color: '#1976d2', timeline: true },
  'mcp-poll': { label: 'MCP Poll', labelKey: 'waves.kind.mcpPoll', color: '#7b1fa2', timeline: true },
  'url-watch': { label: 'URL Watch', labelKey: 'waves.kind.urlWatch', color: '#0288d1', timeline: true },
  webhook: { label: 'Webhook', labelKey: 'waves.kind.webhook', color: '#2e7d32', timeline: false },
  'file-watch': { label: 'File Watcher', labelKey: 'waves.kind.fileWatch', color: '#ed6c02', timeline: false },
  'flow-event': { label: 'Event', labelKey: 'waves.kind.event', color: '#616161', timeline: false },
};

export function triggerKindMeta(kind: WaveTriggerKind): TriggerKindMeta {
  return TRIGGER_KIND_META[kind] ?? { label: kind, color: '#616161', timeline: false };
}

/** Format the milliseconds until `nextRun` as "HH:MM until next run" (or similar). */
export function formatUntil(nextRun: string | null, now: number, t?: Translator): string {
  if (!nextRun) return t ? t('waves.noScheduledRun') : 'no scheduled run';
  const diff = new Date(nextRun).getTime() - now;
  if (Number.isNaN(diff)) return t ? t('waves.noScheduledRun') : 'no scheduled run';
  if (diff <= 0) return t ? t('waves.dueNow') : 'due now';
  const totalMinutes = Math.floor(diff / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return t ? t('waves.untilDaysHours', { days, hours }) : `${days}d ${hours}h until next run`;
  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  return t ? t('waves.untilHoursMinutes', { hours: hh, minutes: mm }) : `${hh}:${mm} until next run`;
}
