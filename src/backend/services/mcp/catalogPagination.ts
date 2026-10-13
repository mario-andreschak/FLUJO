import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ListResourcesResult, ListResourceTemplatesResult, ListPromptsResult } from '@modelcontextprotocol/sdk/types.js';

/** Return a complete catalog or fail; never publish a silently truncated inventory. */
export async function collectCatalogPages<T, R extends { nextCursor?: string }>(
  readPage: (cursor?: string) => Promise<R>,
  items: (page: R) => T[],
): Promise<{ firstPage: R; entries: T[] }> {
  const entries: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let firstPage: R | undefined;
  for (let page = 0; page < 1000; page++) {
    const response = await readPage(cursor);
    firstPage ??= response;
    entries.push(...items(response));
    if (response.nextCursor === undefined) return { firstPage, entries };
    if (seen.has(response.nextCursor)) throw new Error('MCP catalog returned a repeated cursor');
    seen.add(response.nextCursor);
    cursor = response.nextCursor;
  }
  throw new Error('MCP catalog exceeded 1000 pages');
}

export async function listResourcePages(client: Pick<Client, 'listResources'>, cursor?: string, options?: RequestOptions): Promise<ListResourcesResult> {
  if (cursor !== undefined) return client.listResources({ cursor }, options);
  const { firstPage, entries } = await collectCatalogPages(next => client.listResources(next === undefined ? undefined : { cursor: next }, options), page => page.resources);
  const { nextCursor: _cursor, ...rest } = firstPage;
  return { ...rest, resources: entries };
}

export async function listResourceTemplatePages(client: Pick<Client, 'listResourceTemplates'>, cursor?: string, options?: RequestOptions): Promise<ListResourceTemplatesResult> {
  if (cursor !== undefined) return client.listResourceTemplates({ cursor }, options);
  const { firstPage, entries } = await collectCatalogPages(next => client.listResourceTemplates(next === undefined ? undefined : { cursor: next }, options), page => page.resourceTemplates);
  const { nextCursor: _cursor, ...rest } = firstPage;
  return { ...rest, resourceTemplates: entries };
}

export async function listPromptPages(client: Pick<Client, 'listPrompts'>, options?: RequestOptions): Promise<ListPromptsResult> {
  const { firstPage, entries } = await collectCatalogPages(next => client.listPrompts(next === undefined ? undefined : { cursor: next }, options), page => page.prompts);
  const { nextCursor: _cursor, ...rest } = firstPage;
  return { ...rest, prompts: entries };
}
