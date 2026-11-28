/**
 * Install an MCP bundle (.mcpb) as a local MCP server (#1230).
 *
 * Two steps, so nothing runs before the person agrees:
 * 1. {@link reviewMcpbBundle} reads the file and answers what it is, who made
 *    it, what it will run, which settings it needs and whether it fits this
 *    computer. Nothing is written.
 * 2. {@link installMcpbBundle} receives the same file again with the digest
 *    from the review and the settings. A file that changed is refused, and so
 *    is a file whose signature does not hold up (see ./signature.ts). The
 *    bundle is unpacked into `mcp-servers/mcpb/<name>` and saved as a local
 *    (stdio) server through the normal MCP service, so the usual start rules
 *    apply: host access in multi-user mode and owner approval in protected
 *    setups. Installing the same bundle again upgrades it in place.
 */
import path from 'path';
import fs from 'fs/promises';
import { mcpService } from '@/backend/services/mcp';
import { assertMcpHostInstallationAllowed, McpHostInstallationError } from '@/backend/services/mcp/installerEnvironment';
import { HostAccessRequiredError, mayStartHostProgram } from '@/backend/services/accounts/hostAccess';
import { createLogger } from '@/utils/logger';
import type { EnvVarValue, MCPServerConfig, MCPServerSource } from '@/shared/types/mcp';
import type {
  McpbInstallResult,
  McpbReview,
  McpbReviewWarning,
  McpbUserConfigField,
  McpbUserConfigValue,
} from '@/shared/types/mcp/mcpb';
import {
  assertFreeSpace,
  mcpbLimits,
  openMcpbArchive,
  unpackMcpbArchive,
  type McpbLimits,
  type OpenedMcpbArchive,
} from './archive';
import {
  isMcpbServerDir,
  mcpbInstallDir,
  mcpbRoot,
  moveDir,
  pathExists,
  removeTree,
  siblingDir,
  sweepMcpbLeftovers,
} from './files';
import {
  buildLaunchPlan,
  checkUserConfig,
  KNOWN_MANIFEST_VERSIONS,
  launchTemplate,
  manifestPlatforms,
  manifestVersionOf,
  McpbError,
  parseMcpbManifest,
  platformSupported,
  userConfigFields,
  type McpbLaunchPlan,
  type McpbManifest,
} from './manifest';
import { signatureProblemText } from './signature';
import { assertUserConfigPaths } from './userConfigPaths';

const log = createLogger('backend/services/mcp/mcpb/install');

export const MCPB_SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RUNTIME_COMMANDS = new Set(['node', 'python', 'python3', 'uv', 'uvx']);
const BUNDLE_FOLDER_LABEL = '<bundle folder>';

type McpbSource = Extract<MCPServerSource, { type: 'mcpb' }>;

interface InspectedBundle {
  archive: OpenedMcpbArchive;
  manifest: McpbManifest;
}

async function inspect(bytes: Buffer, limits: McpbLimits): Promise<InspectedBundle> {
  const archive = await openMcpbArchive(bytes, limits);
  return { archive, manifest: parseMcpbManifest(archive.manifestText) };
}

function mcpbSource(config: MCPServerConfig | undefined): McpbSource | undefined {
  return config?.source?.type === 'mcpb' ? config.source : undefined;
}

async function loadConfigs(): Promise<MCPServerConfig[]> {
  const configs = await mcpService.loadServerConfigs();
  if (!Array.isArray(configs)) throw new Error(configs.error ?? 'Could not read the MCP server list.');
  return configs;
}

function baseServerName(manifestName: string): string {
  const slug = manifestName.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[-_]+|-+$/g, '').slice(0, 56);
  return slug || 'mcp-bundle';
}

function suggestServerName(manifest: McpbManifest, configs: MCPServerConfig[]): { name: string; existing?: MCPServerConfig } {
  const existing = configs.find((config) => mcpbSource(config)?.bundleName === manifest.name);
  if (existing) return { name: existing.name, existing };
  const taken = new Set(configs.map((config) => config.name.toLowerCase()));
  const base = baseServerName(manifest.name);
  for (let suffix = 1; ; suffix++) {
    const candidate = suffix === 1 ? base : `${base}-${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return { name: candidate };
  }
}

function portableRelative(root: string, target: string): string | undefined {
  const relative = path.relative(root, path.resolve(root, target));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return relative.split(path.sep).join('/');
}

function normalizedEntryPoint(entry: string): string {
  return entry.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
}

/**
 * Decide what program starts. Bundles may start Node.js, Python or uv, or a
 * program inside the bundle itself; nothing else on the computer.
 */
function resolveCommand(
  plan: McpbLaunchPlan,
  installDir: string,
  archive: OpenedMcpbArchive,
  platform: string,
): { command: string; bundledFile?: string } {
  const command = plan.command;
  const leaf = command.split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/, '') ?? '';
  const isBare = !/[\\/]/.test(command);
  if (isBare || RUNTIME_COMMANDS.has(leaf)) {
    if (RUNTIME_COMMANDS.has(leaf)) return { command };
    throw new McpbError(
      `This bundle wants to start "${command}". FLUJO only starts bundles that run with Node.js, Python or uv, or that bring their own program.`,
      'unsupported-command',
    );
  }
  const relative = portableRelative(installDir, command);
  if (!relative) {
    throw new McpbError(`This bundle wants to start "${command}", a program outside the bundle. FLUJO will not run it.`, 'unsupported-command');
  }
  const candidates = platform === 'win32' && !/\.exe$/i.test(relative) ? [`${relative}.exe`, relative] : [relative];
  const bundledFile = candidates.find((candidate) => archive.files.has(candidate));
  if (bundledFile) return { command: path.join(installDir, ...bundledFile.split('/')), bundledFile };
  throw new McpbError(`The bundle says it starts "${relative}", but that file is not in the bundle.`, 'missing-entry-point');
}

function assertEntryPoint(manifest: McpbManifest, plan: McpbLaunchPlan, installDir: string, archive: OpenedMcpbArchive, bundledFile?: string): void {
  if (bundledFile) return;
  const entry = normalizedEntryPoint(manifest.server.entry_point);
  if (archive.files.has(entry)) return;
  const pointsIntoBundle = plan.args.some((arg) => {
    const relative = portableRelative(installDir, arg.slice(arg.indexOf('=') + 1));
    return relative !== undefined && archive.files.has(relative);
  });
  if (pointsIntoBundle) return;
  throw new McpbError(`The bundle says its server starts from "${entry}", but that file is not in the bundle.`, 'missing-entry-point');
}

function displayPath(value: string, installDir: string): string {
  return value.split(installDir).join(BUNDLE_FOLDER_LABEL);
}

function safeUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function savedSecretKeys(existing: MCPServerConfig | undefined): Set<string> {
  const source = mcpbSource(existing);
  const keys = new Set<string>();
  for (const [key, envName] of Object.entries(source?.secretEnv ?? {})) {
    const stored = existing?.env?.[envName];
    const value = typeof stored === 'string' ? stored : stored?.value;
    if (value) keys.add(key);
  }
  return keys;
}

function withSavedValues(fields: McpbUserConfigField[], existing: MCPServerConfig | undefined): McpbUserConfigField[] {
  const saved = mcpbSource(existing)?.userConfig ?? {};
  const secrets = savedSecretKeys(existing);
  return fields.map((field) => {
    if (field.sensitive) return secrets.has(field.key) ? { ...field, hasSavedSecret: true } : field;
    return Object.prototype.hasOwnProperty.call(saved, field.key) ? { ...field, savedValue: saved[field.key] } : field;
  });
}

/** The confirmed signer of a file, when its signature is trusted. */
function trustedSigner(archive: OpenedMcpbArchive): McpbSource['signer'] {
  const { status, signer } = archive.signature;
  return status === 'signed' && signer ? { name: signer.name, fingerprint: signer.fingerprint } : undefined;
}

/** A renewed certificate keeps its name, so only a different name (or none) counts as a change. */
function signerChanged(existing: MCPServerConfig | undefined, archive: OpenedMcpbArchive): boolean {
  const before = mcpbSource(existing)?.signer;
  return Boolean(before) && trustedSigner(archive)?.name !== before?.name;
}

function reviewWarnings(
  manifest: McpbManifest,
  plan: McpbLaunchPlan,
  bundledFile: string | undefined,
  archive: OpenedMcpbArchive,
  existing: MCPServerConfig | undefined,
): McpbReviewWarning[] {
  const warnings: McpbReviewWarning[] = [];
  if (plan.secretInCommandLine) warnings.push('secret-in-command-line');
  if (bundledFile) warnings.push('runs-bundled-program');
  if (manifest.server.type === 'uv') warnings.push('installs-python-packages');
  if (!KNOWN_MANIFEST_VERSIONS.has(manifestVersionOf(manifest))) warnings.push('newer-format');
  if (signerChanged(existing, archive)) warnings.push('signer-changed');
  return warnings;
}

function assertSignatureHoldsUp(archive: OpenedMcpbArchive): void {
  if (archive.signature.status !== 'invalid') return;
  throw new McpbError(`FLUJO will not install this bundle: its signature does not hold up. ${signatureProblemText(archive.signature)}`, 'invalid-signature');
}

/** Fill every setting with a stand-in so the review can show the command without real values. */
function previewValues(fields: McpbUserConfigField[]): Record<string, McpbUserConfigValue> {
  return Object.fromEntries(fields.map((field) => [field.key, field.multiple ? [`<${field.title}>`] : `<${field.title}>`]));
}

/** Read a bundle and describe it. Writes nothing and starts nothing. */
export async function reviewMcpbBundle(bytes: Buffer, limits: McpbLimits = mcpbLimits()): Promise<McpbReview> {
  const { archive, manifest } = await inspect(bytes, limits);
  const configs = await loadConfigs();
  const suggestion = suggestServerName(manifest, configs);
  const installDir = mcpbInstallDir(suggestion.name);
  const fields = withSavedValues(userConfigFields(manifest), suggestion.existing);
  const sensitiveKeys = new Set(fields.filter((field) => field.sensitive).map((field) => field.key));
  const plan = buildLaunchPlan(manifest, { dirname: installDir, values: previewValues(fields), sensitiveKeys });
  const { command, bundledFile } = resolveCommand(plan, installDir, archive, process.platform);
  assertEntryPoint(manifest, plan, installDir, archive, bundledFile);
  const existingSource = mcpbSource(suggestion.existing);

  return {
    digest: archive.digest,
    manifestName: manifest.name,
    displayName: manifest.display_name?.trim() || manifest.name,
    version: manifest.version,
    manifestVersion: manifestVersionOf(manifest),
    description: manifest.description,
    ...(manifest.long_description ? { longDescription: manifest.long_description } : {}),
    author: {
      name: manifest.author.name,
      ...(manifest.author.email ? { email: manifest.author.email } : {}),
      ...(safeUrl(manifest.author.url) ? { url: safeUrl(manifest.author.url) } : {}),
    },
    ...(manifest.license ? { license: manifest.license } : {}),
    ...(safeUrl(manifest.homepage) ? { homepage: safeUrl(manifest.homepage) } : {}),
    ...(safeUrl(manifest.repository?.url) ? { repositoryUrl: safeUrl(manifest.repository?.url) } : {}),
    ...(safeUrl(manifest.documentation) ? { documentation: safeUrl(manifest.documentation) } : {}),
    ...(safeUrl(manifest.support) ? { support: safeUrl(manifest.support) } : {}),
    serverType: manifest.server.type,
    launch: {
      command: displayPath(command, installDir),
      args: plan.args.map((arg) => displayPath(arg, installDir)),
      envNames: Object.keys(launchTemplate(manifest).env).sort(),
    },
    runtimes: { ...(manifest.compatibility?.runtimes ?? {}) },
    flujoNodeVersion: process.versions.node,
    platforms: manifestPlatforms(manifest),
    thisPlatform: process.platform,
    platformSupported: platformSupported(manifest),
    tools: (manifest.tools ?? []).map((tool) => ({ name: tool.name, ...(tool.description ? { description: tool.description } : {}) })),
    toolsGenerated: manifest.tools_generated === true,
    prompts: (manifest.prompts ?? []).map((prompt) => ({ name: prompt.name, ...(prompt.description ? { description: prompt.description } : {}) })),
    promptsGenerated: manifest.prompts_generated === true,
    privacyPolicies: (manifest.privacy_policies ?? []).flatMap((url) => safeUrl(url) ?? []),
    userConfig: fields,
    signature: archive.signature,
    files: { count: archive.entries.length, packedBytes: archive.packedBytes, unpackedBytes: archive.unpackedBytes },
    suggestedServerName: suggestion.name,
    ...(suggestion.existing && existingSource
      ? {
        existing: {
          serverName: suggestion.existing.name,
          version: existingSource.version,
          ...(existingSource.signer ? { signer: existingSource.signer.name } : {}),
        },
      }
      : {}),
    warnings: reviewWarnings(manifest, plan, bundledFile, archive, suggestion.existing),
  };
}

export interface InstallMcpbInput {
  bytes: Buffer;
  reviewedDigest: string;
  serverName: string;
  userConfig: Record<string, unknown>;
}

const installsInFlight = new Map<string, Promise<unknown>>();

/** One install per bundle folder at a time; the next one waits its turn. */
async function oneAtATime<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = installsInFlight.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(work);
  installsInFlight.set(key, current);
  try {
    return await current;
  } finally {
    if (installsInFlight.get(key) === current) installsInFlight.delete(key);
  }
}

async function assertMayInstall(): Promise<void> {
  try {
    assertMcpHostInstallationAllowed();
  } catch (error) {
    if (error instanceof McpHostInstallationError) {
      throw new McpbError('This FLUJO is set up so that only reviewed, preinstalled servers may run. Bundles cannot be installed here.', 'host-install-blocked', 403);
    }
    throw error;
  }
  if (!(await mayStartHostProgram())) throw new HostAccessRequiredError('local-mcp-server');
}

function persistedEnv(
  plan: McpbLaunchPlan,
  keptSecrets: ReadonlySet<string>,
  existing: MCPServerConfig | undefined,
): Record<string, EnvVarValue> {
  const oldSecretEnv = mcpbSource(existing)?.secretEnv ?? {};
  const env: Record<string, EnvVarValue> = {};
  for (const [name, entry] of Object.entries(plan.env)) {
    const keptKey = Object.entries(plan.secretEnv).find(([key, envName]) => envName === name && keptSecrets.has(key))?.[0];
    if (keptKey) {
      const stored = existing?.env?.[oldSecretEnv[keptKey]];
      if (stored !== undefined) env[name] = typeof stored === 'string' ? { value: stored, metadata: { isSecret: true } } : stored;
      continue;
    }
    env[name] = entry.secret ? { value: entry.value, metadata: { isSecret: true } } : entry.value;
  }
  return env;
}

async function reconnect(serverName: string): Promise<void> {
  await mcpService.connectServer(serverName).catch((error: unknown) => log.warn(`Could not restart ${serverName}`, error));
}

interface PreparedInstall {
  serverName: string;
  installDir: string;
  archive: OpenedMcpbArchive;
  manifest: McpbManifest;
  existing?: MCPServerConfig;
  bundledFile?: string;
  config: Partial<MCPServerConfig>;
}

/**
 * Put the unpacked files in place: unpack into `.staging-…`, move an old
 * version to `.old-…`, move the new one in. Returns how to undo it.
 */
async function placeFiles(prepared: PreparedInstall, limits: McpbLimits, staging: string, previous: string): Promise<{ rollback: () => Promise<void>; hadPrevious: boolean }> {
  const { serverName, installDir, existing, bundledFile } = prepared;
  try {
    await unpackMcpbArchive(prepared.archive, staging, limits);
    if (bundledFile && process.platform !== 'win32') await fs.chmod(path.join(staging, ...bundledFile.split('/')), 0o755);
  } catch (error) {
    await removeTree(staging).catch((cleanupError: unknown) => log.warn('Could not remove a half-unpacked bundle; it is removed later.', cleanupError));
    throw error;
  }

  if (existing) await mcpService.disconnectServer(serverName).catch((error: unknown) => log.warn(`Could not stop ${serverName} before upgrading`, error));
  const hadPrevious = await pathExists(installDir);
  try {
    if (hadPrevious) await moveDir(installDir, previous);
  } catch (error) {
    await removeTree(staging).catch(() => undefined);
    if (existing) await reconnect(serverName);
    log.warn(`Could not move the old files of ${serverName}`, error);
    throw new McpbError('The installed version is still in use by another program. Close it and try again.', 'in-use', 409);
  }
  const rollback = async () => {
    await removeTree(installDir).catch(() => undefined);
    if (hadPrevious) await moveDir(previous, installDir).catch((error: unknown) => log.warn(`Could not restore the old files of ${serverName}`, error));
    if (existing) await reconnect(serverName);
  };
  try {
    await moveDir(staging, installDir);
  } catch (error) {
    await removeTree(staging).catch(() => undefined);
    await rollback();
    throw error;
  }
  return { rollback, hadPrevious };
}

/** Save the server through the MCP service (which starts it); undo the files when that fails. */
async function register(prepared: PreparedInstall, rollback: () => Promise<void>): Promise<void> {
  let saved: Awaited<ReturnType<typeof mcpService.updateServerConfig>>;
  try {
    saved = await mcpService.updateServerConfig(prepared.serverName, prepared.config);
  } catch (error) {
    await rollback();
    throw error;
  }
  if (!Array.isArray(saved) && 'success' in saved && saved.success === false) {
    await rollback();
    throw new Error(saved.error ?? 'Saving the server failed.');
  }
}

async function prepareInstall(input: InstallMcpbInput, serverName: string, limits: McpbLimits): Promise<PreparedInstall> {
  const { archive, manifest } = await inspect(input.bytes, limits);
  if (archive.digest !== input.reviewedDigest) {
    throw new McpbError('This file is not the one you reviewed. Review it again before installing.', 'changed-since-review', 409);
  }
  assertSignatureHoldsUp(archive);
  if (!platformSupported(manifest)) {
    throw new McpbError(`This bundle is not made for this computer (${process.platform}). It supports: ${manifestPlatforms(manifest).join(', ')}.`, 'wrong-platform');
  }
  const configs = await loadConfigs();
  const existing = configs.find((config) => config.name.toLowerCase() === serverName.toLowerCase());
  if (existing && (existing.name !== serverName || mcpbSource(existing)?.bundleName !== manifest.name)) {
    throw new McpbError(`A connected app named "${existing.name}" already exists. Choose another name.`, 'name-taken', 409);
  }

  const fields = userConfigFields(manifest);
  const checked = checkUserConfig(fields, input.userConfig, savedSecretKeys(existing));
  await assertUserConfigPaths(fields, checked.values);
  const keptSecrets = new Set(checked.keptSecrets);
  const sensitiveKeys = new Set(fields.filter((field) => field.sensitive).map((field) => field.key));
  const installDir = mcpbInstallDir(serverName);
  const plan = buildLaunchPlan(manifest, { dirname: installDir, values: checked.values, sensitiveKeys, keptSecrets });
  const { command, bundledFile } = resolveCommand(plan, installDir, archive, process.platform);
  assertEntryPoint(manifest, plan, installDir, archive, bundledFile);

  const userConfig = Object.fromEntries(Object.entries(checked.values).filter(([key]) => !sensitiveKeys.has(key)));
  const signer = trustedSigner(archive);
  const source: McpbSource = {
    type: 'mcpb',
    bundleName: manifest.name,
    version: manifest.version,
    digest: archive.digest,
    ...(Object.keys(userConfig).length ? { userConfig } : {}),
    ...(Object.keys(plan.secretEnv).length ? { secretEnv: plan.secretEnv } : {}),
    ...(signer ? { signer } : {}),
  };
  const config = {
    name: serverName,
    transport: 'stdio',
    command,
    args: plan.args,
    env: persistedEnv(plan, keptSecrets, existing),
    rootPath: installDir,
    disabled: false,
    _buildCommand: '',
    _installCommand: '',
    source,
  } satisfies Partial<MCPServerConfig>;
  return { serverName, installDir, archive, manifest, config, ...(existing ? { existing } : {}), ...(bundledFile ? { bundledFile } : {}) };
}

/** Unpack and register a reviewed bundle. */
export async function installMcpbBundle(input: InstallMcpbInput, limits: McpbLimits = mcpbLimits()): Promise<McpbInstallResult> {
  const serverName = input.serverName.trim();
  if (!MCPB_SERVER_NAME.test(serverName)) {
    throw new McpbError('Use a name of 1–64 letters, numbers, hyphens or underscores that starts with a letter or number.', 'invalid-name');
  }
  await assertMayInstall();
  return oneAtATime(mcpbInstallDir(serverName).toLowerCase(), async () => {
    const prepared = await prepareInstall(input, serverName, limits);
    await fs.mkdir(mcpbRoot(), { recursive: true });
    await sweepMcpbLeftovers();
    await assertFreeSpace(mcpbRoot(), prepared.archive.unpackedBytes);

    const staging = siblingDir('.staging-', serverName);
    const previous = siblingDir('.old-', serverName);
    try {
      const { rollback, hadPrevious } = await placeFiles(prepared, limits, staging.dir, previous.dir);
      await register(prepared, rollback);
      if (hadPrevious) await removeTree(previous.dir).catch((error: unknown) => log.warn('The old bundle files are removed later.', error));
      const oldRoot = prepared.existing?.rootPath;
      if (oldRoot && isMcpbServerDir(oldRoot) && path.resolve(oldRoot) !== path.resolve(prepared.installDir)) {
        await removeTree(path.resolve(oldRoot)).catch((error: unknown) => log.warn('The old bundle folder is removed later.', error));
      }
      return { installed: true, serverName, upgraded: Boolean(prepared.existing), version: prepared.manifest.version };
    } finally {
      staging.release();
      previous.release();
    }
  });
}
