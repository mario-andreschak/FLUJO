import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Flow } from '@/shared/types/flow';
import type { Model } from '@/shared/types/model';
import type {
  EnvVarValue, MCPServerConfig, MCPSSEConfig, MCPStdioConfig, MCPStreamableConfig, MCPWebSocketConfig,
} from '@/shared/types/mcp';
import { StorageKey } from '@/shared/types/storage';
import { collectFlowReferences } from '@/shared/types/package/package.serialize';
import { stepModelIds } from '@/utils/shared/flowModelBoundary';
import { ensureWorkspaceDirs, getCurrentWorkspace, getWorkspaceDataDir, runWithWorkspace } from '@/utils/workspace';
import { loadItem } from '@/utils/storage/backend';
import { flowService } from '@/backend/services/flow';
import { modelService } from '@/backend/services/model';
import { mcpService } from '@/backend/services/mcp';
import { appendAudit } from '@/backend/services/accounts/store';
import { recordChange, type SharedEditor } from './guard';
import type { SharedItemKind } from './kinds';
import { loadSharedItem } from './load';
import { isEncryptedValue, isGlobalReference, isSecretKey } from './secrets';

/**
 * Copy a flow, model or MCP server from the selected workspace into another
 * one, usually a team workspace (#575, step 575-4).
 *
 * A copy never carries keys, tokens, passwords, sign-in state, encrypted
 * values or private folders. Every field of today's types is sorted into one
 * of three groups below, and the compiler refuses a new field until someone
 * decides which group it belongs to:
 *
 * - `copy`: copied as it is (plain settings).
 * - `scrub`: copied after every secret value inside it is removed. Each
 *   removed value is listed, so the person enters the team's own value.
 * - `drop`: never copied (secrets as a whole, sign-in state, server folders,
 *   host grants and runtime-only objects).
 *
 * `${global:NAME}` references are kept: they name a workspace variable, not a
 * secret. When the target workspace lacks that variable it is listed too.
 */

export type FieldRule = 'copy' | 'scrub' | 'drop';

export const MODEL_FIELDS = {
  id: 'copy',
  name: 'copy',
  displayName: 'copy',
  description: 'copy',
  /** Only a `${global:…}` reference survives; a stored key never does. */
  ApiKey: 'scrub',
  /** The base URL keeps no user name, password or secret query value. */
  baseUrl: 'scrub',
  azureApiVersion: 'copy',
  provider: 'copy',
  adapter: 'copy',
  promptTemplate: 'copy',
  reasoningSchema: 'copy',
  temperature: 'copy',
  reasoningEffort: 'copy',
  thinkingLevel: 'copy',
  thinkingBudget: 'copy',
  serviceTier: 'copy',
  functionCallingSchema: 'copy',
  contextWindow: 'copy',
  supportsTools: 'copy',
  supportedParameters: 'copy',
  inputModalities: 'copy',
  outputModalities: 'copy',
  visionInputCapability: 'copy',
  maxTurns: 'copy',
  maxTokens: 'copy',
  compactionThreshold: 'copy',
  compactionThresholdPercent: 'copy',
  folder: 'copy',
  favorite: 'copy',
  /** Its members must already exist in the target workspace. */
  fallbackPolicy: 'copy',
  /** A reference to the copying person's own credential: never shared. */
  ownerCredentialBinding: 'drop',
} as const satisfies Record<keyof Required<Model>, FieldRule>;

type McpFieldName =
  | keyof Required<MCPStdioConfig> | keyof Required<MCPSSEConfig>
  | keyof Required<MCPStreamableConfig> | keyof Required<MCPWebSocketConfig>;

export const MCP_FIELDS = {
  name: 'copy',
  transport: 'copy',
  /** Always copied as `true`: nothing starts before the team enters its own values. */
  disabled: 'copy',
  rootPath: 'drop',
  env: 'scrub',
  _buildCommand: 'copy',
  _installCommand: 'copy',
  source: 'copy',
  icons: 'copy',
  hostPathAccess: 'drop',
  exposeAsMcpServer: 'drop',
  alwaysOn: 'copy',
  enableMcpApps: 'copy',
  enableMcpSkills: 'copy',
  folder: 'copy',
  favorite: 'copy',
  roots: 'drop',
  sampling: 'copy',
  elicitation: 'copy',
  maxConcurrency: 'copy',
  toolParameterPresets: 'scrub',
  runtimeHomeMode: 'drop',
  isolation: 'drop',
  trustedHost: 'drop',
  command: 'scrub',
  args: 'scrub',
  cwd: 'drop',
  stderr: 'drop',
  maxBufferSize: 'copy',
  redirectPolicy: 'copy',
  serverUrl: 'scrub',
  websocketUrl: 'scrub',
  headers: 'scrub',
  launch: 'scrub',
  authProvider: 'drop',
  eventSourceInit: 'drop',
  requestInit: 'drop',
  fetch: 'drop',
  reconnectionOptions: 'copy',
  sessionId: 'drop',
  oauthClientId: 'copy',
  oauthClientSecret: 'scrub',
  oauthIssuer: 'copy',
  oauthScopes: 'copy',
  oauthClientMetadata: 'copy',
  oauthClientInformation: 'drop',
  oauthTokens: 'drop',
  oauthCodeVerifier: 'drop',
  oauthState: 'drop',
  oauthStateWorkspace: 'drop',
  oauthStateCreatedAt: 'drop',
  oauthStateDiscovery: 'drop',
  authorizationUrl: 'drop',
} as const satisfies Record<McpFieldName, FieldRule>;

export const FLOW_FIELDS = {
  id: 'copy',
  name: 'copy',
  description: 'copy',
  folder: 'copy',
  favorite: 'copy',
  allowedModels: 'copy',
  behaviorRules: 'scrub',
  nodes: 'scrub',
  edges: 'copy',
  input: 'copy',
  /** Server-stamped; the target stamps its own. */
  createdAt: 'drop',
  updatedAt: 'drop',
  /** Belongs to a Persona in the source workspace. */
  personaOwnership: 'drop',
  /** A frozen Persona closure tied to the source workspace. */
  executionDependencies: 'drop',
} as const satisfies Record<keyof Required<Flow>, FieldRule>;

export interface MissingValue {
  /** Where the value was, in words: "Environment variable GITHUB_TOKEN". */
  readonly field: string;
  /** What to do about it. */
  readonly hint: string;
}

export interface MissingDependency {
  readonly kind: SharedItemKind;
  readonly id: string;
  readonly name: string;
}

export interface TeamCopyResult {
  readonly copied: { readonly kind: SharedItemKind; readonly id: string; readonly name: string };
  readonly targetWorkspace: string;
  readonly missingValues: readonly MissingValue[];
  readonly missingDependencies: readonly MissingDependency[];
}

export class TeamCopyError extends Error {
  readonly status: number;
  readonly code: string;
  readonly missingDependencies: readonly MissingDependency[];
  constructor(message: string, status = 400, code = 'TEAM_COPY_FAILED', missingDependencies: readonly MissingDependency[] = []) {
    super(message);
    this.name = 'TeamCopyError';
    this.status = status;
    this.code = code;
    this.missingDependencies = missingDependencies;
  }
}

const ENTER_VALUE = 'Not copied, because it may be secret. Enter the team\'s own value in the team workspace.';

/** Collects what was left out, once per field. */
class Missing {
  private readonly seen = new Set<string>();
  readonly list: MissingValue[] = [];
  add(field: string, hint = ENTER_VALUE): void {
    if (this.seen.has(field)) return;
    this.seen.add(field);
    this.list.push({ field, hint });
  }
}

function pick<T extends object>(item: T, rules: Readonly<Record<string, FieldRule>>,
  scrub: (key: string, value: unknown) => unknown): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(item)) {
    const rule = rules[key];
    // A field nobody classified yet (for example from an older or newer file) is left out.
    if (rule === undefined || rule === 'drop' || value === undefined) continue;
    const next: unknown = rule === 'copy' ? structuredClone(value) : scrub(key, value);
    if (next !== undefined) Object.assign(out, { [key]: next });
  }
  return out;
}

/** Environment variables and headers: values are secret unless marked `isSecret: false`; `${global:…}` references stay. */
function scrubEnv(record: unknown, label: string, missing: Missing): Record<string, EnvVarValue> | undefined {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return undefined;
  const out: Record<string, EnvVarValue> = {};
  for (const [key, raw] of Object.entries(record as Record<string, unknown>)) {
    const entry = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as { value?: unknown; metadata?: { isSecret?: unknown } } : null;
    const value = entry ? entry.value : raw;
    const text = typeof value === 'string' ? value : '';
    const plain = entry?.metadata?.isSecret === false && !isSecretKey(key) && !isEncryptedValue(text);
    if (plain || isGlobalReference(text)) {
      out[key] = entry ? { value: text, metadata: { isSecret: entry.metadata?.isSecret === true } } : text;
      continue;
    }
    out[key] = { value: '', metadata: { isSecret: true } };
    if (text) missing.add(`${label} ${key}`);
  }
  return out;
}

/** A URL without a user name, password or secret-looking query values. */
function scrubUrl(value: unknown, label: string, missing: Missing): unknown {
  if (typeof value !== 'string' || !value || isGlobalReference(value)) return value;
  if (isEncryptedValue(value)) {
    missing.add(label);
    return '';
  }
  let url: URL;
  try { url = new URL(value); } catch { return value; }
  let changed = false;
  if (url.username || url.password) {
    url.username = '';
    url.password = '';
    changed = true;
  }
  for (const key of [...url.searchParams.keys()]) {
    if (isSecretKey(key) || /^(?:key|sig|signature|code)$/i.test(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  if (!changed) return value;
  missing.add(label, 'Part of this address looked like a password or key and was not copied. Check the address in the team workspace.');
  return url.toString();
}

/** Any JSON: secret-looking fields and encrypted values are emptied; `env`/`headers` records are handled as above. */
function scrubDeep(value: unknown, label: string, missing: Missing, depth = 0): unknown {
  if (depth > 64) return undefined;
  if (isEncryptedValue(value)) {
    missing.add(label);
    return '';
  }
  if (Array.isArray(value)) return value.map(item => scrubDeep(item, label, missing, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'env' || key === 'headers') {
      out[key] = scrubEnv(item, `${label}: ${key === 'env' ? 'environment variable' : 'header'}`, missing);
    } else if (isSecretKey(key)) {
      if (typeof item === 'string') {
        if (item && !isGlobalReference(item)) missing.add(`${label}: ${key}`);
        out[key] = isGlobalReference(item) ? item : '';
      } else if (item && typeof item === 'object') {
        missing.add(`${label}: ${key}`);
      } else {
        out[key] = item;
      }
    } else {
      out[key] = scrubDeep(item, label, missing, depth + 1);
    }
  }
  return out;
}

function insideFolder(candidate: string, folder: string): boolean {
  if (!path.isAbsolute(candidate)) return false;
  const relative = path.relative(path.resolve(folder), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Program arguments: secret flags lose their value; paths inside the source workspace folder are removed. */
function scrubArgs(args: unknown, label: string, sourceFolder: string, missing: Missing): unknown {
  if (!Array.isArray(args)) return args;
  const out: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = typeof args[index] === 'string' ? args[index] as string : String(args[index]);
    const assigned = /^(-{1,2}[^=\s]+)=(.*)$/.exec(arg);
    if (assigned && isSecretKey(assigned[1].replace(/^-+/, '')) && assigned[2] && !isGlobalReference(assigned[2])) {
      out.push(`${assigned[1]}=`);
      missing.add(`${label} ${assigned[1]}`);
      continue;
    }
    if (isEncryptedValue(arg)) {
      out.push('');
      missing.add(label);
      continue;
    }
    if (insideFolder(arg, sourceFolder)) {
      out.push('');
      missing.add(`${label} (a folder in your own workspace)`,
        'This points into your own workspace folder, which the team cannot use. Install the server in the team workspace instead.');
      continue;
    }
    out.push(arg);
    const flag = /^-{1,2}([^=\s]+)$/.exec(arg);
    const next = args[index + 1];
    if (flag && isSecretKey(flag[1]) && typeof next === 'string' && next && !next.startsWith('-') && !isGlobalReference(next)) {
      out.push('');
      missing.add(`${label} ${arg}`);
      index++;
    }
  }
  return out;
}

function scrubCommand(command: unknown, sourceFolder: string, missing: Missing): unknown {
  if (typeof command !== 'string' || !insideFolder(command, sourceFolder)) return command;
  missing.add('Program to start (a folder in your own workspace)',
    'This program lives in your own workspace folder, which the team cannot use. Install the server in the team workspace instead.');
  return '';
}

function globalNames(value: unknown): string[] {
  const names = new Set<string>();
  for (const match of JSON.stringify(value).matchAll(/\$\{global:([^}]+)\}/g)) names.add(match[1]);
  return [...names];
}

function uniqueName(base: string, taken: (candidate: string) => boolean, pattern: (attempt: number) => string): string {
  if (!taken(base)) return base;
  for (let attempt = 1; attempt < 1000; attempt++) {
    const candidate = pattern(attempt);
    if (!taken(candidate)) return candidate;
  }
  return pattern(Date.now());
}

const copyName = (base: string) => (attempt: number) => attempt === 1 ? `${base} (copy)` : `${base} (copy ${attempt})`;
/** Flow names allow only letters, digits, spaces, `_` and `-` (`validateFlowDisplayName`), so no brackets here. */
const flowCopyName = (base: string) => (attempt: number) =>
  `${base.slice(0, 140)} copy${attempt === 1 ? '' : ` ${attempt}`}`;

/** What the target workspace has, read inside it. */
interface TargetCatalog {
  readonly models: readonly Model[];
  readonly servers: readonly MCPServerConfig[];
  readonly flows: readonly Flow[];
  readonly globals: ReadonlySet<string>;
}

async function readTargetCatalog(): Promise<TargetCatalog> {
  const [models, servers, flows, globals] = await Promise.all([
    modelService.loadModels(),
    mcpService.loadServerConfigs(),
    flowService.loadFlows(),
    loadItem<Record<string, unknown>>(StorageKey.GLOBAL_ENV_VARS, {}),
  ]);
  if (!Array.isArray(servers)) throw new TeamCopyError('Could not read the MCP servers of the target workspace. Try again.', 503, 'TEAM_COPY_BUSY');
  return { models, servers, flows: Array.isArray(flows) ? flows : [], globals: new Set(Object.keys(globals ?? {})) };
}

interface References {
  readonly models: string[];
  readonly servers: string[];
  readonly flows: string[];
}

type Prepared = { readonly missing: Missing; readonly refs: References } & (
  | { readonly kind: 'model'; readonly item: Partial<Model> }
  | { readonly kind: 'mcp-server'; readonly item: Partial<MCPServerConfig> }
  | { readonly kind: 'flow'; readonly item: Partial<Flow> }
);

/** Read the source item and build the copy (still in the source workspace). */
async function prepare(kind: SharedItemKind, id: string): Promise<Prepared> {
  const missing = new Missing();
  const sourceFolder = getWorkspaceDataDir();
  if (kind === 'model') {
    const model = (await modelService.loadModels()).find(candidate => candidate.id === id);
    if (!model) throw new TeamCopyError('This model does not exist (any more).', 404, 'NOT_FOUND');
    const item = pick(model, MODEL_FIELDS, (key, value) => {
      if (key === 'ApiKey') {
        if (isGlobalReference(value)) return value;
        if (typeof value === 'string' && value) missing.add('API key', 'Keys are never copied. Enter the team\'s own key in the team workspace.');
        return '';
      }
      return scrubUrl(value, 'Base address', missing);
    });
    if (item.ApiKey === undefined) item.ApiKey = '';
    if (model.ownerCredentialBinding) {
      missing.add('Sign-in of the model', 'This model used your own sign-in. Connect the team\'s own account in the team workspace.');
    }
    const memberIds = model.fallbackPolicy?.modelIds ?? [];
    return { kind, item, missing, refs: { models: [...memberIds], servers: [], flows: [] } };
  }
  if (kind === 'mcp-server') {
    const configs = await mcpService.loadServerConfigs();
    if (!Array.isArray(configs)) throw new TeamCopyError('Could not read the MCP servers. Try again.', 503, 'TEAM_COPY_BUSY');
    const config = configs.find(candidate => candidate.name === id);
    if (!config) throw new TeamCopyError('This MCP server does not exist (any more).', 404, 'NOT_FOUND');
    const item = pick(config, MCP_FIELDS, (key, value) => {
      switch (key) {
        case 'env': return scrubEnv(value, 'Environment variable', missing);
        case 'headers': return scrubEnv(value, 'Header', missing);
        case 'oauthClientSecret':
          if (isGlobalReference(value)) return value;
          if (typeof value === 'string' && value) missing.add('OAuth client secret');
          return undefined;
        case 'command': return scrubCommand(value, sourceFolder, missing);
        case 'args': return scrubArgs(value, 'Program argument', sourceFolder, missing);
        case 'serverUrl':
        case 'websocketUrl': return scrubUrl(value, 'Server address', missing);
        case 'launch': {
          const launch = value && typeof value === 'object' ? { ...(value as Record<string, unknown>) } : null;
          if (!launch) return undefined;
          delete launch.cwd;
          if (launch.env !== undefined) launch.env = scrubEnv(launch.env, 'Start-up environment variable', missing);
          launch.command = scrubCommand(launch.command, sourceFolder, missing);
          if (launch.args !== undefined) launch.args = scrubArgs(launch.args, 'Start-up argument', sourceFolder, missing);
          return launch;
        }
        default: return scrubDeep(value, 'Tool preset', missing);
      }
    });
    item.disabled = true;
    item.rootPath = '';
    if (config.transport === 'streamable' && config.oauthTokens) {
      missing.add('OAuth sign-in', 'The server\'s sign-in is not copied. Sign in again from the team workspace.');
    }
    const samplingModel = config.sampling?.modelId;
    return { kind, item, missing, refs: { models: samplingModel ? [samplingModel] : [], servers: [], flows: [] } };
  }
  const flow = await flowService.getFlow(id);
  if (!flow) throw new TeamCopyError('This flow does not exist (any more).', 404, 'NOT_FOUND');
  const item = pick(flow, FLOW_FIELDS, (key, value) => {
    if (key === 'nodes' && Array.isArray(value)) {
      return value.map((node, index) => {
        const data = (node as { data?: { label?: unknown } })?.data;
        const label = typeof data?.label === 'string' && data.label ? data.label : `Step ${index + 1}`;
        return scrubDeep(node, `Step "${label}"`, missing);
      });
    }
    return scrubDeep(value, 'Rule', missing);
  });
  const references = collectFlowReferences(flow);
  const staticModels = (flow.nodes ?? []).flatMap(node => stepModelIds(node.data?.type ?? node.type, node.data?.properties as Record<string, unknown> | undefined));
  return {
    kind: 'flow', item, missing,
    refs: {
      models: [...new Set([...(references.modelIds ?? []), ...staticModels])],
      servers: references.mcpServerNames ?? [],
      flows: (references.flowIds ?? []).filter(flowId => flowId !== flow.id),
    },
  };
}

/** Names of referenced items, read in the source workspace for the result list. */
async function sourceNames(refs: References): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (refs.models.length) {
    for (const model of await modelService.loadModels()) names.set(`model:${model.id}`, model.displayName || model.name);
  }
  if (refs.flows.length) {
    for (const flowId of refs.flows) {
      const flow = await flowService.getFlow(flowId);
      if (flow) names.set(`flow:${flowId}`, flow.name);
    }
  }
  return names;
}

export interface CopyRequest {
  readonly kind: SharedItemKind;
  readonly id: string;
  readonly targetWorkspace: string;
  /** The person copying. Access to both workspaces was checked by the caller. */
  readonly editor: SharedEditor;
}

/**
 * Copy one item into `targetWorkspace`. Runs from a request in the source
 * workspace; the caller already checked that the person may edit the target.
 */
export async function copySharedItem(request: CopyRequest): Promise<TeamCopyResult> {
  const sourceWorkspace = getCurrentWorkspace();
  if (request.targetWorkspace === sourceWorkspace) {
    throw new TeamCopyError('Choose a different workspace to copy into.', 400, 'SAME_WORKSPACE');
  }
  const prepared = await prepare(request.kind, request.id);
  const names = await sourceNames(prepared.refs);

  return runWithWorkspace(request.targetWorkspace, async () => {
    await ensureWorkspaceDirs(request.targetWorkspace);
    const target = await readTargetCatalog();
    const dependencies: MissingDependency[] = [];
    for (const modelId of prepared.refs.models) {
      if (!target.models.some(model => model.id === modelId)) {
        dependencies.push({ kind: 'model', id: modelId, name: names.get(`model:${modelId}`) ?? modelId });
      }
    }
    for (const server of prepared.refs.servers) {
      if (!target.servers.some(config => config.name === server)) dependencies.push({ kind: 'mcp-server', id: server, name: server });
    }
    for (const flowId of prepared.refs.flows) {
      if (!target.flows.some(flow => flow.id === flowId)) {
        dependencies.push({ kind: 'flow', id: flowId, name: names.get(`flow:${flowId}`) ?? flowId });
      }
    }
    for (const name of globalNames(prepared.item)) {
      if (!target.globals.has(name)) {
        prepared.missing.add(`Workspace variable ${name}`, `Add the variable ${name} in the team workspace, with the team's own value.`);
      }
    }

    let copied: TeamCopyResult['copied'];
    if (prepared.kind === 'model') {
      if (dependencies.length > 0) {
        throw new TeamCopyError('This model picks between other models. Copy those models into the team workspace first.',
          409, 'TEAM_COPY_DEPENDENCIES', dependencies);
      }
      const item = prepared.item;
      const modelId = item.id && !target.models.some(model => model.id === item.id) ? item.id : randomUUID();
      item.id = modelId;
      if (item.displayName) {
        const base = item.displayName;
        item.displayName = uniqueName(base, name => target.models.some(model => model.displayName?.toLowerCase() === name.toLowerCase()), copyName(base));
      }
      const result = await modelService.addModel(item as Model);
      if (!result.success) throw new TeamCopyError(result.error || 'The model could not be copied.', result.code === 'MODEL_CATALOG_BUSY' ? 409 : 400);
      copied = { kind: 'model', id: modelId, name: item.displayName || item.name || modelId };
    } else if (prepared.kind === 'mcp-server') {
      const item = prepared.item;
      const base = item.name || request.id;
      const name = uniqueName(base, candidate => target.servers.some(config => config.name === candidate),
        attempt => attempt === 1 ? `${base}-copy` : `${base}-copy-${attempt}`);
      item.name = name;
      const result = await mcpService.updateServerConfig(name, item);
      if ('error' in result) throw new TeamCopyError(typeof result.error === 'string' ? result.error : 'The MCP server could not be copied.');
      copied = { kind: 'mcp-server', id: name, name };
    } else {
      const item = prepared.item;
      const flowId = item.id && !target.flows.some(flow => flow.id === item.id) ? item.id : randomUUID();
      item.id = flowId;
      const base = item.name || 'Flow';
      const name = uniqueName(base, candidate => target.flows.some(flow => flow.name.trim().toLowerCase() === candidate.trim().toLowerCase()), flowCopyName(base));
      item.name = name;
      const result = await flowService.saveFlow(item as Flow);
      if (!result.success) throw new TeamCopyError(result.error || 'The flow could not be copied.');
      copied = { kind: 'flow', id: flowId, name };
    }

    await recordChange(request.editor, {
      kind: copied.kind, itemId: copied.id, action: 'copied-in', before: null,
      after: await loadSharedItem(copied.kind, copied.id),
      copiedFrom: { workspace: sourceWorkspace, itemId: request.id },
    });
    await appendAudit({
      action: 'item-copied', actorUserId: request.editor.user.id,
      target: { type: 'workspace', id: request.targetWorkspace },
      detail: { kind: copied.kind, from: sourceWorkspace, itemId: copied.id.slice(0, 200) },
    });
    return {
      copied,
      targetWorkspace: request.targetWorkspace,
      missingValues: prepared.missing.list,
      missingDependencies: dependencies,
    };
  });
}
