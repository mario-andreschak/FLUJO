const stages = ['CONFIG', 'ASSETS', 'DEP_LAYOUT', 'DEP_GRAPH', 'DEP_LINKS',
  'SOURCE_FINGERPRINT', 'EXEC_FINGERPRINT', 'CONSENT_DIGEST', 'CONSENT_POLICY_SCHEMA',
  'CONSENT_LAUNCH', 'CONSENT_BUNDLE', 'CONSENT_ENVIRONMENT', 'CONSENT_CAPABILITIES',
  'CONSENT_SERIALIZE', 'CONSENT_SCRYPT', 'APPROVAL_INITIALIZE', 'APPROVAL_LOCK',
  'APPROVAL_REQUEST', 'APPROVAL_PROPOSAL', 'APPROVAL_AUTHORITY', 'APPROVAL_STAGE',
  'APPROVAL_RECHECK', 'APPROVAL_CONFIG', 'APPROVAL_SAVE', 'APPROVAL_PUBLICATION',
  'APPROVAL_DISPOSE'] as const;
export type ConsentDiagnosticStage = typeof stages[number];
type Stage = ConsentDiagnosticStage;

/** Internal causes stay private; the only admitted diagnostic is a fixed code. */
export class BundledConsentDiagnostic extends Error {
  constructor(readonly stage: Stage, cause: unknown) {
    super('Bundled consent preview refused.', { cause });
  }
}

export async function consentDiagnosticStage<T>(stage: Stage, operation: () => T | Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (cause) {
    if (cause instanceof BundledConsentDiagnostic) throw cause;
    throw new BundledConsentDiagnostic(stage, cause);
  }
}

/** Preserve adjacent synchronous evidence captures without introducing a yield. */
export function consentDiagnosticStageSync<T>(stage: Stage, operation: () => T): T {
  try { return operation(); }
  catch (cause) {
    if (cause instanceof BundledConsentDiagnostic) throw cause;
    throw new BundledConsentDiagnostic(stage, cause);
  }
}

export function consentDiagnosticCode(error: unknown): Stage {
  return error instanceof BundledConsentDiagnostic && stages.includes(error.stage) ? error.stage : 'CONFIG';
}
