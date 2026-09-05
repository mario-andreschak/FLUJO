import path from 'node:path';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import simpleGit from 'simple-git';
import type { MCPServerConfig, MCPStdioConfig, EnvVarValue } from '@/shared/types/mcp';
import type { McpInstallOrigin } from '@/shared/types/package';
import { getWorkspaceDataDir } from '@/utils/workspace';
import { mapInstallOrigin, resolveDependencies, type PackageEntities } from './buildPackage';
import { mcpService } from '@/backend/services/mcp';
import { prepareGithubServerRuntime } from '@/backend/services/mcp/githubInstall';
import { prepareRegistryServerRuntime } from '@/backend/services/mcp/registryInstall';
import { createShippedServerConfig, shippedDescriptorForConfig } from '@/backend/services/mcp/shippedServers';
import { atomicWriteWithoutLinks } from '@/backend/services/workspace/backupRestoreFs';

export interface WorkspaceMcpTransferServer {
  name: string;
  kind: 'bundled' | 'github' | 'registry' | 'remote' | 'package-runner' | 'disabled';
  sourceRootPath: string;
  installOrigin?: McpInstallOrigin;
  /** Disabled, unsupported configurations are retained but never started on the worker. */
  reason?: string;
}

/** Private clone metadata. Credentials and complete settings remain in the workspace DB. */
export interface WorkspaceMcpTransferPlan {
  formatVersion: 1;
  sourceWorkspaceRoot: string;
  servers: WorkspaceMcpTransferServer[];
}

export interface WorkspaceMcpReinstallResult {
  ok: boolean;
  servers: Array<{ name: string; status: 'ready' | 'disabled' | 'failed'; error?: string }>;
}

export interface WorkspaceFlowDependencySelection {
  /** Copy for the snapshot only; the live workspace must never persist this array. */
  configs: MCPServerConfig[];
  flowIds: string[];
  modelIds: string[];
  mcpServerNames: string[];
  disabledServerNames: string[];
  requiresCodexAuth: boolean;
}

/** Use package dependency resolution to select a worker's executable flow closure. */
export function selectWorkspaceFlowDependencies(
  flowIds: string[] | undefined,
  entities: Pick<PackageEntities, 'flows' | 'models' | 'mcpServers'>,
): WorkspaceFlowDependencySelection {
  const configs = structuredClone(entities.mcpServers);
  let selectedFlows = entities.flows.map(flow => flow.id);
  let selectedModels = entities.models.map(model => model.id);
  let selectedServers = configs.map(config => config.name);
  const disabledServerNames: string[] = [];
  if (flowIds !== undefined) {
    if (!Array.isArray(flowIds) || flowIds.length === 0 || flowIds.some(id => typeof id !== 'string' || !id.trim())) {
      throw new Error('Select at least one valid flow ID for the worker.');
    }
    const resolved = resolveDependencies({ flowIds }, { ...entities, plannedExecutions: [] });
    if (resolved.warnings.length) throw new Error(`The selected flows have unresolved dependencies: ${resolved.warnings.join(' ')}`);
    selectedFlows = resolved.flowIds;
    selectedModels = resolved.modelIds;
    selectedServers = resolved.mcpServerNames;
    const required = new Set(selectedServers);
    for (const flow of entities.flows.filter(candidate => selectedFlows.includes(candidate.id))) {
      if ((flow.nodes ?? []).some(node => node.data?.properties?.parallelSubflowIdsVar)) {
        throw new Error(`Flow "${flow.name}" selects subflows dynamically; export the whole workspace or use static subflow targets.`);
      }
    }
    for (const config of configs) {
      if (required.has(config.name)) {
        if (config.disabled) throw new Error(`Required MCP server "${config.name}" is disabled in the source workspace.`);
      } else {
        if (!config.disabled) disabledServerNames.push(config.name);
        config.disabled = true;
      }
    }
  }
  const requiredModelIds = new Set(selectedModels);
  return {
    configs, flowIds: selectedFlows, modelIds: selectedModels, mcpServerNames: selectedServers,
    disabledServerNames,
    requiresCodexAuth: entities.models.some(model => requiredModelIds.has(model.id)
      && (model.adapter === 'codex-cli' || model.provider === 'codex') && !model.ApiKey?.trim()),
  };
}

const RUNNERS = new Set(['npx', 'uvx']);
const runtimeEnvironmentKeys = new Set([
  'FLUJO_PARENT_DATA_DIR', 'FLUJO_DATA_DIR', 'FLUJO_WORKSPACE',
  'FLUJO_BASE_URL',
  'FLUJO_BROWSER_PROFILE_DIR', 'FLUJO_BROWSER_SCREENSHOT_DIR', 'FLUJO_BROWSER_RECORD_DIR',
  'PLAYWRIGHT_BROWSERS_PATH',
]);

function pathApi(value: string): typeof path.posix {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') ? path.win32 : path.posix;
}

function absolute(value: string): boolean {
  return path.win32.isAbsolute(value) || path.posix.isAbsolute(value);
}

function relativeInside(root: string, value: string): string | undefined {
  const api = pathApi(root);
  const relative = api.relative(api.resolve(root), api.resolve(value));
  if (relative === '..' || relative.startsWith(`..${api.sep}`) || api.isAbsolute(relative)) return undefined;
  return relative.split(api.sep).join('/');
}

function runner(config: MCPStdioConfig): string | undefined {
  const name = config.command.split(/[\\/]/).at(-1)?.toLowerCase().replace(/\.(cmd|exe|bat)$/i, '');
  return name && RUNNERS.has(name) ? name : undefined;
}

function fail(name: string, reason: string): never {
  throw new Error(`MCP server "${name}" cannot be cloned: ${reason}`);
}

/** Remap complete paths/URI paths and --flag=path values, never arbitrary shell text. */
function mapPath(value: string, mappings: Array<[string, string]>, strict = false, check?: (value: string) => void): string {
  if (/^file:/i.test(value)) {
    const url = new URL(value);
    // fileURLToPath on Linux rejects Windows drive URLs, so select the source syntax.
    const windows = /^\/[A-Za-z]:\//.test(url.pathname);
    const source = windows ? decodeURIComponent(url.pathname.slice(1)).replace(/\//g, '\\') : fileURLToPath(url);
    const mapped = mapPath(source, mappings, strict, check);
    return mapped === source ? value : pathToFileURL(mapped).href;
  }
  const equals = value.indexOf('=');
  if (equals > 0) return `${value.slice(0, equals + 1)}${mapPath(value.slice(equals + 1), mappings, strict, check)}`;
  if (!absolute(value)) return /^\.?\.?[\\/]/.test(value) ? value.replace(/\\/g, '/') : value;
  check?.(value);
  for (const [source, target] of mappings) {
    const relative = relativeInside(source, value);
    if (relative !== undefined) return relative ? path.join(target, ...relative.split('/')) : target;
  }
  if (strict) throw new Error('an external filesystem path needs an explicit cloud replacement');
  return value;
}

function validatePaths(config: MCPServerConfig, sourceWorkspaceRoot: string, bundled: boolean): void {
  const mappings: Array<[string, string]> = [[sourceWorkspaceRoot, sourceWorkspaceRoot]];
  const root = config.rootPath || '.';
  const resolvedRoot = absolute(root) ? root : pathApi(sourceWorkspaceRoot).resolve(sourceWorkspaceRoot, root);
  if (!bundled && relativeInside(sourceWorkspaceRoot, resolvedRoot) === undefined) {
    fail(config.name, 'its root is outside the workspace; move the required files into the workspace first.');
  }
  const omittedMcpRoot = pathApi(sourceWorkspaceRoot).join(sourceWorkspaceRoot, 'mcp-servers');
  const checkIncluded = (value: string): void => {
    if (relativeInside(omittedMcpRoot, value) !== undefined
      && !(config.source?.type === 'github' && relativeInside(resolvedRoot, value) !== undefined)) {
      throw new Error('A file belongs to an omitted MCP checkout.');
    }
  };
  const check = (value: string): void => { mapPath(value, mappings, true, checkIncluded); };
  try {
    for (const root of config.roots ?? []) {
      check(absolute(root) || /^file:/i.test(root) ? root : pathApi(sourceWorkspaceRoot).resolve(sourceWorkspaceRoot, root));
    }
    if (config.transport === 'stdio') {
      if (config.cwd && !bundled) mapPath(absolute(config.cwd) ? config.cwd : pathApi(sourceWorkspaceRoot).resolve(sourceWorkspaceRoot, config.cwd), mappings, true);
      for (const arg of (config.args ?? []).slice(bundled ? 1 : 0)) {
        if (/(?:^|=)\.\.(?:[\\/]|$)/.test(arg)) throw new Error('Relative parent path');
        const candidate = arg.slice(arg.indexOf('=') + 1);
        check(/^\.[\\/]/.test(candidate) ? pathApi(sourceWorkspaceRoot).resolve(resolvedRoot, candidate) : arg);
      }
    }
    for (const [key, raw] of Object.entries(config.env ?? {})) {
      if (bundled && runtimeEnvironmentKeys.has(key)) continue;
      const value = typeof raw === 'string' ? raw : raw.value;
      if (!/path|dir|home|root|file|cert/i.test(key) || value.startsWith('encrypted:')) continue;
      check(value);
    }
  } catch {
    fail(config.name, 'an argument, root, or environment setting references files outside the workspace or in an MCP checkout that will not be transferred.');
  }
}

/** Reuse package origins, while retaining identity and private configuration in the DB. */
export function buildWorkspaceMcpTransferPlan(
  configs: MCPServerConfig[],
  sourceWorkspaceRoot: string,
  options: { requiredServerNames?: readonly string[] } = {},
): WorkspaceMcpTransferPlan {
  if (!absolute(sourceWorkspaceRoot)) throw new Error('The source workspace root must be absolute.');
  const names = new Set<string>();
  const servers = configs.map((config): WorkspaceMcpTransferServer => {
    if (!config.name || names.has(config.name)) throw new Error('MCP server names must be nonempty and unique.');
    names.add(config.name);
    const common = { name: config.name, sourceRootPath: config.rootPath || '.' };
    if (options.requiredServerNames && !options.requiredServerNames.includes(config.name)) {
      if (!config.disabled) fail(config.name, 'an unrelated server must be disabled in the captured configuration.');
      return { ...common, kind: 'disabled', reason: 'Outside the selected flow dependencies; retained disabled.' };
    }
    try {
      if ('launch' in config && config.launch) fail(config.name, 'local HTTP process launch is not supported.');
      const bundled = config.transport === 'stdio' && Boolean(shippedDescriptorForConfig(config));
      validatePaths(config, sourceWorkspaceRoot, bundled);
      if (bundled) return { ...common, kind: 'bundled' };
      if (config.transport !== 'stdio') return { ...common, kind: 'remote' };
      const origin = mapInstallOrigin(config);
      if (origin?.sourceType === 'github' && origin.ref) {
        if (!/^node(?:\.exe)?$/i.test(config.command) && !/[\\/]node(?:\.exe)?$/i.test(config.command)) {
          fail(config.name, 'GitHub package restoration currently supports Node servers only.');
        }
        return { ...common, kind: 'github', installOrigin: origin };
      }
      if (!runner(config) || !(config.args?.length)) {
        fail(config.name, 'use a GitHub Node package, an npx/uvx package, or a hosted MCP server.');
      }
      if (origin?.sourceType === 'registry' && origin.ref) {
        return { ...common, kind: 'registry', installOrigin: origin };
      }
      // Explicit package-runner configs are reproducible even when the editor labels them local.
      return { ...common, kind: 'package-runner' };
    } catch (error) {
      if (!config.disabled) throw error;
      return { ...common, kind: 'disabled', reason: 'Unsupported disabled server retained without installing its runtime.' };
    }
  });
  return { formatVersion: 1, sourceWorkspaceRoot, servers };
}

/** Pin installed GitHub source, rather than rebuilding whichever commit a branch points to later. */
export async function pinWorkspaceMcpTransferPlan(
  plan: WorkspaceMcpTransferPlan,
  options: { signal?: AbortSignal } = {},
): Promise<WorkspaceMcpTransferPlan> {
  const pinned = structuredClone(plan);
  for (const entry of pinned.servers) {
    options.signal?.throwIfAborted();
    if (entry.kind !== 'github') continue;
    const sourceRoot = absolute(entry.sourceRootPath) ? entry.sourceRootPath
      : pathApi(plan.sourceWorkspaceRoot).resolve(plan.sourceWorkspaceRoot, entry.sourceRootPath);
    if (relativeInside(plan.sourceWorkspaceRoot, sourceRoot) === undefined) fail(entry.name, 'the Git checkout is outside the source workspace.');
    try {
      const git = simpleGit({ baseDir: sourceRoot, timeout: { block: 5_000 } });
      const status = await git.raw(['--no-optional-locks', 'status', '--porcelain']);
      options.signal?.throwIfAborted();
      if (status.trim()) fail(entry.name, 'the GitHub checkout has local changes; commit or discard them before cloning.');
      const commit = (await git.raw(['--no-optional-locks', 'rev-parse', 'HEAD'])).trim();
      if (!/^[a-f0-9]{40,64}$/i.test(commit)) fail(entry.name, 'the installed Git commit could not be identified.');
      entry.installOrigin = { ...entry.installOrigin!, gitRef: commit };
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof Error && error.message.startsWith('MCP server ')) throw error;
      fail(entry.name, 'the installed GitHub checkout could not be inspected.');
    }
  }
  options.signal?.throwIfAborted();
  return pinned;
}

function mapEnvironment(env: Record<string, EnvVarValue>, mappings: Array<[string, string]>): Record<string, EnvVarValue> {
  return Object.fromEntries(Object.entries(env).map(([key, raw]) => [
    key,
    typeof raw === 'string' ? mapPath(raw, mappings) : { ...raw, value: mapPath(raw.value, mappings) },
  ]));
}

interface PreparedRuntime {
  config: MCPServerConfig;
  requiredFiles: string[];
}

interface RuntimePreparationMarker {
  version: 1;
  recipeHash: string;
  rootPath: string;
  cwd?: string;
  requiredFiles: string[];
}

function preparationIdentity(entry: WorkspaceMcpTransferServer, plan: WorkspaceMcpTransferPlan) {
  const recipeHash = createHash('sha256').update(JSON.stringify({
    version: plan.formatVersion, source: plan.sourceWorkspaceRoot,
    target: getWorkspaceDataDir(), entry,
  })).digest('hex');
  return {
    recipeHash,
    file: path.join(getWorkspaceDataDir(), 'userdata', 'mcp-runtime', 'clone-preparation', `${recipeHash}.json`),
  };
}

async function runtimePathExists(target: string, file = false): Promise<boolean> {
  const workspace = getWorkspaceDataDir();
  const relative = path.relative(workspace, target);
  if (!path.isAbsolute(target) || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('A prepared MCP runtime path is outside the worker workspace.');
  }
  let current = workspace;
  const parts = relative ? relative.split(path.sep) : [];
  for (let index = -1; index < parts.length; index++) {
    if (index >= 0) current = path.join(current, parts[index]);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    const expectFile = file && index === parts.length - 1;
    if (stat.isSymbolicLink() || (expectFile ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error('A prepared MCP runtime path is not an ordinary file or directory.');
    }
  }
  return true;
}

async function existingRuntime(
  entry: WorkspaceMcpTransferServer, config: MCPServerConfig, plan: WorkspaceMcpTransferPlan,
): Promise<PreparedRuntime | undefined> {
  if (entry.kind !== 'github' && entry.kind !== 'registry') return undefined;
  const { file, recipeHash } = preparationIdentity(entry, plan);
  let marker: RuntimePreparationMarker;
  try {
    if (!await runtimePathExists(path.dirname(file))) return undefined;
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > 16_384) {
      throw new Error('Invalid worker MCP preparation marker.');
    }
    marker = JSON.parse(await fs.readFile(file, 'utf8')) as RuntimePreparationMarker;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('Could not read the worker MCP preparation marker.');
  }
  if (marker.version !== 1 || marker.recipeHash !== recipeHash || marker.rootPath !== config.rootPath
    || config.transport !== 'stdio' || marker.cwd !== config.cwd
    || !Array.isArray(marker.requiredFiles) || marker.requiredFiles.some(value => typeof value !== 'string')
    || (entry.kind === 'github' && marker.requiredFiles.length === 0)) return undefined;
  try {
    for (const directory of [marker.rootPath, marker.cwd].filter((value): value is string => Boolean(value))) {
      if (!await runtimePathExists(directory)) return undefined;
    }
    for (const required of marker.requiredFiles) {
      if (!await runtimePathExists(required, true)) return undefined;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('The prepared worker MCP runtime is unsafe or unavailable.');
  }
  // Jobs may legitimately write inside the checkout. Reconnect the saved target
  // configuration without fetching, checking cleanliness, or rerunning builds.
  return { config: structuredClone(config), requiredFiles: marker.requiredFiles };
}

async function recordPreparedRuntime(
  entry: WorkspaceMcpTransferServer, prepared: PreparedRuntime, plan: WorkspaceMcpTransferPlan,
): Promise<void> {
  if (entry.kind !== 'github' && entry.kind !== 'registry') return;
  const { file, recipeHash } = preparationIdentity(entry, plan);
  const marker: RuntimePreparationMarker = {
    version: 1, recipeHash, rootPath: prepared.config.rootPath,
    ...(prepared.config.transport === 'stdio' && prepared.config.cwd ? { cwd: prepared.config.cwd } : {}),
    requiredFiles: prepared.requiredFiles,
  };
  await atomicWriteWithoutLinks(getWorkspaceDataDir(), file, Buffer.from(JSON.stringify(marker)), { mode: 0o600 });
}

async function prepareConfig(
  entry: WorkspaceMcpTransferServer,
  original: MCPServerConfig,
  plan: WorkspaceMcpTransferPlan,
): Promise<PreparedRuntime> {
  const targetWorkspaceRoot = getWorkspaceDataDir();
  const mappings: Array<[string, string]> = [[plan.sourceWorkspaceRoot, targetWorkspaceRoot]];
  const config = structuredClone(original);
  const requiredFiles: string[] = [];
  if (entry.kind === 'bundled') {
    if (config.transport !== 'stdio') throw new Error('Bundled server transport changed.');
    const descriptor = shippedDescriptorForConfig(config);
    if (!descriptor) throw new Error('The bundled MCP package is unavailable on this worker.');
    const runtime = createShippedServerConfig(descriptor);
    const env = mapEnvironment(config.env, mappings);
    for (const key of runtimeEnvironmentKeys) {
      delete env[key];
      if (runtime.env[key] !== undefined) env[key] = runtime.env[key];
    }
    return { config: {
      ...config, command: runtime.command,
      args: [...(runtime.args ?? []), ...(config.args ?? []).slice(1).map(arg => mapPath(arg, mappings))], cwd: runtime.cwd,
      rootPath: runtime.rootPath, env,
      roots: (config.roots ?? []).map(root => mapPath(root, mappings)),
    }, requiredFiles };
  }
  if (entry.kind === 'github') {
    const origin = entry.installOrigin;
    if (!origin?.ref || config.transport !== 'stdio') throw new Error('Missing GitHub installation recipe.');
    const prepared = await prepareGithubServerRuntime({
      name: config.name, repositoryUrl: origin.ref, ref: origin.gitRef,
      subdirectory: origin.subdirectory, installCommand: origin.installCommand,
      buildCommand: origin.buildCommand, env: {}, disabled: true,
    });
    if (!prepared.installed || !prepared.config?.rootPath) throw new Error('GitHub runtime installation failed.');
    if (prepared.config.transport !== 'stdio' || !prepared.config.args?.[0]) throw new Error('The prepared GitHub runtime entry is missing.');
    requiredFiles.push(path.resolve(prepared.config.rootPath, prepared.config.args[0]));
    const sourceRoot = absolute(entry.sourceRootPath)
      ? entry.sourceRootPath
      : pathApi(plan.sourceWorkspaceRoot).resolve(plan.sourceWorkspaceRoot, entry.sourceRootPath);
    mappings.unshift([sourceRoot, prepared.config.rootPath]);
    config.command = 'node';
    config.rootPath = prepared.config.rootPath;
    config.cwd = prepared.config.rootPath;
    config.args = (config.args ?? []).map(arg => mapPath(arg, mappings));
  } else if (entry.kind === 'registry' || entry.kind === 'package-runner') {
    if (config.transport !== 'stdio' || !runner(config)) throw new Error('Unsupported package runner.');
    if (entry.kind === 'registry') {
      const ref = entry.installOrigin?.ref;
      if (!ref) throw new Error('Missing Registry installation recipe.');
      const prepared = await prepareRegistryServerRuntime(ref,
        Object.fromEntries(Object.entries(config.env ?? {}).map(([name, raw]) => [name, typeof raw === 'string' ? raw : raw.value])),
        { preferredTransport: 'stdio' });
      if (!prepared.config || prepared.config.transport !== 'stdio') throw new Error('Registry runtime preparation failed.');
    }
    // Keep the exact original package/version and custom static args; only the host launcher moves.
    config.command = runner(config)!;
    config.args = (config.args ?? []).map(arg => mapPath(arg, mappings));
    const key = createHash('sha256').update(config.name).digest('hex').slice(0, 24);
    config.rootPath = path.join(targetWorkspaceRoot, 'mcp-servers', key);
    config.cwd = path.join(targetWorkspaceRoot, 'userdata', 'mcp-package-cwd', key);
    await fs.mkdir(config.rootPath, { recursive: true });
    await fs.mkdir(config.cwd, { recursive: true });
  } else {
    // Full remote transport settings, headers and OAuth state remain untouched.
    config.rootPath = path.join(targetWorkspaceRoot, 'mcp-servers', createHash('sha256').update(config.name).digest('hex').slice(0, 24));
    await fs.mkdir(config.rootPath, { recursive: true });
  }
  config.env = mapEnvironment(config.env ?? {}, mappings);
  config.roots = (config.roots ?? []).map(root => mapPath(root, mappings));
  return { config, requiredFiles };
}

/** Rebuild runtime dependencies in the restored workspace without reinstalling its entities. */
export async function reinstallWorkspaceMcpServers(plan: WorkspaceMcpTransferPlan): Promise<WorkspaceMcpReinstallResult> {
  const kinds = new Set(['bundled', 'github', 'registry', 'remote', 'package-runner', 'disabled']);
  if (plan?.formatVersion !== 1 || !Array.isArray(plan.servers)
    || typeof plan.sourceWorkspaceRoot !== 'string' || !absolute(plan.sourceWorkspaceRoot)
    || plan.servers.some(entry => !entry || typeof entry.name !== 'string' || !entry.name
      || typeof entry.sourceRootPath !== 'string' || !kinds.has(entry.kind))
    || new Set(plan.servers.map(entry => entry.name)).size !== plan.servers.length) {
    throw new Error('Unsupported MCP workspace transfer plan.');
  }
  const loaded = await mcpService.loadServerConfigs();
  if (!Array.isArray(loaded)) throw new Error('Could not load restored MCP server configurations.');
  const byName = new Map(loaded.map(config => [config.name, config]));
  if (byName.size !== plan.servers.length || plan.servers.some(entry => !byName.has(entry.name))) {
    throw new Error('The MCP transfer plan does not match the restored server configurations.');
  }
  const results: WorkspaceMcpReinstallResult['servers'] = [];
  for (const entry of plan.servers) {
    try {
      const original = byName.get(entry.name);
      if (!original) throw new Error('The restored MCP configuration is missing.');
      if (entry.kind === 'disabled') {
        if (!original.disabled) throw new Error('An unsupported server became enabled after export.');
        results.push({ name: entry.name, status: 'disabled' });
        continue;
      }
      const prepared = await existingRuntime(entry, original, plan) ?? await prepareConfig(entry, original, plan);
      const { config } = prepared;
      const saved = await mcpService.updateServerConfig(entry.name, config);
      if ('success' in saved && !saved.success) throw new Error('Could not save the restored MCP configuration.');
      // A completed build is durable even if its first handshake fails. Retry
      // connection independently so a transient server failure cannot replay installs.
      await recordPreparedRuntime(entry, prepared, plan);
      if (!config.disabled) {
        const connected = await mcpService.connectServer(entry.name);
        if (!connected.success) throw new Error('MCP connection failed; inspect this server in the worker.');
      }
      results.push({ name: entry.name, status: config.disabled ? 'disabled' : 'ready' });
    } catch (error) {
      results.push({ name: entry.name, status: 'failed', error: error instanceof Error ? error.message : 'MCP runtime preparation failed.' });
    }
  }
  return { ok: results.every(result => result.status !== 'failed'), servers: results };
}
