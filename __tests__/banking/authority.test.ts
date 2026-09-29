import { configuredExecutionAdapter } from '@/integrations/hackathon-banking/configuredAdapter';
import { registerExecutionExtension, createExecutionExtensionContext } from '@/backend/execution/extensions';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { generateKeyPair, exportSPKI, exportPKCS8, SignJWT, jwtVerify } from 'jose';
import canonicalize from 'canonicalize';
import { authenticateBankingRequest, bankingAdmission, createBankingRunContext, bindBankingRun,
  assertBankingRunCurrent, signBankingCall, BANK_ASSERTION_META, validateBankingArguments,
  type BankingRunContext, assertBankingServerConfig } from '@/backend/services/banking/authority';
import { assertBankingModelTool, authorizeBankingHandoffs } from '@/backend/services/banking/authority';
import { commitBankingMutation } from '@/backend/services/banking/authority';
import { grantBankingActionTool } from '@/integrations/hackathon-banking/authority';
import { BankingStore } from '@/backend/services/banking/store';
import { callTool } from '@/backend/services/mcp/tools';
import { validateBankingResult } from '@/backend/services/banking/protocol';
import { runWithWorkspace } from '@/utils/workspace';
import { mcpService } from '@/backend/services/mcp';
import { StaticNode } from '@/backend/execution/flow/nodes/StaticNode';
import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import type { SharedState, StaticNodeParams } from '@/backend/execution/flow/types';
import { acceptBankingJob, activateBankingJob, reserveBankingJob } from '@/integrations/hackathon-banking/executionLease';

describe('banking identity authority', () => {
  let root: string;
  let policy: Record<string, unknown>;
  let frontend: Awaited<ReturnType<typeof generateKeyPair>>;
  let bank: Awaited<ReturnType<typeof generateKeyPair>>;
  let policyFile: string;
  const sessions = new Map<string, { id: string; expires: number }>();
  const priorConfig = process.env.FLUJO_BANKING_CONFIG;
  let restoreExtension: () => void;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-bank-auth-'));
    frontend = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    bank = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    await fs.writeFile(path.join(root, 'signer.pem'), await exportPKCS8(bank.privateKey));
    policy = { deploymentId: 'test', workspace: 'default-workspace', executionToken: 'EXECUTION_SENTINEL_' + 'x'.repeat(32),
      stateDir: path.join(root, 'state'), frontendIssuer: 'frontend-test', frontendAudience: 'flujo-banking-ingress',
      frontendKeys: { front: await exportSPKI(frontend.publicKey) }, bankIssuer: 'banking-runtime-test',
      bankAudience: 'banking-mcp', bankKeyId: 'bank', bankSigningKeyFile: path.join(root, 'signer.pem'),
      bankServerName: 'Banking MCP', bankCommand: path.join(root, 'python'), bankCwd: root, bankConfigFile: path.join(root, 'bank.json'), flowId: randomUUID(), graphHash: 'a'.repeat(64) };
    policyFile = path.join(root, 'policy.json');
    await fs.writeFile(policyFile, JSON.stringify(policy));
    process.env.FLUJO_BANKING_CONFIG = policyFile;
    sessions.clear();
    restoreExtension = registerExecutionExtension(configuredExecutionAdapter);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    restoreExtension();
    if (priorConfig === undefined) delete process.env.FLUJO_BANKING_CONFIG;
    else process.env.FLUJO_BANKING_CONFIG = priorConfig;
    await fs.rm(root, { recursive: true, force: true });
  });

  async function request(subject = 'alice', overrides: Record<string, unknown> = {}, key = frontend.privateKey) {
    const now = Math.floor(Date.now() / 1000);
    if (!sessions.has(subject)) sessions.set(subject, { id: randomUUID(), expires: now + 3600 });
    const session = sessions.get(subject)!;
    const token = await new SignJWT({ iss: 'frontend-test', aud: 'flujo-banking-ingress', sub: subject,
      iat: now, nbf: now, exp: now + 120, session_exp: session.expires, jti: randomUUID(),
      session_id: session.id, scope: ['bank:read'], ...overrides })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'front', typ: 'flujo-ingress+jwt' }).sign(key);
    return new Request('http://127.0.0.1/v1/chat/completions', { method: 'POST', headers: {
      Authorization: `Bearer ${policy.executionToken}`, 'X-Flujo-User-Assertion': token,
    } });
  }

  async function context(subject = 'alice') {
    const principal = await authenticateBankingRequest(await request(subject));
    const { store, identity } = bankingAdmission(principal);
    const id = randomUUID();
    await store.createConversation(id, identity);
    const { job } = await acceptBankingJob(principal, id, true, new AbortController().signal, mint => ({ job: mint() }));
    reserveBankingJob(job);
    await activateBankingJob(job);
    const ctx = await createBankingRunContext(job, id);
    await bindBankingRun(ctx, id, randomUUID());
    return { principal, store, identity, id, ctx, extensionContext: createExecutionExtensionContext(configuredExecutionAdapter, ctx) };
  }

  test('forgery is rejected before any customer state is created', async () => {
    const foreign = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
    await expect(authenticateBankingRequest(await request('alice', {}, foreign.privateKey))).rejects.toThrow('authorization_denied');
    await expect(fs.stat(path.join(root, 'state'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('the protected server must launch the exact local stdio command', () => {
    const config = { name: 'Banking MCP', transport: 'stdio', command: policy.bankCommand,
      cwd: policy.bankCwd, rootPath: policy.bankCwd, env: {},
      args: ['-m', 'banking_mcp', 'serve', '--config', policy.bankConfigFile, '--transport', 'stdio'] };
    expect(() => assertBankingServerConfig(config as never)).not.toThrow();
    for (const patch of [{ transport: 'streamable', serverUrl: 'http://banking-mcp:8000/mcp' },
      { command: 'python' }, { cwd: 'other' }, { args: [] }, { env: { CUSTOMER_ID: 'bob' } }]) {
      expect(() => assertBankingServerConfig({ ...config, ...patch } as never)).toThrow('banking_server_policy_mismatch');
    }
  });
  test.each([{ aud: 'banking-mcp' }, { iss: 'other' }, { scope: ['bank:write'] },
    { exp: 0 }, { iat: '1' }, { sub: '' }, { customer_id: 'other-customer' }, { run_id: 'forged' }])(
    'rejects incompatible/forged ingress claims %o', async overrides => {
      await expect(authenticateBankingRequest(await request('alice', overrides))).rejects.toThrow('authorization_denied');
    });
  test('execution credential cannot be replaced by a user assertion', async () => {
    const req = await request(); req.headers.set('Authorization', 'Bearer wrong');
    await expect(authenticateBankingRequest(req)).rejects.toThrow('authentication_required');
  });
  test('URL and header workspace switches are rejected before owner access', async () => {
    const req = await request();
    await expect(authenticateBankingRequest(new Request(req.url + '?workspace=other', req))).rejects.toThrow('routing_fields_forbidden');
    req.headers.set('X-Flujo-Workspace', 'other');
    await expect(authenticateBankingRequest(req)).rejects.toThrow('routing_fields_forbidden');
  });
  test('ingress replay is rejected after reopening the durable store', async () => {
    const req = await request();
    await authenticateBankingRequest(req);
    await expect(authenticateBankingRequest(req)).rejects.toThrow('assertion_replayed');
  });
  test('foreign, unknown and deleted conversations are unavailable', async () => {
    const alice = await context();
    const bob = bankingAdmission(await authenticateBankingRequest(await request('bob')));
    await expect(bob.store.assertOwner(alice.id, bob.identity)).rejects.toThrow('conversation_unavailable');
    await expect(bob.store.assertOwner(randomUUID(), bob.identity)).rejects.toThrow('conversation_unavailable');
    await alice.store.tombstone(alice.id, alice.identity);
    const restarted = new BankingStore(alice.store.policy);
    await expect(restarted.assertOwner(alice.id, alice.identity)).rejects.toThrow('conversation_unavailable');
    await expect(restarted.createConversation(alice.id, alice.identity)).rejects.toThrow('conversation_unavailable');
  });
  test('a session cannot be rebound to another subject', async () => {
    const alice = await context();
    await expect(authenticateBankingRequest(await request('bob', { session_id: alice.identity.session,
      session_exp: alice.identity.sessionExpires }))).rejects.toThrow('authorization_denied');
  });
  test('context provenance, workspace, conversation and run are enforced', async () => {
    const alice = await context();
    await expect(signBankingCall({} as BankingRunContext, 'Banking MCP', 'list_my_transactions', {})).rejects.toThrow('trusted_banking_context_required');
    await expect(assertBankingRunCurrent(alice.ctx, { conversationId: randomUUID() })).rejects.toThrow('authorization_denied');
    await expect(bindBankingRun(alice.ctx, alice.id, randomUUID())).rejects.toThrow('authorization_denied');
    await expect(runWithWorkspace('other', () => signBankingCall(alice.ctx, 'Banking MCP', 'list_my_transactions', {}))).rejects.toThrow('authorization_denied');
    expect(JSON.stringify(alice.ctx)).toBe('{}');
  });
  test('each exact call receives fresh bank-audience authority', async () => {
    const alice = await context();
    const args = { limit: 2 };
    const first = await signBankingCall(alice.ctx, 'Banking MCP', 'list_my_transactions', args);
    const second = await signBankingCall(alice.ctx, 'Banking MCP', 'list_my_transactions', args);
    const one = await jwtVerify(first, bank.publicKey, { issuer: 'banking-runtime-test', audience: 'banking-mcp' });
    const two = await jwtVerify(second, bank.publicKey);
    expect(one.protectedHeader.typ).toBe('bank-mcp+jwt');
    expect(one.payload.sub).toBe('alice');
    expect(one.payload.args_sha256).toBe(createHash('sha256').update(canonicalize(args)!).digest('hex'));
    expect(one.payload.jti).not.toBe(two.payload.jti);
    expect((one.payload.exp as number) - (one.payload.iat as number)).toBeLessThanOrEqual(60);
    expect(first).not.toContain('EXECUTION_SENTINEL');
  });
  test('revocation blocks subsequent signatures and results', async () => {
    const alice = await context();
    await alice.store.revoke(alice.identity);
    await expect(signBankingCall(alice.ctx, 'Banking MCP', 'list_my_transactions', {})).rejects.toThrow('authorization_expired');
    await expect(assertBankingRunCurrent(alice.ctx)).rejects.toThrow('authorization_expired');
  });
  test('caller/model authority fields and shared-variable interpolation are rejected', () => {
    for (const args of [{ customer_id: '' }, { conversation_id: '' }, { _meta: { [BANK_ASSERTION_META]: 'forged' } },
      { limit: '1' }, { limit: 500 }, { cursor: '${global:EXECUTION_TOKEN}' }]) {
      expect(() => validateBankingArguments('list_my_transactions', args)).toThrow('invalid_banking_arguments');
    }
  });
  test('MCP v1 metadata carries the assertion outside finalized business args', async () => {
    const alice = await context();
    const resultData = { error: 'reference_unavailable' };
    const client = { callTool: jest.fn(async (_params?: unknown) => ({ isError: true,
      content: [{ type: 'text', text: JSON.stringify(resultData) }], structuredContent: resultData })) };
    const args = { limit: 2 };
    const result = await callTool(client as never, 'Banking MCP', 'list_my_transactions', args,
      10, undefined, undefined, 'host', undefined, undefined, alice.extensionContext);
    expect(result.success).toBe(true);
    const params = client.callTool.mock.calls[0]?.[0] as unknown as { arguments: unknown; _meta: Record<string, string> };
    expect(params.arguments).toEqual(args);
    expect(typeof params._meta[BANK_ASSERTION_META]).toBe('string');
    expect(JSON.stringify(result)).not.toContain(params._meta[BANK_ASSERTION_META]);
  });
  test.each([{ task: { taskId: 'foreign' } }, { content: [{ type: 'resource', resource: { text: 'foreign' } }] },
    { content: [{ type: 'text', text: '{"error":"reference_unavailable"}' }], structuredContent: { error: 'reference_unavailable' },
      isError: true, _meta: { ui: { resourceUri: 'ui://foreign' } } }])('unsolicited protocol results are rejected', value => {
      expect(() => validateBankingResult('list_my_transactions', value)).toThrow('banking_protocol_result_rejected');
    });
  test('500 distinct trusted contexts never interchange principals', async () => {
    const results = await Promise.all(Array.from({ length: 500 }, async (_, index) => {
      const subject = `customer-${index}`;
      const admitted = await context(subject);
      const token = await signBankingCall(admitted.ctx, 'Banking MCP', 'list_my_transactions', { limit: 1 });
      return (await jwtVerify(token, bank.publicKey)).payload.sub === subject;
    }));
    expect(results.every(Boolean)).toBe(true);
  }, 30000);

  test('removing a trusted key immediately stops admitted work', async () => {
    const alice = await context();
    policy.frontendKeys = { replacement: await exportSPKI(frontend.publicKey) };
    await fs.writeFile(policyFile, JSON.stringify(policy));
    await expect(signBankingCall(alice.ctx, 'Banking MCP', 'list_my_transactions', {})).rejects.toThrow('banking_policy_changed');
  });
  test('revoked authority cannot commit a durable projection', async () => {
    const alice = await context();
    await alice.store.revoke(alice.identity);
    const write = jest.fn(async () => undefined);
    await expect(commitBankingMutation(alice.ctx, write)).rejects.toThrow('authorization_expired');
    expect(write).not.toHaveBeenCalled();
  });
  test('guessed native tools are denied even when the model bypasses its advertised list', async () => {
    const alice = await context();
    for (const name of ['read_resource', 'write_resource', 'list_mcp_resources', 'question', 'call_subflow_other', 'handoff_to_other']) {
      await expect(assertBankingModelTool(alice.ctx, name, undefined)).rejects.toThrow('banking_tool_forbidden');
    }
    authorizeBankingHandoffs(alice.ctx, ['handoff_to_finish']);
    await expect(assertBankingModelTool(alice.ctx, 'handoff_to_finish', undefined)).resolves.toBeUndefined();
    await expect(assertBankingModelTool(alice.ctx, 'Banking_MCP__list_my_transactions',
      { server: 'Banking MCP', tool: 'list_my_transactions' })).resolves.toBeUndefined();
  });
  test('action scope needs a one-call exact host grant; static host identity is insufficient', async () => {
    const alice = await context();
    const args = { transaction_id: 'synthetic-owned-id', snapshot: 'synthetic-build' };
    await expect(signBankingCall(alice.ctx, 'Banking MCP', 'prepare_unrecognized_charge', args))
      .rejects.toThrow('banking_action_consent_required');
    await expect(assertBankingModelTool(alice.ctx, 'Banking_MCP__prepare_unrecognized_charge',
      { server: 'Banking MCP', tool: 'prepare_unrecognized_charge' })).rejects.toThrow('banking_tool_forbidden');
    await grantBankingActionTool(alice.ctx, 'prepare_unrecognized_charge', args);
    await expect(signBankingCall(alice.ctx, 'Banking MCP', 'prepare_unrecognized_charge',
      { ...args, transaction_id: 'changed' })).rejects.toThrow('banking_action_consent_required');
    const signed = await signBankingCall(alice.ctx, 'Banking MCP', 'prepare_unrecognized_charge', args);
    const verified = await jwtVerify(signed, bank.publicKey, { issuer: 'banking-runtime-test', audience: 'banking-mcp' });
    expect(verified.payload.scope).toEqual(['bank:prepare']);
    await expect(signBankingCall(alice.ctx, 'Banking MCP', 'prepare_unrecognized_charge', args))
      .rejects.toThrow('banking_action_consent_required');
  });
  test('revocation during an in-flight MCP read discards the result', async () => {
    const alice = await context();
    const data = { error: 'reference_unavailable' };
    const client = { callTool: jest.fn(async () => {
      await alice.store.revoke(alice.identity);
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
    }) };
    const result = await callTool(client as never, 'Banking MCP', 'list_my_transactions', {},
      10, undefined, undefined, 'host', undefined, undefined, alice.extensionContext);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain('reference_unavailable');
  });
  test('service denies ordinary calls and unsupported surfaces before connecting', async () => {
    const connect = jest.spyOn(mcpService, 'connectServer');
    const result = await mcpService.callTool('Banking MCP', 'list_my_transactions', {});
    expect(result.success).toBe(false); expect(connect).not.toHaveBeenCalled();
    expect(await mcpService.listServerResources('Banking MCP')).toEqual({ resources: [], error: 'execution_protocol_surface_forbidden' });
    expect((await mcpService.readResource('Banking MCP', 's3://foreign')).success).toBe(false);
    expect((await mcpService.getPrompt('Banking MCP', 'foreign')).success).toBe(false);
    expect(connect).not.toHaveBeenCalled();
  });
  test('actual Static and ModelHandler paths forward the same opaque authority', async () => {
    const alice = await context();
    const data = { error: 'reference_unavailable' };
    const tokens: string[] = [];
    const client = { listTools: jest.fn(async () => ({ tools: [{ name: 'list_my_transactions',
      inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } } }] })),
      callTool: jest.fn(async (params: { _meta: Record<string, string> }) => {
      tokens.push(params._meta[BANK_ASSERTION_META]);
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
    }) };
    jest.spyOn(mcpService, 'loadServerConfigs').mockResolvedValue([]);
    jest.spyOn(mcpService, 'setNodeRoots').mockImplementation(() => undefined);
    const dispatch = jest.spyOn(mcpService, 'callTool').mockImplementation(async (server, tool, args,
      timeout, progress, node, signal, source, owner, trusted, ctx) => {
      expect(ctx).toBe(alice.extensionContext);
      return callTool(client as never, server, tool, args, timeout, progress, signal, source, node, owner, ctx);
    });
    const staticNode = new StaticNode();
    const state = { conversationId: alice.id, logicalRunId: 'static-test', executionExtensionContext: alice.extensionContext,
      messages: [], variables: { customer: 'bob' }, trackingInfo: { executionId: 'test', startTime: 0, nodeExecutionTracker: [] } } as unknown as SharedState;
    const params = { id: 'static', type: 'static', label: 'Static', properties: {
      entries: [{ kind: 'toolCall', executionMode: 'real', serverName: 'Banking MCP',
        toolName: 'list_my_transactions', argumentsJson: '{"limit":2}' }],
      mcpNodes: [{ id: 'bank', properties: { boundServer: 'Banking MCP', enabledTools: ['list_my_transactions'] } }],
    } } as StaticNodeParams;
    await staticNode.post(await staticNode.prep(state, params), {}, state, params);
    const model = await ModelHandler.processToolCalls({ executionExtensionContext: alice.extensionContext,
      toolCalls: [{ id: 'tool-1', type: 'function', function: { name: 'bank_list', arguments: '{"limit":2}' } }],
      toolNameMap: { bank_list: { server: 'Banking MCP', tool: 'list_my_transactions' } } });
    expect(model.success).toBe(true); expect(dispatch).toHaveBeenCalledTimes(2);
    expect(tokens).toHaveLength(2);
    const claims = await Promise.all(tokens.map(token => jwtVerify(token, bank.publicKey).then(value => value.payload)));
    expect(claims.every(claim => claim.sub === 'alice' && claim.conversation_id === alice.id)).toBe(true);
    expect(claims[0].jti).not.toBe(claims[1].jti);
    const hostile = await ModelHandler.processToolCalls({ executionExtensionContext: alice.extensionContext,
      toolCalls: [{ id: 'tool-2', type: 'function', function: { name: 'read_resource', arguments: '{"uri":"foreign"}' } }] });
    expect(hostile.success).toBe(false); expect(dispatch).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(state)).not.toContain(tokens[0]);
  });
});
