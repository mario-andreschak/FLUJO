import path from 'node:path';
import type { MCPStdioConfig } from '@/shared/types/mcp';
import { getCurrentWorkspace, getWorkspaceDataDir } from '@/utils/workspace';
import { loadServerConfigs, saveConfig } from '../mcp/config';
import { shippedDescriptorForConfig, shippedMcpAppRoot } from '../mcp/shippedServers';
import { inspectShippedWorkspaceProvenance } from '../mcp/shippedWorkspacePackages';
import { resolveOwnerRequest } from './ownerAccess';
import { ownerPolicySchema } from './ownerCredentials';
import { withPrivateApprovalLedgerLock } from './privateApprovalLedgerLock';
import { createOwnedPrivateApprovalStage } from './ownedPrivateApprovalStage';
import { fingerprintTrustedHostExecutable, fingerprintTrustedHostSource, readPrivateApprovalAsync,
  trustedHostApprovalsSchema, trustedHostEnvironment, trustedHostMcpPolicyDigestAsync,
  TRUSTED_HOST_RUNTIME_HOME_ENVIRONMENT_NAMES, sameTrustedHostConsent } from './trustedHostMcp';

export class BundledConsentError extends Error {
  constructor(readonly response: Response) { super('Bundled execution consent refused.'); }
}

export async function previewBundledHostConsent(serverName: string, options: { runtimeHome: 'host' | 'isolated' }) {
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
  if (process.platform === 'win32' && !Object.keys(environment).some(name => name.toUpperCase() === 'SYSTEMROOT')) {
    if (!process.env.SystemRoot) throw new Error('Required Windows runtime environment unavailable.');
    environment.SystemRoot = process.env.SystemRoot;
  }
  const environmentNames = [...Object.keys(environment),
    ...(options.runtimeHome === 'isolated' ? TRUSTED_HOST_RUNTIME_HOME_ENVIRONMENT_NAMES : []),
    ...(stored.enableMcpApps ? ['FLUJO_MCP_APP_RUNTIME_REGISTER_URL', 'FLUJO_MCP_APP_RUNTIME_REGISTER_TOKEN'] : []),
    ...(descriptor.packageDirectory === 'flujo' ? ['FLUJO_WORKER_MODE', 'FLUJO_SNAPSHOT_CONTROL_TOKEN'] : [])];
  const config: MCPStdioConfig = { ...stored, command: process.execPath, args: [entryPoint, ...originalArgs.slice(1)],
    cwd: revision.sourceRoot, rootPath: revision.sourceRoot, env: environment, runtimeHomeMode: options.runtimeHome,
    trustedHost: { schemaVersion: 1, kind: 'trusted-host', privileges: 'owner-account', runtime: 'node', runtimeHome: options.runtimeHome,
      entryPoint, sourceRoot: revision.sourceRoot, sourceDigest: fingerprintTrustedHostSource(revision.sourceRoot, revision.dependencyLinks),
      executableDigest: fingerprintTrustedHostExecutable(process.execPath), environmentNames: [...new Set(environmentNames)],
      bundledInstallation: { packageDirectory: descriptor.packageDirectory as 'flujo' | 'filesystem' | 'bash' | 'browser',
        installationRoot: revision.installation, assetDigest: revision.assetDigest, dependencyGraphDigest: revision.dependencyGraph.digest,
        dependencyDirectories: revision.dependencies.map(item => item.directory), dependencyLinks: revision.dependencyLinks } } };
  return { config, policyDigest: await trustedHostMcpPolicyDigestAsync(config), revision, storedConfig: structuredClone(stored) };
}

/** An actual private owner bearer approves a recomputed exact proposal, never an imported attestation. */
export async function approveBundledHostConsent(request: Request, serverName: string,
  options: { runtimeHome: 'host' | 'isolated'; reviewedDigest: string; expiresAt: number }) {
  const owner = resolveOwnerRequest(request, ['control:admin', 'mcp:access', 'secrets:read'], { requireBearer: true });
  if (!owner.ok) throw new BundledConsentError(owner.response);
  const filename = process.env.FLUJO_MCP_TRUSTED_HOST_FILE;
  if (!filename) throw new Error('A protected approval file is required.');
  return withPrivateApprovalLedgerLock(filename, request.signal, () => approveBundledHostConsentLocked(request, serverName, options));
}

async function approveBundledHostConsentLocked(request: Request, serverName: string,
  options: { runtimeHome: 'host' | 'isolated'; reviewedDigest: string; expiresAt: number }) {
  const resolution = resolveOwnerRequest(request, ['control:admin', 'mcp:access', 'secrets:read'], { requireBearer: true });
  if (!resolution.ok) throw new BundledConsentError(resolution.response);
  const authorization = resolution.authorization;
  const workspace = getCurrentWorkspace();
  if (!/^[a-f0-9]{64}$/.test(options.reviewedDigest) || !Number.isSafeInteger(options.expiresAt)
      || options.expiresAt <= Date.now() || options.expiresAt > Date.now() + 30 * 24 * 60 * 60 * 1000) throw new Error('Invalid consent request.');
  const proposal = await previewBundledHostConsent(serverName, options);
  if (proposal.policyDigest !== options.reviewedDigest) throw new Error('The reviewed proposal changed.');
  const filename = process.env.FLUJO_MCP_TRUSTED_HOST_FILE;
  if (!filename || !path.isAbsolute(filename)) throw new Error('A separately protected approval file is required.');
  const owner = ownerPolicySchema.parse(await readPrivateApprovalAsync(process.env.FLUJO_OWNER_AUTH_FILE, request.signal));
  const previous = trustedHostApprovalsSchema.parse(await readPrivateApprovalAsync(filename, request.signal));
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
    const owner = ownerPolicySchema.parse(await readPrivateApprovalAsync(process.env.FLUJO_OWNER_AUTH_FILE, request.signal));
    const previous = trustedHostApprovalsSchema.parse(await readPrivateApprovalAsync(filename, request.signal));
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
