/** Shared package install DTOs. Types only; backend operations remain with their services. */
import type { FlujoPackage, PackagedMcpTransport } from './package';
import type { McpSourceType } from './installOrigin';

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
