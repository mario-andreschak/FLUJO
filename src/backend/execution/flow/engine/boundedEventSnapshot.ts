import { types } from 'node:util';

const budgetExceeded = Symbol('event snapshot byte budget exceeded');

/** UTF-8 bytes of JSON's quoted/escaped string, without building that string. */
function quotedStringBytes(value: string, available: number): number {
  // JSON's UTF-8 representation cannot be shorter than its UTF-16 code units.
  if (value.length + 2 > available) throw budgetExceeded;
  let bytes = 2;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 34 || code === 92) bytes += 2;
    else if (code < 32) bytes += (code === 8 || code === 9 || code === 10 || code === 12 || code === 13) ? 2 : 6;
    else if (code < 128) bytes++;
    else if (code < 2048) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index++;
      } else bytes += 6; // well-formed JSON escapes lone surrogates
    } else if (code >= 0xdc00 && code <= 0xdfff) bytes += 6;
    else bytes += 3;
    if (bytes > available) throw budgetExceeded;
  }
  return bytes;
}

export interface EventSnapshot {
  json: string;
  utf8Bytes: number;
}

/**
 * Detached JSON data for best-effort replay. A bounded data-property walk
 * refuses oversized strings before building a full serialized copy. Accessors,
 * proxies, custom prototypes and callable toJSON hooks are uncacheable: this
 * cache must not invoke new publisher callbacks just to retain an event.
 * The walk admits at most 100,000 values and depth 64. Keys/commas are
 * conservatively charged even for array indices or omitted
 * properties; admission can be below the limit.
 *
 * Only the returned JSON's UTF-8 bytes are bounded. Caller-owned objects,
 * clone/serializer stack/overhead and process RSS are not.
 * An uncacheable/cyclic value never makes this optional cache break live emit.
 */
export function boundedEventSnapshot(value: unknown, maxUtf8Bytes: number): EventSnapshot | undefined {
  if (!Number.isSafeInteger(maxUtf8Bytes) || maxUtf8Bytes <= 0) return undefined;
  let remaining = maxUtf8Bytes;
  let values = 0;
  const ancestors = new WeakSet<object>();
  const reserve = (bytes: number) => {
    if (bytes > remaining) throw budgetExceeded;
    remaining -= bytes;
  };
  const copyData = (item: unknown, depth = 0): unknown => {
    if (++values > 100_000 || depth > 64) throw budgetExceeded;
    if (typeof item === 'string') { reserve(quotedStringBytes(item, remaining)); return item; }
    if (item === null) { reserve(4); return null; }
    if (typeof item === 'boolean') { reserve(item ? 4 : 5); return item; }
    if (typeof item === 'number') { reserve(Number.isFinite(item) ? String(item).length : 4); return item; }
    if (typeof item !== 'object') {
      if (typeof item === 'bigint') throw budgetExceeded;
      reserve(4); // omitted object properties / null array elements
      return undefined;
    }
    if (types.isProxy(item) || ancestors.has(item)) throw budgetExceeded;
    const prototype = Object.getPrototypeOf(item);
    const array = Array.isArray(item);
    if (prototype !== null && prototype !== (array ? Array.prototype : Object.prototype)) throw budgetExceeded;
    if (Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON') ||
        (array && Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON'))) throw budgetExceeded;
    const hook = Object.getOwnPropertyDescriptor(item, 'toJSON');
    if (hook && (hook.get || hook.set || typeof hook.value === 'function')) throw budgetExceeded;
    reserve(2);
    ancestors.add(item);
    const copyProperty = (key: string): unknown => {
      reserve(quotedStringBytes(key, remaining));
      reserve(2);
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (descriptor?.get || descriptor?.set) throw budgetExceeded;
      if (!descriptor && (Object.getOwnPropertyDescriptor(Array.prototype, key) ||
          Object.getOwnPropertyDescriptor(Object.prototype, key))) throw budgetExceeded;
      return copyData(descriptor?.value, depth + 1);
    };
    try {
      if (array) {
        const result: unknown[] = [];
        for (let index = 0; index < item.length; index++) result.push(copyProperty(String(index)));
        return result;
      }
      const result: Record<string, unknown> = Object.create(null);
      for (const key in item) {
        if (Object.hasOwn(item, key)) result[key] = copyProperty(key);
      }
      return result;
    } finally {
      ancestors.delete(item);
    }
  };
  try {
    const json = JSON.stringify(copyData(value));
    if (json === undefined) return undefined;
    const utf8Bytes = Buffer.byteLength(json, 'utf8');
    if (utf8Bytes > maxUtf8Bytes) return undefined;
    return { json, utf8Bytes };
  } catch {
    return undefined;
  }
}
