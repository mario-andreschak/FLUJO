import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;
export const MAX_LIST_QUERY_CHARS = 256;

export type JsonSchema = Record<string, unknown>;

export const COMMON_LIST_PROPERTIES: Record<string, object> = {
  query: {
    type: 'string',
    maxLength: MAX_LIST_QUERY_CHARS,
    description: 'Optional case-insensitive substring search over the safe summary fields.',
  },
  limit: {
    type: 'integer',
    minimum: 1,
    maximum: MAX_LIST_LIMIT,
    description: `Maximum items to return (default ${DEFAULT_LIST_LIMIT}, maximum ${MAX_LIST_LIMIT}).`,
  },
  cursor: {
    type: 'string',
    description: 'Opaque cursor returned in structuredContent.nextCursor by the previous call.',
  },
};

export function listInputSchema(
  properties: Record<string, object> = {},
  options: { required?: string[]; sorts?: readonly string[]; common?: boolean } = {},
): Tool['inputSchema'] {
  const common = options.common === false ? {} : COMMON_LIST_PROPERTIES;
  const sort = options.sorts
    ? {
        sort: {
          type: 'string',
          enum: [...options.sorts],
          description: 'Stable result ordering.',
        },
      }
    : {};
  return {
    type: 'object',
    additionalProperties: false,
    properties: { ...common, ...sort, ...properties },
    ...(options.required?.length ? { required: options.required } : {}),
  } as Tool['inputSchema'];
}

export function listOutputSchema(): NonNullable<Tool['outputSchema']> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      items: { type: 'array', items: {} },
      total: { type: 'integer', minimum: 0 },
      hasMore: { type: 'boolean' },
      nextCursor: { type: 'string' },
    },
    required: ['items', 'total', 'hasMore'],
  } as NonNullable<Tool['outputSchema']>;
}

export class ListArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ListArgumentError';
  }
}

export function decodeListCursor(cursor: string): number {
  if (!cursor || cursor.length > 512) {
    throw new ListArgumentError('"cursor" must be a non-empty cursor returned by a previous list call.');
  }
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { offset?: unknown };
    if (!Number.isInteger(decoded.offset) || Number(decoded.offset) < 0) throw new Error('bad offset');
    return Number(decoded.offset);
  } catch {
    throw new ListArgumentError('"cursor" is invalid or malformed.');
  }
}

export function encodeListCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

export interface ParsedListArgs {
  query: string;
  limit: number;
  offset: number;
  sort?: string;
}

export function assertAllowedArguments(args: Record<string, unknown>, allowed: readonly string[]): void {
  const allow = new Set(allowed);
  const unknown = Object.keys(args).filter((key) => !allow.has(key));
  if (unknown.length > 0) {
    throw new ListArgumentError(`Unsupported list argument${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}.`);
  }
}

export function parseListArgs(
  args: Record<string, unknown>,
  options: {
    allowed?: readonly string[];
    sorts?: readonly string[];
    defaultSort?: string;
    defaultLimit?: number;
  } = {},
): ParsedListArgs {
  assertAllowedArguments(args, ['query', 'limit', 'cursor', ...(options.sorts ? ['sort'] : []), ...(options.allowed ?? [])]);

  let query = '';
  if (args.query !== undefined) {
    if (typeof args.query !== 'string') throw new ListArgumentError('"query" must be a string.');
    query = args.query.trim().toLocaleLowerCase();
    if (query.length > MAX_LIST_QUERY_CHARS) {
      throw new ListArgumentError(`"query" must be at most ${MAX_LIST_QUERY_CHARS} characters.`);
    }
  }

  const defaultLimit = Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(options.defaultLimit ?? DEFAULT_LIST_LIMIT)));
  let limit = defaultLimit;
  if (args.limit !== undefined) {
    if (!Number.isInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > MAX_LIST_LIMIT) {
      throw new ListArgumentError(`"limit" must be an integer between 1 and ${MAX_LIST_LIMIT}.`);
    }
    limit = Number(args.limit);
  }

  let offset = 0;
  if (args.cursor !== undefined) {
    if (typeof args.cursor !== 'string') throw new ListArgumentError('"cursor" must be a string.');
    offset = decodeListCursor(args.cursor);
  }

  let sort = options.defaultSort;
  if (options.sorts && args.sort !== undefined) {
    if (typeof args.sort !== 'string' || !options.sorts.includes(args.sort)) {
      throw new ListArgumentError(`"sort" must be one of: ${options.sorts.join(', ')}.`);
    }
    sort = args.sort;
  }
  return { query, limit, offset, sort };
}

export function optionalString(
  args: Record<string, unknown>,
  key: string,
  options: { maxLength?: number; allowEmpty?: boolean } = {},
): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new ListArgumentError(`"${key}" must be a string.`);
  const trimmed = value.trim();
  if (!trimmed && !options.allowEmpty) throw new ListArgumentError(`"${key}" must not be empty.`);
  if (trimmed.length > (options.maxLength ?? MAX_LIST_QUERY_CHARS)) {
    throw new ListArgumentError(`"${key}" is too long.`);
  }
  return trimmed;
}

export function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new ListArgumentError(`"${key}" must be a boolean.`);
  return value;
}

export function optionalFiniteNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ListArgumentError(`"${key}" must be a finite number.`);
  }
  return value;
}

export function optionalStringArray(
  args: Record<string, unknown>,
  key: string,
  allowed?: readonly string[],
): string[] | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === 'string')) {
    throw new ListArgumentError(`"${key}" must be a non-empty array of strings.`);
  }
  const values = [...new Set(value.map((item) => item.trim()).filter(Boolean))];
  if (values.length === 0) throw new ListArgumentError(`"${key}" must contain at least one non-empty value.`);
  if (allowed) {
    const invalid = values.filter((item) => !allowed.includes(item));
    if (invalid.length > 0) {
      throw new ListArgumentError(`"${key}" contains unsupported values: ${invalid.join(', ')}.`);
    }
  }
  return values;
}

export interface ListPage<T> {
  items: T[];
  total: number;
  hasMore: boolean;
  nextCursor?: string;
}

export function paginateList<T>(items: T[], parsed: ParsedListArgs): ListPage<T> {
  const pageItems = items.slice(parsed.offset, parsed.offset + parsed.limit);
  const nextOffset = parsed.offset + pageItems.length;
  const hasMore = nextOffset < items.length;
  return {
    items: pageItems,
    total: items.length,
    hasMore,
    ...(hasMore ? { nextCursor: encodeListCursor(nextOffset) } : {}),
  };
}

/** Preserve the legacy text-array payload while exposing pagination metadata natively. */
export function pagedCallToolResult<T>(page: ListPage<T>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(page.items, null, 2) }],
    structuredContent: page as unknown as Record<string, unknown>,
  };
}
