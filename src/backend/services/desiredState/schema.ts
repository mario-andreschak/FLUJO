/**
 * The desired-state file: what one workspace of an instance should contain.
 *
 * Top-level names follow the package format (`models`, `mcpServers`, `flows`,
 * `plannedExecutions`). This module only reads the file and says, in plain words, why
 * it cannot be used. It touches no storage. Nothing in a valid file is a secret value:
 * credentials appear only as `${env:NAME}` (read from this process's environment when
 * applied) or `${global:NAME}` (already in the secret store).
 */
import { z } from 'zod';
import { detectHeuristicSecrets } from '@/backend/services/packages/secretHeuristics';
import type { ScanTarget } from '@/backend/services/packages/secretScanTargets';
import type { Flow } from '@/shared/types/flow';
import { FlowSnapshotSchema } from '@/shared/types/enduringAgent';
import type { FlowSpec } from '@/utils/shared/flowSpecCompiler';
import { isSecretEnvVar, isSecretHeaderKey } from '@/utils/shared/common';
import { DEFAULT_WORKSPACE, normalizeWorkspaceName } from '@/utils/workspace';

export const DESIRED_STATE_SCHEMA_VERSION = 1;
export const DEFAULT_KEEP_VERSIONS = 5;
/** A rollback needs one earlier version, so fewer than two would make it impossible. */
export const MIN_KEEP_VERSIONS = 2;
export const MAX_KEEP_VERSIONS = 50;

export interface DesiredStatePolicy {
  /** A managed object someone changed by hand: replace it, or leave it and report it. */
  localEdits: 'overwrite' | 'keep';
  /** An object with the same identity that a person created: refuse, or take it over. */
  existingLocalObjects: 'refuse' | 'adopt';
  /** A managed object no longer in the file: delete it, or leave it unmanaged. */
  removedObjects: 'delete' | 'keep';
  /** Text that looks like a secret outside the credential fields: refuse, or only warn. */
  secretScan: 'refuse' | 'warn';
  /** How many applied versions stay available for rollback. */
  keepVersions: number;
}

export const DEFAULT_POLICY: DesiredStatePolicy = {
  localEdits: 'overwrite',
  existingLocalObjects: 'refuse',
  removedObjects: 'delete',
  secretScan: 'refuse',
  keepVersions: DEFAULT_KEEP_VERSIONS,
};

export interface DesiredFlowEntry {
  id: string;
  spec?: FlowSpec;
  flow?: Flow;
  folder?: string;
  /** Conversations freeze the subflows they can reach. On unless switched off. */
  pinSubflows: boolean;
}

export interface ParsedDesiredState {
  schemaVersion: number;
  version: string;
  workspaces: string[];
  policy: DesiredStatePolicy;
  settings: Record<string, Record<string, unknown>>;
  models: Array<Record<string, unknown> & { id: string; name: string }>;
  mcpServers: Array<Record<string, unknown> & { name: string }>;
  flows: DesiredFlowEntry[];
  plannedExecutions: Array<Record<string, unknown> & { id: string; flowId: string }>;
}

export type DesiredStateProblem = { where: string; message: string };

export type ParseResult =
  | { ok: true; state: ParsedDesiredState; warnings: string[] }
  | { ok: false; problems: DesiredStateProblem[] };

const SECRET_REFERENCE = /^\$\{(env|global):([A-Za-z_][A-Za-z0-9_.-]{0,127})\}$/;

export function parseSecretReference(value: unknown): { source: 'env' | 'global'; name: string } | null {
  if (typeof value !== 'string') return null;
  const match = SECRET_REFERENCE.exec(value.trim());
  return match ? { source: match[1] as 'env' | 'global', name: match[2] } : null;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const heartbeatUrl = z.string().refine((value) => {
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return !url.username && !url.password && (url.protocol === 'https:' || (url.protocol === 'http:' && loopback));
  } catch { return false; }
}, 'must be an https address (plain http only for this computer), with no user name or password in it');

/**
 * Which parts of Settings a file may set. A new setting is one more line here. Each
 * section names only its own fields, so a typing mistake is refused rather than
 * quietly stored and ignored.
 */
const SETTINGS_SECTIONS: Record<string, z.ZodType<Record<string, unknown>>> = {
  telemetry: z.object({ enabled: z.boolean().optional(), notifyDaily: z.boolean().optional() }).strict(),
  network: z.object({
    exposure: z.enum(['localhost', 'network', 'public']).optional(),
    allowAllMcpAppContent: z.boolean().optional(),
  }).strict(),
  modelAccess: z.object({ directModelCalls: z.boolean().optional(), quickChat: z.boolean().optional() }).strict(),
  onboarding: z.object({ completed: z.boolean().optional() }).strict(),
  update: z.object({ checkOnStartup: z.boolean().optional() }).strict(),
  speech: z.object({
    enabled: z.boolean().optional(),
    language: z.string().optional(),
    transcriptionModelId: z.string().optional(),
  }).strict(),
  // These two carry many fields owned by their own features, which check them on read.
  experimental: z.record(z.string(), z.unknown()),
  conversationRetention: z.record(z.string(), z.unknown()),
  heartbeat: z.object({
    url: heartbeatUrl.optional(),
    intervalMinutes: z.number().int().min(1).max(1440).optional(),
  }).strict(),
};

export const SETTINGS_SECTION_NAMES = Object.keys(SETTINGS_SECTIONS);

const TopLevel = z.object({
  schemaVersion: z.number(),
  version: z.string().trim().min(1).max(128),
  workspace: z.string().optional(),
  workspaces: z.array(z.string()).min(1).optional(),
  policy: z.object({
    localEdits: z.enum(['overwrite', 'keep']).optional(),
    existingLocalObjects: z.enum(['refuse', 'adopt']).optional(),
    removedObjects: z.enum(['delete', 'keep']).optional(),
    secretScan: z.enum(['refuse', 'warn']).optional(),
    keepVersions: z.number().int().min(MIN_KEEP_VERSIONS).max(MAX_KEEP_VERSIONS).optional(),
  }).strict().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  models: z.array(z.record(z.string(), z.unknown())).optional(),
  mcpServers: z.array(z.record(z.string(), z.unknown())).optional(),
  flows: z.array(z.record(z.string(), z.unknown())).optional(),
  plannedExecutions: z.array(z.record(z.string(), z.unknown())).optional(),
}).strict();

function zodProblems(prefix: string, error: z.ZodError): DesiredStateProblem[] {
  return error.issues.map((issue) => ({
    where: [prefix, ...issue.path.map(String)].filter(Boolean).join('.') || 'file',
    message: issue.code === 'unrecognized_keys'
      ? `this name is not known: ${issue.keys.join(', ')}.`
      : issue.message,
  }));
}

/** The credential fields: an empty value or a reference. Anything else is a secret value. */
function credentialProblem(where: string, value: unknown, problems: DesiredStateProblem[]): void {
  if (value === undefined || value === '') return;
  if (parseSecretReference(value)) return;
  problems.push({
    where,
    message: 'this holds a value. The file may only name a secret: write ${env:NAME} or ${global:NAME}.',
  });
}

function checkModels(state: ParsedDesiredState, problems: DesiredStateProblem[]): void {
  const seen = new Set<string>();
  state.models.forEach((model, index) => {
    const where = `models[${index}]`;
    if (typeof model.id !== 'string' || !SAFE_ID.test(model.id)) {
      problems.push({ where: `${where}.id`, message: 'an id is required: letters, digits, dot, underscore, colon or hyphen.' });
    } else if (seen.has(model.id)) {
      problems.push({ where: `${where}.id`, message: `the id "${model.id}" is used twice.` });
    } else seen.add(model.id);
    if (typeof model.name !== 'string' || !model.name.trim()) {
      problems.push({ where: `${where}.name`, message: 'the provider\'s model name is required.' });
    }
    if ('ApiKey' in model) {
      problems.push({ where: `${where}.ApiKey`, message: 'use "apiKey" with ${env:NAME} or ${global:NAME}.' });
    }
    if ('ownerCredentialBinding' in model) {
      problems.push({ where: `${where}.ownerCredentialBinding`, message: 'a model tied to an owner credential cannot be set from a file.' });
    }
    credentialProblem(`${where}.apiKey`, model.apiKey, problems);
  });
}

function checkKeyedValues(
  where: string,
  values: unknown,
  isSecretKey: (key: string) => boolean,
  problems: DesiredStateProblem[],
): void {
  if (values === undefined) return;
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    problems.push({ where, message: 'this must be a list of names and text values.' });
    return;
  }
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== 'string') {
      problems.push({ where: `${where}.${key}`, message: 'this must be text.' });
    } else if (isSecretKey(key)) {
      credentialProblem(`${where}.${key}`, value, problems);
    }
  }
}

function checkServers(state: ParsedDesiredState, problems: DesiredStateProblem[]): void {
  const seen = new Set<string>();
  state.mcpServers.forEach((server, index) => {
    const where = `mcpServers[${index}]`;
    if (typeof server.name !== 'string' || !SERVER_NAME.test(server.name)) {
      problems.push({ where: `${where}.name`, message: 'a name is required: letters, digits, underscore or hyphen, at most 64 characters.' });
    } else if (seen.has(server.name)) {
      problems.push({ where: `${where}.name`, message: `the name "${server.name}" is used twice.` });
    } else seen.add(server.name);
    const transport = server.transport ?? 'stdio';
    if (!['stdio', 'streamable', 'sse', 'websocket'].includes(String(transport))) {
      problems.push({ where: `${where}.transport`, message: 'this must be stdio, streamable, sse or websocket.' });
    }
    if (transport === 'stdio' && (typeof server.command !== 'string' || !server.command.trim())) {
      problems.push({ where: `${where}.command`, message: 'a server started on this computer needs a command.' });
    }
    if (transport !== 'stdio' && (typeof server.serverUrl !== 'string' || !server.serverUrl.trim())) {
      problems.push({ where: `${where}.serverUrl`, message: 'a remote server needs an address.' });
    }
    if ('oauthClientSecret' in server) {
      problems.push({ where: `${where}.oauthClientSecret`, message: 'a sign-in secret cannot be in the file. Set it up on the instance.' });
    }
    checkKeyedValues(`${where}.env`, server.env, isSecretEnvVar, problems);
    checkKeyedValues(`${where}.headers`, server.headers, isSecretHeaderKey, problems);
  });
}

function checkFlows(raw: Array<Record<string, unknown>>, problems: DesiredStateProblem[]): DesiredFlowEntry[] {
  const seen = new Set<string>();
  const flows: DesiredFlowEntry[] = [];
  raw.forEach((entry, index) => {
    const where = `flows[${index}]`;
    const id = entry.id;
    if (typeof id !== 'string' || !SAFE_ID.test(id)) {
      problems.push({ where: `${where}.id`, message: 'an id is required: letters, digits, dot, underscore, colon or hyphen.' });
      return;
    }
    if (seen.has(id)) {
      problems.push({ where: `${where}.id`, message: `the id "${id}" is used twice.` });
      return;
    }
    seen.add(id);
    const unknown = Object.keys(entry).filter((key) => !['id', 'spec', 'flow', 'folder', 'pinSubflows'].includes(key));
    if (unknown.length) problems.push({ where, message: `this name is not known: ${unknown.join(', ')}.` });
    if (entry.spec !== undefined && entry.flow !== undefined) {
      problems.push({ where, message: 'give either "spec" or "flow", not both.' });
      return;
    }
    if (entry.spec === undefined && entry.flow === undefined) {
      problems.push({ where, message: 'a flow needs "spec" (FlowSpec form) or "flow" (saved form).' });
      return;
    }
    if (entry.folder !== undefined && typeof entry.folder !== 'string') {
      problems.push({ where: `${where}.folder`, message: 'this must be text.' });
    }
    if (entry.pinSubflows !== undefined && typeof entry.pinSubflows !== 'boolean') {
      problems.push({ where: `${where}.pinSubflows`, message: 'this must be true or false.' });
    }
    const flowEntry: DesiredFlowEntry = {
      id,
      ...(typeof entry.folder === 'string' ? { folder: entry.folder } : {}),
      pinSubflows: entry.pinSubflows !== false,
    };
    if (entry.spec !== undefined) {
      if (!entry.spec || typeof entry.spec !== 'object' || Array.isArray(entry.spec)) {
        problems.push({ where: `${where}.spec`, message: 'this must be a FlowSpec object.' });
        return;
      }
      flowEntry.spec = entry.spec as FlowSpec;
    } else {
      const parsed = FlowSnapshotSchema.safeParse({ ...(entry.flow as object), id });
      if (!parsed.success) {
        problems.push(...zodProblems(`${where}.flow`, parsed.error));
        return;
      }
      if (parsed.data.personaOwnership || parsed.data.executionDependencies) {
        problems.push({ where: `${where}.flow`, message: 'a flow owned by a Persona or carrying frozen dependencies cannot be set from a file.' });
        return;
      }
      flowEntry.flow = parsed.data;
    }
    flows.push(flowEntry);
  });
  return flows;
}

function checkPlannedExecutions(state: ParsedDesiredState, problems: DesiredStateProblem[]): void {
  const seen = new Set<string>();
  state.plannedExecutions.forEach((execution, index) => {
    const where = `plannedExecutions[${index}]`;
    if (typeof execution.id !== 'string' || !SAFE_ID.test(execution.id)) {
      problems.push({ where: `${where}.id`, message: 'an id is required: letters, digits, dot, underscore, colon or hyphen.' });
    } else if (seen.has(execution.id)) {
      problems.push({ where: `${where}.id`, message: `the id "${execution.id}" is used twice.` });
    } else seen.add(execution.id);
    if (typeof execution.flowId !== 'string' || !execution.flowId) {
      problems.push({ where: `${where}.flowId`, message: 'the flow to run is required.' });
    }
    for (const field of ['personaId', 'behaviorSlotKey', 'personaRetired', 'personaArchived', 'workerLocalRecovery']) {
      if (field in execution) problems.push({ where: `${where}.${field}`, message: 'this cannot be set from a file.' });
    }
    const trigger = execution.trigger as { type?: unknown } | undefined;
    if (trigger?.type === 'webhook') {
      problems.push({ where: `${where}.trigger`, message: 'a webhook trigger needs a secret token, which a file cannot hold yet. Use another trigger or set this one up on the instance.' });
    }
  });
}

/** Every text in the file, except the fields already checked as credentials. */
function scanTargets(value: unknown, location: string, out: ScanTarget[]): void {
  if (typeof value === 'string') {
    if (value.trim() && !parseSecretReference(value)) out.push({ location, text: value });
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => scanTargets(item, `${location}[${index}]`, out));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) scanTargets(item, `${location}.${key}`, out);
  }
}

/** Read an already decoded file. Never throws for bad input. */
export function parseDesiredState(input: unknown): ParseResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, problems: [{ where: 'file', message: 'the file must hold one JSON object.' }] };
  }
  const top = TopLevel.safeParse(input);
  if (!top.success) return { ok: false, problems: zodProblems('', top.error) };
  const data = top.data;
  const problems: DesiredStateProblem[] = [];
  if (data.schemaVersion !== DESIRED_STATE_SCHEMA_VERSION) {
    problems.push({ where: 'schemaVersion', message: `this FLUJO reads version ${DESIRED_STATE_SCHEMA_VERSION} of this file, not ${data.schemaVersion}.` });
  }
  if (data.workspace !== undefined && data.workspaces !== undefined) {
    problems.push({ where: 'workspaces', message: 'give either "workspace" or "workspaces", not both.' });
  }
  const workspaces: string[] = [];
  for (const name of data.workspaces ?? (data.workspace !== undefined ? [data.workspace] : [DEFAULT_WORKSPACE])) {
    try {
      const normalized = normalizeWorkspaceName(name);
      if (!workspaces.includes(normalized)) workspaces.push(normalized);
    } catch {
      problems.push({ where: 'workspaces', message: `"${name}" is not a valid workspace name.` });
    }
  }
  const settings: Record<string, Record<string, unknown>> = {};
  for (const [section, value] of Object.entries(data.settings ?? {})) {
    const schema = SETTINGS_SECTIONS[section];
    if (!schema) {
      problems.push({ where: `settings.${section}`, message: `this setting is not known. Known settings: ${SETTINGS_SECTION_NAMES.join(', ')}.` });
      continue;
    }
    const parsed = schema.safeParse(value);
    if (parsed.success) settings[section] = parsed.data;
    else problems.push(...zodProblems(`settings.${section}`, parsed.error));
  }
  const state: ParsedDesiredState = {
    schemaVersion: data.schemaVersion,
    version: data.version,
    workspaces,
    policy: { ...DEFAULT_POLICY, ...data.policy },
    settings,
    models: (data.models ?? []) as ParsedDesiredState['models'],
    mcpServers: (data.mcpServers ?? []) as ParsedDesiredState['mcpServers'],
    flows: [],
    plannedExecutions: (data.plannedExecutions ?? []) as ParsedDesiredState['plannedExecutions'],
  };
  checkModels(state, problems);
  checkServers(state, problems);
  state.flows = checkFlows(data.flows ?? [], problems);
  checkPlannedExecutions(state, problems);

  const warnings: string[] = [];
  const targets: ScanTarget[] = [];
  scanTargets(input, 'file', targets);
  // Report only where it was found. The text itself must never reach a report or log.
  const found = [...new Set(detectHeuristicSecrets(targets).map((proposal) => proposal.location))];
  for (const location of found) {
    const message = 'this looks like a secret value. A file may only name a secret: write ${env:NAME} or ${global:NAME}.';
    if (state.policy.secretScan === 'warn') warnings.push(`${location}: ${message}`);
    else problems.push({ where: location, message });
  }
  return problems.length ? { ok: false, problems } : { ok: true, state, warnings };
}
