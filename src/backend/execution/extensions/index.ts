import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { MCPServerConfig } from '@/shared/types/mcp';
import type { FlowRunInput } from '@/backend/execution/flow/runFlow';
import type { RestrictedCodexProfile } from '@/backend/services/model/adapters/codexRestrictedProfile';
import { isOwnerCredentialBoundModel, validateOwnerCredentialBinding, type Model } from '@/shared/types/model';
import { configuredExecutionAdapter } from '@/backend/execution/extensions/configuredAdapter';
import { resolveCompletionAdapterRoute, type CompletionAdapterRoute } from '@/backend/services/model/adapters/completionRoute';

declare const contextBrand: unique symbol;
/** Opaque capability minted by trusted server code, never by request metadata. */
export interface ExecutionExtensionContext { readonly [contextBrand]: true }
/** Retry restriction only; never a grant of inference, spend or replay authority. */
export interface ExecutionModelAttemptPolicy { version: 1; maxPhysicalAttempts: 1 }
export type ExecutionModelIdentity = Pick<Model, 'id' | 'name' | 'adapter' | 'provider' | 'baseUrl'>;
export interface ExecutionOwnerCredentialBinding { ownerId: string; credentialId: string }
export interface ExecutionBoundModelIdentity extends ExecutionModelIdentity {
  ownerCredentialBinding: ExecutionOwnerCredentialBinding;
}
/** The SDK-final request, without an upstream credential. The owner compares
 * the exact recipient, headers and body with its authenticated step, inserts
 * its held credential, and performs the physical send. */
export interface ExecutionOwnerModelDispatchRequest {
  version: 2;
  operation: 'chat.completions.create' | 'chat.completions.create(stream)';
  model: ExecutionBoundModelIdentity;
  method: 'POST';
  url: string;
  headers: ReadonlyArray<readonly [string, string]>;
  body: Uint8Array;
  bodySha256: string;
  headersSha256: string;
  routingHeaderSha256: ExecutionModelRequestIntent['routingHeaderSha256'];
  signal?: AbortSignal;
}
/** The SDK-final request is observed at its fetch seam. The owner must compare
 * URL, method, body, credential and routing projection with original authority. */
export interface ExecutionModelRequestIntent {
  version: 1;
  operation: 'chat.completions.create' | 'chat.completions.create(stream)';
  model: ExecutionModelIdentity;
  method: 'POST';
  url: string;
  bodySha256: string;
  /** Digest of the effective Authorization header; never the credential itself. */
  authorizationSha256: string;
  /** SHA-256 of JSON-encoded, lower-case, name-sorted SDK-final header pairs. */
  headersSha256: string;
  /** Closed routing/account header projection; null means absent. Values are
   * digests, not raw environment or credential material. */
  routingHeaderSha256: {
    openaiOrganization: string | null;
    openaiProject: string | null;
    httpReferer: string | null;
    xTitle: string | null;
  };
}
const errorRoot = globalThis as typeof globalThis & { __flujoExecutionExtensionErrors?: WeakSet<object> };
const trustedErrors = errorRoot.__flujoExecutionExtensionErrors ??= new WeakSet<object>();
export class ExecutionExtensionError extends Error {
  constructor(readonly code: string, readonly status = 403) {
    super(code); this.name = 'ExecutionExtensionError'; trustedErrors.add(this);
  }
  // Trusted adapters are shared across Next server graphs; their errors must
  // retain provenance too. Serialized names/codes never establish that trust.
  static [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === 'object' && value !== null && trustedErrors.has(value);
  }
}
export interface ExecutionExtensionAdapter {
  /** undefined = ordinary transport policy; null = accepted narrow transport. */
  authorizeTransport?(request: Request): Response | null | undefined;
  withRoute?(request: Request, task: (request: Request) => Promise<Response>): Promise<Response>;
  isProtectedServer(server: string): boolean;
  assertServerConfig(config: MCPServerConfig): void;
  assertRun(context: object, expected?: { conversationId?: string; runId?: string; graphHash?: string }): Promise<void>;
  assertConversationAccess?(conversationId: string): Promise<void>;
  isProtectedState?(state: unknown): boolean;
  exposeConversationInList?(conversationId: string): Promise<boolean>;
  validateRun?(input: FlowRunInput, context: object): Promise<void>;
  validateLoadedState?(context: object, state: unknown): Promise<void>;
  bindRun(context: object, conversation: string, run: string): Promise<void>;
  signal(context: object): AbortSignal | undefined;
  commit<T>(context: object, task: () => Promise<T>): Promise<T>;
  protectedServer(context: object): string;
  authorizeHandoffs(context: object, names: string[]): void;
  assertModelTool(context: object, name: string, advertised: { server: string; tool: string } | undefined): Promise<void>;
  assertDispatch(context: object | undefined, server: string, source: string): Promise<void>;
  normalizeArguments(context: object, tool: string, args: Record<string, unknown>): Record<string, unknown>;
  /** Called after final argument normalization; produces private MCP metadata only. */
  requestMeta(context: object, server: string, tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  validateResult(context: object, tool: string, result: unknown): unknown;
  /** Trusted attestation for an independently verified native CLI restriction profile. */
  codexProfile?(context: object): RestrictedCodexProfile | undefined | Promise<RestrictedCodexProfile | undefined>;
  /** Read-only attestation, potentially queried more than once per logical call.
   * Authenticated original owner may forbid automatic physical inference replay.
   * Verify model/endpoint, request, lease, OFF and budget in the owning adapter;
   * public Model records and caller options cannot supply this attestation. */
  modelAttemptPolicy?(context: object, model: ExecutionModelIdentity): ExecutionModelAttemptPolicy | undefined | Promise<ExecutionModelAttemptPolicy | undefined>;
  /** Required for the one-attempt path. The original owner must durably claim
   * this exact model/body under its own run and budget before any POST starts. */
  claimModelRequest?(context: object, intent: ExecutionModelRequestIntent): Promise<void>;
  /** Return a fresh private child authority for exactly one bound model step.
   * The returned value must be recognized by assertRun and dispatchModelRequest. */
  issueModelStep?(parent: object, model: ExecutionBoundModelIdentity): Promise<object>;
  /** Must validate/claim the exact child and physically send once using the
   * owner-held credential. FLUJO never opens a socket for this path. */
  dispatchModelRequest?(step: object, request: ExecutionOwnerModelDispatchRequest): Promise<Response>;
}
type ContextRecord = { adapter: ExecutionExtensionAdapter; value: object; modelRequestConsumed?: boolean; singlePhysicalAttemptRequired?: boolean; modelStep?: { parent: ExecutionExtensionContext; model: ExecutionBoundModelIdentity } };
type Access = { conversationId: string; assertCurrent: () => Promise<void> };
type Registry = { adapter?: ExecutionExtensionAdapter; configuredAdapter?: ExecutionExtensionAdapter; contexts: WeakMap<object, ContextRecord>; modelStepValues?: WeakSet<object>; input: AsyncLocalStorage<Partial<FlowRunInput>>; access: AsyncLocalStorage<Access>; committing: AsyncLocalStorage<ExecutionExtensionContext> };
const root = globalThis as typeof globalThis & { __flujoExecutionExtensions?: Registry };
const registry = root.__flujoExecutionExtensions ??= { contexts: new WeakMap(), input: new AsyncLocalStorage(), access: new AsyncLocalStorage(), committing: new AsyncLocalStorage() };

function configuredAdapterInProcess(): ExecutionExtensionAdapter | undefined {
  // Next evaluates the static module in multiple server graphs. MCP services
  // and capabilities share this process registry, so their adapter must too.
  // Proxy runtimes have their own registry and authenticate independently.
  return registry.configuredAdapter ??= configuredExecutionAdapter;
}
function canonicalAdapter(adapter: ExecutionExtensionAdapter): ExecutionExtensionAdapter {
  return adapter === configuredExecutionAdapter ? configuredAdapterInProcess() ?? adapter : adapter;
}
export function registerExecutionExtension(adapter: ExecutionExtensionAdapter): () => void {
  adapter = canonicalAdapter(adapter);
  const previous = registry.adapter;
  registry.adapter = adapter;
  return () => { if (registry.adapter === adapter) registry.adapter = previous; };
}
export function executionExtensionAdapter(): ExecutionExtensionAdapter | undefined {
  const adapter = registry.adapter ?? configuredAdapterInProcess();
  if (!adapter && process.env.FLUJO_EXECUTION_ADAPTER_MODULE) throw new ExecutionExtensionError('execution_adapter_not_loaded', 503);
  return adapter;
}
export function createExecutionExtensionContext(adapter: ExecutionExtensionAdapter, value: object): ExecutionExtensionContext {
  const context = Object.freeze({}) as ExecutionExtensionContext;
  registry.contexts.set(context, { adapter: canonicalAdapter(adapter), value });
  return context;
}
function boundModelIdentity(model: Model): ExecutionBoundModelIdentity | undefined {
  if (!isOwnerCredentialBoundModel(model)) return undefined;
  if (validateOwnerCredentialBinding(model) || resolveCompletionAdapterRoute(model) !== 'openai') {
    throw new ExecutionExtensionError('execution_owner_model_binding_invalid');
  }
  const binding = model.ownerCredentialBinding!;
  return { id: model.id, name: model.name, adapter: model.adapter, provider: model.provider,
    baseUrl: model.baseUrl, ownerCredentialBinding: { ownerId: binding.ownerId, credentialId: binding.credentialId } };
}
function sameBoundModel(a: ExecutionBoundModelIdentity, candidate: unknown): boolean {
  if (!candidate || typeof candidate !== 'object') return false;
  const b = candidate as Partial<ExecutionBoundModelIdentity>;
  if (!b.ownerCredentialBinding || typeof b.ownerCredentialBinding !== 'object') return false;
  return a.id === b.id && a.name === b.name && a.adapter === b.adapter &&
    a.provider === b.provider && a.baseUrl === b.baseUrl &&
    a.ownerCredentialBinding.ownerId === b.ownerCredentialBinding.ownerId &&
    a.ownerCredentialBinding.credentialId === b.ownerCredentialBinding.credentialId;
}
/** A trusted parent can request a fresh child only for a bound model. The
 * owner still authenticates the original step and accounts for its budget. */
export async function issueExecutionModelStepContext(parent: ExecutionExtensionContext, model: Model): Promise<ExecutionExtensionContext> {
  const identity = boundModelIdentity(model);
  if (!identity) throw new ExecutionExtensionError('execution_owner_model_binding_required');
  const item = record(parent);
  if (item.modelStep) throw new ExecutionExtensionError('execution_model_step_parent_required');
  if (!item.adapter.issueModelStep) throw new ExecutionExtensionError('execution_model_step_issuer_required');
  try {
    await item.adapter.assertRun(item.value);
    const value = await item.adapter.issueModelStep(item.value, identity);
    if (!value || typeof value !== 'object' || value === item.value) throw new ExecutionExtensionError('execution_model_step_invalid');
    const issued = registry.modelStepValues ??= new WeakSet<object>();
    if (issued.has(value)) throw new ExecutionExtensionError('execution_model_step_reused');
    // Reserve before awaiting either owner check. A second concurrent issuer
    // must not mint another branded wrapper around the same private value.
    issued.add(value);
    await item.adapter.assertRun(item.value);
    await item.adapter.assertRun(value);
    record(parent);
    const child = Object.freeze({}) as ExecutionExtensionContext;
    registry.contexts.set(child, { adapter: item.adapter, value, modelStep: { parent, model: identity } });
    return child;
  } catch (error) {
    if (error instanceof ExecutionExtensionError) throw error;
    throw new ExecutionExtensionError('execution_model_step_denied');
  }
}
function record(context: ExecutionExtensionContext | undefined): ContextRecord {
  const value = context && registry.contexts.get(context);
  if (!value || value.adapter !== executionExtensionAdapter()) throw new ExecutionExtensionError('trusted_execution_context_required');
  return value;
}
export function runWithExecutionInput<T>(input: Partial<FlowRunInput>, task: () => T): T { return registry.input.run(input, task); }
export function applyExecutionRunInput(input: FlowRunInput): FlowRunInput {
  const trusted = registry.input.getStore();
  return trusted ? { ...input, ...trusted } : input;
}
export async function withExecutionExtensionRoute(request: Request, task: (request: Request) => Promise<Response>): Promise<Response> {
  const adapter = executionExtensionAdapter();
  return adapter?.withRoute ? adapter.withRoute(request, task) : task(request);
}
export function authorizeExecutionTransport(request: Request): Response | null | undefined { return executionExtensionAdapter()?.authorizeTransport?.(request); }
export function isProtectedExecutionServer(server: string): boolean { return executionExtensionAdapter()?.isProtectedServer(server) ?? false; }
export function assertExecutionServerConfig(config: MCPServerConfig): void { executionExtensionAdapter()?.assertServerConfig(config); }
export async function assertExecutionExtensionCurrent(context: ExecutionExtensionContext | undefined, expected?: { conversationId?: string; runId?: string; graphHash?: string }): Promise<void> {
  const item = record(context);
  if (item.modelStep) await assertExecutionExtensionCurrent(item.modelStep.parent, expected);
  await item.adapter.assertRun(item.value, expected);
}
/** Synchronous registry check for the last local SDK call site. */
export function assertExecutionExtensionAdapterCurrent(context: ExecutionExtensionContext): void {
  const item = record(context);
  if (item.modelStep) record(item.modelStep.parent);
}
export function runWithExecutionConversationAccess<T>(conversationId: string, assertCurrent: () => Promise<void>, task: () => T): T {
  return registry.access.run({ conversationId, assertCurrent }, task);
}
function hasCurrentConversationAccess(conversation: string): boolean {
  return registry.access.getStore()?.conversationId === conversation ||
    (registry.input.getStore()?.conversationId === conversation && Boolean(registry.input.getStore()?.executionExtensionContext));
}
export async function assertExecutionConversationAccess(conversation: string): Promise<void> {
  const access = registry.access.getStore();
  if (access?.conversationId === conversation) return access.assertCurrent();
  const input = registry.input.getStore();
  if (input?.conversationId === conversation && input.executionExtensionContext) return assertExecutionExtensionCurrent(input.executionExtensionContext, { conversationId: conversation });
  await executionExtensionAdapter()?.assertConversationAccess?.(conversation);
}
export async function assertExecutionStateAccess(state: unknown, conversation: string): Promise<void> {
  const owned = isExecutionProtectedState(state);
  if (owned && !hasCurrentConversationAccess(conversation)) throw new ExecutionExtensionError('trusted_execution_context_required');
  if (owned) await assertExecutionConversationAccess(conversation);
}
export function isExecutionProtectedState(state: unknown): boolean {
  return Boolean(state && typeof state === 'object' && (state as { executionExtensionOwned?: boolean }).executionExtensionOwned) ||
    Boolean(executionExtensionAdapter()?.isProtectedState?.(state));
}
export async function exposeExecutionConversationInList(conversation: string): Promise<boolean> {
  return await executionExtensionAdapter()?.exposeConversationInList?.(conversation) ?? true;
}
export async function validateExecutionExtensionRun(input: FlowRunInput): Promise<void> {
  if (input.executionExtensionContext) { const item = record(input.executionExtensionContext); await item.adapter.validateRun?.(input, item.value); }
  else if (input.conversationId) await assertExecutionConversationAccess(input.conversationId);
}
export async function validateExecutionLoadedState(context: ExecutionExtensionContext, state: unknown): Promise<void> {
  const item = record(context); await item.adapter.assertRun(item.value); await item.adapter.validateLoadedState?.(item.value, state);
}
export function installExecutionExtensionContext(state: { executionExtensionContext?: ExecutionExtensionContext; executionExtensionOwned?: boolean }, context: ExecutionExtensionContext): void {
  record(context);
  Object.defineProperty(state, 'executionExtensionContext', { value: context, enumerable: false, configurable: true, writable: true });
  state.executionExtensionOwned = true;
}
export async function bindExecutionExtensionRun(context: ExecutionExtensionContext, conversation: string, run: string): Promise<void> { const item = record(context); await item.adapter.bindRun(item.value, conversation, run); }
export function executionExtensionSignal(context: ExecutionExtensionContext): AbortSignal | undefined {
  const item = record(context);
  const signal = item.adapter.signal(item.value);
  if (!item.modelStep) return signal;
  const parent = executionExtensionSignal(item.modelStep.parent);
  return parent && signal && parent !== signal ? AbortSignal.any([parent, signal]) : parent ?? signal;
}
export async function commitExecutionExtensionMutation<T>(context: ExecutionExtensionContext, task: () => Promise<T>): Promise<T> {
  const item = record(context);
  if (registry.committing.getStore() === context) {
    await item.adapter.assertRun(item.value); const result = await task(); await item.adapter.assertRun(item.value); return result;
  }
  return item.adapter.commit(item.value, () => registry.committing.run(context, task));
}
export function executionExtensionProtectedServer(context: ExecutionExtensionContext): string { const item = record(context); return item.adapter.protectedServer(item.value); }
export function authorizeExecutionExtensionHandoffs(context: ExecutionExtensionContext, names: string[]): void { const item = record(context); item.adapter.authorizeHandoffs(item.value, names); }
export async function assertExecutionModelTool(context: ExecutionExtensionContext, name: string, advertised: { server: string; tool: string } | undefined): Promise<void> { const item = record(context); await item.adapter.assertModelTool(item.value, name, advertised); }
export async function assertExecutionToolDispatch(context: ExecutionExtensionContext | undefined, server: string, source: string): Promise<void> {
  if (context) { const item = record(context); await item.adapter.assertDispatch(item.value, server, source); }
  else if (isProtectedExecutionServer(server)) await executionExtensionAdapter()!.assertDispatch(undefined, server, source);
}
export function normalizeExecutionToolArguments(context: ExecutionExtensionContext, tool: string, args: Record<string, unknown>): Record<string, unknown> { const item = record(context); return item.adapter.normalizeArguments(item.value, tool, args); }
export async function executionToolRequestMeta(context: ExecutionExtensionContext, server: string, tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> { const item = record(context); await item.adapter.assertRun(item.value); return item.adapter.requestMeta(item.value, server, tool, args); }
export function validateExecutionToolResult(context: ExecutionExtensionContext, tool: string, result: unknown): unknown { const item = record(context); return item.adapter.validateResult(item.value, tool, result); }
export async function executionExtensionCodexProfile(context: ExecutionExtensionContext): Promise<RestrictedCodexProfile | undefined> {
  const item = record(context);
  await item.adapter.assertRun(item.value);
  return item.adapter.codexProfile?.(item.value);
}

/** Resolve a restriction exclusively through the current branded server capability. */
export async function executionExtensionSinglePhysicalAttempt(
  context: ExecutionExtensionContext | undefined, model: Model,
): Promise<boolean> {
  const bound = boundModelIdentity(model);
  if (bound) {
    const item = record(context);
    if (!item.modelStep || !sameBoundModel(item.modelStep.model, bound)) {
      throw new ExecutionExtensionError('execution_model_step_context_required');
    }
    if (!item.adapter.dispatchModelRequest) throw new ExecutionExtensionError('execution_model_dispatch_required');
    await assertExecutionExtensionCurrent(context);
    return true;
  }
  if (!context) return false;
  const item = record(context);
  if (item.modelStep) throw new ExecutionExtensionError('execution_model_step_mismatch');
  // An owner transport cannot silently downgrade when a saved bound model is
  // replaced under the same ID by an unbound record before dispatch.
  if (item.adapter.issueModelStep || item.adapter.dispatchModelRequest) {
    throw new ExecutionExtensionError('execution_owner_model_binding_required');
  }
  await item.adapter.assertRun(item.value);
  const policy = await item.adapter.modelAttemptPolicy?.(item.value, {
    id: model.id, name: model.name, adapter: model.adapter, provider: model.provider, baseUrl: model.baseUrl,
  });
  const validPolicy = Boolean(policy && Object.keys(policy).length === 2
    && policy.version === 1 && policy.maxPhysicalAttempts === 1);
  // Latch before the awaited second owner check so a concurrent policy query
  // cannot slip into ordinary transport after this context has observed v1.
  if (validPolicy) record(context).singlePhysicalAttemptRequired = true;
  await assertExecutionExtensionCurrent(context);
  // A protected policy observed earlier in this trusted context must not be
  // downgraded across ModelHandler preflight and the adapter's later check.
  if (policy === undefined) {
    if (record(context).singlePhysicalAttemptRequired) throw new ExecutionExtensionError('execution_model_attempt_policy_changed');
    return false;
  }
  if (!validPolicy) {
    throw new ExecutionExtensionError('execution_model_attempt_policy_invalid');
  }
  // Only this adapter's physical request boundary is qualified by this contract.
  if (resolveCompletionAdapterRoute(model) !== 'openai') {
    throw new ExecutionExtensionError('execution_single_attempt_adapter_unsupported');
  }
  return true;
}

/** Direct adapter entry points must not treat a model's declared route as proof
 * that this concrete adapter has the protected pre-send claim boundary. */
export async function assertExecutionExtensionConcreteAdapter(
  context: ExecutionExtensionContext | undefined,
  model: Model,
  concreteRoute: CompletionAdapterRoute,
): Promise<void> {
  if (await executionExtensionSinglePhysicalAttempt(context, model) && concreteRoute !== 'openai') {
    throw new ExecutionExtensionError('execution_single_attempt_adapter_unsupported');
  }
}

/** Consume one trusted context before awaiting owner I/O, so parallel calls
 * cannot both cross the local adapter boundary. This is process-local hygiene;
 * only the original owner's durable claim can fence other workers or restarts. */
export async function claimExecutionModelRequest(
  context: ExecutionExtensionContext,
  intent: ExecutionModelRequestIntent,
): Promise<void> {
  const item = record(context);
  if (item.modelRequestConsumed) throw new ExecutionExtensionError('execution_model_request_already_claimed');
  item.modelRequestConsumed = true;
  if (!item.adapter.claimModelRequest) throw new ExecutionExtensionError('execution_model_request_claim_required');
  try {
    await item.adapter.assertRun(item.value);
    await item.adapter.claimModelRequest(item.value, intent);
    await assertExecutionExtensionCurrent(context);
    record(context);
  } catch (error) {
    if (error instanceof ExecutionExtensionError) throw error;
    throw new ExecutionExtensionError('execution_model_request_claim_denied');
  }
}

const ownerModelHeaderNames = new Set([
  'accept', 'content-type', 'user-agent',
  'http-referer', 'x-title', 'openai-organization', 'openai-project',
  'x-stainless-arch', 'x-stainless-lang', 'x-stainless-os',
  'x-stainless-package-version', 'x-stainless-retry-count',
  'x-stainless-runtime', 'x-stainless-runtime-version', 'x-stainless-timeout',
]);
const modelDigest = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
function boundChatUrl(model: ExecutionBoundModelIdentity): string {
  const baseUrl = model.baseUrl ?? 'https://api.openai.com/v1';
  try {
    const base = new URL(baseUrl);
    if (!['http:', 'https:'].includes(base.protocol) ||
        (base.protocol === 'http:' && !['127.0.0.1', '[::1]'].includes(base.hostname)) ||
        base.username || base.password || base.search || base.hash) throw new Error('invalid');
    return new URL(`${baseUrl}${baseUrl.endsWith('/') ? '' : '/'}chat/completions`).toString();
  } catch {
    throw new ExecutionExtensionError('execution_model_endpoint_invalid');
  }
}
function snapshotOwnerRequest(request: ExecutionOwnerModelDispatchRequest, model: ExecutionBoundModelIdentity): ExecutionOwnerModelDispatchRequest {
  if (!Array.isArray(request.headers) || !(request.body instanceof Uint8Array)) {
    throw new ExecutionExtensionError('execution_model_wire_mismatch');
  }
  const headers: Array<readonly [string, string]> = [];
  for (const pair of request.headers) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') {
      throw new ExecutionExtensionError('execution_model_wire_mismatch');
    }
    headers.push([pair[0], pair[1]]);
  }
  if (headers.some((pair, index) =>
      !ownerModelHeaderNames.has(pair[0]) || (index > 0 && headers[index - 1][0] >= pair[0]))) {
    throw new ExecutionExtensionError('execution_model_wire_mismatch');
  }
  const body = Uint8Array.from(request.body);
  const headerValue = (name: string): string | null => headers.find(([key]) => key === name)?.[1] ?? null;
  const routingDigest = (name: string): string | null => {
    const value = headerValue(name);
    return value === null ? null : modelDigest(value);
  };
  const projection = request.routingHeaderSha256;
  if (request.version !== 2 ||
      !['chat.completions.create', 'chat.completions.create(stream)'].includes(request.operation) ||
      request.method !== 'POST' || request.url !== boundChatUrl(model) ||
      headerValue('content-type') !== 'application/json' ||
      request.bodySha256 !== modelDigest(body) ||
      request.headersSha256 !== modelDigest(JSON.stringify(headers)) ||
      !projection || projection.openaiOrganization !== routingDigest('openai-organization') ||
      projection.openaiProject !== routingDigest('openai-project') ||
      projection.httpReferer !== routingDigest('http-referer') ||
      projection.xTitle !== routingDigest('x-title')) {
    throw new ExecutionExtensionError('execution_model_wire_mismatch');
  }
  return {
    version: 2,
    operation: request.operation,
    model: { id: model.id, name: model.name, adapter: model.adapter, provider: model.provider,
      baseUrl: model.baseUrl, ownerCredentialBinding: { ...model.ownerCredentialBinding } },
    method: 'POST',
    url: request.url,
    headers,
    body,
    bodySha256: request.bodySha256,
    headersSha256: request.headersSha256,
    routingHeaderSha256: {
      openaiOrganization: projection.openaiOrganization,
      openaiProject: projection.openaiProject,
      httpReferer: projection.httpReferer,
      xTitle: projection.xTitle,
    },
    ...(request.signal ? { signal: request.signal } : {}),
  };
}

/** Consumes the freshly issued child before owner I/O. An owner callback is the
 * only physical sender for bound models; a denied or ambiguous send stays spent. */
export async function dispatchExecutionModelRequest(
  context: ExecutionExtensionContext,
  request: ExecutionOwnerModelDispatchRequest,
): Promise<Response> {
  const item = record(context);
  if (!item.modelStep || !request || typeof request !== 'object' || !sameBoundModel(item.modelStep.model, request.model)) {
    throw new ExecutionExtensionError('execution_model_step_mismatch');
  }
  if (item.modelRequestConsumed) throw new ExecutionExtensionError('execution_model_request_already_claimed');
  item.modelRequestConsumed = true;
  if (!item.adapter.dispatchModelRequest) throw new ExecutionExtensionError('execution_model_dispatch_required');
  const snapshot = snapshotOwnerRequest(request, item.modelStep.model);
  try {
    await assertExecutionExtensionCurrent(context);
    if (snapshot.signal?.aborted || executionExtensionSignal(context)?.aborted) {
      throw new ExecutionExtensionError('execution_model_request_aborted');
    }
    const response = await item.adapter.dispatchModelRequest(item.value, snapshot);
    if (!(response instanceof Response)) throw new ExecutionExtensionError('execution_model_dispatch_response_invalid');
    return response;
  } catch (error) {
    if (error instanceof ExecutionExtensionError) throw error;
    throw new ExecutionExtensionError('execution_model_dispatch_denied');
  }
}
