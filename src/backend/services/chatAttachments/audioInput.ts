import type { Model } from '@/shared/types/model';
import { resolveModelAdapter } from '@/shared/types/model/provider';
import { parseDataUrl } from '@/backend/services/model/adapters/messageUtils';
import { partInputModality, supportedInputModalities, unsupportedMediaNote } from '@/backend/services/model/mediaHandoff';
import type { Transcriber } from './audioTranscript';

/**
 * Sound files in a chat (#1224): sent as they are to a model that listens
 * and takes their format; otherwise as a transcript, or as a clear note when
 * no transcript can be made.
 */
export type AudioAbility = 'yes' | 'no' | 'unknown';

type ModelIdentity = Pick<Model, 'provider' | 'adapter' | 'inputModalities'> & Partial<Pick<Model, 'name'>>;

/** Gemini takes these; OpenAI-format audio input takes only MP3 and WAV. */
const GEMINI_AUDIO = new Set(['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3', 'audio/aiff', 'audio/aac', 'audio/ogg', 'audio/flac']);
const OPENAI_AUDIO = new Set(['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3']);
const FORMAT_MIME: Record<string, string> = { wav: 'audio/wav', mp3: 'audio/mpeg' };

export function modelHearsAudio(model: ModelIdentity): AudioAbility {
  const known = supportedInputModalities(model.inputModalities);
  if (known.size > 0) return known.has('audio') ? 'yes' : 'no';
  switch (resolveModelAdapter(model.provider, model.adapter)) {
    case 'gemini':
      return 'yes';
    case 'anthropic':
    case 'claude-cli':
    case 'codex-cli':
    case 'antigravity-cli':
      return 'no';
    case 'openai':
    case 'azure':
      if (model.provider === undefined || model.provider === 'openai' || model.provider === 'azure') {
        return /audio/i.test(model.name ?? '') ? 'yes' : 'no';
      }
      return 'unknown';
    default:
      return 'unknown';
  }
}

function acceptsFormat(model: ModelIdentity, mimeType: string): boolean {
  const formats = resolveModelAdapter(model.provider, model.adapter) === 'gemini' ? GEMINI_AUDIO : OPENAI_AUDIO;
  return formats.has(mimeType.toLowerCase());
}

/** The bytes of an inline sound part, or `undefined` for a stored reference. */
function inlineAudio(part: Record<string, unknown>): { base64: string; mimeType: string } | undefined {
  if (part.type === 'input_audio') {
    const audio = part.input_audio as { data?: unknown; format?: unknown } | undefined;
    if (typeof audio?.data !== 'string') return undefined;
    const format = String(audio.format ?? 'wav').toLowerCase();
    return { base64: audio.data, mimeType: FORMAT_MIME[format] ?? `audio/${format}` };
  }
  const nested = part.audio_url as { url?: unknown; mime_type?: unknown } | undefined;
  const parsed = typeof nested?.url === 'string' ? parseDataUrl(nested.url) : undefined;
  if (!parsed) return undefined;
  return { base64: parsed.base64, mimeType: typeof nested?.mime_type === 'string' && nested.mime_type ? nested.mime_type : parsed.mimeType };
}

/**
 * What replaces one wire part for this model, or `undefined` to send it as
 * it is. Only sound parts are touched.
 */
export async function audioInputFor(
  part: Record<string, unknown>,
  context: {
    model: ModelIdentity;
    hears: AudioAbility;
    name?: string;
    /** The voice button already put a transcript right after this recording. */
    transcriptFollows: boolean;
    transcriber: Transcriber;
  },
): Promise<unknown[] | undefined> {
  if (partInputModality(part) !== 'audio') return undefined;
  const { model, hears } = context;
  const audio = inlineAudio(part);
  const label = `Audio${context.name ? ` "${context.name}"` : ''}`;
  if (!audio) {
    return hears === 'no' ? [{ type: 'text', text: unsupportedMediaNote(part, 'audio') }] : undefined;
  }
  const accepted = acceptsFormat(model, audio.mimeType);
  if (hears === 'yes' && accepted) return undefined;
  const why = hears === 'yes' ? `this model cannot take ${audio.mimeType} sound` : 'this model cannot listen to audio';
  if (context.transcriptFollows) {
    return [{ type: 'text', text: `[${label} not sent: ${why}; its transcript follows.]` }];
  }
  const transcript = await context.transcriber({
    bytes: Buffer.from(audio.base64, 'base64'),
    mimeType: audio.mimeType,
    name: context.name ?? 'audio',
  });
  if (transcript.kind === 'text') {
    return [{ type: 'text', text: `[${label}: ${why}, so FLUJO sent a transcript:]\n${transcript.text}` }];
  }
  if (hears === 'unknown' && accepted) return undefined;
  const reason = transcript.kind === 'no-model'
    ? 'no transcription model is set up. Choose one in Settings > Speech to get transcripts'
    : transcript.kind === 'unsupported-format'
      ? `FLUJO cannot make transcripts of ${audio.mimeType} files (MP3, WAV, M4A, Ogg, FLAC and WebM work)`
      : `making a transcript failed (${transcript.reason}). FLUJO tries again with the next message`;
  return [{ type: 'text', text: `[${label} not sent: ${why}, and ${reason}.]` }];
}
