/** @jest-environment jsdom */
import {
  transcribe,
  transcribeFile,
} from '@/frontend/services/transcription';

const response = (
  body: unknown,
  ok = true,
  status = ok ? 200 : 500,
): Response => ({
  ok,
  status,
  json: jest.fn().mockResolvedValue(body),
} as unknown as Response);

describe('prerecorded file transcription', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('preserves MIME metadata, filename, model, and language', async () => {
    fetchMock.mockResolvedValue(response({ text: '  hello world  ' }));
    const onProgress = jest.fn();
    const onStatusChange = jest.fn();

    const result = await transcribe(
      new Blob(['audio'], { type: 'audio/webm;codecs=opus' }),
      {
        modelId: 'whisper-model',
        language: 'es',
        onProgress,
        onStatusChange,
      },
    );

    expect(result).toEqual({
      text: 'hello world',
      success: true,
      engine: 'provider',
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/transcription', {
      method: 'POST',
      body: expect.any(FormData),
      signal: expect.any(AbortSignal),
    });

    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(request.headers).toBeUndefined();
    const body = request.body as FormData;
    const file = body.get('file') as File;
    expect(file.name).toBe('recording.webm');
    expect(file.type).toBe('audio/webm;codecs=opus');
    expect(body.get('modelId')).toBe('whisper-model');
    expect(body.get('language')).toBe('es');
    expect(onProgress.mock.calls).toEqual([[10], [100]]);
    expect(onStatusChange).toHaveBeenLastCalledWith('Transcription completed');
  });

  it('rejects whitespace-only and malformed successful responses', async () => {
    fetchMock
      .mockResolvedValueOnce(response({ text: '   ' }))
      .mockResolvedValueOnce(response({ unexpected: true }));

    await expect(transcribe(
      new Blob(['audio'], { type: 'audio/webm' }),
      { modelId: 'model' },
    )).resolves.toMatchObject({
      success: false,
      text: '',
      code: 'empty-transcript',
    });

    await expect(transcribe(
      new Blob(['audio'], { type: 'audio/webm' }),
      { modelId: 'model' },
    )).resolves.toMatchObject({
      success: false,
      text: '',
      code: 'invalid-response',
    });
  });

  it('surfaces sanitized non-2xx route failures', async () => {
    fetchMock.mockResolvedValue(response(
      {
        error: 'The selected model does not support file transcription',
        code: 'unsupported-format',
      },
      false,
      400,
    ));

    await expect(transcribe(
      new Blob(['audio'], { type: 'audio/webm' }),
      { modelId: 'model' },
    )).resolves.toMatchObject({
      success: false,
      error: 'The selected model does not support file transcription',
      code: 'unsupported-format',
    });
  });

  it('rejects empty and unsupported files without a network request', async () => {
    await expect(transcribeFile(
      new File([], 'empty.webm', { type: 'audio/webm' }),
      { modelId: 'model' },
    )).resolves.toMatchObject({
      success: false,
      code: 'empty-audio',
    });

    await expect(transcribeFile(
      new File(['audio'], 'audio.aac', { type: 'audio/aac' }),
      { modelId: 'model' },
    )).resolves.toMatchObject({
      success: false,
      code: 'unsupported-format',
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cancels an in-flight upload through the caller signal', async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      }),
    );
    const controller = new AbortController();

    const pending = transcribe(
      new Blob(['audio'], { type: 'audio/webm' }),
      { modelId: 'model', signal: controller.signal },
    );
    controller.abort();

    await expect(pending).resolves.toMatchObject({
      success: false,
      code: 'cancelled',
    });
  });

  it('aborts uploads that exceed the configured timeout', async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      }),
    );

    const pending = transcribe(
      new Blob(['audio'], { type: 'audio/webm' }),
      { modelId: 'model', timeoutMs: 25 },
    );
    jest.advanceTimersByTime(25);

    await expect(pending).resolves.toMatchObject({
      success: false,
      code: 'timeout',
    });
  });
});
