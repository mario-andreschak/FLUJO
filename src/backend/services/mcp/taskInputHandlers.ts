import {
  CreateMessageRequestSchema, CreateMessageResultSchema,
  ElicitRequestSchema, ElicitResultSchema, ListRootsRequestSchema, ListRootsResultSchema, ErrorCode, McpError,
} from '@modelcontextprotocol/sdk/types.js';

export interface TaskInputOptions {
  signal?: AbortSignal;
  expectedConversationId?: string;
  assertCurrent?: () => void | Promise<void>;
}
type InputHandler = (request: { params?: unknown }, options?: TaskInputOptions) => Promise<unknown>;
const handlers = new WeakMap<object, Map<string, InputHandler>>();

/** The same policy-bearing closure must serve inbound and keyed task input. */
export function registerTaskInputHandler(client: object, method: 'elicitation/create' | 'sampling/createMessage' | 'roots/list', handler: InputHandler): void {
  let registered = handlers.get(client);
  if (!registered) { registered = new Map(); handlers.set(client, registered); }
  registered.set(method, handler);
}

export async function assertTaskInputCurrent(options: TaskInputOptions): Promise<void> {
  options.signal?.throwIfAborted();
  await options.assertCurrent?.();
  options.signal?.throwIfAborted();
}

export async function dispatchTaskInputRequest(client: object, request: unknown, options: TaskInputOptions = {}): Promise<unknown> {
  await assertTaskInputCurrent(options);
  const method = (request as { method?: unknown } | null)?.method;
  const schemas = method === 'elicitation/create'
    ? [ElicitRequestSchema, ElicitResultSchema] as const
    : method === 'sampling/createMessage'
      ? [CreateMessageRequestSchema, CreateMessageResultSchema] as const
      : method === 'roots/list' ? [ListRootsRequestSchema, ListRootsResultSchema] as const : undefined;
  if (!schemas) throw new McpError(ErrorCode.MethodNotFound, 'Unsupported task input method');
  const handler = handlers.get(client)?.get(method as string);
  if (!handler) throw new McpError(ErrorCode.MethodNotFound, 'Task input policy is not registered for this client');
  const parsed = schemas[0].parse(request);
  await assertTaskInputCurrent(options);
  const pending = handler(parsed, options);
  let removeAbort = () => {};
  const abort = options.signal ? new Promise<never>((_resolve, reject) => {
    const signal = options.signal!;
    const onAbort = () => reject(signal.reason ?? new DOMException('Task input cancelled', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbort = () => signal.removeEventListener('abort', onAbort);
    if (signal.aborted) onAbort();
  }) : undefined;
  let result: unknown;
  try {
    // URL elicitation retains its separately owned OAuth session. Racing its
    // answer releases the task caller without mutating that owner's session.
    result = await (abort ? Promise.race([pending, abort]) : pending);
  } finally {
    removeAbort();
  }
  await assertTaskInputCurrent(options);
  return schemas[1].parse(result);
}
