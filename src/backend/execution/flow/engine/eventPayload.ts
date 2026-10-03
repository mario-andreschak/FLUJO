/** A bounded JSON wire snapshot, shared by replay and live SSE serialization. */
export interface EventPayload {
  json: string;
  wireBytes: number;
  retainedBytes: number;
}

// Cache by ephemeral event identity, never by conversation or payload contents.
const snapshots = new WeakMap<object, EventPayload>();
const MAX_VALUES = 100_000;
const MAX_DEPTH = 64;

/** Check JSON size before stringify can allocate a large transcript/media copy. */
export function eventJsonFits(value: unknown, limit: number): boolean {
  let bytes = 0;
  let values = 0;
  const ancestors = new WeakSet<object>();
  const add = (size: number) => (bytes += size) <= limit;
  const string = (text: string): boolean => {
    if (!add(2 + Buffer.byteLength(text, 'utf8'))) return false;
    const escapes = /["\\\u0000-\u001f\ud800-\udfff]/g;
    let match: RegExpExecArray | null;
    while ((match = escapes.exec(text))) {
      const code = text.charCodeAt(match.index);
      if (code >= 0xd800) {
        const paired = code <= 0xdbff
          ? text.charCodeAt(match.index + 1) >= 0xdc00 && text.charCodeAt(match.index + 1) <= 0xdfff
          : text.charCodeAt(match.index - 1) >= 0xd800 && text.charCodeAt(match.index - 1) <= 0xdbff;
        if (!paired && !add(3)) return false; // UTF-8 replacement -> JSON \uXXXX.
      } else if (!add(code < 32 && ![8, 9, 10, 12, 13].includes(code) ? 5 : 1)) return false;
    }
    return true;
  };
  const visit = (item: unknown, depth: number): boolean => {
    if (++values > MAX_VALUES || depth > MAX_DEPTH) return false;
    if (item === null || item === undefined || typeof item === 'function' || typeof item === 'symbol') return add(4);
    if (typeof item === 'string') return string(item);
    if (typeof item === 'boolean') return add(item ? 4 : 5);
    if (typeof item === 'number') return add(Number.isFinite(item) ? String(item).length : 4);
    if (typeof item !== 'object' || ancestors.has(item)) return false;
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (!array && prototype !== Object.prototype && prototype !== null) return false;
    ancestors.add(item);
    try {
      if (!add(2)) return false;
      if (array) {
        if (item.length > MAX_VALUES - values) return false;
        for (let index = 0; index < item.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, index);
          if (descriptor && !('value' in descriptor)) return false;
          if (!add(1) || !visit(descriptor?.value, depth + 1)) return false;
        }
      } else {
        for (const key in item) {
          const descriptor = Object.getOwnPropertyDescriptor(item, key);
          if (!descriptor?.enumerable) continue;
          if (!('value' in descriptor) || key === 'toJSON') return false;
          if (!string(key) || !add(2) || !visit(descriptor.value, depth + 1)) return false;
        }
      }
      return true;
    } finally {
      ancestors.delete(item);
    }
  };
  return visit(value, 0);
}

export function snapshotEventPayload(event: object, maxWireBytes: number): EventPayload | undefined {
  const cached = snapshots.get(event);
  if (cached) return cached.wireBytes <= maxWireBytes ? cached : undefined;
  if (!eventJsonFits(event, maxWireBytes)) return undefined;
  try {
    const json = JSON.stringify(event);
    const wireBytes = Buffer.byteLength(json, 'utf8');
    if (wireBytes > maxWireBytes) return undefined;
    const payload = { json, wireBytes, retainedBytes: 128 + json.length * 2 };
    snapshots.set(event, payload);
    return payload;
  } catch {
    return undefined;
  }
}
