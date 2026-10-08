const OUTPUT_CHUNK_CHARS = 32 * 1024;
const STRING_SLICE_CHARS = 8 * 1024;

async function* jsonPieces(
  input: unknown,
  ancestors: Set<object>,
): AsyncGenerator<string> {
  let value = input;
  if (
    value
    && typeof value === 'object'
    && typeof (value as { toJSON?: unknown }).toJSON === 'function'
  ) {
    value = (value as { toJSON: () => unknown }).toJSON();
  }

  if (value === null || value === undefined) {
    yield 'null';
    return;
  }
  if (typeof value === 'string') {
    yield '"';
    for (let offset = 0; offset < value.length; offset += STRING_SLICE_CHARS) {
      const encoded = JSON.stringify(value.slice(offset, offset + STRING_SLICE_CHARS));
      yield encoded.slice(1, -1);
    }
    yield '"';
    return;
  }
  if (typeof value === 'number') {
    yield Number.isFinite(value) ? String(value) : 'null';
    return;
  }
  if (typeof value === 'boolean') {
    yield value ? 'true' : 'false';
    return;
  }
  if (typeof value === 'bigint') {
    throw new TypeError('Cannot serialize a BigInt tool result');
  }
  if (typeof value !== 'object') {
    yield 'null';
    return;
  }

  if (ancestors.has(value)) throw new TypeError('Circular tool result');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      yield '[';
      for (let index = 0; index < value.length; index++) {
        if (index > 0) yield ',';
        const item = value[index];
        if (item === undefined || typeof item === 'function' || typeof item === 'symbol') {
          yield 'null';
        } else {
          yield* jsonPieces(item, ancestors);
        }
      }
      yield ']';
      return;
    }

    yield '{';
    let emitted = false;
    for (const key of Object.keys(value)) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
      if (emitted) yield ',';
      emitted = true;
      yield JSON.stringify(key);
      yield ':';
      yield* jsonPieces(item, ancestors);
    }
    yield '}';
  } finally {
    ancestors.delete(value);
  }
}

/**
 * JSON serialization that yields to the event loop and never creates one
 * monolithic JSON string. It preserves the complete JSON value; chunk size is
 * a transport granularity, not a result limit.
 */
export async function* streamJsonChunks(value: unknown): AsyncGenerator<string> {
  let buffer = '';
  let pieces = 0;
  for await (const piece of jsonPieces(value, new Set())) {
    buffer += piece;
    while (buffer.length >= OUTPUT_CHUNK_CHARS) {
      yield buffer.slice(0, OUTPUT_CHUNK_CHARS);
      buffer = buffer.slice(OUTPUT_CHUNK_CHARS);
    }
    if (++pieces % 128 === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  if (buffer) yield buffer;
}
