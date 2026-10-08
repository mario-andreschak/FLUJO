/**
 * Process-local, low-cardinality semantic recall diagnostics.
 * Query text, memory content, IDs, and vectors are deliberately never recorded.
 */

export type SemanticRecallStage =
  | 'item_load'
  | 'query_embedding'
  | 'sidecar_load'
  | 'cosine_scoring'
  | 'filter_rank';

const counters = new Map<string, number>();
const elapsedMilliseconds = new Map<SemanticRecallStage, number>();

export function recordSemanticRecallFallback(reason: string): void {
  const key = `fallback:${reason}`;
  counters.set(key, (counters.get(key) ?? 0) + 1);
}

export function recordSemanticRecallStage(
  stage: SemanticRecallStage,
  milliseconds: number,
): void {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
  counters.set(`stage:${stage}`, (counters.get(`stage:${stage}`) ?? 0) + 1);
  elapsedMilliseconds.set(
    stage,
    (elapsedMilliseconds.get(stage) ?? 0) + milliseconds,
  );
}

export function recordSemanticRecallCandidates(before: number, after: number): void {
  if (!Number.isFinite(before) || !Number.isFinite(after)) return;
  counters.set('candidates:before', (counters.get('candidates:before') ?? 0) + before);
  counters.set('candidates:after', (counters.get('candidates:after') ?? 0) + after);
}

export function getSemanticRecallMetricsSnapshot(): {
  readonly counters: Readonly<Record<string, number>>;
  readonly elapsedMilliseconds: Readonly<Record<string, number>>;
} {
  return {
    counters: Object.fromEntries(counters),
    elapsedMilliseconds: Object.fromEntries(elapsedMilliseconds),
  };
}

export function resetSemanticRecallMetrics(): void {
  counters.clear();
  elapsedMilliseconds.clear();
}
