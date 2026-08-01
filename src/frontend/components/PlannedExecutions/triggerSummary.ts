import { TriggerConfig } from '@/shared/types/plannedExecution';
import { translate, type Translator } from '@/frontend/i18n/core';
import { DEFAULT_LOCALE } from '@/frontend/i18n/locales';

const english: Translator = (key, values) => translate(DEFAULT_LOCALE, key, values);

/** Short human-readable description of a trigger, for card chips. */
export function describeTrigger(trigger: TriggerConfig, t: Translator = english): string {
  switch (trigger.type) {
    case 'schedule': {
      const preset = matchCronPreset(trigger.cron, t);
      return preset ?? t('automations.trigger.schedule', { cron: trigger.cron });
    }
    case 'webhook':
      return t('automations.trigger.webhook');
    case 'file-watch':
      return t('automations.trigger.watchingPath', { path: trigger.path });
    case 'mcp-poll':
      return t('automations.trigger.watchingTool', {
        server: trigger.serverName,
        tool: trigger.toolName,
      });
    case 'url-watch': {
      try {
        return t('automations.trigger.watchingHost', { host: new URL(trigger.url).hostname });
      } catch {
        return t('automations.trigger.watchingUrl');
      }
    }
    case 'flow-event': {
      if (trigger.source?.topic) {
        return t('automations.trigger.onSignal', { topic: trigger.source.topic });
      }
      const outcomes = (trigger.on ?? []).map(outcome => (
        outcome === 'completed'
          ? t('automations.trigger.outcome.completed')
          : t('automations.trigger.outcome.error')
      )).join('/') || t('automations.trigger.terminal');
      return t('automations.trigger.flowOutcome', { outcomes });
    }
    default:
      return t('automations.trigger.generic');
  }
}

const two = (n: number) => String(n).padStart(2, '0');

/**
 * Render the cron patterns our preset builder generates back into plain
 * language. Anything else returns null (shown as the raw pattern).
 */
export function matchCronPreset(cron: string, t: Translator = english): string | null {
  let m = /^\*\/(\d+) \* \* \* \* \*$/.exec(cron);
  if (m) return t('automations.trigger.everySeconds', { count: m[1] });
  m = /^\*\/(\d+) \* \* \* \*$/.exec(cron);
  if (m) return t('automations.trigger.everyMinutes', { count: m[1] });
  m = /^0 \*\/(\d+) \* \* \*$/.exec(cron);
  if (m) return Number(m[1]) === 1
    ? t('automations.trigger.everyHour')
    : t('automations.trigger.everyHours', { count: m[1] });
  m = /^(\d+) (\d+) \* \* \*$/.exec(cron);
  if (m) return t('automations.trigger.dailyAt', {
    time: `${two(Number(m[2]))}:${two(Number(m[1]))}`,
  });
  m = /^(\d+) (\d+) \* \* 1-5$/.exec(cron);
  if (m) return t('automations.trigger.weekdaysAt', {
    time: `${two(Number(m[2]))}:${two(Number(m[1]))}`,
  });
  return null;
}
