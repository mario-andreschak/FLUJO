import { createLogger } from '@/utils/logger';
import type { RunResourceSettings } from '@/shared/types/runResources';
import { resolveToolResultBound, type StepToolResultLimit, type ToolResultBound } from '@/shared/toolResultLimit';
import { writeRunResource } from './index';
import { measureToolResult } from './toolResultBound';

/**
 * Tool-boundary result bound (issue #251, settings in #1226).
 *
 * Every tool result is bounded at the tool boundary — in ModelHandler's
 * processToolCalls (OpenAI/request-response path), the Claude, Codex and
 * Antigravity adapters' MCP-tool callbacks, the native tool broker and history
 * reload — rather than only later on the wire (compactForWire). When a
 * result's text form exceeds EITHER a line budget OR a byte budget (see
 * `resolveToolResultBound`) the full content is spilled UNCONDITIONALLY to a
 * run resource and the model is shown a HEAD + TAIL preview carrying the
 * `flujo://run/...` URI. This guarantees a multi-megabyte result never reaches
 * the wire in full even on the very first turn, and that both ends of a long
 * log (a stack trace's cause AND its final line) survive.
 *
 * With the setting off only the safety ceiling applies (half the model's
 * context window): such a result is moved anyway, with a note saying why,
 * instead of overflowing the model and failing the run.
 *
 * Pure/near-pure and dependency-light on purpose: the only side effect is the
 * `writeRunResource` spill, and a spill failure degrades gracefully to a lossy
 * head+tail preview rather than ever letting the full content through.
 */

const log = createLogger('backend/services/runResources/boundToolResult');

export interface BoundToolResultInput {
  conversationId: string;
  /** Producing tool_call_id — the stable lineage key (mirrors capture.ts). */
  toolCallId: string;
  server?: string;
  toolName?: string;
  nodeId?: string;
  /** The already-stringified tool result (JSON of the CallToolResult data). */
  content: string;
  settings: RunResourceSettings;
  /**
   * Context window (tokens) of the model that reads this result. Sizes the
   * 'auto' limit and the safety ceiling; unknown ⇒ a 128K-token window.
   */
  contextWindow?: number;
  /** The AI step's own limit; wins over the workspace setting. */
  limit?: StepToolResultLimit;
}

export interface BoundToolResultOutcome {
  /** The content to place in the tool message (a preview when spilled). */
  content: string;
  /** True when the result was over a limit and got bounded + spilled. */
  spilled: boolean;
  /** URI of the spilled full content (absent when the store refused the write). */
  uri?: string;
  /** Bytes stored (present only alongside `uri`). */
  bytes?: number;
  /** Present when spilled: 'safety' when the model's context window, not the user's limit, decided. */
  reason?: ToolResultBound['reason'];
}

/** Take at most `maxBytes` UTF-8 bytes from the START of `s`. */
function takeHeadBytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.byteLength <= maxBytes) return s;
  // A byte slice may split a multibyte char at the tail; toString then emits a
  // U+FFFD replacement char there — strip it so the preview stays clean.
  return buf.subarray(0, maxBytes).toString('utf8').replace(/\ufffd+$/, '');
}

/** Take at most `maxBytes` UTF-8 bytes from the END of `s`. */
function takeTailBytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.byteLength <= maxBytes) return s;
  return buf.subarray(buf.byteLength - maxBytes).toString('utf8').replace(/^\ufffd+/, '');
}

/**
 * Build a head+tail preview: half the line budget from each end, then clamp
 * each half to half the byte budget (opencode's algorithm). For a single huge
 * line (over-bytes but under-lines) the head/tail candidates are the whole
 * line, and the byte clamp still yields both ends.
 */
function buildPreview(
  content: string,
  bound: ToolResultBound,
  totalBytes: number,
  uri: string | undefined
): string {
  const { maxLines, maxBytes } = bound;
  const lines = content.split('\n');
  const totalLines = lines.length;
  const lineBudget = maxLines > 0 ? maxLines : lines.length;
  const halfLines = Math.max(1, Math.floor(lineBudget / 2));
  const headLineStr = lines.slice(0, halfLines).join('\n');
  const tailLineStr = lines.slice(-halfLines).join('\n');

  const byteBudget = maxBytes > 0 ? maxBytes : totalBytes;
  const halfBytes = Math.max(1, Math.floor(byteBudget / 2));
  const head = takeHeadBytes(headLineStr, halfBytes);
  const tail = takeTailBytes(tailLineStr, halfBytes);

  // Say why when the user's own limit did not decide: the setting is off (or
  // a custom limit is larger than the model can take) and the result would not
  // fit the model's context window.
  const why = bound.reason === 'safety'
    ? `it is too large for the model's context window (${bound.contextWindow} tokens), so it was moved ` +
      'even though the tool result size limit allows more — '
    : '';
  const marker = uri
    ? `\n…\n[tool result truncated for context — ${why}the full ${totalBytes}-byte (${totalLines}-line) ` +
      `result is stored as run resource ${uri}; call read_resource with this uri ` +
      '(use max_chars and start_char to read it in parts) to read all of it]\n…\n'
    : `\n…[tool result truncated for context — ${why}${totalBytes} bytes / ${totalLines} lines dropped; ` +
      `the full result could not be stored]\n…\n`;

  return `${head}${marker}${tail}`;
}

export async function boundToolResult(input: BoundToolResultInput): Promise<BoundToolResultOutcome> {
  const { conversationId, toolCallId, server, toolName, nodeId, content, settings } = input;

  const bound = resolveToolResultBound(settings, input.contextWindow, input.limit);
  const { over, totalBytes } = measureToolResult(content, bound);
  if (!over) return { content, spilled: false };

  // Over a limit: spill the FULL content unconditionally so the model always
  // has a dereferenceable URI for the whole thing. Never throws at the caller.
  let uri: string | undefined;
  let bytes: number | undefined;
  try {
    const written = await writeRunResource({
      conversationId,
      mimeType: 'text/plain',
      kind: 'text',
      data: { text: content },
      producedBy: {
        source: 'tool-result',
        payloadRole: 'tool-message',
        nodeId,
        server,
        toolName,
        toolCallId,
      },
    });
    if (!('skipped' in written)) {
      uri = written.uri;
      bytes = written.size;
    } else {
      log.warn(`Tool-result spill skipped (${written.skipped}); falling back to lossy preview`, {
        conversationId, server, toolName,
      });
    }
  } catch (error) {
    log.error('Tool-result spill failed; falling back to lossy preview', error);
  }

  const preview = buildPreview(content, bound, totalBytes, uri);
  return { content: preview, spilled: true, uri, bytes, reason: bound.reason };
}
