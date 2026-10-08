import { AsyncLocalStorage } from 'node:async_hooks';
import type { MCPServerConfig } from '@/shared/types/mcp';
import type { FlowRunInput } from '@/backend/execution/flow/runFlow';
import type { RestrictedCodexProfile } from '@/backend/services/model/adapters/codexRestrictedProfile';
import type { Model } from '@/shared/types/model';
import { configuredExecutionAdapter } from '@/backend/execution/extensions/configuredAdapter';

declare const contextBrand: unique symbol;
/** Opaque capability minted by trusted server code, never by request metadata. */
export interface ExecutionExtensionContext { readonly [contextBrand]: true }
/** Retry restriction only; never a grant of inference, spend or replay authority. */
export interface ExecutionModelAttemptPolicy { version: 1; maxPhysicalAttempts: 1 }
export type ExecutionModelIdentity = Pick<Model, 'id' | 'name' | 'adapter' | 'provider' | 'baseUrl'>;
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
}
type ContextRecord = { adapter: ExecutionExtensionAdapter; value: object };
type Access = { conversationId: string; assertCurrent: () => Promise<void> };
type Registry = { adapter?: ExecutionExtensionAdapter; configuredAdapter?: ExecutionExtensionAdapter; contexts: WeakMap<object, ContextRecord>; input: AsyncLocalStorage<Partial<FlowRunInput>>; access: AsyncLocalStorage<Access>; committing: AsyncLocalStorage<ExecutionExtensionContext> };
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
/** Detect inherited private execution guards without exposing their authority. */
export function hasExecutionExtensionContext(): boolean {
  return registry.input.getStore()?.executionExtensionContext !== undefined
    || registry.access.getStore() !== undefined
    || registry.committing.getStore() !== undefined;
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
  const item = record(context); await item.adapter.assertRun(item.value, expected);
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
export function executionExtensionSignal(context: ExecutionExtensionContext): AbortSignal | undefined { const item = record(context); return item.adapter.signal(item.value); }
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
  if (!context) return false;
  const item = record(context);
  await item.adapter.assertRun(item.value);
  const policy = await item.adapter.modelAttemptPolicy?.(item.value, {
    id: model.id, name: model.name, adapter: model.adapter, provider: model.provider, baseUrl: model.baseUrl,
  });
  await assertExecutionExtensionCurrent(context);
  if (policy === undefined) return false;
  if (!policy || Object.keys(policy).length !== 2 || policy.version !== 1 || policy.maxPhysicalAttempts !== 1) {
    throw new ExecutionExtensionError('execution_model_attempt_policy_invalid');
  }
  // Only this adapter's physical request boundary is qualified by this contract.
  if (model.fallbackPolicy || (model.adapter && model.adapter !== 'openai')) {
    throw new ExecutionExtensionError('execution_single_attempt_adapter_unsupported');
  }
  return true;
}
