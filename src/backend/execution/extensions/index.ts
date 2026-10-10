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
/** Returned only by the trusted server adapter after rereading its enrolled
 * Worker, current goal/root run and immutable target/graph records. This DTO
 * alone is not a capability and must never be accepted from Flow/HTTP input. */
export interface ExecutionNativeWorkerRoot {
  version: 1; workerId: string; goalId: string; fleetRunId: string;
  rootConversationId: string; logicalRunId: string; workspace: string;
  targetDigest: string; flowDigest: string; leaseEpoch: string; modelId: string; modelDigest: string;
}
export interface ExecutionNativeWorkerRootRequest {
  conversationId: string; runId: string; workspace: string; flowId: string; flowDigest: string; modelId: string; modelDigest: string;
}
export interface ExecutionNativeWorkerDescendant {
  root: ExecutionNativeWorkerRoot;
  parentNodeId: string;
  flowDigest: string;
  modelId: string;
  modelDigest: string;
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
  prepareSubflow?(context: object, input: FlowRunInput): Promise<object>;
  validateLoadedState?(context: object, state: unknown): Promise<void>;
  bindRun(context: object, conversation: string, run: string): Promise<void>;
  signal(context: object): AbortSignal | undefined;
  commit<T>(context: object, task: () => Promise<T>): Promise<T>;
  protectedServer(context: object): string;
  authorizeHandoffs(context: object, names: string[]): void | string[] | Promise<void | string[]>;
  /** Installed child capacity, independently owned by the execution adapter. */
  subflowCapacity?(context: object, parentNodeId: string): Promise<number | undefined>;
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
  /** Root-only native admission. The adapter must independently authenticate
   * the executing Worker and reread goal, budget, enrollment and OFF gates.
   * commit() must fence these same records throughout a Source mutation. */
  nativeWorkerRoot?(context: object, expected: ExecutionNativeWorkerRootRequest): Promise<ExecutionNativeWorkerRoot | undefined>;
  nativeWorkerDescendant?(context: object, expected: ExecutionNativeWorkerRootRequest): Promise<ExecutionNativeWorkerDescendant>;
}
type ContextRecord = { adapter: ExecutionExtensionAdapter; value: object; parent?: ExecutionExtensionContext;
  boundRun?: { conversationId: string; runId: string } };
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
export function isExecutionChildContext(child:ExecutionExtensionContext,parent:ExecutionExtensionContext):boolean {
  return record(child).parent===parent&&record(parent).adapter===record(child).adapter;
}
function record(context: ExecutionExtensionContext | undefined): ContextRecord {
  const value = context && registry.contexts.get(context);
  if (!value || value.adapter !== executionExtensionAdapter()) throw new ExecutionExtensionError('trusted_execution_context_required');
  return value;
}
export function runWithExecutionInput<T>(input: Partial<FlowRunInput>, task: () => T): T { return registry.input.run(input, task); }
export function applyExecutionRunInput(input: FlowRunInput): FlowRunInput {
  const trusted = registry.input.getStore();
  if (input.executionExtensionContext && trusted?.executionExtensionContext
    && record(input.executionExtensionContext).parent===trusted.executionExtensionContext) return input;
  return trusted ? { ...input, ...trusted } : input;
}
/** Called only by the existing subflow run path inside an opaque parent scope.
 * The adapter checks the actual saved lane and installed child plan. */
export async function prepareExecutionSubflowInput(input: FlowRunInput): Promise<FlowRunInput | undefined> {
  const parent=registry.input.getStore()?.executionExtensionContext;
  if(!parent||input.source!=='subflow'||input.executionExtensionContext)return undefined;
  const item=record(parent);
  if(!item.adapter.prepareSubflow)throw new ExecutionExtensionError('trusted_subflow_unavailable');
  const value=await item.adapter.prepareSubflow(item.value,input);
  const context=createExecutionExtensionContext(item.adapter,value);
  registry.contexts.get(context)!.parent=parent;
  return {...input,executionExtensionContext:context};
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
/** Native lineage reads may inspect the actual bound immediate parent. The
 * scope is held only around the read; it grants no ambient ancestor access. */
export async function withExecutionParentConversationRead<T>(conversationId: string, task: () => Promise<T>): Promise<T> {
  const context = registry.input.getStore()?.executionExtensionContext;
  const child = context && record(context);
  const parent = child?.parent && record(child.parent);
  if (!context || !child?.parent || parent?.boundRun?.conversationId !== conversationId) return task();
  const parentContext = child.parent;
  const expected = Object.freeze({ ...parent.boundRun });
  const assertCurrent = async () => {
    await assertExecutionExtensionCurrent(context);
    await assertExecutionExtensionCurrent(parentContext, expected);
  };
  await assertCurrent();
  const result = await runWithExecutionConversationAccess(conversationId, assertCurrent, task);
  await assertCurrent();
  return result;
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
export async function bindExecutionExtensionRun(context: ExecutionExtensionContext, conversation: string, run: string): Promise<void> {
  const item = record(context);
  if (item.boundRun && (item.boundRun.conversationId !== conversation || item.boundRun.runId !== run)) {
    throw new ExecutionExtensionError('trusted_execution_run_rebind_refused');
  }
  await item.adapter.bindRun(item.value, conversation, run);
  item.boundRun = Object.freeze({ conversationId: conversation, runId: run });
}
export function executionExtensionSignal(context: ExecutionExtensionContext): AbortSignal | undefined { const item = record(context); return item.adapter.signal(item.value); }
export async function commitExecutionExtensionMutation<T>(context: ExecutionExtensionContext, task: () => Promise<T>): Promise<T> {
  const item = record(context);
  const owner=item.parent??context;
  if (registry.committing.getStore() === owner) {
    await item.adapter.assertRun(item.value); const result = await task(); await item.adapter.assertRun(item.value); return result;
  }
  return item.adapter.commit(item.value, () => registry.committing.run(owner, task));
}
export function executionExtensionProtectedServer(context: ExecutionExtensionContext): string { const item = record(context); return item.adapter.protectedServer(item.value); }
export async function authorizeExecutionExtensionHandoffs(context: ExecutionExtensionContext, names: string[]): Promise<void | string[]> { const item = record(context); return item.adapter.authorizeHandoffs(item.value, names); }
export async function executionExtensionSubflowCapacity(context: ExecutionExtensionContext, parentNodeId: string): Promise<number | undefined> {
  const item = record(context);
  return item.adapter.subflowCapacity?.(item.value, parentNodeId);
}
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

/** No caller callbacks or DTO can select the reader: it comes exclusively from
 * the currently registered adapter behind the existing opaque context. */
export function executionExtensionSupportsNativeWorkerRoot(context: ExecutionExtensionContext): boolean {
  const item = record(context);
  return typeof item.adapter.nativeWorkerRoot === 'function';
}

export async function executionExtensionNativeWorkerRoot(context: ExecutionExtensionContext,
  expected: ExecutionNativeWorkerRootRequest): Promise<ExecutionNativeWorkerRoot | undefined> {
  const item = record(context);
  await item.adapter.assertRun(item.value, { conversationId: expected.conversationId, runId: expected.runId });
  const selected = await item.adapter.nativeWorkerRoot?.(item.value, Object.freeze({ ...expected }));
  await assertExecutionExtensionCurrent(context, { conversationId: expected.conversationId, runId: expected.runId });
  if (selected === undefined) return undefined;
  const fields = ['version', 'workerId', 'goalId', 'fleetRunId', 'rootConversationId', 'logicalRunId',
    'workspace', 'targetDigest', 'flowDigest', 'leaseEpoch', 'modelId', 'modelDigest'];
  if (!selected || typeof selected !== 'object' || Array.isArray(selected)
    || Object.keys(selected).length !== fields.length || Object.keys(selected).some(key => !fields.includes(key))
    || selected.version !== 1 || fields.slice(1).some(key => typeof selected[key as keyof typeof selected] !== 'string'
      || !(selected[key as keyof typeof selected] as string).length
      || (selected[key as keyof typeof selected] as string).length > 160)
    || selected.rootConversationId !== expected.conversationId || selected.logicalRunId !== expected.runId
    || selected.workspace !== expected.workspace || selected.flowDigest !== expected.flowDigest
    || selected.modelId !== expected.modelId || selected.modelDigest !== expected.modelDigest
    || !/^[a-f0-9]{64}$/.test(selected.targetDigest) || !/^[a-f0-9]{64}$/.test(selected.flowDigest)) {
    throw new ExecutionExtensionError('execution_native_worker_root_invalid');
  }
  return Object.freeze(structuredClone(selected));
}
export async function executionExtensionNativeWorkerDescendant(context: ExecutionExtensionContext,
  expected: ExecutionNativeWorkerRootRequest): Promise<ExecutionNativeWorkerDescendant> {
  const item=record(context);
  await item.adapter.assertRun(item.value,{conversationId:expected.conversationId,runId:expected.runId});
  const selected=await item.adapter.nativeWorkerDescendant?.(item.value,Object.freeze({...expected}));
  await assertExecutionExtensionCurrent(context,{conversationId:expected.conversationId,runId:expected.runId});
  if(!selected||Object.keys(selected).sort().join()!=='flowDigest,modelDigest,modelId,parentNodeId,root'
    ||!selected.parentNodeId||selected.flowDigest!==expected.flowDigest||selected.modelId!==expected.modelId
    ||selected.modelDigest!==expected.modelDigest||selected.root.workspace!==expected.workspace
    ||selected.root.rootConversationId===expected.conversationId)throw new ExecutionExtensionError('execution_native_worker_child_invalid');
  return Object.freeze({...selected,root:Object.freeze({...selected.root})});
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
