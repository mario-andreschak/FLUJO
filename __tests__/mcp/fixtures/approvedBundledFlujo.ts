import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MCPStdioConfig } from '@/shared/types/mcp';
import { getCurrentWorkspace, getWorkspaceDir } from '@/utils/workspace';
import { createShippedServerConfig, SHIPPED_MCP_SERVERS } from '@/backend/services/mcp/shippedServers';
import { ensureShippedWorkspacePackages } from '@/backend/services/mcp/shippedWorkspacePackages';
import { saveConfig } from '@/backend/services/mcp/config';
import { approveBundledHostConsent, previewBundledHostConsent } from '@/backend/services/security/bundledMcpConsent';
import { installBundledFixtureOwner } from './bundledFixtureOwner';

/**
 * Time one real consent takes on a busy Windows PC: every private read starts a
 * fresh Windows permission check, and preview plus approval make dozens of them.
 */
export const APPROVED_BUNDLED_FLUJO_SETUP_MS = 180_000;

export interface ApprovedBundledFlujo {
  fixture: string;
  application: string;
  proposed: MCPStdioConfig;
  approved: MCPStdioConfig;
  remove(): Promise<void>;
}

type Timed = <T>(stage: string, operation: () => Promise<T>) => Promise<T>;

/**
 * One genuinely provisioned and privately approved bundled FLUJO server for a
 * whole test file. The cases then each prepare their own fresh workload on it.
 * Each file used to repeat this real consent per case, which alone took a
 * quarter of every case's time limit.
 */
export async function installApprovedBundledFlujo(options: {
  prefix: string;
  env?: Record<string, string | undefined>;
  beforeProvision?: () => Promise<void>;
  timed?: Timed;
}): Promise<ApprovedBundledFlujo> {
  const timed: Timed = options.timed ?? ((_stage, operation) => operation());
  const names = ['FLUJO_APP_ROOT', 'FLUJO_DATA_DIR', 'FLUJO_PARENT_DATA_DIR', 'FLUJO_BASE_URL', 'FLUJO_WORKER_MODE',
    ...Object.keys(options.env ?? {})];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const parent = path.resolve(process.platform === 'win32' ? process.env.LOCALAPPDATA ?? os.tmpdir() : os.tmpdir());
  const fixture = fs.mkdtempSync(path.join(parent, options.prefix));
  const application = path.join(fixture, 'application');
  let owner: ReturnType<typeof installBundledFixtureOwner> | undefined;
  const remove = async () => {
    const errors: unknown[] = [];
    try { owner?.restore(); } catch (error) { errors.push(error); }
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    // Uncertain cleanup keeps the owned root as evidence.
    if (!errors.length) try {
      if (path.dirname(fixture) !== parent || !path.basename(fixture).startsWith(options.prefix)
          || fs.lstatSync(fixture).isSymbolicLink()) throw new Error('Unsafe bundled FLUJO fixture cleanup.');
      await fs.promises.rm(fixture, { recursive: true, force: true, maxRetries: 5 });
    } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Bundled FLUJO fixture cleanup failed.');
  };
  try {
    process.env.FLUJO_APP_ROOT = application;
    process.env.FLUJO_DATA_DIR = path.join(fixture, 'data');
    process.env.FLUJO_BASE_URL = 'http://127.0.0.1:4200';
    delete process.env.FLUJO_PARENT_DATA_DIR;
    delete process.env.FLUJO_WORKER_MODE;
    for (const [name, value] of Object.entries(options.env ?? {})) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    const descriptor = SHIPPED_MCP_SERVERS.find(item => item.packageDirectory === 'flujo')!;
    const write = (relative: string, content: string) => {
      const filename = path.join(application, relative);
      fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, content);
    };
    write('package.json', '{"name":"flujo-ai","version":"1.0.0"}');
    write('node_modules/fixture-dependency/package.json', '{"name":"fixture-dependency","version":"1.0.0","type":"module","exports":"./index.js"}');
    write('node_modules/fixture-dependency/index.js', 'export const value = 1;');
    write('mcp-servers/flujo/package.json', JSON.stringify({ name: descriptor.packageId, version: '1.0.0', type: 'module', dependencies: { 'fixture-dependency': '1.0.0' } }));
    write('mcp-servers/flujo/src/index.ts', '// genuine fixture source');
    write('mcp-servers/flujo/dist/index.js', 'export { value } from "fixture-dependency";');
    fs.mkdirSync(getWorkspaceDir(getCurrentWorkspace()), { recursive: true });
    await options.beforeProvision?.();
    await timed('package-copy', () => ensureShippedWorkspacePackages(getWorkspaceDir(getCurrentWorkspace()), application, ['flujo']));
    const proposed = createShippedServerConfig(descriptor);
    const persisted = await timed('persist-config', () => saveConfig(new Map([[proposed.name, proposed]])));
    if (!persisted.success) throw new Error('Bundled FLUJO fixture config was not saved.');
    // The approval must outlast every case in the file, not just one.
    const fixtureOwner = installBundledFixtureOwner({ lifetimeMs: 6 * 60 * 60 * 1000 });
    owner = fixtureOwner;
    const preview = await timed('preview', () => previewBundledHostConsent(proposed.name, { runtimeHome: 'host' }));
    const approved = await timed('approve', () => approveBundledHostConsent(fixtureOwner.request(proposed.name), proposed.name, {
      runtimeHome: 'host', reviewedDigest: preview.policyDigest, expiresAt: fixtureOwner.expiresAt,
    }));
    return { fixture, application, proposed, approved: approved.config, remove };
  } catch (error) {
    try { await remove(); } catch { /* Keep the setup error; the owned root stays inspectable. */ }
    throw error;
  }
}
