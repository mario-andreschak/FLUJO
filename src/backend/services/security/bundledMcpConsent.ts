import path from 'node:path';
import fs, { constants } from 'node:fs';
import type { MCPStdioConfig } from '@/shared/types/mcp';
import { getCurrentWorkspace, getWorkspaceDataDir } from '@/utils/workspace';
import { getDataDir } from '@/utils/paths';
import { loadServerConfigs, saveConfig } from '../mcp/config';
import { shippedDescriptorForConfig, shippedMcpAppRoot, resolvePlaywrightBrowsersPath } from '../mcp/shippedServers';
import { inspectShippedWorkspaceProvenance } from '../mcp/shippedWorkspacePackages';
import { resolveOwnerRequest, type OwnerRequestAuthorization } from './ownerAccess';
import { ownerPolicySchema } from './ownerCredentials';
import { consentDiagnosticStage, consentDiagnosticStageSync } from './bundledConsentDiagnostic';
import { withPrivateApprovalLedgerLock } from './privateApprovalLedgerLock';
import { createOwnedPrivateApprovalStage } from './ownedPrivateApprovalStage';
import { fingerprintTrustedHostExecutable, fingerprintTrustedHostSource, readPrivateApprovalAsync, readPrivateApprovalPairAsync,
  trustedHostApprovalsSchema, trustedHostEnvironment, trustedHostMcpPreviewDigestAsync,
  TRUSTED_HOST_RUNTIME_HOME_ENVIRONMENT_NAMES, sameTrustedHostConsent } from './trustedHostMcp';

export class BundledConsentError extends Error {
  constructor(readonly response: Response) { super('Bundled execution consent refused.'); }
}

const HOST_BINDINGS = ['PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
  'TMP', 'TEMP', 'TMPDIR', 'SHELL', 'COMSPEC', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'PROGRAMFILES', 'GH_CONFIG_DIR'];

/** An explicit authenticated operator may initialize an empty grant namespace. */
async function initializePrivateLedger(filename: string, request: Request, authorization: OwnerRequestAuthorization) {
  if (!path.isAbsolute(filename)) throw new Error('A protected absolute approval path is required.');
  try { await fs.promises.lstat(filename); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const resolved = path.resolve(filename), parent = path.dirname(resolved);
  const dataRoots = [path.resolve(getDataDir())];
  try { dataRoots.push(await fs.promises.realpath(dataRoots[0])); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (dataRoots.some(root => { const relative = path.relative(root, resolved); return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); })) throw new Error('Approval authority must be outside workspace data.');
  const canonical = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  if (canonical(await fs.promises.realpath(parent)) !== canonical(parent)) throw new Error('Approval parent must be canonical.');
  const owner = ownerPolicySchema.parse(await readPrivateApprovalAsync(process.env.FLUJO_OWNER_AUTH_FILE, request.signal));
  const revoked = authorization.recheck(); if (revoked) throw new BundledConsentError(revoked);
  if (owner.ownerId !== authorization.principal.ownerId || request.signal.aborted || filename !== process.env.FLUJO_MCP_TRUSTED_HOST_FILE) throw new Error('Approval authority changed.');
  let handle: fs.promises.FileHandle;
  try { handle = await fs.promises.open(resolved, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0), 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return; throw error; }
  const content = Buffer.from(JSON.stringify({ schemaVersion: 1, ownerId: owner.ownerId, approvals: [] }));
  let initialized = false, failure: unknown, written: fs.BigIntStats | undefined;
  const stable = (value: fs.BigIntStats) => {
    const expected = written;
    return expected !== undefined && value.isFile() && !value.isSymbolicLink() && value.nlink === BigInt(1)
      && ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'gid', 'nlink'].every(field => value[field as keyof fs.BigIntStats] === expected[field as keyof fs.BigIntStats]);
  };
  const assertExactSeed = async () => {
    const bytes = Buffer.alloc(content.length + 1);
    try {
      if (!stable(await handle.stat({ bigint: true })) || !stable(await fs.promises.lstat(resolved, { bigint: true }))) throw new Error('Created approval seed identity changed.');
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== content.length || !bytes.subarray(0, bytesRead).equals(content)) throw new Error('Created approval seed bytes changed.');
      if (!stable(await handle.stat({ bigint: true })) || !stable(await fs.promises.lstat(resolved, { bigint: true }))) throw new Error('Created approval seed identity changed.');
    } finally { bytes.fill(0); }
  };
  try {
    await handle.writeFile(content); await handle.sync();
    written = await handle.stat({ bigint: true });
    await assertExactSeed();
    const observed = trustedHostApprovalsSchema.parse(await readPrivateApprovalAsync(resolved, request.signal));
    const current = await handle.stat({ bigint: true }), named = await fs.promises.lstat(resolved, { bigint: true });
    if (!stable(current) || !stable(named) || observed.ownerId !== owner.ownerId || observed.approvals.length) throw new Error('Created approval ledger changed.');
    await assertExactSeed();
    const finalOwner = authorization.recheck(); if (finalOwner) throw new BundledConsentError(finalOwner);
    if (request.signal.aborted || filename !== process.env.FLUJO_MCP_TRUSTED_HOST_FILE) throw new Error('Approval initialization retired.');
    initialized = true;
  } catch (error) { failure = error; throw error; }
  finally {
    const cleanupErrors: unknown[] = [];
    try {
      if (!initialized) {
        const held = await handle.stat({ bigint: true });
        const named = await fs.promises.lstat(resolved, { bigint: true }).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
        if (named && stable(held) && stable(named)) {
          const bytes = Buffer.alloc(content.length + 1);
          try {
            const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
            if (bytesRead === content.length && bytes.subarray(0, bytesRead).equals(content)
                && stable(await handle.stat({ bigint: true })) && stable(await fs.promises.lstat(resolved, { bigint: true }))) await fs.promises.unlink(resolved);
          } finally { bytes.fill(0); }
        }
      }
    } catch (error) { cleanupErrors.push(error); }
    content.fill(0);
    try { await handle.close(); } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length) throw new AggregateError(failure === undefined ? cleanupErrors : [failure, ...cleanupErrors], 'Approval initialization cleanup failed.', { cause: failure ?? cleanupErrors[0] });
  }
}

export async function previewBundledHostConsent(serverName: string, options: { runtimeHome: 'host' | 'isolated' }) {
  return consentDiagnosticStage('CONFIG', async () => {
  if (!['host', 'isolated'].includes(options.runtimeHome)) throw new Error('Invalid runtime home selection.');
  const current = await loadServerConfigs();
  if (!Array.isArray(current)) throw new Error('Authoritative MCP configuration unavailable.');
  const stored = current.find(item => item.name === serverName);
  if (!stored || stored.transport !== 'stdio' || stored.disabled || stored.isolation !== undefined
      || stored._buildCommand || stored._installCommand) throw new Error('This server has no fixed bundled runtime proposal.');
  const descriptor = shippedDescriptorForConfig(stored);
  if (!descriptor) throw new Error('Unknown installed package.');
  const revision = await inspectShippedWorkspaceProvenance(getWorkspaceDataDir(), descriptor.packageDirectory, shippedMcpAppRoot());
  const entryPoint = path.join(revision.sourceRoot, 'dist', 'index.js');
  const originalArgs = stored.args ?? [];
  if (!['node', process.execPath].includes(stored.command) || originalArgs.length < 1
      || path.resolve(revision.sourceRoot, originalArgs[0]) !== entryPoint) throw new Error('The stored command differs from the fixed installed entry.');
  const environment = Object.fromEntries(trustedHostEnvironment(stored));
  // Normalize durable workspace outputs before they enter the reviewed digest.
  // The fixed trusted launch must not mutate an already-approved environment.
  if (descriptor.packageDirectory === 'browser') {
    if (!environment.PLAYWRIGHT_BROWSERS_PATH?.trim()) {
      const browsersPath = resolvePlaywrightBrowsersPath(process.env);
      if (browsersPath) environment.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
    }
    const root = getWorkspaceDataDir();
    const ownedPaths = ['FLUJO_BROWSER_PROFILE_DIR', 'FLUJO_BROWSER_SCREENSHOT_DIR', 'FLUJO_BROWSER_RECORD_DIR'];
    for (const name of Object.keys(environment)) if (ownedPaths.includes(name.toUpperCase())) delete environment[name];
    environment.FLUJO_BROWSER_PROFILE_DIR = path.join(root, 'browser-profile', 'trusted');
    environment.FLUJO_BROWSER_SCREENSHOT_DIR = path.join(root, 'screenshots', 'browser');
    environment.FLUJO_BROWSER_RECORD_DIR = path.join(root, 'recordings', 'browser');
  }
  if (Object.keys(environment).some(name => ['FLUJO_SNAPSHOT_CONTROL_TOKEN', 'PERSONA_GOAL_ENDURANCE_FIXTURE_TOKEN', 'FLUJO_WORKER_MODE'].includes(name.toUpperCase()))) throw new Error('Persisted runtime credentials are forbidden.');
  if (descriptor.packageDirectory === 'bash' && options.runtimeHome === 'host') {
    for (const key of HOST_BINDINGS) {
      for (const name of Object.keys(environment)) if (name.toUpperCase() === key) delete environment[name];
      const actual = Object.entries(process.env).find(([name]) => name.toUpperCase() === key);
      if (actual?.[1] !== undefined) environment[actual[0]] = actual[1];
    }
  }
  for (const name of Object.keys(environment)) if (['FLUJO_DATA_DIR', 'FLUJO_PARENT_DATA_DIR', 'FLUJO_WORKSPACE'].includes(name.toUpperCase())) delete environment[name];
  environment.FLUJO_DATA_DIR = getWorkspaceDataDir(); environment.FLUJO_PARENT_DATA_DIR = getDataDir(); environment.FLUJO_WORKSPACE = getCurrentWorkspace();
  if (process.platform === 'win32') {
    for (const key of ['SYSTEMROOT', 'COMSPEC']) for (const name of Object.keys(environment)) if (name.toUpperCase() === key) delete environment[name];
    if (!process.env.SystemRoot) throw new Error('Required Windows runtime environment unavailable.');
    environment.SystemRoot = process.env.SystemRoot;
    if (process.env.ComSpec) environment.ComSpec = process.env.ComSpec;
  }
  const environmentNames = [...Object.keys(environment),
    ...(options.runtimeHome === 'isolated' ? TRUSTED_HOST_RUNTIME_HOME_ENVIRONMENT_NAMES : []),
    ...(stored.enableMcpApps ? ['FLUJO_MCP_APP_RUNTIME_REGISTER_URL', 'FLUJO_MCP_APP_RUNTIME_REGISTER_TOKEN'] : []),
    ...(descriptor.packageDirectory === 'flujo' ? ['FLUJO_WORKER_MODE', 'FLUJO_SNAPSHOT_CONTROL_TOKEN'] : [])];
  const config: MCPStdioConfig = { ...stored, command: process.execPath, args: [entryPoint, ...originalArgs.slice(1)],
    cwd: revision.sourceRoot, rootPath: revision.sourceRoot, env: environment, runtimeHomeMode: options.runtimeHome,
    trustedHost: { schemaVersion: 1, kind: 'trusted-host', privileges: 'owner-account', runtime: 'node', runtimeHome: options.runtimeHome,
      entryPoint, sourceRoot: revision.sourceRoot, sourceDigest: consentDiagnosticStageSync('SOURCE_FINGERPRINT', () => fingerprintTrustedHostSource(revision.sourceRoot, revision.dependencyLinks)),
      executableDigest: consentDiagnosticStageSync('EXEC_FINGERPRINT', () => fingerprintTrustedHostExecutable(process.execPath)), environmentNames: [...new Set(environmentNames)],
      bundledInstallation: { packageDirectory: descriptor.packageDirectory as 'flujo' | 'filesystem' | 'bash' | 'browser',
        installationRoot: revision.installation, dependencyNamespaceRoot: revision.dependencyNamespaceRoot,
        assetDigest: revision.assetDigest, dependencyGraphDigest: revision.dependencyGraph.digest,
        dependencyDirectories: revision.dependencies.map(item => item.directory), dependencyLinks: revision.dependencyLinks } } };
  return { config, policyDigest: await consentDiagnosticStage('CONSENT_DIGEST', () => trustedHostMcpPreviewDigestAsync(config)), revision, storedConfig: structuredClone(stored) };
  });
}

/** An actual private owner bearer approves a recomputed exact proposal, never an imported attestation. */
export async function approveBundledHostConsent(request: Request, serverName: string,
  options: { runtimeHome: 'host' | 'isolated'; reviewedDigest: string; expiresAt: number }) {
  const owner = resolveOwnerRequest(request, ['control:admin', 'mcp:access', 'secrets:read'], { requireBearer: true });
  if (!owner.ok) throw new BundledConsentError(owner.response);
  const filename = process.env.FLUJO_MCP_TRUSTED_HOST_FILE;
  if (!filename) throw new Error('A protected approval file is required.');
  await initializePrivateLedger(filename, request, owner.authorization);
  return withPrivateApprovalLedgerLock(filename, request.signal, () => {
    const revoked = owner.authorization.recheck(); if (revoked) throw new BundledConsentError(revoked);
    if (filename !== process.env.FLUJO_MCP_TRUSTED_HOST_FILE) throw new Error('Captured approval ledger changed.');
    return approveBundledHostConsentLocked(request, serverName, options, filename);
  });
}

async function approveBundledHostConsentLocked(request: Request, serverName: string,
  options: { runtimeHome: 'host' | 'isolated'; reviewedDigest: string; expiresAt: number }, filename: string) {
  const resolution = resolveOwnerRequest(request, ['control:admin', 'mcp:access', 'secrets:read'], { requireBearer: true });
  if (!resolution.ok) throw new BundledConsentError(resolution.response);
  const authorization = resolution.authorization;
  const workspace = getCurrentWorkspace();
  if (!/^[a-f0-9]{64}$/.test(options.reviewedDigest) || !Number.isSafeInteger(options.expiresAt)
      || options.expiresAt <= Date.now() || options.expiresAt > Date.now() + 30 * 24 * 60 * 60 * 1000) throw new Error('Invalid consent request.');
  const proposal = await previewBundledHostConsent(serverName, options);
  if (proposal.policyDigest !== options.reviewedDigest) throw new Error('The reviewed proposal changed.');
  if (!path.isAbsolute(filename) || filename !== process.env.FLUJO_MCP_TRUSTED_HOST_FILE) throw new Error('A separately protected approval file is required.');
  const [ownerValue, approvalValue] = await readPrivateApprovalPairAsync(process.env.FLUJO_OWNER_AUTH_FILE, filename, request.signal);
  const owner = ownerPolicySchema.parse(ownerValue);
  const previous = trustedHostApprovalsSchema.parse(approvalValue);
  if (previous.ownerId !== owner.ownerId || owner.ownerId !== authorization.principal.ownerId) throw new Error('Approval authority changed.');
  const next = trustedHostApprovalsSchema.parse({ ...previous, approvals: [
    ...previous.approvals.filter(item => item.workspace !== workspace || item.serverName !== serverName),
    { workspace, serverName, policyDigest: proposal.policyDigest, expiresAt: options.expiresAt },
  ] });
  const stage = await createOwnedPrivateApprovalStage(filename, next, request.signal);
  try {
    const revoked = authorization.recheck(); if (revoked) throw new BundledConsentError(revoked);
    if (request.signal.aborted || workspace !== getCurrentWorkspace()) throw new Error('Consent request retired.');
    const finalProposal = await previewBundledHostConsent(serverName, options);
    if (!sameTrustedHostConsent(finalProposal.config, proposal.config) || finalProposal.policyDigest !== proposal.policyDigest) throw new Error('The installed revision changed.');
    const latest = trustedHostApprovalsSchema.parse(await readPrivateApprovalAsync(filename, request.signal));
    if (JSON.stringify(latest) !== JSON.stringify(previous)) throw new Error('Approval ledger changed concurrently.');
    const configs = await loadServerConfigs();
    if (!Array.isArray(configs)) throw new Error('Authoritative MCP configuration unavailable.');
    if (JSON.stringify(configs.find(item => item.name === serverName)) !== JSON.stringify(proposal.storedConfig)) throw new Error('Stored configuration changed before approval.');
    const beforeSave = authorization.recheck(); if (beforeSave) throw new BundledConsentError(beforeSave);
    const result = await saveConfig(new Map(configs.map(item => [item.name, item.name === serverName ? proposal.config : item])));
    if (!result.success) throw new Error('Approved configuration could not be saved.');
    const beforePublication = trustedHostApprovalsSchema.parse(await readPrivateApprovalAsync(filename, request.signal));
    if (JSON.stringify(beforePublication) !== JSON.stringify(previous)) throw new Error('Approval ledger changed before publication.');
    const beforePublish = authorization.recheck(); if (beforePublish) throw new BundledConsentError(beforePublish);
    if (request.signal.aborted || workspace !== getCurrentWorkspace()) throw new Error('Consent request retired.');
    await stage.publish(filename, () => {
      const finalOwner = authorization.recheck(); if (finalOwner) throw new BundledConsentError(finalOwner);
      if (workspace !== getCurrentWorkspace() || filename !== process.env.FLUJO_MCP_TRUSTED_HOST_FILE) throw new Error('Approval authority changed.');
    });
    return proposal;
  } finally { await stage.dispose(); }
}

export async function revokeBundledHostConsent(request: Request, serverName: string) {
  const resolution = resolveOwnerRequest(request, ['control:admin', 'mcp:access', 'secrets:read'], { requireBearer: true });
  if (!resolution.ok) throw new BundledConsentError(resolution.response);
  const filename = process.env.FLUJO_MCP_TRUSTED_HOST_FILE;
  if (!filename) throw new Error('A protected approval file is required.');
  const workspace = getCurrentWorkspace();
  return withPrivateApprovalLedgerLock(filename, request.signal, async () => {
    const [ownerValue, approvalValue] = await readPrivateApprovalPairAsync(process.env.FLUJO_OWNER_AUTH_FILE, filename, request.signal);
    const owner = ownerPolicySchema.parse(ownerValue);
    const previous = trustedHostApprovalsSchema.parse(approvalValue);
    if (owner.ownerId !== resolution.authorization.principal.ownerId || previous.ownerId !== owner.ownerId) throw new Error('Approval authority changed.');
    const next = { ...previous, approvals: previous.approvals.filter(item => item.workspace !== workspace || item.serverName !== serverName) };
    const stage = await createOwnedPrivateApprovalStage(filename, next, request.signal);
    try {
      const current = trustedHostApprovalsSchema.parse(await readPrivateApprovalAsync(filename, request.signal));
      if (JSON.stringify(current) !== JSON.stringify(previous)) throw new Error('Approval ledger changed.');
      const revoked = resolution.authorization.recheck(); if (revoked) throw new BundledConsentError(revoked);
      if (request.signal.aborted || workspace !== getCurrentWorkspace() || filename !== process.env.FLUJO_MCP_TRUSTED_HOST_FILE) throw new Error('Revocation retired.');
      await stage.publish(filename, () => {
        const finalOwner = resolution.authorization.recheck(); if (finalOwner) throw new BundledConsentError(finalOwner);
        if (workspace !== getCurrentWorkspace() || filename !== process.env.FLUJO_MCP_TRUSTED_HOST_FILE) throw new Error('Approval authority changed.');
      });
      return { revoked: true, serverName, workspace };
    } finally { await stage.dispose(); }
  });
}
