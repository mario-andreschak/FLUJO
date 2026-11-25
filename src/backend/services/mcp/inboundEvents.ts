import { randomUUID } from 'crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { z } from 'zod';
import { createLogger } from '@/utils/logger';
import { workspaceCacheKey } from '@/utils/workspace';

const log = createLogger('backend/services/mcp/inboundEvents');

/**
 * Claude channel messages (`notifications/claude/channel`) as a second input
 * for the "tool server reports an event" trigger (#1401, plan PR 1).
 *
 * Wire format from the Claude Code channels reference: the server declares
 * `capabilities.experimental['claude/channel']` and sends `params.content`
 * (string) plus optional `params.meta` (string values; keys that are not
 * identifiers are dropped, as Claude Code does). The protocol is a research
 * preview, so everything that knows it lives in this file.
 *
 * Channels have no acknowledgement and no replay: a message that arrives while
 * FLUJO or the server is off is gone. Only automations that chose this source
 * listen; with none listening a message is dropped and nothing runs.
 */
export const CLAUDE_CHANNEL_METHOD = 'notifications/claude/channel';
const MAX_EVENT_BYTES = 256 * 1024;
const META_KEY = /^[A-Za-z0-9_]+$/;

export interface McpInboundEvent {
  serverName: string;
  source: 'claude-channel';
  content: string;
  meta: Record<string, string>;
  receivedAt: string;
  /**
   * `meta.event_id` or `meta.message_id` when the server sends one, so a
   * repeated message is recognised. Otherwise unique: without an id two equal
   * messages ("yes", "yes") are both real.
   */
  deliveryId: string;
}

const ClaudeChannelNotificationSchema = z.object({
  method: z.literal(CLAUDE_CHANNEL_METHOD),
  params: z.unknown().optional(),
}).passthrough();

export function serverDeclaresClaudeChannel(client: Pick<Client, 'getServerCapabilities'>): boolean {
  const capabilities = client.getServerCapabilities?.() as
    | { experimental?: Record<string, unknown> }
    | undefined;
  const declared = capabilities?.experimental?.['claude/channel'];
  return Boolean(declared) && typeof declared === 'object';
}

/** A valid channel message in FLUJO's neutral format, or null to drop it. */
export function parseClaudeChannelNotification(
  serverName: string,
  params: unknown,
  now: () => number = Date.now,
): McpInboundEvent | null {
  if (!params || typeof params !== 'object') return null;
  const { content, meta } = params as { content?: unknown; meta?: unknown };
  if (typeof content !== 'string') return null;
  const cleanMeta: Record<string, string> = {};
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    for (const [key, value] of Object.entries(meta as Record<string, unknown>)) {
      if (META_KEY.test(key) && typeof value === 'string') cleanMeta[key] = value;
    }
  }
  if (Buffer.byteLength(JSON.stringify({ content, meta: cleanMeta })) > MAX_EVENT_BYTES) return null;
  const stableId = cleanMeta.event_id || cleanMeta.message_id;
  return {
    serverName,
    source: 'claude-channel',
    content,
    meta: cleanMeta,
    receivedAt: new Date(now()).toISOString(),
    deliveryId: stableId ? `channel:${stableId}` : `channel-once:${randomUUID()}`,
  };
}

type InboundListener = (event: McpInboundEvent) => void;

// Global-backed so a dev hot reload or a second module instance (route vs
// scheduler) shares one set of listeners, like the steering inbox.
declare global {
  var __flujoMcpInboundListeners: Map<string, Set<InboundListener>> | undefined;
}
const inboundListeners = globalThis.__flujoMcpInboundListeners
  ?? (globalThis.__flujoMcpInboundListeners = new Map<string, Set<InboundListener>>());

/** Listen for one server's messages in the current workspace. */
export function subscribeInboundEvents(serverName: string, listener: InboundListener): () => void {
  const key = workspaceCacheKey(serverName);
  const listeners = inboundListeners.get(key) ?? new Set<InboundListener>();
  listeners.add(listener);
  inboundListeners.set(key, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && inboundListeners.get(key) === listeners) inboundListeners.delete(key);
  };
}

/** Returns how many listeners took the event (0: nobody chose this source). */
export function publishInboundEvent(event: McpInboundEvent): number {
  const listeners = inboundListeners.get(workspaceCacheKey(event.serverName));
  if (!listeners?.size) return 0;
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (error) {
      log.warn(`A listener for ${event.serverName} failed`, error);
    }
  }
  return listeners.size;
}

/**
 * Handle `notifications/claude/channel` from one client. `isCurrent` ignores a
 * replaced client's late messages. A server that never declared the channel
 * capability is ignored too: it did not ask to be a channel.
 */
export function receiveClaudeChannelNotification(
  client: Pick<Client, 'getServerCapabilities'>,
  serverName: string,
  notification: unknown,
  isCurrent: () => boolean,
): void {
  if (!isCurrent()) return;
  if (!serverDeclaresClaudeChannel(client)) {
    log.debug(`Ignoring a channel message from ${serverName}: it does not declare claude/channel`);
    return;
  }
  const event = parseClaudeChannelNotification(serverName, (notification as { params?: unknown } | undefined)?.params);
  if (!event) {
    log.warn(`Dropped a malformed or oversized channel message from ${serverName}`);
    return;
  }
  if (publishInboundEvent(event) === 0) {
    log.debug(`No automation listens to channel messages from ${serverName}; dropped`);
  }
}

/**
 * v1 SDK client: Zod-schema handler. Register before `client.connect()`, with a
 * handler already bound to the connection's workspace.
 */
export function registerClaudeChannelHandler(
  client: Client,
  serverName: string,
  handler: (notification: unknown) => void,
): void {
  try {
    client.setNotificationHandler(ClaudeChannelNotificationSchema, (notification) => handler(notification));
  } catch (error) {
    log.warn(`Could not listen for channel messages from ${serverName}`, error);
  }
}
