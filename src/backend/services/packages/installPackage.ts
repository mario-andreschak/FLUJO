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
  PackagedMcpTransport,
  PackagedModel,
  PackagedPlannedExecution,
} from '@/shared/types/package/package';
import type { EnvDeclaration, McpInstallOrigin, McpSourceType } from '@/shared/types/package/installOrigin';
import {
  effectiveName,
  validateRenameMap,
  type RenameCandidate,
} from '@/utils/shared/packageRename';
import { fetchPackageManifest } from './packageRegistry';
import { installRegistryServer } from '@/backend/services/mcp/registryInstall';
import { installGithubServer } from '@/backend/services/mcp/githubInstall';
import { modelService } from '@/backend/services/model';
import { flowService } from '@/backend/services/flow';
import { mcpService } from '@/backend/services/mcp';
import { getSchedulerService } from '@/backend/services/scheduler';
import type { Model } from '@/shared/types/model';
import type { ModelAdapter, ModelProvider } from '@/shared/types/model/provider';
import type { Flow } from '@/shared/types/flow';
import { isPersonaControlledPlannedExecution } from '@/shared/types/plannedExecution';
import type { MCPServerConfig, EnvVarValue, MCPHeaderValue } from '@/shared/types/mcp';
import { remapFlowModelBindings } from '@/utils/shared/flowModelReplacement';

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

// ---------------------------------------------------------------------------
// Inspection contract (issue #407)
//
// The install wizard needs to SHOW a package before touching the host: which
// apps/MCP servers it carries, where they come from, what they need, which
// flows and triggers it contains, and which secrets/globals feed what. These
// types are ADDITIVE — every pre-existing `InstallPreview` / `InstallSummary`
// field is preserved for older clients.
//
// Secrets posture: inspection data is derived from the PUBLIC manifest only.
// Declaration NAMES and reference NAMES are exposed; submitted secret VALUES
// never are.
// ---------------------------------------------------------------------------

/** Where a single env/header declaration of a packaged server gets its value. */
export type PackageDeclarationSource = 'secret' | 'global' | 'template' | 'environment';

export interface PackageDeclarationInfo {
  /** The env var / header name the server reads. */
  name: string;
  /** The package marked this value as sensitive (masked, encrypted at rest). */
  isSecret: boolean;
  source: PackageDeclarationSource;
  /** Manifest secret this declaration binds to (`source: 'secret'`). */
  secretRef?: string;
  /** Host global this declaration binds to (`source: 'global'`). */
  globalVar?: string;
  /** True when the bound manifest secret is declared required. */
  required: boolean;
  /** True when a value for the bound secret was supplied with this request. */
  provided: boolean;
}

/** Everything the wizard shows about one packaged app / MCP server. */
export interface PackageServerInfo {
  localName: string;
  transport: PackagedMcpTransport;
  sourceType: McpSourceType;
  /** Same compact `type:ref` string the legacy preview/result uses. */
  source: string;
  /** Safe, absolute http(s) link to the repository / registry entry, if any. */
  link?: string;
  ref?: string;
  gitRef?: string;
  subdirectory?: string;
  installCommand?: string;
  buildCommand?: string;
  url?: string;
  /** The package ships this server disabled. */
  disabled: boolean;
  folder?: string;
  autoApprove: string[];
  /** Positional argument templates the origin declares (no secret values). */
  argTemplates: Array<{ index: number; value: string }>;
  env: PackageDeclarationInfo[];
  headers: PackageDeclarationInfo[];
  /** Env/header names whose REQUIRED secret has no value yet. */
  requiredEnvMissing: string[];
}

/** A packaged flow, including a read-only graph payload for browsing. */
export interface PackageFlowInfo {
  /** Manifest-local flow id (stable rename key). */
  localId: string;
  name: string;
  /** Display name after the requested bulk rename (equals `name` by default). */
  effectiveName: string;
  nodeCount: number;
  edgeCount: number;
  /** Textual fallback for screen readers and unrenderable graphs. */
  nodeSummary: Array<{ id: string; type: string; label: string }>;
  /** Raw, non-executing ReactFlow payload. Null when the graph is malformed. */
  graph: { nodes: unknown[]; edges: unknown[] } | null;
  /** Why `graph` is null. */
  graphError?: string;
  references?: { flowIds?: string[]; modelIds?: string[]; mcpServerNames?: string[] };
}

/** A packaged planned execution + its trigger, described without secrets. */
export interface PackageTriggerInfo {
  /** Manifest execution name (stable rename key AND deterministic-id source). */
  key: string;
  name: string;
  effectiveName: string;
  triggerType: string;
  /** Manifest-local flow id this execution runs. */
  flowLocalId: string;
  flowName?: string;
  /** Planned executions are always installed disabled for review. */
  enabledAfterInstall: false;
  /** Safe key/value trigger configuration (tokens and secrets excluded). */
  details: Array<{ label: string; value: string }>;
}

export interface PackageSecretInfo {
  key: string;
  description?: string;
  required: boolean;
  provided: boolean;
  /** Entities that stop working (or install disabled) without this secret. */
  usedBy: Array<{ type: PackageEntityType; name: string }>;
}

export interface PackageGlobalInfo {
  name: string;
  description?: string;
  required: boolean;
  isSecret: boolean;
  /** True when this host already has the global set in Settings. */
  present: boolean;
  usedBy: Array<{ type: PackageEntityType; name: string }>;
}

export interface PackageIdentityInfo {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  publisher?: string;
  tags: string[];
}

/** One ordered, user-visible installation step. */
export type InstallStepStatus =
  | 'ok'
  | 'created'
  | 'updated'
  | 'adopted'
  | 'skipped'
  | 'disabled'
  | 'failed';

export type InstallStepPhase =
  | 'manifest'
  | 'server'
  | 'model'
  | 'flow'
  | 'plannedExecution';

export interface InstallStep {
  /** 1-based position in the real execution order. */
  order: number;
  phase: InstallStepPhase;
  entityType?: PackageEntityType;
  name: string;
  status: InstallStepStatus;
  /** Persisted id / server name, when the step produced one. */
  id?: string;
  /** Sanitized reason — always present for skipped/disabled/failed steps. */
  detail?: string;
}

export interface InstallPreview {
  servers: Array<{
    localName: string;
    source: string;
    requiredEnvMissing: string[];
    installCommand?: string;
    buildCommand?: string;
  }>;
  models: Array<{ id: string; displayName: string; apiKeyFrom?: string; missingRequiredSecret?: boolean }>;
  installedModels: Array<{ id: string; displayName: string; name: string }>;
  flows: Array<{ name: string }>;
  plannedExecutions: Array<{ name: string }>;
  secrets: Array<{ key: string; label?: string; required: boolean; provided: boolean }>;
  /** Host-global declarations whose values may be collected before install. */
  globals: NonNullable<FlujoPackage['globals']>;
  /**
   * `${global:VAR}` names this package expects the host to already have set
   * (in Settings), that are NOT currently set. Unlike `secrets[]` these are
   * host-level config, not something install can collect a value for — the
   * consent screen surfaces them so the user knows to set them afterwards.
   */
  missingGlobals: string[];

  // --- issue #407 inspection data (additive; always present on new servers) ---
  /** Package identity/description metadata for the wizard header. */
  info?: PackageIdentityInfo;
  /** Full per-server metadata (superset of `servers[]`). */
  serverDetails?: PackageServerInfo[];
  /** Packaged flows with read-only graph payloads. */
  flowDetails?: PackageFlowInfo[];
  /** Packaged planned executions / triggers. */
  triggerDetails?: PackageTriggerInfo[];
  /** Declared secrets plus which entities depend on them. */
  secretDetails?: PackageSecretInfo[];
  /** Declared host globals plus which entities depend on them. */
  globalDetails?: PackageGlobalInfo[];
  /** Errors produced by validating the requested bulk-rename map. */
  renameErrors?: string[];
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
  /**
   * Ordered per-entity outcome of the real install (issue #407), in the exact
   * order the orchestrator executed them. Every packaged entity appears here
   * exactly once with a terminal status and — when not successful — a safe
   * reason, so the wizard can show partial success honestly.
   */
  steps?: InstallStep[];
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
   * Bulk display-name renames (issue #407). Keys are manifest-local flow ids
   * and manifest planned-execution NAMES. Only display names change —
   * deterministic ids, webhook identities and flow-event topics stay derived
   * from the original manifest values so reinstall/uninstall stay stable.
   */
  renames?: {
    flows?: Record<string, string>;
    plannedExecutions?: Record<string, string>;
  };
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

export interface PackageUninstallInspection {
  exists: boolean;
  /** True when uninstall would delete at least one currently Persona-targeted plan. */
  requiresPersonaControl: boolean;
}

export interface UninstallPackageOptions {
  /** Set only by a route that already passed the strict-loopback boundary. */
  allowPersonaPlannedExecutions?: boolean;
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

function manifestContainsPersonaTarget(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const executions = (value as { plannedExecutions?: unknown }).plannedExecutions;
  if (!Array.isArray(executions)) return false;
  return executions.some((execution) => (
    Boolean(execution)
    && typeof execution === 'object'
    && !Array.isArray(execution)
    && isPersonaControlledPlannedExecution(execution)
  ));
}

async function hasProtectedExecutionCollision(
  manifest: Pick<FlujoPackage, 'name' | 'plannedExecutions'>,
): Promise<boolean> {
  const scheduler = getSchedulerService();
  for (const execution of manifest.plannedExecutions ?? []) {
    const existing = await scheduler.get(deterministicExecutionId(manifest.name, execution.name));
    if (isPersonaControlledPlannedExecution(existing)) return true;
  }
  return false;
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
async function computeMissingGlobals(manifest: Pick<FlujoPackage, 'requiredGlobals' | 'globals'>): Promise<string[]> {
  const requiredGlobals = new Set(manifest.requiredGlobals ?? []);
  for (const global of manifest.globals ?? []) {
    if (global.required) requiredGlobals.add(global.name);
  }
  if (requiredGlobals.size === 0) return [];
  const stored = await loadItem<Record<string, unknown>>(StorageKey.GLOBAL_ENV_VARS, {});
  return [...requiredGlobals].filter((name) => !Object.prototype.hasOwnProperty.call(stored, name));
}

// ---------------------------------------------------------------------------
// Bulk display-name renames (issue #407)
// ---------------------------------------------------------------------------

/** Keep only well-formed string entries so a hostile body cannot smuggle values in. */
function sanitizeRenameRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') out[key] = entry.trim();
  }
  return out;
}

function flowRenameCandidates(manifest: FlujoPackage): RenameCandidate[] {
  return (manifest.flows ?? []).map((f) => ({
    key: f.flow?.id ?? '',
    original: f.flow?.name ?? '',
    kind: 'flow' as const,
  }));
}

function executionRenameCandidates(manifest: FlujoPackage): RenameCandidate[] {
  return (manifest.plannedExecutions ?? []).map((p) => ({
    key: p.name,
    original: p.name,
    kind: 'plannedExecution' as const,
  }));
}

/**
 * Re-run the wizard's rename validation on the server. Host entities this
 * package already owns (deterministic ids) are excluded from the collision set
 * so a re-install never collides with itself.
 */
async function collectRenameErrors(
  manifest: FlujoPackage,
  flowRenames: Record<string, string>,
  executionRenames: Record<string, string>,
): Promise<string[]> {
  const flowCandidates = flowRenameCandidates(manifest);
  const executionCandidates = executionRenameCandidates(manifest);
  if (Object.keys(flowRenames).length === 0 && Object.keys(executionRenames).length === 0) return [];

  let existingFlowNames: string[] = [];
  try {
    const ownedFlowIds = new Set(flowCandidates.map((c) => deterministicFlowId(manifest.name, c.key)));
    const flows = await flowService.loadFlows();
    existingFlowNames = (flows ?? [])
      .filter((f) => !ownedFlowIds.has(f.id))
      .map((f) => f.name)
      .filter((n): n is string => typeof n === 'string');
  } catch (err) {
    log.warn('installPackage: failed to load flows for rename validation', err);
  }

  let existingExecutionNames: string[] = [];
  try {
    // The scheduler is mocked in tests — tolerate a service without `list()`.
    const scheduler = getSchedulerService() as unknown as {
      list?: () => Promise<Array<{ execution?: { id?: string; name?: string } }>>;
    };
    if (typeof scheduler?.list === 'function') {
      const ownedIds = new Set(executionCandidates.map((c) => deterministicExecutionId(manifest.name, c.key)));
      const executions = await scheduler.list();
      existingExecutionNames = (executions ?? [])
        .map((entry) => entry?.execution)
        .filter((e): e is { id?: string; name?: string } => Boolean(e))
        .filter((e) => typeof e.id !== 'string' || !ownedIds.has(e.id))
        .map((e) => e.name)
        .filter((n): n is string => typeof n === 'string');
    }
  } catch (err) {
    log.warn('installPackage: failed to load planned executions for rename validation', err);
  }

  return [
    ...validateRenameMap(flowRenames, flowCandidates, {
      existingNames: existingFlowNames,
      label: 'flow rename',
    }),
    ...validateRenameMap(executionRenames, executionCandidates, {
      existingNames: existingExecutionNames,
      label: 'trigger rename',
    }),
  ];
}

// ---------------------------------------------------------------------------
// Ordered install steps (issue #407)
// ---------------------------------------------------------------------------

/**
 * Project the summary buckets back onto the manifest's real execution order so
 * the wizard can render "what happened, in order" with one terminal status per
 * packaged entity. Derived (rather than emitted inline) so the install
 * primitives, their idempotency and their fail-soft posture stay untouched.
 */
export function buildInstallSteps(
  manifest: FlujoPackage,
  summary: InstallSummary,
  renames: { flows?: Record<string, string>; plannedExecutions?: Record<string, string> } = {},
): InstallStep[] {
  const steps: InstallStep[] = [];
  let order = 0;
  const next = (step: Omit<InstallStep, 'order'>): void => {
    order += 1;
    steps.push({ order, ...step });
  };

  next({
    phase: 'manifest',
    name: `${manifest.name} v${manifest.version}`,
    status: 'ok',
    detail: 'Manifest validated',
  });

  // Servers keep manifest order in `summary.servers`.
  for (const server of summary.servers) {
    const status: InstallStepStatus = server.error
      ? 'failed'
      : server.disabled
        ? 'disabled'
        : server.alreadyExisted
          ? 'adopted'
          : server.installed
            ? 'created'
            : 'skipped';
    const detail =
      server.error ??
      (server.needsEnv && server.needsEnv.length > 0
        ? `Missing required configuration: ${server.needsEnv.join(', ')}`
        : server.alreadyExisted
          ? 'Already installed — existing server reused'
          : server.disabled
            ? 'Installed disabled until its configuration is complete'
            : undefined);
    next({
      phase: 'server',
      entityType: 'server',
      name: server.localName,
      status,
      ...(server.serverName ? { id: server.serverName } : {}),
      ...(detail ? { detail } : {}),
    });
  }

  const find = (type: PackageEntityType, name: string): { status: InstallStepStatus; ref?: InstallEntityRef } => {
    const match = (bucket: InstallEntityRef[]) => bucket.find((r) => r.type === type && r.name === name);
    const failed = match(summary.skipped);
    const disabled = match(summary.disabled);
    const updated = match(summary.updated);
    const created = match(summary.created);
    if (disabled) return { status: 'disabled', ref: disabled };
    if (failed) return { status: 'skipped', ref: failed };
    if (updated) return { status: 'updated', ref: updated };
    if (created) return { status: 'created', ref: created };
    return { status: 'skipped' };
  };

  for (const model of manifest.models ?? []) {
    const name = model.displayName || model.name;
    const { status, ref } = find('model', name);
    next({
      phase: 'model',
      entityType: 'model',
      name,
      status,
      ...(ref?.id ? { id: ref.id } : {}),
      ...(ref?.note ? { detail: ref.note } : status === 'skipped' ? { detail: 'Not reported by the installer' } : {}),
    });
  }

  for (const packaged of manifest.flows ?? []) {
    const original = packaged.flow?.name ?? '';
    const shown = effectiveName(renames.flows, packaged.flow?.id ?? '', original);
    const { status, ref } = find('flow', shown);
    next({
      phase: 'flow',
      entityType: 'flow',
      name: shown,
      status,
      ...(ref?.id ? { id: ref.id } : {}),
      ...(ref?.note ? { detail: ref.note } : status === 'skipped' ? { detail: 'Not reported by the installer' } : {}),
    });
  }

  for (const pe of manifest.plannedExecutions ?? []) {
    const shown = effectiveName(renames.plannedExecutions, pe.name, pe.name);
    const { status, ref } = find('plannedExecution', shown);
    next({
      phase: 'plannedExecution',
      entityType: 'plannedExecution',
      name: shown,
      status,
      ...(ref?.id ? { id: ref.id } : {}),
      ...(ref?.note ? { detail: ref.note } : status === 'skipped' ? { detail: 'Not reported by the installer' } : {}),
    });
  }

  return steps;
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

  // Defense in depth before schema parsing: registry content must never carry
  // workspace-local Persona identity or Behavior binding fields. Keep this
  // explicit check even though the shared schema rejects them, so a future
  // parser/refactor cannot silently turn package install into a Persona target
  // selection API.
  if (manifestContainsPersonaTarget(raw)) {
    const s = empty();
    s.errors.push('Invalid package manifest: Persona-targeted planned executions are not portable.');
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

  // 2b. Bulk display-name renames (issue #407): validated identically on the
  //     client and here, so a hand-crafted request cannot bypass the wizard.
  const flowRenames = sanitizeRenameRecord(input.renames?.flows);
  const executionRenames = sanitizeRenameRecord(input.renames?.plannedExecutions);
  const renameErrors = await collectRenameErrors(manifest, flowRenames, executionRenames);

  // 3. Consent preview (dry-run): no mutations.
  if (input.consentGranted !== true) {
    return {
      ok: true,
      dryRun: true,
      package: { name: manifest.name, version: manifest.version, ...(manifest.publisher ? { publisher: manifest.publisher } : {}) },
      preview: {
        ...await buildPreview(manifest, secretProvided, { flowRenames, executionRenames, renameErrors }),
        missingGlobals: await computeMissingGlobals(manifest),
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

  // A rename the user asked for must never be silently dropped: refuse BEFORE
  // touching the host rather than installing under the original names.
  if (renameErrors.length > 0) {
    const s = empty();
    s.dryRun = false;
    s.errors.push(...renameErrors);
    return s;
  }

  // A Persona plan may occupy the deterministic id created by an older package
  // install. Re-install must not update/disable that protected plan as an
  // incidental conflict resolution. Preflight every id before installing any
  // server/model/flow so denial is all-or-none.
  if (await hasProtectedExecutionCollision(manifest)) {
    const s = empty();
    s.dryRun = false;
    s.errors.push('Package install conflicts with a protected workspace execution.');
    return s;
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
    missingGlobals: await computeMissingGlobals(manifest),
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
    await installServer(server, {
      packageFolder: manifest.name,
      secrets,
      secretProvided,
      secretRequired,
      summary,
      ledgerEntities,
      ledgerCreated,
      existingServerNames,
      existingServerConfigs,
    });
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
    const installed = await installModel(model, {
      packageFolder: manifest.name,
      secrets,
      secretProvided,
      secretRequired,
      summary,
      ledgerEntities,
      ledgerCreated,
      existingServerNames,
      existingServerConfigs,
    });
    if (installed) modelIdMap[model.id] = installed;
  }

  // 6. Flows — fresh deterministic ids + internal reference remapping.
  const flowIdMap = await installFlows(manifest.name, resolvedFlows, modelIdMap, summary, ledgerEntities, ledgerCreated, flowRenames);

  // 7. Planned executions — remapped flowId, created DISABLED.
  for (const pe of resolvedPlannedExecutions) {
    await installPlannedExecution(pe, manifest.name, flowIdMap, summary, ledgerEntities, ledgerCreated, executionRenames);
  }

  // 7b. Ordered, per-entity outcomes for the install wizard.
  summary.steps = buildInstallSteps(manifest, summary, {
    flows: flowRenames,
    plannedExecutions: executionRenames,
  });

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

function plannedExecutionIdsRemovedByUninstall(record: PackageInstallRecord): string[] {
  const ids = Array.isArray(record.entities?.plannedExecutions)
    ? record.entities.plannedExecutions.filter((id): id is string => typeof id === 'string')
    : [];
  if (record.created === undefined) return [...new Set(ids)];
  const createdIds = new Set(
    Array.isArray(record.created.plannedExecutions)
      ? record.created.plannedExecutions.filter((id): id is string => typeof id === 'string')
      : [],
  );
  return [...new Set(ids.filter((id) => createdIds.has(id)))];
}

async function protectedPlannedExecutionsForUninstall(
  record: PackageInstallRecord,
): Promise<string[]> {
  const scheduler = getSchedulerService();
  const protectedIds: string[] = [];
  for (const id of plannedExecutionIdsRemovedByUninstall(record)) {
    if (isPersonaControlledPlannedExecution(await scheduler.get(id))) protectedIds.push(id);
  }
  return protectedIds;
}

/** Side-effect-free route preflight; never returns Persona ids or bindings. */
export async function inspectPackageUninstall(
  packageName: string,
): Promise<PackageUninstallInspection> {
  const file = await loadItem<PackageInstallsFile>(StorageKey.PACKAGE_INSTALLS, {});
  const record = file[packageName];
  if (!record) return { exists: false, requiresPersonaControl: false };
  return {
    exists: true,
    requiresPersonaControl: (await protectedPlannedExecutionsForUninstall(record)).length > 0,
  };
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
export async function uninstallPackage(
  packageName: string,
  options: UninstallPackageOptions = {},
): Promise<UninstallSummary> {
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

  // Re-evaluate inside the mutating service to close the route-preflight race
  // and keep direct service callers fail-closed. No entity of any kind is
  // removed before this all-or-none authorization decision.
  const protectedExecutionIds = await protectedPlannedExecutionsForUninstall(record);
  if (protectedExecutionIds.length > 0 && !options.allowPersonaPlannedExecutions) {
    summary.ok = false;
    summary.hasErrors = true;
    summary.errors.push({
      kind: 'plannedExecution',
      id: 'protected',
      reason: 'Persona-targeted planned executions require strict-loopback control.',
    });
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

/** Every host-global name a server's env/header declarations reference. */
function serverGlobalRefs(server: PackagedMcpServer): string[] {
  return [...server.envDeclarations, ...(server.headerDeclarations ?? [])]
    .map((d) => d.globalVar)
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
}

// ---------------------------------------------------------------------------
// Inspection builders (issue #407)
// ---------------------------------------------------------------------------

/**
 * Derive a SAFE, absolute http(s) link for a packaged server so the wizard can
 * show "where does this come from". Anything that is not a plain http(s) URL
 * (javascript:, data:, file:, ...) is dropped rather than rendered.
 */
export function safeOriginLink(origin: McpInstallOrigin): string | undefined {
  const candidates = [origin.url, origin.ref].filter(
    (v): v is string => typeof v === 'string' && v.trim() !== '',
  );
  for (const candidate of candidates) {
    const value = candidate.trim();
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.toString();
      continue;
    } catch {
      // Not an absolute URL — fall through to the shorthand handling below.
    }
    if (origin.sourceType === 'github' && /^[\w.-]+\/[\w.-]+$/.test(value)) {
      return `https://github.com/${value}`;
    }
  }
  return undefined;
}

function describeDeclarations(
  declarations: EnvDeclaration[],
  manifest: FlujoPackage,
  secretProvided: (name: string) => boolean,
): PackageDeclarationInfo[] {
  return declarations.map((decl) => {
    const source: PackageDeclarationSource = decl.secretRef
      ? 'secret'
      : decl.globalVar
        ? 'global'
        : decl.globalTemplate
          ? 'template'
          : 'environment';
    return {
      name: decl.name,
      isSecret: decl.isSecret === true,
      source,
      ...(decl.secretRef ? { secretRef: decl.secretRef } : {}),
      ...(decl.globalVar ? { globalVar: decl.globalVar } : {}),
      required: decl.secretRef
        ? (manifest.secrets ?? []).some((s) => s.name === decl.secretRef && s.required === true)
        : decl.globalVar
          ? (manifest.globals ?? []).some((g) => g.name === decl.globalVar && g.required === true)
          : false,
      provided: decl.secretRef ? secretProvided(decl.secretRef) : false,
    };
  });
}

function buildServerDetails(
  manifest: FlujoPackage,
  secretProvided: (name: string) => boolean,
): PackageServerInfo[] {
  return (manifest.mcpServers ?? []).map((server) => {
    const origin = server.installOrigin;
    const link = safeOriginLink(origin);
    return {
      localName: server.name,
      transport: server.transport,
      sourceType: origin.sourceType,
      source: serverSource(server),
      ...(link ? { link } : {}),
      ...(origin.ref ? { ref: origin.ref } : {}),
      ...(origin.gitRef ? { gitRef: origin.gitRef } : {}),
      ...(origin.subdirectory ? { subdirectory: origin.subdirectory } : {}),
      ...(origin.installCommand ? { installCommand: origin.installCommand } : {}),
      ...(origin.buildCommand ? { buildCommand: origin.buildCommand } : {}),
      ...(origin.url ? { url: origin.url } : {}),
      disabled: server.disabled === true,
      ...(server.folder ? { folder: server.folder } : {}),
      autoApprove: server.autoApprove ?? [],
      argTemplates: (server.argTemplates ?? []).map((a) => ({ index: a.index, value: a.value })),
      env: describeDeclarations(server.envDeclarations ?? [], manifest, secretProvided),
      headers: describeDeclarations(server.headerDeclarations ?? [], manifest, secretProvided),
      requiredEnvMissing: serverSecretRefs(server).filter(
        (name) =>
          (manifest.secrets ?? []).some((sec) => sec.name === name && sec.required) && !secretProvided(name),
      ),
    };
  });
}

function buildFlowDetails(
  manifest: FlujoPackage,
  flowRenames: Record<string, string>,
): PackageFlowInfo[] {
  return (manifest.flows ?? []).map((packaged) => {
    const flow = packaged.flow;
    const nodes = Array.isArray(flow?.nodes) ? flow.nodes : [];
    const edges = Array.isArray(flow?.edges) ? flow.edges : [];
    const info: PackageFlowInfo = {
      localId: flow?.id ?? '',
      name: flow?.name ?? '',
      effectiveName: effectiveName(flowRenames, flow?.id ?? '', flow?.name ?? ''),
      nodeCount: nodes.length,
      edgeCount: edges.length,
      nodeSummary: nodes.map((node) => {
        const n = node as { id?: unknown; type?: unknown; data?: { label?: unknown; type?: unknown } };
        return {
          id: typeof n.id === 'string' ? n.id : '',
          type: typeof n.type === 'string' ? n.type : typeof n.data?.type === 'string' ? n.data.type : 'unknown',
          label: typeof n.data?.label === 'string' ? n.data.label : (typeof n.id === 'string' ? n.id : ''),
        };
      }),
      graph: null,
      ...(packaged.references ? { references: packaged.references } : {}),
    };

    // The graph payload is manifest content only — the schema already forbids
    // encrypted blobs and secret VALUES, so it is safe to hand to the
    // read-only canvas. Serialize defensively: a cyclic/oversized graph must
    // degrade to the textual summary, never break the whole preview.
    try {
      const serialized = JSON.stringify({ nodes, edges });
      if (serialized.length > 2_000_000) {
        info.graphError = 'graph too large to preview';
      } else {
        info.graph = JSON.parse(serialized) as { nodes: unknown[]; edges: unknown[] };
      }
    } catch (err) {
      info.graphError = err instanceof Error ? err.message : String(err);
    }
    return info;
  });
}

/** Human-readable, secret-free description of one packaged trigger. */
function describeTrigger(trigger: unknown): { type: string; details: Array<{ label: string; value: string }> } {
  const t = (trigger ?? {}) as Record<string, unknown>;
  const type = typeof t.type === 'string' ? t.type : 'unknown';
  const details: Array<{ label: string; value: string }> = [];
  const push = (label: string, value: unknown) => {
    if (value === undefined || value === null || value === '') return;
    if (typeof value === 'object') {
      details.push({ label, value: JSON.stringify(value) });
      return;
    }
    details.push({ label, value: String(value) });
  };

  switch (type) {
    case 'schedule':
      push('cron', t.cron);
      push('timezone', t.timezone);
      push('catchUp', t.catchUp);
      break;
    case 'webhook':
      // NEVER expose the shared secret — only whether one is required.
      push('token', typeof t.token === 'string' && t.token !== '' ? 'provided by package' : 'generated on install');
      push('allowExternal', t.allowExternal === true);
      break;
    case 'file-watch':
      push('path', t.path);
      push('events', Array.isArray(t.events) ? t.events.join(', ') : undefined);
      break;
    case 'mcp-poll':
      push('server', t.serverName);
      push('tool', t.toolName);
      push('intervalMs', t.intervalMs);
      break;
    case 'url-watch':
      push('url', t.url);
      push('intervalMs', t.intervalMs);
      break;
    case 'flow-event':
      push('source', t.source);
      push('on', Array.isArray(t.on) ? t.on.join(', ') : undefined);
      push('maxChainDepth', t.maxChainDepth);
      break;
    default:
      break;
  }
  return { type, details };
}

function buildTriggerDetails(
  manifest: FlujoPackage,
  executionRenames: Record<string, string>,
): PackageTriggerInfo[] {
  const flowNames = new Map(
    (manifest.flows ?? []).map((f) => [f.flow?.id ?? '', f.flow?.name ?? '']),
  );
  return (manifest.plannedExecutions ?? []).map((pe) => {
    const described = describeTrigger((pe as { trigger?: unknown }).trigger);
    const flowName = flowNames.get(pe.flowId);
    return {
      key: pe.name,
      name: pe.name,
      effectiveName: effectiveName(executionRenames, pe.name, pe.name),
      triggerType: described.type,
      flowLocalId: pe.flowId,
      ...(flowName ? { flowName } : {}),
      enabledAfterInstall: false as const,
      details: described.details,
    };
  });
}

/** Which packaged entities depend on each declared secret / host global. */
function buildDependencyIndex(manifest: FlujoPackage): {
  secrets: Map<string, Array<{ type: PackageEntityType; name: string }>>;
  globals: Map<string, Array<{ type: PackageEntityType; name: string }>>;
} {
  const secrets = new Map<string, Array<{ type: PackageEntityType; name: string }>>();
  const globals = new Map<string, Array<{ type: PackageEntityType; name: string }>>();
  const add = (
    index: Map<string, Array<{ type: PackageEntityType; name: string }>>,
    key: string,
    entry: { type: PackageEntityType; name: string },
  ) => {
    if (!key) return;
    const list = index.get(key) ?? [];
    if (!list.some((e) => e.type === entry.type && e.name === entry.name)) list.push(entry);
    index.set(key, list);
  };

  for (const server of manifest.mcpServers ?? []) {
    for (const name of serverSecretRefs(server)) add(secrets, name, { type: 'server', name: server.name });
    for (const name of serverGlobalRefs(server)) add(globals, name, { type: 'server', name: server.name });
  }
  for (const model of manifest.models ?? []) {
    const label = model.displayName || model.name;
    if (model.apiKeyRef.kind === 'secret') add(secrets, model.apiKeyRef.secret, { type: 'model', name: label });
    if (model.apiKeyRef.kind === 'global') add(globals, model.apiKeyRef.var, { type: 'model', name: label });
  }

  // Free-text `{{secret.NAME}}` placeholders inside flows / planned executions.
  const scanPlaceholders = (value: unknown, entry: { type: PackageEntityType; name: string }) => {
    const serialized = (() => {
      try {
        return JSON.stringify(value ?? '');
      } catch {
        return '';
      }
    })();
    const re = new RegExp(SECRET_PLACEHOLDER_REGEX.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = re.exec(serialized)) !== null) add(secrets, match[1], entry);
    const globalRe = /\$\{global:([A-Za-z_][A-Za-z0-9_]*)\}/g;
    let globalMatch: RegExpExecArray | null;
    while ((globalMatch = globalRe.exec(serialized)) !== null) add(globals, globalMatch[1], entry);
  };
  for (const packaged of manifest.flows ?? []) {
    scanPlaceholders(packaged.flow, { type: 'flow', name: packaged.flow?.name ?? '' });
  }
  for (const pe of manifest.plannedExecutions ?? []) {
    scanPlaceholders(pe, { type: 'plannedExecution', name: pe.name });
  }

  return { secrets, globals };
}

async function buildPreview(
  manifest: FlujoPackage,
  secretProvided: (name: string) => boolean,
  options: {
    flowRenames?: Record<string, string>;
    executionRenames?: Record<string, string>;
    renameErrors?: string[];
  } = {},
): Promise<Omit<InstallPreview, 'missingGlobals'>> {
  const installedModels = await modelService.loadModels();
  const flowRenames = options.flowRenames ?? {};
  const executionRenames = options.executionRenames ?? {};
  const dependencies = buildDependencyIndex(manifest);
  const storedGlobals = await loadItem<Record<string, unknown>>(StorageKey.GLOBAL_ENV_VARS, {});
  return {
    info: {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      ...(manifest.description ? { description: manifest.description } : {}),
      ...(manifest.author ? { author: manifest.author } : {}),
      ...(manifest.publisher ? { publisher: manifest.publisher } : {}),
      tags: manifest.tags ?? [],
    },
    serverDetails: buildServerDetails(manifest, secretProvided),
    flowDetails: buildFlowDetails(manifest, flowRenames),
    triggerDetails: buildTriggerDetails(manifest, executionRenames),
    secretDetails: (manifest.secrets ?? []).map((s) => ({
      key: s.name,
      ...(s.description ? { description: s.description } : {}),
      required: s.required === true,
      provided: secretProvided(s.name),
      usedBy: dependencies.secrets.get(s.name) ?? [],
    })),
    globalDetails: (manifest.globals ?? []).map((g) => ({
      name: g.name,
      ...(g.description ? { description: g.description } : {}),
      required: g.required === true,
      isSecret: g.isSecret === true,
      present: Object.prototype.hasOwnProperty.call(storedGlobals ?? {}, g.name),
      usedBy: dependencies.globals.get(g.name) ?? [],
    })),
    ...(options.renameErrors && options.renameErrors.length > 0
      ? { renameErrors: options.renameErrors }
      : {}),
    servers: (manifest.mcpServers ?? []).map((s) => ({
      localName: s.name,
      source: serverSource(s),
      ...(s.installOrigin.sourceType === 'github' && s.installOrigin.installCommand
        ? { installCommand: s.installOrigin.installCommand }
        : {}),
      ...(s.installOrigin.sourceType === 'github' && s.installOrigin.buildCommand
        ? { buildCommand: s.installOrigin.buildCommand }
        : {}),
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
    globals: manifest.globals ?? [],
  };
}

// ---------------------------------------------------------------------------
// Per-entity install helpers
// ---------------------------------------------------------------------------

interface InstallCtx {
  /** All entities owned by this install are organized under the package name. */
  packageFolder: string;
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
      // Preserve the secret classification on the installed config even
      // though the value is a portable global reference rather than a package
      // secret. This keeps masking/encryption and future re-exports correct.
      if (decl.isSecret) secretNames.add(decl.name);
    } else if (decl.globalTemplate) {
      values[decl.name] = decl.globalTemplate;
      if (decl.isSecret) secretNames.add(decl.name);
    }
    // No binding: nothing to resolve — the declaration is metadata-only (e.g.
    // documents a var the server reads from its own environment).
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
  resolvedHeaders: Record<string, MCPHeaderValue> = {},
): Promise<void> {
  const { packageFolder, summary, ledgerEntities, existingServerConfigs } = ctx;
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
  const existingArgs = (existingConfig as { args?: string[] }).args;
  const mergedArgs = Array.isArray(existingArgs) ? [...existingArgs] : [];
  for (const template of server.argTemplates ?? []) {
    if (
      template.index > mergedArgs.length ||
      (template.index < mergedArgs.length &&
        !/\$\{global:[A-Za-z0-9_.-]+\}/.test(mergedArgs[template.index]))
    ) {
      const error =
        `argument template index ${template.index} cannot replace a static existing argument`;
      summary.servers.push({ localName: server.name, source, installed: false, error });
      summary.skipped.push({ type: 'server', name: server.name, note: error });
      return;
    }
    mergedArgs[template.index] = template.value;
  }

  const saved = await mcpService.updateServerConfig(
    server.name,
    {
      env: mergedEnv,
      ...(Object.keys(resolvedHeaders).length > 0
        ? {
            headers: {
              ...('headers' in existingConfig ? (existingConfig.headers ?? {}) : {}),
              ...resolvedHeaders,
            },
          }
        : {}),
      folder: packageFolder,
      ...(server.argTemplates?.length ? { args: mergedArgs } : {}),
    } as Partial<MCPServerConfig>,
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
    if (!origin.ref) {
      summary.servers.push({ localName: server.name, source, installed: false, error: 'missing GitHub repository URL' });
      summary.skipped.push({ type: 'server', name: server.name, note: 'installOrigin has no GitHub ref' });
      return;
    }
    // Match the registry path's adopt-and-configure semantics. Reinstalling a
    // package must not rebuild or take ownership of a user's existing server,
    // but it must still merge the package's env/folder configuration.
    if (existingServerNames.has(server.name)) {
      await adoptAndConfigureServer(
        server,
        ctx,
        missingRequired,
        env.values,
        env.secretNames,
        resolvedHeaders,
      );
      return;
    }
    if (missingRequired.length > 0) {
      summary.disabled.push({ type: 'server', name: server.name, note: `missing required secret(s) for: ${missingRequired.join(', ')}` });
      summary.servers.push({ localName: server.name, source, installed: false, needsEnv: missingRequired });
      return;
    }
    const result = await installGithubServer({
      name: server.name,
      repositoryUrl: origin.ref,
      ref: origin.gitRef,
      subdirectory: origin.subdirectory,
      installCommand: origin.installCommand,
      buildCommand: origin.buildCommand,
      env: env.values,
      secretEnvNames: [...env.secretNames],
      argTemplates: server.argTemplates,
      disabled: server.disabled,
      autoApprove: server.autoApprove,
      folder: ctx.packageFolder,
    });
    summary.servers.push({
      localName: server.name,
      source,
      installed: result.installed,
      ...(result.serverName ? { serverName: result.serverName } : {}),
      ...(result.alreadyExisted ? { alreadyExisted: true } : {}),
      ...(result.error ? { error: result.error } : {}),
    });
    if (result.installed) {
      ledgerEntities.servers.push(result.serverName ?? server.name);
      const ref = { type: 'server' as const, name: server.name, id: result.serverName ?? server.name };
      if (result.alreadyExisted) summary.updated.push(ref);
      else {
        ledgerCreated.servers.push(result.serverName ?? server.name);
        summary.created.push(ref);
      }
    } else {
      summary.skipped.push({ type: 'server', name: server.name, note: result.error ?? 'GitHub install failed' });
    }
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
      await adoptAndConfigureServer(
        server,
        ctx,
        missingRequired,
        env.values,
        env.secretNames,
        resolvedHeaders,
      );
      return;
    }

    // NEW INSTALL: fail-soft if a required secret is missing.
    if (missingRequired.length > 0) {
      summary.disabled.push({ type: 'server', name: server.name, note: `missing required secret(s) for: ${missingRequired.join(', ')}` });
      summary.servers.push({ localName: server.name, source, installed: false, needsEnv: missingRequired });
      return;
    }
    const result = await installRegistryServer(registryName, env.values, {
      preferredTransport: server.transport,
      headerOverrides: resolvedHeaders,
      ...(server.argTemplates?.length ? { argTemplates: server.argTemplates } : {}),
    });
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
      if (result.serverName) {
        await assignServerPackageFolder(result.serverName, ctx.packageFolder);
      }
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
    const config = buildRemoteServerConfig(
      server,
      ctx.packageFolder,
      env.values,
      disabled,
      resolvedHeaders,
      env.secretNames,
    );
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
 * Registry installs build the server config in a lower-level service that has
 * no package context. Apply the package folder immediately afterwards.
 * Fail-soft like secret re-tagging: the server itself is already installed.
 */
async function assignServerPackageFolder(serverName: string, packageFolder: string): Promise<void> {
  try {
    const saved = await mcpService.updateServerConfig(
      serverName,
      { folder: packageFolder } as Partial<MCPServerConfig>,
    );
    if (
      !Array.isArray(saved) &&
      saved &&
      'success' in saved &&
      (saved as { success?: boolean }).success === false
    ) {
      log.warn(
        `assignServerPackageFolder: failed to assign "${serverName}" to "${packageFolder}": ${(saved as { error?: string }).error ?? 'unknown error'}`,
      );
    }
  } catch (err) {
    log.warn(`assignServerPackageFolder: failed to assign "${serverName}" to "${packageFolder}"`, err);
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
  packageFolder: string,
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
    folder: packageFolder,
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
  const {
    packageFolder,
    secrets,
    secretProvided,
    secretRequired,
    summary,
    ledgerEntities,
    ledgerCreated,
  } = ctx;

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
    ...(model.adapter ? { adapter: model.adapter as ModelAdapter } : {}),
    ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
    ...(model.description ? { description: model.description } : {}),
    ...(model.promptTemplate ? { promptTemplate: model.promptTemplate } : {}),
    ...(model.temperature ? { temperature: model.temperature } : {}),
    ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort as Model['reasoningEffort'] } : {}),
    ...(model.thinkingLevel ? { thinkingLevel: model.thinkingLevel as Model['thinkingLevel'] } : {}),
    ...(model.thinkingBudget !== undefined ? { thinkingBudget: model.thinkingBudget } : {}),
    ...(model.serviceTier ? { serviceTier: model.serviceTier as Model['serviceTier'] } : {}),
    ...(model.reasoningSchema ? { reasoningSchema: model.reasoningSchema } : {}),
    ...(model.functionCallingSchema ? { functionCallingSchema: model.functionCallingSchema } : {}),
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(model.supportsTools !== undefined ? { supportsTools: model.supportsTools } : {}),
    ...(model.supportedParameters !== undefined ? { supportedParameters: model.supportedParameters } : {}),
    ...(model.inputModalities !== undefined ? { inputModalities: model.inputModalities } : {}),
    ...(model.outputModalities !== undefined ? { outputModalities: model.outputModalities } : {}),
    ...(model.visionInputCapability !== undefined ? { visionInputCapability: model.visionInputCapability } : {}),
    ...(model.maxTurns !== undefined ? { maxTurns: model.maxTurns } : {}),
    ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
    ...(model.compactionThreshold !== undefined ? { compactionThreshold: model.compactionThreshold } : {}),
    folder: packageFolder,
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
  /** Manifest-local flow id -> requested display name (issue #407). */
  flowRenames: Record<string, string> = {},
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
    flow.folder = packageName;
    // Display-name-only rename: the deterministic id above is derived from the
    // manifest-local id, so renaming never breaks reinstall / uninstall.
    const displayName = effectiveName(flowRenames, localId, packagedFlow.flow.name);
    flow.name = displayName;
    const wasPresent = existingIds.has(newId);
    const res = await flowService.saveFlow(flow);
    if (res.success) {
      ledgerEntities.flows[localId] = newId;
      const ref: InstallEntityRef = { type: 'flow', name: displayName, id: newId };
      if (wasPresent) summary.updated.push(ref);
      else {
        ledgerCreated.flows.push(newId);
        summary.created.push(ref);
      }
    } else {
      summary.skipped.push({ type: 'flow', name: displayName, note: res.error });
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
  let clone = JSON.parse(JSON.stringify(packagedFlow.flow)) as Flow & { nodes: Array<{ data?: { properties?: Record<string, unknown> } }> };
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
  clone = remapFlowModelBindings(clone, modelIdMap).flow;
  return clone as Flow;
}

async function installPlannedExecution(
  pe: PackagedPlannedExecution,
  packageName: string,
  flowIdMap: Record<string, string>,
  summary: InstallSummary,
  ledgerEntities: PackageInstallRecord['entities'],
  ledgerCreated: LedgerCreated,
  /** Manifest execution name -> requested display name (issue #407). */
  executionRenames: Record<string, string> = {},
): Promise<void> {
  const scheduler = getSchedulerService();
  // The deterministic id stays derived from the ORIGINAL manifest name so a
  // renamed execution still updates in place on re-install and is still found
  // by uninstall. Only the display name changes.
  const id = deterministicExecutionId(packageName, pe.name);
  const displayName = effectiveName(executionRenames, pe.name, pe.name);
  const mappedFlowId = flowIdMap[pe.flowId] ?? pe.flowId;

  // Re-check at the mutation boundary to close a concurrent retarget between
  // the all-or-none orchestrator preflight and this create/update.
  if (isPersonaControlledPlannedExecution(await scheduler.get(id))) {
    const error = 'Package install conflicts with a protected workspace execution.';
    summary.ok = false;
    summary.errors.push(error);
    summary.skipped.push({ type: 'plannedExecution', name: displayName, id, note: error });
    return;
  }

  // Strip manifest-local id/timestamps; force enabled:false; remap flowId.
  const { id: _localId, flowId: _fid, createdAt: _c, updatedAt: _u, ...rest } = pe as Record<string, unknown> & { id: string; flowId: string };
  const config = {
    ...rest,
    id,
    name: displayName,
    flowId: mappedFlowId,
    folder: packageName,
    enabled: false,
  } as Parameters<typeof scheduler.create>[0];

  const created = await scheduler.create(config);
  if (created.execution) {
    ledgerEntities.plannedExecutions.push(id);
    ledgerCreated.plannedExecutions.push(id);
    summary.created.push({ type: 'plannedExecution', name: displayName, id });
    summary.disabled.push({ type: 'plannedExecution', name: displayName, id, note: 'created disabled — enable it after review' });
    return;
  }

  if (created.conflict) {
    // Idempotent re-install: update the existing execution in place.
    const { id: _id, ...patch } = config as Record<string, unknown>;
    const updated = await scheduler.update(id, patch as Parameters<typeof scheduler.update>[1]);
    if (updated.execution) {
      ledgerEntities.plannedExecutions.push(id);
      summary.updated.push({ type: 'plannedExecution', name: displayName, id });
      summary.disabled.push({ type: 'plannedExecution', name: displayName, id, note: 'updated (disabled) — enable it after review' });
    } else {
      summary.skipped.push({ type: 'plannedExecution', name: displayName, note: updated.error });
    }
    return;
  }

  summary.skipped.push({ type: 'plannedExecution', name: displayName, note: created.error });
}
