/**
 * FLUJO package manifest format — `FlujoPackage` v1 (issue #192).
 *
 * The canonical, capability-bundling manifest: MCP servers (by reference),
 * models (configuration only), flows (full ReactFlow JSON) and planned
 * executions, plus the secrets those entities need. DATA ONLY — it never
 * carries executable scripts, server files, API keys, tokens, or `encrypted:`
 * blobs. Every other Packages issue (wizard, secret derivation, registry API,
 * install flow) builds on these types.
 *
 * TS interfaces are hand-written here (referencing the live `Flow` /
 * `PlannedExecution` shapes for good editor types); the runtime validator lives
 * in `package.schema.ts` and is intentionally looser on the deeply-nested
 * ReactFlow bits (passthrough), mirroring the repo's existing manifest pattern.
 */
import type { Flow } from '../flow/flow';
import type { PlannedExecution, TriggerConfig, WebhookTriggerConfig } from '../plannedExecution/plannedExecution';
import type { PackageSecret } from './secrets';
import type { EnvDeclaration, HeaderDeclaration, McpInstallOrigin } from './installOrigin';

/**
 * How a packaged model's API key is supplied at install time. The real key is
 * NEVER serialized:
 * - `secret`: comes from a declared `secrets[]` entry.
 * - `global`: bound to a host `${global:VAR}` variable.
 * - `none`: the model needs no key (e.g. a local endpoint).
 */
export type PackageApiKeyRef =
  | { kind: 'secret'; secret: string }
  | { kind: 'global'; var: string }
  | { kind: 'none' };

/**
 * A model packaged as configuration only: the live `Model` shape MINUS
 * `ApiKey`, plus an explicit `apiKeyRef`. The serializer strips `ApiKey` and
 * refuses to emit any `encrypted:` value.
 */
export interface PackagedModel {
  id: string;
  name: string;
  displayName?: string;
  description?: string;
  baseUrl?: string;
  provider?: string;
  adapter?: string;
  promptTemplate?: string;
  reasoningSchema?: string;
  temperature?: string;
  functionCallingSchema?: string;
  contextWindow?: number;
  maxTurns?: number;
  maxTokens?: number;
  folder?: string;
  favorite?: boolean;
  apiKeyRef: PackageApiKeyRef;
}

/** Transport of a packaged MCP server (mirrors the live union's discriminant). */
export type PackagedMcpTransport = 'stdio' | 'sse' | 'streamable' | 'websocket';

/**
 * A packaged MCP server, by reference only. No `command`, `args`, `rootPath`,
 * `_buildCommand`, `_installCommand`, `serverUrl`, OAuth secrets, or server
 * files — just where to install it (`installOrigin`) and DECLARATIONS of the
 * env vars / headers it needs (names + `isSecret`, never values).
 */
export interface PackagedMcpServer {
  name: string;
  transport: PackagedMcpTransport;
  disabled?: boolean;
  autoApprove?: string[];
  folder?: string;
  installOrigin: McpInstallOrigin;
  envDeclarations: EnvDeclaration[];
  headerDeclarations?: HeaderDeclaration[];
}

/**
 * Package-internal references discovered inside a flow's nodes
 * (`node.data.properties`), recorded so the installer can remap them to fresh
 * uuids (as a proper restore should). This issue only declares/validates the
 * shape; actual remapping belongs to the install issue.
 */
export interface PackagedFlowReferences {
  /** Subflow node `flowId`s that must resolve to another packaged flow. */
  flowIds?: string[];
  /** Model ids referenced by process/mcp nodes. */
  modelIds?: string[];
  /** MCP server names referenced by mcp nodes. */
  mcpServerNames?: string[];
}

/** A flow carried in full ReactFlow JSON, with its extracted references. */
export interface PackagedFlow {
  flow: Flow;
  references?: PackagedFlowReferences;
}

/**
 * A packaged trigger: the live `TriggerConfig` union, except the webhook
 * variant's per-instance secret `token` is excluded (optional) — the serializer
 * omits it.
 */
export type PackagedTrigger =
  | Exclude<TriggerConfig, WebhookTriggerConfig>
  | (Omit<WebhookTriggerConfig, 'token'> & { token?: string });

/**
 * A packaged planned execution: the full `PlannedExecution` config with
 * `flowId` expressed as a package-internal flow reference and the webhook token
 * (and similar per-instance state) excluded.
 */
export type PackagedPlannedExecution = Omit<PlannedExecution, 'trigger'> & {
  trigger: PackagedTrigger;
};

/**
 * The FLUJO package manifest, v1. A single JSON document (the registry stores
 * it as a blob), validated by the shared `flujoPackageSchema`.
 */
export interface FlujoPackage {
  /** Literal `1`; guarded by `PACKAGE_SCHEMA_VERSION`. */
  schemaVersion: 1;
  /** Package identity (uuid/slug), distinct from any packaged entity id. */
  id: string;
  name: string;
  description?: string;
  /** Semantic version of the package. */
  version: string;
  author?: string;
  publisher?: string;
  tags?: string[];
  /** `${global:VAR}` names the package expects the host to provide. */
  requiredGlobals?: string[];
  secrets: PackageSecret[];
  models: PackagedModel[];
  mcpServers: PackagedMcpServer[];
  flows: PackagedFlow[];
  plannedExecutions: PackagedPlannedExecution[];
}
