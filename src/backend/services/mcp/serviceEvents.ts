// MCP server events through the MCP service: list, subscribe, push streams, polls and Claude channels, each on a lease.
import { type AcquireResult } from "./mcpLeasePool";
import {
  listMcpEvents,
  pollMcpEvent,
  serverSupportsEvents,
  subscribeMcpEvent,
  unsubscribeMcpEvent,
  type McpEventDescriptor,
  type McpEventPollRequest,
  type McpEventPollResult,
  type McpEventSubscribeRequest,
  type McpEventSubscribeResult,
  type McpEventUnsubscribeRequest,
} from "./serverEvents";
import { openMcpEventStream, type McpEventStream, type McpEventStreamHandlers, type McpEventStreamRequest } from "./serverEventStream";
import { serverDeclaresClaudeChannel } from "./inboundEvents";

/** What the events functions use from the MCP service. */
export type McpEventsHost = {
  acquireServerLease(serverName: string): Promise<AcquireResult>;
  isServerDisabled(serverName: string): Promise<boolean>;
};

/**
 * The events a server can report, for the automation editor. `channel` says
 * whether it also sends Claude channel messages (#1401).
 */
export async function listServerEvents(host: McpEventsHost, serverName: string): Promise<{
  supported: boolean;
  channel: boolean;
  events: McpEventDescriptor[];
  error?: string;
}> {
  const acquired = await host.acquireServerLease(serverName);
  if (!acquired.lease) return { supported: false, channel: false, events: [], error: acquired.error };
  try {
    const channel = serverDeclaresClaudeChannel(acquired.lease.client);
    if (!serverSupportsEvents(acquired.lease.client)) return { supported: false, channel, events: [] };
    return { supported: true, channel, events: await listMcpEvents(acquired.lease.client) };
  } finally {
    acquired.lease.release();
  }
}

/** Ends a webhook subscription. Throws when the server cannot be reached or refuses. */
export async function unsubscribeServerEvent(host: McpEventsHost, serverName: string, request: McpEventUnsubscribeRequest): Promise<void> {
  const acquired = await host.acquireServerLease(serverName);
  if (!acquired.lease) throw new Error(acquired.error ?? `MCP server '${serverName}' is not available`);
  try {
    if (!serverSupportsEvents(acquired.lease.client)) return;
    await unsubscribeMcpEvent(acquired.lease.client, request);
  } finally {
    acquired.lease.release();
  }
}

/**
 * Starts the server if needed and says whether it sends Claude channel
 * messages. Called on arm and every few minutes, which also reconnects a
 * server that went away. Throws when the server cannot be reached.
 */
export async function connectClaudeChannel(host: McpEventsHost, serverName: string): Promise<boolean> {
  if (await host.isServerDisabled(serverName)) throw new Error(`MCP server '${serverName}' is disabled`);
  const acquired = await host.acquireServerLease(serverName);
  if (!acquired.lease) throw new Error(acquired.error ?? `MCP server '${serverName}' is not available`);
  try {
    return serverDeclaresClaudeChannel(acquired.lease.client);
  } finally {
    acquired.lease.release();
  }
}

/** Creates or refreshes a webhook subscription. Throws when the server refuses. */
export async function subscribeServerEvent(host: McpEventsHost, serverName: string, request: McpEventSubscribeRequest): Promise<McpEventSubscribeResult> {
  if (await host.isServerDisabled(serverName)) throw new Error(`MCP server '${serverName}' is disabled`);
  const acquired = await host.acquireServerLease(serverName);
  if (!acquired.lease) throw new Error(acquired.error ?? `MCP server '${serverName}' is not available`);
  try {
    if (!serverSupportsEvents(acquired.lease.client)) throw new Error(`MCP server '${serverName}' does not report events`);
    return await subscribeMcpEvent(acquired.lease.client, request);
  } finally {
    acquired.lease.release();
  }
}

/**
 * Opens a push subscription (`events/stream`) and resolves once the server
 * confirmed it. The stream lives on the connection, not on a lease: the
 * caller pins the server, and the stream ends when the connection does.
 */
export async function openServerEventStream(
  host: McpEventsHost,
  serverName: string,
  request: McpEventStreamRequest,
  handlers: McpEventStreamHandlers,
): Promise<McpEventStream> {
  if (await host.isServerDisabled(serverName)) throw new Error(`MCP server '${serverName}' is disabled`);
  const acquired = await host.acquireServerLease(serverName);
  if (!acquired.lease) throw new Error(acquired.error ?? `MCP server '${serverName}' is not available`);
  try {
    if (!serverSupportsEvents(acquired.lease.client)) throw new Error(`MCP server '${serverName}' does not report events`);
    return await openMcpEventStream(acquired.lease.client, request, handlers);
  } finally {
    acquired.lease.release();
  }
}

/** One `events/poll`. Throws when the server cannot be reached or refuses. */
export async function pollServerEvent(host: McpEventsHost, serverName: string, request: McpEventPollRequest): Promise<McpEventPollResult> {
  if (await host.isServerDisabled(serverName)) throw new Error(`MCP server '${serverName}' is disabled`);
  const acquired = await host.acquireServerLease(serverName);
  if (!acquired.lease) throw new Error(acquired.error ?? `MCP server '${serverName}' is not available`);
  try {
    if (!serverSupportsEvents(acquired.lease.client)) throw new Error(`MCP server '${serverName}' does not report events`);
    return await pollMcpEvent(acquired.lease.client, request);
  } finally {
    acquired.lease.release();
  }
}
