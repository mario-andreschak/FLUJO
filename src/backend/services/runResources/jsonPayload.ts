import { createHash } from 'node:crypto';
import { promises as fs, type BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { types } from 'node:util';

const STRING_CHARS = 8 * 1024;
const BUFFER_BYTES = 64 * 1024;
const NATIVE_JSON = Symbol('native JSON compatibility');

function* stringParts(text: string): Generator<string> {
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + STRING_CHARS, text.length);
    const last = text.charCodeAt(end - 1);
    const next = text.charCodeAt(end);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
    yield text.slice(start, end);
    start = end;
  }
}

/** Native property order and JSON escaping, without a whole-transcript string.
 * Exotic objects execute native serialization once during preparation instead.
 */
function* jsonParts(value: unknown, ancestors = new Set<object>()): Generator<string> {
  if (typeof value === 'string') {
    yield '"';
    for (const part of stringParts(value)) yield JSON.stringify(part).slice(1, -1);
    yield '"';
  } else if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    yield JSON.stringify(value);
  } else if (typeof value === 'object') {
    if (types.isProxy(value)) throw NATIVE_JSON;
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if ((!array && prototype !== Object.prototype && prototype !== null) || 'toJSON' in value) throw NATIVE_JSON;
    if (ancestors.has(value)) throw new TypeError('Circular JSON');
    ancestors.add(value);
    try {
      yield array ? '[' : '{';
      let count = 0;
      const keys = array ? undefined : Object.keys(value);
      const length = array ? value.length : keys!.length;
      for (let index = 0; index < length; index += 1) {
        const key = array ? String(index) : keys![index];
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor?.get || descriptor?.set || (!descriptor && key in value)) throw NATIVE_JSON;
        const item: unknown = descriptor?.value;
        const omitted = item === undefined || typeof item === 'symbol' || typeof item === 'function';
        if (typeof item === 'function' && 'toJSON' in item) throw NATIVE_JSON;
        if (!array && omitted) continue;
        if (count++) yield ',';
        if (!array) {
          yield* jsonParts(key, ancestors);
          yield ':';
        }
        if (omitted) yield 'null';
        else yield* jsonParts(item, ancestors);
      }
      yield array ? ']' : '}';
    } finally {
      ancestors.delete(value);
    }
  } else {
    throw NATIVE_JSON;
  }
}

/** The consumer finishes each chunk before advancing this reusable buffer. */
function* byteChunks(parts: Iterable<string>): Generator<Buffer> {
  const buffer = Buffer.allocUnsafe(BUFFER_BYTES);
  let used = 0;
  for (const part of parts) {
    const count = Buffer.byteLength(part, 'utf8');
    if (count > buffer.length) throw new Error('Run-resource JSON encoding chunk exceeded its bound.');
    if (used + count > buffer.length) {
      yield buffer.subarray(0, used);
      used = 0;
    }
    used += buffer.write(part, used, 'utf8');
  }
  if (used) yield buffer.subarray(0, used);
}

/** Measure/hash before quota admission, then verify identical bytes while
 * writing. Edits during a queued or slow write cannot publish a partial source.
 */
export function prepareJsonPayload(value: unknown): {
  size: number; encoding: 'utf8'; persist: (filename: string) => Promise<string>;
} {
  let chunks = () => byteChunks(jsonParts(value));
  let size = 0;
  let hash = createHash('sha256');
  try {
    for (const bytes of chunks()) { size += bytes.length; hash.update(bytes); }
  } catch (error) {
    if (error !== NATIVE_JSON) throw error;
    // No getter/toJSON has run on the incremental path. Preserve native
    // compatibility without evaluating a custom serializer a second time.
    const text = JSON.stringify(value);
    if (text === undefined) throw new TypeError('No JSON value');
    chunks = () => byteChunks(stringParts(text));
    size = Buffer.byteLength(text, 'utf8');
    hash = createHash('sha256');
    for (const bytes of chunks()) hash.update(bytes);
  }
  const expectedHash = hash.digest('hex');
  return { size, encoding: 'utf8', persist: filename => persistJsonPayload(filename, chunks, size, expectedHash) };
}

async function persistJsonPayload(
  filename: string, chunks: () => Iterable<Buffer>, size: number, expectedHash: string,
): Promise<string> {
  let destination: FileHandle | undefined = await fs.open(filename, 'wx');
  let owned: BigIntStats | undefined;
  let complete = false;
  try {
    owned = await destination.stat({ bigint: true });
    const hash = createHash('sha256');
    let position = 0;
    for (const bytes of chunks()) {
      if (position + bytes.length > size) throw new Error('Run-resource JSON source changed during its write.');
      hash.update(bytes);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await destination.write(bytes, offset, bytes.length - offset, position + offset);
        if (!result.bytesWritten) throw new Error('Run-resource JSON made no write progress.');
        offset += result.bytesWritten;
      }
      position += bytes.length;
    }
    const actualHash = hash.digest('hex');
    if (position !== size || actualHash !== expectedHash) throw new Error('Run-resource JSON source changed during its write.');
    await destination.close();
    destination = undefined;
    const named = await fs.lstat(filename, { bigint: true });
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== BigInt(1)
        || named.dev !== owned.dev || named.ino !== owned.ino || named.size !== BigInt(size)) {
      throw new Error('Run-resource JSON destination changed during its write.');
    }
    complete = true;
    return actualHash;
  } catch (error) {
    if (error === NATIVE_JSON) throw new Error('Run-resource JSON source changed during its write.');
    throw error;
  } finally {
    await destination?.close().catch(() => undefined);
    if (!complete && owned) {
      try {
        const current = await fs.lstat(filename, { bigint: true });
        if (current.isFile() && !current.isSymbolicLink() && current.nlink === BigInt(1)
            && current.dev === owned.dev && current.ino === owned.ino) await fs.unlink(filename);
      } catch { /* Preserve unknown or replaced paths. */ }
    }
  }
}
