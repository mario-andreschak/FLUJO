import OpenAI from 'openai';

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
    const m = DATA_URL_RE.exec(url);
    if (m && /;base64/i.test(url)) {
      out.push({ url, mimeType: m[1], base64: m[2] });
    } else {
      out.push({ url });
    }
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
