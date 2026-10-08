import fs, { constants, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { createHash, scrypt, scryptSync } from 'node:crypto';
import { z } from 'zod';
import type { MCPStdioConfig } from '@/shared/types/mcp';
import { getCurrentWorkspace, getWorkspaceDataDir, isValidWorkspaceName } from '@/utils/workspace';
import { getDataDir } from '@/utils/paths';
import { ownerPolicySchema } from './ownerCredentials';
import { windowsPrivateAuthorityStamp, windowsPrivateAuthorityStampAsync } from './windowsPrivateAuthority';
import { BundledConsentDiagnostic, type ConsentDiagnosticStage } from './bundledConsentDiagnostic';

/** Admit only own data properties; configuration accessors never run during consent. */
export function trustedHostEnvironment(config: MCPStdioConfig): Map<string, string> {
  const environment = new Map<string, string>();
  const descriptors = Object.getOwnPropertyDescriptors(config.env ?? {});
  for (const [name, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable) continue;
    if (!('value' in descriptor)) throw new TrustedHostMcpError('HOST_POLICY_INVALID');
    const raw: unknown = descriptor.value;
    const field = raw && typeof raw === 'object' ? Object.getOwnPropertyDescriptor(raw, 'value') : undefined;
    const value: unknown = typeof raw === 'string' ? raw : field && 'value' in field ? field.value : undefined;
    if (typeof value !== 'string' || Buffer.byteLength(value) > 16 * 1024 || value.includes('\0')) throw new TrustedHostMcpError('HOST_POLICY_INVALID');
    environment.set(name, value);
  }
  return environment;
}

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const absolutePath = z.string().min(1).max(2048).refine(value => path.isAbsolute(value) && !value.includes('\0'));
const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_MEMBERS = 16_384;
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;

export const TRUSTED_HOST_RUNTIME_HOME_ENVIRONMENT_NAMES = [
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
  'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR', 'TMP', 'TEMP',
  'NPM_CONFIG_CACHE', 'PIP_CACHE_DIR', 'UV_CACHE_DIR',
  'FLUJO_PARENT_DATA_DIR', 'FLUJO_DATA_DIR', 'FLUJO_WORKSPACE',
  ...(process.platform === 'win32' ? ['HOMEDRIVE', 'HOMEPATH'] : []),
] as const;

/** A request for explicit host trust, never effective approval or an OS sandbox. */
export const trustedHostMcpPolicySchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('trusted-host'),
  privileges: z.literal('owner-account'),
  runtime: z.enum(['node', 'native']),
  runtimeHome: z.enum(['host', 'isolated']).optional(),
  entryPoint: absolutePath,
  sourceRoot: absolutePath,
  sourceDigest: digestSchema,
  executableDigest: digestSchema,
  bundledInstallation: z.object({
    packageDirectory: z.enum(['flujo', 'filesystem', 'bash', 'browser']),
    installationRoot: absolutePath,
    dependencyNamespaceRoot: absolutePath,
    assetDigest: digestSchema,
    dependencyGraphDigest: digestSchema,
    dependencyDirectories: z.array(absolutePath).max(256),
    dependencyLinks: z.array(z.object({ link: absolutePath, target: absolutePath }).strict()).max(64),
    workload: z.object({ purpose: z.literal('bundled-flujo-control-v1'), inventory: z.array(z.object({
      action: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/), method: z.enum(['GET', 'POST']),
      path: z.enum(['/api/mcp/flujo/tools', '/api/mcp/flujo/resources', '/api/mcp/flujo/resources/read',
        '/api/mcp/flujo/skills', '/api/mcp/flujo/authoring', '/api/mcp/flujo/flows', '/api/mcp/flujo/servers',
        '/api/mcp/flujo/automation', '/api/mcp/flujo/state']), schemaDigest: digestSchema,
    }).strict()).min(1).max(70).refine(items => new Set(items.map(item => item.action)).size === items.length) }).strict().optional(),
  }).strict().optional(),
  environmentNames: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)
    .refine(name => !['NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONHOME', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH'].includes(name.toUpperCase()))).max(64),
}).strict().refine(value => new Set(value.environmentNames.map(name => process.platform === 'win32' ? name.toUpperCase() : name)).size === value.environmentNames.length)
  .refine(value => !value.bundledInstallation?.workload || value.bundledInstallation.packageDirectory === 'flujo');

export const trustedHostApprovalsSchema = z.object({
  schemaVersion: z.literal(1),
  ownerId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  approvals: z.array(z.object({
    workspace: z.string().refine(isValidWorkspaceName),
    serverName: z.string().min(1).max(256).refine(value => !/[\x00-\x1f\x7f]/.test(value)),
    policyDigest: digestSchema,
    expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).strict()).max(128),
}).strict().refine(value => new Set(value.approvals.map(item => JSON.stringify([item.workspace, item.serverName]))).size === value.approvals.length);
const approvalsSchema = trustedHostApprovalsSchema;

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
  const fd = fs.openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.nlink !== BigInt(1) || opened.size > BigInt(maximum)) throw new TrustedHostMcpError('HOST_SOURCE_CHANGED');
    assertLinkFree(filename);
    if (!sameIdentity(opened, fs.lstatSync(filename, { bigint: true }))) throw new TrustedHostMcpError('HOST_SOURCE_CHANGED');
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
export function fingerprintTrustedHostSource(sourceRoot: string, dependencyLinks: readonly { link: string; target: string }[] = []): string {
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
        if (stat.isSymbolicLink()) {
          const admitted = dependencyLinks.find(item => canonical(item.link) === canonical(filename));
          if (!admitted || canonical(fs.realpathSync(filename)) !== canonical(admitted.target)) throw new Error();
          tree.update(JSON.stringify(['approved-dependency-link', path.relative(root, filename).split(path.sep).join('/'), canonical(admitted.target)]));
          continue;
        }
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

/** Shared local execution authority reader; callers translate profile-specific errors. */
export function readPrivateApproval(filename: string | undefined): unknown {
  const before = process.platform === 'win32' && filename ? windowsPrivateAuthorityStamp(filename) : undefined;
  const identity = filename ? fs.lstatSync(filename, { bigint: true }) : undefined;
  const value = readPrivateApprovalContents(filename);
  if (before !== undefined && windowsPrivateAuthorityStamp(filename!) !== before) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
  if (identity && filename) { assertLinkFree(filename); if (!sameIdentity(identity, fs.lstatSync(filename, { bigint: true }))) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED'); }
  return value;
}

export async function readPrivateApprovalAsync(filename: string | undefined, signal?: AbortSignal): Promise<unknown> {
  return (await readPrivateApprovalEvidenceAsync(filename, signal)).value;
}

/** Fresh private evidence for two related files, never a cross-request cache. */
export async function readPrivateApprovalPairAsync(first: string | undefined, second: string | undefined, signal?: AbortSignal): Promise<[unknown, unknown]> {
  if (!first || !second || signal?.aborted) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
  const filenames = [first, second];
  const identities = filenames.map(filename => fs.lstatSync(filename, { bigint: true }));
  const before = process.platform === 'win32' ? await windowsPrivateAuthorityStampAsync(filenames, signal) : undefined;
  const values = filenames.map(filename => readPrivateApprovalContents(filename));
  if (before !== undefined && await windowsPrivateAuthorityStampAsync(filenames, signal) !== before) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
  for (const [index, filename] of filenames.entries()) {
    assertLinkFree(filename);
    if (!sameIdentity(identities[index], fs.lstatSync(filename, { bigint: true }))) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
  }
  if (signal?.aborted) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
  return [values[0], values[1]];
}

/** One bounded fresh native witness set; never stored or reused by a request. */
export async function readPrivateApprovalSetAsync(input: readonly string[], signal?: AbortSignal): Promise<unknown[]> {
  if (!input.length || input.length > 4 || new Set(input).size !== input.length
      || input.some(filename => typeof filename !== 'string' || !path.isAbsolute(filename) || filename.length > 2048 || filename.includes('\0'))
      || signal?.aborted) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
  const filenames = [...input];
  const identities = filenames.map(filename => fs.lstatSync(filename, { bigint: true }));
  const before = process.platform === 'win32' ? await windowsPrivateAuthorityStampAsync(filenames, signal) : undefined;
  const values = filenames.map(filename => readPrivateApprovalContents(filename));
  if (before !== undefined && await windowsPrivateAuthorityStampAsync(filenames, signal) !== before) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
  for (const [index, filename] of filenames.entries()) {
    assertLinkFree(filename);
    if (!sameIdentity(identities[index], fs.lstatSync(filename, { bigint: true }))) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
  }
  if (signal?.aborted) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
  return values;
}

/** Final synchronous witness set after every yielding verification phase. */
export function readPrivateApprovalSet(input: readonly string[], signal?: AbortSignal): unknown[] {
  if (!input.length || input.length > 4 || new Set(input).size !== input.length
      || input.some(filename => typeof filename !== 'string' || !path.isAbsolute(filename) || filename.length > 2048 || filename.includes('\0'))
      || signal?.aborted) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
  const filenames = [...input];
  const identities = filenames.map(filename => fs.lstatSync(filename, { bigint: true }));
  const before = process.platform === 'win32' ? windowsPrivateAuthorityStamp(filenames) : undefined;
  const values = filenames.map(filename => readPrivateApprovalContents(filename));
  if (before !== undefined && windowsPrivateAuthorityStamp(filenames) !== before) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
  for (const [index, filename] of filenames.entries()) {
    assertLinkFree(filename);
    if (!sameIdentity(identities[index], fs.lstatSync(filename, { bigint: true }))) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
  }
  if (signal?.aborted) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
  return values;
}

async function readPrivateApprovalEvidenceAsync(filename: string | undefined, signal?: AbortSignal) {
  if (signal?.aborted) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
  const before = process.platform === 'win32' && filename ? await windowsPrivateAuthorityStampAsync(filename, signal) : undefined;
  const identity = filename ? fs.lstatSync(filename, { bigint: true }) : undefined;
  const value = readPrivateApprovalContents(filename);
  if (before !== undefined && await windowsPrivateAuthorityStampAsync(filename!, signal) !== before) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
  if (identity && filename) { assertLinkFree(filename); if (!sameIdentity(identity, fs.lstatSync(filename, { bigint: true }))) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED'); }
  if (signal?.aborted) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
  return { value, windowsAuthority: before };
}

function readPrivateApprovalContents(filename: string | undefined): unknown {
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
  try {
    const stat = readStableFile(filename, 64 * 1024, chunk => chunks.push(Buffer.from(chunk)));
    if (process.platform !== 'win32' && (stat.mode & BigInt(0o077)) !== BigInt(0)) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
    if (process.platform !== 'win32' && typeof process.getuid === 'function'
        && stat.uid !== BigInt(process.getuid()) && stat.uid !== BigInt(0)) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  }
  finally { for (const chunk of chunks) chunk.fill(0); }
}

function consentInput(config: MCPStdioConfig, diagnostic = false): { consent: string; salt: string } {
  let stage: ConsentDiagnosticStage = 'CONSENT_POLICY_SCHEMA';
  try {
    const policy = trustedHostMcpPolicySchema.parse(config.trustedHost);
    stage = 'CONSENT_LAUNCH';
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
    stage = 'CONSENT_BUNDLE';
    if (policy.bundledInstallation) {
      if (policy.runtime !== 'node' || canonical(policy.entryPoint) !== canonical(path.join(policy.sourceRoot, 'dist', 'index.js'))) throw new Error();
      if (canonical(policy.sourceRoot) !== canonical(path.join(getWorkspaceDataDir(), 'mcp-servers', policy.bundledInstallation.packageDirectory))) throw new Error();
      const relativeInstallation = path.relative(path.resolve(getDataDir()), policy.bundledInstallation.installationRoot);
      if (!relativeInstallation || (relativeInstallation !== '..' && !relativeInstallation.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeInstallation))) throw new Error();
      for (const item of policy.bundledInstallation.dependencyLinks) {
        const relativeLink = path.relative(path.join(policy.sourceRoot, 'node_modules'), item.link);
        if (relativeLink === '..' || relativeLink.startsWith(`..${path.sep}`) || path.isAbsolute(relativeLink)) throw new Error();
      }
    }
    stage = 'CONSENT_ENVIRONMENT';
    const requestedEnvironment = [...trustedHostEnvironment(config)].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, value]) => {
      if (!policy.environmentNames.includes(name)) throw new Error();
      return [name, value];
    });
    stage = 'CONSENT_CAPABILITIES';
    const rootEntry = z.string().max(2048).refine(value => !value.includes('${global:') && !/[\x00-\x1f\x7f]/.test(value));
    const roots = z.array(rootEntry).max(64).parse(config.roots ?? []);
    const rootPath = rootEntry.parse(config.rootPath ?? '');
    stage = 'CONSENT_SERIALIZE';
    const consent = JSON.stringify({
      domain: 'flujo:mcp:trusted-host-consent:v2', command, args, cwd, requestedEnvironment,
      policy: { ...policy, environmentNames: [...policy.environmentNames].sort() },
      capabilities: { roots, sampling: config.sampling ?? null, elicitation: config.elicitation ?? null,
        apps: config.enableMcpApps === true, skills: config.enableMcpSkills === true, rootPath,
        runtimeHomeMode: config.runtimeHomeMode ?? null },
    });
    // Configured environment/arguments can contain credentials. Their consent
    // commitment must resist cheap offline guessing, rather than hash secrets
    // with the same fast SHA-256 used for public package byte fingerprints.
    const salt = JSON.stringify(['flujo:mcp:trusted-host-consent:v2', getCurrentWorkspace(), config.name, policy.sourceRoot]);
    return { consent, salt };
  } catch (cause) {
    if (diagnostic) throw new BundledConsentDiagnostic(stage, cause);
    throw new TrustedHostMcpError('HOST_POLICY_INVALID');
  }
}

export function trustedHostMcpPolicyDigest(config: MCPStdioConfig): string {
  const { consent, salt } = consentInput(config);
  return scryptSync(consent, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex');
}

/** Compare full admitted consent inputs within one check; never caches authority. */
export function sameTrustedHostConsent(left: MCPStdioConfig, right: MCPStdioConfig): boolean {
  const first = consentInput(left), second = consentInput(right);
  return first.consent === second.consent && first.salt === second.salt;
}

export async function trustedHostMcpPolicyDigestAsync(config: MCPStdioConfig, signal?: AbortSignal): Promise<string> {
  return policyDigestAsync(config, signal, false);
}

/** Preview diagnostics only; ordinary runtime errors and authority are unchanged. */
export async function trustedHostMcpPreviewDigestAsync(config: MCPStdioConfig): Promise<string> {
  return policyDigestAsync(config, undefined, true);
}

async function policyDigestAsync(config: MCPStdioConfig, signal: AbortSignal | undefined, diagnostic: boolean): Promise<string> {
  if (signal?.aborted) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
  const { consent, salt } = consentInput(config, diagnostic);
  const digest = await new Promise<Buffer>((resolve, reject) => {
    const refuse = (cause: unknown) => reject(diagnostic ? new BundledConsentDiagnostic('CONSENT_SCRYPT', cause) : cause);
    try {
      scrypt(consent, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
        (error, result) => error ? refuse(error) : resolve(result));
    } catch (cause) { refuse(cause); }
  });
  try {
    if (signal?.aborted) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
    return digest.toString('hex');
  } finally { digest.fill(0); }
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
    const approvalFile = process.env.FLUJO_MCP_TRUSTED_HOST_FILE, ownerFile = process.env.FLUJO_OWNER_AUTH_FILE;
    if (!approvalFile || !ownerFile) throw new Error();
    const filenames = [approvalFile, ownerFile];
    const identities = filenames.map(filename => fs.lstatSync(filename, { bigint: true }));
    const before = process.platform === 'win32' ? windowsPrivateAuthorityStamp(filenames) : undefined;
    const contents = filenames.map(filename => readPrivateApprovalContents(filename));
    if (before !== undefined && windowsPrivateAuthorityStamp(filenames) !== before) throw new Error();
    for (const [index, filename] of filenames.entries()) {
      assertLinkFree(filename);
      if (!sameIdentity(identities[index], fs.lstatSync(filename, { bigint: true }))) throw new Error();
    }
    if (approvalFile !== process.env.FLUJO_MCP_TRUSTED_HOST_FILE || ownerFile !== process.env.FLUJO_OWNER_AUTH_FILE) throw new Error();
    const approvals = approvalsSchema.parse(contents[0]);
    const owner = ownerPolicySchema.parse(contents[1]);
    const grant = approvals.approvals.find(item => item.workspace === getCurrentWorkspace() && item.serverName === config.name);
    if (owner.ownerId !== approvals.ownerId || !grant || grant.expiresAt <= Date.now() || grant.policyDigest !== digest) throw new Error();
    return { policy, digest, ownerId: owner.ownerId, workspace: getCurrentWorkspace(), expiresAt: grant.expiresAt };
  } catch (error) {
    if (error instanceof TrustedHostMcpError) throw error;
    throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
  }
}

export async function trustedHostMcpApprovalAsync(config: MCPStdioConfig, signal?: AbortSignal) {
  try {
    const captured = structuredClone(config);
    const workspace = getCurrentWorkspace();
    const policy = trustedHostMcpPolicySchema.parse(captured.trustedHost);
    const digest = await trustedHostMcpPolicyDigestAsync(captured, signal);
    const approvalFile = process.env.FLUJO_MCP_TRUSTED_HOST_FILE;
    const ownerFile = process.env.FLUJO_OWNER_AUTH_FILE;
    if (!approvalFile || !ownerFile) throw new Error();
    // One fresh native snapshot covers BOTH chains before and after the held-FD
    // reads. There is no gap where one private reader awaits another helper.
    const results = await readPrivateApprovalPairAsync(approvalFile, ownerFile, signal);
    if (approvalFile !== process.env.FLUJO_MCP_TRUSTED_HOST_FILE || ownerFile !== process.env.FLUJO_OWNER_AUTH_FILE) throw new Error();
    const approvals = approvalsSchema.parse(results[0]);
    const owner = ownerPolicySchema.parse(results[1]);
    const grant = approvals.approvals.find(item => item.workspace === workspace && item.serverName === captured.name);
    if (signal?.aborted || workspace !== getCurrentWorkspace() || owner.ownerId !== approvals.ownerId
        || !grant || grant.expiresAt <= Date.now() || grant.policyDigest !== digest) throw new Error();
    return { policy, digest, ownerId: owner.ownerId, workspace, expiresAt: grant.expiresAt };
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
  const handle = await fs.promises.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== BigInt(1) || opened.size > BigInt(maximum)) throw new Error();
    await assertLinkFreeAsync(filename);
    if (!sameIdentity(opened, await fs.promises.lstat(filename, { bigint: true }))) throw new Error();
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

async function fingerprintSourceAsync(sourceRoot: string, signal?: AbortSignal, dependencyLinks: readonly { link: string; target: string }[] = []): Promise<string> {
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
      if (stat.isSymbolicLink()) {
        const admitted = dependencyLinks.find(item => canonical(item.link) === canonical(filename));
        if (!admitted || canonical(await fs.promises.realpath(filename)) !== canonical(admitted.target)) throw new Error();
        tree.update(JSON.stringify(['approved-dependency-link', path.relative(root, filename).split(path.sep).join('/'), canonical(admitted.target)]));
        continue;
      }
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
  const before = await trustedHostMcpApprovalAsync(captured, signal);
  try {
    const executable = await hashStableFileAsync(captured.command, MAX_EXECUTABLE_BYTES, signal);
    const source = await fingerprintSourceAsync(before.policy.sourceRoot, signal, before.policy.bundledInstallation?.dependencyLinks);
    if (before.policy.bundledInstallation) {
      const bundle = before.policy.bundledInstallation;
      const { inspectShippedWorkspaceProvenance } = await import('../mcp/shippedWorkspacePackages');
      const inspected = await inspectShippedWorkspaceProvenance(getWorkspaceDataDir(), bundle.packageDirectory, bundle.installationRoot);
      if (signal?.aborted || inspected.assetDigest !== bundle.assetDigest
          || canonical(inspected.dependencyNamespaceRoot) !== canonical(bundle.dependencyNamespaceRoot)
          || inspected.dependencyGraph.digest !== bundle.dependencyGraphDigest
          || JSON.stringify(inspected.dependencyLinks) !== JSON.stringify(bundle.dependencyLinks)
          || JSON.stringify(inspected.dependencies.map(item => item.directory)) !== JSON.stringify(bundle.dependencyDirectories)) throw new Error();
    }
    if (executable.digest !== before.policy.executableDigest || source !== before.policy.sourceDigest) throw new Error();
  } catch { throw new TrustedHostMcpError('HOST_SOURCE_CHANGED'); }
  if (signal?.aborted) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
  const after = await trustedHostMcpApprovalAsync(captured, signal);
  if (after.ownerId !== before.ownerId || after.digest !== before.digest || after.workspace !== before.workspace) throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED');
  return after;
}
