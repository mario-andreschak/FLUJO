import { createNativeTurns } from '@/vendor/avatar/server/native-turns.mjs';
import { streamNativeTurn, validateNativeTurn } from '@/vendor/avatar/server/openrouter-native.mjs';
import { transcribe, validateTranscription } from '@/vendor/avatar/server/transcription.mjs';
import { PublicError } from '@/vendor/avatar/server/support.mjs';
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
interface Session { ledger: Ledger; touched: number; calls: number[]; active: number; results: Set<string> }
const sessions = new Map<string, Session>();
const config = () => ({ openrouterKey: process.env.FLUJO_AVATAR_OPENROUTER_KEY || process.env.OPENROUTER_API_KEY || '', openrouterSttModel: 'openai/whisper-large-v3' });
export function avatarVoiceAvailable() { return Boolean(config().openrouterKey); }

function sessionFor(request: Request) {
  const client = request.headers.get('x-flujo-avatar-client');
  if (!client || !CLIENT.test(client)) throw new PublicError(400, 'invalid_voice_request', 'Start a voice session.');
  const owner = `${getCurrentWorkspace()}:${client}`, now = Date.now();
  for (const [key, session] of sessions) if (now - session.touched > 30 * 60_000) { session.ledger.reset(); sessions.delete(key); }
  let session = sessions.get(owner);
  if (!session) {
    if (sessions.size >= 128) throw new PublicError(429, 'rate_limited', 'Voice is busy. Try again shortly.');
    session = { ledger: createNativeTurns(), touched: now, calls: [], active: 0, results: new Set() };
    session.ledger.bind(owner); sessions.set(owner, session);
  }
  session.touched = now; session.calls = session.calls.filter(call => now - call < 60_000);
  return { owner, session };
}

async function boundedBody(request: Request) {
  const maximum = 12 * 1024 * 1024;
  if (Number(request.headers.get('content-length')) > maximum) throw new PublicError(413, 'body_too_large', 'The recording is too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new PublicError(400, 'invalid_voice_request', 'Send a voice request.');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > maximum) throw new PublicError(413, 'body_too_large', 'The recording is too large.');
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; }
    catch { throw new PublicError(400, 'invalid_voice_request', 'Send a valid voice request.'); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Narration receives only a terminal, root-level public Chat reply. It cannot
 * accept browser-supplied results, tool arguments or claims of success. */
export async function canonicalVoiceResult(conversationId: string, messageId: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(conversationId) || !/^[A-Za-z0-9_-]{1,128}$/.test(messageId)) throw new PublicError(400, 'invalid_voice_request', 'Choose a recorded result.');
  const state = FlowExecutor.conversationStates.get(conversationId)
    ?? await loadItem<SharedState | undefined>(`conversations/${conversationId}` as StorageKey, undefined);
  if (!state || state.conversationId !== conversationId) throw new PublicError(404, 'result_unavailable', 'The result is unavailable.');
  if (!['completed', 'awaiting_tool_approval', 'paused_debug', 'capped', 'error'].includes(state.status ?? '')) throw new PublicError(409, 'result_not_ready', 'Work is still in progress.');
  const { messages } = await recoverConversationTranscript(state);
  const visible = messages.filter(message => !message.disabled && !message.depth && ['user', 'assistant'].includes(message.role));
  const latest = visible.at(-1);
  if (latest?.id !== messageId || latest.role !== 'assistant') throw new PublicError(409, 'result_not_current', 'That reply is no longer current.');
  const content = typeof latest.content === 'string' ? latest.content : Array.isArray(latest.content) ? latest.content.flatMap(part => 'text' in part ? [part.text] : []).join('\n') : '';
  const reply = content.replace(/<flujo-ui-actions>[\s\S]*?<\/flujo-ui-actions>/g, '').trim().slice(0, 8000);
  if (!reply) throw new PublicError(409, 'result_unavailable', 'There is no public reply to speak.');
  return { reply, mode: 'flujo', status: state.status === 'awaiting_tool_approval' || state.status === 'paused_debug' ? 'waiting_for_input' : 'completed' };
}

export async function handleAvatarVoice(request: Request, action: string): Promise<Response> {
  if (!['native-turn', 'native-input', 'native-observe', 'native-played', 'native-reset', 'native-result', 'native-result-receipt'].includes(action)) return Response.json({ error: 'Unknown voice action.' }, { status: 404 });
  try {
    const { owner, session } = sessionFor(request), body = await boundedBody(request);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PublicError(400, 'invalid_voice_request', 'Send a valid voice request.');
    if (action === 'native-reset') {
      if (Object.keys(body).length) throw new PublicError(400, 'invalid_voice_request', 'Reset takes no options.');
      session.ledger.reset(); session.ledger.bind(owner); session.results.clear();
      return Response.json({ accepted: true });
    }
    if (action === 'native-played') return Response.json(session.ledger.played(body));
    if (!avatarVoiceAvailable()) throw new PublicError(503, 'voice_unconfigured', 'Voice is unavailable. You can type and connect your work AI.');
    if (action === 'native-result-receipt') {
      if (Object.keys(body).some(key => !['conversationId', 'messageId', 'locale'].includes(key)) || !['es', 'pt', 'en'].includes(String(body.locale))) throw new PublicError(400, 'invalid_voice_request', 'Choose a recorded result.');
      const resultKey = `${body.conversationId}:${body.messageId}`;
      if (session.results.has(resultKey)) throw new PublicError(409, 'result_already_offered', 'This result has already been offered.');
      const result = await canonicalVoiceResult(String(body.conversationId), String(body.messageId));
      const taskId = session.ledger.receipt(result, owner);
      if (!taskId) throw new PublicError(409, 'result_unavailable', 'The result is unavailable.');
      session.results.add(resultKey); if (session.results.size > 64) session.results.delete(session.results.values().next().value!);
      return Response.json({ taskId });
    }
    if (session.active >= 3 || session.calls.length >= 20) throw new PublicError(429, 'rate_limited', 'Voice is busy. Try again shortly.');
    session.active++; session.calls.push(Date.now());
    const owned = new AbortController();
    const abort = () => owned.abort(); request.signal.addEventListener('abort', abort, { once: true });
    let released = false;
    const release = () => { if (released) return; released = true; session.active--; request.signal.removeEventListener('abort', abort); };
    if (request.signal.aborted) owned.abort();
    if (action === 'native-input') {
      let started;
      const timer = setTimeout(abort, 45_000);
      try {
        const value = validateNativeTurn(body);
        if (!('audio' in value)) throw new PublicError(400, 'invalid_voice_request', 'Send a WAV recording.');
        started = session.ledger.begin(value, owner, owned);
        const turn = session.ledger.claimObserver({ audio: value.audio, format: 'wav', locale: value.locale, turnId: started.turn.id }, owned);
        const result = await transcribe({ audio: value.audio, format: 'wav', language: value.locale }, config(), fetch, owned.signal);
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
        const result = await transcribe({ ...value, language: body.locale }, config(), fetch, owned.signal);
        if (!session.ledger.observed(turn, result.text)) throw new PublicError(409, 'native_turn_ended', 'This recording is no longer current.');
        return Response.json(result);
      } finally { if (turn) session.ledger.observerFailed(turn); clearTimeout(timer); release(); }
    }
    try {
      const result = action === 'native-result' ? session.ledger.consumeReceipt(body, owner) : undefined;
      const value = result ? { message: 'Answer directly using the supplied reply. Give only the answer, without an introduction. Do not claim more than it states.', avatar: body.avatar, locale: body.locale } : validateNativeTurn(body);
      const models = await modelService.loadModels(), selected = await readAvatarWorkModel(models);
      const discovery = !result && !selected?.ready ? await discoverAvatarConnections(models) : null;
      const setupFacts = JSON.stringify({ findAIButton: value.locale === 'pt' ? 'Encontrar minha IA' : value.locale === 'es' ? 'Encontrar mi IA' : 'Find my AI',
        checkedAt: Date.now(), workAI: selected?.ready ? { label: selected.label, model: models.find(model => model.id === selected.modelId)?.name, verified: true } : null,
        ...(discovery ? { options: discovery.candidates.filter(candidate => candidate.kind !== 'saved-model').map(candidate => ({ label: candidate.label, runtime: candidate.runtime, login: candidate.authentication, nextAction: candidate.nextAction })) } : {}),
        instruction: result ? 'Give the answer alone, in the fewest natural words. Omit every introduction.' : selected?.ready ? 'Work is handled by the selected Flujo AI. Do not recommend models or repeat setup confirmation.' : 'Use the visible Find my AI button. No work AI is connected yet. Do not recommend a particular model.' });
      const started = session.ledger.begin(value, owner, owned);
      const stream = new TransformStream<Uint8Array, Uint8Array>(), writer = stream.writable.getWriter(), encoder = new TextEncoder();
      let admitted = false;
      let admit!: () => void, reject!: (error: unknown) => void;
      const ready = new Promise<void>((resolve, fail) => { admit = resolve; reject = fail; });
      const emit = async (event: unknown) => {
        if (!admitted) { admitted = true; admit(); }
        try { await writer.write(encoder.encode(JSON.stringify(event) + '\n')); }
        catch (error) { owned.abort(); throw error; }
      };
      void streamNativeTurn(value, config(), fetch, owned.signal, emit, { turnId: started.turn.id, history: result || selected?.ready ? [] : started.history, backendResult: result, setupFacts,
        onQualifiedResult: (qualified: unknown) => session.ledger.qualify(started.turn, qualified) }).then(async outcome => {
        session.ledger.finish(started.turn, outcome); await writer.close().catch(() => {});
      }).catch(async error => {
        session.ledger.finish(started.turn, null); reject(error); await writer.abort().catch(() => {});
      }).finally(release);
      await ready;
      return new Response(stream.readable, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } });
    } catch (error) { if (session.active > 0) release(); throw error; }
  } catch (error) {
    const known = error instanceof PublicError;
    return Response.json({ error: known ? error.message : 'Voice could not complete the request. You can type.', code: known ? error.code : 'voice_unavailable' }, { status: known ? error.status : 502 });
  }
}
