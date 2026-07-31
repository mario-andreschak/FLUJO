import type OpenAI from 'openai';
import type { FlujoChatMessage } from '@/shared/types/chat';
import type { Model } from '@/shared/types/model';

const readRunResource = jest.fn();
jest.mock('@/backend/services/runResources', () => ({
  readRunResource: (...args: unknown[]) => readRunResource(...args),
}));

import { toApiMessages } from '@/backend/execution/flow/buildNodeContext';
import { hydrateRunResourceMedia } from '@/backend/services/model/mediaHandoff';
import { OpenRouterMediaAdapter } from '@/backend/services/model/adapters';
import { toGeminiContents } from '@/backend/services/model/adapters/geminiAdapter';

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    headers: { get: (name: string) => name.toLowerCase() === 'content-type' ? 'application/json' : null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function videoResponse(): Response {
  const body = Buffer.from('VIDEO_BYTES');
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => 'video/mp4' },
    arrayBuffer: async () =>
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  } as unknown as Response;
}

const kling: Model = {
  id: 'kling',
  name: 'kwaivgi/kling-v3.0-std',
  ApiKey: 'encrypted',
  provider: 'openrouter',
  adapter: 'openai',
  baseUrl: 'https://openrouter.ai/api/v1',
  inputModalities: ['text', 'image'],
  outputModalities: ['video'],
};

describe('image → OpenRouter video → Gemini recognition chain', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    readRunResource.mockReset();
  });

  it('carries private generated media across both provider boundaries', async () => {
    readRunResource.mockResolvedValueOnce({
      entry: { mimeType: 'image/png' },
      contents: {
        contents: [{
          uri: 'flujo://run/conv/generated-image',
          mimeType: 'image/png',
          blob: 'GENERATED_IMAGE',
        }],
      },
    });
    const imageConversation = [
      {
        role: 'assistant',
        content: [{
          type: 'image_url',
          image_url: { url: '/v1/chat/resources/generated-image/content' },
        }],
        media: [{
          type: 'image',
          resourceUri: 'flujo://run/conv/generated-image',
          url: '/v1/chat/resources/generated-image/content',
          mimeType: 'image/png',
        }],
        id: 'assistant-image',
        timestamp: 1,
      },
      {
        role: 'user',
        content: 'Animate this character walking into the sunset.',
        id: 'user-video',
        timestamp: 2,
      },
    ] as unknown as FlujoChatMessage[];
    const klingWire = await hydrateRunResourceMedia(toApiMessages(imageConversation), 'kling-node');

    const fetchSpy = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(response({
        id: 'video-job',
        status: 'completed',
      }, 202))
      .mockResolvedValueOnce(videoResponse());
    const video = await new OpenRouterMediaAdapter().createCompletion({
      model: kling,
      apiKey: 'sk-or',
      messages: klingWire,
      temperature: 0,
    });

    const submitBody = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));
    expect(submitBody.frame_images[0].image_url.url)
      .toBe('data:image/png;base64,GENERATED_IMAGE');
    expect(video.media?.[0]).toMatchObject({
      type: 'video',
      mimeType: 'video/mp4',
    });

    readRunResource.mockResolvedValueOnce({
      entry: { mimeType: 'video/mp4' },
      contents: {
        contents: [{
          uri: 'flujo://run/conv/generated-video',
          mimeType: 'video/mp4',
          blob: video.media?.[0].data,
        }],
      },
    });
    const videoConversation = [
      {
        role: 'assistant',
        content: null,
        media: [{
          type: 'video',
          resourceUri: 'flujo://run/conv/generated-video',
          url: '/v1/chat/resources/generated-video/content',
          mimeType: 'video/mp4',
        }],
        id: 'assistant-video',
        timestamp: 3,
      },
      {
        role: 'user',
        content: 'Describe the motion and composition.',
        id: 'user-gemini',
        timestamp: 4,
      },
    ] as unknown as FlujoChatMessage[];
    const geminiWire = await hydrateRunResourceMedia(
      toApiMessages(videoConversation),
      'gemini-node',
    );
    const gemini = await toGeminiContents(
      geminiWire as OpenAI.ChatCompletionMessageParam[],
    );

    expect(gemini.contents[1].parts).toEqual([
      { text: 'Describe the motion and composition.' },
      {
        inlineData: {
          mimeType: 'video/mp4',
          data: Buffer.from('VIDEO_BYTES').toString('base64'),
        },
      },
    ]);
  });
});
