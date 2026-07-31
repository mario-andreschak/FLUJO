import type { Model } from '@/shared/types/model';
import { getCompletionAdapter, OpenRouterMediaAdapter } from '@/backend/services/model/adapters';

const model = (output: 'image' | 'video'): Model => ({
  id: `model-${output}`,
  name: output === 'video'
    ? 'kwaivgi/kling-v3.0-std'
    : 'x-ai/grok-imagine-image-quality',
  ApiKey: 'encrypted',
  provider: 'openrouter',
  adapter: 'openai',
  baseUrl: 'https://openrouter.ai/api/v1',
  inputModalities: ['text', 'image'],
  outputModalities: [output],
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function binaryResponse(bytes: string, contentType = 'video/mp4'): Response {
  const body = Buffer.from(bytes);
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: (name: string) => name.toLowerCase() === 'content-type' ? contentType : null },
    arrayBuffer: async () =>
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  } as unknown as Response;
}

describe('OpenRouter dedicated media adapter', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('is selected for OpenRouter image and video output models', () => {
    expect(getCompletionAdapter(model('image'))).toBeInstanceOf(OpenRouterMediaAdapter);
    expect(getCompletionAdapter(model('video'))).toBeInstanceOf(OpenRouterMediaAdapter);
  });

  it('uses POST /images and normalizes base64 image output', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(jsonResponse({
      created: 123,
      data: [{ b64_json: 'PNGDATA', media_type: 'image/png' }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }));
    const adapter = new OpenRouterMediaAdapter();

    const result = await adapter.createCompletion({
      model: model('image'),
      apiKey: 'sk-or',
      temperature: 0,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Restyle this as watercolor.' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,SOURCE' } },
        ],
      }],
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe('https://openrouter.ai/api/v1/images');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer sk-or',
      'HTTP-Referer': 'https://flujo.com.co',
      'X-Title': 'FLUJO',
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'x-ai/grok-imagine-image-quality',
      prompt: 'Restyle this as watercolor.',
      input_references: [{
        type: 'image_url',
        image_url: { url: 'data:image/jpeg;base64,SOURCE' },
      }],
    });
    expect(result.media).toEqual([{
      type: 'image',
      data: 'PNGDATA',
      mimeType: 'image/png',
    }]);
  });

  it('submits, polls, and downloads an image-to-video job without leaking the API key', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({
        id: 'job-1',
        polling_url: '/api/v1/videos/job-1',
        status: 'pending',
      }, 202))
      .mockResolvedValueOnce(jsonResponse({
        id: 'job-1',
        generation_id: 'generation-1',
        status: 'completed',
        unsigned_urls: ['https://storage.example/video.mp4'],
      }))
      .mockResolvedValueOnce(binaryResponse('VIDEO_BYTES'));
    const attempts = jest.fn();
    const adapter = new OpenRouterMediaAdapter();

    const result = await adapter.createCompletion({
      model: model('video'),
      apiKey: 'sk-or',
      temperature: 0,
      onProviderAttempt: attempts,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Animate it with a slow camera push.' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,FRAME' } },
        ],
      }],
    });

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(String(fetchSpy.mock.calls[0][0])).toBe('https://openrouter.ai/api/v1/videos');
    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toEqual({
      model: 'kwaivgi/kling-v3.0-std',
      prompt: 'Animate it with a slow camera push.',
      frame_images: [{
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,FRAME' },
        frame_type: 'first_frame',
      }],
    });
    expect(String(fetchSpy.mock.calls[1][0]))
      .toBe('https://openrouter.ai/api/v1/videos/job-1');
    expect(String(fetchSpy.mock.calls[2][0]))
      .toBe('https://storage.example/video.mp4');
    expect(fetchSpy.mock.calls[2][1]?.headers).toBeUndefined();
    expect(result.media).toEqual([{
      type: 'video',
      data: Buffer.from('VIDEO_BYTES').toString('base64'),
      mimeType: 'video/mp4',
    }]);
    expect(attempts).toHaveBeenCalledTimes(3);
  });

  it('falls back to the authenticated content endpoint when no unsigned URL is returned', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({
        id: 'job-2',
        status: 'completed',
      }, 202))
      .mockResolvedValueOnce(binaryResponse('VIDEO'));
    const adapter = new OpenRouterMediaAdapter();

    await adapter.createCompletion({
      model: model('video'),
      apiKey: 'sk-or',
      temperature: 0,
      messages: [{ role: 'user', content: 'Create a short clip.' }],
    });

    expect(String(fetchSpy.mock.calls[1][0]))
      .toBe('https://openrouter.ai/api/v1/videos/job-2/content?index=0');
    expect(fetchSpy.mock.calls[1][1]?.headers).toEqual({
      Authorization: 'Bearer sk-or',
    });
  });

  it('surfaces terminal video job failures', async () => {
    jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({
        id: 'job-failed',
        status: 'pending',
      }, 202))
      .mockResolvedValueOnce(jsonResponse({
        id: 'job-failed',
        status: 'failed',
        error: 'Content policy violation',
      }));

    await expect(new OpenRouterMediaAdapter().createCompletion({
      model: model('video'),
      apiKey: 'sk-or',
      temperature: 0,
      messages: [{ role: 'user', content: 'Create a clip.' }],
    })).rejects.toThrow('Content policy violation');
  });
});
