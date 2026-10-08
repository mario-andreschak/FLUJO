const stages = ['CONFIG', 'ASSETS', 'DEP_LAYOUT', 'DEP_GRAPH', 'DEP_LINKS',
  'SOURCE_FINGERPRINT', 'EXEC_FINGERPRINT', 'CONSENT_DIGEST'] as const;
type Stage = typeof stages[number];

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

export function consentDiagnosticCode(error: unknown): Stage {
  return error instanceof BundledConsentDiagnostic && stages.includes(error.stage) ? error.stage : 'CONFIG';
}
