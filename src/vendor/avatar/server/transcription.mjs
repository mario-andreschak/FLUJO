import { PublicError, readResponse } from './support.mjs';
import { isLocale } from './locale.mjs';
const BASE='https://openrouter.ai/api/v1', MAX_AUDIO=8*1024*1024;
const invalid=message=>new PublicError(400,'invalid_voice_request',message);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const only=(value,keys)=>object(value)&&Object.keys(value).every(key=>keys.includes(key));
function requireKey(config) { if (!config.openrouterKey) throw new PublicError(503,'voice_unconfigured','Voice is unavailable. You can type.'); }
function headers(config) { return { Authorization: 'Bearer '+config.openrouterKey, 'Content-Type':'application/json', 'X-OpenRouter-Title':'Flujo Avatar' }; }
async function requireSuccess(response) { if (!response.ok) throw new PublicError(response.status===429?429:502,'voice_unavailable','Recognition is unavailable. You can type.'); }
/** PCM WAV only: no browser URL, external file or arbitrary transcription options. */
export function validateTranscription(payload) {
  if (!only(payload, ['audio', 'format', 'language', 'locale']) || (payload.locale !== undefined && !isLocale(payload.locale)) || payload.format !== 'wav' ||
      typeof payload.audio !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload.audio) || payload.audio.length % 4 !== 0 ||
      (payload.language !== undefined && !/^[a-z]{2}$/.test(payload.language))) {
    throw invalid('Send a base64 PCM WAV recording and an optional two-letter language.');
  }
  const data = Buffer.from(payload.audio, 'base64');
  if (data.length > MAX_AUDIO || data.toString('base64') !== payload.audio || data.length < 44 ||
      data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE' ||
      data.readUInt32LE(4) + 8 !== data.length) throw invalid('The WAV recording is invalid.');
  let format;
  let audioBytes = 0;
  let offset = 12;
  while (offset + 8 <= data.length) {
    const name = data.toString('ascii', offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    offset += 8;
    if (offset + size > data.length) throw invalid('The WAV recording is invalid.');
    if (name === 'fmt ') {
      if (size < 16 || format) throw invalid('The WAV recording is invalid.');
      format = { codec: data.readUInt16LE(offset), channels: data.readUInt16LE(offset + 2), rate: data.readUInt32LE(offset + 4),
        bytesPerSecond: data.readUInt32LE(offset + 8), alignment: data.readUInt16LE(offset + 12), bits: data.readUInt16LE(offset + 14) };
    }
    if (name === 'data') audioBytes += size;
    offset += size + size % 2;
  }
  if (offset !== data.length || !format || format.codec !== 1 || format.channels !== 1 || format.bits !== 16 ||
      format.rate < 8000 || format.rate > 48000 || format.bytesPerSecond !== format.rate * 2 || format.alignment !== 2 ||
      !audioBytes || audioBytes % 2 || audioBytes / format.bytesPerSecond > 30.1) {
    throw invalid('Record at most 30 seconds of mono 16-bit PCM audio.');
  }
  return { audio: payload.audio, ...(payload.language ? { language: payload.language } : {}) };
}

export async function transcribe(payload, config, fetchImpl, signal) {
  requireKey(config);
  const response = await fetchImpl(`${BASE}/audio/transcriptions`, {
    method: 'POST', redirect: 'manual', signal, headers: headers(config),
    body: JSON.stringify({ model: config.openrouterSttModel, input_audio: { data: payload.audio, format: 'wav' },
      response_format: 'json', temperature: 0, ...(payload.language ? { language: payload.language } : {}) }),
  });
  await requireSuccess(response);
  let result;
  try { result = JSON.parse((await readResponse(response, 64 * 1024)).toString('utf8')); }
  catch { throw new PublicError(502, 'invalid_upstream_response', 'The transcription service returned an invalid response.'); }
  if (typeof result.text !== 'string' || result.text.length > 8000) throw new PublicError(502, 'invalid_upstream_response', 'The transcription service returned an invalid response.');
  return { text: result.text.trim() };
}

