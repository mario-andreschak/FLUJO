import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ListToolsResult, Request } from '@modelcontextprotocol/sdk/types.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { AnySchema, SchemaOutput } from '@modelcontextprotocol/sdk/server/zod-compat.js';

const REPEATED_CURSOR = "Tool discovery returned a repeated cursor; check the server's pagination.";

/** Complete inventory or an error; a partial inventory must never authorize calls. */
export async function collectToolPages(
  readPage: (cursor?: string) => Promise<ListToolsResult>,
): Promise<ListToolsResult> {
  const tools: ListToolsResult['tools'] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let firstPage: ListToolsResult | undefined;
  for (let page = 0; ; page += 1) {
    if (page >= 1000) throw new Error("Tool discovery exceeded 1000 pages; check the server's pagination.");
    const response = await readPage(cursor);
    firstPage ??= response;
    tools.push(...response.tools);
    if (response.nextCursor === undefined) break;
    if (seenCursors.has(response.nextCursor)) throw new Error(REPEATED_CURSOR);
    seenCursors.add(response.nextCursor);
    cursor = response.nextCursor;
  }
  const { nextCursor: _cursor, ...result } = firstPage;
  return { ...result, tools };
}

interface PageRequester {
  request(...args: unknown[]): Promise<unknown>;
}

const field = (value: unknown, key: string): unknown => (
  typeof value === 'object' && value !== null && key in value ? Reflect.get(value, key) : undefined
);

/**
 * SDK v2 walks tools/list pages itself and stops quietly when a page points back to the
 * cursor it was fetched with, returning the tools so far as if they were all of them.
 * Watching each page on this client turns that into the same repeated-cursor error
 * SDK v1 discovery gives. Longer cycles already fail at the SDK's page limit.
 */
export function rejectRepeatedToolCursors<C extends PageRequester>(client: C): C {
  const target: PageRequester = client;
  const request = target.request.bind(client);
  target.request = async (...args: unknown[]) => {
    const result = await request(...args);
    const cursor = field(field(args[0], 'params'), 'cursor');
    if (field(args[0], 'method') === 'tools/list' && cursor !== undefined && field(result, 'nextCursor') === cursor) {
      throw new Error(REPEATED_CURSOR);
    }
    return result;
  };
  return client;
}

/** Also supports client adapters that expose individual pages through listTools. */
export function listCompleteTools(client: Pick<Client, 'listTools'>, options?: RequestOptions): Promise<ListToolsResult> {
  return collectToolPages((cursor) => options
    ? client.listTools(cursor === undefined ? undefined : { cursor }, options)
    : cursor === undefined ? client.listTools() : client.listTools({ cursor }));
}

/**
 * SDK v1 caches output validators and task declarations from the single result
 * received by listTools, replacing the previous cache. Aggregate through the
 * public request API so its normal listTools implementation caches ALL tools.
 * Explicit cursor requests retain the standard single-page API. SDK v2 already
 * performs this aggregation; its client factory needs no adapter.
 */
export class CompleteToolDiscoveryClient extends Client {
  override async request<T extends AnySchema>(
    request: Request,
    resultSchema: T,
    options?: RequestOptions,
  ): Promise<SchemaOutput<T>> {
    if (request.method !== 'tools/list' || request.params?.cursor !== undefined) {
      return super.request(request, resultSchema, options);
    }
    const result = await collectToolPages(async (cursor) => (
      await super.request({
        ...request,
        params: { ...request.params, ...(cursor === undefined ? {} : { cursor }) },
      }, resultSchema, options)
    ) as ListToolsResult);
    // Each page has passed the caller's SDK result schema. Aggregation only
    // combines the tool array and removes the consumed continuation cursor.
    return result as SchemaOutput<T>;
  }
}
