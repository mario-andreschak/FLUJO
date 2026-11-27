import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { z } from 'zod';
import { createLogger } from '@/utils/logger';
import {
  MCP_EVENTS_CLIENT_META,
  McpEventOccurrenceSchema,
  eventRequestOptions,
  type McpEventOccurrence,
  type McpEventTarget,
} from './serverEvents';

const log = createLogger('backend/services/mcp/serverEventStream');

/**
 * Push delivery of the MCP events extension: one long-lived `events/stream`
 * request per subscription. The server confirms with
 * `notifications/events/active`, then sends events, heartbeats and errors as
 * notifications that carry the request's JSON-RPC id in
 * `_meta["io.modelcontextprotocol/subscriptionId"]`.
 *
 * Neither SDK generation tells the caller which id it gave a request, so the
 * first `active` with an unknown id belongs to the stream being opened. Opens
 * on one client therefore take turns; each waits only for its confirmation.
 */
export const MCP_EVENT_NOTIFICATIONS = [
  'notifications/events/active',
  'notifications/events/event',
  'notifications/events/heartbeat',
  'notifications/events/error',
  'notifications/events/terminated',
] as const;

const SUBSCRIPTION_ID = 'io.modelcontextprotocol/subscriptionId';
/** Node's longest timer. The heartbeat, not a request timeout, tells a dead stream. */
const NO_TIMEOUT_MS = 2_147_483_647;
const OPEN_TIMEOUT_MS = 30_000;

export interface McpEventStreamError {
  code?: number;
  message: string;
  data?: unknown;
}

export interface McpEventStreamActive {
  cursor: string | null;
  truncated: boolean;
  heartbeatMs?: number;
}

export interface McpEventStreamHandlers {
  onActive(info: McpEventStreamActive): void;
  onEvent(event: McpEventOccurrence): void;
  onHeartbeat(cursor: string | null): void;
  /** A single failure upstream; the stream stays open. */
  onError(error: McpEventStreamError): void;
}

export type McpEventStreamEnd =
  | { kind: 'closed' }
  | { kind: 'ended' }
  | { kind: 'terminated'; error: McpEventStreamError }
  | { kind: 'failed'; message: string };

export interface McpEventStream {
  /** Resolves once: closed by FLUJO, ended or terminated by the server, or failed. */
  readonly ended: Promise<McpEventStreamEnd>;
  close(): void;
}

export interface McpEventStreamRequest extends McpEventTarget {
  cursor: string | null;
  heartbeatMs?: number;
  openTimeoutMs?: number;
}

interface StreamEntry {
  name: string;
  handlers: McpEventStreamHandlers;
  key?: string;
  confirm(): void;
  finish(end: McpEventStreamEnd): void;
}

interface StreamRouter {
  bound: Map<string, StreamEntry>;
  pending?: StreamEntry;
  opening: Promise<void>;
}

const routers = new WeakMap<object, StreamRouter>();

function routerFor(client: object): StreamRouter {
  let router = routers.get(client);
  if (!router) {
    router = { bound: new Map(), opening: Promise.resolve() };
    routers.set(client, router);
  }
  return router;
}

function streamError(value: unknown): McpEventStreamError {
  if (!value || typeof value !== 'object') return { message: 'Unknown error' };
  const { code, message, data } = value as { code?: unknown; message?: unknown; data?: unknown };
  return {
    ...(typeof code === 'number' ? { code } : {}),
    message: typeof message === 'string' && message ? message : 'Unknown error',
    ...(data === undefined ? {} : { data }),
  };
}

const cursorOf = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** Hands one `notifications/events/*` message to the stream it belongs to. */
export function routeMcpEventNotification(client: object, method: string, params: unknown): void {
  const router = routers.get(client);
  if (!router || !params || typeof params !== 'object') return;
  const record = params as Record<string, unknown>;
  const id = (record._meta as Record<string, unknown> | undefined)?.[SUBSCRIPTION_ID];
  if (typeof id !== 'string' && typeof id !== 'number') return;
  const key = `${typeof id}:${id}`;
  let entry = router.bound.get(key);
  if (!entry && method === 'notifications/events/active' && router.pending && !router.pending.key) {
    entry = router.pending;
    entry.key = key;
    router.bound.set(key, entry);
    entry.confirm();
  }
  if (!entry) {
    log.debug(`Ignoring ${method} for a stream FLUJO does not hold`);
    return;
  }
  try {
    switch (method) {
      case 'notifications/events/active': {
        const heartbeatMs = typeof record.heartbeatMs === 'number' && record.heartbeatMs > 0 ? record.heartbeatMs : undefined;
        entry.handlers.onActive({ cursor: cursorOf(record.cursor), truncated: record.truncated === true, heartbeatMs });
        break;
      }
      case 'notifications/events/event': {
        const parsed = McpEventOccurrenceSchema.safeParse(record);
        if (parsed.success && parsed.data.name === entry.name) entry.handlers.onEvent(parsed.data);
        else log.warn(`Dropped a malformed event on the '${entry.name}' stream`);
        break;
      }
      case 'notifications/events/heartbeat':
        entry.handlers.onHeartbeat(cursorOf(record.cursor));
        break;
      case 'notifications/events/error':
        entry.handlers.onError(streamError(record.error));
        break;
      case 'notifications/events/terminated':
        entry.finish({ kind: 'terminated', error: streamError(record.error) });
        break;
      default:
        break;
    }
  } catch (error) {
    log.warn(`A handler for ${method} failed`, error);
  }
}

const StreamResultSchema = z.object({}).passthrough();

/**
 * Opens one push subscription and resolves once the server confirmed it.
 * Throws when the server refuses (`NotFound`, `Forbidden`, `InvalidParams`,
 * `Unsupported`, method not found), closes first, or never confirms.
 */
export async function openMcpEventStream(
  client: Client,
  request: McpEventStreamRequest,
  handlers: McpEventStreamHandlers,
): Promise<McpEventStream> {
  const router = routerFor(client);
  const previous = router.opening;
  let releaseTurn!: () => void;
  router.opening = new Promise<void>((resolve) => { releaseTurn = resolve; });
  try {
    await previous;
    const options = await eventRequestOptions(client, request);
    const controller = new AbortController();
    let settle!: (end: McpEventStreamEnd) => void;
    const ended = new Promise<McpEventStreamEnd>((resolve) => { settle = resolve; });
    let confirm!: () => void;
    const confirmed = new Promise<'active'>((resolve) => { confirm = () => resolve('active'); });
    let done = false;
    const entry: StreamEntry = {
      name: request.name,
      handlers,
      confirm,
      finish(end) {
        if (done) return;
        done = true;
        if (entry.key && router.bound.get(entry.key) === entry) router.bound.delete(entry.key);
        if (router.pending === entry) router.pending = undefined;
        // Closing or a termination cancels the request; the server stops sending.
        if (end.kind === 'closed' || end.kind === 'terminated') controller.abort();
        settle(end);
      },
    };
    router.pending = entry;
    client.request({
      method: 'events/stream',
      params: {
        name: request.name,
        ...(request.arguments && Object.keys(request.arguments).length > 0 ? { arguments: request.arguments } : {}),
        cursor: request.cursor,
        ...(request.heartbeatMs ? { heartbeatMs: request.heartbeatMs } : {}),
        _meta: MCP_EVENTS_CLIENT_META,
      },
    } as never, StreamResultSchema, { ...options, signal: controller.signal, timeout: NO_TIMEOUT_MS }).then(
      () => entry.finish({ kind: 'ended' }),
      (error: unknown) => entry.finish({ kind: 'failed', message: error instanceof Error ? error.message : String(error) }),
    );

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), request.openTimeoutMs ?? OPEN_TIMEOUT_MS);
      timer.unref?.();
    });
    const first = await Promise.race([confirmed, ended, timedOut]);
    clearTimeout(timer);
    if (router.pending === entry) router.pending = undefined;
    if (first === 'active') return { ended, close: () => entry.finish({ kind: 'closed' }) };
    if (first === 'timeout') {
      entry.finish({ kind: 'closed' });
      throw new Error('The server did not confirm the event stream in time');
    }
    if (first.kind === 'failed') throw new Error(first.message);
    if (first.kind === 'terminated') throw new Error(first.error.message);
    throw new Error('The server closed the event stream before confirming it');
  } finally {
    releaseTurn();
  }
}

/**
 * Classic SDK client: one handler per `notifications/events/*` method. Register
 * before `client.connect()`; the newer client gets the same through
 * `createNewBetaClient`.
 */
export function registerMcpEventStreamHandlers(client: Client, serverName: string): void {
  for (const method of MCP_EVENT_NOTIFICATIONS) {
    try {
      client.setNotificationHandler(
        z.object({ method: z.literal(method), params: z.unknown().optional() }).passthrough(),
        notification => routeMcpEventNotification(client, method, notification.params),
      );
    } catch (error) {
      log.warn(`Could not listen for ${method} from ${serverName}`, error);
    }
  }
}
