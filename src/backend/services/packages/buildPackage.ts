/**
 * Package BUILD/EXPORT service (issue #194).
 *
 * The counterpart to `installPackage.ts`: instead of consuming a manifest, this
 * assembles a `FlujoPackage` (issue #192) FROM the user's existing entities —
 * the backend half of the Packages-page creation wizard. It:
 *
 *   resolve dependencies (subflows, models, MCP servers, planned-exec flows)
 *     -> validate MCP servers (local-only servers HARD-ABORT; #193 `source`)
 *     -> derive secrets (model API keys + secret env/header declarations)
 *     -> serialize via the shared secret-safe serializer (#192)
 *
 * SECURITY: the heavy lifting of never leaking secret material lives in the
 * shared serializer (`serializePackage` strips model `ApiKey`s, refuses any
 * `encrypted:` blob, drops webhook tokens). This module only ever emits
 * *declarations* (names + `isSecret`) for MCP env/headers and secret *refs* for
 * model keys — never a value.
 *
 * The pure helpers (`resolveDependencies`, `validateMcpSelection`,
 * `deriveModelApiKeyRef`, `buildManifestFromEntities`) take their data as
 * arguments so they are directly unit-testable without any I/O.
 */
import { createLogger } from '@/utils/logger';
import { GLOBAL_VAR_REGEX, IDENTIFIER_REGEX } from '@/shared/types/package/constants';
import {
  collectFlowReferences,
  serializePackage,
  validatePackage,
} from '@/shared/types/package/package.serialize';
import type { FlujoPackage, PackageApiKeyRef, PackagedMcpServer } from '@/shared/types/package/package';
import type {
  EnvDeclaration,
  HeaderDeclaration,
  McpInstallOrigin,
} from '@/shared/types/package/installOrigin';
import type { PackageSecret } from '@/shared/types/package/secrets';
import type { Model } from '@/shared/types/model';
import type { Flow } from '@/shared/types/flow';
import type { EnvVarValue, MCPServerConfig, MCPServerSource } from '@/shared/types/mcp';
import type { PlannedExecution } from '@/shared/types/plannedExecution';

const log = createLogger('backend/services/packages/buildPackage');

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** What the user ticked in the wizard's "Select contents" step. */
export interface PackageSelection {
  flowIds?: string[];
  modelIds?: string[];
  mcpServerNames?: string[];
  plannedExecutionIds?: string[];
}

/** The live entities the resolver/serializer draws from. */
export interface PackageEntities {
  flows: Flow[];
  models: Model[];
  mcpServers: MCPServerConfig[];
  plannedExecutions: PlannedExecution[];
}

export type PackageEntityType = 'flow' | 'model' | 'mcpServer' | 'plannedExecution';

export interface AutoAddedRef {
  type: PackageEntityType;
  id: string;
  /** Human-readable reason the item was pulled in automatically. */
  reason: string;
}

/** Result of walking a selection to its full dependency closure. */
export interface ResolvedSelection {
  flowIds: string[];
  modelIds: string[];
  mcpServerNames: string[];
  plannedExecutionIds: string[];
  autoAdded: AutoAddedRef[];
  /** Non-fatal advisories (missing referenced entity, circular subflow, …). */
  warnings: string[];
}

/** Package metadata gathered by the wizard's "Metadata" step. */
export interface PackageMetadataInput {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  publisher?: string;
  tags?: string[];
}

export interface BuildManifestResult {
  ok: boolean;
  /** Canonical JSON of the validated package (present on success). */
  json?: string;
  package?: FlujoPackage;
  resolved: ResolvedSelection;
  /** Fatal problems that prevented a build (e.g. a local-only MCP server). */
  errors: string[];
  /** Non-fatal advisories (unused secret, missing referenced entity, …). */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Dependency resolution (pure)
// ---------------------------------------------------------------------------

/**
 * Walk a raw selection to its full dependency closure: subflow descendants,
 * models + MCP servers referenced inside flow nodes, and the flows referenced
 * by selected planned executions. Guards against circular subflow references
 * (a visited set) and records a warning for any reference that points at a
 * missing/deleted entity instead of throwing.
 */
export function resolveDependencies(
  selection: PackageSelection,
  entities: PackageEntities,
): ResolvedSelection {
  const flowById = new Map(entities.flows.map((f) => [f.id, f]));
  const modelById = new Map(entities.models.map((m) => [m.id, m]));
  const serverByName = new Map(entities.mcpServers.map((s) => [s.name, s]));
  const peById = new Map(entities.plannedExecutions.map((p) => [p.id, p]));

  const flowIds = new Set<string>();
  const modelIds = new Set<string>(selection.modelIds ?? []);
  const mcpServerNames = new Set<string>(selection.mcpServerNames ?? []);
  const plannedExecutionIds = new Set<string>(selection.plannedExecutionIds ?? []);
  const autoAdded: AutoAddedRef[] = [];
  const warnings: string[] = [];

  const explicitFlows = new Set(selection.flowIds ?? []);
  const explicitModels = new Set(selection.modelIds ?? []);
  const explicitServers = new Set(selection.mcpServerNames ?? []);

  // Planned executions pull in the flow they run.
  for (const peId of plannedExecutionIds) {
    const pe = peById.get(peId);
    if (!pe) {
      warnings.push(`Planned execution "${peId}" was not found and will be skipped.`);
      continue;
    }
    if (pe.flowId && !explicitFlows.has(pe.flowId) && !flowIds.has(pe.flowId)) {
      autoAdded.push({ type: 'flow', id: pe.flowId, reason: `used by planned execution "${pe.name}"` });
    }
    if (pe.flowId) explicitFlows.add(pe.flowId); // treat as a root to walk
  }

  // Walk flows transitively (subflow refs), collecting model/server refs.
  const visited = new Set<string>();
  const queue: string[] = Array.from(explicitFlows);
  while (queue.length > 0) {
    const flowId = queue.shift() as string;
    if (visited.has(flowId)) continue; // circular-ref guard
    visited.add(flowId);

    const flow = flowById.get(flowId);
    if (!flow) {
      warnings.push(`Referenced flow "${flowId}" was not found and will be skipped.`);
      continue;
    }
    flowIds.add(flowId);

    const refs = collectFlowReferences(flow);
    for (const childFlowId of refs.flowIds ?? []) {
      if (!visited.has(childFlowId)) queue.push(childFlowId);
      if (!explicitFlows.has(childFlowId) && childFlowId !== flowId) {
        if (!flowById.has(childFlowId)) {
          warnings.push(`Flow "${flow.name}" references missing subflow "${childFlowId}".`);
        } else if (!autoAdded.some((a) => a.type === 'flow' && a.id === childFlowId)) {
          autoAdded.push({ type: 'flow', id: childFlowId, reason: `subflow of "${flow.name}"` });
        }
      }
    }
    for (const modelId of refs.modelIds ?? []) {
      if (!modelById.has(modelId)) {
        warnings.push(`Flow "${flow.name}" references missing model "${modelId}".`);
        continue;
      }
      if (!modelIds.has(modelId)) {
        modelIds.add(modelId);
        if (!explicitModels.has(modelId)) {
          autoAdded.push({ type: 'model', id: modelId, reason: `used by flow "${flow.name}"` });
        }
      }
    }
    for (const serverName of refs.mcpServerNames ?? []) {
      if (!serverByName.has(serverName)) {
        warnings.push(`Flow "${flow.name}" references missing MCP server "${serverName}".`);
        continue;
      }
      if (!mcpServerNames.has(serverName)) {
        mcpServerNames.add(serverName);
        if (!explicitServers.has(serverName)) {
          autoAdded.push({ type: 'mcpServer', id: serverName, reason: `used by flow "${flow.name}"` });
        }
      }
    }
  }

  return {
    flowIds: Array.from(flowIds),
    modelIds: Array.from(modelIds),
    mcpServerNames: Array.from(mcpServerNames),
    plannedExecutionIds: Array.from(plannedExecutionIds),
    autoAdded,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// MCP validation + by-reference packaging (pure)
// ---------------------------------------------------------------------------

/** Map a live MCP `source` (#193) to a package `installOrigin` (#192), or null for local/unknown. */
export function mapInstallOrigin(config: MCPServerConfig): McpInstallOrigin | null {
  const source: MCPServerSource | undefined = config.source;
  if (!source || source.type === 'local') return null;
  switch (source.type) {
    case 'github': {
      const ref = source.ref ? `${source.repositoryUrl}@${source.ref}` : source.repositoryUrl;
      return { sourceType: 'github', ref, name: config.name };
    }
    case 'registry':
      return { sourceType: 'registry', ref: source.registryName, name: config.name };
    case 'marketplace':
      return { sourceType: 'marketplace', ref: source.id, name: config.name };
    case 'remote': {
      const url =
        (config as { serverUrl?: string }).serverUrl ??
        (config as { websocketUrl?: string }).websocketUrl;
      return { sourceType: 'remote', url, name: config.name };
    }
    default:
      return null;
  }
}

function isSecretValue(value: EnvVarValue | undefined): boolean {
  return typeof value === 'object' && value !== null && value.metadata?.isSecret === true;
}

/** Build env/header DECLARATIONS (names + isSecret only, never values). */
function declarationsFrom(record: Record<string, EnvVarValue> | undefined): EnvDeclaration[] {
  if (!record) return [];
  return Object.entries(record).map(([name, value]) => ({ name, isSecret: isSecretValue(value) }));
}

export interface McpValidationResult {
  packaged: PackagedMcpServer[];
  /** Fatal per-server problems (local-only server, missing server). */
  errors: string[];
}

/**
 * Validate + pack the selected MCP servers by reference. Local-only servers
 * (no `source`, or `source.type === 'local'`) HARD-ABORT with a clear error —
 * their untrusted code cannot be packaged (#193). Everything else becomes a
 * by-reference entry carrying only env/header declarations.
 */
export function validateMcpSelection(
  serverNames: string[],
  servers: MCPServerConfig[],
): McpValidationResult {
  const byName = new Map(servers.map((s) => [s.name, s]));
  const packaged: PackagedMcpServer[] = [];
  const errors: string[] = [];

  for (const name of serverNames) {
    const config = byName.get(name);
    if (!config) {
      errors.push(`MCP server "${name}" was not found.`);
      continue;
    }
    const installOrigin = mapInstallOrigin(config);
    if (!installOrigin) {
      errors.push(
        `MCP server "${name}" is a local server and cannot be packaged. Re-install it from GitHub, the registry, the marketplace, or as a remote server, then try again.`,
      );
      continue;
    }
    const headers = (config as { headers?: Record<string, EnvVarValue> }).headers;
    const headerDeclarations: HeaderDeclaration[] = declarationsFrom(headers);
    packaged.push({
      name: config.name,
      transport: config.transport,
      ...(config.disabled ? { disabled: true } : {}),
      ...(config.autoApprove && config.autoApprove.length ? { autoApprove: config.autoApprove } : {}),
      ...(config.folder ? { folder: config.folder } : {}),
      installOrigin,
      envDeclarations: declarationsFrom(config.env),
      ...(headerDeclarations.length ? { headerDeclarations } : {}),
    });
  }

  return { packaged, errors };
}

// ---------------------------------------------------------------------------
// Secret derivation (pure)
// ---------------------------------------------------------------------------

/** Turn any string into a valid secret / identifier name (#192 IDENTIFIER_REGEX). */
export function toSecretName(prefix: string, raw: string): string {
  const cleaned = `${prefix}_${raw}`
    .toUpperCase()
    .replace(/[^A-Z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const name = cleaned || `${prefix}_SECRET`;
  return IDENTIFIER_REGEX.test(name) ? name : `${prefix}_SECRET`;
}

/**
 * Decide how a packaged model's API key is supplied WITHOUT ever reading the
 * value: empty key -> none; a `${global:VAR}` binding -> global; anything else
 * (a real or masked key) -> a declared secret. The serializer strips the real
 * `ApiKey` regardless.
 */
export function deriveModelApiKeyRef(model: Model): { ref: PackageApiKeyRef; secret?: PackageSecret } {
  const key = (model.ApiKey ?? '').trim();
  if (!key) return { ref: { kind: 'none' } };

  const globalMatch = GLOBAL_VAR_REGEX.exec(key);
  if (globalMatch) return { ref: { kind: 'global', var: globalMatch[1] } };

  const secretName = toSecretName('MODEL', model.displayName || model.name || model.id);
  return {
    ref: { kind: 'secret', secret: secretName },
    secret: {
      name: secretName,
      description: `API key for model "${model.displayName || model.name}"`,
      required: true,
    },
  };
}

/**
 * Derive `secrets[]` for the packaged MCP servers' secret env/header
 * declarations, binding each secret declaration to a `secretRef`. Mutates the
 * declarations in place (adds `secretRef`) and returns the new secret entries.
 */
export function deriveMcpSecrets(servers: PackagedMcpServer[]): PackageSecret[] {
  const secrets: PackageSecret[] = [];
  const seen = new Set<string>();
  const addFor = (serverName: string, decls: EnvDeclaration[] | undefined) => {
    for (const decl of decls ?? []) {
      if (!decl.isSecret || decl.secretRef) continue;
      const secretName = toSecretName('MCP', `${serverName}_${decl.name}`);
      decl.secretRef = secretName;
      if (!seen.has(secretName)) {
        seen.add(secretName);
        secrets.push({
          name: secretName,
          description: `Secret "${decl.name}" for MCP server "${serverName}"`,
          required: true,
        });
      }
    }
  };
  for (const server of servers) {
    addFor(server.name, server.envDeclarations);
    addFor(server.name, server.headerDeclarations);
  }
  return secrets;
}

/**
 * Preview the secrets a resolved selection will declare (model API keys + MCP
 * secret env/header declarations), WITHOUT building the whole manifest. Powers
 * the wizard's "Secret review" step. Pure.
 */
export function previewPackageSecrets(
  resolved: ResolvedSelection,
  entities: PackageEntities,
): PackageSecret[] {
  const modelById = new Map(entities.models.map((m) => [m.id, m]));
  const secrets: PackageSecret[] = [];
  const seen = new Set<string>();
  const push = (s?: PackageSecret) => {
    if (s && !seen.has(s.name)) {
      seen.add(s.name);
      secrets.push(s);
    }
  };

  for (const id of resolved.modelIds) {
    const model = modelById.get(id);
    if (model) push(deriveModelApiKeyRef(model).secret);
  }
  const mcp = validateMcpSelection(resolved.mcpServerNames, entities.mcpServers);
  for (const s of deriveMcpSecrets(mcp.packaged)) push(s);
  return secrets;
}

// ---------------------------------------------------------------------------
// Manifest assembly (pure, given resolved entities)
// ---------------------------------------------------------------------------

/**
 * Assemble + serialize a package from an ALREADY-RESOLVED selection and the
 * live entities. Pure (no I/O) so it is directly unit-testable. Returns fatal
 * errors (e.g. a local-only MCP server) instead of throwing where possible;
 * only a serializer/schema failure surfaces as an error string.
 */
export function buildManifestFromEntities(
  resolved: ResolvedSelection,
  entities: PackageEntities,
  metadata: PackageMetadataInput,
): BuildManifestResult {
  const errors: string[] = [];
  const warnings = [...resolved.warnings];

  const flowById = new Map(entities.flows.map((f) => [f.id, f]));
  const modelById = new Map(entities.models.map((m) => [m.id, m]));
  const peById = new Map(entities.plannedExecutions.map((p) => [p.id, p]));

  // MCP servers (by reference) — local-only servers hard-abort.
  const mcp = validateMcpSelection(resolved.mcpServerNames, entities.mcpServers);
  errors.push(...mcp.errors);

  // Secrets: model keys + MCP secret declarations.
  const secrets: PackageSecret[] = [];
  const secretNames = new Set<string>();
  const pushSecret = (s?: PackageSecret) => {
    if (s && !secretNames.has(s.name)) {
      secretNames.add(s.name);
      secrets.push(s);
    }
  };

  const models = resolved.modelIds
    .map((id) => modelById.get(id))
    .filter((m): m is Model => Boolean(m));
  const modelInputs = models.map((model) => {
    const { ref, secret } = deriveModelApiKeyRef(model);
    pushSecret(secret);
    return { model, apiKeyRef: ref };
  });

  for (const s of deriveMcpSecrets(mcp.packaged)) pushSecret(s);

  const flows = resolved.flowIds
    .map((id) => flowById.get(id))
    .filter((f): f is Flow => Boolean(f));
  const plannedExecutions = resolved.plannedExecutionIds
    .map((id) => peById.get(id))
    .filter((p): p is PlannedExecution => Boolean(p));

  if (errors.length > 0) {
    return { ok: false, resolved, errors, warnings };
  }

  try {
    const { json, package: pkg } = serializePackage({
      id: metadata.id,
      name: metadata.name,
      version: metadata.version,
      description: metadata.description,
      author: metadata.author,
      publisher: metadata.publisher,
      tags: metadata.tags,
      secrets,
      models: modelInputs,
      mcpServers: mcp.packaged,
      flows,
      plannedExecutions,
    });
    // Surface advisory warnings (e.g. an unused secret) without failing.
    const advisory = validatePackage(pkg);
    if (advisory.warnings?.length) warnings.push(...advisory.warnings);
    return { ok: true, json, package: pkg, resolved, errors, warnings };
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
    return { ok: false, resolved, errors, warnings };
  }
}

// ---------------------------------------------------------------------------
// I/O orchestration
// ---------------------------------------------------------------------------

/** Load every packageable entity from the backend services. */
export async function loadPackageableEntities(): Promise<PackageEntities> {
  const { flowService } = await import('@/backend/services/flow');
  const { modelService } = await import('@/backend/services/model');
  const { loadServerConfigs } = await import('@/backend/services/mcp/config');
  const { getSchedulerService } = await import('@/backend/services/scheduler');

  const [flows, models, serverConfigsRaw, peList] = await Promise.all([
    flowService.loadFlows(),
    modelService.loadModels(),
    loadServerConfigs(),
    getSchedulerService().list(),
  ]);

  const mcpServers = Array.isArray(serverConfigsRaw) ? serverConfigsRaw : [];
  const plannedExecutions = peList.map((entry) => entry.execution);

  return { flows, models, mcpServers, plannedExecutions };
}

/** Resolve a selection against the live entities (I/O wrapper). */
export async function resolvePackageSelection(selection: PackageSelection): Promise<{
  resolved: ResolvedSelection;
  entities: PackageEntities;
}> {
  const entities = await loadPackageableEntities();
  const resolved = resolveDependencies(selection, entities);
  return { resolved, entities };
}

/** Full build: load entities, resolve, validate, serialize (I/O wrapper). */
export async function buildPackageManifest(
  selection: PackageSelection,
  metadata: PackageMetadataInput,
): Promise<BuildManifestResult> {
  log.info(`Building package "${metadata.name}" v${metadata.version}`);
  const { resolved, entities } = await resolvePackageSelection(selection);
  return buildManifestFromEntities(resolved, entities, metadata);
}
