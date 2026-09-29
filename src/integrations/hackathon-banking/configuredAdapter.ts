import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { runWithWorkspace } from '@/utils/workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { flowService } from '@/backend/services/flow';
import { createFlowExecutionSnapshot } from '@/backend/services/flow/executionSnapshot';
import { loadConversationStateReadOnly } from '@/backend/execution/flow/loadConversationState';
import { withWorkspaceMutation } from '@/backend/services/workspace/workspaceMutationGate';
import { createExecutionExtensionContext, runWithExecutionInput, ExecutionExtensionError,
  type ExecutionExtensionAdapter } from '@/backend/execution/extensions';
import { authenticateBankingRequest, bankingAdmission, createBankingRunContext,
  assertBankingRunCurrent, bankingRunPolicy, bindBankingRun, bankingRunSignal,
  commitBankingMutation, authorizeBankingHandoffs, assertBankingModelTool,
  assertBankingToolDispatch, validateBankingArguments, signBankingCall,
  assertBankingServerConfig, BANK_ASSERTION_META, type BankingRunContext } from './authority';
import { getBankingPolicy, requireBankingPolicy, assertBankingExecutionBearer, isBankingRoute } from './policy';
import { BankingStore, conversationPattern } from './store';
import { assertBankingGraph } from './graph';
import { withBankingAdmission } from './admission';
import { BankingError, bankingErrorResponse } from './errors';
import { validateBankingResult } from './protocol';
import type { SharedState } from '@/backend/execution/flow/types';
import { bankingConversation, bankingCancel, bankingEvents, registerBankingActiveRun } from './controllers';

// This module is selected explicitly by a trusted build alias. Its policy and
// private keys never come from an HTTP DTO, saved graph or MCP server preset.
const metadataSchema = z.object({ flujo: z.literal('true').optional(), appendMessages: z.literal('true').optional(),
  compactToolPayloads: z.literal('true').optional(), conversationId: z.string().regex(conversationPattern).optional() }).strict();
const requestSchema = z.object({ model: z.string().min(1).max(256),
  messages: z.tuple([z.object({ role: z.literal('user'), content: z.string().trim().min(1).max(4096) }).strict()]),
  metadata: metadataSchema.optional(), stream: z.literal(false).optional() }).strict();
const normalConversation = /^\/v1\/chat\/conversations\/([a-f0-9-]{36})(?:\/(.*))?$/;
const noCache = { 'Cache-Control': 'no-store, private', Pragma: 'no-cache', Vary: 'Authorization, X-Flujo-User-Assertion' };

function extensionError(error: unknown): never {
  if (error instanceof BankingError) throw new ExecutionExtensionError(error.code, error.status);
  throw new ExecutionExtensionError('banking_unavailable', 503);
}
function synchronous<T>(task: () => T): T { try { return task(); } catch (error) { return extensionError(error); } }
async function asynchronous<T>(task: () => Promise<T>): Promise<T> { try { return await task(); } catch (error) { return extensionError(error); } }

function usesBankingCredential(request: Request): boolean {
  if (request.headers.has('x-flujo-user-assertion')) return true;
  const policy = getBankingPolicy();
  if (!policy) return false;
  try { assertBankingExecutionBearer(request, policy); return true; } catch { return false; }
}

function allowedBoundRoute(request: Request): boolean {
  const path = new URL(request.url).pathname;
  if (path === '/v1/chat/completions') return request.method === 'POST';
  if (path === '/v1/banking/session/revoke') return request.method === 'POST';
  const match = normalConversation.exec(path);
  return Boolean(match && ((!match[2] && ['GET', 'DELETE'].includes(request.method))
    || (match[2] === 'events' && request.method === 'GET')
    || (match[2] === 'cancel' && request.method === 'POST')));
}

async function readCompletion(request: Request) {
  if (!request.body || !(request.headers.get('content-type') ?? '').startsWith('application/json')) {
    throw new BankingError('invalid_banking_request', 400);
  }
  // The admitted request is rebuilt below. Consume this body directly so a
  // rejected oversized stream does not leave an unread tee branch hanging.
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 16384) { await reader.cancel(); throw new BankingError('banking_request_too_large', 413); }
      chunks.push(part.value);
    }
    return requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch (error) {
    if (error instanceof BankingError) throw error;
    throw new BankingError('invalid_banking_request', 400);
  } finally { reader.releaseLock(); }
}

async function ordinaryCompletion(request: Request, task: (request: Request) => Promise<Response>): Promise<Response> {
  // Authenticate and consume the fresh ingress assertion before parsing/logging
  // user messages or touching workspace, graph, history or provider sessions.
  const principal = await authenticateBankingRequest(request);
  const parsed = await readCompletion(request);
  const { policy, identity, store } = bankingAdmission(principal);
  const existingId = parsed.metadata?.conversationId;
  if (existingId) await store.assertOwner(existingId, identity);
  return runWithWorkspace(policy.workspace, async () => {
    const locked = await assertUnlocked({ openai: true });
    if (locked) return locked;
    return withBankingAdmission(principal, async () => {
      await store.assertSession(identity);
      const flow = await flowService.getFlow(policy.flowId);
      if (!flow) throw new BankingError('approved_banking_graph_unavailable', 503);
      const snapshot = createFlowExecutionSnapshot(policy.workspace, flow);
      assertBankingGraph(snapshot.flow, policy);
      if (parsed.model !== 'flow-' + flow.name) throw new BankingError('approved_banking_graph_required');
      const id = existingId ?? randomUUID();
      if (!existingId) {
        // Never adopt an old operator transcript or native provider session.
        if (await loadConversationStateReadOnly(id)) throw new BankingError('conversation_unavailable', 404);
        await store.createConversation(id, identity);
      }
      return store.withLock('turn:' + id, async () => {
        await store.assertOwner(id, identity);
        const controller = new AbortController();
        const abort = () => controller.abort(new BankingError('banking_run_cancelled', 409));
        request.signal.addEventListener('abort', abort, { once: true });
        if (request.signal.aborted) abort();
        const timeout = setTimeout(abort, Math.max(1, Math.min(policy.maxRunSeconds * 1000,
          identity.expires * 1000 - Date.now())));
        const release = registerBankingActiveRun(principal, id, controller);
        try {
          const rawContext = await createBankingRunContext(principal, id, controller.signal);
          const context = createExecutionExtensionContext(configuredExecutionAdapter, rawContext);
          const url = new URL(request.url);
          url.searchParams.set('workspace', policy.workspace);
          const headers = new Headers(request.headers);
          headers.delete('x-flujo-user-assertion');
          const admitted = new NextRequest(url, { method: 'POST', headers, signal: controller.signal,
            body: JSON.stringify({ model: parsed.model, messages: parsed.messages,
              metadata: { flujo: 'true', appendMessages: 'true', conversationId: id } }) });
          const response = await runWithExecutionInput({ modelName: undefined, flowDefinition: snapshot.flow,
            conversationId: id, runId: randomUUID(), source: 'api', resumeAsNewTurn: true, userTurn: true,
            flujo: true, debug: false, requireApproval: false, onApprovalRequired: 'fail',
            abortSignal: controller.signal, executionExtensionContext: context },
          () => withWorkspaceMutation(() => task(admitted)));
          await assertBankingRunCurrent(rawContext, { conversationId: id });
          // Synchronous profile: completion response is assembled before the
          // authority check; tasks, streaming and approvals are not admitted.
          for (const [name, value] of Object.entries(noCache)) response.headers.set(name, value);
          return response;
        } finally {
          clearTimeout(timeout); release(); request.signal.removeEventListener('abort', abort);
        }
      });
    });
  });
}

export const configuredExecutionAdapter: ExecutionExtensionAdapter = {
  authorizeTransport(request) {
    try {
      requireBankingPolicy();
      const path = new URL(request.url).pathname;
      // Session revocation is the only specialized route. Retired ingress and
      // controls must never fall through to ordinary transport admission.
      if (path.startsWith('/v1/banking')) {
        if (!isBankingRoute(path) || request.method !== 'POST') return Response.json({ error: 'not_found' }, { status: 404 });
        assertBankingExecutionBearer(request); return null;
      }
      if (!usesBankingCredential(request)) return undefined;
      if (!allowedBoundRoute(request)) throw new BankingError('banking_control_forbidden');
      assertBankingExecutionBearer(request); return null;
    } catch (error) { return bankingErrorResponse(error); }
  },
  async withRoute(request, task) {
    try {
      requireBankingPolicy();
      const path = new URL(request.url).pathname;
      if (path.startsWith('/v1/banking')) {
        if (!isBankingRoute(path) || request.method !== 'POST') return Response.json({ error: 'not_found' }, { status: 404 });
        return task(request);
      }
      if (usesBankingCredential(request)) {
        if (!allowedBoundRoute(request)) throw new BankingError('banking_control_forbidden');
        if (path === '/v1/chat/completions') return await ordinaryCompletion(request, task);
        const match = normalConversation.exec(path)!;
        // These adapters expose only user/assistant text and status, and check
        // ownership before state/control access. Do not invoke raw state routes.
        if (match[2] === 'events') return bankingEvents(request, match[1]);
        if (match[2] === 'cancel') return bankingCancel(request, match[1]);
        return bankingConversation(request, match[1], request.method === 'DELETE');
      }
      const match = normalConversation.exec(path);
      if (match) await configuredExecutionAdapter.assertConversationAccess!(match[1]);
      return task(request);
    } catch (error) { return bankingErrorResponse(error); }
  },
  isProtectedServer(server) { return synchronous(() => requireBankingPolicy().bankServerName === server); },
  assertServerConfig(config) { synchronous(() => { if (requireBankingPolicy().bankServerName === config.name) assertBankingServerConfig(config); }); },
  assertRun(context, expected) { return asynchronous(() => assertBankingRunCurrent(context as BankingRunContext, expected)); },
  async assertConversationAccess(id) {
    const policy = synchronous(requireBankingPolicy);
    if (await new BankingStore(policy).isOwned(id)) throw new ExecutionExtensionError('trusted_execution_context_required');
  },
  async exposeConversationInList(id) {
    const policy = synchronous(requireBankingPolicy);
    return !await new BankingStore(policy).isOwned(id);
  },
  isProtectedState(state) {
    const value = state as { bankingOwned?: boolean; executionExtensionOwned?: boolean } | undefined;
    return Boolean(value?.bankingOwned || value?.executionExtensionOwned);
  },
  async validateRun(input, context) {
    return asynchronous(async () => {
      if (!input.conversationId || !input.flowDefinition || input.parentRunId || input.depth
        || input.debug || input.requireApproval || input.mode === 'ephemeral') throw new BankingError('banking_run_context_mismatch');
      await assertBankingRunCurrent(context as BankingRunContext, { conversationId: input.conversationId });
      assertBankingGraph(input.flowDefinition, bankingRunPolicy(context as BankingRunContext));
    });
  },
  validateLoadedState(context, state) {
    return asynchronous(async () => {
      const rawContext = context as BankingRunContext;
      const value = state as Partial<SharedState> & { bankingOwned?: boolean };
      if (!value || typeof value !== 'object' || typeof value.conversationId !== 'string'
        || !conversationPattern.test(value.conversationId) || !(value.executionExtensionOwned || value.bankingOwned)) {
        throw new BankingError('banking_run_context_mismatch');
      }
      await assertBankingRunCurrent(rawContext, { conversationId: value.conversationId });
      const policy = bankingRunPolicy(rawContext);
      if (value.flowId !== policy.flowId || !value.flowSnapshot) throw new BankingError('approved_banking_graph_required');
      assertBankingGraph(value.flowSnapshot, policy);
    });
  },
  bindRun(context, conversation, run) { return asynchronous(() => bindBankingRun(context as BankingRunContext, conversation, run)); },
  signal(context) { return synchronous(() => bankingRunSignal(context as BankingRunContext)); },
  commit(context, task) { return asynchronous(() => commitBankingMutation(context as BankingRunContext, task)); },
  protectedServer(context) { return synchronous(() => bankingRunPolicy(context as BankingRunContext).bankServerName); },
  authorizeHandoffs(context, names) { synchronous(() => authorizeBankingHandoffs(context as BankingRunContext, names)); },
  assertModelTool(context, name, advertised) { return asynchronous(() => assertBankingModelTool(context as BankingRunContext, name, advertised)); },
  assertDispatch(context, server, source) { return asynchronous(() => assertBankingToolDispatch(context as BankingRunContext | undefined, server, source)); },
  normalizeArguments(_context, tool, args) { return synchronous(() => validateBankingArguments(tool, args)); },
  requestMeta(context, server, tool, args) { return asynchronous(async () => ({ [BANK_ASSERTION_META]: await signBankingCall(context as BankingRunContext, server, tool, args) })); },
  validateResult(_context, tool, result) { return synchronous(() => validateBankingResult(tool, result)); },
  codexProfile(context) {
    return asynchronous(async () => {
      await assertBankingRunCurrent(context as BankingRunContext);
      return bankingRunPolicy(context as BankingRunContext).restrictedCodex;
    });
  },
};
