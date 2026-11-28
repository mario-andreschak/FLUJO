import { withWorkspaceRoute } from '@/app/api/_workspace';
import {
  AudioTranscriptionError,
  transcribeAudioFile,
} from '@/backend/services/transcription/audioTranscription';
import {
  MAX_TRANSCRIPTION_AUDIO_BYTES,
  isSupportedTranscriptionAudioMimeType,
} from '@/shared/transcription/audio';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { createLogger } from '@/utils/logger';
import { NextRequest, NextResponse } from 'next/server';

const log = createLogger('app/api/transcription/route');

function errorResponse(
  error: string,
  code: string,
  status: number,
): NextResponse {
  return NextResponse.json({ error, code }, { status });
}

function normalizeLanguageHint(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const primaryLanguage = value.split(/[-_]/, 1)[0].trim().toLowerCase();
  return /^[a-z]{2}$/.test(primaryLanguage) ? primaryLanguage : undefined;
}

/**
 * POST /api/transcription
 *
 * Accepts multipart/form-data fields:
 * - file: non-empty prerecorded audio (up to 25 MB)
 * - modelId: an existing OpenAI-format configured model
 * - language: optional ISO-639-1 language hint
 *
 * The stored API key is resolved and decrypted only on the server.
 */
async function POST_handler(request: NextRequest) {
  const lock = await assertUnlocked();
  if (lock) return lock;

  try {
    const formData = await request.formData();
    const file = formData.get('file');
    const modelId = formData.get('modelId')?.toString().trim();
    const rawLanguage = formData.get('language')?.toString().trim();
    const language = normalizeLanguageHint(rawLanguage);

    if (!(file instanceof File) || file.size === 0) {
      return errorResponse(
        'A non-empty audio file is required',
        'empty-audio',
        400,
      );
    }
    if (file.size > MAX_TRANSCRIPTION_AUDIO_BYTES) {
      return errorResponse(
        'The recording is larger than the 25 MB transcription limit',
        'file-too-large',
        413,
      );
    }
    if (!isSupportedTranscriptionAudioMimeType(file.type)) {
      return errorResponse(
        'The recording format is not supported for transcription',
        'unsupported-format',
        415,
      );
    }
    if (!modelId) {
      return errorResponse(
        'A transcription model is required',
        'missing-model',
        400,
      );
    }
    if (rawLanguage && !language) {
      return errorResponse(
        'The transcription language must be a valid two-letter language code',
        'request-failed',
        400,
      );
    }

    const text = await transcribeAudioFile(file, modelId, { language, signal: request.signal });
    return NextResponse.json({ text });
  } catch (error) {
    if (error instanceof AudioTranscriptionError) {
      return errorResponse(error.message, error.code, error.status);
    }
    if (request.signal.aborted) {
      return errorResponse(
        'Audio transcription was cancelled',
        'cancelled',
        408,
      );
    }

    log.error('Audio transcription failed', { error });
    return errorResponse(
      'Audio transcription failed',
      'request-failed',
      502,
    );
  }
}

export const POST = withWorkspaceRoute(POST_handler);
