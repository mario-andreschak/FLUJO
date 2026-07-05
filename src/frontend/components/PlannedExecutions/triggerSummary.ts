import { TriggerConfig } from '@/shared/types/plannedExecution';

/** Short human-readable description of a trigger, for card chips. */
export function describeTrigger(trigger: TriggerConfig): string {
  switch (trigger.type) {
    case 'schedule': {
      const preset = matchCronPreset(trigger.cron);
      return preset ?? `Schedule: ${trigger.cron}`;
    }
    case 'webhook':
      return 'Webhook';
    case 'file-watch':
      return `Watching ${trigger.path}`;
    case 'mcp-poll':
      return `Watching ${trigger.serverName} › ${trigger.toolName}`;
    case 'url-watch': {
      try {
        return `Watching ${new URL(trigger.url).hostname}`;
      } catch {
        return 'Watching a URL';
      }
    }
    default:
      return 'Trigger';
  }
}

const two = (n: number) => String(n).padStart(2, '0');

/**
 * Render the cron patterns our preset builder generates back into plain
 * language. Anything else returns null (shown as the raw pattern).
 */
export function matchCronPreset(cron: string): string | null {
  let m = /^\*\/(\d+) \* \* \* \* \*$/.exec(cron);
  if (m) return `Every ${m[1]}s`;
  m = /^\*\/(\d+) \* \* \* \*$/.exec(cron);
  if (m) return `Every ${m[1]} min`;
  m = /^0 \*\/(\d+) \* \* \*$/.exec(cron);
  if (m) return Number(m[1]) === 1 ? 'Every hour' : `Every ${m[1]} hours`;
  m = /^(\d+) (\d+) \* \* \*$/.exec(cron);
  if (m) return `Daily at ${two(Number(m[2]))}:${two(Number(m[1]))}`;
  m = /^(\d+) (\d+) \* \* 1-5$/.exec(cron);
  if (m) return `Weekdays at ${two(Number(m[2]))}:${two(Number(m[1]))}`;
  return null;
}
