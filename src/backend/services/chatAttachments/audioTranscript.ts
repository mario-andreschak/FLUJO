import { webcrypto } from 'node:crypto';
import { modelService } from '@/backend/services/model';
import {
  AudioTranscriptionError,
  supportsFileTranscription,
  transcribeAudioFile,
} from '@/backend/services/transcription/audioTranscription';
import {
  MAX_TRANSCRIPTION_AUDIO_BYTES,
  getTranscriptionAudioExtension,
} from '@/shared/transcription/audio';
import { StorageKey, type Settings } from '@/shared/types/storage';
import { loadItem } from '@/utils/storage/backend';
import { createLogger } from '@/utils/logger';

const log = createLogger('backend/services/chatAttachments/audioTranscript');

/**
 * Transcripts of sound files added to a chat, for models that cannot listen
 * (#1224). They use the same transcription model as the voice button
 * (Settings → Speech). When none is chosen there, a configured model whose
 * name says it transcribes (whisper-1, gpt-4o-mini-transcribe, …) is used.
 * A conversation re-sends its sound file on every turn, so transcripts are
 * kept for the most recent files; a failure is not kept, so the next message
 * tries again.
 */
export type AudioTranscript =
  | { kind: 'text'; text: string }
  /** No transcription model is set up. */
  | { kind: 'no-model' }
  /** The transcription service does not take this sound format. */
  | { kind: 'unsupported-format' }
  | { kind: 'failed'; reason: string };

export type Transcriber = (audio: { bytes: Uint8Array; mimeType: string; name: string }) => Promise<AudioTranscript>;

const TRANSCRIPTION_TIMEOUT_MS = 120_000;
const TRANSCRIBING_MODEL = /whisper|transcri|speech[-_ ]?to[-_ ]?text|\bstt\b/i;
const MAX_ENTRIES = 64;
const cache = new Map<string, Promise<AudioTranscript>>();

/** `.opus` files are Ogg files, which transcription services take under that name. */
function transcriptionMime(mimeType: string): string {
  const base = mimeType.split(';', 1)[0].trim().toLowerCase();
  return base === 'audio/opus' ? 'audio/ogg' : base;
}

async function transcriptionModelId(): Promise<string | undefined> {
  let chosen: string | undefined;
  try {
    const settings = await loadItem<Settings | undefined>(StorageKey.SPEECH_SETTINGS, undefined);
    chosen = settings?.speech?.transcriptionModelId;
  } catch (error) {
    log.warn('Could not read the speech settings; looking for a transcription model by name', error);
  }
  const models = await modelService.loadModels();
  const usable = models.filter(model => supportsFileTranscription(model) && model.ownerCredentialBinding === undefined);
  return usable.find(model => model.id === chosen)?.id ?? usable.find(model => TRANSCRIBING_MODEL.test(model.name))?.id;
}

async function transcribe(audio: { bytes: Uint8Array; mimeType: string; name: string }, modelId: string): Promise<AudioTranscript> {
  const mimeType = transcriptionMime(audio.mimeType);
  const extension = getTranscriptionAudioExtension(mimeType) ?? 'bin';
  const base = audio.name.replace(/\.[^.]*$/, '') || 'audio';
  const file = new File([Buffer.from(audio.bytes)], `${base}.${extension}`, { type: mimeType });
  try {
    return { kind: 'text', text: await transcribeAudioFile(file, modelId, { signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS) }) };
  } catch (error) {
    log.warn('Could not transcribe a chat sound file', error);
    const reason = error instanceof AudioTranscriptionError
      ? error.message
      : (error as { name?: string })?.name === 'TimeoutError' ? 'it took too long' : 'the transcription service did not answer';
    return { kind: 'failed', reason };
  }
}

export const transcribeChatAudio: Transcriber = async (audio) => {
  if (!getTranscriptionAudioExtension(transcriptionMime(audio.mimeType))) return { kind: 'unsupported-format' };
  if (audio.bytes.byteLength > MAX_TRANSCRIPTION_AUDIO_BYTES) return { kind: 'failed', reason: 'the file is larger than 25 MB' };
  const modelId = await transcriptionModelId().catch((error: unknown) => {
    log.warn('Could not look up a transcription model', error);
    return undefined;
  });
  if (!modelId) return { kind: 'no-model' };
  const digest = Buffer.from(await webcrypto.subtle.digest('SHA-256', audio.bytes)).toString('hex');
  const key = `${modelId}:${digest}`;
  const existing = cache.get(key);
  if (existing) {
    cache.delete(key);
    cache.set(key, existing);
    return existing;
  }
  const pending = transcribe(audio, modelId);
  cache.set(key, pending);
  pending.then(result => { if (result.kind !== 'text') cache.delete(key); }, () => cache.delete(key));
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
  return pending;
};
