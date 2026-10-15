import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/v4';
import {
  McpGetSkillRequestSchema,
  McpListSkillsRequestSchema,
  McpReadSkillDirectoryRequestSchema,
} from '@/shared/types/mcp/skills';
import {
  McpGetSkillRequestSchema as StandaloneGetSchema,
  McpListSkillsRequestSchema as StandaloneListSchema,
} from '../../mcp-servers/flujo/src/skills';

describe.each([
  { surface: 'proxy', get: McpGetSkillRequestSchema, list: McpListSkillsRequestSchema },
  { surface: 'standalone', get: StandaloneGetSchema, list: StandaloneListSchema },
])('Skills request errors over the $surface SDK transport', ({ get, list }) => {
  let server: Server;
  let client: Client;
  const getHandler = jest.fn(async (_request: unknown) => ({ resultType: 'complete' }));
  const listHandler = jest.fn(async (_request: unknown) => ({ resultType: 'complete', skills: [] }));
  const directoryHandler = jest.fn(async () => ({ resultType: 'complete', resources: [] }));

  beforeEach(async () => {
    jest.clearAllMocks();
    server = new Server({ name: 'skills-errors', version: '1' }, {
      capabilities: { resources: {}, extensions: { 'io.modelcontextprotocol/skills': {} } },
    });
    server.setRequestHandler(get, getHandler);
    server.setRequestHandler(list, listHandler);
    server.setRequestHandler(McpReadSkillDirectoryRequestSchema, directoryHandler);
    client = new Client({ name: 'skills-errors-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await Promise.all([client.close(), server.close()]);
  });

  it.each([
    { method: 'skills/get', params: { uri: '' } },
    { method: 'skills/get', params: { uri: 7 } },
    { method: 'skills/get', params: {} },
    { method: 'skills/get' },
    { method: 'skills/list', params: { cursor: 7 } },
    { method: 'skills/list', params: { cursor: null } },
    { method: 'resources/directory/read', params: { uri: '' } },
    { method: 'resources/directory/read', params: { uri: 'skill://example', cursor: 7 } },
  ])('refuses malformed $method before downstream effects', async (request) => {
    await expect(client.request(request, z.unknown())).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
    });
    expect(getHandler).not.toHaveBeenCalled();
    expect(listHandler).not.toHaveBeenCalled();
    expect(directoryHandler).not.toHaveBeenCalled();
  });

  it('accepts a valid request after refusal and preserves empty optional list parameters', async () => {
    await expect(client.request({ method: 'skills/get', params: {} }, z.unknown()))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await client.request({ method: 'skills/get', params: { uri: 'skill://example/SKILL.md' } }, z.unknown());
    await client.request({ method: 'skills/list' }, z.unknown());
    await client.request({ method: 'skills/list', params: {} }, z.unknown());
    await client.request({ method: 'skills/list', params: { cursor: 'opaque cursor' } }, z.unknown());
    expect(getHandler).toHaveBeenCalledTimes(1);
    expect(getHandler.mock.calls[0][0]).toMatchObject({ params: { uri: 'skill://example/SKILL.md' } });
    expect(listHandler).toHaveBeenCalledTimes(3);
    expect(listHandler.mock.calls[2][0]).toMatchObject({ params: { cursor: 'opaque cursor' } });
  });

  it('keeps an unexpected backend failure distinct from invalid client parameters', async () => {
    getHandler.mockRejectedValueOnce(new Error('backend failed'));
    await expect(client.request({ method: 'skills/get', params: { uri: 'skill://example/SKILL.md' } }, z.unknown()))
      .rejects.toMatchObject({ code: ErrorCode.InternalError });
    expect(getHandler).toHaveBeenCalledTimes(1);
  });

  it('reports invalid fields without echoing their supplied values', async () => {
    const secret = 'synthetic-private-request-value';
    const error = await client.request({ method: 'skills/get', params: { uri: { secret } } }, z.unknown())
      .catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: ErrorCode.InvalidParams, data: { issues: [{ path: ['uri'] }] } });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(getHandler).not.toHaveBeenCalled();
  });
});
