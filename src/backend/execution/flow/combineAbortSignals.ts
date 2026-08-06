/**
 * Combine several optional AbortSignals into one that aborts as soon as the
 * first of them does (issue #357: a tool call must die on EITHER the caller's
 * run-level signal or its own per-call cancel controller).
 *
 * Uses `AbortSignal.any` when available (Node >= 20) and falls back to a manual
 * listener bridge otherwise. Returns `undefined` when no signal was given, so
 * callers keep the "no signal at all" behaviour unchanged.
 */
export function combineAbortSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => Boolean(s));
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];

  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') return anyFn(present);

  const controller = new AbortController();
  const alreadyAborted = present.find(s => s.aborted);
  if (alreadyAborted) {
    controller.abort(alreadyAborted.reason);
    return controller.signal;
  }
  for (const signal of present) {
    signal.addEventListener(
      'abort',
      () => controller.abort(signal.reason),
      { once: true },
    );
  }
  return controller.signal;
}
