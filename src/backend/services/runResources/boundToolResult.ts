import { createLogger } from '@/utils/logger';
import { RunResourceSettings } from '@/shared/types/runResources';
import { writeRunResource } from './index';

/**
 * Tool-boundary result bound (issue #251).
 *
 * Every tool result is bounded at the tool boundary — in ModelHandler's
 * processToolCalls (OpenAI/request-response path) and the Claude Subscription
 * adapter's MCP-tool callback — rather than only later on the wire
 * (compactForWire). When a result's text form exceeds EITHER a line budget OR a
 * byte budget (both configurable) the full content is spilled UNCONDITIONALLY
 * to a run resource and the model is shown a HEAD + TAIL preview carrying the
 * `flujo://run/...` URI. This guarantees a multi-megabyte result never reaches
 * the wire in full even on the very first turn, and that both ends of a long
 * log (a stack trace's cause AND its final line) survive.
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
}

/** Take at most `maxBytes` UTF-8 bytes from the START of `s`. */
function takeHeadBytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.byteLength <= maxBytes) return s;
  // A byte slice may split a multibyte char at the tail; toString then emits a
  // U+FFFD replacement char there — strip it so the preview stays clean.
  return buf.subarray(0, maxBytes).toString('utf8').replace(/�+$/, '');
}

/** Take at most `maxBytes` UTF-8 bytes from the END of `s`. */
function takeTailBytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.byteLength <= maxBytes) return s;
  return buf.subarray(buf.byteLength - maxBytes).toString('utf8').replace(/^�+/, '');
}

/**
 * Build a head+tail preview: half the line budget from each end, then clamp
 * each half to half the byte budget (opencode's algorithm). For a single huge
 * line (over-bytes but under-lines) the head/tail candidates are the whole
 * line, and the byte clamp still yields both ends.
 */
function buildPreview(
  content: string,
  maxLines: number,
  maxBytes: number,
  totalBytes: number,
  totalLines: number,
  uri: string | undefined
): string {
  const lines = content.split('\n');
  const lineBudget = maxLines > 0 ? maxLines : lines.length;
  const halfLines = Math.max(1, Math.floor(lineBudget / 2));
  const headLineStr = lines.slice(0, halfLines).join('\n');
  const tailLineStr = lines.slice(-halfLines).join('\n');

  const byteBudget = maxBytes > 0 ? maxBytes : totalBytes;
  const halfBytes = Math.max(1, Math.floor(byteBudget / 2));
  const head = takeHeadBytes(headLineStr, halfBytes);
  const tail = takeTailBytes(tailLineStr, halfBytes);

  const marker = uri
    ? `\n…\n[tool result truncated for context — the full ${totalBytes}-byte (${totalLines}-line) ` +
      `result is stored as run resource ${uri}; call read_resource with this uri to read all of it]\n…\n`
    : `\n…[tool result truncated for context — ${totalBytes} bytes / ${totalLines} lines dropped; ` +
      `the full result could not be stored]\n…\n`;

  return `${head}${marker}${tail}`;
}

export async function boundToolResult(input: BoundToolResultInput): Promise<BoundToolResultOutcome> {
  const { conversationId, toolCallId, server, toolName, nodeId, content, settings } = input;
  const maxLines = settings.toolResultMaxLines ?? 2000;
  const maxBytes = settings.toolResultMaxBytes ?? 50 * 1024;

  // Both dimensions disabled → bounding is off entirely.
  if (maxLines <= 0 && maxBytes <= 0) return { content, spilled: false };

  // Byte check first (cheap) — only split lines when a line budget is active.
  const totalBytes = Buffer.byteLength(content, 'utf8');
  const overBytes = maxBytes > 0 && totalBytes > maxBytes;

  let totalLines = 0;
  let overLines = false;
  if (maxLines > 0) {
    totalLines = 1;
    for (let i = 0; i < content.length; i++) {
      if (content.charCodeAt(i) === 10 /* \n */) totalLines++;
    }
    overLines = totalLines > maxLines;
  }

  if (!overBytes && !overLines) return { content, spilled: false };

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

  const preview = buildPreview(content, maxLines, maxBytes, totalBytes, totalLines, uri);
  return { content: preview, spilled: true, uri, bytes };
}
