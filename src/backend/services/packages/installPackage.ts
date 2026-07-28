/**
 * Package install orchestrator (issue #198).
 *
 * The single source of truth that BOTH the REST route and the Browse-tab UI
 * call. Pure orchestration — no HTTP concerns. It sequences:
 *
 *   fetch + validate manifest (against the real #192 `flujoPackageSchema` /
 *   `FlujoPackage` — NOT a separate ad hoc schema; see note below)
 *     -> (consent preview, when not yet granted)
 *     -> MCP servers (by reference)
 *     -> models
 *     -> flows (fresh, deterministic ids + reference remapping)
 *     -> planned executions (remapped flowId, created DISABLED)
 *     -> summary
 *
 * NOTE: this used to validate against a bespoke schema in
 * `@/shared/types/packages/manifest` (plural "packages") that was never
 * reconciled with the actual #192 manifest format the publish side
 * (`buildPackage.ts` / the wizard, `@/shared/types/package` singular) produces
 * — every real published package failed "Invalid package manifest" on
 * install. Fixed by validating with `flujoPackageSchema` / `FlujoPackage`
 * (the same types the wizard and registry backstop already use) instead.
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
import { validatePackage } from '@/shared/types/package/package.serialize';
import { SECRET_PLACEHOLDER_REGEX } from '@/shared/types/package/constants';
import type {
  FlujoPackage,
  PackagedFlow,
  PackagedMcpServer,
  PackagedModel,
  PackagedPlannedExecution,
} from '@/shared/types/package/package';
import type { EnvDeclaration } from '@/shared/types/package/installOrigin';
import { fetchPackageManifest } from './packageRegistry';
import { installRegistryServer } from '@/backend/services/mcp/registryInstall';
import { modelService } from '@/backend/services/model';
import { flowService } from '@/backend/services/flow';
import { mcpService } from '@/backend/services/mcp';
import { getSchedulerService } from '@/backend/services/scheduler';
import type { Model } from '@/shared/types/model';
import type { ModelProvider } from '@/shared/types/model/provider';
import type { Flow } from '@/shared/types/flow';
import type { MCPServerConfig, EnvVarValue, MCPHeaderValue } from '@/shared/types/mcp';

const log = createLogger('backend/services/packages/installPackage');

export type PackageEntityType = 'server' | 'model' | 'flow' | 'plannedExecution';

export interface InstallEntityRef {
  type: PackageEntityType;
  /** Human-readable name (server name / displayName / flow name / execution name). */
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
  models: Array<{ id: string; displayName: string; apiKeyFrom?: string; missingRequiredSecret?: boolean }>;
  installedModels: Array<{ id: string; displayName: string; name: string }>;
  flows: Array<{ name: string }>;
  plannedExecutions: Array<{ name: string }>;
  secrets: Array<{ key: string; label?: string; required: boolean; provided: boolean }>;
  /**
   * `${global:VAR}` names this package expects the host to already have set
   * (in Settings), that are NOT currently set. Unlike `secrets[]` these are
   * host-level config, not something install can collect a value for — the
   * consent screen surfaces them so the user knows to set them afterwards.
   */
  missingGlobals: string[];
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
  /** `requiredGlobals` names that are still unset on this host after install. */
  missingGlobals: string[];
}

export interface InstallPackageInput {
  source: 'registry';
  packageId: string;
  version?: string;
  /** Secret values keyed by manifest secret name. Never logged / persisted. */
  secrets?: Record<string, string>;
  /** Package-local model id -> id of an already installed model to substitute. */
  modelMappings?: Record<string, string>;
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
  /**
   * Per-entity provenance (issue #211): the ids the install NEWLY CREATED, as
   * opposed to entities it merely adopted/updated in place (e.g. a pre-existing
   * model matched by displayName). Uninstall only deletes created entities.
   * Optional so ledgers written before this field (3.27.0) still parse.
   */
  created?: {
    flows: string[];               // installed flow ids newly created
    models: string[];              // model ids newly created (addModel)
    servers: string[];             // server names newly installed
    plannedExecutions: string[];   // execution ids newly created (no conflict)
  };
}
type PackageInstallsFile = Record<string, PackageInstallRecord>;
type LedgerCreated = NonNullable<PackageInstallRecord['created']>;

// ---------------------------------------------------------------------------
// Uninstall (issue #211)
// ---------------------------------------------------------------------------

export interface PackageEntityRef {
  kind: 'flow' | 'model' | 'server' | 'plannedExecution';
  /** Entity id (server name for MCP servers). */
  id: string;
  /** Human-friendly label (displayName / flow name), when known. */
  label?: string;
  /** Why it was skipped / errored (e.g. 'not found', 'adopted-not-created'). */
  reason?: string;
}

export interface UninstallSummary {
  packageName: string;
  /** false when at least one delete primitive returned a hard error. */
  ok: boolean;
  hasErrors: boolean;
  removed: PackageEntityRef[];   // entities actually deleted
  skipped: PackageEntityRef[];   // already gone, or intentionally preserved
  errors: PackageEntityRef[];    // delete primitive returned success:false (real error)
}

export interface InstalledPackageInfo {
  packageName: string;
  version: string;
  installedAt: string;
  entityCounts: { flows: number; models: number; servers: number; plannedExecutions: number };
}

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
// Secret-placeholder resolution ({{secret.NAME}} -> the supplied value)
// ---------------------------------------------------------------------------

/**
 * Deep-replace every `{{secret.NAME}}` occurrence in a value with the supplied
 * secret's value. A placeholder whose secret wasn't provided is left as-is
 * (fail-soft, matching the rest of the install posture — the dependent entity
 * still installs, just with the placeholder unresolved).
 */
function resolveSecretPlaceholders<T>(value: T, secrets: Record<string, string>): T {
  if (typeof value === 'string') {
    if (!value.includes('{{secret.')) return value;
    const re = new RegExp(SECRET_PLACEHOLDER_REGEX.source, 'g');
    return value.replace(re, (match, name: string) =>
      Object.prototype.hasOwnProperty.call(secrets, name) ? secrets[name] : match,
    ) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => resolveSecretPlaceholders(v, secrets)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveSecretPlaceholders(v, secrets);
    }
    return out as unknown as T;
  }
  return value;
}

// ---------------------------------------------------------------------------
// requiredGlobals (host `${global:VAR}` bindings the package expects)
// ---------------------------------------------------------------------------

/** Which of `requiredGlobals` are NOT currently set as a host global env var. */
async function computeMissingGlobals(requiredGlobals: string[] | undefined): Promise<string[]> {
  if (!requiredGlobals || requiredGlobals.length === 0) return [];
  const stored = await loadItem<Record<string, unknown>>(StorageKey.GLOBAL_ENV_VARS, {});
  return requiredGlobals.filter((name) => !Object.prototype.hasOwnProperty.call(stored, name));
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
    missingGlobals: [],
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

  // 2. Validate against the real #192 schema.
  const parsed = validatePackage(raw);
  if (!parsed.success || !parsed.data) {
    const s = empty();
    s.errors.push('Invalid package manifest.', ...(parsed.errors ?? []));
    return s;
  }
  const manifest = parsed.data;

  const secrets = input.secrets ?? {};
  const secretProvided = (name: string): boolean =>
    Object.prototype.hasOwnProperty.call(secrets, name) && `${secrets[name] ?? ''}`.length > 0;
  const secretRequired = (name: string): boolean =>
    (manifest.secrets ?? []).some((s) => s.name === name && s.required === true);

  // 3. Consent preview (dry-run): no mutations.
  if (input.consentGranted !== true) {
    return {
      ok: true,
      dryRun: true,
      package: { name: manifest.name, version: manifest.version, ...(manifest.publisher ? { publisher: manifest.publisher } : {}) },
      preview: {
        ...await buildPreview(manifest, secretProvided),
        missingGlobals: await computeMissingGlobals(manifest.requiredGlobals),
      },
      created: [],
      updated: [],
      skipped: [],
      disabled: [],
      servers: [],
      errors: [],
      missingGlobals: [],
    };
  }

  const installedModels = await modelService.loadModels();
  const packageModelIds = new Set((manifest.models ?? []).map((model) => model.id));
  const installedModelsById = new Map(installedModels.map((model) => [model.id, model]));
  for (const [packageModelId, installedModelId] of Object.entries(input.modelMappings ?? {})) {
    if (!packageModelIds.has(packageModelId) || !installedModelsById.has(installedModelId)) {
      const s = empty();
      s.errors.push(`Invalid model mapping: "${packageModelId}" -> "${installedModelId}"`);
      return s;
    }
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
    missingGlobals: await computeMissingGlobals(manifest.requiredGlobals),
  };

  // Resolve {{secret.NAME}} placeholders in free-text content (prompts,
  // descriptions, promptTemplates, ...) BEFORE installing models/flows/planned
  // executions — otherwise the placeholder survives verbatim into the
  // installed entity instead of the value the user just supplied.
  const resolvedModels = (manifest.models ?? []).map((m) => resolveSecretPlaceholders(m, secrets));
  const resolvedFlows = (manifest.flows ?? []).map((f) => resolveSecretPlaceholders(f, secrets));
  const resolvedPlannedExecutions = (manifest.plannedExecutions ?? []).map((p) => resolveSecretPlaceholders(p, secrets));

  const ledgerEntities: PackageInstallRecord['entities'] = {
    flows: {},
    models: {},
    servers: [],
    plannedExecutions: [],
  };
  const ledgerCreated: LedgerCreated = {
    flows: [],
    models: [],
    servers: [],
    plannedExecutions: [],
  };

  // Snapshot MCP server names + configs that pre-exist BEFORE we install any,
  // so remote (upsert) servers can be classified created-vs-adopted for uninstall,
  // and registry servers with matching name can be adopted in place.
  const existingServerNames = new Set<string>();
  const existingServerConfigs = new Map<string, MCPServerConfig>();
  try {
    const configs = await mcpService.loadServerConfigs();
    if (Array.isArray(configs)) {
      for (const c of configs) {
        existingServerNames.add(c.name);
        existingServerConfigs.set(c.name, c);
      }
    }
  } catch (err) {
    log.warn('installPackage: failed to snapshot existing server names', err);
  }

  // 4. MCP servers (before flows so name-based boundServer references resolve).
  for (const server of manifest.mcpServers ?? []) {
    await installServer(server, { secrets, secretProvided, secretRequired, summary, ledgerEntities, ledgerCreated, existingServerNames, existingServerConfigs });
  }

  // 5. Models (before flows so id-based boundModel references resolve).
  //    modelIdMap: manifest-local model.id -> the installed model's real id,
  //    so flow nodes' `properties.boundModel` (which binds by id) can be
  //    remapped in step 6 — otherwise every process node bound to a packaged
  //    model comes out "unbound" after install (the model gets a fresh id).
  const modelIdMap: Record<string, { id: string; name: string }> = {};
  for (const model of resolvedModels) {
    const mappedModelId = input.modelMappings?.[model.id];
    if (mappedModelId) {
      const mappedModel = installedModelsById.get(mappedModelId)!;
      modelIdMap[model.id] = { id: mappedModel.id, name: mappedModel.name };
      summary.skipped.push({
        type: 'model',
        name: model.displayName || model.name,
        id: mappedModel.id,
        note: `substituted with installed model "${mappedModel.displayName || mappedModel.name}"`,
      });
      continue;
    }
    const installed = await installModel(model, { secrets, secretProvided, secretRequired, summary, ledgerEntities, ledgerCreated, existingServerNames, existingServerConfigs });
    if (installed) modelIdMap[model.id] = installed;
  }

  // 6. Flows — fresh deterministic ids + internal reference remapping.
  const flowIdMap = await installFlows(manifest.name, resolvedFlows, modelIdMap, summary, ledgerEntities, ledgerCreated);

  // 7. Planned executions — remapped flowId, created DISABLED.
  for (const pe of resolvedPlannedExecutions) {
    await installPlannedExecution(pe, manifest.name, flowIdMap, summary, ledgerEntities, ledgerCreated);
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
      created: ledgerCreated,
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

/** List every installed package recorded in the ledger (for the UI list). */
export async function listInstalledPackages(): Promise<InstalledPackageInfo[]> {
  const file = await loadItem<PackageInstallsFile>(StorageKey.PACKAGE_INSTALLS, {});
  return Object.values(file).map((record) => ({
    packageName: record.packageName,
    version: record.version,
    installedAt: record.installedAt,
    entityCounts: {
      flows: Object.keys(record.entities?.flows ?? {}).length,
      models: Object.keys(record.entities?.models ?? {}).length,
      servers: (record.entities?.servers ?? []).length,
      plannedExecutions: (record.entities?.plannedExecutions ?? []).length,
    },
  }));
}

// ---------------------------------------------------------------------------
// Uninstall orchestrator (issue #211)
// ---------------------------------------------------------------------------

/** A delete primitive's error text that means "the entity is already gone". */
function isNotFoundError(error: string | undefined): boolean {
  if (!error) return false;
  return /not found|no planned execution with id|does not exist/i.test(error);
}

/**
 * Reverse a package install (issue #211).
 *
 * Reads the install ledger and deletes ONLY the entities the install actually
 * CREATED — never entities it adopted/updated in place (e.g. a pre-existing
 * model matched by displayName). Fail-soft: an already-deleted entity is a
 * `skipped`, not an `error`; a single thrown exception can't abort the batch.
 * Idempotent: once the ledger entry is removed a second call is a clean no-op.
 *
 * Order: planned executions -> flows -> servers -> models (delete dependents
 * before dependencies; models last since flows may reference them).
 */
export async function uninstallPackage(packageName: string): Promise<UninstallSummary> {
  const summary: UninstallSummary = {
    packageName,
    ok: true,
    hasErrors: false,
    removed: [],
    skipped: [],
    errors: [],
  };

  const file = await loadItem<PackageInstallsFile>(StorageKey.PACKAGE_INSTALLS, {});
  const record = file[packageName];
  if (!record) {
    // Unknown package / already uninstalled: clean no-op.
    return summary;
  }

  const created = record.created;
  const hasProvenance = created !== undefined;

  // Classify a delete primitive's result into the symmetric summary.
  const classify = (
    res: { success: boolean; error?: string },
    ref: PackageEntityRef,
  ): void => {
    if (res.success) {
      summary.removed.push(ref);
    } else if (isNotFoundError(res.error)) {
      summary.skipped.push({ ...ref, reason: 'not found' });
    } else {
      summary.errors.push({ ...ref, reason: res.error ?? 'delete failed' });
    }
  };

  // Wrap a delete so a thrown exception becomes an errors[] entry, never aborts.
  const runDelete = async (
    ref: PackageEntityRef,
    fn: () => Promise<{ success: boolean; error?: string }>,
  ): Promise<void> => {
    try {
      classify(await fn(), ref);
    } catch (err) {
      summary.errors.push({ ...ref, reason: err instanceof Error ? err.message : String(err) });
    }
  };

  const scheduler = getSchedulerService();

  // 1. Planned executions. Package-owned deterministic ids: safe to remove even
  //    for legacy ledgers without provenance.
  for (const id of record.entities?.plannedExecutions ?? []) {
    const ref: PackageEntityRef = { kind: 'plannedExecution', id };
    if (hasProvenance && !created!.plannedExecutions.includes(id)) {
      summary.skipped.push({ ...ref, reason: 'adopted-not-created' });
      continue;
    }
    await runDelete(ref, () => scheduler.delete(id));
  }

  // 2. Flows. Package-owned deterministic ids: safe to remove even for legacy
  //    ledgers without provenance.
  for (const [localId, flowId] of Object.entries(record.entities?.flows ?? {})) {
    const ref: PackageEntityRef = { kind: 'flow', id: flowId, label: localId };
    if (hasProvenance && !created!.flows.includes(flowId)) {
      summary.skipped.push({ ...ref, reason: 'adopted-not-created' });
      continue;
    }
    await runDelete(ref, () => flowService.deleteFlow(flowId));
  }

  // 3. MCP servers. Registry servers use package-owned names; remote servers are
  //    an upsert on a package-declared name. Safe to remove for legacy ledgers.
  for (const name of record.entities?.servers ?? []) {
    const ref: PackageEntityRef = { kind: 'server', id: name };
    if (hasProvenance && !created!.servers.includes(name)) {
      summary.skipped.push({ ...ref, reason: 'adopted-not-created' });
      continue;
    }
    await runDelete(ref, () => mcpService.deleteServerConfig(name));
  }

  // 4. Models (last). CRITICAL: install ADOPTS pre-existing models by displayName
  //    and updates them in place — those must NEVER be deleted. Without
  //    provenance (legacy 3.27.0 ledger) we conservatively skip ALL models.
  for (const [displayName, modelId] of Object.entries(record.entities?.models ?? {})) {
    const ref: PackageEntityRef = { kind: 'model', id: modelId, label: displayName };
    if (!hasProvenance) {
      summary.skipped.push({ ...ref, reason: 'legacy-ledger-no-provenance' });
      continue;
    }
    if (!created!.models.includes(modelId)) {
      summary.skipped.push({ ...ref, reason: 'adopted-not-created' });
      continue;
    }
    await runDelete(ref, () => modelService.deleteModel(modelId));
  }

  summary.hasErrors = summary.errors.length > 0;
  summary.ok = !summary.hasErrors;

  // Fail-soft persistence: only drop the ledger entry when nothing hard-errored,
  // so the user can retry. On errors, keep the record for a retry.
  if (!summary.hasErrors) {
    try {
      const latest = await loadItem<PackageInstallsFile>(StorageKey.PACKAGE_INSTALLS, {});
      delete latest[packageName];
      await saveItem(StorageKey.PACKAGE_INSTALLS, latest);
    } catch (err) {
      log.warn('uninstallPackage: failed to delete ledger entry', err);
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

function serverSource(server: PackagedMcpServer): string {
  const origin = server.installOrigin;
  if (origin.sourceType === 'remote') return `remote:${origin.url}`;
  return `${origin.sourceType}:${origin.ref ?? origin.name ?? server.name}`;
}

/** Every secret name a server's env/header declarations reference. */
function serverSecretRefs(server: PackagedMcpServer): string[] {
  return [...server.envDeclarations, ...(server.headerDeclarations ?? [])]
    .map((d) => d.secretRef)
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
}

async function buildPreview(manifest: FlujoPackage, secretProvided: (name: string) => boolean): Promise<Omit<InstallPreview, 'missingGlobals'>> {
  const installedModels = await modelService.loadModels();
  return {
    servers: (manifest.mcpServers ?? []).map((s) => ({
      localName: s.name,
      source: serverSource(s),
      requiredEnvMissing: serverSecretRefs(s).filter(
        (name) => (manifest.secrets ?? []).some((sec) => sec.name === name && sec.required) && !secretProvided(name),
      ),
    })),
    models: (manifest.models ?? []).map((m) => ({
      id: m.id,
      displayName: m.displayName || m.name,
      ...(m.apiKeyRef.kind === 'global'
        ? { apiKeyFrom: `\${global:${m.apiKeyRef.var}}` }
        : m.apiKeyRef.kind === 'secret'
          ? { apiKeyFrom: `secret:${m.apiKeyRef.secret}` }
          : {}),
      ...(m.apiKeyRef.kind === 'secret' &&
        (manifest.secrets ?? []).some((sec) => sec.name === (m.apiKeyRef as { secret: string }).secret && sec.required) &&
        !secretProvided((m.apiKeyRef as { secret: string }).secret)
        ? { missingRequiredSecret: true }
        : {}),
    })),
    installedModels: installedModels.map((m) => ({
      id: m.id,
      displayName: m.displayName || m.name,
      name: m.name,
    })),
    flows: (manifest.flows ?? []).map((f) => ({ name: f.flow.name })),
    plannedExecutions: (manifest.plannedExecutions ?? []).map((p) => ({ name: p.name })),
    secrets: (manifest.secrets ?? []).map((s) => ({
      key: s.name,
      ...(s.description ? { label: s.description } : {}),
      required: s.required === true,
      provided: secretProvided(s.name),
    })),
  };
}

// ---------------------------------------------------------------------------
// Per-entity install helpers
// ---------------------------------------------------------------------------

interface InstallCtx {
  secrets: Record<string, string>;
  secretProvided: (name: string) => boolean;
  secretRequired: (name: string) => boolean;
  summary: InstallSummary;
  ledgerEntities: PackageInstallRecord['entities'];
  ledgerCreated: LedgerCreated;
  /** Server names that already existed before this install began. */
  existingServerNames: Set<string>;
  /** Full server configs snapshot taken before install began (for adopt-and-configure). */
  existingServerConfigs: Map<string, MCPServerConfig>;
}

/** Resolved env/header values for one packaged server, plus which required secrets are missing. */
function resolveDeclarations(
  declarations: EnvDeclaration[],
  ctx: Pick<InstallCtx, 'secrets' | 'secretProvided' | 'secretRequired'>,
): { values: Record<string, string>; secretNames: Set<string>; missingRequired: string[] } {
  const { secrets, secretProvided, secretRequired } = ctx;
  const values: Record<string, string> = {};
  const secretNames = new Set<string>();
  const missingRequired: string[] = [];

  for (const decl of declarations) {
    if (decl.secretRef) {
      if (secretProvided(decl.secretRef)) {
        values[decl.name] = secrets[decl.secretRef];
        if (decl.isSecret) secretNames.add(decl.name);
      } else if (secretRequired(decl.secretRef)) {
        missingRequired.push(decl.name);
      }
    } else if (decl.globalVar) {
      values[decl.name] = `\${global:${decl.globalVar}}`;
    }
    // Neither secretRef nor globalVar: nothing to resolve — the declaration is
    // metadata-only (e.g. documents a var the server reads from its own env).
  }
  return { values, secretNames, missingRequired };
}

/**
 * Adopt-and-configure: when a registry/marketplace-ref server's name already
 * exists in FLUJO, merge the manifest env into the existing config rather than
 * running a new registry install. Secret-derived values are tagged isSecret
 * for encryption at rest. The server is classified as `updated` (never
 * `created`) so uninstall will skip it.
 */
async function adoptAndConfigureServer(
  server: PackagedMcpServer,
  ctx: InstallCtx,
  missingRequired: string[],
  resolvedEnv: Record<string, string>,
  secretEnvNames: Set<string>,
): Promise<void> {
  const { summary, ledgerEntities, existingServerConfigs } = ctx;
  const source = serverSource(server);

  const existingConfig = existingServerConfigs.get(server.name);
  if (!existingConfig) {
    // Snapshot was stale — nothing to adopt; skip without error.
    summary.servers.push({ localName: server.name, source, installed: false,
      error: 'server vanished between snapshot and install' });
    summary.skipped.push({ type: 'server', name: server.name,
      note: 'server not found in configs (stale snapshot)' });
    return;
  }

  // Merge env: existing keys preserved, resolved declarations win (secret-backed
  // ones tagged isSecret for encryption at rest).
  const mergedEnv: Record<string, EnvVarValue> = { ...(existingConfig.env ?? {}) };
  for (const [envName, value] of Object.entries(resolvedEnv)) {
    mergedEnv[envName] = secretEnvNames.has(envName) ? { value, metadata: { isSecret: true } } : value;
  }

  const saved = await mcpService.updateServerConfig(
    server.name,
    { env: mergedEnv } as Partial<MCPServerConfig>,
  );
  const failed =
    !Array.isArray(saved) &&
    saved &&
    'success' in saved &&
    (saved as { success?: boolean }).success === false;
  if (failed) {
    const error = (saved as { error?: string }).error ?? 'unknown error';
    summary.servers.push({ localName: server.name, source, installed: false, error });
    summary.skipped.push({ type: 'server', name: server.name, note: error });
    return;
  }

  // Classify as updated (not created) — uninstall must never delete this server.
  ledgerEntities.servers.push(server.name);
  // NOTE: intentionally NOT adding to ledgerCreated.servers
  summary.servers.push({
    localName: server.name, source, installed: true,
    serverName: server.name, alreadyExisted: true,
  });
  const note = missingRequired.length > 0
    ? `env partially merged — missing required secret(s) for: ${missingRequired.join(', ')}`
    : undefined;
  summary.updated.push({
    type: 'server', name: server.name, id: server.name,
    ...(note ? { note } : {}),
  });
}

async function installServer(
  server: PackagedMcpServer,
  ctx: InstallCtx,
): Promise<void> {
  const { secrets, summary, ledgerEntities, ledgerCreated, existingServerNames } = ctx;
  const source = serverSource(server);
  const origin = server.installOrigin;

  const env = resolveDeclarations(server.envDeclarations, ctx);
  const headers = resolveDeclarations(server.headerDeclarations ?? [], ctx);
  const missingRequired = [...env.missingRequired, ...headers.missingRequired];

  const resolvedHeaders: Record<string, MCPHeaderValue> = {};
  for (const [headerName, value] of Object.entries(headers.values)) {
    resolvedHeaders[headerName] = headers.secretNames.has(headerName)
      ? { value, metadata: { isSecret: true } }
      : value;
  }

  if (origin.sourceType === 'github') {
    // No automated github clone/build install path exists server-side yet
    // (that flow currently only runs client-side in the GitHub tab wizard).
    summary.servers.push({ localName: server.name, source, installed: false,
      error: 'GitHub-sourced servers are not auto-installable yet — install manually from the MCP page' });
    summary.skipped.push({ type: 'server', name: server.name,
      note: 'GitHub-sourced servers require manual install' });
    return;
  }

  if (origin.sourceType === 'registry' || origin.sourceType === 'marketplace') {
    const registryName = origin.ref ?? origin.name;
    if (!registryName) {
      summary.servers.push({ localName: server.name, source, installed: false, error: 'missing registry ref' });
      summary.skipped.push({ type: 'server', name: server.name, note: 'installOrigin has no ref/name' });
      return;
    }

    // ADOPT-AND-CONFIGURE: if a server with this name already exists, merge env
    // into it rather than installing a new server from the registry.
    if (existingServerNames.has(server.name)) {
      await adoptAndConfigureServer(server, ctx, missingRequired, env.values, env.secretNames);
      return;
    }

    // NEW INSTALL: fail-soft if a required secret is missing.
    if (missingRequired.length > 0) {
      summary.disabled.push({ type: 'server', name: server.name, note: `missing required secret(s) for: ${missingRequired.join(', ')}` });
      summary.servers.push({ localName: server.name, source, installed: false, needsEnv: missingRequired });
      return;
    }
    const result = await installRegistryServer(registryName, env.values);
    const entry: InstallServerResult = {
      localName: server.name,
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
      const ref: InstallEntityRef = { type: 'server', name: server.name, ...(result.serverName ? { id: result.serverName } : {}) };
      if (result.alreadyExisted) summary.updated.push(ref);
      else {
        if (result.serverName) ledgerCreated.servers.push(result.serverName);
        summary.created.push(ref);
        // Tag secret-derived env keys as isSecret for encryption at rest.
        if (result.serverName && env.secretNames.size > 0) {
          await tagSecretEnvKeys(result.serverName, env.values, env.secretNames);
        }
      }
    } else {
      summary.skipped.push({ type: 'server', name: server.name, note: result.error ?? (result.needsEnv ? `needs env: ${result.needsEnv.join(', ')}` : 'not installed') });
    }
    return;
  }

  // Remote (sse / streamable / websocket) — plain config creation. Install
  // DISABLED when a required secret is missing (rather than dropping it).
  const disabled = missingRequired.length > 0;
  try {
    const config = buildRemoteServerConfig(server, env.values, disabled, resolvedHeaders, env.secretNames);
    const saved = await mcpService.updateServerConfig(server.name, config);
    const failed = !Array.isArray(saved) && saved && 'success' in saved && (saved as { success?: boolean }).success === false;
    if (failed) {
      const error = (saved as { error?: string }).error ?? 'unknown error';
      summary.servers.push({ localName: server.name, source, installed: false, error });
      summary.skipped.push({ type: 'server', name: server.name, note: error });
      return;
    }
    ledgerEntities.servers.push(server.name);
    // Remote servers are an upsert: classify created-vs-adopted from the
    // pre-install snapshot so uninstall never deletes a user's own server.
    if (!existingServerNames.has(server.name)) ledgerCreated.servers.push(server.name);
    summary.servers.push({ localName: server.name, source, installed: true, serverName: server.name, ...(disabled ? { disabled: true, needsEnv: missingRequired } : {}) });
    const ref: InstallEntityRef = { type: 'server', name: server.name, id: server.name };
    if (disabled) summary.disabled.push({ ...ref, note: `installed disabled — missing required secret(s) for: ${missingRequired.join(', ')}` });
    else summary.created.push(ref);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    summary.servers.push({ localName: server.name, source, installed: false, error });
    summary.skipped.push({ type: 'server', name: server.name, note: error });
  }
}

/**
 * Re-tag an already-installed server's secret-derived env entries as
 * `isSecret` so they are encrypted at rest. Fail-soft: a tagging failure is
 * logged but not fatal.
 */
async function tagSecretEnvKeys(
  serverName: string,
  envValues: Record<string, string>,
  secretNames: Set<string>,
): Promise<void> {
  if (secretNames.size === 0) return;
  const allConfigs = await mcpService.loadServerConfigs().catch(() => null);
  if (!Array.isArray(allConfigs)) return;
  const existing = allConfigs.find((c) => c.name === serverName);
  if (!existing) return;

  const updatedEnv: Record<string, EnvVarValue> = { ...(existing.env ?? {}) };
  let changed = false;
  for (const name of secretNames) {
    if (envValues[name] === undefined) continue;
    updatedEnv[name] = { value: envValues[name], metadata: { isSecret: true } };
    changed = true;
  }
  if (!changed) return;
  try {
    await mcpService.updateServerConfig(serverName, { env: updatedEnv } as Partial<MCPServerConfig>);
  } catch (err) {
    log.warn(`tagSecretEnvKeys: failed to re-tag secret env for "${serverName}"`, err);
  }
}

function buildRemoteServerConfig(
  server: PackagedMcpServer,
  env: Record<string, string>,
  disabled: boolean,
  headers: Record<string, MCPHeaderValue>,
  secretEnvNames: Set<string>,
): MCPServerConfig {
  const origin = server.installOrigin;
  if (origin.sourceType !== 'remote' || !origin.url) {
    throw new Error('buildRemoteServerConfig called for a non-remote (or url-less) server');
  }
  const transport = server.transport === 'websocket' || server.transport === 'sse' || server.transport === 'streamable'
    ? server.transport
    : 'streamable';
  const base = {
    name: server.name,
    disabled,
    autoApprove: server.autoApprove ?? [],
    rootPath: '',
    env: Object.fromEntries(
      Object.entries(env).map(([k, v]) => [
        k,
        secretEnvNames.has(k) ? { value: v, metadata: { isSecret: true } } : v,
      ])
    ),
    _buildCommand: '',
    _installCommand: '',
  };
  if (transport === 'websocket') {
    return { ...base, transport: 'websocket', websocketUrl: origin.url } as MCPServerConfig;
  }
  const hasHeaders = Object.keys(headers).length > 0;
  return {
    ...base,
    transport,
    serverUrl: origin.url,
    ...(hasHeaders ? { headers } : {}),
  } as MCPServerConfig;
}

/** Returns the installed model's real id + name (for flow boundModel remapping), or undefined if the install failed. */
async function installModel(
  model: PackagedModel,
  ctx: InstallCtx,
): Promise<{ id: string; name: string } | undefined> {
  const { secrets, secretProvided, secretRequired, summary, ledgerEntities, ledgerCreated } = ctx;

  // Resolve the API key: global-var binding, provided secret, or empty (a
  // missing REQUIRED secret installs the model DISABLED, i.e. keyless).
  let apiKey = '';
  let disabledNote: string | undefined;
  if (model.apiKeyRef.kind === 'global') {
    apiKey = `\${global:${model.apiKeyRef.var}}`;
  } else if (model.apiKeyRef.kind === 'secret') {
    const secretName = model.apiKeyRef.secret;
    if (secretProvided(secretName)) {
      apiKey = secrets[secretName];
    } else if (secretRequired(secretName)) {
      disabledNote = `installed without an API key — missing required secret "${secretName}"`;
    }
  }

  const displayName = model.displayName || model.name;
  const fields: Partial<Model> = {
    name: model.name,
    displayName,
    ...(model.provider ? { provider: model.provider as ModelProvider } : {}),
    ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
    ...(model.description ? { description: model.description } : {}),
    ...(model.promptTemplate ? { promptTemplate: model.promptTemplate } : {}),
    ...(model.temperature ? { temperature: model.temperature } : {}),
    ...(model.reasoningSchema ? { reasoningSchema: model.reasoningSchema } : {}),
    ...(model.functionCallingSchema ? { functionCallingSchema: model.functionCallingSchema } : {}),
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(model.maxTurns !== undefined ? { maxTurns: model.maxTurns } : {}),
    ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
    ApiKey: apiKey,
  };

  const existing = (await modelService.loadModels()).find(
    (m) => (m.displayName ?? '').toLowerCase() === displayName.toLowerCase(),
  );

  if (existing) {
    const res = await modelService.updateModel({ ...existing, ...fields, id: existing.id } as Model);
    if (res.success) {
      ledgerEntities.models[displayName] = existing.id;
      const ref: InstallEntityRef = { type: 'model', name: displayName, id: existing.id };
      if (disabledNote) summary.disabled.push({ ...ref, note: disabledNote });
      else summary.updated.push(ref);
      return { id: existing.id, name: model.name };
    }
    summary.skipped.push({ type: 'model', name: displayName, note: res.error });
    return undefined;
  }

  const id = uuidv4();
  const res = await modelService.addModel({ id, ...fields } as Model);
  if (res.success) {
    ledgerEntities.models[displayName] = id;
    ledgerCreated.models.push(id);
    const ref: InstallEntityRef = { type: 'model', name: displayName, id };
    if (disabledNote) summary.disabled.push({ ...ref, note: disabledNote });
    else summary.created.push(ref);
    return { id, name: model.name };
  }
  summary.skipped.push({ type: 'model', name: displayName, note: res.error });
  return undefined;
}

async function installFlows(
  packageName: string,
  flows: PackagedFlow[],
  modelIdMap: Record<string, { id: string; name: string }>,
  summary: InstallSummary,
  ledgerEntities: PackageInstallRecord['entities'],
  ledgerCreated: LedgerCreated,
): Promise<Record<string, string>> {
  // Build the manifest-local-id -> installed-id map first, so cross-flow
  // (subflow) references can be remapped regardless of flow order.
  const idMap: Record<string, string> = {};
  for (const f of flows) {
    idMap[f.flow.id] = deterministicFlowId(packageName, f.flow.id);
  }

  const existingIds = new Set((await flowService.loadFlows()).map((f) => f.id));

  for (const packagedFlow of flows) {
    const localId = packagedFlow.flow.id;
    const newId = idMap[localId];
    const flow = remapFlow(packagedFlow, newId, idMap, modelIdMap);
    const wasPresent = existingIds.has(newId);
    const res = await flowService.saveFlow(flow);
    if (res.success) {
      ledgerEntities.flows[localId] = newId;
      const ref: InstallEntityRef = { type: 'flow', name: packagedFlow.flow.name, id: newId };
      if (wasPresent) summary.updated.push(ref);
      else {
        ledgerCreated.flows.push(newId);
        summary.created.push(ref);
      }
    } else {
      summary.skipped.push({ type: 'flow', name: packagedFlow.flow.name, note: res.error });
    }
  }
  return idMap;
}

/**
 * Deep-clone a packaged flow, assign the fresh id, and remap subflow +
 * process-node model refs. `properties.boundModel` binds by model ID (see
 * flowValidation.ts) — since install always gives a model a fresh id
 * (uuidv4()) or resolves to a pre-existing one by displayName, the packaged
 * id never survives verbatim, so every bound node must be remapped here or it
 * shows up as "unbound" after install. `properties.modelName` is a cosmetic
 * display-only cache (no effect on execution/validation) — refreshed to match
 * for consistency.
 */
function remapFlow(
  packagedFlow: PackagedFlow,
  newId: string,
  idMap: Record<string, string>,
  modelIdMap: Record<string, { id: string; name: string }>,
): Flow {
  const clone = JSON.parse(JSON.stringify(packagedFlow.flow)) as Flow & { nodes: Array<{ data?: { properties?: Record<string, unknown> } }> };
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
    if (typeof props.boundModel === 'string' && modelIdMap[props.boundModel]) {
      const installed = modelIdMap[props.boundModel];
      props.boundModel = installed.id;
      props.modelName = installed.name;
    }
  }
  return clone as Flow;
}

async function installPlannedExecution(
  pe: PackagedPlannedExecution,
  packageName: string,
  flowIdMap: Record<string, string>,
  summary: InstallSummary,
  ledgerEntities: PackageInstallRecord['entities'],
  ledgerCreated: LedgerCreated,
): Promise<void> {
  const scheduler = getSchedulerService();
  const id = deterministicExecutionId(packageName, pe.name);
  const mappedFlowId = flowIdMap[pe.flowId] ?? pe.flowId;

  // Strip manifest-local id/timestamps; force enabled:false; remap flowId.
  const { id: _localId, flowId: _fid, createdAt: _c, updatedAt: _u, ...rest } = pe as Record<string, unknown> & { id: string; flowId: string };
  const config = {
    ...rest,
    id,
    flowId: mappedFlowId,
    enabled: false,
  } as Parameters<typeof scheduler.create>[0];

  const created = await scheduler.create(config);
  if (created.execution) {
    ledgerEntities.plannedExecutions.push(id);
    ledgerCreated.plannedExecutions.push(id);
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
