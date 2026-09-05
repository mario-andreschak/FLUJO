import { checkWebSpeechSupport } from './webSpeech';

export {
  startLiveTranscription,
  type LiveTranscriptionSession,
  type LiveTranscriptionOptions,
} from './webSpeech';

export interface TranscriptionOptions {
  onProgress?: (progress: number) => void;
  onStatusChange?: (status: string) => void;
  language?: string;
}

export interface TranscriptionResult {
  text: string;
  success: boolean;
  error?: string;
  engine?: 'webspeech';
}

export const isSpeechSupported = checkWebSpeechSupport;

export function checkSpeechSupport() {
  return checkWebSpeechSupport();
}

/**
 * Prerecorded audio is intentionally not routed through Web Speech.
 *
 * Web Speech recognizes the live microphone only. Keep this compatibility
 * boundary as an explicit failure until a file-capable provider is configured.
 */
export async function transcribe(
  _audioBlob: Blob,
  options: TranscriptionOptions = {},
): Promise<TranscriptionResult> {
  const error = typeof window === 'undefined'
    ? 'Server-side transcription is not supported'
    : 'Pre-recorded audio transcription requires a file-capable provider';

  options.onProgress?.(0);
  options.onStatusChange?.('Transcription unavailable');

  return {
    text: '',
    success: false,
    error,
  };
}
