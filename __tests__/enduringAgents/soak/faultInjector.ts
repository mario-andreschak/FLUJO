export type SoakFaultKind =
  | 'lease-expiry'
  | 'graceful-restart'
  | 'hard-crash'
  | 'administrative-recovery'
  | 'concurrent-claimant';

export interface ScheduledSoakFault { day: number; kind: SoakFaultKind; }

export function defaultFaultSchedule(days: number): ScheduledSoakFault[] {
  const kinds: SoakFaultKind[] = [
    'lease-expiry',
    'concurrent-claimant',
    'graceful-restart',
    'hard-crash',
    'administrative-recovery',
  ];
  return kinds
    .map((kind, index) => ({ day: Math.min(days, 2 + index * 5), kind }))
    .filter((fault, index, all) => all.findIndex((item) => item.day === fault.day && item.kind === fault.kind) === index);
}
