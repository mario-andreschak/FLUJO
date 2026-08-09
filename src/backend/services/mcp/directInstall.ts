/**
 * Resolve and install a caller-supplied MCP server source.
 *
 * Registry installs remain in registryInstall.ts. This module closes the other
 * headless-install gaps: a GitHub repository, a hosted MCP endpoint, a local
 * command, an official server.json document, or a FLUJO/Claude-style config.
 * Resolution is deliberately separate from execution so the authoring tool can
 * audit and consent-gate the exact plan before anything is spawned.
 */
import { mcpService } from '@/backend/services/mcp';
import path from 'path';
import {
  githubInstallRepositoryPath,
  installGithubServer,
  parseGithubRepositoryReference,
} from '@/backend/services/mcp/githubInstall';
import type { EnvVarValue, MCPServerConfig } from '@/shared/types/mcp';
import {
  applySpotlightEnvDefaults,
  buildConfigFromOption,
  getInstallOptions,
  isAutoInstallable,
  missingRequiredInputs,
  resolvedPlanFrom,
  sanitizeServerName,
  type InstallOption,
  type RegistryServer,
  type ResolvedInstallPlan,
} from '@/utils/mcp/registry';

export type DirectInstallKind = 'github' | 'remote' | 'command' | 'server-json' | 'config';

export interface DirectInstallInput {
  source: unknown;
  serverName?: string;
  transport?: 'stdio' | 'streamable' | 'sse' | 'websocket';
  env?: Record<string, string>;
  headers?: Record<string, string>;
  ref?: string;
  subdirectory?: string;
  installCommand?: string;
  buildCommand?: string;
}

export interface ResolvedDirectInstall {
  kind: DirectInstallKind;
  plan: ResolvedInstallPlan;
  config?: Partial<MCPServerConfig>;
  github?: {
    repositoryUrl: string;
    ref?: string;
    subdirectory?: string;
    installCommand?: string;
    buildCommand?: string;
  };
  missingInputs: string[];
}

export interface DirectInstallResult {
  installed: boolean;
  serverName?: string;
  tools?: Array<{ name: string; description?: string }>;
  alreadyExisted?: boolean;
  needsEnv?: string[];
  plan?: ResolvedInstallPlan;
  worksGateRejected?: boolean;
  error?: string;
}

const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const LOCAL_COMMANDS = new Set([
  'npx', 'npm', 'node', 'uvx', 'python', 'python3', 'pipx', 'docker', 'dnx', 'bun', 'bunx', 'deno',
  'cargo', 'go', 'java', 'dotnet', 'ruby',
]);
const GITHUB_API_TIMEOUT_MS = 15_000;

interface GithubPackageJson {
  main?: string;
  bin?: string | Record<string, string>;
  packageManager?: string;
  scripts?: Record<string, string>;
}

interface GithubExecutionPreview {
  commit: string;
  installCommand: string;
  buildCommand: string;
  entry: string;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringRecord(value: unknown): Record<string, string> {
  const record = objectRecord(value);
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record).flatMap(([name, item]) => typeof item === 'string' ? [[name, item]] : []),
  );
}

function envValue(value: EnvVarValue | undefined): string {
  return typeof value === 'string' ? value : value?.value ?? '';
}

function normalizedName(value: string | undefined, fallback: string): string {
  const name = value?.trim() || sanitizeServerName(fallback).slice(0, 64);
  if (!SERVER_NAME.test(name)) {
    throw new Error('The server name must be 1-64 characters and use only letters, numbers, hyphens, or underscores.');
  }
  return name;
}

function parseJsonString(value: string): unknown | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error('The MCP server JSON is not valid JSON.');
  }
}

function assertSupportedCommand(command: string): void {
  const basename = command.replace(/\\/g, '/').split('/').pop()?.replace(/\.exe$/i, '').toLowerCase() ?? '';
  if (!LOCAL_COMMANDS.has(basename)) {
    throw new Error(
      `Unsupported direct MCP command "${command}". Use a standard package/runtime launcher such as npx, node, uvx, Python, Docker, Bun, Deno, Java, .NET, Cargo, or Go.`,
    );
  }
}

/** Split a display command into argv without ever invoking a shell. */
export function parseMcpCommandLine(value: string): { command: string; args: string[] } {
  if (!value.trim() || value.length > 16_384 || /[\0\r\n]/.test(value)) {
    throw new Error('The MCP command is empty or invalid.');
  }
  const tokens: string[] = [];
  let token = '';
  let quote: '"' | "'" | '' = '';
  let escaping = false;
  for (const char of value.trim()) {
    if (escaping) {
      token += char;
      escaping = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      else token += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (token) {
        tokens.push(token);
        token = '';
      }
      continue;
    }
    // These are shell operators, not argv. Reject them rather than giving a
    // misleading preview; the process is spawned directly without a shell.
    if (';&|<>'.includes(char)) throw new Error('Shell operators are not supported in MCP commands; pass one executable and its arguments.');
    token += char;
  }
  if (escaping || quote) throw new Error('The MCP command contains an unfinished escape or quote.');
  if (token) tokens.push(token);
  const [command = '', ...args] = tokens;
  assertSupportedCommand(command);
  return { command, args };
}

function githubUrl(value: string): boolean {
  const candidate = value.startsWith('github:') ? value.slice('github:'.length) : value;
  try {
    const url = new URL(candidate);
    return /(^|\.)github\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

function githubCoordinates(repositoryUrl: string): { owner: string; repo: string } {
  const parsed = new URL(repositoryUrl);
  const parts = parsed.pathname.replace(/\.git$/i, '').split('/').filter(Boolean);
  if (parts.length !== 2) throw new Error('GitHub installation requires a repository-root URL such as https://github.com/owner/repo.');
  return { owner: parts[0], repo: parts[1] };
}

async function githubApiJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GITHUB_API_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'FLUJO-MCP-installer' },
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`GitHub returned ${response.status}.`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function githubEntry(packageJson: GithubPackageJson): string {
  const bin = typeof packageJson.bin === 'string'
    ? packageJson.bin
    : packageJson.bin ? Object.values(packageJson.bin)[0] : undefined;
  if (bin) return bin;
  if (packageJson.main) return packageJson.main;
  const start = packageJson.scripts?.start;
  return start?.match(/(?:^|\s)node\s+["']?([^"'\s]+)["']?/)?.[1] || 'dist/index.js';
}

async function previewGithubExecution(
  repositoryUrl: string,
  ref: string | undefined,
  subdirectory: string | undefined,
  installOverride: string | undefined,
  buildOverride: string | undefined,
): Promise<GithubExecutionPreview> {
  const { owner, repo } = githubCoordinates(repositoryUrl);
  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const commitBody = objectRecord(await githubApiJson(`${base}/commits/${encodeURIComponent(ref || 'HEAD')}`));
  const commit = typeof commitBody?.sha === 'string' ? commitBody.sha : '';
  if (!/^[a-f0-9]{40}$/i.test(commit)) throw new Error('GitHub did not return an immutable commit for this repository.');
  const directory = (subdirectory ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (directory.split('/').some((part) => part === '..')) throw new Error('GitHub subdirectory must stay inside the repository.');
  const packagePath = [directory, 'package.json'].filter(Boolean).map(encodeURIComponent).join('/');
  const packageBody = objectRecord(await githubApiJson(`${base}/contents/${packagePath}?ref=${encodeURIComponent(commit)}`));
  const encoded = typeof packageBody?.content === 'string' ? packageBody.content.replace(/\s/g, '') : '';
  if (!encoded) throw new Error('GitHub package install requires a readable package.json in the selected directory.');
  let packageJson: GithubPackageJson;
  try {
    packageJson = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as GithubPackageJson;
  } catch {
    throw new Error('The GitHub repository package.json is invalid.');
  }
  const contentsPath = directory ? `/contents/${directory.split('/').map(encodeURIComponent).join('/')}` : '/contents';
  const contents = await githubApiJson(`${base}${contentsPath}?ref=${encodeURIComponent(commit)}`).catch(() => []);
  const names = new Set(Array.isArray(contents)
    ? contents.flatMap((item) => typeof objectRecord(item)?.name === 'string' ? [String(objectRecord(item)?.name)] : [])
    : []);
  const declared = packageJson.packageManager?.split('@')[0];
  const manager = declared === 'pnpm' || declared === 'yarn' || declared === 'bun' || declared === 'npm'
    ? declared
    : names.has('pnpm-lock.yaml') ? 'pnpm'
      : names.has('yarn.lock') ? 'yarn'
        : names.has('bun.lock') || names.has('bun.lockb') ? 'bun' : 'npm';
  const installCommand = installOverride !== undefined
    ? installOverride.trim()
    : manager === 'npm' ? 'npm install --include=dev' : `${manager} install`;
  const buildScript = ['build', 'compile', 'dist'].find((name) => Boolean(packageJson.scripts?.[name]));
  const buildCommand = buildOverride !== undefined
    ? buildOverride.trim()
    : !buildScript ? '' : manager === 'yarn' ? `yarn ${buildScript}` : `${manager} run ${buildScript}`;
  return { commit, installCommand, buildCommand, entry: githubEntry(packageJson) };
}

function remoteUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function commandLike(value: string): boolean {
  const first = value.trim().match(/^([^\s]+)/)?.[1]?.replace(/^['"]|['"]$/g, '') ?? '';
  const basename = first.replace(/\\/g, '/').split('/').pop()?.replace(/\.exe$/i, '').toLowerCase() ?? '';
  return LOCAL_COMMANDS.has(basename);
}

function configFromContainer(raw: Record<string, unknown>, requestedName?: string): { config: Record<string, unknown>; name?: string } {
  // Claude Desktop uses `mcpServers`; VS Code uses `servers`.
  const servers = objectRecord(raw.mcpServers) ?? objectRecord(raw.servers);
  if (!servers) return { config: raw, name: requestedName };
  const entries = Object.entries(servers).filter((entry): entry is [string, Record<string, unknown>] => Boolean(objectRecord(entry[1])))
    .map(([name, value]) => [name, objectRecord(value)!] as const);
  const selected = requestedName
    ? entries.find(([name]) => name === requestedName)
    : entries.length === 1 ? entries[0] : undefined;
  if (!selected) {
    throw new Error(requestedName
      ? `The MCP config has no server named "${requestedName}".`
      : 'The MCP config contains multiple servers; pass serverName to select one.');
  }
  return { config: selected[1], name: selected[0] };
}

function normalizeConfig(
  rawValue: Record<string, unknown>,
  input: DirectInstallInput,
  fallbackName: string,
): Partial<MCPServerConfig> {
  const selected = configFromContainer(rawValue, input.serverName);
  const raw = selected.config;
  const name = normalizedName(input.serverName ?? selected.name ?? (typeof raw.name === 'string' ? raw.name : undefined), fallbackName);
  const declaredTransport = typeof raw.transport === 'string'
    ? raw.transport
    : typeof raw.type === 'string' ? raw.type : undefined;
  const rawTransport = input.transport
    ?? (declaredTransport === 'http' || declaredTransport === 'streamable-http'
      ? 'streamable'
      : declaredTransport === 'ws' ? 'websocket' : declaredTransport);
  const url = typeof raw.serverUrl === 'string'
    ? raw.serverUrl
    : typeof raw.url === 'string' ? raw.url
      : typeof raw.websocketUrl === 'string' ? raw.websocketUrl : undefined;
  const transport = rawTransport ?? (url?.startsWith('ws') ? 'websocket' : url ? 'streamable' : 'stdio');
  const common = {
    name,
    disabled: false,
    autoApprove: [],
    env: { ...stringRecord(raw.env), ...(input.env ?? {}) },
    _buildCommand: '',
    _installCommand: '',
    rootPath: typeof raw.rootPath === 'string' && raw.rootPath.trim() ? raw.rootPath : transport === 'stdio' ? '.' : `mcp-servers/${name}`,
  };
  if (transport === 'stdio') {
    const command = typeof raw.command === 'string' ? raw.command.trim() : '';
    if (!command || /[\0\r\n]/.test(command)) throw new Error('A stdio MCP config requires one executable in command.');
    assertSupportedCommand(command);
    const args = raw.args === undefined ? [] : raw.args;
    if (!Array.isArray(args) || args.some((item) => typeof item !== 'string' || /[\0\r\n]/.test(item))) {
      throw new Error('MCP config args must be an array of strings.');
    }
    return { ...common, transport, command, args, source: { type: 'local' } } as Partial<MCPServerConfig>;
  }
  if (transport === 'streamable' || transport === 'sse') {
    const parsed = remoteUrl(url ?? '');
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${transport} MCP config requires an http(s) serverUrl.`);
    return {
      ...common,
      transport,
      serverUrl: parsed.toString(),
      headers: { ...stringRecord(raw.headers), ...(input.headers ?? {}) },
      source: { type: 'remote' },
    } as Partial<MCPServerConfig>;
  }
  if (transport === 'websocket') {
    const parsed = remoteUrl(url ?? '');
    if (!parsed || !['ws:', 'wss:'].includes(parsed.protocol)) throw new Error('A websocket MCP config requires a ws(s) websocketUrl.');
    return { ...common, transport, websocketUrl: parsed.toString(), source: { type: 'remote' } } as Partial<MCPServerConfig>;
  }
  throw new Error(`Unsupported MCP transport "${String(transport)}".`);
}

function planFromConfig(kind: DirectInstallKind, reference: string, config: Partial<MCPServerConfig>): ResolvedInstallPlan {
  const loose = config as Partial<MCPServerConfig> & { command?: string; args?: string[]; serverUrl?: string; websocketUrl?: string };
  const transport = config.transport === 'sse'
    ? 'sse'
    : config.transport === 'stdio'
      ? 'stdio'
      : config.transport === 'websocket' ? 'websocket' : 'streamable';
  const requiredEnvNames = Array.from(new Set([
    ...Object.keys(config.env ?? {}),
    ...Object.keys('headers' in config ? (config.headers ?? {}) : {}),
  ])).sort();
  return {
    registryName: `${kind}:${reference}`,
    resolvedName: reference,
    serverName: String(config.name),
    transport,
    ...(loose.command ? { command: loose.command } : {}),
    ...(Array.isArray(loose.args) ? { args: loose.args } : {}),
    ...(loose.serverUrl || loose.websocketUrl ? { serverUrl: loose.serverUrl ?? loose.websocketUrl } : {}),
    requiredEnvNames,
    verificationStatus: 'unverified-direct-source',
  };
}

function assertSecretsOutsidePlan(plan: ResolvedInstallPlan, input: DirectInstallInput): void {
  const serialized = JSON.stringify(plan);
  const suppliedValues = [...Object.values(input.env ?? {}), ...Object.values(input.headers ?? {})]
    .filter((value) => value.length >= 4 && !value.startsWith('${global:'));
  if (suppliedValues.some((value) => serialized.includes(value))) {
    throw new Error('Credential values must be passed only through env or headers, never embedded in a command, argument, URL, or install/build command.');
  }
}

function registryServerFrom(value: Record<string, unknown>): RegistryServer | null {
  const wrapped = objectRecord(value.server);
  const raw = wrapped ?? value;
  if (typeof raw.name !== 'string' || (!Array.isArray(raw.packages) && !Array.isArray(raw.remotes))) return null;
  return raw as unknown as RegistryServer;
}

function chooseServerJsonOption(server: RegistryServer, preferred?: DirectInstallInput['transport']): InstallOption {
  if (preferred === 'websocket') throw new Error('Official server.json does not define websocket install options.');
  const options = getInstallOptions(server).filter(isAutoInstallable);
  const desired = preferred === 'streamable' || preferred === 'sse' ? preferred : preferred === 'stdio' ? 'stdio' : undefined;
  const selected = desired
    ? options.find((option) => option.kind === 'package'
      ? desired === 'stdio'
      : option.kind === 'remote' && (option.remote.type === 'sse' ? 'sse' : 'streamable') === desired)
    : options[0];
  if (!selected) throw new Error('This server.json has no FLUJO-supported stdio package or hosted HTTP endpoint.');
  return selected;
}

export function looksLikeRegistryName(source: unknown): source is string {
  if (typeof source !== 'string') return false;
  const value = source.trim();
  return Boolean(value) && !/\s/.test(value)
    && parseJsonString(value) === undefined && !githubUrl(value) && !remoteUrl(value) && !commandLike(value);
}

/** Resolve a non-Registry source without saving, cloning, downloading, or spawning. */
export async function resolveDirectMcpInstall(input: DirectInstallInput): Promise<ResolvedDirectInstall> {
  let source = input.source;
  if (typeof source === 'string') source = parseJsonString(source) ?? source.trim();

  if (typeof source === 'string' && githubUrl(source)) {
    if (input.transport && input.transport !== 'stdio') throw new Error('A GitHub repository source installs as a local stdio MCP server.');
    const parsed = parseGithubRepositoryReference(source.replace(/^github:/, ''), input.ref);
    const fallback = parsed.repositoryUrl.replace(/\.git$/i, '').split('/').filter(Boolean).pop() || 'github-mcp';
    const serverName = normalizedName(input.serverName, fallback);
    const execution = await previewGithubExecution(
      parsed.repositoryUrl,
      parsed.ref,
      input.subdirectory,
      input.installCommand,
      input.buildCommand,
    );
    const repositoryPath = githubInstallRepositoryPath(parsed.repositoryUrl, execution.commit);
    const workingDirectory = input.subdirectory
      ? path.join(repositoryPath, input.subdirectory.replace(/\\/g, '/'))
      : repositoryPath;
    const command = 'git';
    const args = ['clone', '--depth', '1', parsed.repositoryUrl, repositoryPath];
    const steps: NonNullable<ResolvedInstallPlan['steps']> = [
      { label: 'clone', command: 'git', args },
      { label: 'pin-commit', command: 'git', args: ['fetch', '--depth=1', 'origin', execution.commit], cwd: repositoryPath },
      { label: 'checkout', command: 'git', args: ['checkout', '--detach', 'FETCH_HEAD'], cwd: repositoryPath },
      ...(execution.installCommand ? [{ label: 'install-dependencies', command: 'shell', args: [execution.installCommand], cwd: workingDirectory }] : []),
      ...(execution.buildCommand ? [{ label: 'build', command: 'shell', args: [execution.buildCommand], cwd: workingDirectory }] : []),
      { label: 'launch', command: 'node', args: [execution.entry], cwd: workingDirectory },
    ];
    const resolved: ResolvedDirectInstall = {
      kind: 'github',
      plan: {
        registryName: `github:${parsed.repositoryUrl}${parsed.ref ? `@${parsed.ref}` : ''}`,
        resolvedName: parsed.repositoryUrl,
        serverName,
        transport: 'stdio',
        command,
        args,
        steps,
        requiredEnvNames: Object.keys(input.env ?? {}).sort(),
        verificationStatus: 'unverified-github-source',
      },
      github: {
        repositoryUrl: parsed.repositoryUrl,
        ref: execution.commit,
        ...(input.subdirectory ? { subdirectory: input.subdirectory } : {}),
        installCommand: execution.installCommand,
        buildCommand: execution.buildCommand,
      },
      missingInputs: [],
    };
    assertSecretsOutsidePlan(resolved.plan, input);
    return resolved;
  }

  if (typeof source === 'string' && commandLike(source)) {
    const parsed = parseMcpCommandLine(source);
    const fallback = parsed.args.find((arg) => !arg.startsWith('-')) ?? parsed.command;
    const config = normalizeConfig({ command: parsed.command, args: parsed.args, env: input.env ?? {} }, input, fallback);
    const plan = planFromConfig('command', source, config);
    assertSecretsOutsidePlan(plan, input);
    return { kind: 'command', plan, config, missingInputs: [] };
  }

  if (typeof source === 'string') {
    const url = remoteUrl(source);
    if (url) {
      const transport = input.transport ?? (url.protocol.startsWith('ws') ? 'websocket' : 'streamable');
      const config = normalizeConfig({ serverUrl: source, transport }, input, url.hostname || 'remote-mcp');
      const plan = planFromConfig('remote', url.toString(), config);
      assertSecretsOutsidePlan(plan, input);
      return { kind: 'remote', plan, config, missingInputs: [] };
    }
  }

  const raw = objectRecord(source);
  if (!raw) throw new Error('Pass a Registry name, GitHub URL, remote URL, command, server.json, or MCP server config.');
  const server = registryServerFrom(raw);
  if (server) {
    const option = chooseServerJsonOption(server, input.transport);
    let config = buildConfigFromOption(server, option);
    if (config.transport === 'stdio') assertSupportedCommand(String(config.command ?? ''));
    const serverName = normalizedName(input.serverName, server.name);
    config = applySpotlightEnvDefaults({ ...config, name: serverName }, input.env);
    if (option.kind === 'remote' && input.headers) {
      config = { ...config, headers: { ...('headers' in config ? config.headers ?? {} : {}), ...input.headers } } as Partial<MCPServerConfig>;
    }
    const supplied = { ...(input.env ?? {}), ...(input.headers ?? {}) };
    const missingInputs = missingRequiredInputs(option, supplied);
    const plan = { ...resolvedPlanFrom(server.name, server, option, 'unverified-direct-server-json'), serverName };
    assertSecretsOutsidePlan(plan, input);
    return { kind: 'server-json', plan, config, missingInputs };
  }

  const config = normalizeConfig(raw, input, 'mcp-server');
  const plan = planFromConfig('config', String(config.name), config);
  assertSecretsOutsidePlan(plan, input);
  return { kind: 'config', plan, config, missingInputs: [] };
}

async function existingServer(name: string): Promise<DirectInstallResult | null> {
  const configs = await mcpService.loadServerConfigs();
  if (!Array.isArray(configs)) return { installed: false, error: configs.error ?? 'Could not load MCP server configs.' };
  if (!configs.some((config) => config.name === name)) return null;
  const { tools, error } = await mcpService.listServerTools(name);
  return {
    installed: true,
    alreadyExisted: true,
    serverName: name,
    tools: (tools ?? []).map((tool) => ({ name: tool.name, ...(tool.description ? { description: tool.description } : {}) })),
    ...(error ? { error } : {}),
  };
}

/** Execute an already-resolved direct source and require at least one MCP tool. */
export async function installResolvedDirectMcp(
  resolved: ResolvedDirectInstall,
  input: DirectInstallInput,
): Promise<DirectInstallResult> {
  if (resolved.missingInputs.length > 0) {
    return {
      installed: false,
      needsEnv: resolved.missingInputs,
      plan: resolved.plan,
      error: `This MCP server requires values for: ${resolved.missingInputs.join(', ')}`,
    };
  }
  const existing = await existingServer(resolved.plan.serverName);
  if (existing) return { ...existing, plan: resolved.plan };

  if (resolved.kind === 'github' && resolved.github) {
    const result = await installGithubServer({
      name: resolved.plan.serverName,
      repositoryUrl: resolved.github.repositoryUrl,
      env: input.env ?? {},
      ...(resolved.github.ref ? { ref: resolved.github.ref } : {}),
      ...(resolved.github.subdirectory ? { subdirectory: resolved.github.subdirectory } : {}),
      ...(resolved.github.installCommand !== undefined ? { installCommand: resolved.github.installCommand } : {}),
      ...(resolved.github.buildCommand !== undefined ? { buildCommand: resolved.github.buildCommand } : {}),
    });
    if (!result.installed) return { ...result, plan: resolved.plan };
  } else {
    const saved = await mcpService.updateServerConfig(resolved.plan.serverName, resolved.config ?? {});
    if (!Array.isArray(saved) && saved && 'success' in saved && saved.success === false) {
      return { installed: false, plan: resolved.plan, error: saved.error ?? 'Saving the MCP server failed.' };
    }
  }

  const { tools, error } = await mcpService.listServerTools(resolved.plan.serverName);
  const toolList = (tools ?? []).map((tool) => ({ name: tool.name, ...(tool.description ? { description: tool.description } : {}) }));
  if (toolList.length === 0) {
    await mcpService.deleteServerConfig(resolved.plan.serverName).catch(() => undefined);
    return {
      installed: false,
      worksGateRejected: true,
      serverName: resolved.plan.serverName,
      plan: resolved.plan,
      error: error
        ? `The MCP server failed to start: ${error}`
        : 'The MCP server connected but exposed no tools; the new config was rolled back.',
    };
  }
  return {
    installed: true,
    serverName: resolved.plan.serverName,
    plan: resolved.plan,
    tools: toolList,
    ...(error ? { error } : {}),
  };
}
