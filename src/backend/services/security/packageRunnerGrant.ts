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
import { readPrivateApprovalPairAsync, readPrivateApprovalSetAsync, readPrivateApprovalSet } from './trustedHostMcp';
import { withPrivateApprovalLedgerLock } from './privateApprovalLedgerLock';
import { createOwnedPrivateApprovalStage } from './ownedPrivateApprovalStage';
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
  const resolution = resolveOwnerRequest(request, ['control:admin', 'mcp:access', 'secrets:read'], { requireBearer: true });
  if (!resolution.ok) throw new Error('Actual runner owner authorization refused');
  const authorization = resolution.authorization;
  const filename = ledgerPath();
  const workspace = getCurrentWorkspace();
  if (options.reviewedDigest !== intent.digest || !Number.isSafeInteger(options.expiresAt)
      || options.expiresAt <= Date.now() || options.expiresAt > Date.now() + 30 * 24 * 60 * 60 * 1000) {
    throw new Error('Runner review/expiration differs from the owned intent');
  }
  const current = () => {
    if (request.signal.aborted || authorization.recheck() || workspace !== getCurrentWorkspace()
        || filename !== ledgerPath()) throw new Error('Runner owner/workspace/grant authority retired');
  };
  current();
  return withPrivateApprovalLedgerLock(filename, request.signal, async () => {
    current();
    const config = await actualConfig(serverName);
    const subject = packageRunnerIntentSubject(intent, config);
    await revalidatePackageRunnerIntent(intent, config, subject.revision, request.signal);
    const [ownerValue, ledgerValue] = await readPrivateApprovalPairAsync(process.env.FLUJO_OWNER_AUTH_FILE, filename, request.signal);
    const owner = ownerPolicySchema.parse(ownerValue);
    const previous = ledgerSchema.parse(ledgerValue);
    if (owner.ownerId !== authorization.principal.ownerId || previous.ownerId !== owner.ownerId) throw new Error('Runner private authority owner mismatch');
    const ownerAuthorityDigest = fingerprint(owner);
    const next = ledgerSchema.parse({ ...previous, revision: previous.revision + 1, grants: [
      ...previous.grants.filter(row => row.workspace !== workspace || row.serverName !== serverName),
      { ...subject, ownerAuthorityDigest, expiresAt: options.expiresAt },
    ] });
    const stage = await createOwnedPrivateApprovalStage(filename, next, request.signal);
    const failures: unknown[] = [];
    try {
      await revalidatePackageRunnerIntent(intent, await actualConfig(serverName), subject.revision, request.signal);
      const [latestOwner, latestLedger] = await readPrivateApprovalPairAsync(process.env.FLUJO_OWNER_AUTH_FILE, filename, request.signal);
      if (fingerprint(ownerPolicySchema.parse(latestOwner)) !== ownerAuthorityDigest
          || JSON.stringify(ledgerSchema.parse(latestLedger)) !== JSON.stringify(previous)) throw new Error('Runner owner/private CAS revision changed');
      packageRunnerIntentSubject(intent, await actualConfig(serverName));
      current();
      await stage.publish(filename, current);
    } catch (error) { failures.push(error); }
    try { await stage.dispose(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Runner publication/owned stage disposal failed');
    return Object.freeze({ ...subject, ownerAuthorityDigest, expiresAt: options.expiresAt, ledgerRevision: next.revision });
  });
}

const ownedLaunches = new Set<ChildProcessWithoutNullStreams>();
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
export async function spawnGrantedPackageRunner(intent: PreparedPackageRunnerIntent, serverName: string,
  signal: AbortSignal): Promise<ChildProcessWithoutNullStreams> {
  const filename = ledgerPath();
  const workspace = getCurrentWorkspace();
  const ownerFile = process.env.FLUJO_OWNER_AUTH_FILE;
  if (!ownerFile) throw new Error('Actual runner owner authority unavailable');
  const configFile = path.join(getWorkspaceDataDir(), 'db', 'mcp_servers.json');
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    return await withPrivateApprovalLedgerLock(filename, signal, async () => {
      const initial = await readPrivateApprovalSetAsync([ownerFile, filename, configFile], signal);
      const config = await actualConfig(serverName);
      const subject = packageRunnerIntentSubject(intent, config);
      const second = await readPrivateApprovalSetAsync([ownerFile, filename, configFile], signal);
      if (JSON.stringify(initial) !== JSON.stringify(second)) throw new Error('Runner configuration/private authority changed during binding');
      const owner = ownerPolicySchema.parse(second[0]);
      const ledger = ledgerSchema.parse(second[1]);
      const row = ledger.grants.find(value => value.workspace === workspace && value.serverName === serverName);
      if (ledger.ownerId !== owner.ownerId || !row || row.expiresAt <= Date.now()
          || row.digest !== subject.digest || row.revision !== subject.revision
          || row.ownerAuthorityDigest !== fingerprint(owner)) throw new Error('Current private runner grant does not authorize this owned intent');
      await revalidatePackageRunnerIntent(intent, config, subject.revision, signal);
      const launch = packageRunnerIntentLaunchParameters(intent, config);
      const final = readPrivateApprovalSet([ownerFile, filename, configFile], signal);
      if (JSON.stringify(final) !== JSON.stringify(second) || signal.aborted || row.expiresAt <= Date.now()
          || workspace !== getCurrentWorkspace() || filename !== ledgerPath()
          || ownerFile !== process.env.FLUJO_OWNER_AUTH_FILE) throw new Error('Runner final native/request/private CAS fence retired');
      child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: { ...launch.env },
        windowsHide: true, windowsVerbatimArguments: true, stdio: ['pipe', 'pipe', 'pipe'] });
      ownedLaunches.add(child);
      // Ownership survives spawn errors and writer-lock cleanup exceptions. The
      // caller receives the real child even when a post-spawn boundary fails.
      child.on('error', () => { /* Actual error remains observable by caller. */ });
      child.once('close', () => { ownedLaunches.delete(child!); });
      return child;
    });
  } catch (error) {
    if (child) throw new PackageRunnerSpawnUncertain(error, child);
    throw error;
  }
}
