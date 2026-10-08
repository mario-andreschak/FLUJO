export interface RecallObservation { expectedId: string; recalledIds: string[]; }

export function scoreRecallPrecision(observations: RecallObservation[]): number {
  const returned = observations.reduce((total, item) => total + item.recalledIds.length, 0);
  if (returned === 0) return observations.length === 0 ? 1 : 0;
  const relevant = observations.reduce(
    (total, item) => total + item.recalledIds.filter((id) => id === item.expectedId).length,
    0,
  );
  return relevant / returned;
}
