import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { runWithWorkspace } from '@/utils/workspace';
import { withWorkspaceMutation } from '@/backend/services/workspace/workspaceMutationGate';
import { flowService } from '@/backend/services/flow';
import { createFlowExecutionSnapshot } from '@/backend/services/flow/executionSnapshot';
import { runFlow } from '@/backend/execution/flow/runFlow';
import { loadConversationStateReadOnly } from '@/backend/execution/flow/loadConversationState';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { markConversationDeleted } from '@/backend/execution/flow/cancellation';
import type { SharedState } from '@/backend/execution/flow/types';
import { authenticateBankingRequest, bankingAdmission, createBankingRunContext,
  assertBankingRunCurrent, assertBankingPrincipalCurrent, revokeBankingSession, type BankingPrincipal } from './authority';
import { conversationPattern } from './store';
import { assertBankingGraph } from './graph';
import { withBankingAdmission } from './admission';
import { BankingError, bankingErrorResponse } from './errors';
import { createExecutionExtensionContext, runWithExecutionConversationAccess, runWithExecutionInput } from '@/backend/execution/extensions';
import { configuredExecutionAdapter } from './configuredAdapter';
import { assertUnlocked } from '@/utils/encryption/lockGate';

const noCache = { 'Cache-Control': 'no-store, private', Pragma: 'no-cache', Vary: 'Authorization, X-Flujo-User-Assertion' };
const chatSchema = z.object({ message: z.string().trim().min(1).max(4096),
  conversation_id: z.string().regex(conversationPattern).optional() }).strict();
interface ActiveRun { controller: AbortController; session: string }
const registry = globalThis as typeof globalThis & { __flujoBankingActive?: Map<string, ActiveRun>; __flujoBankingStreams?: Map<string, number> };
const activeRuns = registry.__flujoBankingActive ??= new Map();
const streams = registry.__flujoBankingStreams ??= new Map();

/** Same registry for ordinary completion admission and the legacy controls. */
export function registerBankingActiveRun(principal: BankingPrincipal, id: string, controller: AbortController): () => void {
  const runKey = key(principal, id);
  activeRuns.set(runKey, { controller, session: bankingAdmission(principal).identity.session });
  return () => { if (activeRuns.get(runKey)?.controller === controller) activeRuns.delete(runKey); };
}

function key(principal: BankingPrincipal, id: string): string {
  const { policy } = bankingAdmission(principal);
  return JSON.stringify([policy.deploymentId, policy.workspace, id]);
}

function readOwnedState(principal: BankingPrincipal, id: string) {
  const { policy, store, identity } = bankingAdmission(principal);
  return runWithWorkspace(policy.workspace, () => runWithExecutionConversationAccess(id, async () => {
    await assertBankingPrincipalCurrent(principal);
    await store.assertOwner(id, identity);
  }, () => loadConversationStateReadOnly(id)));
}

async function body(request: Request): Promise<unknown> {
  if (!request.body || !(request.headers.get('content-type') ?? '').startsWith('application/json')) {
    throw new BankingError('invalid_banking_request', 400);
  }
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
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof BankingError) throw error;
    throw new BankingError('invalid_banking_request', 400);
  } finally { reader.releaseLock(); }
}

function publicState(id: string, state: SharedState | undefined) {
  const messages = (state?.messages ?? []).filter(message => ['user', 'assistant'].includes(message.role)
    && typeof message.content === 'string' && message.content)
    .slice(-100).map(message => ({ role: message.role, content: String(message.content).slice(0, 32768) }));
  while (messages.length && Buffer.byteLength(JSON.stringify(messages)) > 60000) messages.shift();
  return { conversation_id: id, status: state?.status ?? 'pending', messages };
}

export async function bankingChat(request: Request): Promise<Response> {
  try {
    const principal = await authenticateBankingRequest(request);
    const { policy, identity, store } = bankingAdmission(principal);
    const locked = await runWithWorkspace(policy.workspace, () => assertUnlocked({ openai: true }));
    if (locked) return locked;
    const parsed = chatSchema.safeParse(await body(request));
    if (!parsed.success) throw new BankingError('invalid_banking_request', 400);
    if (parsed.data.conversation_id) await store.assertOwner(parsed.data.conversation_id, identity);
    return await runWithWorkspace(policy.workspace, () => withBankingAdmission(principal, async () => {
      await store.assertSession(identity);
      const flow = await flowService.getFlow(policy.flowId);
      if (!flow) throw new BankingError('approved_banking_graph_unavailable', 503);
      const snapshot = createFlowExecutionSnapshot(policy.workspace, flow);
      assertBankingGraph(snapshot.flow, policy);
      const id = parsed.data.conversation_id ?? randomUUID();
      if (!parsed.data.conversation_id) {
        // Never bind/adopt a legacy conversation, even in a generated-ID collision.
        if (await loadConversationStateReadOnly(id)) throw new BankingError('conversation_unavailable', 404);
        await store.createConversation(id, identity);
      }
      return store.withLock('turn:' + id, async () => {
        await store.assertOwner(id, identity);
        const controller = new AbortController();
        const relayAbort = () => controller.abort(new BankingError('banking_run_cancelled', 409));
        request.signal.addEventListener('abort', relayAbort, { once: true });
        if (request.signal.aborted) relayAbort();
        const timeout = setTimeout(relayAbort, Math.max(1, Math.min(policy.maxRunSeconds * 1000,
          identity.expires * 1000 - Date.now())));
        const runKey = key(principal, id);
        activeRuns.set(runKey, { controller, session: identity.session });
        try {
          const context = await createBankingRunContext(principal, id, controller.signal);
          // History, graph, providers, tool policy, routing and run identity are server-owned.
          // Admit the complete turn once. Nested storage writes reuse this workspace
          // admission, while banking authority still fences each individual commit.
          const genericContext = createExecutionExtensionContext(configuredExecutionAdapter, context);
          const result = await runWithExecutionInput({ conversationId: id, executionExtensionContext: genericContext },
          () => withWorkspaceMutation(() => runFlow({ source: 'api', conversationId: id, flowDefinition: snapshot.flow,
            runId: randomUUID(), prompt: parsed.data.message, resumeAsNewTurn: true,
            userTurn: true, flujo: true, debug: false, requireApproval: false,
            onApprovalRequired: 'fail', abortSignal: controller.signal,
            executionExtensionContext: genericContext })));
          await assertBankingRunCurrent(context, { conversationId: id, runId: result.runId });
          if (result.error || !['completed', 'waiting_for_input'].includes(result.status)) {
            throw new BankingError('banking_run_failed', 502);
          }
          return Response.json({ conversation_id: id, status: result.status, message: result.outputText.slice(0, 60000) },
            { headers: noCache });
        } finally {
          clearTimeout(timeout);
          request.signal.removeEventListener('abort', relayAbort);
          if (activeRuns.get(runKey)?.controller === controller) activeRuns.delete(runKey);
        }
      });
    }));
  } catch (error) { return bankingErrorResponse(error); }
}

export async function bankingConversation(request: Request, id: string, remove = false): Promise<Response> {
  try {
    const principal = await authenticateBankingRequest(request);
    const { policy, store, identity } = bankingAdmission(principal);
    await store.assertOwner(id, identity); // Before state, media, controls or registries.
    return await runWithWorkspace(policy.workspace, async () => {
      const locked = await assertUnlocked({ openai: true });
      if (locked) return locked;
      if (remove) {
        await store.tombstone(id, identity);
        activeRuns.get(key(principal, id))?.controller.abort();
        markConversationDeleted(id);
        FlowExecutor.conversationStates.delete(id);
        return new Response(null, { status: 204, headers: noCache });
      }
      const state = await readOwnedState(principal, id);
      await assertBankingPrincipalCurrent(principal);
      await store.assertOwner(id, identity);
      return Response.json(publicState(id, state), { headers: noCache });
    });
  } catch (error) { return bankingErrorResponse(error); }
}

export async function bankingCancel(request: Request, id: string): Promise<Response> {
  try {
    const principal = await authenticateBankingRequest(request);
    const { store, identity, policy } = bankingAdmission(principal);
    await store.assertOwner(id, identity);
    const locked = await runWithWorkspace(policy.workspace, () => assertUnlocked({ openai: true }));
    if (locked) return locked;
    const active = activeRuns.get(key(principal, id));
    active?.controller.abort(new BankingError('banking_run_cancelled', 409));
    return Response.json({ cancelled: Boolean(active) }, { headers: noCache });
  } catch (error) { return bankingErrorResponse(error); }
}

export async function bankingRevoke(request: Request): Promise<Response> {
  try {
    const principal = await authenticateBankingRequest(request, true);
    const { identity, policy } = bankingAdmission(principal);
    const locked = await runWithWorkspace(policy.workspace, () => assertUnlocked({ openai: true }));
    if (locked) return locked;
    for (const [runKey, active] of activeRuns) {
      if (runKey.startsWith(JSON.stringify([policy.deploymentId, policy.workspace]).slice(0, -1))
        && active.session === identity.session) active.controller.abort();
    }
    await revokeBankingSession(principal);
    return Response.json({ revoked: true }, { headers: noCache });
  } catch (error) { return bankingErrorResponse(error); }
}

export async function bankingEvents(request: Request, id: string): Promise<Response> {
  try {
    const principal = await authenticateBankingRequest(request);
    const { policy, identity, store } = bankingAdmission(principal);
    await store.assertOwner(id, identity);
    const locked = await runWithWorkspace(policy.workspace, () => assertUnlocked({ openai: true }));
    if (locked) return locked;
    const deploymentKey = JSON.stringify([policy.deploymentId, policy.workspace]);
    const subjectKey = deploymentKey + JSON.stringify([identity.issuer, identity.subject]);
    if ((streams.get(deploymentKey) ?? 0) >= 512 || (streams.get(subjectKey) ?? 0) >= 2) {
      throw new BankingError('banking_busy', 429);
    }
    streams.set(deploymentKey, (streams.get(deploymentKey) ?? 0) + 1);
    streams.set(subjectKey, (streams.get(subjectKey) ?? 0) + 1);
    let closed = false;
    let detachAbort: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const release = () => {
      if (closed) return;
      closed = true;
      detachAbort?.();
      clearTimeout(timer);
      for (const slot of [deploymentKey, subjectKey]) {
        const count = (streams.get(slot) ?? 1) - 1;
        if (count) streams.set(slot, count); else streams.delete(slot);
      }
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let last = '';
        const close = () => { release(); try { controller.close(); } catch { /* already closed */ } };
        const tick = async () => {
          if (closed) return;
          try {
            await assertBankingPrincipalCurrent(principal);
            await store.assertOwner(id, identity);
            const state = await readOwnedState(principal, id);
            await assertBankingPrincipalCurrent(principal);
            await store.assertOwner(id, identity);
            const value = JSON.stringify(publicState(id, state));
            if (value !== last && (controller.desiredSize ?? 0) > 0) {
              controller.enqueue(new TextEncoder().encode('event: state\ndata: ' + value + '\n\n'));
              last = value;
            }
            if (state?.status === 'completed' || state?.status === 'error' || request.signal.aborted) close();
            else timer = setTimeout(tick, 750);
          } catch { close(); }
        };
        request.signal.addEventListener('abort', close, { once: true });
        detachAbort = () => request.signal.removeEventListener('abort', close);
        void tick();
      },
      cancel() { release(); },
    }, { highWaterMark: 1 });
    return new Response(stream, { headers: { ...noCache, 'Content-Type': 'text/event-stream',
      'X-Accel-Buffering': 'no', 'Connection': 'keep-alive' } });
  } catch (error) { return bankingErrorResponse(error); }
}
