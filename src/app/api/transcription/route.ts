import { withWorkspaceRoute } from '@/app/api/_workspace';
import { modelService } from '@/backend/services/model';
import { resolveAndDecryptApiKey } from '@/backend/services/model/encryption';
import {
  createOpenAIClient,
  getProviderDefaultHeaders,
} from '@/backend/services/model/openaiClient';
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

function supportsOpenAITranscription(adapter: string | undefined): boolean {
  // Models created before the adapter field existed used the OpenAI-compatible
  // client, so an absent adapter retains that established default.
  return adapter === undefined ||
    adapter === 'openai' ||
    adapter === 'openai-responses';
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

    const model = await modelService.getModel(modelId);
    if (!model) {
      return errorResponse(
        'The transcription model was not found',
        'missing-model',
        404,
      );
    }
    if (
      !supportsOpenAITranscription(model.adapter) ||
      model.provider === 'azure'
    ) {
      return errorResponse(
        'The selected model does not support file transcription',
        'unsupported-format',
        400,
      );
    }

    const apiKey = await resolveAndDecryptApiKey(model.ApiKey);
    if (!apiKey) {
      return errorResponse(
        'Could not resolve credentials for the transcription model',
        'request-failed',
        400,
      );
    }

    const client = createOpenAIClient({
      apiKey,
      baseURL: model.baseUrl,
      defaultHeaders: getProviderDefaultHeaders(model.provider),
    });
    const result = await client.audio.transcriptions.create(
      {
        file,
        model: model.name,
        ...(language ? { language } : {}),
      },
      { signal: request.signal },
    );
    const text = typeof result.text === 'string' ? result.text.trim() : '';

    if (!text) {
      return errorResponse(
        'The transcription provider returned no text',
        'empty-transcript',
        422,
      );
    }

    return NextResponse.json({ text });
  } catch (error) {
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
