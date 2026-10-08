import { BundledConsentDiagnostic, consentDiagnosticCode, consentDiagnosticStage } from '@/backend/services/security/bundledConsentDiagnostic';

test.each(['APPROVAL_INITIALIZE', 'APPROVAL_LOCK', 'APPROVAL_REQUEST', 'APPROVAL_PROPOSAL',
  'APPROVAL_AUTHORITY', 'APPROVAL_STAGE', 'APPROVAL_RECHECK', 'APPROVAL_CONFIG',
  'APPROVAL_SAVE', 'APPROVAL_PUBLICATION', 'APPROVAL_DISPOSE'] as const)
('approval diagnostic %s exposes only a fixed code and preserves the private cause', async stage => {
  const privateCause = new Error('private-token-and-private-path-fixture');
  let caught: unknown;
  try { await consentDiagnosticStage(stage, () => { throw privateCause; }); }
  catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(BundledConsentDiagnostic);
  expect(consentDiagnosticCode(caught)).toBe(stage);
  expect((caught as Error).cause).toBe(privateCause);
  expect((caught as Error).message).not.toContain(privateCause.message);
});

test('caller-shaped diagnostics never supply the public stage code', () => {
  expect(consentDiagnosticCode({ stage: 'APPROVAL_PUBLICATION', message: 'private' })).toBe('CONFIG');
});
