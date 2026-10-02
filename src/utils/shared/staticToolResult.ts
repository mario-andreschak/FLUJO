/** Output snapshots are deliberately separate from the complete context injected
 * into model history. Captures omit inline binary media and remain bounded. */
export const MAX_STATIC_CAPTURE_CHARS = 65_536;
export const MAX_STATIC_ERROR_CHARS = 2_048;

export function boundStaticText(text: string, limit = MAX_STATIC_CAPTURE_CHARS): string {
  const marker = '\n[Static output truncated]';
  return text.length > limit ? text.slice(0, limit - marker.length) + marker : text;
}

function snapshot(value: unknown, ancestors = new Set<object>(), depth = 0): unknown {
  if (!value || typeof value !== 'object') return value;
  if (ancestors.has(value)) return '[Circular value omitted]';
  if (depth >= 20) return '[Nested value omitted]';
  const next = new Set(ancestors).add(value);
  if (Array.isArray(value)) return value.map(item => snapshot(item, next, depth + 1));
  const record = value as Record<string, unknown>;
  const binary = record.type === 'image' || record.type === 'audio' || record.type === 'video';
  return Object.fromEntries(Object.entries(record).map(([key, child]) => [
    key,
    (binary && key === 'data') || key === 'blob' ? '[Binary data omitted]' : snapshot(child, next, depth + 1),
  ]));
}

/** JSON stays parseable when oversized; the preview is marked as truncated
 * rather than being presented as the original structured result. */
export function staticResultJson(value: unknown): string {
  const json = JSON.stringify(snapshot(value ?? null));
  if (json.length <= MAX_STATIC_CAPTURE_CHARS) return json;
  return JSON.stringify({
    truncated: true,
    originalChars: json.length,
    preview: json.slice(0, Math.floor((MAX_STATIC_CAPTURE_CHARS - 100) / 6)),
  });
}

/** Text means MCP text blocks (including textual embedded resources), in order.
 * Structured data and media are explicitly marked instead of silently flattened. */
export function staticResultText(value: unknown): string {
  if (typeof value === 'string') return boundStaticText(value);
  if (!value || typeof value !== 'object') return '';
  const result = value as Record<string, unknown>;
  const parts = Array.isArray(result.content) ? result.content.map((item: unknown) => {
    if (!item || typeof item !== 'object') return '[MCP content omitted]';
    const block = item as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') return block.text;
    if (block.type === 'resource' && block.resource && typeof block.resource === 'object') {
      const resource = block.resource as Record<string, unknown>;
      if (typeof resource.text === 'string') return resource.text;
    }
    return `[MCP ${String(block.type ?? 'unknown')} content omitted; use json capture for metadata]`;
  }) : [];
  if (parts.length === 0 && (result.structuredContent !== undefined
    || (!Array.isArray(result.content) && Object.keys(result).length > 0))) {
    parts.push('[MCP structured content; use json capture]');
  }
  return boundStaticText(parts.join('\n'));
}
