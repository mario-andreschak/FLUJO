import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bundledCodexExecutable } from '@/backend/services/model/adapters/codexRestrictedProfile';
import { qualifyCodexUpdate, newerCodexVersion, codexUpdateEnvironment } from '@/backend/services/model/adapters/codexRuntimeUpdate';

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
