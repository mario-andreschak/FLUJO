import { createLogger } from '@/utils/logger';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { RunResourceEntry, RunResourceKind, RunResourceSettings } from '@/shared/types/runResources';
import { writeRunResource } from './index';

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
}

function formatKb(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function stubText(entry: RunResourceEntry): string {
  return `[FLUJO stored this ${entry.mimeType ?? entry.kind} (${formatKb(entry.size)}) as run resource ${entry.uri}. ` +
    `Read it back via the 'flujo' MCP server (resources/read) if needed.]`;
}

export async function captureToolResult(input: CaptureToolResultInput): Promise<CaptureOutcome> {
  const { conversationId, server, toolName, toolCallId, nodeId, result, settings } = input;
  const captured: RunResourceEntry[] = [];

  // Failed calls are diagnostics, not data artifacts.
  if (result.isError || !Array.isArray(result.content)) {
    return { result, captured };
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
  for (const item of result.content) {
    switch (item.type) {
      case 'image':
      case 'audio': {
        // Binary payloads: always capture, always stub.
        const entry = await store(item.type, { base64: item.data }, item.mimeType);
        newContent.push(entry ? { type: 'text', text: stubText(entry) } : item);
        break;
      }
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
    return { result, captured };
  }
  return { result: { ...result, content: newContent }, captured };
}
