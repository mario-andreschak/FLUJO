import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { decodeProtectedHeader, importPKCS8, importSPKI, jwtVerify, SignJWT } from 'jose';
import canonicalize from 'canonicalize';
import { z } from 'zod';
import { getCurrentWorkspace } from '@/utils/workspace';
import type { MCPServerConfig } from '@/shared/types/mcp';
import { BankingError } from './errors';
import { assertBankingExecutionBearer, requireBankingPolicy, type BankingPolicy } from './policy';
import { BankingStore, type Identity } from './store';

export const BANK_ASSERTION_META = 'com.flujo.bank/assertion';
declare const principalBrand: unique symbol;
declare const runBrand: unique symbol;
export interface BankingPrincipal { readonly [principalBrand]: true }
export interface BankingRunContext { readonly [runBrand]: true }
interface Admission { identity: Identity; policy: BankingPolicy; store: BankingStore }
interface Run extends Admission { conversation: string; runId?: string; signal?: AbortSignal; handoffs?: ReadonlySet<string> }
type Registries = { principals: WeakMap<object, Admission>; runs: WeakMap<object, Run> };
const shared = globalThis as typeof globalThis & { __flujoBankingAuthority?: Registries };
const registries = shared.__flujoBankingAuthority ??= { principals: new WeakMap(), runs: new WeakMap() };

function admission(principal: BankingPrincipal): Admission {
  const record = registries.principals.get(principal);
  if (!record) throw new BankingError('authorization_denied');
  return record;
}

function run(context: BankingRunContext | undefined): Run {
  const record = context && registries.runs.get(context);
  if (!record) throw new BankingError('trusted_banking_context_required');
  return record;
}

const claimsSchema = z.object({
  iss: z.string().min(1).max(128), aud: z.literal('flujo-banking-ingress'),
  sub: z.string().min(1).max(128), session_id: z.string().min(16).max(128),
  iat: z.number().int(), nbf: z.number().int(), exp: z.number().int(), session_exp: z.number().int(),
  jti: z.string().min(16).max(128), scope: z.tuple([z.literal('bank:read')]),
}).strict();

export async function authenticateBankingRequest(request: Request, revocation = false): Promise<BankingPrincipal> {
  const policy = requireBankingPolicy();
  assertBankingExecutionBearer(request, policy);
  // The routes have no workspace wrapper: caller routing is rejected before any workspace lookup.
  if (new URL(request.url).search || request.headers.has('x-workspace')
    || request.headers.has('x-flujo-workspace')) throw new BankingError('routing_fields_forbidden', 400);
  const token = request.headers.get('x-flujo-user-assertion');
  if (!token || token.length > 8192) throw new BankingError('authentication_required', 401);
  let identity: Identity;
  let jti: string;
  try {
    const header = decodeProtectedHeader(token);
    if (Object.keys(header).sort().join(',') !== 'alg,kid,typ' || header.alg !== 'EdDSA'
      || header.typ !== 'flujo-ingress+jwt' || typeof header.kid !== 'string') throw new Error();
    const pem = policy.frontendKeys[header.kid];
    if (!pem) throw new Error();
    const key = await importSPKI(pem, 'EdDSA');
    if (key.type !== 'public' || key.algorithm.name !== 'Ed25519') throw new Error();
    const verified = await jwtVerify(token, key, { issuer: policy.frontendIssuer, audience: policy.frontendAudience,
      algorithms: ['EdDSA'], clockTolerance: 0 });
    const claims = claimsSchema.parse(verified.payload);
    const now = Date.now() / 1000;
    if (claims.nbf !== claims.iat || claims.iat > now || claims.exp - claims.iat <= 0
      || claims.exp - claims.iat > 120 || claims.exp > claims.session_exp
      || claims.session_exp - claims.iat > 8 * 3600) throw new Error();
    identity = { issuer: claims.iss, subject: claims.sub, session: claims.session_id,
      expires: claims.exp, sessionExpires: claims.session_exp };
    jti = claims.jti;
  } catch {
    throw new BankingError('authorization_denied', 401);
  }
  const store = new BankingStore(policy);
  if (revocation) await store.bindSession(identity);
  else await store.admitSession(identity);
  // Fresh ingress assertions are single-use, including retries/reconnects.
  await store.consumeAssertion(identity.issuer, jti, identity.expires);
  const principal = Object.freeze({}) as BankingPrincipal;
  registries.principals.set(principal, { policy, identity, store });
  return principal;
}

export function bankingAdmission(principal: BankingPrincipal): Admission { return admission(principal); }

export async function createBankingRunContext(principal: BankingPrincipal, conversation: string,
  signal?: AbortSignal): Promise<BankingRunContext> {
  const record = admission(principal);
  await record.store.assertOwner(conversation, record.identity);
  const context = Object.freeze({}) as BankingRunContext;
  registries.runs.set(context, { ...record, conversation, signal });
  return context;
}

export async function assertBankingRunCurrent(context: BankingRunContext | undefined,
  expected?: { conversationId?: string; runId?: string; graphHash?: string }): Promise<void> {
  const record = run(context);
  assertPolicyCurrent(record);
  if (record.signal?.aborted) throw new BankingError('banking_run_cancelled', 409);
  if (getCurrentWorkspace() !== record.policy.workspace
    || (expected?.conversationId !== undefined && expected.conversationId !== record.conversation)
    || (expected?.runId !== undefined && expected.runId !== record.runId)
    || (expected?.graphHash !== undefined && expected.graphHash !== record.policy.graphHash)) {
    throw new BankingError('authorization_denied');
  }
  await record.store.assertOwner(record.conversation, record.identity);
}

function assertPolicyCurrent(record: Admission): void {
  // Removing a key or changing the approved deployment invalidates in-flight work too.
  if (canonicalize(requireBankingPolicy()) !== canonicalize(record.policy)) {
    throw new BankingError('banking_policy_changed', 409);
  }
}

export async function assertBankingPrincipalCurrent(principal: BankingPrincipal): Promise<void> {
  const record = admission(principal);
  assertPolicyCurrent(record);
  await record.store.assertSession(record.identity);
}

export async function bindBankingRun(context: BankingRunContext, conversation: string, runId: string): Promise<void> {
  const record = run(context);
  if (record.runId && record.runId !== runId) throw new BankingError('authorization_denied');
  await assertBankingRunCurrent(context, { conversationId: conversation });
  record.runId = runId;
}

export function bankingRunPolicy(context: BankingRunContext): BankingPolicy { return run(context).policy; }
export function bankingRunSignal(context: BankingRunContext): AbortSignal | undefined { return run(context).signal; }

export function authorizeBankingHandoffs(context: BankingRunContext, names: string[]): void {
  run(context).handoffs = new Set(names);
}

export async function assertBankingModelTool(context: BankingRunContext, name: string,
  advertised: { server: string; tool: string } | undefined): Promise<void> {
  await assertBankingRunCurrent(context);
  const record = run(context);
  if (record.handoffs?.has(name)) return;
  if (!advertised || advertised.server !== record.policy.bankServerName
    || !bankingToolNames.includes(advertised.tool)) throw new BankingError('banking_tool_forbidden');
}

export async function commitBankingMutation<T>(context: BankingRunContext, task: () => Promise<T>): Promise<T> {
  const record = run(context);
  return record.store.withLock('session:' + record.identity.session, async () => {
    await assertBankingRunCurrent(context);
    const result = await task();
    await assertBankingRunCurrent(context);
    return result;
  });
}

export function assertBankingServerConfig(config: MCPServerConfig, policy = requireBankingPolicy()): void {
  if (config.name !== policy.bankServerName || config.transport !== 'streamable'
    || config.serverUrl !== policy.bankServerUrl || config.enableMcpApps || config.enableMcpSkills
    || config.sampling?.enabled || config.elicitation?.enabled || config.exposeAsMcpServer) {
    throw new BankingError('banking_server_policy_mismatch');
  }
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional();
const reference = z.string().regex(/^[A-Za-z0-9_-]{32,64}$/);
const toolSchemas = {
  banking_status: z.object({}).strict(),
  list_my_transactions: z.object({ start_date: date, end_date: date,
    limit: z.number().int().min(1).max(20).optional(), cursor: reference.nullable().optional() }).strict(),
  get_my_transaction: z.object({ selection_handle: reference, verify_source: z.boolean().optional() }).strict(),
};
export const bankingToolNames = Object.freeze(Object.keys(toolSchemas));

export function validateBankingArguments(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const schema = toolSchemas[tool as keyof typeof toolSchemas];
  if (!schema) throw new BankingError('banking_tool_forbidden');
  try {
    return schema.parse(args);
  } catch {
    throw new BankingError('invalid_banking_arguments', 400);
  }
}

export async function assertBankingToolDispatch(context: BankingRunContext | undefined, serverName: string,
  source: string): Promise<void> {
  const record = run(context);
  if (serverName !== record.policy.bankServerName || !['model', 'host'].includes(source) || !record.runId) {
    throw new BankingError('banking_tool_forbidden');
  }
  await assertBankingRunCurrent(context);
}

export function bankSessionId(policy: BankingPolicy, identity: Identity): string {
  return createHash('sha256').update(JSON.stringify([policy.deploymentId, identity.issuer, identity.session])).digest('hex');
}

export async function signBankingCall(context: BankingRunContext, serverName: string, tool: string,
  args: Record<string, unknown>): Promise<string> {
  await assertBankingToolDispatch(context, serverName, 'host');
  const record = run(context);
  validateBankingArguments(tool, args);
  return sign(record.policy, record.identity, record.conversation, record.runId!, tool, args, 'bank:read', 'bank-mcp+jwt');
}

async function sign(policy: BankingPolicy, identity: Identity, conversation: string, runId: string,
  tool: string, args: Record<string, unknown>, scope: string, type: string): Promise<string> {
  const key = await importPKCS8(await readFile(policy.bankSigningKeyFile, 'utf8'), 'EdDSA');
  if (key.algorithm.name !== 'Ed25519') throw new BankingError('banking_signer_unavailable', 503);
  const now = Math.floor(Date.now() / 1000);
  const expires = Math.min(now + 60, identity.expires, identity.sessionExpires);
  if (expires <= now) throw new BankingError('authorization_expired', 401);
  return new SignJWT({ sub: identity.subject, session_id: bankSessionId(policy, identity),
    conversation_id: conversation, run_id: runId, graph_revision: policy.graphHash,
    tool, scope: [scope], args_sha256: createHash('sha256').update(canonicalize(args)!).digest('hex') })
    .setProtectedHeader({ alg: 'EdDSA', kid: policy.bankKeyId, typ: type })
    .setIssuer(policy.bankIssuer).setAudience(policy.bankAudience).setIssuedAt(now).setNotBefore(now)
    .setExpirationTime(expires).setJti(randomUUID()).sign(key);
}

export async function revokeBankingSession(principal: BankingPrincipal): Promise<void> {
  const record = admission(principal);
  // Local revocation is durable before attempting propagation, so calls fail closed during a network outage.
  await record.store.revoke(record.identity);
  const assertion = await sign(record.policy, record.identity, 'session-revocation', randomUUID(),
    'revoke_session', {}, 'bank:revoke', 'bank-revoke+jwt');
  const url = new URL('/internal/revoke', record.policy.bankServerUrl);
  const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${record.policy.bankServiceToken}` },
    body: JSON.stringify({ assertion }) });
  if (!response.ok) throw new BankingError('bank_revocation_pending', 503);
}
