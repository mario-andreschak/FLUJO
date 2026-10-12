import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getCurrentWorkspace, getWorkspaceDir } from '@/utils/workspace';
import { createShippedServerConfig, SHIPPED_MCP_SERVERS } from '@/backend/services/mcp/shippedServers';
import { ensureShippedWorkspacePackages } from '@/backend/services/mcp/shippedWorkspacePackages';
import { loadServerConfigs, saveConfig } from '@/backend/services/mcp/config';
import { approveBundledHostConsent, previewBundledHostConsent } from '@/backend/services/security/bundledMcpConsent';
import { BundledConsentDiagnostic, consentDiagnosticCode } from '@/backend/services/security/bundledConsentDiagnostic';
import { verifyTrustedHostMcp } from '@/backend/services/security/trustedHostMcp';
import { installBundledFixtureOwner } from './fixtures/bundledFixtureOwner';

// Genuine owner, package provenance, private ledger and production writer.
// Only the actual final rename is equipment in the failure case.
test.each(['success', 'seed-success', 'publication-failure'] as const)('protected approval writer retains authority and finite diagnostics: %s', async mode => {
  const names = ['FLUJO_APP_ROOT', 'FLUJO_DATA_DIR', 'FLUJO_PARENT_DATA_DIR', 'FLUJO_WORKER_MODE'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const parent = path.resolve(process.platform === 'win32' ? process.env.LOCALAPPDATA ?? os.tmpdir() : os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'flujo-approval-control-'));
  const application = path.join(root, 'application');
  const write = (relative: string, content: string) => {
    const filename = path.join(application, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, content);
  };
  let owner: ReturnType<typeof installBundledFixtureOwner> | undefined;
  let rename: jest.SpyInstance | undefined;
  let failed = false;
  let primary: unknown;
  try {
    process.env.FLUJO_APP_ROOT = application;
    process.env.FLUJO_DATA_DIR = path.join(root, 'data');
    delete process.env.FLUJO_PARENT_DATA_DIR;
    delete process.env.FLUJO_WORKER_MODE;
    const descriptor = SHIPPED_MCP_SERVERS.find(item => item.packageDirectory === 'filesystem')!;
    write('package.json', '{"name":"flujo-ai","version":"1.0.0"}');
    write('node_modules/fixture-dependency/package.json', '{"name":"fixture-dependency","version":"1.0.0","type":"module","exports":"./index.js"}');
    write('node_modules/fixture-dependency/index.js', 'export const value = 1;');
    write('mcp-servers/filesystem/package.json', JSON.stringify({ name: descriptor.packageId, version: '1.0.0', type: 'module', dependencies: { 'fixture-dependency': '1.0.0' } }));
    write('mcp-servers/filesystem/src/index.ts', '// genuine fixture source');
    write('mcp-servers/filesystem/dist/index.js', 'export { value } from "fixture-dependency";');
    fs.mkdirSync(getWorkspaceDir(getCurrentWorkspace()), { recursive: true });
    await ensureShippedWorkspacePackages(getWorkspaceDir(getCurrentWorkspace()), application, ['filesystem']);
    const proposed = createShippedServerConfig(descriptor);
    expect((await saveConfig(new Map([[proposed.name, proposed]]))).success).toBe(true);
    const fixtureOwner = installBundledFixtureOwner();
    owner = fixtureOwner;
    const preview = await previewBundledHostConsent(proposed.name, { runtimeHome: 'host' });
    const ledger = process.env.FLUJO_MCP_TRUSTED_HOST_FILE!;
    const before = fs.readFileSync(ledger);
    const entries = fs.readdirSync(path.dirname(ledger)).sort();
    if (mode === 'seed-success') {
      expect(JSON.parse(before.toString()).approvals).toEqual([]);
      fs.unlinkSync(ledger);
      expect(fs.existsSync(ledger)).toBe(false);
    }
    const failure = new Error('private-native-rename-canary');
    let ledgerRenameAttempts = 0;
    if (mode === 'publication-failure') {
      const actualRename = fs.promises.rename.bind(fs.promises);
      rename = jest.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
        if (String(to) === ledger) { ledgerRenameAttempts += 1; throw failure; }
        return actualRename(from, to);
      });
    }
    let caught: unknown;
    try {
      const approved = await approveBundledHostConsent(fixtureOwner.request(proposed.name), proposed.name, {
        runtimeHome: 'host', reviewedDigest: preview.policyDigest, expiresAt: fixtureOwner.expiresAt,
      });
      expect(mode).not.toBe('publication-failure');
      expect((await verifyTrustedHostMcp(approved.config)).digest).toBe(preview.policyDigest);
    } catch (error) { caught = error; }
    if (mode !== 'publication-failure') {
      expect(caught).toBeUndefined();
      expect(JSON.parse(fs.readFileSync(ledger, 'utf8')).approvals).toHaveLength(1);
    } else {
      expect(caught).toBeInstanceOf(BundledConsentDiagnostic);
      expect(consentDiagnosticCode(caught)).toBe('APPROVAL_PUBLICATION');
      expect(ledgerRenameAttempts).toBe(1);
      expect((caught as Error).cause).toBe(failure);
      expect((caught as Error).message).not.toContain(failure.message);
      expect(fs.readFileSync(ledger)).toEqual(before);
      const configs = await loadServerConfigs();
      if (!Array.isArray(configs)) throw new Error('Authoritative fixture configuration unavailable.');
      const savedConfig = configs.find(item => item.name === proposed.name);
      if (!savedConfig || savedConfig.transport !== 'stdio') throw new Error('Authoritative stdio fixture configuration unavailable.');
      await expect(verifyTrustedHostMcp(savedConfig)).rejects.toThrow();
    }
    expect(fs.readdirSync(path.dirname(ledger)).sort()).toEqual(entries);
  } catch (error) { failed = true; primary = error; throw error; }
  finally {
    const cleanup: unknown[] = [];
    try { rename?.mockRestore(); } catch (error) { cleanup.push(error); }
    try { owner?.restore(); } catch (error) { cleanup.push(error); }
    for (const [name, value] of Object.entries(saved)) {
      try { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
      catch (error) { cleanup.push(error); }
    }
    if (!cleanup.length) {
      try {
        if (path.dirname(root) !== parent || !/^flujo-approval-control-[A-Za-z0-9]+$/.test(path.basename(root)) || fs.lstatSync(root).isSymbolicLink()) throw new Error('Unsafe approval fixture cleanup.');
        fs.rmSync(root, { recursive: true, force: true });
      } catch (error) { cleanup.push(error); }
    }
    if (cleanup.length) throw new AggregateError(failed ? [primary, ...cleanup] : cleanup, 'Approval fixture cleanup failed.');
  }
}, 60_000);
