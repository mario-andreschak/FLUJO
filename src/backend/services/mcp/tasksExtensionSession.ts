import { randomUUID } from 'node:crypto';
import type { Client, Transport, JSONRPCMessage } from '@modelcontextprotocol/client';
import {
  createSessionPortFromClient,
  withTasks,
  DispatchError,
  JsonRpcResponseError,
  type DispatchOptions,
  type JsonRpcResponse,
  type TaskEnabledSession,
  type V2RequestFraming,
} from '@modelcontextprotocol/ext-tasks/client';
import { isJsonValue, type JsonValue } from '@modelcontextprotocol/ext-tasks/core';
import {
  CallToolResultV2Schema,
  CancelTaskResultV2Schema,
  CreateTaskResultV2Schema,
  ErrorV2Schema,
  GetTaskResultV2Schema,
  InputResponsesV2Schema,
  InputRequestV2Schema,
  ElicitResultV2Schema,
  CreateMessageResultV2Schema,
  ListRootsResultV2Schema,
  UpdateTaskResultV2Schema,
  hasTaskServerCapabilityV2,
  type CallToolResultV2,
  type CreateTaskResultV2,
  type GetTaskResultV2,
  type InputResponsesV2,
  type InputRequestV2,
  type InputResponseV2,
} from '@modelcontextprotocol/ext-tasks/core/v2';

/** A host timer, distinct from remote JSON-RPC errors with similar text. */
export class TasksExtensionRequestTimeoutError extends DispatchError {
  constructor() { super('MCP Tasks request timed out'); this.name = 'TasksExtensionRequestTimeoutError'; }
}

export interface TasksExtensionClientIdentity {
  readonly endpointId: string;
  readonly clientInfo: V2RequestFraming['clientInfo'];
  readonly clientCapabilities: V2RequestFraming['clientCapabilities'];
  /** Recheck current host authority before best-effort late-creation cleanup. */
  readonly authorizeLateTaskCancellation?: (taskId: string) => boolean | Promise<boolean>;
  readonly handleInputRequest?: (request: InputRequestV2, signal?: AbortSignal, expectedConversationId?: string) => Promise<InputResponseV2>;
  readonly isAuthorityCurrent?: () => boolean | Promise<boolean>;
}

export interface HostTasksDispatchOptions extends DispatchOptions {
  readonly context?: NonNullable<DispatchOptions['context']> & {
    readonly onprogress?: (progress: { progress: number; total?: number; message?: string }) => void;
  };
}

export interface TasksExtensionSession {
  /** Official extension facade; host lifecycle code may use the validated RPCs below. */
  readonly session: TaskEnabledSession;
  readonly signal: AbortSignal;
  callTool(params: Readonly<Record<string, JsonValue>>, options?: HostTasksDispatchOptions): Promise<CreateTaskResultV2 | CallToolResultV2>;
  getTask(taskId: string, options?: DispatchOptions): Promise<GetTaskResultV2>;
  cancelTask(taskId: string, options?: DispatchOptions): Promise<void>;
  updateTask(taskId: string, inputResponses: InputResponsesV2, options?: DispatchOptions): Promise<void>;
}

interface Registration {
  readonly identity: TasksExtensionClientIdentity;
  bundle?: TasksExtensionSession;
  close?: () => Promise<void>;
  retired?: boolean;
  negotiatedModern?: boolean;
}
const registrations = new WeakMap<object, Registration>();

/** Store the host's actual declared identity, never SDK-private fields or remote claims. */
export function registerTasksExtensionClient(client: object, identity: TasksExtensionClientIdentity): void {
  if (registrations.has(client)) throw new Error('MCP Tasks identity is already registered');
  if (!identity.endpointId) throw new TypeError('MCP Tasks endpoint identity must not be empty');
  registrations.set(client, { identity });
}

interface PendingDispatch {
  finish(response?: JsonRpcResponse, error?: unknown): void;
  progress(params?: Record<string, unknown>): void;
}

/** Owns only string IDs in its private namespace; ordinary SDK/MRTR traffic stays intact. */
class RawTasksChannel {
  private readonly prefix = `flujo-tasks:${randomUUID()}:`;
  private sequence = 0;
  private readonly pending = new Map<string, PendingDispatch>();
  private readonly lateCreations = new Map<string, number>();
  private retired = false;
  private readonly previousMessage: Transport['onmessage'];
  private readonly previousClose: Transport['onclose'];

  constructor(private readonly client: Client, private readonly transport: Transport,
    private readonly onLateCreation: (taskId: string) => Promise<void>,
    private readonly checkAuthority: () => Promise<void>,
    private readonly onRetired: () => void) {
    this.previousMessage = transport.onmessage;
    this.previousClose = transport.onclose;
    transport.onmessage = this.onmessage;
    transport.onclose = this.onclose;
  }

  private readonly onmessage: NonNullable<Transport['onmessage']> = (message, extra) => {
    if ('id' in message && !('method' in message) && typeof message.id === 'string' && message.id.startsWith(this.prefix)) {
      const pending = this.pending.get(message.id);
      // Absorb late/duplicate replies for retired IDs instead of delivering them
      // to the SDK's numeric request counter (which reports unknown responses).
      if (pending) {
        if ('result' in message && isBoundedTaskJson(message.result) && isJsonValue(message.result)) {
          pending.finish({ kind: 'result', result: message.result });
        } else if ('error' in message && isBoundedTaskJson(message.error) && isJsonValue(message.error)) {
          const parsed = ErrorV2Schema.safeParse(message.error);
          if (parsed.success) pending.finish({ kind: 'error', error: parsed.data });
          else pending.finish(undefined, new DispatchError('MCP Tasks response error is malformed'));
        } else {
          pending.finish(undefined, new DispatchError('MCP Tasks response is not bounded JSON'));
        }
      } else if (!this.retired && (this.lateCreations.get(message.id) ?? 0) > Date.now()) {
        this.lateCreations.delete(message.id);
        const created = 'result' in message && isBoundedTaskJson(message.result) ? CreateTaskResultV2Schema.safeParse(message.result) : undefined;
        if (created?.success) void this.onLateCreation(created.data.taskId).catch(() => {});
      }
      return;
    }
    if ('method' in message && message.method === 'notifications/progress') {
      const token = message.params?.progressToken;
      if (typeof token === 'string' && token.startsWith(this.prefix)) {
        this.pending.get(token)?.progress(message.params);
        return;
      }
    }
    this.previousMessage?.call(this.transport, message, extra);
  };

  private readonly onclose = (): void => {
    this.retire(new DispatchError('MCP Tasks transport closed'));
    this.previousClose?.call(this.transport);
  };

  retire(reason: unknown = new DispatchError('MCP Tasks session retired')): void {
    if (this.retired) return;
    this.retired = true;
    this.lateCreations.clear();
    for (const pending of [...this.pending.values()]) pending.finish(undefined, reason);
    this.onRetired();
    // Keep the namespace filter on this still-live channel until its transport
    // closes. Recreating a connection must use a new client, as FLUJO already does.
  }

  dispatch = async (request: JsonValue, options: DispatchOptions = {}): Promise<JsonRpcResponse> => {
    await this.checkAuthority();
    if (this.retired || this.client.transport !== this.transport || this.transport.onmessage !== this.onmessage) {
      this.retire();
      return Promise.reject(new DispatchError('MCP Tasks connection is no longer active'));
    }
    if (options.signal?.aborted) return Promise.reject(abortReason(options.signal));
    if (!isJsonRecord(request) || typeof request.method !== 'string') {
      return Promise.reject(new DispatchError('MCP Tasks request must be an object with a method'));
    }
    const timeoutMs = options.context?.requestTimeoutMs ?? 60_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
      return Promise.reject(new RangeError('MCP Tasks request timeout must be a positive 32-bit integer'));
    }
    const id = `${this.prefix}${this.sequence++}`;
    const params = jsonRecord(request.params);
    const message = {
      ...request,
      jsonrpc: '2.0',
      id,
      params: { ...params, _meta: { ...jsonRecord(params._meta), progressToken: id } },
    } as JSONRPCMessage;
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout>;
      const arm = (): void => {
        clearTimeout(timer);
        timer = setTimeout(() => finish(undefined, new TasksExtensionRequestTimeoutError()), timeoutMs);
      };
      const onAbort = (): void => finish(undefined, abortReason(options.signal!));
      const finish = (response?: JsonRpcResponse, error?: unknown): void => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        // Retire a per-request HTTP stream as soon as its answer is observed.
        controller.abort();
        if (!response && !this.retired && request.method === 'tools/call') {
          for (const [key, expires] of this.lateCreations) if (expires <= Date.now()) this.lateCreations.delete(key);
          while (this.lateCreations.size >= 32) this.lateCreations.delete(this.lateCreations.keys().next().value!);
          // Only opaque correlation IDs and deadlines survive. No call arguments,
          // caller metadata, headers, credentials, or pending promises are retained.
          this.lateCreations.set(id, Date.now() + 30_000);
        }
        if (response) {
          void this.checkAuthority().then(() => {
            if (options.signal?.aborted) throw abortReason(options.signal);
            if (this.retired || this.client.transport !== this.transport || this.transport.onmessage !== this.onmessage) {
              throw new DispatchError('MCP Tasks connection retired before result delivery');
            }
            resolve(response);
          }).catch(reject);
        }
        else reject(error);
      };
      this.pending.set(id, { finish, progress: params => {
        if (options.context?.resetTimeoutOnProgress) arm();
        if (params && typeof params.progress === 'number' && Number.isFinite(params.progress)) {
          try { (options as HostTasksDispatchOptions).context?.onprogress?.({
            progress: params.progress, ...(typeof params.total === 'number' && Number.isFinite(params.total) ? { total: params.total } : {}),
            ...(typeof params.message === 'string' ? { message: params.message } : {}),
          }); } catch (error) { finish(undefined, error); }
        }
      } });
      options.signal?.addEventListener('abort', onAbort, { once: true });
      arm();
      void this.transport.send(message, {
        headers: options.context?.headers,
        requestSignal: controller.signal,
        onRequestStreamEnd: () => finish(undefined, new DispatchError('MCP Tasks response stream ended before a reply')),
      }).catch(error => finish(undefined, error));
    });
  };
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError');
}
function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return isJsonRecord(value) ? value : {};
}
function isJsonRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value);
}
function result(response: JsonRpcResponse): JsonValue {
  if (response.kind === 'error') throw new JsonRpcResponseError(response.error);
  return response.result;
}

/** Legacy connections deliberately stay on the existing v1 Tasks adapter. */
export function getTasksExtensionSession(clientObject: object): TasksExtensionSession | undefined {
  const registration = registrations.get(clientObject);
  if (!registration || registration.retired) return undefined;
  if (registration.bundle) return registration.bundle;
  const client = clientObject as Client;
  if (client.getProtocolEra?.() === 'modern') registration.negotiatedModern = true;
  if (client.getProtocolEra?.() !== 'modern' || client.getNegotiatedProtocolVersion?.() !== '2026-07-28' ||
      !hasTaskServerCapabilityV2(client.getServerCapabilities?.()) || !client.transport) return undefined;
  const transport = client.transport;
  const sessionController = new AbortController();
  const checkAuthority = async (): Promise<void> => {
    if (registration.retired || (registration.identity.isAuthorityCurrent && !await registration.identity.isAuthorityCurrent())) {
      registration.retired = true;
      void registration.close?.().catch(() => {});
      throw new DispatchError('MCP Tasks connection authority is no longer current');
    }
  };
  const channel = new RawTasksChannel(client, transport, async taskId => {
    const authorize = registration.identity.authorizeLateTaskCancellation;
    if (!authorize || registration.retired || client.transport !== transport || !await authorize(taskId)) return;
    if (!registration.retired && client.transport === transport) await registration.bundle?.cancelTask(taskId);
  }, checkAuthority, () => { sessionController.abort(); registration.retired = true; void registration.close?.().catch(() => {}); });
  let port: ReturnType<typeof createSessionPortFromClient>;
  try {
    port = createSessionPortFromClient(client, registration.identity.endpointId, {
      rawDispatch: channel.dispatch,
      v2RequestFraming: { ...registration.identity, protocolVersion: '2026-07-28' },
    });
  } catch (error) { channel.retire(); throw error; }
  const session = withTasks(port, {});
  const dispatch = async (method: string, params: Record<string, JsonValue>, options?: DispatchOptions): Promise<JsonValue> => {
    try { return result(await port.dispatch({ method, params }, options)); }
    catch (error) {
      // The official port wraps transport exceptions. Preserve the caller's
      // cancellation sentinel so existing host lifecycle abort handling works.
      if (options?.signal?.aborted) throw abortReason(options.signal);
      const timeout = localRequestTimeout(error);
      if (timeout) throw timeout;
      throw error;
    }
  };
  const taskOptions = (taskId: string, options?: DispatchOptions): DispatchOptions => ({
    ...options,
    context: {
      ...options?.context,
      headers: { ...Object.fromEntries(Object.entries(options?.context?.headers ?? {}).filter(([name]) => name.toLowerCase() !== 'mcp-name')), 'Mcp-Name': taskId },
    },
  });
  registration.bundle = {
    session,
    signal: sessionController.signal,
    async callTool(params, options) {
      const value = await dispatch('tools/call', { ...params }, options);
      const task = CreateTaskResultV2Schema.safeParse(value);
      return task.success ? task.data : CallToolResultV2Schema.parse(value);
    },
    async getTask(taskId, options) {
      const task = GetTaskResultV2Schema.parse(await dispatch('tasks/get', { taskId }, taskOptions(taskId, options)));
      if (task.taskId !== taskId) throw new DispatchError('MCP Tasks response identity mismatch');
      return task;
    },
    async cancelTask(taskId, options) {
      CancelTaskResultV2Schema.parse(await dispatch('tasks/cancel', { taskId }, taskOptions(taskId, options)));
    },
    async updateTask(taskId, inputResponses, options) {
      const validated = InputResponsesV2Schema.parse(inputResponses);
      UpdateTaskResultV2Schema.parse(await dispatch('tasks/update', { taskId, inputResponses: validated }, taskOptions(taskId, options)));
    },
  };
  registration.close = async () => {
    registration.retired = true;
    sessionController.abort();
    channel.retire();
    try { await session.close(); } finally { port[Symbol.dispose](); }
  };
  port.onInvalidated(() => { void registration.close?.().catch(() => {}); });
  return registration.bundle;
}

function localRequestTimeout(error: unknown): TasksExtensionRequestTimeoutError | undefined {
  let current = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    if (current instanceof TasksExtensionRequestTimeoutError) return current;
    current = Object.getOwnPropertyDescriptor(current, 'cause')?.value;
  }
  return undefined;
}

/** Retiring extension state never closes or spawns the host-owned transport. */
export async function closeTasksExtensionSession(client: object): Promise<void> {
  const registration = registrations.get(client);
  if (!registration) return;
  registration.retired = true;
  await registration.close?.();
}

/** The SDK clears live negotiated-era getters on close; a retired task client never becomes legacy. */
export function wasModernTasksExtensionClient(client: object): boolean {
  const registration = registrations.get(client);
  return registration?.negotiatedModern === true || registration?.bundle !== undefined;
}

/** Route validated embedded input to the same host policy handlers as SDK MRTR. */
export async function handleTasksInputRequest(client: object, request: InputRequestV2, signal?: AbortSignal, expectedConversationId?: string): Promise<InputResponseV2> {
  const registration = registrations.get(client);
  if (!registration || registration.retired || !registration.identity.handleInputRequest) {
    throw new DispatchError('MCP Tasks input handling is not available');
  }
  if (signal?.aborted) throw abortReason(signal);
  if (registration.identity.isAuthorityCurrent && !await registration.identity.isAuthorityCurrent()) {
    await closeTasksExtensionSession(client);
    throw new DispatchError('MCP Tasks input authority is no longer current');
  }
  const parsed = InputRequestV2Schema.parse(request);
  const operation = registration.identity.handleInputRequest(parsed, signal, expectedConversationId);
  const response = await abortableInput(operation, signal);
  if (signal?.aborted) throw abortReason(signal);
  if (registration.retired || (registration.identity.isAuthorityCurrent && !await registration.identity.isAuthorityCurrent())) {
    await closeTasksExtensionSession(client);
    throw new DispatchError('MCP Tasks input authority changed before result delivery');
  }
  if (parsed.method === 'elicitation/create') return ElicitResultV2Schema.parse(response);
  if (parsed.method === 'sampling/createMessage') return CreateMessageResultV2Schema.parse(response);
  return ListRootsResultV2Schema.parse(response);
}

async function abortableInput<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try { return await Promise.race([operation, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

/** Standalone host adapter applies the same depth/entry/text ceilings before vendor traversal. */
function isBoundedTaskJson(value: unknown): boolean {
  let entries = 0, chars = 0;
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number): boolean => {
    if (++entries > 10_000 || depth > 32) return false;
    if (typeof item === 'string') { chars += item.length; return chars <= 1024 * 1024; }
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item !== 'object' || seen.has(item)) return false;
    seen.add(item);
    const keys = Object.keys(item);
    if (keys.length > 10_000) return false;
    for (const key of keys) {
      chars += key.length;
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (chars > 1024 * 1024 || !descriptor || !('value' in descriptor) || !visit(descriptor.value, depth + 1)) return false;
    }
    seen.delete(item); return true;
  };
  return visit(value, 0);
}
