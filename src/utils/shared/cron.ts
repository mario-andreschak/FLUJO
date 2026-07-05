/**
 * Convert a legacy poll interval (ms) into an equivalent croner pattern.
 * Used to migrate mcp-poll triggers that were saved before they switched to
 * cron scheduling (backend derives at arm time; the editor derives when
 * opening a legacy config). Croner's 6-field form carries the seconds.
 */
export function intervalMsToCron(intervalMs?: number): string {
  const seconds = Math.max(5, Math.round((intervalMs ?? 60_000) / 1000));
  if (seconds < 60) {
    return `*/${seconds} * * * * *`;
  }
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) {
    return `*/${minutes} * * * *`;
  }
  const hours = Math.max(1, Math.min(23, Math.round(minutes / 60)));
  return `0 */${hours} * * *`;
}
