import { PublicError, readResponse } from './support.mjs';

export const POCKET_VOICES = Object.freeze({ en: 'anna', es: 'lola', de: 'juergen', pt: 'rafael', fr: 'estelle', it: 'giovanni', nl: 'daan' });
export const POCKET_MAX_TEXT = 600;
const unavailable = () => new PublicError(503, 'local_speech_unavailable', 'Local speech is unavailable.');

/** Only operator configuration can choose the private synthesis server. */
export function pocketOrigin(origin) {
  if (!origin) throw unavailable();
  let url; try { url = new URL(origin); } catch { throw unavailable(); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw unavailable();
  return url.origin;
}
export function validatePocketSpeech(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['text', 'locale'].includes(key)) ||
      typeof value.text !== 'string' || !value.text.trim() || value.text.length > POCKET_MAX_TEXT || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value.text) ||
      !Object.hasOwn(POCKET_VOICES, value.locale)) throw new PublicError(400, 'invalid_voice_request', 'Send short text and a supported speech language.');
  return { text: value.text.trim(), locale: value.locale };
}
export async function pocketAvailability(origin, fetchImpl = fetch, signal) {
  try {
    const response = await fetchImpl(pocketOrigin(origin) + '/healthz', { redirect: 'error', signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(2000)]) });
    const bytes = await readResponse(response, 4096);
    const body = JSON.parse(bytes.toString());
    return response.ok && body.ready === true && body.engine === 'pocket-tts' && body.version === '3.3.0';
  } catch { return false; }
}
export async function synthesizePocket(value, origin, fetchImpl = fetch, signal) {
  const payload = validatePocketSpeech(value);
  const lifetime = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(45_000)]);
  lifetime.throwIfAborted();
  const response = await fetchImpl(pocketOrigin(origin) + '/speech', { method: 'POST', redirect: 'error',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    signal: lifetime });
  if (!response.ok) { await response.body?.cancel(); throw new PublicError(response.status === 429 ? 429 : 503, 'local_speech_unavailable', 'Local speech is busy or unavailable.'); }
  const bytes = await readResponse(response, 44 + 24000 * 2 * 31);
  lifetime.throwIfAborted();
  // Fixed mono PCM16 WAV: no URLs, file paths or arbitrary media from the worker.
  if (bytes.length < 46 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' ||
      bytes.toString('ascii', 12, 16) !== 'fmt ' || bytes.readUInt32LE(16) !== 16 || bytes.readUInt16LE(20) !== 1 ||
      bytes.readUInt16LE(22) !== 1 || bytes.readUInt32LE(24) !== 24000 || bytes.readUInt32LE(28) !== 48000 ||
      bytes.readUInt16LE(32) !== 2 || bytes.readUInt16LE(34) !== 16 || bytes.toString('ascii', 36, 40) !== 'data' ||
      bytes.readUInt32LE(40) !== bytes.length - 44 || bytes.readUInt32LE(4) !== bytes.length - 8 || (bytes.length - 44) % 2) throw unavailable();
  return bytes;
}
