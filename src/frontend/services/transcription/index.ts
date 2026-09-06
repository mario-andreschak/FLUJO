import { checkWebSpeechSupport } from './webSpeech';
import {
  createTranscriptionFile,
  transcribeFile,
  type FileTranscriptionResult,
  type TranscriptionFailureCode,
} from './fileTranscription';

export {
  startLiveTranscription,
  type LiveTranscriptionSession,
  type LiveTranscriptionOptions,
} from './webSpeech';

export {
  createTranscriptionFile,
  transcribeFile,
  type FileTranscriptionOptions,
  type FileTranscriptionResult,
  type TranscriptionFailureCode,
} from './fileTranscription';

export interface TranscriptionOptions {
  modelId?: string;
  onProgress?: (progress: number) => void;
  onStatusChange?: (status: string) => void;
  language?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type TranscriptionResult = FileTranscriptionResult;

export const isSpeechSupported = checkWebSpeechSupport;

export function checkSpeechSupport() {
  return checkWebSpeechSupport();
}

/**
 * Transcribe a prerecorded Blob through the configured file-capable provider.
 * Browser Web Speech remains available only through startLiveTranscription().
 */
export async function transcribe(
  audioBlob: Blob,
  options: TranscriptionOptions = {},
): Promise<TranscriptionResult> {
  if (!options.modelId?.trim()) {
    return {
      text: '',
      success: false,
      error: 'A transcription model is not configured',
      code: 'missing-model',
      engine: 'provider',
    };
  }

  const file = createTranscriptionFile(audioBlob);
  if (!file) {
    const code: TranscriptionFailureCode = audioBlob.type
      ? 'unsupported-format'
      : 'request-failed';
    return {
      text: '',
      success: false,
      error: audioBlob.type
        ? 'The recording format is not supported by the transcription provider'
        : 'This browser cannot prepare the recording for transcription',
      code,
      engine: 'provider',
    };
  }

  return transcribeFile(file, {
    modelId: options.modelId,
    language: options.language,
    onProgress: options.onProgress,
    onStatusChange: options.onStatusChange,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
}
