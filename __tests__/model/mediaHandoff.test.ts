import type OpenAI from 'openai';

const readRunResource = jest.fn();
jest.mock('@/backend/services/runResources', () => ({
  readRunResource: (...args: unknown[]) => readRunResource(...args),
}));

import {
  filterUnsupportedMediaInputs,
  hydrateRunResourceMedia,
} from '@/backend/services/model/mediaHandoff';

describe('cross-provider media hydration', () => {
  beforeEach(() => {
    readRunResource.mockReset();
  });

  it('hydrates image and video run resources into private data URLs at dispatch', async () => {
    readRunResource
      .mockResolvedValueOnce({
        entry: { mimeType: 'image/png' },
        contents: {
          contents: [{
            uri: 'flujo://run/conv/image',
            mimeType: 'image/png',
            blob: 'IMAGE',
          }],
        },
      })
      .mockResolvedValueOnce({
        entry: { mimeType: 'video/mp4' },
        contents: {
          contents: [{
            uri: 'flujo://run/conv/video',
            mimeType: 'video/mp4',
            blob: 'VIDEO',
          }],
        },
      });
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: 'Use these.' },
        {
          type: 'image_url',
          image_url: { url: 'flujo://run/conv/image' },
        },
        {
          type: 'video_url',
          video_url: { url: 'flujo://run/conv/video' },
        },
      ],
    }] as unknown as OpenAI.ChatCompletionMessageParam[];

    const hydrated = await hydrateRunResourceMedia(messages, 'node-1');

    expect(hydrated[0].content).toEqual([
      { type: 'text', text: 'Use these.' },
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,IMAGE' },
      },
      {
        type: 'video_url',
        video_url: {
          url: 'data:video/mp4;base64,VIDEO',
          mime_type: 'video/mp4',
        },
      },
    ]);
    expect(readRunResource).toHaveBeenNthCalledWith(1, 'flujo://run/conv/image', {
      at: expect.any(Number),
      source: 'node',
      nodeId: 'node-1',
    });
  });

  it('converts supported audio resources to OpenAI input_audio parts', async () => {
    readRunResource.mockResolvedValue({
      entry: { mimeType: 'audio/mpeg' },
      contents: {
        contents: [{
          uri: 'flujo://run/conv/audio',
          mimeType: 'audio/mpeg',
          blob: 'AUDIO',
        }],
      },
    });
    const messages = [{
      role: 'user',
      content: [{
        type: 'audio_url',
        audio_url: { url: 'flujo://run/conv/audio' },
      }],
    }] as unknown as OpenAI.ChatCompletionMessageParam[];

    const hydrated = await hydrateRunResourceMedia(messages);

    expect(hydrated[0].content).toEqual([{
      type: 'input_audio',
      input_audio: { data: 'AUDIO', format: 'mp3' },
    }]);
  });

  it('fails clearly when persisted media has disappeared', async () => {
    readRunResource.mockResolvedValue(null);
    const messages = [{
      role: 'user',
      content: [{
        type: 'video_url',
        video_url: { url: 'flujo://run/conv/missing' },
      }],
    }] as unknown as OpenAI.ChatCompletionMessageParam[];

    await expect(hydrateRunResourceMedia(messages))
      .rejects.toThrow('Generated media resource is unavailable');
  });

  it('drops only explicitly unsupported media for text-only models', () => {
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: 'Continue.' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,IMAGE' } },
        { type: 'video_url', video_url: { url: 'data:video/mp4;base64,VIDEO' } },
      ],
    }] as unknown as OpenAI.ChatCompletionMessageParam[];

    expect(filterUnsupportedMediaInputs(messages, ['text'])).toEqual([{
      role: 'user',
      content: [{ type: 'text', text: 'Continue.' }],
    }]);
    expect(filterUnsupportedMediaInputs(messages, undefined)).toBe(messages);
    expect(filterUnsupportedMediaInputs(messages, ['text', 'video'])).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'Continue.' },
        { type: 'video_url', video_url: { url: 'data:video/mp4;base64,VIDEO' } },
      ],
    }]);
  });
});
