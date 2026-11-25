import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { z } from 'zod';

/**
 * Client side of the webhook part of the MCP events extension
 * (`io.modelcontextprotocol/events`, SEP-3415, Beta;
 * github.com/modelcontextprotocol/ext-events, formerly
 * experimental-ext-triggers-events).
 *
 * These are protocol requests, not tools, so a model can never create a
 * subscription. The extension can still change; everything that knows its
 * wire format is in this file and in `receiveMcpEvent`. A server opts in by
 * declaring the extension in `capabilities.extensions` (current draft) or, as
 * earlier drafts did, `events` top-level or under `experimental`.
 */
export const MCP_EVENTS_EXTENSION = 'io.modelcontextprotocol/events';

/** Optional per-request client declaration the extension defines. */
const CLIENT_META = {
  'io.modelcontextprotocol/clientCapabilities': { extensions: { [MCP_EVENTS_EXTENSION]: {} } },
};

/** Enough for any real server; stops a server that keeps handing out cursors. */
const MAX_LIST_PAGES = 20;

const McpEventDescriptorSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  delivery: z.array(z.string()).optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const ListResultSchema = z.object({
  events: z.array(McpEventDescriptorSchema),
  nextCursor: z.string().nullable().optional(),
}).passthrough();

const SubscribeResultSchema = z.object({
  id: z.string(),
  refreshBefore: z.string().nullable(),
  cursor: z.string().nullable().optional(),
  truncated: z.boolean().optional(),
}).passthrough();

export type McpEventDescriptor = z.infer<typeof McpEventDescriptorSchema>;
export type McpEventSubscribeResult = z.infer<typeof SubscribeResultSchema>;

export interface McpEventSubscribeRequest {
  name: string;
  arguments?: Record<string, unknown>;
  url: string;
  secret: string;
  ttlMs?: number;
  /** Last cursor FLUJO accepted, so a new or expired subscription resumes there. */
  cursor?: string | null;
}

export interface McpEventUnsubscribeRequest {
  name: string;
  arguments?: Record<string, unknown>;
  url: string;
}

export function serverSupportsEvents(client: Client): boolean {
  const capabilities = client.getServerCapabilities?.() as
    | { events?: unknown; experimental?: { events?: unknown }; extensions?: Record<string, unknown> }
    | undefined;
  return Boolean(
    capabilities?.extensions?.[MCP_EVENTS_EXTENSION]
    ?? capabilities?.events
    ?? capabilities?.experimental?.events,
  );
}

const withArguments = (args: Record<string, unknown> | undefined) =>
  (args && Object.keys(args).length > 0 ? { arguments: args } : {});

export async function listMcpEvents(client: Client): Promise<McpEventDescriptor[]> {
  const events: McpEventDescriptor[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const result = await client.request({
      method: 'events/list',
      params: { ...(cursor ? { cursor } : {}), _meta: CLIENT_META },
    } as never, ListResultSchema) as z.infer<typeof ListResultSchema>;
    events.push(...result.events);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return events;
}

export async function subscribeMcpEvent(
  client: Client,
  request: McpEventSubscribeRequest,
): Promise<McpEventSubscribeResult> {
  const result = await client.request({
    method: 'events/subscribe',
    params: {
      name: request.name,
      ...withArguments(request.arguments),
      delivery: { mode: 'webhook', url: request.url, secret: request.secret },
      cursor: request.cursor ?? null,
      ...(request.ttlMs === undefined ? {} : { ttlMs: request.ttlMs }),
      _meta: CLIENT_META,
    },
  } as never, SubscribeResultSchema);
  return result as McpEventSubscribeResult;
}

/**
 * Ends a subscription. Since the current draft a `410` answer only refuses one
 * delivery, so a deleted or changed automation has to say goodbye explicitly.
 */
export async function unsubscribeMcpEvent(client: Client, request: McpEventUnsubscribeRequest): Promise<void> {
  await client.request({
    method: 'events/unsubscribe',
    params: {
      name: request.name,
      ...withArguments(request.arguments),
      delivery: { url: request.url },
      _meta: CLIENT_META,
    },
  } as never, z.object({}).passthrough());
}
