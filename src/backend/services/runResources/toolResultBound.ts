import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResultBound } from '@/shared/toolResultLimit';

/**
 * The two pure steps every tool-result path shares (issue #1226): measuring a
 * result against the bound from `resolveToolResultBound`, and putting a
 * bounded preview back into an MCP result for an agent CLI. Kept apart from
 * `boundToolResult` (which writes to the store) so callers can use them
 * without the store.
 */

export interface ToolResultMeasure {
  over: boolean;
  totalBytes: number;
  /** Lines counted (0 when no line limit is active). */
  totalLines: number;
}

/** Whether `content` is over the bound — the one test every path uses. */
export function measureToolResult(content: string, bound: Pick<ToolResultBound, 'maxBytes' | 'maxLines'>): ToolResultMeasure {
  // Byte check first (cheap) — only count lines when a line budget is active.
  const totalBytes = Buffer.byteLength(content, 'utf8');
  const overBytes = bound.maxBytes > 0 && totalBytes > bound.maxBytes;
  let totalLines = 0;
  let overLines = false;
  if (bound.maxLines > 0) {
    totalLines = 1;
    for (let i = 0; i < content.length; i++) {
      if (content.charCodeAt(i) === 10 /* \n */) totalLines++;
    }
    overLines = totalLines > bound.maxLines;
  }
  return { over: overBytes || overLines, totalBytes, totalLines };
}

/**
 * Put a bounded preview into an MCP tool result for an agent CLI. Media blocks
 * stay (the text was too big, never the picture). `structuredContent` goes:
 * it carries the same payload, and a CLI that prefers it would otherwise still
 * hand the model the full result.
 */
export function withBoundedToolText(
  result: CallToolResult,
  mediaItems: CallToolResult['content'],
  text: string,
): CallToolResult {
  const bounded: CallToolResult = { ...result, content: [...mediaItems, { type: 'text', text }] };
  delete bounded.structuredContent;
  return bounded;
}
