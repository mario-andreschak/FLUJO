import type { NextRequest } from 'next/server';
import type { Model } from '@/shared/types';

const assertUnlockedMock = jest.fn();
const getModelMock = jest.fn();
const resolveApiKeyMock = jest.fn();
const transcriptionCreateMock = jest.fn();
const createOpenAIClientMock = jest.fn((_options: unknown) => ({
  audio: {
    transcriptions: {
      create: transcriptionCreateMock,
    },
  },
}));

jest.mock('@/app/api/_workspace', () => ({
  withWorkspaceRoute: <T,>(handler: T): T => handler,
}));
jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: (...args: unknown[]) => assertUnlockedMock(...args),
}));
jest.mock('@/backend/services/model', () => ({
  modelService: {
    getModel: (...args: unknown[]) => getModelMock(...args),
  },
}));
jest.mock('@/backend/services/model/encryption', () => ({
  resolveAndDecryptApiKey: (...args: unknown[]) => resolveApiKeyMock(...args),
}));
jest.mock('@/backend/services/model/openaiClient', () => ({
  createOpenAIClient: (options: unknown) => createOpenAIClientMock(options),
  getProviderDefaultHeaders: jest.fn(() => ({ 'X-Title': 'FLUJO' })),
}));

import { POST } from '@/app/api/transcription/route';

const configuredModel: Model = {
  id: 'transcription-model',
  name: 'whisper-1',
  displayName: 'Whisper',
  ApiKey: 'encrypted:secret',
  baseUrl: 'https://api.openai.com/v1',
  provider: 'openai',
  adapter: 'openai',
};

const requestWith = (
  fields: {
    file?: File;
    modelId?: string;
    language?: string;
  },
): NextRequest => {
  const formData = new FormData();
  if (fields.file) formData.append('file', fields.file);
  if (fields.modelId) formData.append('modelId', fields.modelId);
  if (fields.language) formData.append('language', fields.language);

  return new Request('http://localhost:4200/api/transcription', {
    method: 'POST',
    headers: { host: 'localhost:4200' },
    body: formData,
  }) as unknown as NextRequest;
};

describe('POST /api/transcription', () => {
  beforeEach(() => {
    assertUnlockedMock.mockReset().mockResolvedValue(null);
    getModelMock.mockReset().mockResolvedValue(configuredModel);
    resolveApiKeyMock.mockReset().mockResolvedValue('resolved-secret');
    transcriptionCreateMock.mockReset().mockResolvedValue({ text: ' hello ' });
    createOpenAIClientMock.mockClear();
  });

  it('requires a non-empty supported audio file and model ID', async () => {
    const missingFile = await POST(requestWith({
      modelId: configuredModel.id,
    }), {} as never);
    expect(missingFile.status).toBe(400);
    await expect(missingFile.json()).resolves.toMatchObject({
      code: 'empty-audio',
    });

    const missingModel = await POST(requestWith({
      file: new File(['audio'], 'recording.webm', { type: 'audio/webm' }),
    }), {} as never);
    expect(missingModel.status).toBe(400);
    await expect(missingModel.json()).resolves.toMatchObject({
      code: 'missing-model',
    });

    const unsupported = await POST(requestWith({
      file: new File(['audio'], 'recording.aac', { type: 'audio/aac' }),
      modelId: configuredModel.id,
    }), {} as never);
    expect(unsupported.status).toBe(415);
    await expect(unsupported.json()).resolves.toMatchObject({
      code: 'unsupported-format',
    });
  });

  it('resolves the stored model and key and forwards file metadata and language', async () => {
    const response = await POST(requestWith({
      file: new File(['audio'], 'recording.webm', {
        type: 'audio/webm;codecs=opus',
      }),
      modelId: configuredModel.id,
      language: 'es-CO',
    }), {} as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ text: 'hello' });
    expect(getModelMock).toHaveBeenCalledWith(configuredModel.id);
    expect(resolveApiKeyMock).toHaveBeenCalledWith(configuredModel.ApiKey);
    expect(createOpenAIClientMock).toHaveBeenCalledWith({
      apiKey: 'resolved-secret',
      baseURL: configuredModel.baseUrl,
      defaultHeaders: { 'X-Title': 'FLUJO' },
    });
    expect(transcriptionCreateMock).toHaveBeenCalledWith(
      {
        file: expect.objectContaining({
          name: 'recording.webm',
          type: 'audio/webm;codecs=opus',
        }),
        model: 'whisper-1',
        language: 'es',
      },
      { signal: expect.any(AbortSignal) },
    );
  });

  it('rejects unknown and non-OpenAI-format models', async () => {
    getModelMock.mockResolvedValueOnce(null);
    const unknown = await POST(requestWith({
      file: new File(['audio'], 'recording.webm', { type: 'audio/webm' }),
      modelId: 'missing',
    }), {} as never);
    expect(unknown.status).toBe(404);

    getModelMock.mockResolvedValueOnce({
      ...configuredModel,
      adapter: 'anthropic',
    });
    const incompatible = await POST(requestWith({
      file: new File(['audio'], 'recording.webm', { type: 'audio/webm' }),
      modelId: configuredModel.id,
    }), {} as never);
    expect(incompatible.status).toBe(400);
    expect(resolveApiKeyMock).not.toHaveBeenCalled();
  });

  it('turns empty provider output into an explicit recoverable failure', async () => {
    transcriptionCreateMock.mockResolvedValue({ text: '   ' });

    const response = await POST(requestWith({
      file: new File(['audio'], 'recording.webm', { type: 'audio/webm' }),
      modelId: configuredModel.id,
    }), {} as never);

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: 'The transcription provider returned no text',
      code: 'empty-transcript',
    });
  });

  it('sanitizes provider failures and never returns credentials', async () => {
    transcriptionCreateMock.mockRejectedValue(
      new Error('provider echoed resolved-secret'),
    );

    const response = await POST(requestWith({
      file: new File(['audio'], 'recording.webm', { type: 'audio/webm' }),
      modelId: configuredModel.id,
    }), {} as never);
    const body = await response.text();

    expect(response.status).toBe(502);
    expect(body).toContain('Audio transcription failed');
    expect(body).not.toContain('resolved-secret');
  });
});
