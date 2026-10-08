import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';
import type { MCPStdioConfig } from '@/shared/types/mcp';
import { getDataDir } from '@/utils/paths';
import { getCurrentWorkspace, getWorkspaceDataDir } from '@/utils/workspace';
import { loadServerConfigs } from '@/backend/services/mcp/config';
import { resolveOwnerRequest } from './ownerAccess';
import { ownerPolicySchema } from './ownerCredentials';
import { readPrivateApprovalPairAsync } from './trustedHostMcp';
import { withPrivateApprovalLedgerLock } from './privateApprovalLedgerLock';
import { createOwnedPrivateApprovalStage } from './ownedPrivateApprovalStage';
import { capturePackageRunnerAuthorityFence } from './packageRunnerAuthorityFence';
import { packageRunnerIntentSubject, packageRunnerIntentLaunchParameters, revalidatePackageRunnerIntent,
  type PreparedPackageRunnerIntent } from './packageRunnerIntent';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const grant = z.object({ workspace: z.string().min(1).max(128), serverName: z.string().min(1).max(256),
  revision: z.string().min(1).max(256), digest, resolver: z.literal('modified-npm'), ownerAuthorityDigest: digest,
  expiresAt: z.number().int().positive() }).strict();
const ledgerSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('controlled-package-runner'),
  ownerId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
  grants: z.array(grant).max(128) }).strict();
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function ledgerPath() {
  const filename = process.env.FLUJO_MCP_PACKAGE_RUNNER_FILE;
  if (!filename || !path.isAbsolute(filename)) throw new Error('A separate protected runner grant file is required');
  const relative = path.relative(path.resolve(getDataDir()), path.resolve(filename));
  if (!relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
    throw new Error('Runner grant authority must be outside workspace data');
  }
  return filename;
}
async function actualConfig(serverName: string): Promise<MCPStdioConfig> {
  const configs = await loadServerConfigs();
  const config = Array.isArray(configs) && configs.find(candidate => candidate.name === serverName);
  if (!config || config.transport !== 'stdio' || config.disabled) throw new Error('Authoritative enabled runner configuration unavailable');
  return config;
}

/** Real owner bearer + protected CAS publication, in a distinct namespace.
 * The pre-existing ledger must be provisioned through the private operator
 * setup; this does not create an owner, fake a grant, relax trusted-host .cmd
 * policy, or integrate/spawn a launcher. Resolver mode is explicitly modified.
 */
export async function approvePackageRunnerIntent(request: Request, intent: PreparedPackageRunnerIntent,
  serverName: string, options: { reviewedDigest: string; expiresAt: number }) {
  const { reviewedDigest, expiresAt } = options;
  const ownerFile = process.env.FLUJO_OWNER_AUTH_FILE;
  if (!ownerFile) throw new Error('Actual runner owner authority unavailable');
  const configFile = path.join(getWorkspaceDataDir(), 'db', 'mcp_servers.json');
  const resolution = resolveOwnerRequest(request, ['control:admin', 'mcp:access', 'secrets:read'], { requireBearer: true });
  if (!resolution.ok) throw new Error('Actual runner owner authorization refused');
  const authorization = resolution.authorization;
  const filename = ledgerPath();
  const workspace = getCurrentWorkspace();
  if (reviewedDigest !== intent.digest || !Number.isSafeInteger(expiresAt)
      || expiresAt <= Date.now() || expiresAt > Date.now() + 30 * 24 * 60 * 60 * 1000) {
    throw new Error('Runner review/expiration differs from the owned intent');
  }
  const current = () => {
    if (request.signal.aborted || authorization.recheck() || workspace !== getCurrentWorkspace()
        || filename !== ledgerPath() || ownerFile !== process.env.FLUJO_OWNER_AUTH_FILE
        || configFile !== path.join(getWorkspaceDataDir(), 'db', 'mcp_servers.json')
        || expiresAt <= Date.now()) throw new Error('Runner owner/workspace/grant authority retired');
  };
  current();
  return withPrivateApprovalLedgerLock(filename, request.signal, async () => {
    current();
    const fence = await capturePackageRunnerAuthorityFence([ownerFile, filename, configFile], request.signal);
    const failures: unknown[] = [];
    let stage: Awaited<ReturnType<typeof createOwnedPrivateApprovalStage>> | undefined;
    let receipt: Readonly<ReturnType<typeof packageRunnerIntentSubject> & {
      ownerAuthorityDigest: string; expiresAt: number; ledgerRevision: number;
    }> | undefined;
    try {
    const config = await actualConfig(serverName);
    fence.assertCurrent();
    const subject = packageRunnerIntentSubject(intent, config);
    await revalidatePackageRunnerIntent(intent, config, subject.revision, request.signal);
    const [ownerValue, ledgerValue] = fence.values;
    const owner = ownerPolicySchema.parse(ownerValue);
    const previous = ledgerSchema.parse(ledgerValue);
    if (owner.ownerId !== authorization.principal.ownerId || previous.ownerId !== owner.ownerId) throw new Error('Runner private authority owner mismatch');
    const ownerAuthorityDigest = fingerprint(owner);
    const next = ledgerSchema.parse({ ...previous, revision: previous.revision + 1, grants: [
      ...previous.grants.filter(row => row.workspace !== workspace || row.serverName !== serverName),
      { ...subject, ownerAuthorityDigest, expiresAt },
    ] });
    stage = await createOwnedPrivateApprovalStage(filename, next, request.signal);
      await revalidatePackageRunnerIntent(intent, await actualConfig(serverName), subject.revision, request.signal);
      const [latestOwner, latestLedger] = await readPrivateApprovalPairAsync(ownerFile, filename, request.signal);
      if (fingerprint(ownerPolicySchema.parse(latestOwner)) !== ownerAuthorityDigest
          || JSON.stringify(ledgerSchema.parse(latestLedger)) !== JSON.stringify(previous)) throw new Error('Runner owner/private CAS revision changed');
      packageRunnerIntentSubject(intent, await actualConfig(serverName));
      current();
      await stage.publish(filename, () => {
        current();
        fence.assertCurrent();
        current();
      });
      receipt = Object.freeze({ ...subject, ownerAuthorityDigest, expiresAt, ledgerRevision: next.revision });
    } catch (error) { failures.push(error); }
    try { await stage?.dispose(); } catch (error) { failures.push(error); }
    try { await fence.dispose(); } catch (error) { failures.push(error); }
    if (failures.length) throw Object.assign(new AggregateError(failures, 'Runner publication/owned stage disposal failed'), {
      disposeAuthority: fence.dispose,
    });
    return receipt!;
  });
}

const ownedLaunches = new Set<ChildProcessWithoutNullStreams>();
const closedLaunches = new WeakSet<ChildProcessWithoutNullStreams>();
type LaunchBinding = { request: Request; intent: PreparedPackageRunnerIntent; serverName: string;
  workspace: string; filename: string; ownerFile: string; configFile: string; authority: string; principal: string };
const launchBindings = new WeakMap<ChildProcessWithoutNullStreams, LaunchBinding>();
export class PackageRunnerSpawnUncertain extends Error {
  constructor(cause: unknown, readonly child: ChildProcessWithoutNullStreams) {
    super('Controlled runner spawned but boundary/cleanup is uncertain; child ownership retained', { cause });
  }
}

/** Actual standalone child boundary, not yet an MCP SDK transport integration.
 * Grant writers serialize with the effect. Final synchronous native/held-file
 * reads rebind actual owner, CAS row and raw authoritative configuration after
 * asynchronous stage checks. No new Node-direct/native-interpreter exemption.
 */
async function withCurrentRunnerAuthority<T>(request: Request, intent: PreparedPackageRunnerIntent, serverName: string,
  signal: AbortSignal, effect: (config: MCPStdioConfig, binding: LaunchBinding) => T, previous?: LaunchBinding): Promise<T> {
  const resolution = resolveOwnerRequest(request, ['control:admin', 'mcp:access', 'secrets:read'], { requireBearer: true });
  if (!resolution.ok) throw new Error('Actual runner owner authorization refused');
  const authorization = resolution.authorization;
  const principal = fingerprint(authorization.principal);
  const filename = ledgerPath();
  const workspace = getCurrentWorkspace();
  const ownerFile = process.env.FLUJO_OWNER_AUTH_FILE;
  if (!ownerFile) throw new Error('Actual runner owner authority unavailable');
  const configFile = path.join(getWorkspaceDataDir(), 'db', 'mcp_servers.json');
  if (previous && (previous.workspace !== workspace || previous.filename !== filename
      || previous.ownerFile !== ownerFile || previous.configFile !== configFile
      || previous.principal !== principal)) throw new Error('Captured runner request/authority alias changed');
  return withPrivateApprovalLedgerLock(filename, signal, async () => {
    const fence = await capturePackageRunnerAuthorityFence([ownerFile, filename, configFile], signal);
    const failures: unknown[] = [];
    let result: T | undefined;
    try {
      const config = await actualConfig(serverName);
      const subject = packageRunnerIntentSubject(intent, config);
      fence.assertCurrent();
      const authority = fingerprint(fence.values);
      if (previous && previous.authority !== authority) throw new Error('Captured runner grant/configuration revision changed');
      const owner = ownerPolicySchema.parse(fence.values[0]);
      const ledger = ledgerSchema.parse(fence.values[1]);
      const row = ledger.grants.find(value => value.workspace === workspace && value.serverName === serverName);
      if (owner.ownerId !== authorization.principal.ownerId || ledger.ownerId !== owner.ownerId || !row || row.expiresAt <= Date.now()
          || row.digest !== subject.digest || row.revision !== subject.revision
          || row.ownerAuthorityDigest !== fingerprint(owner)) throw new Error('Current private runner grant does not authorize this owned intent');
      await revalidatePackageRunnerIntent(intent, config, subject.revision, signal);
      if (authorization.recheck()) throw new Error('Runner request owner authority retired');
      fence.assertCurrent();
      if (signal.aborted || request.signal.aborted || row.expiresAt <= Date.now()
          || authorization.principal.expiresAt <= Date.now()
          || workspace !== getCurrentWorkspace() || filename !== ledgerPath()
          || ownerFile !== process.env.FLUJO_OWNER_AUTH_FILE
          || configFile !== path.join(getWorkspaceDataDir(), 'db', 'mcp_servers.json')) throw new Error('Runner final native/request/private CAS fence retired');
      // Synchronous effect only: no new await may separate this fence from
      // spawn/write. Same-account mutation is still not OS-atomically excluded.
      result = effect(config, { request, intent, serverName, workspace, filename, ownerFile, configFile, authority, principal });
    } catch (error) { failures.push(error); }
    try { await fence.dispose(); } catch (error) { failures.push(error); }
    if (failures.length) throw Object.assign(new AggregateError(failures, 'Runner effect/held authority disposal failed'), {
      disposeAuthority: fence.dispose,
    });
    return result!;
  });
}

export async function spawnGrantedPackageRunner(request: Request, intent: PreparedPackageRunnerIntent, serverName: string,
  signal: AbortSignal, observeChild?: (child: ChildProcessWithoutNullStreams) => void): Promise<ChildProcessWithoutNullStreams> {
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    return await withCurrentRunnerAuthority(request, intent, serverName, signal, (config, binding) => {
      const launch = packageRunnerIntentLaunchParameters(intent, config);
      child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: { ...launch.env },
        windowsHide: true, windowsVerbatimArguments: true, stdio: ['pipe', 'pipe', 'pipe'] });
      ownedLaunches.add(child);
      launchBindings.set(child, binding);
      // Ownership survives spawn errors and writer-lock cleanup exceptions. The
      // caller receives the real child even when a post-spawn boundary fails.
      child.on('error', () => { /* Actual error remains observable by caller. */ });
      // Closed parent alone is not descendant or stdio-drain proof. The actual
      // transport owns terminal stream witnesses separately.
      child.once('close', () => { closedLaunches.add(child!); launchBindings.delete(child!); });
      observeChild?.(child);
      return child;
    });
  } catch (error) {
    if (child) throw new PackageRunnerSpawnUncertain(error, child);
    throw error;
  }
}

/** Dispatch only to an actual child with its original captured authority. */
export async function writeGrantedPackageRunner(child: ChildProcessWithoutNullStreams, bytes: string,
  signal: AbortSignal): Promise<void> {
  const binding = launchBindings.get(child);
  if (!binding || !ownedLaunches.has(child) || child.exitCode !== null || child.signalCode !== null
      || child.stdin.destroyed || Buffer.byteLength(bytes) > 256 * 1024) throw new Error('Owned runner dispatch unavailable');
  let completion: Promise<void> | undefined;
  await withCurrentRunnerAuthority(binding.request, binding.intent, binding.serverName, signal, () => {
    if (!launchBindings.has(child) || child.exitCode !== null || child.signalCode !== null || child.stdin.destroyed) {
      throw new Error('Owned runner exited before dispatch');
    }
    completion = new Promise<void>((resolve, reject) => {
      const aborted = () => { reject(new Error('Runner write completion aborted; prior write effect may have occurred')); };
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) {
        signal.removeEventListener('abort', aborted);
        aborted();
        return;
      }
      try {
        child.stdin.write(bytes, error => {
          signal.removeEventListener('abort', aborted);
          error ? reject(error) : resolve();
        });
      } catch (error) {
        signal.removeEventListener('abort', aborted);
        reject(error);
      }
    });
    // Observe errors immediately while held-file and writer-lock cleanup await.
    void completion.catch(() => {});
  }, binding);
  await completion;
}

/** Only actual terminal stream witnesses release process ownership. */
export function releaseDrainedPackageRunner(child: ChildProcessWithoutNullStreams): void {
  if (!ownedLaunches.has(child) || !closedLaunches.has(child) || !child.stdout.readableEnded || !child.stderr.readableEnded
      || (child.exitCode === null && child.signalCode === null)) throw new Error('Runner exit/drain remains unresolved');
  launchBindings.delete(child);
  ownedLaunches.delete(child);
}
