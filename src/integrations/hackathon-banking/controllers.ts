import { runWithWorkspace } from '@/utils/workspace';
import { loadConversationStateReadOnly } from '@/backend/execution/flow/loadConversationState';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { markConversationDeleted } from '@/backend/execution/flow/cancellation';
import type { SharedState } from '@/backend/execution/flow/types';
import { authenticateBankingRequest, bankingAdmission,
  assertBankingPrincipalCurrent, revokeBankingSession, type BankingPrincipal } from './authority';
import { BankingError, bankingErrorResponse } from './errors';
import { runWithExecutionConversationAccess } from '@/backend/execution/extensions';
import { assertUnlocked } from '@/utils/encryption/lockGate';

const noCache = { 'Cache-Control': 'no-store, private', Pragma: 'no-cache', Vary: 'Authorization, X-Flujo-User-Assertion' };
interface ActiveRun { controller: AbortController; session: string }
const registry = globalThis as typeof globalThis & { __flujoBankingActive?: Map<string, ActiveRun>; __flujoBankingStreams?: Map<string, number> };
const activeRuns = registry.__flujoBankingActive ??= new Map();
const streams = registry.__flujoBankingStreams ??= new Map();

/** Shared registry for ordinary completion admission and owner controls. */
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

function publicState(id: string, state: SharedState | undefined) {
  const messages = (state?.messages ?? []).filter(message => ['user', 'assistant'].includes(message.role)
    && typeof message.content === 'string' && message.content)
    .slice(-100).map(message => ({ role: message.role, content: String(message.content).slice(0, 32768) }));
  while (messages.length && Buffer.byteLength(JSON.stringify(messages)) > 60000) messages.shift();
  return { conversation_id: id, status: state?.status ?? 'pending', messages };
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
