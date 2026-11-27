import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { z } from 'zod';

/**
 * Client side of the MCP events extension (`io.modelcontextprotocol/events`,
 * SEP-3415, Beta; github.com/modelcontextprotocol/ext-events, formerly
 * experimental-ext-triggers-events): listing, poll (`events/poll`) and webhook
 * (`events/subscribe`) requests. Push (`events/stream`) is in
 * serverEventStream.ts.
 *
 * These are protocol requests, not tools, so a model can never create a
 * subscription. The extension can still change; everything that knows its
 * wire format is in these two files and in `receiveMcpEvent`. A server opts in
 * by declaring the extension in `capabilities.extensions` (current spec) or, as
 * earlier drafts did, `events` top-level or under `experimental`.
 */
export const MCP_EVENTS_EXTENSION = 'io.modelcontextprotocol/events';

/** Optional per-request client declaration the extension defines. */
export const MCP_EVENTS_CLIENT_META = {
  'io.modelcontextprotocol/clientCapabilities': { extensions: { [MCP_EVENTS_EXTENSION]: {} } },
};

/** Enough for any real server; stops a server that keeps handing out cursors. */
const MAX_LIST_PAGES = 20;


const McpEventDescriptorSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  delivery: z.array(z.string()).optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  payloadSchema: z.record(z.string(), z.unknown()).optional(),
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

export const McpEventOccurrenceSchema = z.object({
  eventId: z.string().min(1),
  name: z.string(),
  timestamp: z.string().optional(),
  data: z.unknown().optional(),
  cursor: z.string().nullable().optional(),
}).passthrough();

const PollResultSchema = z.object({
  events: z.array(z.unknown()).default([]),
  cursor: z.string().nullable().optional(),
  truncated: z.boolean().optional(),
  hasMore: z.boolean().optional(),
  nextPollMs: z.number().optional(),
}).passthrough();

export type McpEventDescriptor = z.infer<typeof McpEventDescriptorSchema>;
export type McpEventSubscribeResult = z.infer<typeof SubscribeResultSchema>;
export type McpEventOccurrence = z.infer<typeof McpEventOccurrenceSchema>;

export interface McpEventPollResult {
  events: McpEventOccurrence[];
  /** Occurrences that did not match the spec's shape, dropped. */
  malformed: number;
  cursor: string | null;
  truncated: boolean;
  hasMore: boolean;
  nextPollMs?: number;
}

export interface McpEventTarget {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface McpEventSubscribeRequest extends McpEventTarget {
  url: string;
  secret: string;
  ttlMs?: number;
  /** Last cursor FLUJO accepted, so a new or expired subscription resumes there. */
  cursor?: string | null;
}

export interface McpEventUnsubscribeRequest extends McpEventTarget {
  url: string;
}

export interface McpEventPollRequest extends McpEventTarget {
  cursor: string | null;
  maxEvents?: number;
}

export function serverSupportsEvents(client: Pick<Client, 'getServerCapabilities'>): boolean {
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

// ── Streamable HTTP routing headers (SEP-2243) ──────────────────────────────

const RFC9110_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HEADER_TYPES = new Set(['string', 'integer', 'boolean']);
const BASE64_PREFIX = '=?base64?';
const BASE64_SUFFIX = '?=';

interface HeaderDeclaration { path: string[]; header: string }

/** A value as a plain ASCII header, or in the transport's Base64 form. */
export function encodeHeaderValue(value: string): string {
  const plain = value.length > 0
    && value === value.trim()
    && !(value.startsWith(BASE64_PREFIX) && value.endsWith(BASE64_SUFFIX))
    && [...value].every((char) => {
      const code = char.codePointAt(0)!;
      return code === 9 || (code >= 32 && code <= 126);
    });
  return plain ? value : `${BASE64_PREFIX}${Buffer.from(value, 'utf8').toString('base64')}${BASE64_SUFFIX}`;
}

/**
 * `x-mcp-header` annotations on the `properties` chain of an `inputSchema`,
 * or null when one breaks the transport's rules (then the event is left out
 * of the list, as the spec requires).
 */
export function eventHeaderDeclarations(inputSchema: unknown): HeaderDeclaration[] | null {
  const found: HeaderDeclaration[] = [];
  const names = new Set<string>();
  let valid = true;
  const visit = (node: unknown, path: string[], onChain: boolean) => {
    if (!valid || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, path, false);
      return;
    }
    const record = node as Record<string, unknown>;
    if ('x-mcp-header' in record) {
      const header = record['x-mcp-header'];
      if (
        !onChain || path.length === 0 || typeof header !== 'string' || !RFC9110_TOKEN.test(header)
        || typeof record.type !== 'string' || !HEADER_TYPES.has(record.type) || names.has(header.toLowerCase())
      ) {
        valid = false;
        return;
      }
      names.add(header.toLowerCase());
      found.push({ path, header });
    }
    for (const [key, value] of Object.entries(record)) {
      if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [name, child] of Object.entries(value)) visit(child, [...path, name], onChain);
      } else if (key !== 'x-mcp-header') {
        visit(value, path, false);
      }
    }
  };
  visit(inputSchema, [], true);
  return valid ? found : null;
}

function headerArgument(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return undefined;
}

/**
 * `Mcp-Name` plus one `Mcp-Param-*` per annotated argument, which every
 * `events/*` request except `events/list` carries on Streamable HTTP. Only the
 * newer client sends per-request headers; the classic one speaks the earlier
 * protocol, where they do not exist.
 */
export function eventRequestHeaders(target: McpEventTarget, descriptor?: McpEventDescriptor): Record<string, string> {
  const headers: Record<string, string> = { 'Mcp-Name': encodeHeaderValue(target.name) };
  for (const { path, header } of eventHeaderDeclarations(descriptor?.inputSchema) ?? []) {
    let value: unknown = target.arguments;
    for (const key of path) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
    const text = headerArgument(value);
    if (text !== undefined) headers[`Mcp-Param-${header}`] = encodeHeaderValue(text);
  }
  return headers;
}

// ── Requests ─────────────────────────────────────────────────────────────────

const descriptorCache = new WeakMap<object, Map<string, McpEventDescriptor>>();

export async function listMcpEvents(client: Client): Promise<McpEventDescriptor[]> {
  const events: McpEventDescriptor[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const result = await client.request({
      method: 'events/list',
      params: { ...(cursor ? { cursor } : {}), _meta: MCP_EVENTS_CLIENT_META },
    } as never, ListResultSchema) as z.infer<typeof ListResultSchema>;
    events.push(...result.events.filter(event => eventHeaderDeclarations(event.inputSchema) !== null));
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  descriptorCache.set(client, new Map(events.map(event => [event.name, event])));
  return events;
}

/** The descriptor this client last listed for an event, listing once if needed. */
export async function describeMcpEvent(client: Client, name: string): Promise<McpEventDescriptor | undefined> {
  const cached = descriptorCache.get(client)?.get(name);
  if (cached) return cached;
  try {
    return (await listMcpEvents(client)).find(event => event.name === name);
  } catch {
    return undefined;
  }
}

/** Request options with the routing headers; the classic client ignores `headers`. */
export async function eventRequestOptions(
  client: Client,
  target: McpEventTarget,
): Promise<RequestOptions & { headers: Record<string, string> }> {
  return { headers: eventRequestHeaders(target, await describeMcpEvent(client, target.name)) };
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
      _meta: MCP_EVENTS_CLIENT_META,
    },
  } as never, SubscribeResultSchema, await eventRequestOptions(client, request));
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
      _meta: MCP_EVENTS_CLIENT_META,
    },
  } as never, z.object({}).passthrough(), await eventRequestOptions(client, request));
}

/**
 * One `events/poll`. A `null` cursor starts from now; the server then sends no
 * events and a cursor for the next poll.
 */
export async function pollMcpEvent(client: Client, request: McpEventPollRequest): Promise<McpEventPollResult> {
  const result = await client.request({
    method: 'events/poll',
    params: {
      name: request.name,
      ...withArguments(request.arguments),
      cursor: request.cursor,
      ...(request.maxEvents ? { maxEvents: request.maxEvents } : {}),
      _meta: MCP_EVENTS_CLIENT_META,
    },
  } as never, PollResultSchema, await eventRequestOptions(client, request)) as z.infer<typeof PollResultSchema>;
  const events: McpEventOccurrence[] = [];
  let malformed = 0;
  for (const raw of result.events) {
    const parsed = McpEventOccurrenceSchema.safeParse(raw);
    if (parsed.success && parsed.data.name === request.name) events.push(parsed.data);
    else malformed++;
  }
  return {
    events,
    malformed,
    cursor: typeof result.cursor === 'string' ? result.cursor : null,
    truncated: result.truncated === true,
    hasMore: result.hasMore === true,
    ...(typeof result.nextPollMs === 'number' && Number.isFinite(result.nextPollMs) ? { nextPollMs: result.nextPollMs } : {}),
  };
}
