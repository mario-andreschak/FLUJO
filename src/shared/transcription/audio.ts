/**
 * OpenAI-compatible transcription endpoints accept these prerecorded-audio
 * container types. Parameters such as `codecs=opus` are intentionally ignored
 * when validating the container while the original MIME value is preserved on
 * the uploaded File.
 */
export const TRANSCRIPTION_AUDIO_EXTENSIONS = {
  'audio/flac': 'flac',
  'audio/m4a': 'm4a',
  'audio/mp3': 'mp3',
  'audio/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
  'audio/x-m4a': 'm4a',
  'audio/x-wav': 'wav',
} as const;

export type TranscriptionAudioMimeType =
  keyof typeof TRANSCRIPTION_AUDIO_EXTENSIONS;

export const MAX_TRANSCRIPTION_AUDIO_BYTES = 25 * 1024 * 1024;

export function normalizeAudioMimeType(mimeType: string): string {
  return mimeType.split(';', 1)[0].trim().toLowerCase();
}

export function getTranscriptionAudioExtension(
  mimeType: string,
): string | undefined {
  const normalized = normalizeAudioMimeType(mimeType);
  return TRANSCRIPTION_AUDIO_EXTENSIONS[
    normalized as TranscriptionAudioMimeType
  ];
}

export function isSupportedTranscriptionAudioMimeType(
  mimeType: string,
): boolean {
  return Boolean(getTranscriptionAudioExtension(mimeType));
}
