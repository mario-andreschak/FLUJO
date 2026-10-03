import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ListToolsResult, Request } from '@modelcontextprotocol/sdk/types.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { AnySchema, SchemaOutput } from '@modelcontextprotocol/sdk/server/zod-compat.js';

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
    if (seenCursors.has(response.nextCursor)) {
      throw new Error("Tool discovery returned a repeated cursor; check the server's pagination.");
    }
    seenCursors.add(response.nextCursor);
    cursor = response.nextCursor;
  }
  const { nextCursor: _cursor, ...result } = firstPage;
  return { ...result, tools };
}

/** Also supports client adapters that expose individual pages through listTools. */
export function listCompleteTools(client: Pick<Client, 'listTools'>): Promise<ListToolsResult> {
  return collectToolPages((cursor) => cursor === undefined ? client.listTools() : client.listTools({ cursor }));
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
