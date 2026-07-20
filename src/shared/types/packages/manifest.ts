/**
 * Package manifest schema (issue #198; aligns with #192).
 *
 * A "package" bundles FLUJO capabilities — MCP servers (by reference), models,
 * flows and planned executions — plus the secrets those entities need. The
 * manifest is DATA ONLY: it never carries executable scripts. MCP servers are
 * installed through the vetted registry / remote-config paths, so a manifest can
 * declare WHICH server to install but never HOW to run arbitrary code.
 *
 * This is the single Zod source of truth the install orchestrator validates
 * against. If #192 lands its own schema, this file should become a thin
 * re-export to avoid drift.
 *
 * Secrets posture: the manifest declares secret KEYS + metadata (label /
 * required) and entities reference those keys (a server's `envFromSecret`, a
 * model's `apiKeySecret`). Actual secret VALUES are supplied out-of-band at
 * install time and are never part of the manifest.
 */
import { z } from 'zod';

/** The only manifest schema version this build understands. */
export const PACKAGE_MANIFEST_SCHEMA_VERSION = '1';

/**
 * A secret the package needs. `targets` is optional, purely-declarative metadata
 * for the consent screen (e.g. "used by server X, model Y"); the authoritative
 * wiring is the entity-level reference (`envFromSecret` / `apiKeySecret`).
 */
export const SecretSpecSchema = z.object({
  key: z.string().min(1),
  label: z.string().optional(),
  required: z.boolean().optional(),
  targets: z.array(z.string()).optional(),
});
export type SecretSpec = z.infer<typeof SecretSpecSchema>;

/** Install this MCP server from the public registry (via installRegistryServer). */
export const RegistryServerRefSchema = z.object({
  kind: z.literal('registry'),
  /** The exact registry name, e.g. "ai.keenable/web-search". */
  registryName: z.string().min(1),
});

/** A remote (HTTP/SSE/WebSocket) MCP server — plain config creation. */
export const RemoteServerRefSchema = z.object({
  kind: z.literal('remote'),
  transport: z.enum(['sse', 'streamable', 'websocket']).optional(),
  /** http(s):// URL for sse/streamable; ws(s):// URL for websocket. */
  serverUrl: z.string().min(1),
});

export const ServerRefSchema = z.discriminatedUnion('kind', [
  RegistryServerRefSchema,
  RemoteServerRefSchema,
]);

export const ManifestServerSchema = z.object({
  /** The name this server is installed under in FLUJO (referenced by flows). */
  localName: z.string().min(1),
  ref: ServerRefSchema,
  /** Literal environment values, by env-var name. */
  env: z.record(z.string(), z.string()).optional(),
  /** Map of env-var name -> secret key; resolved from the supplied secrets. */
  envFromSecret: z.record(z.string(), z.string()).optional(),
});
export type ManifestServer = z.infer<typeof ManifestServerSchema>;

export const ManifestModelSchema = z.object({
  /** Provider model id (the technical `name`). */
  name: z.string().min(1),
  /** Unique display name — the idempotency key for models. */
  displayName: z.string().min(1),
  provider: z.string().optional(),
  baseUrl: z.string().optional(),
  description: z.string().optional(),
  promptTemplate: z.string().optional(),
  temperature: z.string().optional(),
  /** Secret key whose value becomes the model's (encrypted-at-rest) API key. */
  apiKeySecret: z.string().optional(),
  /** Alternatively, bind the API key to a global var (stored as ${global:VAR}). */
  apiKeyGlobalVar: z.string().optional(),
});
export type ManifestModel = z.infer<typeof ManifestModelSchema>;

/**
 * A flow, as authored in the package. Ids are manifest-LOCAL and remapped to
 * fresh, deterministic ids on install. Extra Flow fields (description, folder,
 * input, ...) are preserved via catchall.
 */
export const ManifestFlowSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    nodes: z.array(z.any()),
    edges: z.array(z.any()),
  })
  .catchall(z.unknown());
export type ManifestFlow = z.infer<typeof ManifestFlowSchema>;

/**
 * A planned execution to create (DISABLED by default). `flowId` is manifest-LOCAL
 * and remapped to the installed flow's id. Extra fields (overlapStrategy,
 * approvalPolicy, ...) are preserved via catchall.
 */
export const ManifestPlannedExecutionSchema = z
  .object({
    name: z.string().min(1),
    /** Manifest-local id of the flow this execution runs. */
    flowId: z.string().min(1),
    prompt: z.string(),
    trigger: z.any(),
  })
  .catchall(z.unknown());
export type ManifestPlannedExecution = z.infer<typeof ManifestPlannedExecutionSchema>;

export const PackageManifestSchema = z.object({
  schemaVersion: z.literal(PACKAGE_MANIFEST_SCHEMA_VERSION),
  /** Stable package key (used for idempotent re-installs). */
  name: z.string().min(1),
  version: z.string().min(1),
  publisher: z.string().optional(),
  description: z.string().optional(),
  secrets: z.array(SecretSpecSchema).optional(),
  mcpServers: z.array(ManifestServerSchema).optional(),
  models: z.array(ManifestModelSchema).optional(),
  flows: z.array(ManifestFlowSchema).optional(),
  plannedExecutions: z.array(ManifestPlannedExecutionSchema).optional(),
});
export type PackageManifest = z.infer<typeof PackageManifestSchema>;

export type ParsePackageManifestResult =
  | { ok: true; manifest: PackageManifest }
  | { ok: false; errors: string[] };

/**
 * Safely validate an untrusted manifest blob. Returns the typed manifest on
 * success, or a list of human-readable validation errors on failure — never
 * throws.
 */
export function parsePackageManifest(raw: unknown): ParsePackageManifestResult {
  const result = PackageManifestSchema.safeParse(raw);
  if (result.success) {
    return { ok: true, manifest: result.data };
  }
  const errors = result.error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  return { ok: false, errors };
}
