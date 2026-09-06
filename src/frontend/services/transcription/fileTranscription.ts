import {
  MAX_TRANSCRIPTION_AUDIO_BYTES,
  getTranscriptionAudioExtension,
  isSupportedTranscriptionAudioMimeType,
} from '@/shared/transcription/audio';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/services/transcription/fileTranscription');

export const DEFAULT_TRANSCRIPTION_TIMEOUT_MS = 120_000;

export type TranscriptionFailureCode =
  | 'empty-audio'
  | 'unsupported-format'
  | 'file-too-large'
  | 'missing-model'
  | 'empty-transcript'
  | 'invalid-response'
  | 'request-failed'
  | 'cancelled'
  | 'timeout';

export interface FileTranscriptionOptions {
  modelId: string;
  language?: string;
  onProgress?: (progress: number) => void;
  onStatusChange?: (status: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface FileTranscriptionResult {
  text: string;
  success: boolean;
  error?: string;
  code?: TranscriptionFailureCode;
  engine: 'provider';
}

interface TranscriptionResponse {
  text?: unknown;
  error?: unknown;
  code?: unknown;
}

const KNOWN_FAILURE_CODES: readonly TranscriptionFailureCode[] = [
  'empty-audio',
  'unsupported-format',
  'file-too-large',
  'missing-model',
  'empty-transcript',
  'invalid-response',
  'request-failed',
  'cancelled',
  'timeout',
];

function failure(
  code: TranscriptionFailureCode,
  error: string,
): FileTranscriptionResult {
  return { text: '', success: false, error, code, engine: 'provider' };
}

function responseFailureCode(value: unknown): TranscriptionFailureCode {
  return typeof value === 'string' &&
    KNOWN_FAILURE_CODES.includes(value as TranscriptionFailureCode)
    ? value as TranscriptionFailureCode
    : 'request-failed';
}

/**
 * Upload a prerecorded audio File to FLUJO's server-side transcription route.
 * Provider credentials and endpoint configuration never cross this boundary.
 */
export async function transcribeFile(
  file: File,
  options: FileTranscriptionOptions,
): Promise<FileTranscriptionResult> {
  if (file.size === 0) {
    return failure('empty-audio', 'The recording contains no audio data');
  }
  if (file.size > MAX_TRANSCRIPTION_AUDIO_BYTES) {
    return failure(
      'file-too-large',
      'The recording is larger than the 25 MB transcription limit',
    );
  }
  if (!isSupportedTranscriptionAudioMimeType(file.type)) {
    return failure(
      'unsupported-format',
      'The recording format is not supported by the transcription provider',
    );
  }
  if (!options.modelId.trim()) {
    return failure('missing-model', 'A transcription model is not configured');
  }
  if (options.signal?.aborted) {
    return failure('cancelled', 'Audio transcription was cancelled');
  }

  const controller = new AbortController();
  let timedOut = false;
  const timeoutMs =
    typeof options.timeoutMs === 'number' &&
    Number.isFinite(options.timeoutMs) &&
    options.timeoutMs > 0
      ? Math.floor(options.timeoutMs)
      : DEFAULT_TRANSCRIPTION_TIMEOUT_MS;
  const handleCallerAbort = () => controller.abort();
  options.signal?.addEventListener('abort', handleCallerAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const formData = new FormData();
  formData.append('file', file, file.name);
  formData.append('modelId', options.modelId.trim());
  if (options.language?.trim()) {
    formData.append('language', options.language.trim());
  }

  options.onProgress?.(10);
  options.onStatusChange?.('Uploading audio for transcription…');

  try {
    const response = await fetch('/api/transcription', {
      method: 'POST',
      body: formData,
      signal: controller.signal,
    });
    const payload = await response.json()
      .catch(() => null) as TranscriptionResponse | null;

    if (!response.ok) {
      const message = typeof payload?.error === 'string'
        ? payload.error
        : 'Audio transcription failed';
      return failure(responseFailureCode(payload?.code), message);
    }

    if (!payload || typeof payload.text !== 'string') {
      return failure(
        'invalid-response',
        'The transcription provider returned an invalid response',
      );
    }

    const text = payload.text.trim();
    if (!text) {
      options.onStatusChange?.('No speech was detected');
      return failure('empty-transcript', 'No speech was detected');
    }

    options.onProgress?.(100);
    options.onStatusChange?.('Transcription completed');
    return { text, success: true, engine: 'provider' };
  } catch (error) {
    if (controller.signal.aborted) {
      return timedOut
        ? failure('timeout', 'Audio transcription timed out')
        : failure('cancelled', 'Audio transcription was cancelled');
    }

    log.error('Prerecorded audio transcription request failed', { error });
    return failure('request-failed', 'Audio transcription failed');
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', handleCallerAbort);
  }
}

/**
 * Preserve the recorder's real MIME type while deriving the extension expected
 * by multipart transcription providers.
 */
export function createTranscriptionFile(
  audioBlob: Blob,
  basename = 'recording',
): File | null {
  const mimeType = audioBlob.type || 'audio/webm';
  const extension = getTranscriptionAudioExtension(mimeType);
  if (!extension || typeof File === 'undefined') return null;

  return new File([audioBlob], `${basename}.${extension}`, {
    type: mimeType,
    lastModified: Date.now(),
  });
}
