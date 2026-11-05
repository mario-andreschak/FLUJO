/**
 * Turns a desired state into a plan without writing anything: compile and check every
 * object, compare it with what is stored and with what was applied last time, and work
 * out the exact writes in both directions. A dry run stops here, which is why it reports
 * exactly what an apply would do, and why an invalid file cannot change the instance.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '@/backend/services/enduringAgents/behaviorRevisions';
import { flowService } from '@/backend/services/flow';
import { mcpService } from '@/backend/services/mcp';
import { modelService } from '@/backend/services/model';
import { getSchedulerService } from '@/backend/services/scheduler';
import { isOwnerBootstrapAvailable } from '@/backend/services/security/ownerBootstrap';
import type { Flow, FlowNode } from '@/shared/types/flow';
import type { Model } from '@/shared/types/model';
import { validateFallbackPolicy } from '@/shared/types/model/fallbackPolicy';
import { validateModelConfiguration } from '@/shared/types/model/provider';
import { StorageKey, type Settings } from '@/shared/types/storage';
import { decryptWithPassword } from '@/utils/encryption/secure';
import { compileFlowSpec, sanitizeFlowName } from '@/utils/shared/flowSpecCompiler';
import { validateFlowDisplayName } from '@/utils/shared/flowNamePolicy';
import { validateFlow } from '@/utils/shared/flowValidation';
import { loadItem } from '@/utils/storage/backend';
import { DEFAULT_WORKSPACE, getCurrentWorkspace } from '@/utils/workspace';
import { parseSecretReference, type DesiredStatePolicy, type DesiredStateProblem, type ParsedDesiredState } from './schema';
import {
  emptyChangeSet,
  type BundleRecord,
  type BundleTargets,
  type BundleUndo,
  type ChangeSet,
  type DesiredStateChange,
  type DurableState,
  type LedgerEntry,
  type ManagedKind,
  type PlannedExecutionDefinition,
  type StoredServer,
} from './store';

const SERVER_MANAGED_FLOW_FIELDS = new Set(['createdAt', 'updatedAt']);
const SERVER_MANAGED_EXECUTION_FIELDS = new Set(['generationId', 'createdAt', 'updatedAt']);
/** Settings the launcher reads once, before the server starts. */
const RESTART_SETTINGS = new Set(['network.exposure', 'network.allowAllMcpAppContent']);
/** May name an installation in its path, so its value stays out of reports. */
const QUIET_SETTINGS = new Set(['heartbeat.url']);
const MAX_REPORTED_FIELDS = 40;

export const ledgerKey = (kind: ManagedKind, id: string): string => `${kind}:${id}`;

function withoutFields<T extends object>(value: T, fields: Set<string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !fields.has(key)));
}

export function fingerprint(kind: ManagedKind, value: unknown): string {
  let content = value;
  if (value && typeof value === 'object') {
    if (kind === 'flow') content = withoutFields(value, SERVER_MANAGED_FLOW_FIELDS);
    if (kind === 'plannedExecution') content = withoutFields(value, SERVER_MANAGED_EXECUTION_FIELDS);
  }
  return createHash('sha256').update(canonicalJson(content)).digest('hex');
}

/** Paths of the fields that differ, never their contents. */
function changedFields(before: unknown, after: unknown, path = '', out: string[] = []): string[] {
  if (out.length >= MAX_REPORTED_FIELDS) return out;
  if (before && after && typeof before === 'object' && typeof after === 'object'
      && Array.isArray(before) === Array.isArray(after)) {
    const left = before as Record<string, unknown>;
    const right = after as Record<string, unknown>;
    for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])]) {
      if (!path && SERVER_MANAGED_EXECUTION_FIELDS.has(key)) continue;
      const next = Array.isArray(before) ? `${path}[${key}]` : path ? `${path}.${key}` : key;
      changedFields(left[key], right[key], next, out);
    }
  } else if (canonicalJson(before) !== canonicalJson(after)) {
    out.push(path || '(whole object)');
  }
  return out;
}

const readSettingsDocument = (): Promise<Settings | null> =>
  loadItem<Settings | null>(StorageKey.SPEECH_SETTINGS, null);
export const readSecretStore = (): Promise<Record<string, unknown>> =>
  loadItem<Record<string, unknown>>(StorageKey.GLOBAL_ENV_VARS, {});
export const readRawServers = (): Promise<Record<string, StoredServer>> =>
  loadItem<Record<string, StoredServer>>(StorageKey.MCP_SERVERS, {});

function settingValue(document: Settings | null, path: readonly string[]): { exists: boolean; value?: unknown } {
  let current: unknown = document;
  for (const part of path) {
    if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) {
      return { exists: false };
    }
    current = (current as Record<string, unknown>)[part];
  }
  return { exists: true, value: current };
}

/**
 * The form of an object used for comparing. Servers are compared as FLUJO reads them,
 * because an unrelated later save writes that normalized form back to disk, which must
 * not look like a local edit.
 */
export async function readStored(kind: ManagedKind, id: string): Promise<unknown | null> {
  switch (kind) {
    case 'flow':
      return (await flowService.readFlowExecutionSnapshot(id))?.flow ?? null;
    case 'model':
      return (await modelService.loadModels()).find((model) => model.id === id) ?? null;
    case 'mcpServer': {
      const configs = await mcpService.loadServerConfigs();
      if (!Array.isArray(configs)) throw new Error('The list of servers could not be read.');
      return configs.find((config) => config.name === id) ?? null;
    }
    case 'plannedExecution':
      return await getSchedulerService().get(id);
    case 'setting': {
      const found = settingValue(await readSettingsDocument(), id.split('.'));
      return found.exists ? found.value : null;
    }
    case 'secret':
      return null;
  }
}

export interface CompiledTargets {
  targets: BundleTargets;
  problems: DesiredStateProblem[];
  warnings: string[];
  /** Values read from the environment, held only to scrub them from outgoing text. */
  secretValues: string[];
}

function subflowTargetsOf(flow: Flow): string[] {
  const targets: string[] = [];
  for (const node of flow.nodes ?? []) {
    if (node.type !== 'subflow' && node.data?.type !== 'subflow') continue;
    const properties = node.data?.properties ?? {};
    if (typeof properties.subflowId === 'string' && properties.subflowId) targets.push(properties.subflowId);
    if (Array.isArray(properties.parallelSubflowIds)) {
      targets.push(...properties.parallelSubflowIds.filter((id): id is string => typeof id === 'string' && !!id));
    }
  }
  return targets;
}

async function compileFlows(
  state: ParsedDesiredState,
  durable: DurableState,
  modelsAfter: Model[],
  serverNames: string[],
  problems: DesiredStateProblem[],
  warnings: string[],
): Promise<Flow[]> {
  const fromFile = new Set(state.flows.map((entry) => entry.id));
  const localFlows = (await flowService.loadFlows()).filter((flow) => (
    !fromFile.has(flow.id) && !durable.ledger[ledgerKey('flow', flow.id)]
  ));
  const stubs = state.flows.map((entry) => ({
    id: entry.id,
    name: entry.spec ? sanitizeFlowName(entry.spec.name ?? entry.id, []) : String(entry.flow?.name ?? entry.id),
  }));
  const modelContext = modelsAfter.map((model) => ({
    id: model.id, name: model.name, displayName: model.displayName, fallbackPolicy: model.fallbackPolicy,
  }));
  const compiledChildren: Array<{ id: string; name: string }> = [];
  const flows: Flow[] = [];

  for (const entry of state.flows) {
    const where = `flows.${entry.id}`;
    const existingNames = [
      ...localFlows.map((flow) => ({ id: flow.id, name: flow.name })),
      ...stubs.filter((stub) => stub.id !== entry.id),
      ...compiledChildren,
    ];
    let bundle: Flow[];
    if (entry.spec) {
      const spec = { ...entry.spec, name: entry.spec.name ?? entry.id };
      const compiled = compileFlowSpec(spec, {
        models: modelContext,
        servers: serverNames.map((name) => ({ name })),
        flows: existingNames,
      }, { keepPills: true, newSubflowDefaults: true, stableIdSeed: entry.id });
      for (const issue of compiled.issues) {
        const text = issue.nodeKey ? `step "${issue.nodeKey}": ${issue.message}` : issue.message;
        if (issue.severity === 'error') problems.push({ where, message: text });
        else warnings.push(`${where}: ${text}`);
      }
      if (!compiled.flow) continue;
      if (compiled.flow.name !== sanitizeFlowName(spec.name, [])) {
        problems.push({ where, message: `the name "${spec.name}" is already used by another flow on this instance. Rename one of them.` });
        continue;
      }
      compiled.flow.id = entry.id;
      bundle = compiled.flows;
      for (const flow of bundle) {
        if (flow !== compiled.flow) compiledChildren.push({ id: flow.id, name: flow.name });
      }
    } else {
      const flow = structuredClone(entry.flow!);
      const nameError = validateFlowDisplayName(String(flow.name ?? ''));
      if (nameError) {
        problems.push({ where, message: `the flow name is not usable (${nameError}).` });
        continue;
      }
      const taken = existingNames.find((other) => other.name.toLowerCase() === flow.name.toLowerCase());
      if (taken) {
        problems.push({ where, message: `the name "${flow.name}" is already used by another flow on this instance. Rename one of them.` });
        continue;
      }
      bundle = [flow];
    }
    for (const flow of bundle) {
      if (entry.folder !== undefined) flow.folder = entry.folder;
      if (entry.pinSubflows && subflowTargetsOf(flow).length) flow.pinSubflowsAtRunStart = true;
      const validation = validateFlow(flow, {
        models: modelContext,
        // Whether a server is running right now must not decide whether a file is valid.
        servers: serverNames.map((name) => ({ name, status: 'connected' })),
      });
      for (const issue of validation.issues) {
        if (issue.severity === 'error') problems.push({ where, message: issue.message });
        else warnings.push(`${where}: ${issue.message}`);
      }
      for (const node of flow.nodes as FlowNode[]) {
        const tools = node.data?.properties?.enabledTools;
        if (node.type === 'mcp' && Array.isArray(tools) && tools.length === 0) {
          warnings.push(`${where}: server "${String(node.data?.properties?.boundServer)}" is attached with no tools listed, so that step gets none from it.`);
        }
      }
      flows.push(flow);
    }
  }
  const known = new Set([...localFlows.map((flow) => flow.id), ...flows.map((flow) => flow.id)]);
  for (const flow of flows) {
    for (const target of subflowTargetsOf(flow)) {
      if (!known.has(target)) {
        problems.push({ where: `flows.${flow.id}`, message: `it calls subflow "${target}", which is neither in this file nor on this instance.` });
      }
    }
  }
  return flows;
}

/** Everything the file asks for, fully checked and compiled. Writes nothing. */
export async function compileTargets(state: ParsedDesiredState, durable: DurableState): Promise<CompiledTargets> {
  const problems: DesiredStateProblem[] = [];
  const warnings: string[] = [];
  const secretValues: string[] = [];
  const secrets = new Map<string, { name: string; fromEnv?: string }>();
  const secretStore = await readSecretStore();

  /** The stored form of a credential field, or a problem when what it names is missing. */
  const credential = (where: string, value: unknown): string | undefined => {
    const reference = parseSecretReference(value);
    if (!reference) return undefined;
    if (reference.source === 'env') {
      const found = process.env[reference.name];
      if (found === undefined || found === '') {
        problems.push({ where, message: `the environment variable ${reference.name} is not set.` });
      } else {
        secretValues.push(found);
        secrets.set(reference.name, { name: reference.name, fromEnv: reference.name });
      }
    } else if (!Object.prototype.hasOwnProperty.call(secretStore, reference.name) && !secrets.has(reference.name)) {
      problems.push({ where, message: `the secret store has nothing called ${reference.name}.` });
    }
    return `\${global:${reference.name}}`;
  };

  const models: Model[] = state.models.map((entry, index) => {
    const { apiKey, ...rest } = entry;
    const model = { ...rest, ApiKey: credential(`models[${index}].apiKey`, apiKey) ?? '' } as unknown as Model;
    const configurationError = validateModelConfiguration(model);
    if (configurationError) problems.push({ where: `models.${model.id}`, message: configurationError });
    return model;
  });
  const existingModels = await modelService.loadModels();
  const modelIds = new Set(models.map((model) => model.id));
  const modelsAfter = [
    ...existingModels.filter((model) => !modelIds.has(model.id) && !durable.ledger[ledgerKey('model', model.id)]),
    ...models,
  ];
  for (const model of models) {
    const policyError = validateFallbackPolicy(model, modelsAfter);
    if (policyError) problems.push({ where: `models.${model.id}`, message: policyError });
    const name = model.displayName?.trim().toLowerCase();
    if (name && modelsAfter.some((other) => other.id !== model.id && other.displayName?.trim().toLowerCase() === name)) {
      problems.push({ where: `models.${model.id}`, message: `the display name "${model.displayName}" is already used by another model.` });
    }
  }

  const keyedValues = (where: string, values: unknown, isCredential: (key: string) => boolean) => {
    const out: Record<string, { value: string; metadata: { isSecret: boolean } }> = {};
    for (const [key, value] of Object.entries((values ?? {}) as Record<string, string>)) {
      const stored = credential(`${where}.${key}`, value);
      out[key] = { value: stored ?? value, metadata: { isSecret: stored !== undefined || isCredential(key) } };
    }
    return out;
  };
  const mcpServers = state.mcpServers.map((entry, index) => {
    const { name, env, headers, ...rest } = entry;
    const transport = (rest.transport as string | undefined) ?? 'stdio';
    const config: StoredServer = {
      disabled: false,
      ...(transport === 'stdio' ? { args: [] } : { rootPath: `mcp-servers/${name}` }),
      ...rest,
      transport,
      env: keyedValues(`mcpServers[${index}].env`, env, () => false),
      ...(headers !== undefined ? { headers: keyedValues(`mcpServers[${index}].headers`, headers, () => true) } : {}),
    };
    return { name, config };
  });
  const serverConfigs = await mcpService.loadServerConfigs();
  const serverNames = [...new Set([
    ...(Array.isArray(serverConfigs) ? serverConfigs : [])
      .map((config) => config.name)
      .filter((name) => !durable.ledger[ledgerKey('mcpServer', name)]),
    ...mcpServers.map((server) => server.name),
  ])];

  const settings = Object.entries(state.settings).flatMap(([section, values]) => (
    Object.entries(values).map(([key, value]) => ({ path: [section, key], value }))
  ));
  const exposure = state.settings.network?.exposure;
  if (exposure !== undefined && getCurrentWorkspace() !== DEFAULT_WORKSPACE) {
    warnings.push('settings.network: network exposure is read from the default workspace only, so it has no effect here.');
  }
  // FLUJO refuses to start on a wider exposure without an owner credential. A file must
  // not be able to leave an instance that will not come back after its next restart.
  if (exposure !== undefined && exposure !== 'localhost' && getCurrentWorkspace() === DEFAULT_WORKSPACE
      && process.env.FLUJO_OWNER_AUTH_FILE === undefined && !isOwnerBootstrapAvailable()) {
    problems.push({
      where: 'settings.network.exposure',
      message: `"${String(exposure)}" needs owner access (FLUJO_OWNER_AUTH_FILE). Without it this instance would refuse to start after its next restart.`,
    });
  }

  const flows = await compileFlows(state, durable, modelsAfter, serverNames, problems, warnings);

  const scheduler = getSchedulerService();
  const localFlowIds = new Set((await flowService.loadFlows()).map((flow) => flow.id));
  const plannedExecutions = state.plannedExecutions.map((entry) => {
    const definition = { ...entry } as PlannedExecutionDefinition;
    const where = `plannedExecutions.${entry.id}`;
    if (!flows.some((flow) => flow.id === entry.flowId) && !localFlowIds.has(entry.flowId)) {
      problems.push({ where, message: `it runs flow "${entry.flowId}", which is neither in this file nor on this instance.` });
    }
    const error = scheduler.validateDefinition(definition as never);
    if (error) problems.push({ where, message: error });
    return definition;
  });

  return {
    targets: { secrets: [...secrets.values()], settings, models, mcpServers, flows, plannedExecutions },
    problems,
    warnings,
    secretValues,
  };
}

/** Rollback uses a stored version. Secrets stay as they are, but must still exist. */
export async function targetsForRollback(record: BundleRecord): Promise<{ targets: BundleTargets; problems: DesiredStateProblem[] }> {
  const store = await readSecretStore();
  const problems: DesiredStateProblem[] = [];
  for (const secret of record.targets.secrets) {
    if (!Object.prototype.hasOwnProperty.call(store, secret.name)) {
      problems.push({ where: `secrets.${secret.name}`, message: 'version it returns to needs this secret, and the secret store no longer has it.' });
    }
  }
  // Without a source, the plan keeps these managed and leaves their values alone.
  return { targets: { ...record.targets, secrets: record.targets.secrets.map(({ name }) => ({ name })) }, problems };
}

export interface OperationPlan {
  changes: DesiredStateChange[];
  unchanged: number;
  problems: DesiredStateProblem[];
  forward: ChangeSet;
  reverse: ChangeSet;
  ledgerTargets: Array<{ kind: ManagedKind; id: string; desiredHash: string }>;
  keptEntries: LedgerEntry[];
  undo: BundleUndo;
  restartRequired: string[];
  /** Whether anything would actually be written. */
  writes: boolean;
}

type Decision = 'create' | 'update' | 'unchanged' | 'adopt' | 'recreate' | 'overwrite-local-edit' | 'keep-local-edit' | 'refuse';

function decide(
  entry: LedgerEntry | undefined,
  desiredHash: string,
  stored: unknown | null,
  storedHash: string | null,
  policy: DesiredStatePolicy,
): Decision {
  if (!entry) {
    if (stored === null) return 'create';
    return policy.existingLocalObjects === 'adopt' ? 'adopt' : 'refuse';
  }
  const edited = storedHash !== entry.appliedHash;
  if (!edited) return entry.desiredHash === desiredHash ? 'unchanged' : 'update';
  if (policy.localEdits === 'keep') return 'keep-local-edit';
  return stored === null ? 'recreate' : 'overwrite-local-edit';
}

const EXISTS_MESSAGE = 'an object with this name was created on this instance, not from a file. Remove it, or set policy.existingLocalObjects to "adopt" to take it over.';

/** Compare every target with what is stored and work out the writes in both directions. */
export async function buildOperationPlan(input: {
  targets: BundleTargets;
  policy: DesiredStatePolicy;
  durable: DurableState;
  /** The version being left behind by a rollback. Its undo records are put back. */
  rollbackFrom?: BundleRecord;
}): Promise<OperationPlan> {
  const { targets, policy, durable, rollbackFrom } = input;
  const plan: OperationPlan = {
    changes: [],
    unchanged: 0,
    problems: [],
    forward: emptyChangeSet(),
    reverse: emptyChangeSet(),
    ledgerTargets: [],
    keptEntries: [],
    undo: { settings: [], adopted: emptyChangeSet() },
    restartRequired: [],
    writes: false,
  };
  const targetKeys = new Set<string>();
  const rawServers = await readRawServers();
  const rawModels = await modelService.loadModels();

  /** The exact stored record to put back if this write has to be undone. */
  const remember = (kind: ManagedKind, id: string, into: ChangeSet, preImage: unknown): void => {
    if (kind === 'model') into.models.push({ id, value: rawModels.find((model) => model.id === id) ?? null });
    if (kind === 'mcpServer') into.mcpServers.push({ name: id, value: rawServers[id] ?? null });
    if (kind === 'flow') into.flows.push({ id, value: (preImage as Flow | null) ?? null });
    if (kind === 'plannedExecution') into.plannedExecutions.push({ id, value: (preImage as PlannedExecutionDefinition | null) ?? null });
  };
  const write = (kind: ManagedKind, id: string, desired: unknown): void => {
    if (kind === 'model') plan.forward.models.push({ id, value: desired as Model | null });
    if (kind === 'mcpServer') plan.forward.mcpServers.push({ name: id, value: desired as StoredServer | null });
    if (kind === 'flow') plan.forward.flows.push({ id, value: desired as Flow | null });
    if (kind === 'plannedExecution') plan.forward.plannedExecutions.push({ id, value: desired as PlannedExecutionDefinition | null });
  };

  const consider = async (kind: ManagedKind, id: string, desired: unknown): Promise<void> => {
    const key = ledgerKey(kind, id);
    targetKeys.add(key);
    const entry = durable.ledger[key];
    const desiredHash = fingerprint(kind, desired);
    const stored = await readStored(kind, id);
    const storedHash = stored === null ? null : fingerprint(kind, stored);
    const decision = decide(entry, desiredHash, stored, storedHash, policy);
    if (decision === 'refuse') {
      plan.problems.push({ where: `${kind} ${id}`, message: EXISTS_MESSAGE });
      return;
    }
    if (decision === 'unchanged') {
      plan.unchanged += 1;
      plan.ledgerTargets.push({ kind, id, desiredHash });
      return;
    }
    // Compare a server as it is stored, so read-time defaults are not reported as changes.
    const { name: _serverName, ...serverRecord } = (kind === 'mcpServer' ? desired : {}) as StoredServer;
    const fields = stored === null ? undefined
      : kind === 'mcpServer' ? changedFields(rawServers[id] ?? {}, serverRecord)
      : changedFields(stored, desired);
    if (decision === 'keep-local-edit') {
      plan.keptEntries.push({ ...entry!, localEditKept: true });
      plan.changes.push({ kind, id, action: 'keep-local-edit', ...(fields ? { fields } : {}), reason: 'Changed on this instance. policy.localEdits is "keep", so it stays as it is.' });
      return;
    }
    plan.writes = true;
    plan.changes.push({
      kind, id, action: decision,
      ...(fields ? { fields } : {}),
      ...(decision === 'overwrite-local-edit' ? { reason: 'Changed on this instance. policy.localEdits is "overwrite", so the file wins. An earlier flow definition stays in that flow\'s version history.' } : {}),
    });
    if (decision === 'adopt') remember(kind, id, plan.undo.adopted, stored);
    write(kind, id, desired);
    remember(kind, id, plan.reverse, stored);
    plan.ledgerTargets.push({ kind, id, desiredHash });
  };

  // Secrets first: they are compared by value, and that value never leaves this function.
  const secretStore = await readSecretStore();
  for (const secret of targets.secrets) {
    const key = ledgerKey('secret', secret.name);
    targetKeys.add(key);
    if (!secret.fromEnv) {
      plan.ledgerTargets.push({ kind: 'secret', id: secret.name, desiredHash: durable.ledger[key]?.desiredHash ?? 'env:' });
      plan.unchanged += 1;
      continue;
    }
    const raw = secretStore[secret.name];
    const storedValue = typeof raw === 'string' ? raw : (raw as { value?: string } | undefined)?.value;
    const wanted = process.env[secret.fromEnv];
    let same = false;
    if (storedValue?.startsWith('encrypted:')) {
      same = (await decryptWithPassword(storedValue.substring('encrypted:'.length))) === wanted;
    }
    plan.ledgerTargets.push({ kind: 'secret', id: secret.name, desiredHash: `env:${secret.fromEnv}` });
    if (same) { plan.unchanged += 1; continue; }
    plan.writes = true;
    plan.changes.push({ kind: 'secret', id: secret.name, action: raw === undefined ? 'create' : 'update' });
    plan.forward.secrets.push({ name: secret.name, fromEnv: secret.fromEnv });
    plan.reverse.secrets.push({ name: secret.name, stored: raw ?? null });
  }

  const settingsDocument = await readSettingsDocument();
  for (const setting of targets.settings) {
    const id = setting.path.join('.');
    const key = ledgerKey('setting', id);
    targetKeys.add(key);
    const entry = durable.ledger[key];
    const found = settingValue(settingsDocument, setting.path);
    const desiredHash = fingerprint('setting', setting.value);
    const storedHash = found.exists ? fingerprint('setting', found.value) : null;
    plan.ledgerTargets.push({ kind: 'setting', id, desiredHash });
    if (!entry) plan.undo.settings.push({ path: setting.path, exists: found.exists, ...(found.exists ? { value: found.value } : {}) });
    // A setting always has some value, so finding one is not somebody's object to protect.
    const decision = entry ? decide(entry, desiredHash, found.exists ? found.value : null, storedHash, policy)
      : storedHash === desiredHash ? 'unchanged' : 'update';
    if (decision === 'unchanged') { plan.unchanged += 1; continue; }
    const shown = QUIET_SETTINGS.has(id) ? {} : { from: found.value, to: setting.value };
    if (decision === 'keep-local-edit') {
      plan.ledgerTargets.pop();
      plan.keptEntries.push({ ...entry!, localEditKept: true });
      plan.changes.push({ kind: 'setting', id, action: decision, ...shown, reason: 'Changed on this instance. policy.localEdits is "keep", so it stays as it is.' });
      continue;
    }
    if (storedHash === desiredHash) { plan.unchanged += 1; continue; }
    plan.writes = true;
    plan.changes.push({ kind: 'setting', id, action: decision === 'overwrite-local-edit' ? decision : 'update', ...shown });
    plan.forward.settings.push({ path: setting.path, exists: true, value: setting.value });
    plan.reverse.settings.push({ path: setting.path, exists: found.exists, ...(found.exists ? { value: found.value } : {}) });
    if (RESTART_SETTINGS.has(id)) plan.restartRequired.push(id);
  }

  for (const model of targets.models) await consider('model', model.id, model);
  for (const server of targets.mcpServers) await consider('mcpServer', server.name, { name: server.name, ...server.config });
  for (const flow of targets.flows) await consider('flow', flow.id, flow);
  for (const execution of targets.plannedExecutions) await consider('plannedExecution', execution.id, execution);

  // A server's stored record has no name inside it: the name is its key.
  for (const change of plan.forward.mcpServers) {
    if (change.value) {
      const { name: _name, ...record } = change.value;
      change.value = record;
    }
  }

  // What the file no longer mentions.
  const allFlows = await flowService.loadFlows();
  const localFlowText = allFlows
    .filter((flow) => !targets.flows.some((target) => target.id === flow.id) && !durable.ledger[ledgerKey('flow', flow.id)])
    .map((flow) => JSON.stringify(flow));
  const localExecutions = (await getSchedulerService().list())
    .filter(({ execution }) => !durable.ledger[ledgerKey('plannedExecution', execution.id)]);
  const stillUsed = (kind: ManagedKind, id: string): boolean => {
    if (kind === 'plannedExecution') return false;
    const quoted = JSON.stringify(id);
    if (localFlowText.some((text) => text.includes(quoted))) return true;
    if (kind === 'flow') return localExecutions.some(({ execution }) => execution.flowId === id);
    if (kind === 'model') {
      return rawModels.some((model) => !durable.ledger[ledgerKey('model', model.id)] && model.fallbackPolicy?.modelIds.includes(id));
    }
    return false;
  };

  for (const entry of Object.values(durable.ledger)) {
    const key = ledgerKey(entry.kind, entry.id);
    if (targetKeys.has(key)) continue;
    if (entry.kind === 'secret') {
      // A secret may be used by something local and an earlier version may need it again.
      plan.changes.push({ kind: 'secret', id: entry.id, action: 'unmanage', reason: 'No longer in the file. Secrets are never deleted by a file, so it stays in the secret store.' });
      continue;
    }
    if (entry.kind === 'setting') {
      const previous = rollbackFrom?.undo.settings.find((item) => item.path.join('.') === entry.id);
      const path = entry.id.split('.');
      const found = settingValue(settingsDocument, path);
      if (!previous) {
        plan.changes.push({ kind: 'setting', id: entry.id, action: 'unmanage', reason: 'No longer in the file, so it keeps its current value.' });
        continue;
      }
      if (policy.localEdits === 'keep' && (found.exists ? fingerprint('setting', found.value) : null) !== entry.appliedHash) {
        plan.changes.push({ kind: 'setting', id: entry.id, action: 'keep-local-edit', reason: 'Changed on this instance. policy.localEdits is "keep", so it stays as it is.' });
        continue;
      }
      if (canonicalJson(previous.exists ? previous.value : null) === canonicalJson(found.exists ? found.value : null)) continue;
      plan.writes = true;
      plan.changes.push({ kind: 'setting', id: entry.id, action: 'restore' });
      plan.forward.settings.push(previous);
      plan.reverse.settings.push({ path, exists: found.exists, ...(found.exists ? { value: found.value } : {}) });
      continue;
    }
    const stored = await readStored(entry.kind, entry.id);
    if (stored === null) continue;
    const edited = fingerprint(entry.kind, stored) !== entry.appliedHash;
    if (edited && policy.localEdits === 'keep') {
      plan.changes.push({ kind: entry.kind, id: entry.id, action: 'keep-local-edit', reason: 'No longer in the file but changed on this instance, so it stays and is no longer managed.' });
      continue;
    }
    if (rollbackFrom) {
      const adopted = rollbackFrom.undo.adopted;
      const before = entry.kind === 'model' ? adopted.models.find((item) => item.id === entry.id)?.value
        : entry.kind === 'mcpServer' ? adopted.mcpServers.find((item) => item.name === entry.id)?.value
        : entry.kind === 'flow' ? adopted.flows.find((item) => item.id === entry.id)?.value
        : adopted.plannedExecutions.find((item) => item.id === entry.id)?.value;
      if (before) {
        plan.writes = true;
        plan.changes.push({ kind: entry.kind, id: entry.id, action: 'restore', reason: 'This version took it over. It goes back to how it was and is no longer managed.' });
        write(entry.kind, entry.id, before);
        remember(entry.kind, entry.id, plan.reverse, stored);
        continue;
      }
    } else if (policy.removedObjects === 'keep') {
      plan.changes.push({ kind: entry.kind, id: entry.id, action: 'unmanage', reason: 'No longer in the file. policy.removedObjects is "keep", so it stays and is no longer managed.' });
      continue;
    }
    if (stillUsed(entry.kind, entry.id)) {
      plan.changes.push({ kind: entry.kind, id: entry.id, action: 'unmanage', reason: 'No longer in the file, but something created on this instance uses it, so it stays and is no longer managed.' });
      continue;
    }
    plan.writes = true;
    plan.changes.push({ kind: entry.kind, id: entry.id, action: 'delete' });
    write(entry.kind, entry.id, null);
    remember(entry.kind, entry.id, plan.reverse, stored);
  }
  return plan;
}
