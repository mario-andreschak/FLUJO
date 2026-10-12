import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { ProtocolError, SdkError, SdkErrorCode, type Tool } from '@modelcontextprotocol/client';
import { listResourcePages, listResourceTemplatePages, listPromptPages, collectCatalogPages } from '@/backend/services/mcp/catalogPagination';
import { normalizeToolArguments } from '@/backend/services/mcp/toolArguments';
import { mcpProtocolError, isMcpRequestTimeout } from '@/backend/services/mcp/protocolErrors';
import { taskToolHeaders, taskToolOutputValidator } from '@/backend/services/mcp/tasksExtensionSession';

test.each(['resources', 'resourceTemplates', 'prompts'] as const)('%s walks opaque cursors through an empty page', async field => {
  const page = jest.fn(async (params?: { cursor?: string }) => ({ [field]: params?.cursor === 'opaque:empty' ? [] : [{ name: params?.cursor ?? 'first' }],
    ...(params?.cursor === 'opaque:last' ? {} : { nextCursor: params?.cursor ? 'opaque:last' : 'opaque:empty' }) }));
  const client = { listResources: page, listResourceTemplates: page, listPrompts: page } as never;
  const result = field === 'resources' ? await listResourcePages(client) : field === 'resourceTemplates' ? await listResourceTemplatePages(client) : await listPromptPages(client);
  expect((result as unknown as Record<string, unknown>)[field]).toEqual([{ name: 'first' }, { name: 'opaque:last' }]);
  expect(result.nextCursor).toBeUndefined();
  expect(page.mock.calls.map(call => call[0]?.cursor)).toEqual([undefined, 'opaque:empty', 'opaque:last']);
});

test('explicit resource cursors return one page with its continuation intact', async () => {
  const page = jest.fn().mockResolvedValue({ resources: [], nextCursor: 'next opaque' });
  expect(await listResourcePages({ listResources: page } as never, '')).toEqual({ resources: [], nextCursor: 'next opaque' });
  expect(page).toHaveBeenCalledTimes(1);
  expect(page.mock.calls[0][0]).toEqual({ cursor: '' });
});

test('pagination rejects repeated cursors and never publishes partial results', async () => {
  const page = jest.fn().mockResolvedValue({ nextCursor: 'repeated', values: [1] });
  await expect(collectCatalogPages<number, { nextCursor?: string; values: number[] }>(page, result => result.values)).rejects.toThrow('repeated cursor');
  expect(page).toHaveBeenCalledTimes(2);
});

test('nullable values and prototype-sensitive own keys survive without guessed defaults', () => {
  const args = JSON.parse('{"ownerId":null,"message":null,"__proto__":{"ownerId":null},"nested":[null,{"hasAccess":null}]}');
  args.omitted = undefined;
  args.nested[1].omitted = undefined;
  const result = normalizeToolArguments(args);
  expect(JSON.stringify(result)).toBe('{"ownerId":null,"message":null,"__proto__":{"ownerId":null},"nested":[null,{"hasAccess":null}]}');
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  expect(Object.hasOwn(result, '__proto__')).toBe(true);
});

test.each([NaN, Infinity, BigInt(1), () => {}, undefined])('non-JSON array members %s are rejected', value => {
  expect(() => normalizeToolArguments({ values: [value] })).toThrow(McpError);
});

test('accessors and cycles are rejected without executing a getter', () => {
  const getter = jest.fn();
  const value = Object.defineProperty({}, 'ownerId', { get: getter, enumerable: true });
  expect(() => normalizeToolArguments(value)).toThrow(McpError);
  expect(getter).not.toHaveBeenCalled();
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  expect(() => normalizeToolArguments(cycle)).toThrow(McpError);
});

test.each([-32601, -32602, -32603])('both SDKs preserve protocol code %s and data', code => {
  for (const error of [new McpError(code, 'refused', { field: 'name' }), new ProtocolError(code, 'refused', { field: 'name' })]) {
    expect(mcpProtocolError(error)).toMatchObject({ code, data: { field: 'name' } });
  }
  expect(mcpProtocolError({ code, data: { forged: true } })).toBeUndefined();
});

test('local v1/v2 request timers are distinguished from unrelated failures', () => {
  expect(isMcpRequestTimeout(new McpError(ErrorCode.RequestTimeout, 'timed out'))).toBe(true);
  expect(isMcpRequestTimeout(new SdkError(SdkErrorCode.RequestTimeout, 'timed out'))).toBe(true);
  expect(isMcpRequestTimeout(new Error('timed out'))).toBe(false);
});

test('Tasks mirrors declared primitive headers with unambiguous UTF8 encoding', () => {
  const tool = { name: 'route', inputSchema: { type: 'object', properties: {
    tenant: { type: 'string', 'x-mcp-header': 'Tenant' },
    count: { type: 'integer', 'x-mcp-header': 'Count' },
    nested: { type: 'object', properties: { active: { type: 'boolean', 'x-mcp-header': 'Active' } } },
  } } } as Tool;
  expect(taskToolHeaders(tool, { tenant: ' a\né ', count: 7, nested: { active: false }, secret: 'never a header' })).toEqual({
    'Mcp-Param-Tenant': '=?base64?' + Buffer.from(' a\né ').toString('base64') + '?=', 'Mcp-Param-Count': '7', 'Mcp-Param-Active': 'false',
  });
  expect(taskToolHeaders(tool, { tenant: null })).toEqual({});
  expect(() => taskToolHeaders({ ...tool, inputSchema: { type: 'object', items: { type: 'string', 'x-mcp-header': 'Bad' } } } as Tool, {})).toThrow(ProtocolError);
});

test.each([{ type: 'integer' }, { type: 'array', items: { type: 'integer' } }, { type: 'object', required: ['value'], properties: { value: { type: 'integer' } } }])('Tasks validates arbitrary structured JSON against %j', outputSchema => {
  const valid = outputSchema.type === 'integer' ? 7 : outputSchema.type === 'array' ? [7, 8] : { value: 7 };
  const check = taskToolOutputValidator({ name: 'output', inputSchema: { type: 'object' }, outputSchema } as Tool);
  expect(() => check({ structuredContent: valid })).not.toThrow();
  expect(() => check({ structuredContent: 'wrong' })).toThrow(ProtocolError);
  expect(() => check({})).toThrow(ProtocolError);
  expect(() => check({ isError: true })).not.toThrow();
});
