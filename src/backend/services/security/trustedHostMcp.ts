import fs, { constants, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { MCPStdioConfig } from '@/shared/types/mcp';
import { getCurrentWorkspace, getWorkspaceDataDir, isValidWorkspaceName } from '@/utils/workspace';
import { getDataDir } from '@/utils/paths';
import { ownerPolicySchema } from './ownerCredentials';

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const absolutePath = z.string().min(1).max(2048).refine(value => path.isAbsolute(value) && !value.includes('\0'));
const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_MEMBERS = 16_384;
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;

/** A request for explicit host trust, never effective approval or an OS sandbox. */
export const trustedHostMcpPolicySchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('trusted-host'),
  privileges: z.literal('owner-account'),
  runtime: z.enum(['node', 'native']),
  entryPoint: absolutePath,
  sourceRoot: absolutePath,
  sourceDigest: digestSchema,
  executableDigest: digestSchema,
  environmentNames: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)
    .refine(name => !['NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONHOME', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH'].includes(name.toUpperCase()))).max(64),
}).strict().refine(value => new Set(value.environmentNames.map(name => process.platform === 'win32' ? name.toUpperCase() : name)).size === value.environmentNames.length);

const approvalsSchema = z.object({
  schemaVersion: z.literal(1),
  ownerId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  approvals: z.array(z.object({
    workspace: z.string().refine(isValidWorkspaceName),
    serverName: z.string().min(1).max(256).refine(value => !/[\x00-\x1f\x7f]/.test(value)),
    policyDigest: digestSchema,
    expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).strict()).max(128),
}).strict().refine(value => new Set(value.approvals.map(item => JSON.stringify([item.workspace, item.serverName]))).size === value.approvals.length);

export class TrustedHostMcpError extends Error {
  constructor(readonly code: 'HOST_CONSENT_REQUIRED' | 'HOST_SOURCE_CHANGED' | 'HOST_POLICY_INVALID') {
    super(code === 'HOST_CONSENT_REQUIRED'
      ? 'MCP host execution requires explicit owner consent for this workspace, server, package revision and capabilities. Configure an approved isolated profile or a separately protected trusted-host approval.'
      : code === 'HOST_SOURCE_CHANGED'
        ? 'MCP executable or package revision changed. Inspect the fixed package and renew owner consent before execution.'
        : 'MCP trusted-host policy is invalid. Use an absolute executable, working directory and fixed workspace package; dynamic package runners require an approved isolated profile.');
    this.name = 'TrustedHostMcpError';
  }
}

function canonical(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function assertLinkFree(filename: string): void {
  let current = path.resolve(filename);
  while (true) {
    if (fs.lstatSync(current).isSymbolicLink()) throw new TrustedHostMcpError('HOST_SOURCE_CHANGED');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (canonical(fs.realpathSync(filename)) !== canonical(filename)) throw new TrustedHostMcpError('HOST_SOURCE_CHANGED');
}

function sameIdentity(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs
    && before.mode === after.mode && before.uid === after.uid && before.gid === after.gid && before.nlink === after.nlink;
}

function readStableFile(filename: string, maximum: number, consume: (chunk: Buffer) => void): BigIntStats {
  assertLinkFree(filename);
  const before = fs.lstatSync(filename, { bigint: true });
  if (!before.isFile() || before.nlink !== BigInt(1) || before.size > BigInt(maximum)) throw new TrustedHostMcpError('HOST_SOURCE_CHANGED');
  const fd = fs.openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!sameIdentity(before, opened) || !opened.isFile()) throw new TrustedHostMcpError('HOST_SOURCE_CHANGED');
    const buffer = Buffer.alloc(64 * 1024);
    let length = 0;
    while (true) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      length += count;
      if (length > maximum || BigInt(length) > opened.size) throw new TrustedHostMcpError('HOST_SOURCE_CHANGED');
      consume(buffer.subarray(0, count));
    }
    assertLinkFree(filename);
    if (BigInt(length) !== opened.size || !sameIdentity(opened, fs.fstatSync(fd, { bigint: true }))
        || !sameIdentity(opened, fs.lstatSync(filename, { bigint: true }))) throw new TrustedHostMcpError('HOST_SOURCE_CHANGED');
    return opened;
  } finally { fs.closeSync(fd); }
}

export function fingerprintTrustedHostExecutable(filename: string): string {
  try {
    const hash = createHash('sha256');
    readStableFile(filename, MAX_EXECUTABLE_BYTES, chunk => hash.update(chunk));
    return hash.digest('hex');
  } catch { throw new TrustedHostMcpError('HOST_SOURCE_CHANGED'); }
}

/** Fingerprint every admitted package member; never run package or inspection code. */
export function fingerprintTrustedHostSource(sourceRoot: string): string {
  try {
    const root = path.resolve(sourceRoot);
    const packages = path.resolve(getWorkspaceDataDir(), 'mcp-servers');
    const relative = path.relative(packages, root);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error();
    const tree = createHash('sha256').update('flujo:mcp:trusted-host-source:v1\0');
    let members = 0;
    let bytes = 0;
    const visit = (directory: string): void => {
      if (++members > MAX_MEMBERS) throw new Error();
      assertLinkFree(directory);
      const before = fs.lstatSync(directory, { bigint: true });
      if (!before.isDirectory()) throw new Error();
      const names = fs.readdirSync(directory).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
      tree.update(JSON.stringify(['directory', path.relative(root, directory).split(path.sep).join('/'), String(before.mode)]));
      for (const name of names) {
        const filename = path.join(directory, name);
        const stat = fs.lstatSync(filename, { bigint: true });
        if (stat.isDirectory() && !stat.isSymbolicLink()) { visit(filename); continue; }
        if (++members > MAX_MEMBERS || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== BigInt(1)) throw new Error();
        const content = createHash('sha256');
        const admitted = readStableFile(filename, MAX_SOURCE_BYTES - bytes, chunk => content.update(chunk));
        bytes += Number(admitted.size);
        tree.update(JSON.stringify(['file', path.relative(root, filename).split(path.sep).join('/'), String(admitted.mode), content.digest('hex')]));
      }
      assertLinkFree(directory);
      if (!sameIdentity(before, fs.lstatSync(directory, { bigint: true }))) throw new Error();
    };
    visit(root);
    return tree.digest('hex');
  } catch { throw new TrustedHostMcpError('HOST_SOURCE_CHANGED'); }
}

function readPrivateApproval(filename: string | undefined): unknown {
  if (!filename || !path.isAbsolute(filename)) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
  const relative = path.relative(path.resolve(getDataDir()), path.resolve(filename));
  if (!relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
  if (process.platform !== 'win32' && typeof process.getuid === 'function') {
    const uid = BigInt(process.getuid());
    let directory = path.dirname(path.resolve(filename));
    while (true) {
      const stat = fs.lstatSync(directory, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== uid && stat.uid !== BigInt(0))
          || ((stat.mode & BigInt(0o022)) !== BigInt(0) && (stat.mode & BigInt(0o1000)) === BigInt(0))) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  const chunks: Buffer[] = [];
  const stat = readStableFile(filename, 64 * 1024, chunk => chunks.push(Buffer.from(chunk)));
  if (process.platform !== 'win32' && (stat.mode & BigInt(0o077)) !== BigInt(0)) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
  if (process.platform !== 'win32' && typeof process.getuid === 'function'
      && stat.uid !== BigInt(process.getuid()) && stat.uid !== BigInt(0)) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  finally { for (const chunk of chunks) chunk.fill(0); }
}

export function trustedHostMcpPolicyDigest(config: MCPStdioConfig): string {
  try {
    const policy = trustedHostMcpPolicySchema.parse(config.trustedHost);
    const command = absolutePath.parse(config.command);
    const cwd = absolutePath.parse(config.cwd);
    const args = z.array(z.string().max(2048).refine(value => !value.includes('\0'))).max(64).parse(config.args ?? []);
    if (config.isolation !== undefined || /\.(?:cmd|bat|ps1)$/i.test(command)) throw new Error();
    if (canonical(cwd) !== canonical(policy.sourceRoot)) throw new Error();
    const entry = path.relative(policy.sourceRoot, policy.entryPoint);
    if (!entry || entry === '..' || entry.startsWith(`..${path.sep}`) || path.isAbsolute(entry)) throw new Error();
    const executableName = path.basename(command).toLowerCase().replace(/\.exe$/, '');
    if (policy.runtime === 'node') {
      if (executableName !== 'node' || args[0] !== policy.entryPoint || !/\.(?:mjs|cjs|js)$/.test(policy.entryPoint)) throw new Error();
    } else if (canonical(command) !== canonical(policy.entryPoint)
        || ['node', 'npm', 'npx', 'pnpm', 'yarn', 'corepack', 'uv', 'uvx', 'pip', 'pip3', 'python', 'python3', 'bash', 'sh', 'cmd', 'powershell', 'pwsh', 'ruby', 'perl', 'deno', 'bun', 'go', 'cargo'].includes(executableName)) throw new Error();
    const requestedEnvironment = Object.entries(config.env ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, item]) => {
      if (!policy.environmentNames.includes(name)) throw new Error();
      const value = typeof item === 'string' ? item : item?.value;
      if (typeof value !== 'string' || Buffer.byteLength(value) > 16 * 1024 || value.includes('\0')) throw new Error();
      return [name, value];
    });
    const rootEntry = z.string().max(2048).refine(value => !value.includes('${global:') && !/[\x00-\x1f\x7f]/.test(value));
    const roots = z.array(rootEntry).max(64).parse(config.roots ?? []);
    const rootPath = rootEntry.parse(config.rootPath ?? '');
    return createHash('sha256').update(JSON.stringify({
      domain: 'flujo:mcp:trusted-host-consent:v1', command, args, cwd, requestedEnvironment,
      policy: { ...policy, environmentNames: [...policy.environmentNames].sort() },
      capabilities: { roots, sampling: config.sampling ?? null, elicitation: config.elicitation ?? null,
        apps: config.enableMcpApps === true, skills: config.enableMcpSkills === true, rootPath },
    })).digest('hex');
  } catch { throw new TrustedHostMcpError('HOST_POLICY_INVALID'); }
}

/** The config requests trust. Only a private owner-matched grant conveys it. */
export function assertTrustedHostMcpAllowed(config: MCPStdioConfig): z.infer<typeof trustedHostMcpPolicySchema> {
  if (config.trustedHost === undefined) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
  try {
    const policy = trustedHostMcpPolicySchema.parse(config.trustedHost);
    const digest = trustedHostMcpPolicyDigest(config);
    const approvals = approvalsSchema.parse(readPrivateApproval(process.env.FLUJO_MCP_TRUSTED_HOST_FILE));
    const owner = ownerPolicySchema.parse(readPrivateApproval(process.env.FLUJO_OWNER_AUTH_FILE));
    const grant = approvals.approvals.find(item => item.workspace === getCurrentWorkspace() && item.serverName === config.name);
    if (approvals.ownerId !== owner.ownerId || !grant || grant.expiresAt <= Date.now() || grant.policyDigest !== digest) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
    if (fingerprintTrustedHostExecutable(config.command) !== policy.executableDigest
        || fingerprintTrustedHostSource(policy.sourceRoot) !== policy.sourceDigest) throw new TrustedHostMcpError('HOST_SOURCE_CHANGED');
    // Fingerprinting can take time. An approval that expired meanwhile cannot
    // authorize a later effect, and changed owner/grant files must be reread.
    const currentApprovals = approvalsSchema.parse(readPrivateApproval(process.env.FLUJO_MCP_TRUSTED_HOST_FILE));
    const currentOwner = ownerPolicySchema.parse(readPrivateApproval(process.env.FLUJO_OWNER_AUTH_FILE));
    const currentGrant = currentApprovals.approvals.find(item => item.workspace === getCurrentWorkspace() && item.serverName === config.name);
    if (currentOwner.ownerId !== owner.ownerId || currentApprovals.ownerId !== owner.ownerId
        || !currentGrant || currentGrant.expiresAt <= Date.now() || currentGrant.policyDigest !== digest) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
    return policy;
  } catch (error) {
    if (error instanceof TrustedHostMcpError) throw error;
    throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
  }
}

export function trustedHostMcpApproval(config: MCPStdioConfig) {
  if (config.trustedHost === undefined) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
  try {
    const policy = trustedHostMcpPolicySchema.parse(config.trustedHost);
    const digest = trustedHostMcpPolicyDigest(config);
    const approvals = approvalsSchema.parse(readPrivateApproval(process.env.FLUJO_MCP_TRUSTED_HOST_FILE));
    const owner = ownerPolicySchema.parse(readPrivateApproval(process.env.FLUJO_OWNER_AUTH_FILE));
    const grant = approvals.approvals.find(item => item.workspace === getCurrentWorkspace() && item.serverName === config.name);
    if (owner.ownerId !== approvals.ownerId || !grant || grant.expiresAt <= Date.now() || grant.policyDigest !== digest) throw new Error();
    return { policy, digest, ownerId: owner.ownerId, workspace: getCurrentWorkspace(), expiresAt: grant.expiresAt };
  } catch (error) {
    if (error instanceof TrustedHostMcpError) throw error;
    throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
  }
}

async function assertLinkFreeAsync(filename: string): Promise<void> {
  let current = path.resolve(filename);
  while (true) {
    if ((await fs.promises.lstat(current)).isSymbolicLink()) throw new Error();
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (canonical(await fs.promises.realpath(filename)) !== canonical(filename)) throw new Error();
}

async function hashStableFileAsync(filename: string, maximum: number, signal?: AbortSignal): Promise<{ digest: string; size: number }> {
  if (signal?.aborted) throw new Error();
  await assertLinkFreeAsync(filename);
  const before = await fs.promises.lstat(filename, { bigint: true });
  if (!before.isFile() || before.nlink !== BigInt(1) || before.size > BigInt(maximum)) throw new Error();
  const handle = await fs.promises.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameIdentity(before, opened) || !opened.isFile()) throw new Error();
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let length = 0;
    while (true) {
      if (signal?.aborted) throw new Error();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      length += bytesRead;
      if (length > maximum || BigInt(length) > opened.size) throw new Error();
      hash.update(buffer.subarray(0, bytesRead));
    }
    await assertLinkFreeAsync(filename);
    if (BigInt(length) !== opened.size || !sameIdentity(opened, await handle.stat({ bigint: true }))
        || !sameIdentity(opened, await fs.promises.lstat(filename, { bigint: true }))) throw new Error();
    return { digest: hash.digest('hex'), size: length };
  } finally { await handle.close(); }
}

async function fingerprintSourceAsync(sourceRoot: string, signal?: AbortSignal): Promise<string> {
  const root = path.resolve(sourceRoot);
  const relative = path.relative(path.resolve(getWorkspaceDataDir(), 'mcp-servers'), root);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error();
  const tree = createHash('sha256').update('flujo:mcp:trusted-host-source:v1\0');
  let members = 0;
  let bytes = 0;
  const visit = async (directory: string): Promise<void> => {
    if (signal?.aborted) throw new Error();
    if (++members > MAX_MEMBERS) throw new Error();
    await assertLinkFreeAsync(directory);
    const before = await fs.promises.lstat(directory, { bigint: true });
    if (!before.isDirectory()) throw new Error();
    tree.update(JSON.stringify(['directory', path.relative(root, directory).split(path.sep).join('/'), String(before.mode)]));
    const names = (await fs.promises.readdir(directory)).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    for (const name of names) {
      const filename = path.join(directory, name);
      const stat = await fs.promises.lstat(filename, { bigint: true });
      if (stat.isDirectory() && !stat.isSymbolicLink()) { await visit(filename); continue; }
      if (++members > MAX_MEMBERS || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== BigInt(1)) throw new Error();
      const admitted = await hashStableFileAsync(filename, MAX_SOURCE_BYTES - bytes, signal);
      bytes += admitted.size;
      tree.update(JSON.stringify(['file', path.relative(root, filename).split(path.sep).join('/'), String(stat.mode), admitted.digest]));
    }
    await assertLinkFreeAsync(directory);
    if (!sameIdentity(before, await fs.promises.lstat(directory, { bigint: true }))) throw new Error();
  };
  await visit(root);
  return tree.digest('hex');
}

/** Production checks yield during source verification and reread authority afterward. */
export async function verifyTrustedHostMcp(config: MCPStdioConfig, signal?: AbortSignal) {
  const captured = structuredClone(config);
  const before = trustedHostMcpApproval(captured);
  try {
    const executable = await hashStableFileAsync(captured.command, MAX_EXECUTABLE_BYTES, signal);
    const source = await fingerprintSourceAsync(before.policy.sourceRoot, signal);
    if (executable.digest !== before.policy.executableDigest || source !== before.policy.sourceDigest) throw new Error();
  } catch { throw new TrustedHostMcpError('HOST_SOURCE_CHANGED'); }
  if (signal?.aborted) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
  const after = trustedHostMcpApproval(captured);
  if (after.ownerId !== before.ownerId || after.digest !== before.digest || after.workspace !== before.workspace) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
  return after;
}
