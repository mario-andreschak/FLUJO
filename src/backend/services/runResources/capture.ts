import { createLogger } from '@/utils/logger';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { RunResourceEntry, RunResourceKind, RunResourceSettings } from '@/shared/types/runResources';
import type { ModelMediaPart, ModelMediaType } from '@/shared/types/model/media';
import { writeRunResource, getRunResourceLocalPath } from './index';
import {
  mediaPartFromEntry,
  toolMediaData,
  toolMediaMime,
  toolMediaType,
} from './toolResultMedia';

/**
 * Auto-capture of MCP tool results as run-scoped resources.
 *
 * Decides, per content item of a CallToolResult, whether the item is a data
 * artifact worth tracking (image, audio, embedded blob, large text, native
 * resource_link) or trivial inline output ("file exists", a short listing)
 * that should stay message-only.
 *
 * Binary items are ALWAYS replaced in the returned result by a short stub
 * that carries the run-resource URI — JSON-stringified base64 in a tool
 * message costs context and helps no model. Large TEXT is captured for
 * lineage but kept inline unless `replaceLargeTextWithStub` is enabled,
 * because mutating text results can break flows that parse tool output.
 *
 * Stubbing binary content is only half the job. A model that cannot SEE a
 * screenshot a tool just took is strictly worse off than one that never called
 * the tool, so every captured image/audio/video is ALSO returned as a
 * `ModelMediaPart` in `CaptureOutcome.media`. The caller attaches those parts
 * to the tool message, and `toApiMessages` folds them into the next user turn
 * as real `image_url`/`input_audio` input parts — the media round-trips out of
 * the tool channel and back into the model's INPUT channel, carrying only the
 * durable `flujo://run/...` URI until `hydrateRunResourceMedia` resolves it
 * immediately before the provider call.
 *
 * Capture must never break a run: any store failure keeps the original item
 * and logs.
 */

const log = createLogger('backend/services/runResources/capture');

type ContentItem = CallToolResult['content'][number];

export interface CaptureToolResultInput {
  conversationId: string;
  server: string;
  toolName: string;
  toolCallId: string;
  nodeId?: string;
  result: CallToolResult;
  settings: RunResourceSettings;
}

export interface CaptureOutcome {
  /** The result to put in the tool message (items possibly replaced by stubs). */
  result: CallToolResult;
  /** Every run resource stored for this call (emit resource:write per entry). */
  captured: RunResourceEntry[];
  /**
   * Provider-neutral media captured from this result, to be re-attached as
   * genuine model INPUT (see the module docstring). Carries `resourceUri`, not
   * base64.
   */
  media: ModelMediaPart[];
}

function formatKb(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function stubText(entry: RunResourceEntry): string {
  return `[FLUJO stored this ${entry.mimeType ?? entry.kind} (${formatKb(entry.size)}) as run resource ${entry.uri}. ` +
    `Read it back with the 'read_resource' tool (or the 'flujo' MCP server's resources/read) if needed.]`;
}

/**
 * Stub for media that is simultaneously being re-attached as model input.
 * Says so explicitly: a model that receives the pixels should not waste a turn
 * calling `read_resource` to "look at" what it can already see.
 */
function mediaStubText(entry: RunResourceEntry, mediaType: ModelMediaType): string {
  return `[FLUJO stored this ${entry.mimeType ?? entry.kind} (${formatKb(entry.size)}) as run resource ${entry.uri} ` +
    `and attached it to this turn as ${mediaType} input, so you can perceive it directly if this model accepts ` +
    `${mediaType} input. Use 'read_resource' with that uri for a host-local path (e.g. to pass it to another tool).]`;
}

/** Run-resource kind used to persist a given media type. */
function mediaResourceKind(mediaType: ModelMediaType): RunResourceKind {
  if (mediaType === 'image') return 'image';
  if (mediaType === 'audio') return 'audio';
  return 'blob';
}

export async function captureToolResult(input: CaptureToolResultInput): Promise<CaptureOutcome> {
  const { conversationId, server, toolName, toolCallId, nodeId, result, settings } = input;
  const captured: RunResourceEntry[] = [];
  const media: ModelMediaPart[] = [];

  // Failed calls are diagnostics, not data artifacts.
  if (result.isError || !Array.isArray(result.content)) {
    return { result, captured, media };
  }

  const producedBy = {
    source: 'tool-result' as const,
    nodeId,
    server,
    toolName,
    toolCallId,
  };

  const store = async (
    kind: RunResourceKind,
    data: { text: string } | { base64: string } | undefined,
    mimeType: string | undefined,
    origin?: { server: string; uri: string }
  ): Promise<RunResourceEntry | null> => {
    try {
      const written = await writeRunResource({
        conversationId,
        mimeType,
        kind,
        data,
        producedBy: origin ? { ...producedBy, source: 'mcp-link' } : producedBy,
        origin,
      });
      if ('skipped' in written) {
        log.warn(`Auto-capture skipped (${written.skipped}) for ${server}/${toolName}`);
        return null;
      }
      captured.push(written);
      return written;
    } catch (error) {
      // Capture must never break a run — keep the inline content.
      log.error(`Auto-capture failed for ${server}/${toolName}; keeping inline content`, error);
      return null;
    }
  };

  const newContent: ContentItem[] = [];

  /**
   * Capture one media item: persist the bytes, replace the item with a compact
   * stub, and record a media part so the caller can re-attach it as real model
   * input. Covers image/audio/video items and media-typed embedded blobs.
   */
  const captureMedia = async (
    item: ContentItem,
    mediaType: ModelMediaType,
    origin?: { server: string; uri: string },
  ): Promise<void> => {
    const base64 = toolMediaData(item);
    if (!base64) {
      // Declared media with no payload (e.g. a bare annotation) — nothing to
      // store and nothing to show; leave it exactly as the server sent it.
      newContent.push(item);
      return;
    }
    const entry = await store(mediaResourceKind(mediaType), { base64 }, toolMediaMime(item), origin);
    if (!entry) {
      newContent.push(item);
      return;
    }
    let localPath: string | null = null;
    try {
      localPath = await getRunResourceLocalPath(entry.uri);
    } catch (error) {
      // A missing host projection only costs tool-side convenience — the
      // resourceUri still delivers the bytes to the model.
      log.warn(`Could not materialize a local path for ${entry.uri}`, error);
    }
    media.push(mediaPartFromEntry(entry, mediaType, localPath));
    newContent.push({ type: 'text', text: mediaStubText(entry, mediaType) });
  };

  for (const item of result.content) {
    // Media first, so 'video' (absent from the MCP SDK's content union, but
    // emitted by FLUJO's own filesystem server) can never reach the default
    // branch and leak raw base64 into the context window.
    const mediaType = toolMediaType(item);
    if (mediaType) {
      const loose = item as { type?: string; resource?: { uri?: unknown } };
      const originUri = loose.type === 'resource' && typeof loose.resource?.uri === 'string'
        ? loose.resource.uri
        : undefined;
      await captureMedia(item, mediaType, originUri ? { server, uri: originUri } : undefined);
      continue;
    }

    switch (item.type) {
      case 'resource_link': {
        // A native MCP resource pointer: register for lineage, keep the item
        // itself — it's already a compact reference the model can use.
        await store('link', undefined, item.mimeType, { server, uri: item.uri });
        newContent.push(item);
        break;
      }
      case 'resource': {
        const res = item.resource;
        if (typeof (res as { blob?: unknown }).blob === 'string') {
          const blob = (res as { blob: string }).blob;
          const entry = await store('blob', { base64: blob }, res.mimeType,
            { server, uri: res.uri });
          newContent.push(entry ? { type: 'text', text: stubText(entry) } : item);
        } else if (typeof (res as { text?: unknown }).text === 'string') {
          const text = (res as { text: string }).text;
          if (text.length >= settings.textThresholdChars) {
            const entry = await store('text', { text }, res.mimeType ?? 'text/plain',
              { server, uri: res.uri });
            if (entry && settings.replaceLargeTextWithStub) {
              newContent.push({ type: 'text', text: `${text.slice(0, 1024)}\n…\n${stubText(entry)}` });
            } else {
              newContent.push(item);
            }
          } else {
            newContent.push(item); // small embedded text is fine inline
          }
        } else {
          newContent.push(item);
        }
        break;
      }
      case 'text': {
        if (typeof item.text === 'string' && item.text.length >= settings.textThresholdChars) {
          const entry = await store('text', { text: item.text }, 'text/plain');
          if (entry && settings.replaceLargeTextWithStub) {
            newContent.push({ type: 'text', text: `${item.text.slice(0, 1024)}\n…\n${stubText(entry)}` });
          } else {
            newContent.push(item);
          }
        } else {
          newContent.push(item); // short text is never captured
        }
        break;
      }
      default:
        newContent.push(item);
    }
  }

  if (captured.length === 0) {
    return { result, captured, media };
  }
  return { result: { ...result, content: newContent }, captured, media };
}
