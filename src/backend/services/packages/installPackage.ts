/**
 * Package install orchestrator (issue #198).
 *
 * The single source of truth that BOTH the REST route and (eventually) the
 * Browse-tab UI call. Pure orchestration — no HTTP concerns. It sequences:
 *
 *   fetch + validate manifest
 *     -> (consent preview, when not yet granted)
 *     -> MCP servers (by reference)
 *     -> models
 *     -> flows (fresh, deterministic ids + reference remapping)
 *     -> planned executions (remapped flowId, created DISABLED)
 *     -> summary
 *
 * Fail-soft: a missing REQUIRED secret disables the dependent entity instead of
 * aborting the whole install; only an invalid manifest or a fetch failure fails
 * the install outright. Idempotent: re-installing the same package updates
 * entities in place (deterministic ids for flows / planned executions; display
 * name for models; server name for MCP servers) rather than duplicating them.
 *
 * Secrets posture: secret VALUES are used to build env / API keys and are NEVER
 * written to the summary, the ledger, or any log.
 */
import { createHash } from 'crypto';
// eslint-disable-next-line import/named
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '@/utils/logger';
import { loadItem, saveItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import {
  parsePackageManifest,
  PackageManifest,
  ManifestFlow,
} from '@/shared/types/packages/manifest';
import { fetchPackageManifest } from './packageRegistry';
import { installRegistryServer } from '@/backend/services/mcp/registryInstall';
import { modelService } from '@/backend/services/model';
import { flowService } from '@/backend/services/flow';
import { mcpService } from '@/backend/services/mcp';
import { getSchedulerService } from '@/backend/services/scheduler';
import type { Model } from '@/shared/types/model';
import type { ModelProvider } from '@/shared/types/model/provider';
import type { Flow } from '@/shared/types/flow';
import type { MCPServerConfig } from '@/shared/types/mcp';

const log = createLogger('backend/services/packages/installPackage');

export type PackageEntityType = 'server' | 'model' | 'flow' | 'plannedExecution';

export interface InstallEntityRef {
  type: PackageEntityType;
  /** Human-readable name (localName / displayName / flow name / execution name). */
  name: string;
  /** The id the entity was persisted under, when applicable. */
  id?: string;
  /** Why an entity was skipped or left disabled. */
  note?: string;
}

export interface InstallServerResult {
  localName: string;
  source: string;
  installed: boolean;
  serverName?: string;
  alreadyExisted?: boolean;
  disabled?: boolean;
  needsEnv?: string[];
  error?: string;
}

export interface InstallPreview {
  servers: Array<{ localName: string; source: string; requiredEnvMissing: string[] }>;
  models: Array<{ displayName: string; apiKeyFrom?: string; missingRequiredSecret?: boolean }>;
  flows: Array<{ name: string }>;
  plannedExecutions: Array<{ name: string }>;
  secrets: Array<{ key: string; label?: string; required: boolean; provided: boolean }>;
}

export interface InstallSummary {
  ok: boolean;
  dryRun: boolean;
  package?: { name: string; version: string; publisher?: string };
  /** Present on a dry-run (consent preview). */
  preview?: InstallPreview;
  created: InstallEntityRef[];
  updated: InstallEntityRef[];
  skipped: InstallEntityRef[];
  /** Entities installed but left disabled (missing required secret). */
  disabled: InstallEntityRef[];
  servers: InstallServerResult[];
  errors: string[];
}

export interface InstallPackageInput {
  source: 'registry';
  packageId: string;
  version?: string;
  /** Secret values keyed by manifest secret key. Never logged / persisted. */
  secrets?: Record<string, string>;
  /**
   * When false (or omitted) the orchestrator performs a DRY RUN: it validates
   * the manifest and returns a consent preview WITHOUT mutating anything. The
   * REST route passes `true` (the request itself is the consent).
   */
  consentGranted?: boolean;
}

interface PackageInstallRecord {
  packageName: string;
  version: string;
  installedAt: string;
  summary: InstallSummary;
  entities: {
    flows: Record<string, string>;
    models: Record<string, string>;
    servers: string[];
    plannedExecutions: string[];
  };
}
type PackageInstallsFile = Record<string, PackageInstallRecord>;

// ---------------------------------------------------------------------------
// Deterministic ids (idempotent re-installs)
// ---------------------------------------------------------------------------

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function shortHash(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 8);
}

/** Flow ids must match /^[A-Za-z0-9_-]{1,64}$/ (assertSafeCollectionId). */
export function deterministicFlowId(packageName: string, localId: string): string {
  const base = `pkg-${slug(packageName)}-${slug(localId)}`;
  const safe = base.replace(/[^A-Za-z0-9_-]/g, '-');
  if (safe.length <= 64) return safe;
  return `${safe.slice(0, 55)}-${shortHash(`${packageName}::${localId}`)}`;
}

/** Planned-execution ids allow /^[A-Za-z0-9._:-]{1,128}$/. */
export function deterministicExecutionId(packageName: string, name: string): string {
  const base = `pkg-${slug(packageName)}-${slug(name)}`;
  const safe = base.replace(/[^A-Za-z0-9._:-]/g, '-');
  return safe.slice(0, 128);
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function installPackage(input: InstallPackageInput): Promise<InstallSummary> {
  const empty = (): InstallSummary => ({
    ok: false,
    dryRun: input.consentGranted !== true,
    created: [],
    updated: [],
    skipped: [],
    disabled: [],
    servers: [],
    errors: [],
  });

  if (input.source !== 'registry') {
    const s = empty();
    s.errors.push(`Unsupported package source: ${String(input.source)}`);
    return s;
  }

  // 1. Fetch the manifest.
  let raw: unknown;
  try {
    raw = await fetchPackageManifest(input.packageId, input.version);
  } catch (err) {
    const s = empty();
    s.errors.push(`Failed to fetch package "${input.packageId}": ${err instanceof Error ? err.message : String(err)}`);
    return s;
  }

  // 2. Validate.
  const parsed = parsePackageManifest(raw);
  if (!parsed.ok) {
    const s = empty();
    s.errors.push('Invalid package manifest.', ...parsed.errors);
    return s;
  }
  const manifest = parsed.manifest;

  const secrets = input.secrets ?? {};
  const secretProvided = (key: string): boolean =>
    Object.prototype.hasOwnProperty.call(secrets, key) && `${secrets[key] ?? ''}`.length > 0;
  const secretRequired = (key: string): boolean =>
    (manifest.secrets ?? []).some((s) => s.key === key && s.required === true);

  // 3. Consent preview (dry-run): no mutations.
  if (input.consentGranted !== true) {
    return {
      ok: true,
      dryRun: true,
      package: { name: manifest.name, version: manifest.version, ...(manifest.publisher ? { publisher: manifest.publisher } : {}) },
      preview: buildPreview(manifest, secretProvided),
      created: [],
      updated: [],
      skipped: [],
      disabled: [],
      servers: [],
      errors: [],
    };
  }

  const summary: InstallSummary = {
    ok: true,
    dryRun: false,
    package: { name: manifest.name, version: manifest.version, ...(manifest.publisher ? { publisher: manifest.publisher } : {}) },
    created: [],
    updated: [],
    skipped: [],
    disabled: [],
    servers: [],
    errors: [],
  };

  const ledgerEntities: PackageInstallRecord['entities'] = {
    flows: {},
    models: {},
    servers: [],
    plannedExecutions: [],
  };

  // 4. MCP servers (before flows so name-based boundServer references resolve).
  for (const server of manifest.mcpServers ?? []) {
    await installServer(server, { secrets, secretProvided, secretRequired, summary, ledgerEntities });
  }

  // 5. Models (before flows so name-based boundModel references resolve).
  for (const model of manifest.models ?? []) {
    await installModel(model, { secrets, secretProvided, secretRequired, summary, ledgerEntities });
  }

  // 6. Flows — fresh deterministic ids + internal reference remapping.
  const flowIdMap = await installFlows(manifest, summary, ledgerEntities);

  // 7. Planned executions — remapped flowId, created DISABLED.
  for (const pe of manifest.plannedExecutions ?? []) {
    await installPlannedExecution(pe, manifest.name, flowIdMap, summary, ledgerEntities);
  }

  // 8. Persist the ledger (idempotency + last-summary for the status endpoint).
  try {
    const file = await loadItem<PackageInstallsFile>(StorageKey.PACKAGE_INSTALLS, {});
    file[manifest.name] = {
      packageName: manifest.name,
      version: manifest.version,
      installedAt: new Date().toISOString(),
      summary,
      entities: ledgerEntities,
    };
    await saveItem(StorageKey.PACKAGE_INSTALLS, file);
  } catch (err) {
    log.warn('installPackage: failed to persist install ledger', err);
  }

  return summary;
}

/** Read the last recorded install summary for a package (status endpoint). */
export async function getLastInstallSummary(packageName: string): Promise<InstallSummary | null> {
  const file = await loadItem<PackageInstallsFile>(StorageKey.PACKAGE_INSTALLS, {});
  return file[packageName]?.summary ?? null;
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

type ManifestServerEntry = NonNullable<PackageManifest['mcpServers']>[number];

function serverSource(server: ManifestServerEntry): string {
  return server.ref.kind === 'registry' ? `registry:${server.ref.registryName}` : `remote:${server.ref.serverUrl}`;
}

function buildPreview(manifest: PackageManifest, secretProvided: (k: string) => boolean): InstallPreview {
  return {
    servers: (manifest.mcpServers ?? []).map((s) => ({
      localName: s.localName,
      source: serverSource(s),
      requiredEnvMissing: Object.entries(s.envFromSecret ?? {})
        .filter(([, key]) => (manifest.secrets ?? []).some((sec) => sec.key === key && sec.required) && !secretProvided(key))
        .map(([envName]) => envName),
    })),
    models: (manifest.models ?? []).map((m) => ({
      displayName: m.displayName,
      ...(m.apiKeyGlobalVar ? { apiKeyFrom: `\${global:${m.apiKeyGlobalVar}}` } : m.apiKeySecret ? { apiKeyFrom: `secret:${m.apiKeySecret}` } : {}),
      ...(m.apiKeySecret && (manifest.secrets ?? []).some((sec) => sec.key === m.apiKeySecret && sec.required) && !secretProvided(m.apiKeySecret)
        ? { missingRequiredSecret: true }
        : {}),
    })),
    flows: (manifest.flows ?? []).map((f) => ({ name: f.name })),
    plannedExecutions: (manifest.plannedExecutions ?? []).map((p) => ({ name: p.name })),
    secrets: (manifest.secrets ?? []).map((s) => ({
      key: s.key,
      ...(s.label ? { label: s.label } : {}),
      required: s.required === true,
      provided: secretProvided(s.key),
    })),
  };
}

// ---------------------------------------------------------------------------
// Per-entity install helpers
// ---------------------------------------------------------------------------

interface InstallCtx {
  secrets: Record<string, string>;
  secretProvided: (key: string) => boolean;
  secretRequired: (key: string) => boolean;
  summary: InstallSummary;
  ledgerEntities: PackageInstallRecord['entities'];
}

async function installServer(
  server: NonNullable<PackageManifest['mcpServers']>[number],
  ctx: InstallCtx,
): Promise<void> {
  const { secrets, secretProvided, secretRequired, summary, ledgerEntities } = ctx;
  const source = serverSource(server);

  // Resolve env: literal values + values pulled from provided secrets. A missing
  // REQUIRED secret disables the server instead of failing the whole install.
  const env: Record<string, string> = { ...(server.env ?? {}) };
  const missingRequired: string[] = [];
  for (const [envName, secretKey] of Object.entries(server.envFromSecret ?? {})) {
    if (secretProvided(secretKey)) {
      env[envName] = secrets[secretKey];
    } else if (secretRequired(secretKey)) {
      missingRequired.push(envName);
    }
  }

  if (server.ref.kind === 'registry') {
    if (missingRequired.length > 0) {
      summary.disabled.push({ type: 'server', name: server.localName, note: `missing required secret(s) for: ${missingRequired.join(', ')}` });
      summary.servers.push({ localName: server.localName, source, installed: false, needsEnv: missingRequired });
      return;
    }
    const result = await installRegistryServer(server.ref.registryName, env);
    const entry: InstallServerResult = {
      localName: server.localName,
      source,
      installed: result.installed,
      ...(result.serverName ? { serverName: result.serverName } : {}),
      ...(result.alreadyExisted ? { alreadyExisted: true } : {}),
      ...(result.needsEnv ? { needsEnv: result.needsEnv } : {}),
      ...(result.error ? { error: result.error } : {}),
    };
    summary.servers.push(entry);
    if (result.installed) {
      if (result.serverName) ledgerEntities.servers.push(result.serverName);
      const ref: InstallEntityRef = { type: 'server', name: server.localName, ...(result.serverName ? { id: result.serverName } : {}) };
      if (result.alreadyExisted) summary.updated.push(ref);
      else summary.created.push(ref);
    } else {
      summary.skipped.push({ type: 'server', name: server.localName, note: result.error ?? (result.needsEnv ? `needs env: ${result.needsEnv.join(', ')}` : 'not installed') });
    }
    return;
  }

  // Remote (sse / streamable / websocket) — plain config creation. Install
  // DISABLED when a required secret is missing (rather than dropping it).
  const disabled = missingRequired.length > 0;
  try {
    const config = buildRemoteServerConfig(server, env, disabled);
    const saved = await mcpService.updateServerConfig(server.localName, config);
    const failed = !Array.isArray(saved) && saved && 'success' in saved && (saved as { success?: boolean }).success === false;
    if (failed) {
      const error = (saved as { error?: string }).error ?? 'unknown error';
      summary.servers.push({ localName: server.localName, source, installed: false, error });
      summary.skipped.push({ type: 'server', name: server.localName, note: error });
      return;
    }
    ledgerEntities.servers.push(server.localName);
    summary.servers.push({ localName: server.localName, source, installed: true, serverName: server.localName, ...(disabled ? { disabled: true, needsEnv: missingRequired } : {}) });
    const ref: InstallEntityRef = { type: 'server', name: server.localName, id: server.localName };
    if (disabled) summary.disabled.push({ ...ref, note: `installed disabled — missing required secret(s) for: ${missingRequired.join(', ')}` });
    else summary.created.push(ref);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    summary.servers.push({ localName: server.localName, source, installed: false, error });
    summary.skipped.push({ type: 'server', name: server.localName, note: error });
  }
}

function buildRemoteServerConfig(
  server: NonNullable<PackageManifest['mcpServers']>[number],
  env: Record<string, string>,
  disabled: boolean,
): MCPServerConfig {
  if (server.ref.kind !== 'remote') {
    throw new Error('buildRemoteServerConfig called for a non-remote ref');
  }
  const transport = server.ref.transport ?? 'streamable';
  const base = {
    name: server.localName,
    disabled,
    autoApprove: [] as string[],
    rootPath: '',
    env: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, { value: v }])),
    _buildCommand: '',
    _installCommand: '',
  };
  if (transport === 'websocket') {
    return { ...base, transport: 'websocket', websocketUrl: server.ref.serverUrl } as MCPServerConfig;
  }
  return { ...base, transport, serverUrl: server.ref.serverUrl } as MCPServerConfig;
}

async function installModel(
  model: NonNullable<PackageManifest['models']>[number],
  ctx: InstallCtx,
): Promise<void> {
  const { secrets, secretProvided, secretRequired, summary, ledgerEntities } = ctx;

  // Resolve the API key: global-var binding, provided secret, or empty (a
  // missing REQUIRED secret installs the model DISABLED, i.e. keyless).
  let apiKey = '';
  let disabledNote: string | undefined;
  if (model.apiKeyGlobalVar) {
    apiKey = `\${global:${model.apiKeyGlobalVar}}`;
  } else if (model.apiKeySecret) {
    if (secretProvided(model.apiKeySecret)) {
      apiKey = secrets[model.apiKeySecret];
    } else if (secretRequired(model.apiKeySecret)) {
      disabledNote = `installed without an API key — missing required secret "${model.apiKeySecret}"`;
    }
  }

  const fields: Partial<Model> = {
    name: model.name,
    displayName: model.displayName,
    ...(model.provider ? { provider: model.provider as ModelProvider } : {}),
    ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
    ...(model.description ? { description: model.description } : {}),
    ...(model.promptTemplate ? { promptTemplate: model.promptTemplate } : {}),
    ...(model.temperature ? { temperature: model.temperature } : {}),
    ApiKey: apiKey,
  };

  const existing = (await modelService.loadModels()).find(
    (m) => (m.displayName ?? '').toLowerCase() === model.displayName.toLowerCase(),
  );

  if (existing) {
    const res = await modelService.updateModel({ ...existing, ...fields, id: existing.id } as Model);
    if (res.success) {
      ledgerEntities.models[model.displayName] = existing.id;
      const ref: InstallEntityRef = { type: 'model', name: model.displayName, id: existing.id };
      if (disabledNote) summary.disabled.push({ ...ref, note: disabledNote });
      else summary.updated.push(ref);
    } else {
      summary.skipped.push({ type: 'model', name: model.displayName, note: res.error });
    }
    return;
  }

  const id = uuidv4();
  const res = await modelService.addModel({ id, ...fields } as Model);
  if (res.success) {
    ledgerEntities.models[model.displayName] = id;
    const ref: InstallEntityRef = { type: 'model', name: model.displayName, id };
    if (disabledNote) summary.disabled.push({ ...ref, note: disabledNote });
    else summary.created.push(ref);
  } else {
    summary.skipped.push({ type: 'model', name: model.displayName, note: res.error });
  }
}

async function installFlows(
  manifest: PackageManifest,
  summary: InstallSummary,
  ledgerEntities: PackageInstallRecord['entities'],
): Promise<Record<string, string>> {
  const flows = manifest.flows ?? [];
  // Build the manifest-local-id -> installed-id map first, so cross-flow
  // (subflow) references can be remapped regardless of flow order.
  const idMap: Record<string, string> = {};
  for (const f of flows) {
    idMap[f.id] = deterministicFlowId(manifest.name, f.id);
  }

  const existingIds = new Set((await flowService.loadFlows()).map((f) => f.id));

  for (const manifestFlow of flows) {
    const newId = idMap[manifestFlow.id];
    const flow = remapFlow(manifestFlow, newId, idMap);
    const wasPresent = existingIds.has(newId);
    const res = await flowService.saveFlow(flow);
    if (res.success) {
      ledgerEntities.flows[manifestFlow.id] = newId;
      const ref: InstallEntityRef = { type: 'flow', name: manifestFlow.name, id: newId };
      if (wasPresent) summary.updated.push(ref);
      else summary.created.push(ref);
    } else {
      summary.skipped.push({ type: 'flow', name: manifestFlow.name, note: res.error });
    }
  }
  return idMap;
}

/** Deep-clone a manifest flow, assign the fresh id, and remap subflow refs. */
function remapFlow(manifestFlow: ManifestFlow, newId: string, idMap: Record<string, string>): Flow {
  const clone = JSON.parse(JSON.stringify(manifestFlow)) as Flow & { nodes: Array<{ data?: { properties?: Record<string, unknown> } }> };
  clone.id = newId;
  // Do not carry manifest-authored timestamps; saveFlow re-stamps them.
  delete (clone as { createdAt?: number }).createdAt;
  delete (clone as { updatedAt?: number }).updatedAt;

  for (const node of clone.nodes ?? []) {
    const props = node?.data?.properties;
    if (!props) continue;
    if (typeof props.subflowId === 'string' && idMap[props.subflowId]) {
      props.subflowId = idMap[props.subflowId];
    }
    if (Array.isArray(props.parallelSubflowIds)) {
      props.parallelSubflowIds = props.parallelSubflowIds.map((id: unknown) =>
        typeof id === 'string' && idMap[id] ? idMap[id] : id,
      );
    }
  }
  return clone as Flow;
}

async function installPlannedExecution(
  pe: NonNullable<PackageManifest['plannedExecutions']>[number],
  packageName: string,
  flowIdMap: Record<string, string>,
  summary: InstallSummary,
  ledgerEntities: PackageInstallRecord['entities'],
): Promise<void> {
  const scheduler = getSchedulerService();
  const id = deterministicExecutionId(packageName, pe.name);
  const mappedFlowId = flowIdMap[pe.flowId] ?? pe.flowId;

  // Strip manifest-local id/timestamps; force enabled:false; remap flowId.
  const { flowId: _fid, ...rest } = pe as Record<string, unknown> & { flowId: string };
  const config = {
    ...rest,
    id,
    flowId: mappedFlowId,
    enabled: false,
  } as Parameters<typeof scheduler.create>[0];

  const created = await scheduler.create(config);
  if (created.execution) {
    ledgerEntities.plannedExecutions.push(id);
    summary.created.push({ type: 'plannedExecution', name: pe.name, id });
    summary.disabled.push({ type: 'plannedExecution', name: pe.name, id, note: 'created disabled — enable it after review' });
    return;
  }

  if (created.conflict) {
    // Idempotent re-install: update the existing execution in place.
    const { id: _id, ...patch } = config as Record<string, unknown>;
    const updated = await scheduler.update(id, patch as Parameters<typeof scheduler.update>[1]);
    if (updated.execution) {
      ledgerEntities.plannedExecutions.push(id);
      summary.updated.push({ type: 'plannedExecution', name: pe.name, id });
      summary.disabled.push({ type: 'plannedExecution', name: pe.name, id, note: 'updated (disabled) — enable it after review' });
    } else {
      summary.skipped.push({ type: 'plannedExecution', name: pe.name, note: updated.error });
    }
    return;
  }

  summary.skipped.push({ type: 'plannedExecution', name: pe.name, note: created.error });
}
