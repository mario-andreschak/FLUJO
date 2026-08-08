import OpenAI from 'openai';
import { createLogger } from '@/utils/logger';
import {
  getRunResourceLocalPath,
  readRunResource,
} from '@/backend/services/runResources';
import type { ModelMediaPart } from '@/shared/types/model/media';

const log = createLogger('backend/services/model/mediaHandoff');

type WirePart = Record<string, any>;

/**
 * Refresh the host-local projection of persisted media before building model
 * context. `resourceUri` remains the durable identity, while `localPath` is the
 * directly useful reference for filesystem-backed tools. Resolving here also
 * repairs conversations written before local paths were added or after the
 * FLUJO data directory was relocated.
 */
export async function materializeRunResourceMediaPaths(
  parts: ModelMediaPart[],
): Promise<ModelMediaPart[]> {
  let changed = false;
  const resolved = await Promise.all(parts.map(async (part) => {
    if (!part.resourceUri?.startsWith('flujo://run/')) return part;
    const localPath = await getRunResourceLocalPath(part.resourceUri);
    if (localPath === part.localPath) return part;
    changed = true;
    const { localPath: _stalePath, ...withoutPath } = part;
    return localPath ? { ...withoutPath, localPath } : withoutPath;
  }));
  return changed ? resolved : parts;
}

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
  strictOpenAiAudioFormats: boolean,
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
    if (format) {
      return { type: 'input_audio', input_audio: { data: blob, format } };
    }
    // OpenAI's input_audio contract accepts only MP3/WAV. Never relabel OGG,
    // FLAC or M4A bytes as WAV: that corrupts the declared format and still
    // fails at the provider. Keep the companion artifact summary/path as the
    // usable fallback. Native adapters (for example Gemini) remain permissive
    // and receive their supported MIME as an inline audio URL.
    return strictOpenAiAudioFormats
      ? {
          type: 'text',
          text: `[${mimeType} audio attachment is available as an artifact but this OpenAI input channel accepts only MP3 or WAV]`,
        }
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
 *
 * An unresolvable reference DEGRADES rather than throwing. Tool-produced media
 * flows through here on every turn now, and run resources are swept on a
 * retention timer, so a replayed or long-lived conversation will legitimately
 * contain references whose payload is gone. Failing the whole model call over a
 * missing thumbnail would turn a cosmetic gap into a dead flow; the model gets
 * an explicit note instead and can carry on.
 */
export async function hydrateRunResourceMedia(
  messages: OpenAI.ChatCompletionMessageParam[],
  nodeId?: string,
  options: { strictOpenAiAudioFormats?: boolean } = {},
): Promise<OpenAI.ChatCompletionMessageParam[]> {
  return Promise.all(messages.map(async (message) => {
    if (!Array.isArray(message.content)) return message;
    const content = await Promise.all(message.content.map(async (rawPart) => {
      const part = rawPart as unknown as WirePart;
      const uri = referencedUri(part);
      if (!uri?.startsWith('flujo://run/')) return rawPart;
      let read: Awaited<ReturnType<typeof readRunResource>> = null;
      try {
        read = await readRunResource(uri, {
          at: Date.now(),
          source: 'node',
          nodeId,
        });
      } catch (error) {
        log.warn(`Failed to read media run resource ${uri}; sending a placeholder instead`, error);
      }
      const contentItem = read?.contents.contents[0];
      const blob =
        contentItem && typeof (contentItem as { blob?: unknown }).blob === 'string'
          ? (contentItem as { blob: string }).blob
          : undefined;
      if (!read || !blob) {
        log.warn(`Media run resource is unavailable, degrading to a text note: ${uri}`);
        return {
          type: 'text',
          text: `[media attachment unavailable — its stored payload (${uri}) could not be read; it may have passed the run-resource retention window]`,
        } as unknown as typeof rawPart;
      }
      const mimeType =
        (contentItem as { mimeType?: string }).mimeType ??
        read.entry.mimeType ??
        'application/octet-stream';
      return replaceReferencedUri(
        part,
        `data:${mimeType};base64,${blob}`,
        mimeType,
        blob,
        options.strictOpenAiAudioFormats === true,
      );
    }));
    return { ...message, content } as OpenAI.ChatCompletionMessageParam;
  }));
}
