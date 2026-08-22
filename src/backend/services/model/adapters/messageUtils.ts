import OpenAI from 'openai';
import type { ModelMediaPart } from '@/shared/types/model/media';
import { mediaTypeFromMime } from '@/shared/types/model/media';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

/**
 * Flatten an OpenAI message `content` value to plain text. Handles the string
 * form and the multi-part array form (keeping only text parts; non-text parts
 * such as images are dropped, since the native adapters here are text+tools).
 */
export function extractText(
  content: OpenAI.ChatCompletionMessageParam['content']
): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part): part is OpenAI.ChatCompletionContentPartText =>
        !!part && (part as { type?: string }).type === 'text'
      )
      .map(part => part.text)
      .join('');
  }
  return '';
}

/**
 * An image carried by an OpenAI `image_url` content part. When the URL is a
 * `data:` URL we parse out the MIME type and the base64 payload (the common
 * case — pasted screenshots arrive as data URLs); for a remote `http(s)` URL we
 * keep only `url` so adapters that support URL image sources can pass it on.
 */
export interface ImagePart {
  /** The raw URL from the part — a `data:` URL or an `http(s)` URL. */
  url: string;
  /** Parsed MIME type, when `url` is a base64 `data:` URL (e.g. `image/png`). */
  mimeType?: string;
  /** Parsed base64 payload, when `url` is a base64 `data:` URL. */
  base64?: string;
}

// data:[<mime>][;base64],<payload>  — `[\s\S]` matches across newlines without
// the `s` flag (which needs an es2018 target this project doesn't compile to).
const DATA_URL_RE = /^data:([^;,]+)(?:;[^,]*)?,([\s\S]*)$/;

export function parseDataUrl(url: string): { mimeType: string; base64: string } | undefined {
  const match = DATA_URL_RE.exec(url);
  if (!match || !/;base64/i.test(url)) return undefined;
  return { mimeType: match[1], base64: match[2] };
}

/**
 * Pull image content parts out of an OpenAI message `content`. Returns [] for
 * the string form (no images) and for messages with no `image_url` parts. The
 * native adapters use this alongside {@link extractText} to forward images that
 * {@link extractText} deliberately drops.
 */
export function extractImageParts(
  content: OpenAI.ChatCompletionMessageParam['content']
): ImagePart[] {
  if (!Array.isArray(content)) return [];
  const out: ImagePart[] = [];
  for (const part of content) {
    if (!part || (part as { type?: string }).type !== 'image_url') continue;
    const url = (part as OpenAI.ChatCompletionContentPartImage).image_url?.url;
    if (!url) continue;
    const parsed = parseDataUrl(url);
    if (parsed) {
      out.push({ url, mimeType: parsed.mimeType, base64: parsed.base64 });
    } else {
      out.push({ url });
    }
  }
  return out;
}

const AUDIO_FORMAT_MIME: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  opus: 'audio/opus',
  pcm16: 'audio/pcm',
};

/**
 * Extract every media part FLUJO accepts on its OpenAI-shaped internal wire.
 * Standard image/input-audio parts and FLUJO's video/file extensions are all
 * normalized here so native adapters do not each invent their own parser.
 */
export function extractMediaParts(content: unknown): ModelMediaPart[] {
  if (!Array.isArray(content)) return [];
  const media: ModelMediaPart[] = [];

  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const part = raw as UnknownRecord;
    const imageUrl = asRecord(part.image_url);
    const inputAudio = asRecord(part.input_audio);

    if (part.type === 'image_url' && typeof imageUrl?.url === 'string') {
      const parsed = parseDataUrl(imageUrl.url);
      media.push({
        type: 'image',
        url: imageUrl.url,
        ...(parsed ? { mimeType: parsed.mimeType, data: parsed.base64 } : {}),
      });
      continue;
    }

    if (part.type === 'input_audio' && typeof inputAudio?.data === 'string') {
      const format = String(inputAudio.format ?? 'wav').toLowerCase();
      media.push({
        type: 'audio',
        mimeType: AUDIO_FORMAT_MIME[format] ?? `audio/${format}`,
        data: inputAudio.data,
      });
      continue;
    }

    const urlContainer =
      part.type === 'audio_url' ? asRecord(part.audio_url)
        : part.type === 'video_url' ? asRecord(part.video_url)
          : undefined;
    if (urlContainer && typeof urlContainer.url === 'string') {
      const parsed = parseDataUrl(urlContainer.url);
      const fallbackType = part.type === 'audio_url' ? 'audio' : 'video';
      const mimeType = parsed?.mimeType
        ?? (typeof urlContainer.mime_type === 'string' ? urlContainer.mime_type : undefined);
      media.push({
        type: fallbackType,
        url: urlContainer.url,
        ...(mimeType ? { mimeType } : {}),
        ...(parsed ? { data: parsed.base64 } : {}),
      });
      continue;
    }

    if (part.type === 'file' || part.type === 'input_file') {
      const file = asRecord(part.file) ?? part;
      const url = file.url ?? file.file_url ?? file.file_data;
      const parsed = typeof url === 'string' ? parseDataUrl(url) : undefined;
      const rawMimeType = parsed?.mimeType ?? file.mime_type ?? file.mimeType;
      const mimeType = typeof rawMimeType === 'string' ? rawMimeType : undefined;
      const rawName = file.filename ?? file.name;
      const name = typeof rawName === 'string' ? rawName : undefined;
      media.push({
        type: mediaTypeFromMime(mimeType),
        ...(typeof url === 'string' ? { url } : {}),
        ...(parsed ? { data: parsed.base64 } : {}),
        ...(mimeType ? { mimeType } : {}),
        ...(name ? { name } : {}),
      });
    }
  }
  return media;
}

/**
 * Normalize provider extensions on an assistant message. OpenRouter returns
 * generated images in `message.images`; OpenAI audio models use
 * `message.audio`; compatible gateways may expose equivalent audio/video/file
 * arrays. Unknown entries are ignored rather than poisoning the completion.
 */
export function extractAssistantMedia(message: unknown): ModelMediaPart[] {
  if (!message || typeof message !== 'object') return [];
  const candidate = message as Record<string, unknown>;
  const out: ModelMediaPart[] = [
    ...extractMediaParts(candidate.content),
    ...extractNativeMediaParts(candidate.content),
  ];

  const collectUrlArray = (field: string, type: ModelMediaPart['type']) => {
    const entries = candidate[field];
    if (!Array.isArray(entries)) return;
    for (const rawEntry of entries) {
      const entry = asRecord(rawEntry);
      if (!entry) continue;
      const url =
        asRecord(entry.image_url)?.url ??
        asRecord(entry.audio_url)?.url ??
        asRecord(entry.video_url)?.url ??
        asRecord(entry.file_url)?.url ??
        entry.url;
      const data = entry.data;
      if (typeof url !== 'string' && typeof data !== 'string') continue;
      const parsed = typeof url === 'string' ? parseDataUrl(url) : undefined;
      const rawMimeType = parsed?.mimeType ?? entry.mimeType ?? entry.mime_type;
      const mimeType = typeof rawMimeType === 'string' ? rawMimeType : undefined;
      out.push({
        type,
        ...(typeof url === 'string' ? { url } : {}),
        ...(typeof data === 'string' ? { data } : parsed ? { data: parsed.base64 } : {}),
        ...(mimeType ? { mimeType } : {}),
        ...(typeof entry.name === 'string' ? { name: entry.name } : {}),
      });
    }
  };

  collectUrlArray('images', 'image');
  collectUrlArray('audios', 'audio');
  collectUrlArray('videos', 'video');
  collectUrlArray('files', 'file');

  const audio = asRecord(candidate.audio);
  if (audio) {
    if (typeof audio.data === 'string') {
      const rawMimeType = audio.mime_type ?? audio.mimeType;
      out.push({
        type: 'audio',
        data: audio.data,
        mimeType: typeof rawMimeType === 'string' ? rawMimeType : 'audio/mpeg',
        ...(typeof audio.transcript === 'string' ? { transcript: audio.transcript } : {}),
      });
    }
  }

  return out.filter((part, index, all) => {
    const key = `${part.type}|${part.url ?? ''}|${part.data ?? ''}|${part.mimeType ?? ''}`;
    return all.findIndex(candidatePart =>
      `${candidatePart.type}|${candidatePart.url ?? ''}|${candidatePart.data ?? ''}|${candidatePart.mimeType ?? ''}` === key
    ) === index;
  });
}

/**
 * Best-effort normalization for SDK-native content blocks. This keeps the
 * Claude Agent SDK and Codex transcript adapters future-proof without claiming
 * that their current text-output models generate media.
 */
export function extractNativeMediaParts(value: unknown): ModelMediaPart[] {
  const items = Array.isArray(value) ? value : [value];
  const out: ModelMediaPart[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const block = item as UnknownRecord;
    const inline = asRecord(block.inlineData) ?? asRecord(block.inline_data);
    const source = asRecord(block.source) ?? inline ?? block;
    const mimeType =
      source.mimeType ??
      source.mime_type ??
      source.media_type ??
      block.mimeType ??
      block.mime_type;
    const explicitType = String(block.type ?? '').toLowerCase();
    const isMediaBlock =
      ['image', 'audio', 'video', 'file', 'document', 'generated_image'].includes(explicitType) ||
      Boolean(inline) ||
      (typeof mimeType === 'string' &&
        /^(image|audio|video)\//i.test(mimeType));
    if (!isMediaBlock) continue;

    const data = source.data ?? block.data;
    const url =
      source.url ??
      source.uri ??
      source.fileUri ??
      block.url ??
      block.uri;
    if (typeof data !== 'string' && typeof url !== 'string') continue;
    out.push({
      type: explicitType === 'document' || explicitType === 'file'
        ? 'file'
        : mediaTypeFromMime(typeof mimeType === 'string' ? mimeType : undefined),
      ...(typeof data === 'string' ? { data } : {}),
      ...(typeof url === 'string' ? { url } : {}),
      ...(typeof mimeType === 'string' ? { mimeType } : {}),
      ...(typeof block.name === 'string' ? { name: block.name } : {}),
      ...(typeof block.transcript === 'string' ? { transcript: block.transcript } : {}),
    });
  }
  return out;
}

/**
 * Anthropic's base64 image source accepts only this fixed set of MIME types.
 * Normalize a parsed MIME type to one of them, defaulting unknown/odd values
 * (e.g. a clipboard quirk) to PNG — the format browsers emit for pasted
 * screenshots.
 */
export function toAnthropicImageMediaType(
  mimeType: string | undefined
): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' {
  switch ((mimeType || '').toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':
      return 'image/jpeg';
    case 'image/gif':
      return 'image/gif';
    case 'image/webp':
      return 'image/webp';
    case 'image/png':
    default:
      return 'image/png';
  }
}

/**
 * Truncate a string to `cap` characters, appending a byte-count marker when it
 * was shortened. Used by self-orchestrating adapters (Claude subscription) that
 * flatten prior tool calls/results into a single text prompt: an unbounded tool
 * result (a directory tree, a large file read) would otherwise blow up the
 * flattened prompt. Returns the input unchanged when it already fits, so the
 * no-truncation path is byte-identical.
 */
export function truncateForPrompt(text: string, cap: number): string {
  if (typeof text !== 'string' || text.length <= cap) return text ?? '';
  return `${text.slice(0, cap)}…[truncated ${text.length - cap} chars]`;
}

/** Safely JSON-parse a tool-call arguments string, defaulting to `{}`. */
export function parseToolArgs(argsString: string | undefined): Record<string, unknown> {
  if (!argsString) return {};
  try {
    const parsed = JSON.parse(argsString);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
