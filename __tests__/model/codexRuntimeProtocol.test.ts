import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bundledCodexExecutable } from '@/backend/services/model/adapters/codexRestrictedProfile';
import { qualifyCodexUpdate, newerCodexVersion, codexUpdateEnvironment } from '@/backend/services/model/adapters/codexRuntimeUpdate';
import { assertSupportedCodexServer, codexServerVersion, CodexRuntimeVersionError, describeCodexTurnError, MIN_ORDINARY_CODEX_CLI } from '@/backend/services/model/adapters/codexProtocol';

it('qualifies the installed native CLI through real stdio with an empty isolated home and no inference', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-codex-protocol-'));
  try { await qualifyCodexUpdate(bundledCodexExecutable(), home); }
  finally {
    const target = path.resolve(home), parent = path.resolve(os.tmpdir());
    if (path.dirname(target) !== parent || !path.basename(target).startsWith('flujo-codex-protocol-')) throw new Error('Unsafe test cleanup');
    await fs.rm(target, { recursive: true, force: true });
  }
}, 60000);

it('orders stable versions numerically and refuses downgrade, prerelease and malformed candidates', () => {
  expect(newerCodexVersion('0.162.1', '0.99.9')).toBe(true);
  for (const candidate of ['0.161.9', '0.162.1', '0.163.0-beta', '../../escape', '9999.0.0']) {
    expect(newerCodexVersion(candidate, '0.162.1')).toBe(false);
  }
});

it('reads the version the app-server names, refusing only versions known to be too old', () => {
  expect(codexServerVersion({ userAgent: 'flujo_conversation/0.166.0 (Windows 10.0.19045; x86_64) unknown (flujo_conversation; 1)' })).toBe('0.166.0');
  expect(codexServerVersion({ userAgent: 'codex_cli_rs/0.174.0-alpha.5 (Mac OS 15.1; arm64) iTerm' })).toBe('0.174.0');
  for (const unknown of [undefined, {}, { userAgent: 7 }, { userAgent: 'no version here' }, { userAgent: 'x/1.2 (y)' }, { userAgent: 'x/'.padEnd(2000, '9') }]) {
    expect(codexServerVersion(unknown)).toBeUndefined();
    expect(assertSupportedCodexServer(unknown)).toBeUndefined();
  }
  expect(assertSupportedCodexServer({ userAgent: `a/${MIN_ORDINARY_CODEX_CLI} (x)` })).toBe(MIN_ORDINARY_CODEX_CLI);
  expect(assertSupportedCodexServer({ userAgent: 'a/1.0.0 (x)' })).toBe('1.0.0');
  expect(() => assertSupportedCodexServer({ userAgent: 'a/0.162.0 (x)' })).toThrow(CodexRuntimeVersionError);
  expect(() => assertSupportedCodexServer({ userAgent: 'a/0.99.200 (x)' })).toThrow('Nothing was sent to Codex');
});

it('turns Codex error kinds into plain, bounded messages that keep Codex\'s own reason', () => {
  expect(describeCodexTurnError({ message: 'Try again at 7 PM.', codexErrorInfo: 'usageLimitExceeded' }))
    .toBe('Your ChatGPT plan has used up its Codex allowance for now. Codex says: "Try again at 7 PM." FLUJO did not send the input again.');
  expect(describeCodexTurnError({ message: 'stream closed', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } } }))
    .toMatch(/^Codex lost its connection to the model service\. Try again\. Codex says: "stream closed"/);
  expect(describeCodexTurnError({ codexErrorInfo: 'modelNotFound' })).toBe('This model is not available to your Codex account. Pick another model under AI Setup. FLUJO did not send the input again.');
  expect(describeCodexTurnError({ message: 'new kind', codexErrorInfo: 'somethingNew' })).toMatch(/^Codex reported an error\. Codex says: "new kind"/);
  expect(describeCodexTurnError(null)).toBe('Codex reported an error. FLUJO did not send the input again.');
  const long = describeCodexTurnError({ message: `line one\n\n${'x'.repeat(5000)}`, codexErrorInfo: 'other' });
  expect(long.length).toBeLessThan(700);
  expect(long).not.toContain('\n');
});

it('never inherits npm/provider credentials or personal Codex configuration into update probes', () => {
  const names = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'NPM_CONFIG_USERCONFIG', 'NODE_OPTIONS', 'CODEX_HOME'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    names.forEach(name => { process.env[name] = 'private-test-value'; });
    const env = codexUpdateEnvironment('/isolated-update');
    expect(env.CODEX_HOME).toBe('/isolated-update');
    for (const name of names.filter(name => name !== 'CODEX_HOME')) expect(env[name]).toBeUndefined();
  } finally {
    names.forEach(name => { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; });
  }
});
