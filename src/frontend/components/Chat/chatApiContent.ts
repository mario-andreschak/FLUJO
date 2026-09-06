import type OpenAI from 'openai';
import type { FlujoChatMessage } from '@/shared/types/chat';

export interface Attachment {
  id: string;
  type: 'document' | 'audio' | 'image' | 'video';
  // Plain documents contain text. Binary audio/image/video attachments use a
  // `data:` URL; audio transcription text is kept separately below.
  content: string;
  originalName?: string;
  mimeType?: string;
  /** Optional text transcript retained alongside a raw audio attachment. */
  transcript?: string;
}

export type ChatMessage = FlujoChatMessage & {
  attachments?: Attachment[];
};

/**
 * Build the OpenAI-wire content for a message about to be sent to the API.
 * Kept independent from the Chat render tree so serializers and their tests do
 * not load UI-only dependencies such as Markdown renderers.
 */
export function buildApiContent(
  msg: ChatMessage,
): OpenAI.ChatCompletionUserMessageParam['content'] {
  if (Array.isArray(msg.content)) {
    return msg.content as OpenAI.ChatCompletionUserMessageParam['content'];
  }

  let text = typeof msg.content === 'string' ? msg.content : '';
  const attachments = msg.attachments ?? [];
  const textAttachments = attachments.filter(
    attachment =>
      attachment.type === 'document' &&
      !attachment.content.startsWith('data:'),
  );
  const images = attachments.filter(attachment => attachment.type === 'image');
  const binary = attachments.filter(
    attachment =>
      attachment.type !== 'image' &&
      !textAttachments.includes(attachment),
  );

  if (textAttachments.length > 0) {
    text += '\n\n' + textAttachments
      .map(attachment => `[DOCUMENT]: ${attachment.content}`)
      .join('\n\n');
  }
  if (images.length === 0 && binary.length === 0) {
    return text;
  }

  const parts: Array<Record<string, unknown>> = [];
  if (text.trim()) parts.push({ type: 'text', text });

  for (const image of images) {
    parts.push({ type: 'image_url', image_url: { url: image.content } });
  }

  for (const attachment of binary) {
    if (attachment.type === 'audio') {
      const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(attachment.content);
      const mimeType = attachment.mimeType ?? match?.[1];

      if (match && (mimeType === 'audio/wav' || mimeType === 'audio/mpeg')) {
        parts.push({
          type: 'input_audio',
          input_audio: {
            data: match[2],
            format: mimeType === 'audio/mpeg' ? 'mp3' : 'wav',
          },
        });
      } else {
        parts.push({
          type: 'audio_url',
          audio_url: { url: attachment.content, mime_type: mimeType },
        });
      }

      if (attachment.transcript) {
        parts.push({
          type: 'text',
          text: `[Audio transcript]: ${attachment.transcript}`,
        });
      }
    } else if (attachment.type === 'video') {
      parts.push({
        type: 'video_url',
        video_url: {
          url: attachment.content,
          mime_type: attachment.mimeType,
        },
      });
    } else {
      parts.push({
        type: 'file',
        file: {
          file_data: attachment.content,
          filename: attachment.originalName,
          mime_type: attachment.mimeType,
        },
      });
    }
  }

  return parts as unknown as OpenAI.ChatCompletionUserMessageParam['content'];
}
