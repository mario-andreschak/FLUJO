import { createNativeTurns } from '@/vendor/avatar/server/native-turns.mjs';
import { streamNativeTurn, validateNativeTurn } from '@/vendor/avatar/server/openrouter-native.mjs';
import { transcribe, validateTranscription } from '@/vendor/avatar/server/transcription.mjs';
import { PublicError } from '@/vendor/avatar/server/support.mjs';
import { createHash } from 'node:crypto';
import { assertExecutionConversationAccess, assertExecutionStateAccess } from '@/backend/execution/extensions';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { recoverConversationTranscript } from '@/backend/execution/flow/conversationLog';
import type { SharedState } from '@/backend/execution/flow/types';
import { loadItem } from '@/utils/storage/backend';
import type { StorageKey } from '@/shared/types/storage';
import { getCurrentWorkspace } from '@/utils/workspace';
import { modelService } from '@/backend/services/model';
import { discoverAvatarConnections } from './connectionDiscovery';
import { readAvatarWorkModel } from './workModel';

const CLIENT = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;
type Ledger = ReturnType<typeof createNativeTurns>;
/** Constructed only by the authenticated server ingress, never request metadata. */
export interface TrustedAvatarVoiceContext {
  readonly workspace: string;
  readonly scopeKey: string;
  readonly revokeSignal: AbortSignal;
  readonly recheck: () => Promise<void>;
}
interface ResultProvenance { conversationId: string; messageId: string; digest: string; expires: number }
interface Session {
  ledger: Ledger; touched: number; calls: number[]; active: number; results: Set<string>;
  receipts: Map<string, ResultProvenance>; epoch: number; scope: string | null;
  controllers: Set<AbortController>; revokeListeners: Map<AbortSignal, () => void>;
}
const sessions = new Map<string, Session>();
const config = () => ({ openrouterKey: process.env.FLUJO_AVATAR_OPENROUTER_KEY || process.env.OPENROUTER_API_KEY || '', openrouterSttModel: 'openai/whisper-large-v3' });
export function avatarVoiceAvailable() { return Boolean(config().openrouterKey); }

const interrupted = () => new PublicError(499, 'voice_interrupted', 'Voice stopped.');
const revoked = () => new PublicError(403, 'voice_access_revoked', 'Voice session ended.');
const resultDigest = (result: unknown) => createHash('sha256').update(JSON.stringify(result)).digest('hex');
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void pending.catch(() => {}); return Promise.reject(signal.reason ?? interrupted()); }
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason ?? interrupted()); };
    signal.addEventListener('abort', abort, { once: true });
    pending.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
function resetSession(session: Session, except?: AbortController, reason: unknown = interrupted()) {
  session.epoch++; session.results.clear(); session.receipts.clear();
  for (const controller of session.controllers) if (controller !== except) controller.abort(reason);
  session.ledger.reset();
}
function removeSession(owner: string, session: Session, reason: unknown = interrupted()) {
  resetSession(session, undefined, reason);
  for (const [signal, listener] of session.revokeListeners) signal.removeEventListener('abort', listener);
  session.revokeListeners.clear();
  if (sessions.get(owner) === session) sessions.delete(owner);
}
function revokeScope(scope: string) {
  for (const [owner, session] of sessions) if (session.scope === scope) removeSession(owner, session, revoked());
}
function sessionFor(request: Request, trusted?: TrustedAvatarVoiceContext) {
  const client = request.headers.get('x-flujo-avatar-client');
  if (!client || !CLIENT.test(client)) throw new PublicError(400, 'invalid_voice_request', 'Start a voice session.');
  const scope = trusted ? JSON.stringify([trusted.workspace, trusted.scopeKey]) : null;
  const owner = JSON.stringify([scope ? 'authenticated' : 'local', getCurrentWorkspace(), scope, client]), now = Date.now();
  for (const [key, session] of sessions) if (now - session.touched > 30 * 60_000) removeSession(key, session);
  let session = sessions.get(owner);
  if (!session) {
    if (sessions.size >= 128) throw new PublicError(429, 'rate_limited', 'Voice is busy. Try again shortly.');
    session = { ledger: createNativeTurns(), touched: now, calls: [], active: 0, results: new Set(), receipts: new Map(), epoch: 0, scope, controllers: new Set(), revokeListeners: new Map() };
    session.ledger.bind(owner); sessions.set(owner, session);
  }
  session.touched = now; session.calls = session.calls.filter(call => now - call < 60_000);
  for (const [id, provenance] of session.receipts) if (provenance.expires <= now) session.receipts.delete(id);
  if (trusted && scope && !session.revokeListeners.has(trusted.revokeSignal)) {
    // Active calls retain their own revocation listeners. Keep only the latest
    // idle lifetime listener so new ingress contexts cannot grow this map.
    for (const [signal, listener] of session.revokeListeners) signal.removeEventListener('abort', listener);
    session.revokeListeners.clear();
    const listener = () => revokeScope(scope);
    session.revokeListeners.set(trusted.revokeSignal, listener);
    trusted.revokeSignal.addEventListener('abort', listener, { once: true });
  }
  return { owner, session };
}

async function boundedBody(request: Request, signal: AbortSignal) {
  const maximum = 12 * 1024 * 1024;
  if (Number(request.headers.get('content-length')) > maximum) throw new PublicError(413, 'body_too_large', 'The recording is too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new PublicError(400, 'invalid_voice_request', 'Send a voice request.');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal); if (done) break;
      size += value.length; if (size > maximum) throw new PublicError(413, 'body_too_large', 'The recording is too large.');
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; }
    catch { throw new PublicError(400, 'invalid_voice_request', 'Send a valid voice request.'); }
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Narration receives only a terminal, root-level public Chat reply. It cannot
 * accept browser-supplied results, tool arguments or claims of success. */
export async function canonicalVoiceResult(conversationId: string, messageId: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(conversationId) || !/^[A-Za-z0-9_-]{1,128}$/.test(messageId)) throw new PublicError(400, 'invalid_voice_request', 'Choose a recorded result.');
  await assertExecutionConversationAccess(conversationId);
  const state = FlowExecutor.conversationStates.get(conversationId)
    ?? await loadItem<SharedState | undefined>(`conversations/${conversationId}` as StorageKey, undefined);
  if (!state || state.conversationId !== conversationId) throw new PublicError(404, 'result_unavailable', 'The result is unavailable.');
  await assertExecutionStateAccess(state, conversationId);
  if (!['completed', 'awaiting_tool_approval', 'paused_debug', 'capped', 'error'].includes(state.status ?? '')) throw new PublicError(409, 'result_not_ready', 'Work is still in progress.');
  const { messages } = await recoverConversationTranscript(state);
  await assertExecutionConversationAccess(conversationId);
  await assertExecutionStateAccess(state, conversationId);
  const visible = messages.filter(message => !message.disabled && !message.depth && ['user', 'assistant'].includes(message.role));
  const latest = visible.at(-1);
  if (latest?.id !== messageId || latest.role !== 'assistant') throw new PublicError(409, 'result_not_current', 'That reply is no longer current.');
  const content = typeof latest.content === 'string' ? latest.content : Array.isArray(latest.content) ? latest.content.flatMap(part => 'text' in part ? [part.text] : []).join('\n') : '';
  const reply = content.replace(/<flujo-ui-actions>[\s\S]*?<\/flujo-ui-actions>/g, '').trim().slice(0, 8000);
  if (!reply) throw new PublicError(409, 'result_unavailable', 'There is no public reply to speak.');
  return { reply, mode: 'flujo', status: state.status === 'awaiting_tool_approval' || state.status === 'paused_debug' ? 'waiting_for_input' : 'completed' };
}

export async function handleAvatarVoice(request: Request, action: string): Promise<Response> {
  return handleVoice(request, action);
}
export async function handleAuthenticatedAvatarVoice(request: Request, action: string, trusted: TrustedAvatarVoiceContext): Promise<Response> {
  return handleVoice(request, action, trusted);
}
async function handleVoice(request: Request, action: string, trusted?: TrustedAvatarVoiceContext): Promise<Response> {
  if (!['native-turn', 'native-input', 'native-observe', 'native-played', 'native-reset', 'native-result', 'native-result-receipt'].includes(action)) return Response.json({ error: 'Unknown voice action.' }, { status: 404 });
  const owned = new AbortController();
  const abort = () => owned.abort(interrupted());
  const revoke = () => {
    if (trusted) revokeScope(JSON.stringify([trusted.workspace, trusted.scopeKey]));
    owned.abort(revoked());
  };
  request.signal.addEventListener('abort', abort, { once: true });
  trusted?.revokeSignal.addEventListener('abort', revoke, { once: true });
  if (request.signal.aborted) abort();
  if (trusted?.revokeSignal.aborted) revoke();
  let session: Session | undefined, epoch = 0, active = false, streaming = false, released = false;
  const release = () => {
    if (released) return; released = true;
    if (session) { session.controllers.delete(owned); if (active) session.active--; }
    request.signal.removeEventListener('abort', abort); trusted?.revokeSignal.removeEventListener('abort', revoke);
  };
  const check = async () => {
    if (owned.signal.aborted) throw owned.signal.reason ?? interrupted();
    if (session && epoch !== session.epoch) throw interrupted();
    if (trusted) {
      try {
        if (trusted.workspace !== getCurrentWorkspace() || typeof trusted.scopeKey !== 'string' || !trusted.scopeKey || trusted.scopeKey.length > 256) throw revoked();
        await abortable(Promise.resolve().then(() => trusted.recheck()), owned.signal);
        if (trusted.workspace !== getCurrentWorkspace() || trusted.revokeSignal.aborted) throw revoked();
      } catch (error) {
        // A canceled caller/reset may win the await race while the shared
        // authenticated grant is still valid. Only an authority failure may
        // discard other clients' ledgers under that grant.
        if (!trusted.revokeSignal.aborted && owned.signal.aborted && error === owned.signal.reason) throw error;
        revoke(); throw error;
      }
    }
    if (owned.signal.aborted || session && epoch !== session.epoch) throw owned.signal.reason ?? interrupted();
  };
  let provenance: ResultProvenance | undefined;
  const checkResult = async () => {
    await check();
    if (provenance) {
      const result = await abortable(canonicalVoiceResult(provenance.conversationId, provenance.messageId), owned.signal);
      await check();
      if (provenance.expires <= Date.now() || resultDigest(result) !== provenance.digest) throw new PublicError(409, 'result_not_current', 'That reply is no longer current.');
    }
  };
  // Both provider headers and provider reads are scoped. Even a fetch double
  // ignoring AbortSignal cannot publish a late transcription or audio chunk.
  const scopedFetch: typeof fetch = async (input, init) => {
    await checkResult();
    const signal = init?.signal ? AbortSignal.any([owned.signal, init.signal]) : owned.signal;
    const pending = fetch(input, { ...init, signal });
    void pending.then(late => { if (signal.aborted) void late.body?.cancel().catch(() => {}); }).catch(() => {});
    const response = await abortable(pending, signal);
    try { await checkResult(); }
    catch (error) { void response.body?.cancel().catch(() => {}); throw error; }
    if (!response.body) return response;
    const reader = response.body.getReader();
    let dispose: () => void = () => {}, finished = false, canceling: Promise<void> | undefined;
    const releaseReader = () => { try { reader.releaseLock(); } catch { /* Cancellation settles outstanding reads before releasing. */ } };
    const cancelReader = () => canceling ??= reader.cancel().catch(() => {}).finally(releaseReader);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const stop = () => {
          if (finished) return;
          finished = true; dispose(); controller.error(signal.reason ?? interrupted()); void cancelReader();
        };
        signal.addEventListener('abort', stop, { once: true });
        dispose = () => signal.removeEventListener('abort', stop);
        if (signal.aborted) stop();
      },
      async pull(controller) {
        if (finished) return;
        try {
          await check(); if (finished) return;
          const next = await abortable(reader.read(), signal); await check(); if (finished) return;
          if (next.done) { finished = true; dispose(); controller.close(); releaseReader(); }
          else controller.enqueue(next.value);
        } catch (error) {
          if (finished) return;
          finished = true; dispose(); controller.error(error); void cancelReader();
        }
      },
      cancel() { finished = true; dispose(); return cancelReader(); },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  try {
    await check();
    const bound = sessionFor(request, trusted), owner = bound.owner; session = bound.session; epoch = session.epoch;
    const currentSession = session;
    session.controllers.add(owned);
    const body = await boundedBody(request, owned.signal); await check();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PublicError(400, 'invalid_voice_request', 'Send a valid voice request.');
    if (action === 'native-reset') {
      if (Object.keys(body).length) throw new PublicError(400, 'invalid_voice_request', 'Reset takes no options.');
      resetSession(session, owned); epoch = session.epoch; session.ledger.bind(owner);
      return Response.json({ accepted: true });
    }
    if (action === 'native-played') return Response.json(session.ledger.played(body));
    if (!avatarVoiceAvailable()) throw new PublicError(503, 'voice_unconfigured', 'Voice is unavailable. You can type and connect your work AI.');
    if (action === 'native-result-receipt') {
      if (Object.keys(body).some(key => !['conversationId', 'messageId', 'locale', 'expectedResultDigest'].includes(key)) || !['es', 'pt', 'en'].includes(String(body.locale))
        || (body.expectedResultDigest !== undefined && (typeof body.expectedResultDigest !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedResultDigest)))) throw new PublicError(400, 'invalid_voice_request', 'Choose a recorded result.');
      const resultKey = `${body.conversationId}:${body.messageId}`;
      if (session.results.has(resultKey)) throw new PublicError(409, 'result_already_offered', 'This result has already been offered.');
      const conversationId = String(body.conversationId), messageId = String(body.messageId);
      const result = await abortable(canonicalVoiceResult(conversationId, messageId), owned.signal); await check();
      const digest = resultDigest(result);
      if (body.expectedResultDigest !== undefined && body.expectedResultDigest !== digest) throw new PublicError(409, 'result_not_current', 'That reply is no longer current.');
      if (session.results.has(resultKey)) throw new PublicError(409, 'result_already_offered', 'This result has already been offered.');
      const taskId = session.ledger.receipt(result, owner);
      if (!taskId) throw new PublicError(409, 'result_unavailable', 'The result is unavailable.');
      session.results.add(resultKey); if (session.results.size > 64) session.results.delete(session.results.values().next().value!);
      session.receipts.set(taskId, { conversationId, messageId, digest, expires: Date.now() + 120_000 });
      while (session.receipts.size > 4) session.receipts.delete(session.receipts.keys().next().value!);
      return Response.json({ taskId });
    }
    if (session.active >= 3 || session.calls.length >= 20) throw new PublicError(429, 'rate_limited', 'Voice is busy. Try again shortly.');
    session.active++; active = true; session.calls.push(Date.now());
    if (action === 'native-input') {
      let started;
      const timer = setTimeout(abort, 45_000);
      try {
        const value = validateNativeTurn(body);
        if (!('audio' in value)) throw new PublicError(400, 'invalid_voice_request', 'Send a WAV recording.');
        started = session.ledger.begin(value, owner, owned);
        const turn = session.ledger.claimObserver({ audio: value.audio, format: 'wav', locale: value.locale, turnId: started.turn.id }, owned);
        const result = await abortable(transcribe({ audio: value.audio, format: 'wav', language: value.locale }, config(), scopedFetch, owned.signal), owned.signal); await check();
        if (!session.ledger.observed(turn, result.text)) throw new PublicError(409, 'native_turn_ended', 'This recording is no longer current.');
        return Response.json(result);
      } finally { if (started) session.ledger.finish(started.turn, null); clearTimeout(timer); release(); }
    }
    if (action === 'native-observe') {
      let turn;
      const timer = setTimeout(abort, 45_000);
      try {
        const value = validateTranscription({ audio: body.audio, format: body.format });
        turn = session.ledger.claimObserver(body, owned);
        const result = await abortable(transcribe({ ...value, language: body.locale }, config(), scopedFetch, owned.signal), owned.signal); await check();
        if (!session.ledger.observed(turn, result.text)) throw new PublicError(409, 'native_turn_ended', 'This recording is no longer current.');
        return Response.json(result);
      } finally { if (turn) session.ledger.observerFailed(turn); clearTimeout(timer); release(); }
    }
    try {
      if (action === 'native-result') {
        provenance = typeof body.taskId === 'string' ? session.receipts.get(body.taskId) : undefined;
        if (!provenance) throw new PublicError(409, 'native_turn_ended', 'This voice turn is no longer available.');
        await checkResult();
      }
      const result = action === 'native-result' ? session.ledger.consumeReceipt(body, owner) : undefined;
      if (result) session.receipts.delete(String(body.taskId));
      const value = result ? { message: 'Answer directly using the supplied reply. Give only the answer, without an introduction. Do not claim more than it states.', avatar: body.avatar, locale: body.locale } : validateNativeTurn(body);
      const models = await abortable(modelService.loadModels(), owned.signal); await check();
      const selected = await abortable(readAvatarWorkModel(models), owned.signal); await check();
      const discovery = !result && !selected?.ready ? await abortable(discoverAvatarConnections(models), owned.signal) : null; await checkResult();
      const setupFacts = JSON.stringify({ findAIButton: value.locale === 'pt' ? 'Encontrar minha IA' : value.locale === 'es' ? 'Encontrar mi IA' : 'Find my AI',
        checkedAt: Date.now(), workAI: selected?.ready ? { label: selected.label, model: models.find(model => model.id === selected.modelId)?.name, verified: true } : null,
        ...(discovery ? { options: discovery.candidates.filter(candidate => candidate.kind !== 'saved-model').map(candidate => ({ label: candidate.label, runtime: candidate.runtime, login: candidate.authentication, nextAction: candidate.nextAction })) } : {}),
        instruction: result ? 'Give the answer alone, in the fewest natural words. Omit every introduction.' : selected?.ready ? 'Work is handled by the selected Flujo AI. Do not recommend models or repeat setup confirmation.' : 'Use the visible Find my AI button. No work AI is connected yet. Do not recommend a particular model.' });
      const started = session.ledger.begin(value, owner, owned);
      let streamController!: TransformStreamDefaultController<Uint8Array>;
      const stream = new TransformStream<Uint8Array, Uint8Array>({ start(controller) { streamController = controller; } }), writer = stream.writable.getWriter(), encoder = new TextEncoder();
      let admitted = false;
      let admit!: () => void, reject!: (error: unknown) => void;
      const ready = new Promise<void>((resolve, fail) => { admit = resolve; reject = fail; });
      const stopStream = () => { const error = owned.signal.reason ?? interrupted(); streamController.error(error); reject(error); };
      owned.signal.addEventListener('abort', stopStream, { once: true });
      const emit = async (event: unknown) => {
        await checkResult();
        if (!admitted) { admitted = true; admit(); }
        try { await abortable(writer.write(encoder.encode(JSON.stringify(event) + '\n')), owned.signal); await check(); }
        catch (error) { owned.abort(); throw error; }
      };
      streaming = true;
      void streamNativeTurn(value, config(), scopedFetch, owned.signal, emit, { turnId: started.turn.id, history: result || selected?.ready ? [] : started.history, backendResult: result, setupFacts,
        onQualifiedResult: async (qualified: unknown) => { await checkResult(); currentSession.ledger.qualify(started.turn, qualified); } }).then(async outcome => {
        await checkResult(); currentSession.ledger.finish(started.turn, outcome); await writer.close().catch(() => {});
      }).catch(async error => {
        currentSession.ledger.finish(started.turn, null); reject(error); streamController.error(error); await writer.abort(error).catch(() => {});
      }).finally(() => { owned.signal.removeEventListener('abort', stopStream); release(); });
      await ready;
      return new Response(stream.readable, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } });
    } catch (error) { release(); throw error; }
  } catch (error) {
    // Recognition adapters may normalize cancellation into a provider error.
    // Authenticated denial retains precedence; a valid lifetime preserves the
    // original provider/local error instead of claiming a permission failure.
    let failure = error;
    if (trusted) {
      try {
        if (trusted.revokeSignal.aborted || trusted.workspace !== getCurrentWorkspace()) throw revoked();
        // Caller/reset cancellation is already decided. Do not wait again on
        // the same shared authority callback that the caller just interrupted.
        if (!owned.signal.aborted) await abortable(Promise.resolve().then(() => trusted.recheck()), owned.signal);
      } catch (denied) {
        if (!trusted.revokeSignal.aborted && owned.signal.aborted && denied === owned.signal.reason) failure = error;
        else { revoke(); failure = denied instanceof PublicError ? denied : revoked(); }
      }
    }
    const publicFailure = failure instanceof PublicError ? failure : null;
    return Response.json({ error: publicFailure ? publicFailure.message : 'Voice could not complete the request. You can type.', code: publicFailure ? publicFailure.code : 'voice_unavailable' }, { status: publicFailure ? publicFailure.status : 502 });
  } finally { if (!streaming) release(); }
}
