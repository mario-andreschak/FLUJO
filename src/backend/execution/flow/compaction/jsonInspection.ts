const STRING_CHUNK_SIZE = 16 * 1024;

/** Inspect persisted JSON without materializing its complete serialized text.
 * Non-JSON objects retain the caller's native JSON.stringify compatibility path.
 * The string visitor sees only serialized keys/values, in native property order.
 */
export function inspectJson(value: unknown, visitString?: (text: string) => void): number {
  const ancestors = new Set<object>();
  const stringLength = (text: string): number => {
    visitString?.(text);
    let length = 2; // quotes
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + STRING_CHUNK_SIZE, text.length);
      const last = text.charCodeAt(end - 1);
      const next = text.charCodeAt(end);
      if (end < text.length && last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
      length += JSON.stringify(text.slice(start, end)).length - 2;
      start = end;
    }
    return length;
  };
  const inspect = (entry: unknown): number | undefined => {
    if (typeof entry === 'string') return stringLength(entry);
    if (entry === null) return 4;
    if (typeof entry === 'number' || typeof entry === 'boolean') return JSON.stringify(entry).length;
    if (typeof entry === 'undefined' || typeof entry === 'symbol') return undefined;
    if (typeof entry === 'function') {
      if ('toJSON' in entry) throw new TypeError('Use native JSON serialization');
      return undefined;
    }
    if (typeof entry !== 'object') throw new TypeError('Use native JSON serialization');
    const prototype = Object.getPrototypeOf(entry);
    if (!Array.isArray(entry) && prototype !== Object.prototype && prototype !== null) throw new TypeError('Use native JSON serialization');
    // Accessors and custom toJSON can have side effects. Let the native path
    // execute them once instead of retrying a partially inspected message.
    if ('toJSON' in entry) throw new TypeError('Use native JSON serialization');
    if (ancestors.has(entry)) throw new TypeError('Circular JSON');
    ancestors.add(entry);
    try {
      if (Array.isArray(entry)) {
        let length = 2;
        for (let index = 0; index < entry.length; index += 1) {
          if (index) length += 1;
          const descriptor = Object.getOwnPropertyDescriptor(entry, index);
          if (descriptor?.get || descriptor?.set || (!descriptor && index in entry)) throw new TypeError('Use native JSON serialization');
          length += inspect(entry[index]) ?? 4;
        }
        return length;
      }
      let length = 2;
      let count = 0;
      for (const key of Object.keys(entry)) {
        const descriptor = Object.getOwnPropertyDescriptor(entry, key);
        if (descriptor?.get || descriptor?.set) throw new TypeError('Use native JSON serialization');
        const item = (entry as Record<string, unknown>)[key];
        // Omitted properties contribute neither a key nor a resource URI.
        if (item === undefined || typeof item === 'symbol'
          || (typeof item === 'function' && !('toJSON' in item))) continue;
        const keyLength = stringLength(key);
        const itemLength = inspect(item);
        if (count++) length += 1;
        length += keyLength + 1 + (itemLength ?? 4);
      }
      return length;
    } finally {
      ancestors.delete(entry);
    }
  };
  const length = inspect(value);
  if (length === undefined) throw new TypeError('No JSON value');
  return length;
}
