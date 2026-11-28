import { modelService } from '@/backend/services/model';
import { resolveAndDecryptApiKey } from '@/backend/services/model/encryption';
import { createOpenAIClient, getProviderDefaultHeaders } from '@/backend/services/model/openaiClient';
import type { Model } from '@/shared/types';

/**
 * Prerecorded audio to text through a configured OpenAI-format model: the
 * voice button's recordings (`/api/transcription`) and sound files added to
 * a chat for a model that cannot listen (#1224). The model's key is resolved
 * and decrypted only here, on the server.
 */
export type AudioTranscriptionFailure = 'missing-model' | 'owner-bound-model' | 'unsupported-format' | 'request-failed' | 'empty-transcript';

export class AudioTranscriptionError extends Error {
  constructor(readonly code: AudioTranscriptionFailure, readonly status: number, message: string) {
    super(message);
  }
}

/** Models created before the adapter field existed used the OpenAI-compatible client. */
export function supportsFileTranscription(model: Pick<Model, 'adapter' | 'provider'>): boolean {
  return model.provider !== 'azure' && (model.adapter === undefined || model.adapter === 'openai' || model.adapter === 'openai-responses');
}

export async function transcribeAudioFile(
  file: File,
  modelId: string,
  options: { language?: string; signal?: AbortSignal } = {},
): Promise<string> {
  const model = await modelService.getModel(modelId);
  if (!model) throw new AudioTranscriptionError('missing-model', 404, 'The transcription model was not found');
  if (model.ownerCredentialBinding !== undefined) {
    throw new AudioTranscriptionError('owner-bound-model', 403, 'Owner-bound models require an authorized model-step transport.');
  }
  if (!supportsFileTranscription(model)) {
    throw new AudioTranscriptionError('unsupported-format', 400, 'The selected model does not support file transcription');
  }
  const apiKey = await resolveAndDecryptApiKey(model.ApiKey);
  if (!apiKey) throw new AudioTranscriptionError('request-failed', 400, 'Could not resolve credentials for the transcription model');
  const client = createOpenAIClient({
    apiKey,
    baseURL: model.baseUrl,
    defaultHeaders: getProviderDefaultHeaders(model.provider),
  });
  const result = await client.audio.transcriptions.create(
    { file, model: model.name, ...(options.language ? { language: options.language } : {}) },
    { signal: options.signal },
  );
  const text = typeof result.text === 'string' ? result.text.trim() : '';
  if (!text) throw new AudioTranscriptionError('empty-transcript', 422, 'The transcription provider returned no text');
  return text;
}
