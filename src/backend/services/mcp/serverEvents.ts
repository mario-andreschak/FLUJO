import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { z } from 'zod';

/**
 * Client side of the webhook part of the MCP events draft
 * (github.com/modelcontextprotocol/experimental-ext-triggers-events).
 *
 * These are protocol requests, not tools, so a model can never create a
 * subscription. The draft will change; everything that knows its wire format is
 * in this file, and a server opts in by declaring `events` (top-level or under
 * `experimental`) in its capabilities.
 */
const McpEventDescriptorSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  delivery: z.array(z.string()).optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const ListResultSchema = z.object({ events: z.array(McpEventDescriptorSchema) }).passthrough();

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
}

export function serverSupportsEvents(client: Client): boolean {
  const capabilities = client.getServerCapabilities?.() as
    | { events?: unknown; experimental?: { events?: unknown } }
    | undefined;
  return Boolean(capabilities?.events ?? capabilities?.experimental?.events);
}

export async function listMcpEvents(client: Client): Promise<McpEventDescriptor[]> {
  const result = await client.request({ method: 'events/list', params: {} } as never, ListResultSchema);
  return (result as z.infer<typeof ListResultSchema>).events;
}

export async function subscribeMcpEvent(
  client: Client,
  request: McpEventSubscribeRequest,
): Promise<McpEventSubscribeResult> {
  const result = await client.request({
    method: 'events/subscribe',
    params: {
      name: request.name,
      ...(request.arguments && Object.keys(request.arguments).length > 0 ? { arguments: request.arguments } : {}),
      delivery: { mode: 'webhook', url: request.url, secret: request.secret },
      cursor: null,
      ...(request.ttlMs === undefined ? {} : { ttlMs: request.ttlMs }),
    },
  } as never, SubscribeResultSchema);
  return result as McpEventSubscribeResult;
}
