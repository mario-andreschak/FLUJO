import { createHash, randomUUID } from 'node:crypto';
import { generateKeyPair, SignJWT, jwtVerify } from 'jose';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { callTool } from '@/backend/services/mcp/tools';
import { registerExecutionExtension, type ExecutionExtensionContext } from '@/backend/execution/extensions';
import { applyPresetArguments } from '@/backend/utils/resolveDynamicReferences';
import { fixtureAdapter, fixtureRun, mintFixture, type FixtureRun } from './fixtureAdapter';

jest.mock('@/utils/logger', () => ({ createLogger: () => ({
  debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), verbose: jest.fn(),
}) }));
jest.mock('@/backend/services/mcp/betaClient', () => ({ isBetaClient: () => false }));
jest.mock('@/backend/services/mcp/tasksProtocol', () => ({ decideTaskAugmentation: jest.fn(), mcpTasksClientEnabled: () => false }));

describe('final-argument private MCP dispatch boundary', () => {
  let restore: () => void;
  afterEach(() => restore?.());
  const digest = (value: object) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const sdk = (implementation = jest.fn(async () => ({ structuredContent: { ok: true }, content: [] }))) => ({
    callTool: implementation,
    listTools: jest.fn(async () => ({ tools: [{ name: 'read', inputSchema: { type: 'object' } }] })),
  });
  const dispatch = (client: ReturnType<typeof sdk>, args: Record<string, unknown>, context?: ExecutionExtensionContext) =>
    callTool(client as unknown as Client, 'protected-fixture', 'read', args, 30, undefined, undefined,
      'host', undefined, undefined, context);

  test('signs final preset-overridden, normalized args with private subject and fresh jti per dispatch', async () => {
    const keys = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
    const verified: Record<string, unknown>[] = [];
    const adapter = fixtureAdapter({ requestMeta: async (value, _server, tool, args) => {
      const run = value as FixtureRun;
      const token = await new SignJWT({ sub: run.subject, conversation: run.conversation, tool, digest: digest(args) })
        .setProtectedHeader({ alg: 'EdDSA', typ: 'fixture+jwt' }).setAudience('fixture-mcp')
        .setIssuedAt().setExpirationTime('60s').setJti(randomUUID()).sign(keys.privateKey);
      return { assertion: token };
    } });
    restore = registerExecutionExtension(adapter);
    const run = fixtureRun();
    const context = mintFixture(adapter, run);
    const call = jest.fn(async (request: { arguments: object; _meta: { assertion: string } }) => {
      const result = await jwtVerify(request._meta.assertion, keys.publicKey, { audience: 'fixture-mcp' });
      expect(result.payload.sub).toBe('A');
      expect(result.payload.digest).toBe(digest(request.arguments));
      expect(request.arguments).toEqual({ customer_id: 'A', conversation_id: 'conversation-A', limit: 1 });
      verified.push(result.payload);
      return { content: [{ type: 'text', text: '{"ok":true}' }] };
    });
    const client = sdk(call as never);
    const args = await applyPresetArguments({ customer_id: 'B', conversation_id: 'conversation-B' },
      { customer_id: 'A', conversation_id: '@current.conversation.id' }, { conversationId: run.conversation });
    expect((await dispatch(client, args, context)).success).toBe(true);
    expect((await dispatch(client, args, context)).success).toBe(true);
    expect(verified[0].jti).not.toBe(verified[1].jti);
  });

  test.each([undefined, {}, { subject: 'A' }])('missing or forged context is rejected before SDK dispatch: %j', async forged => {
    restore = registerExecutionExtension(fixtureAdapter());
    const client = sdk();
    expect((await dispatch(client, {}, forged as ExecutionExtensionContext)).success).toBe(false);
    expect(client.callTool).not.toHaveBeenCalled();
    expect(client.listTools).not.toHaveBeenCalled();
  });

  test.each(['revoked', 'expired'])('late MCP result cannot publish after authority is %s', async mutation => {
    const validateResult = jest.fn((_value: object, _tool: string, result: unknown) => result);
    const adapter = fixtureAdapter({ validateResult });
    restore = registerExecutionExtension(adapter);
    const run = fixtureRun();
    const context = mintFixture(adapter, run);
    const client = sdk(jest.fn(async () => {
      if (mutation === 'revoked') run.revoked = true; else run.expires = Date.now() - 1;
      return { structuredContent: { ok: true }, content: [] };
    }));
    const result = await dispatch(client, {}, context);
    expect(result.success).toBe(false);
    expect(result).not.toHaveProperty('data');
    expect(validateResult).not.toHaveBeenCalled();
  });

  test('SDK errors containing private metadata are neither returned nor retried', async () => {
    const adapter = fixtureAdapter();
    restore = registerExecutionExtension(adapter);
    const run = fixtureRun();
    const client = sdk(jest.fn(async () => { throw new Error(`request failed: ${run.privateMarker}`); }));
    const result = await dispatch(client, {}, mintFixture(adapter, run));
    expect(result).toMatchObject({ success: false, error: 'execution_tool_unavailable' });
    expect(JSON.stringify(result)).not.toContain(run.privateMarker);
    expect(client.callTool).toHaveBeenCalledTimes(1);
  });
});
