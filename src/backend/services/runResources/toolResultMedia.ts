import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ModelMediaPart, ModelMediaType } from '@/shared/types/model/media';
import { mediaTypeFromMime } from '@/shared/types/model/media';
import type { RunResourceEntry } from '@/shared/types/runResources';

/**
 * Media items inside an MCP tool result (issue #365 follow-up).
 *
 * A tool can hand back pixels or sound, and those bytes must reach the next
 * model through a real INPUT channel — an `image_url`/`input_audio` part on the
 * OpenAI-compatible wire, or a native content block on the self-orchestrating
 * adapters. Two rules follow from that, and this module exists to make both
 * cheap to apply consistently:
 *
 *  1. Media must never take part in the tool-result SIZE bound. Bounding is a
 *     context-cost guard for text; base64 measured against a byte budget just
 *     silently deletes the picture (a 37 KB image already blows a 50 KB budget
 *     once JSON-stringified), which is the most confusing possible failure
 *     mode. Split the media out, bound the text, put the media back.
 *  2. What replaces media in the TEXT projection must stay honest — a short
 *     placeholder, so a transcript reader sees that an item existed rather
 *     than an unexplained gap.
 *
 * The MCP SDK's content union has no 'video' member, so items are inspected
 * through a loose record view; FLUJO's own filesystem server emits exactly that
 * shape (`type: 'video'`) and it must not fall through unhandled.
 */

type ContentItem = CallToolResult['content'][number];
type LooseItem = { type?: string; mimeType?: string; data?: string; resource?: Record<string, unknown> };

/** Content-item `type` values that carry binary media directly. */
const DIRECT_MEDIA_TYPES = new Set(['image', 'audio', 'video']);

/**
 * The media type of a content item, or undefined when it is not media.
 * Covers direct image/audio/video items and embedded `resource` blobs whose
 * MIME says they are media.
 */
export function toolMediaType(item: ContentItem): ModelMediaType | undefined {
  const loose = item as LooseItem;
  if (loose.type && DIRECT_MEDIA_TYPES.has(loose.type)) {
    // Trust the declared item type; fall back to the MIME when it disagrees.
    return loose.type as ModelMediaType;
  }
  if (loose.type === 'resource' && loose.resource && typeof loose.resource.blob === 'string') {
    const mime = typeof loose.resource.mimeType === 'string' ? loose.resource.mimeType : undefined;
    const derived = mediaTypeFromMime(mime);
    return derived === 'file' ? undefined : derived;
  }
  return undefined;
}

export function isMediaContentItem(item: ContentItem): boolean {
  return toolMediaType(item) !== undefined;
}

/**
 * Build an inline provider-neutral media part when persistence is unavailable
 * or deliberately disabled. This is the lossless fallback for ephemeral runs:
 * the bytes stay out of the tool-result text projection but still reach the
 * model through its native input channel.
 */
export function mediaPartFromToolItem(item: ContentItem): ModelMediaPart | undefined {
  const type = toolMediaType(item);
  const data = toolMediaData(item);
  if (!type || !data) return undefined;
  const mimeType = toolMediaMime(item);
  return {
    type,
    data,
    ...(mimeType ? { mimeType } : {}),
  };
}

/** MIME of a media content item, direct or embedded. */
export function toolMediaMime(item: ContentItem): string | undefined {
  const loose = item as LooseItem;
  if (typeof loose.mimeType === 'string') return loose.mimeType;
  const nested = loose.resource?.mimeType;
  return typeof nested === 'string' ? nested : undefined;
}

/** Base64 payload of a media content item, direct or embedded. */
export function toolMediaData(item: ContentItem): string | undefined {
  const loose = item as LooseItem;
  if (typeof loose.data === 'string') return loose.data;
  const blob = loose.resource?.blob;
  return typeof blob === 'string' ? blob : undefined;
}

function placeholderFor(item: ContentItem, mediaType: ModelMediaType): ContentItem {
  const mime = toolMediaMime(item) ?? mediaType;
  const bytes = toolMediaData(item)?.length;
  const size = bytes ? ` ~${Math.round((bytes * 3) / 4 / 1024)} KB` : '';
  return {
    type: 'text',
    text: `[${mime}${size} media item returned by this tool; delivered to the model as a native ${mediaType} input rather than inline base64]`,
  } as ContentItem;
}

export interface SplitToolResultMedia {
  /** The media content items, untouched, in original order. */
  mediaItems: ContentItem[];
  /**
   * The same result with every media item replaced by a short text
   * placeholder. Safe to stringify and measure against a size budget.
   */
  textResult: CallToolResult;
  hasMedia: boolean;
}

/**
 * Separate media content items from the rest of a tool result.
 *
 * Callers bound/stringify `textResult` and re-attach `mediaItems` to whatever
 * the model actually consumes, so a size bound can never delete a picture.
 */
export function splitToolResultMedia(result: CallToolResult): SplitToolResultMedia {
  if (!result || !Array.isArray(result.content)) {
    return { mediaItems: [], textResult: result, hasMedia: false };
  }
  const mediaItems: ContentItem[] = [];
  const textContent: ContentItem[] = [];
  for (const item of result.content) {
    const mediaType = toolMediaType(item);
    if (mediaType) {
      mediaItems.push(item);
      textContent.push(placeholderFor(item, mediaType));
    } else {
      textContent.push(item);
    }
  }
  if (mediaItems.length === 0) {
    return { mediaItems: [], textResult: result, hasMedia: false };
  }
  return {
    mediaItems,
    textResult: { ...result, content: textContent },
    hasMedia: true,
  };
}

/**
 * Build the provider-neutral media part for a stored run resource.
 *
 * Mirrors what `persistModelMedia` produces for assistant-generated media: the
 * durable `flujo://run/...` identity plus an optional host path, and crucially
 * NO base64 — `hydrateRunResourceMedia` resolves the URI to a data URL at the
 * last moment before the provider call, so conversation storage, debugger
 * snapshots and context estimates never balloon.
 */
export function mediaPartFromEntry(
  entry: RunResourceEntry,
  mediaType: ModelMediaType,
  localPath?: string | null,
): ModelMediaPart {
  return {
    type: mediaType,
    ...(entry.mimeType ? { mimeType: entry.mimeType } : {}),
    ...(entry.name ? { name: entry.name } : {}),
    resourceUri: entry.uri,
    ...(localPath ? { localPath } : {}),
  };
}
