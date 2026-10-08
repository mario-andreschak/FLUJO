/* Worker used by streamed tool calls and the progressive result viewer.
 * Parsed values stay inside the worker so React receives only a visible page.
 */
const documents = new Map();

function classify(value) {
  if (Array.isArray(value)) return { kind: 'array', length: value.length };
  if (value && typeof value === 'object' && Array.isArray(value.content)) {
    return { kind: 'mcp-content', length: value.content.length };
  }
  if (value && typeof value === 'object') {
    return { kind: 'object', length: Object.keys(value).length };
  }
  return { kind: 'scalar', length: 1 };
}

function pageOf(value, kind, offset, limit) {
  const stringify = (item) => {
    if (typeof item === 'string') return item;
    const encoded = JSON.stringify(item, null, 2);
    return encoded === undefined ? String(item) : encoded;
  };
  if (kind === 'array') return value.slice(offset, offset + limit).map(stringify);
  if (kind === 'mcp-content') {
    return value.content.slice(offset, offset + limit).map(stringify);
  }
  if (kind === 'object') {
    return Object.entries(value)
      .slice(offset, offset + limit)
      .map(([key, item]) => `${JSON.stringify(key)}: ${stringify(item)}`);
  }
  return offset === 0 ? [stringify(value)] : [];
}

self.onmessage = (event) => {
  const message = event.data || {};
  try {
    if (message.type === 'parse-chunks') {
      const value = JSON.parse(message.chunks.join(''));
      self.postMessage({ type: 'parsed', requestId: message.requestId, value });
      return;
    }
    if (message.type === 'open') {
      const value = JSON.parse(message.content);
      const meta = classify(value);
      documents.set(message.requestId, { value, meta });
      self.postMessage({ type: 'opened', requestId: message.requestId, meta });
      return;
    }
    if (message.type === 'page') {
      const document = documents.get(message.requestId);
      if (!document) throw new Error('Result document is no longer available');
      const offset = Math.max(0, Number(message.offset) || 0);
      const limit = Math.max(1, Number(message.limit) || 1);
      self.postMessage({
        type: 'page',
        requestId: message.requestId,
        offset,
        items: pageOf(document.value, document.meta.kind, offset, limit),
      });
      return;
    }
    if (message.type === 'close') documents.delete(message.requestId);
  } catch (error) {
    self.postMessage({
      type: 'error',
      requestId: message.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
