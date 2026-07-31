import OpenAI from 'openai';
import { readRunResource } from '@/backend/services/runResources';

type WirePart = Record<string, any>;

function partInputModality(part: WirePart): string | undefined {
  if (part.type === 'image_url' || part.type === 'input_image') return 'image';
  if (part.type === 'audio_url' || part.type === 'input_audio') return 'audio';
  if (part.type === 'video_url' || part.type === 'input_video') return 'video';
  if (part.type === 'file' || part.type === 'input_file') return 'file';
  return undefined;
}

/**
 * Respect explicit provider capability metadata. Unknown catalogues stay
 * permissive for backward compatibility; a model that explicitly advertises
 * text-only input does not receive stale generated binary attachments.
 */
export function filterUnsupportedMediaInputs(
  messages: OpenAI.ChatCompletionMessageParam[],
  inputModalities?: string[],
): OpenAI.ChatCompletionMessageParam[] {
  if (!inputModalities?.length) return messages;
  const supported = new Set(inputModalities.map(value => value.toLowerCase()));
  if (supported.has('vision')) supported.add('image');
  if (supported.has('document') || supported.has('pdf')) supported.add('file');

  return messages.map(message => {
    if (!Array.isArray(message.content)) return message;
    const content = message.content.filter(rawPart => {
      const modality = partInputModality(rawPart as unknown as WirePart);
      return !modality || supported.has(modality);
    });
    return content.length === message.content.length
      ? message
      : { ...message, content } as OpenAI.ChatCompletionMessageParam;
  });
}

function referencedUri(part: WirePart): string | undefined {
  if (part.type === 'image_url') return part.image_url?.url;
  if (part.type === 'audio_url') return part.audio_url?.url;
  if (part.type === 'video_url') return part.video_url?.url;
  if (part.type === 'file' || part.type === 'input_file') {
    const file = part.file ?? part;
    return file.file_data ?? file.file_url ?? file.url;
  }
  return undefined;
}

function replaceReferencedUri(
  part: WirePart,
  dataUrl: string,
  mimeType: string,
  blob: string,
): WirePart {
  if (part.type === 'image_url') {
    return { ...part, image_url: { ...part.image_url, url: dataUrl } };
  }
  if (part.type === 'video_url') {
    return {
      ...part,
      video_url: { ...part.video_url, url: dataUrl, mime_type: mimeType },
    };
  }
  if (part.type === 'audio_url') {
    const format =
      mimeType === 'audio/mpeg' ? 'mp3'
        : mimeType === 'audio/wav' || mimeType === 'audio/x-wav' ? 'wav'
          : undefined;
    return format
      ? { type: 'input_audio', input_audio: { data: blob, format } }
      : {
          ...part,
          audio_url: { ...part.audio_url, url: dataUrl, mime_type: mimeType },
        };
  }
  if (part.type === 'file' || part.type === 'input_file') {
    const file = part.file ?? part;
    return {
      type: 'file',
      file: {
        ...file,
        file_data: dataUrl,
        mime_type: mimeType,
      },
    };
  }
  return part;
}

/**
 * Resolve durable flujo:// media references at the last possible moment.
 *
 * The conversation and the pre-flight wire keep only small URIs, so history
 * storage, debugger snapshots, cache fingerprints, and context estimates do not
 * balloon with base64. Native/provider adapters receive ordinary data URLs.
 */
export async function hydrateRunResourceMedia(
  messages: OpenAI.ChatCompletionMessageParam[],
  nodeId?: string,
): Promise<OpenAI.ChatCompletionMessageParam[]> {
  return Promise.all(messages.map(async (message) => {
    if (!Array.isArray(message.content)) return message;
    const content = await Promise.all(message.content.map(async (rawPart) => {
      const part = rawPart as unknown as WirePart;
      const uri = referencedUri(part);
      if (!uri?.startsWith('flujo://run/')) return rawPart;
      const read = await readRunResource(uri, {
        at: Date.now(),
        source: 'node',
        nodeId,
      });
      const contentItem = read?.contents.contents[0];
      const blob =
        contentItem && typeof (contentItem as { blob?: unknown }).blob === 'string'
          ? (contentItem as { blob: string }).blob
          : undefined;
      if (!read || !blob) {
        throw new Error(`Generated media resource is unavailable: ${uri}`);
      }
      const mimeType =
        (contentItem as { mimeType?: string }).mimeType ??
        read.entry.mimeType ??
        'application/octet-stream';
      return replaceReferencedUri(part, `data:${mimeType};base64,${blob}`, mimeType, blob);
    }));
    return { ...message, content } as OpenAI.ChatCompletionMessageParam;
  }));
}
