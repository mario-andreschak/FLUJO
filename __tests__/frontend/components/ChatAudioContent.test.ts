import {
  buildApiContent,
  type Attachment,
  type ChatMessage,
} from '@/frontend/components/Chat';

const audioMessage = (attachment: Attachment): ChatMessage => ({
  id: 'message',
  role: 'user',
  content: '',
  attachments: [attachment],
} as ChatMessage);

describe('chat audio API content', () => {
  it.each([
    ['audio/wav', 'wav'],
    ['audio/mpeg', 'mp3'],
  ])('uses input_audio for %s recordings', (mimeType, format) => {
    const content = buildApiContent(audioMessage({
      id: 'audio',
      type: 'audio',
      content: `data:${mimeType};base64,YXVkaW8=`,
      mimeType,
    })) as Array<Record<string, unknown>>;

    expect(content).toEqual([
      {
        type: 'input_audio',
        input_audio: {
          data: 'YXVkaW8=',
          format,
        },
      },
    ]);
  });

  it('preserves Chrome WebM as an audio URL without relabeling it', () => {
    const content = buildApiContent(audioMessage({
      id: 'audio',
      type: 'audio',
      content: 'data:audio/webm;codecs=opus;base64,YXVkaW8=',
      mimeType: 'audio/webm;codecs=opus',
    })) as Array<Record<string, unknown>>;

    expect(content).toEqual([
      {
        type: 'audio_url',
        audio_url: {
          url: 'data:audio/webm;codecs=opus;base64,YXVkaW8=',
          mime_type: 'audio/webm;codecs=opus',
        },
      },
    ]);
  });

  it('includes only non-empty transcripts', () => {
    const withTranscript = buildApiContent(audioMessage({
      id: 'audio',
      type: 'audio',
      content: 'data:audio/webm;base64,YXVkaW8=',
      mimeType: 'audio/webm',
      transcript: 'spoken words',
    })) as Array<Record<string, unknown>>;
    const withoutTranscript = buildApiContent(audioMessage({
      id: 'audio',
      type: 'audio',
      content: 'data:audio/webm;base64,YXVkaW8=',
      mimeType: 'audio/webm',
      transcript: '',
    })) as Array<Record<string, unknown>>;

    expect(withTranscript).toContainEqual({
      type: 'text',
      text: '[Audio transcript]: spoken words',
    });
    expect(withoutTranscript).not.toContainEqual(
      expect.objectContaining({
        text: expect.stringContaining('[Audio transcript]'),
      }),
    );
  });
});
