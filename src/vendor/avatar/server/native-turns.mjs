import { createHash, randomUUID } from 'node:crypto';
import { PublicError } from './support.mjs';
import { isLocale } from './locale.mjs';

const bad = () => { throw new PublicError(400, 'invalid_voice_request', 'Send a valid native voice request.'); };
const missing = () => { throw new PublicError(409, 'native_turn_ended', 'This voice turn is no longer available.'); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const only = (value, fields) => object(value) && Object.keys(value).every(key => fields.includes(key));
const hashAudio = audio => createHash('sha256').update(audio).digest('hex');

/** Owned, bounded conversation ledger. Received audio is never treated as heard audio. */
export function createNativeTurns({ now = Date.now } = {}) {
  const turns = new Map(), receipts = new Map();
  let scopeOwner = null, locale = null, sequence = 0, privateContext = false, latestResult = null;
  const reset = () => {
    for (const turn of turns.values()) { turn.responseAbort?.abort(); turn.observerAbort?.abort(); }
    turns.clear(); receipts.clear(); locale = null; privateContext = false; latestResult = null;
  };
  const bind = scopeToken => { if (scopeToken !== scopeOwner) { reset(); scopeOwner = scopeToken; } };
  const sweep = () => {
    for (const [id, turn] of turns) if (turn.expires <= now()) {
      turn.responseAbort?.abort(); turn.observerAbort?.abort(); turns.delete(id);
    }
    while (turns.size > 12) {
      const id = turns.keys().next().value, turn = turns.get(id);
      turn.responseAbort?.abort(); turn.observerAbort?.abort(); turns.delete(id);
    }
    for (const [id, receipt] of receipts) if (receipt.expires <= now()) receipts.delete(id);
  };
  const lookup = (id, requestedLocale) => {
    sweep(); const turn = turns.get(id);
    if (!turn || turn.locale !== requestedLocale || locale !== requestedLocale) missing();
    return turn;
  };
  const history = () => {
    sweep(); const entries = [];
    for (const turn of turns.values()) {
      if (turn.userText) entries.push({ role: 'user', content: turn.userText });
      if (turn.heard && turn.result?.text) entries.push({ role: 'assistant', content: turn.result.text });
      else if (turn.cancelled && turn.result?.text) entries.push({ role: 'user', content: '[The previous assistant reply was interrupted. Its unconfirmed audio is omitted.]' });
    }
    const result = []; let characters = 0;
    for (let i = entries.length - 1; i >= 0 && result.length < 10; i--) {
      const entry = entries[i], content = entry.content.slice(0, 4000);
      if (characters + content.length > 8000) break;
      result.unshift({ ...entry, content }); characters += content.length;
    }
    return result;
  };
  return {
    bind, reset, history,
    hasPrivateContext: () => privateContext,
    latestResult() {
      if (!latestResult || latestResult.expires <= now() || latestResult.owner !== scopeOwner) return undefined;
      const { reply, mode, status } = latestResult; return { reply, mode, status };
    },
    begin(value, scopeToken, responseAbort) {
      bind(scopeToken);
      if (locale !== null && locale !== value.locale) reset();
      locale = value.locale; sweep();
      const prior = history();
      // Cancelling a reply preserves the independent observer for its captured input.
      for (const turn of turns.values()) if (turn.responseAbort) {
        turn.cancelled = true; turn.responseAbort.abort();
      }
      const turn = { id: randomUUID(), sequence: ++sequence, locale, created: now(), expires: now() + 600_000,
        audioHash: value.audio ? hashAudio(value.audio) : null, userText: value.message || '',
        observed: Boolean(value.message), observing: false, cancelled: false, heard: false, result: null, responseAbort };
      turns.set(turn.id, turn); sweep(); return { turn, history: prior };
    },
    qualify(turn, result) {
      if (turns.get(turn.id) !== turn) return;
      if (result?.completed && typeof result.text === 'string' && Number.isInteger(result.samples) && result.samples > 0)
        turn.result = { text: result.text.slice(0, 4000), samples: result.samples };
    },
    finish(turn, result) {
      if (turns.get(turn.id) !== turn) return;
      turn.responseAbort = null;
      if (result?.completed) this.qualify(turn, result);
      else { turn.cancelled = true; if (!turn.heard) turn.result = null; }
    },
    claimObserver(payload, observerAbort) {
      if (!only(payload, ['turnId', 'locale', 'audio', 'format']) || typeof payload.turnId !== 'string' ||
          !isLocale(payload.locale) || typeof payload.audio !== 'string' || payload.format !== 'wav') bad();
      const turn = lookup(payload.turnId, payload.locale);
      if (!turn.audioHash || hashAudio(payload.audio) !== turn.audioHash || now() - turn.created > 120_000) missing();
      if (turn.observed || turn.observing) throw new PublicError(409, 'native_observer_used', 'This recorded request has already been observed.');
      turn.observing = true; turn.observerAbort = observerAbort; return turn;
    },
    observed(turn, text) {
      if (turns.get(turn.id) !== turn || turn.observerAbort?.signal.aborted) return false;
      if (typeof text !== 'string' || text.length > 4000) bad();
      turn.observing = false; turn.observed = true; turn.observerAbort = null; turn.userText = text.trim(); return true;
    },
    observerFailed(turn) { if (turns.get(turn.id) === turn) { turn.observing = false; turn.observed = true; turn.observerAbort = null; } },
    played(payload) {
      if (!only(payload, ['turnId', 'locale', 'playedSamples', 'complete']) || typeof payload.turnId !== 'string' ||
          !isLocale(payload.locale) || !Number.isInteger(payload.playedSamples) || payload.playedSamples < 0 ||
          payload.playedSamples > 31 * 24000 || typeof payload.complete !== 'boolean') bad();
      const turn = lookup(payload.turnId, payload.locale);
      if (turn.heard) return { accepted: true };
      if (!payload.complete) { turn.cancelled = true; turn.responseAbort?.abort(); return { accepted: true }; }
      if (!turn.result || turn.cancelled || payload.playedSamples !== turn.result.samples) missing();
      turn.heard = true; return { accepted: true };
    },
    receipt(result, scopeToken) {
      bind(scopeToken); sweep();
      if (!scopeToken || !only(result, ['reply', 'mode', 'status']) || result.mode !== 'flujo' ||
          !['completed', 'waiting_for_input'].includes(result.status) || typeof result.reply !== 'string' ||
          !result.reply.trim() || result.reply.length > 8000) return null;
      privateContext = true;
      const id = randomUUID(); receipts.set(id, { ...result, id, owner: scopeToken, expires: now() + 120_000, consumed: false });
      while (receipts.size > 4) receipts.delete(receipts.keys().next().value);
      return id;
    },
    receiptFor(payload, scopeToken) {
      bind(scopeToken); sweep();
      if (!only(payload, ['reply', 'locale']) || !isLocale(payload.locale) || typeof payload.reply !== 'string' || payload.reply.length > 8000) bad();
      const found = [...receipts.values()].reverse().find(item => !item.consumed && item.owner === scopeToken && item.reply === payload.reply);
      if (!found) missing(); return { taskId: found.id };
    },
    consumeReceipt(payload, scopeToken) {
      bind(scopeToken); sweep();
      if (!only(payload, ['taskId', 'avatar', 'locale']) || typeof payload.taskId !== 'string' ||
          !['moss', 'orbit', 'spark'].includes(payload.avatar) || !isLocale(payload.locale)) bad();
      const receipt = receipts.get(payload.taskId);
      if (!receipt || receipt.consumed || !scopeToken || receipt.owner !== scopeToken || locale !== null && locale !== payload.locale) missing();
      receipt.consumed = true; latestResult = { ...receipt };
      return { reply: receipt.reply, mode: receipt.mode, status: receipt.status };
    },
  };
}
