import { BundledConsentDiagnostic, consentDiagnosticCode, consentDiagnosticStage, consentDiagnosticStageSync } from '@/backend/services/security/bundledConsentDiagnostic';

const savedTrace = process.env.FLUJO_BUNDLED_CONSENT_TRACE;
afterEach(() => {
  if (savedTrace === undefined) delete process.env.FLUJO_BUNDLED_CONSENT_TRACE;
  else process.env.FLUJO_BUNDLED_CONSENT_TRACE = savedTrace;
  jest.restoreAllMocks();
});

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

test('timing is disabled by default and never emits an operation result', async () => {
  delete process.env.FLUJO_BUNDLED_CONSENT_TRACE;
  const log = jest.spyOn(console, 'info').mockImplementation(() => undefined);
  const result = { privateValue: 'private-result-canary' };
  expect(await consentDiagnosticStage('APPROVAL_SAVE', () => result)).toBe(result);
  expect(log).not.toHaveBeenCalled();
});

test.each(['sync', 'async'] as const)('enabled %s timing emits only the finite stage and elapsed duration', async mode => {
  process.env.FLUJO_BUNDLED_CONSENT_TRACE = '1';
  const log = jest.spyOn(console, 'info').mockImplementation(() => undefined);
  const cause = new Error('private-cause-canary');
  const operation = () => { throw cause; };
  let caught: unknown;
  try {
    if (mode === 'sync') consentDiagnosticStageSync('APPROVAL_SAVE', operation);
    else await consentDiagnosticStage('APPROVAL_SAVE', operation);
  } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(BundledConsentDiagnostic);
  expect((caught as Error).cause).toBe(cause);
  expect(log).toHaveBeenCalledTimes(1);
  const logged = JSON.parse(log.mock.calls[0][0]);
  expect(Object.keys(logged).sort()).toEqual(['bundledConsentStage', 'elapsedMs']);
  expect(logged.bundledConsentStage).toBe('APPROVAL_SAVE');
  expect(Number.isFinite(logged.elapsedMs)).toBe(true);
  expect(logged.elapsedMs).toBeGreaterThanOrEqual(0);
  expect(log.mock.calls[0][0]).not.toContain(cause.message);
});

test('failed timing delivery preserves the original result and refusal', async () => {
  process.env.FLUJO_BUNDLED_CONSENT_TRACE = '1';
  jest.spyOn(console, 'info').mockImplementation(() => { throw new Error('diagnostic delivery failed'); });
  const result = {};
  expect(consentDiagnosticStageSync('APPROVAL_SAVE', () => result)).toBe(result);
  const original = new BundledConsentDiagnostic('APPROVAL_REQUEST', new Error('private-cause-canary'));
  await expect(consentDiagnosticStage('APPROVAL_SAVE', () => { throw original; })).rejects.toBe(original);
});
