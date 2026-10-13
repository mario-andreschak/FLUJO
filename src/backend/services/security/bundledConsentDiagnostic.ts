import { performance } from 'node:perf_hooks';

const stages = ['CONFIG', 'ASSETS', 'DEP_LAYOUT', 'DEP_GRAPH', 'DEP_LINKS',
  'SOURCE_FINGERPRINT', 'EXEC_FINGERPRINT', 'CONSENT_DIGEST', 'CONSENT_POLICY_SCHEMA',
  'CONSENT_LAUNCH', 'CONSENT_BUNDLE', 'CONSENT_ENVIRONMENT', 'CONSENT_CAPABILITIES',
  'CONSENT_SERIALIZE', 'CONSENT_SCRYPT', 'APPROVAL_INITIALIZE', 'APPROVAL_SEED_PARENT',
  'APPROVAL_SEED_OWNER', 'APPROVAL_SEED_IDENTITY', 'APPROVAL_SEED_AUTHORITY', 'APPROVAL_LOCK',
  'APPROVAL_REQUEST', 'APPROVAL_PROPOSAL', 'APPROVAL_AUTHORITY', 'APPROVAL_STAGE',
  'APPROVAL_RECHECK', 'APPROVAL_CONFIG', 'APPROVAL_SAVE', 'APPROVAL_PUBLICATION',
  'APPROVAL_DISPOSE'] as const;
export type ConsentDiagnosticStage = typeof stages[number];
type Stage = ConsentDiagnosticStage;

function traceStart(stage: Stage): number | undefined {
  try {
    if (process.env.FLUJO_BUNDLED_CONSENT_TRACE !== '1' || !stages.includes(stage)) return undefined;
    const started = performance.now();
    return Number.isFinite(started) ? started : undefined;
  } catch { return undefined; }
}

function traceElapsed(stage: Stage, started: number | undefined): void {
  if (started === undefined) return;
  // Diagnostic delivery must never replace an operation's result or refusal.
  try {
    const elapsedMs = performance.now() - started;
    if (!Number.isFinite(elapsedMs)) return;
    console.info(JSON.stringify({ bundledConsentStage: stage,
      elapsedMs: Math.max(0, elapsedMs) }));
  } catch { /* Preserve the original operation semantics if logging fails. */ }
}

/** Internal causes stay private; the only admitted diagnostic is a fixed code. */
export class BundledConsentDiagnostic extends Error {
  constructor(readonly stage: Stage, cause: unknown) {
    super('Bundled consent preview refused.', { cause });
  }
}

export async function consentDiagnosticStage<T>(stage: Stage, operation: () => T | Promise<T>): Promise<T> {
  const started = traceStart(stage);
  try { return await operation(); }
  catch (cause) {
    if (cause instanceof BundledConsentDiagnostic) throw cause;
    throw new BundledConsentDiagnostic(stage, cause);
  }
  finally { traceElapsed(stage, started); }
}

/** Preserve adjacent synchronous evidence captures without introducing a yield. */
export function consentDiagnosticStageSync<T>(stage: Stage, operation: () => T): T {
  const started = traceStart(stage);
  try { return operation(); }
  catch (cause) {
    if (cause instanceof BundledConsentDiagnostic) throw cause;
    throw new BundledConsentDiagnostic(stage, cause);
  }
  finally { traceElapsed(stage, started); }
}

export function consentDiagnosticCode(error: unknown): Stage {
  return error instanceof BundledConsentDiagnostic && stages.includes(error.stage) ? error.stage : 'CONFIG';
}
