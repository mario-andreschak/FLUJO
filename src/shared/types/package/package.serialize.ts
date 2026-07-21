/**
 * Pure (de)serialization + validation helpers for the FLUJO package manifest
 * format (issue #192). No I/O, no crypto, no Node/browser-only APIs — these run
 * in the wizard, the registry backstop, and the installer alike.
 */
import type { Model } from '../model/model';
import type { Flow, FlowNode } from '../flow/flow';
import type { PlannedExecution } from '../plannedExecution/plannedExecution';
import { MANIFEST_SIZE_CAP_BYTES } from './constants';
import { collectSecretPlaceholdersDeep } from './secrets';
import type { PackageSecret } from './secrets';
import type {
  FlujoPackage,
  PackageApiKeyRef,
  PackagedFlow,
  PackagedFlowReferences,
  PackagedMcpServer,
  PackagedModel,
  PackagedPlannedExecution,
} from './package';
import { flujoPackageSchema, hasEncryptedBlob } from './package.schema';

/** UTF-8 byte length of a string (isomorphic; used for the size cap). */
export function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Throw if `value` contains any `encrypted:` string anywhere. A hard backstop
 * against leaking encrypted-at-rest secret material into a package.
 */
export function assertNoEncryptedBlobs(value: unknown): void {
  if (hasEncryptedBlob(value)) {
    throw new Error(
      "Refusing to serialize package: an 'encrypted:' value was found (secret material must never be packaged).",
    );
  }
}

/**
 * Best-effort extraction of the package-internal references a flow's nodes
 * carry in `node.data.properties` (subflow `flowId`s, model ids, MCP server
 * names), so the installer can remap them to fresh uuids. Heuristic by design —
 * it recognises the common property keys FLUJO nodes use.
 */
export function collectFlowReferences(flow: Flow): PackagedFlowReferences {
  const flowIds = new Set<string>();
  const modelIds = new Set<string>();
  const mcpServerNames = new Set<string>();

  for (const node of flow.nodes ?? []) {
    const props = (node as FlowNode).data?.properties ?? {};
    const nodeType = (node as FlowNode).data?.type ?? (node as FlowNode).type;

    const flowRef = props.flowId ?? props.subflowId ?? props.subFlowId;
    if (nodeType === 'subflow' && typeof flowRef === 'string' && flowRef) {
      flowIds.add(flowRef);
    }

    const modelRef = props.boundModel ?? props.modelId ?? props.model;
    if (typeof modelRef === 'string' && modelRef) modelIds.add(modelRef);

    if (nodeType === 'mcp') {
      const serverRef = props.mcpServer ?? props.serverName ?? props.server;
      if (typeof serverRef === 'string' && serverRef) mcpServerNames.add(serverRef);
    }
  }

  const refs: PackagedFlowReferences = {};
  if (flowIds.size) refs.flowIds = Array.from(flowIds);
  if (modelIds.size) refs.modelIds = Array.from(modelIds);
  if (mcpServerNames.size) refs.mcpServerNames = Array.from(mcpServerNames);
  return refs;
}

/** Model input for {@link serializePackage}: the source model + how its key is bound. */
export interface PackageModelInput {
  model: Model;
  apiKeyRef?: PackageApiKeyRef;
}

/** Inputs the serializer assembles into a validated {@link FlujoPackage}. */
export interface SerializePackageInput {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  publisher?: string;
  tags?: string[];
  requiredGlobals?: string[];
  secrets?: PackageSecret[];
  models?: PackageModelInput[];
  /** Already declared by-reference (env/header values never present). */
  mcpServers?: PackagedMcpServer[];
  flows?: Flow[];
  plannedExecutions?: PlannedExecution[];
}

/** Strip `ApiKey` from a live model, attaching an explicit apiKeyRef. */
function packModel({ model, apiKeyRef }: PackageModelInput): PackagedModel {
  const { ApiKey: _dropped, ...rest } = model;
  return { ...(rest as Omit<Model, 'ApiKey'>), apiKeyRef: apiKeyRef ?? { kind: 'none' } };
}

/** Deep JSON clone (data-only structures). */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Strip the webhook token (and any per-instance secret state) from a planned execution. */
function packPlannedExecution(pe: PlannedExecution): PackagedPlannedExecution {
  const copy = clone(pe) as PlannedExecution;
  if (copy.trigger && copy.trigger.type === 'webhook') {
    // Remove the shared secret entirely — never packaged.
    delete (copy.trigger as { token?: string }).token;
  }
  return copy as unknown as PackagedPlannedExecution;
}

/** Assemble a (not-yet-validated) FlujoPackage from raw inputs. */
function buildPackage(input: SerializePackageInput): FlujoPackage {
  return {
    schemaVersion: 1,
    id: input.id,
    name: input.name,
    description: input.description,
    version: input.version,
    author: input.author,
    publisher: input.publisher,
    tags: input.tags,
    requiredGlobals: input.requiredGlobals,
    secrets: input.secrets ?? [],
    models: (input.models ?? []).map(packModel),
    mcpServers: input.mcpServers ?? [],
    flows: (input.flows ?? []).map<PackagedFlow>((flow) => {
      const references = collectFlowReferences(flow);
      return Object.keys(references).length ? { flow, references } : { flow };
    }),
    plannedExecutions: (input.plannedExecutions ?? []).map(packPlannedExecution),
  };
}

/**
 * Build, sanitize, validate, and serialize a package to canonical JSON.
 * Strips model `ApiKey`s and webhook tokens, refuses `encrypted:` blobs,
 * validates against the shared schema, and enforces the size cap.
 */
export function serializePackage(input: SerializePackageInput): {
  json: string;
  package: FlujoPackage;
} {
  const draft = buildPackage(input);
  assertNoEncryptedBlobs(draft);
  const validated = flujoPackageSchema.parse(draft) as unknown as FlujoPackage;
  const json = JSON.stringify(validated);
  const size = byteLength(json);
  if (size > MANIFEST_SIZE_CAP_BYTES) {
    throw new Error(
      `Package exceeds size cap: ${size} bytes > ${MANIFEST_SIZE_CAP_BYTES} bytes.`,
    );
  }
  return { json, package: validated };
}

/**
 * Parse + validate a package JSON string. Enforces the size cap first, then
 * throws (via Zod) on any schema violation.
 */
export function parsePackage(json: string): FlujoPackage {
  const size = byteLength(json);
  if (size > MANIFEST_SIZE_CAP_BYTES) {
    throw new Error(
      `Package exceeds size cap: ${size} bytes > ${MANIFEST_SIZE_CAP_BYTES} bytes.`,
    );
  }
  const raw = JSON.parse(json);
  return flujoPackageSchema.parse(raw) as unknown as FlujoPackage;
}

/** Result of {@link validatePackage}: never throws. */
export interface ValidatePackageResult {
  success: boolean;
  data?: FlujoPackage;
  errors?: string[];
  /** Non-fatal advisories (e.g. a declared-but-unused secret). */
  warnings?: string[];
}

/** Declared secrets that nothing in the package references. */
function unusedSecretWarnings(pkg: FlujoPackage): string[] {
  const referenced = new Set<string>(collectSecretPlaceholdersDeep(pkg));
  for (const model of pkg.models) {
    if (model.apiKeyRef.kind === 'secret') referenced.add(model.apiKeyRef.secret);
  }
  for (const server of pkg.mcpServers) {
    for (const decl of [...server.envDeclarations, ...(server.headerDeclarations ?? [])]) {
      if (decl.secretRef) referenced.add(decl.secretRef);
    }
  }
  return pkg.secrets
    .filter((s) => !referenced.has(s.name))
    .map((s) => `secret "${s.name}" is declared but never referenced`);
}

/**
 * Non-throwing validation for the registry backstop and wizard live-validation.
 * Returns typed data + advisory warnings on success, or human-readable errors.
 */
export function validatePackage(value: unknown): ValidatePackageResult {
  const result = flujoPackageSchema.safeParse(value);
  if (!result.success) {
    const errors = result.error.issues.map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    });
    return { success: false, errors };
  }
  const data = result.data as unknown as FlujoPackage;
  return { success: true, data, warnings: unusedSecretWarnings(data) };
}
