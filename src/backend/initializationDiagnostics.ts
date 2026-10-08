import { AsyncLocalStorage } from 'node:async_hooks';

export type InitializationStep = 'layout' | 'snapshot-import' | 'snapshot-restore' | 'snapshot-unlock'
  | 'storage' | 'encryption' | 'secret-services' | 'runtime-snapshot-import' | 'runtime-package-import'
  | 'runtime-snapshot' | 'codex-auth' | 'mcp-reinstall' | 'mcp-start' | 'mcp-config' | 'mcp-status'
  | 'scheduler-import' | 'scheduler-start' | 'transfer-config' | 'transfer-existing'
  | 'bundled-authority' | 'bundled-digest' | 'bundled-config' | 'transfer-prepare'
  | 'bundled-provision' | 'transfer-save' | 'transfer-marker' | 'transfer-connect';
type Diagnostic = Readonly<{ step: InitializationStep; state: 'enter' | 'ready' | 'failed'; elapsedMs: number }>;
type Scope = { observer: (event: Diagnostic) => unknown; started: number; count: number };
const scopes = new AsyncLocalStorage<Scope>();

/** Scoped observation only. No readiness setter, timeout, substitute or gate. */
export function observeBackendInitialization<T>(observer: (event: Diagnostic) => unknown, run: () => Promise<T>): Promise<T> {
  return scopes.run({ observer, started: Date.now(), count: 0 }, run);
}
function emit(step: InitializationStep, state: Diagnostic['state']): void {
  try {
    const scope = scopes.getStore();
    if (!scope || scope.count >= 128) return;
    scope.count++;
    const result = scope.observer(Object.freeze({ step, state, elapsedMs: Date.now() - scope.started }));
    // Neither synchronous throws nor async diagnostic rejection may alter
    // actual initialization or create an unhandled rejection.
    if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
      void Promise.resolve(result).catch(() => {});
    }
  } catch { /* Diagnostic failure never replaces an application result. */ }
}
export function observeInitializationAwait<T>(step: InitializationStep, run: () => Promise<T>): Promise<T> {
  if (!scopes.getStore()) return run();
  emit(step, 'enter');
  return (async () => {
    try { const result = await run(); emit(step, 'ready'); return result; }
    catch (error) { emit(step, 'failed'); throw error; }
  })();
}
