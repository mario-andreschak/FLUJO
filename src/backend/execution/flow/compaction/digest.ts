import { createHash } from 'crypto';
import type { FlujoChatMessage } from '@/shared/types/chat';
import type { CompactionProjectionIdentity } from './types';

// Only non-JSON objects with callable toJSON need the legacy materialization
// path. Ordinary saved messages are streamed without cloning their graph.
const LEGACY_TO_JSON = Symbol('legacy canonical toJSON');
const STRING_CHUNK_SIZE = 16 * 1024;
const HASH_BUFFER_SIZE = 32 * 1024;

function hasCallableToJSON(value: unknown): boolean {
  return typeof value === 'function' && typeof (value as unknown as { toJSON?: unknown }).toJSON === 'function';
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function digestCanonicalJson(value: unknown): string {
  const hash = createHash('sha256');
  let buffer = '';
  const append = (text: string) => {
    buffer += text;
    if (buffer.length >= HASH_BUFFER_SIZE) {
      hash.update(buffer);
      buffer = '';
    }
  };
  const writeString = (text: string) => {
    append('"');
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + STRING_CHUNK_SIZE, text.length);
      // JSON.stringify escapes lone surrogates. Keep real pairs together so a
      // chunk boundary cannot change either the JSON bytes or the UTF-8 hash.
      const last = text.charCodeAt(end - 1);
      const next = text.charCodeAt(end);
      if (end < text.length && last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
      append(JSON.stringify(text.slice(start, end)).slice(1, -1));
      start = end;
    }
    append('"');
  };
  const arrayIndex = (key: string): number | undefined => {
    const index = Number(key);
    return Number.isInteger(index) && index >= 0 && index < 0xffffffff && String(index) === key ? index : undefined;
  };
  const write = (entry: unknown): void => {
    if (typeof entry === 'string') {
      writeString(entry);
    } else if (Array.isArray(entry)) {
      append('[');
      for (let index = 0; index < entry.length; index += 1) {
        if (index) append(',');
        const item = entry[index];
        if (item === undefined || typeof item === 'function' || typeof item === 'symbol') {
          if (hasCallableToJSON(item)) throw LEGACY_TO_JSON;
          append('null');
        } else write(item);
      }
      append(']');
    } else if (entry && typeof entry === 'object') {
      const entries = Object.entries(entry);
      if (entries.some(([key, item]) => (key === 'toJSON' && typeof item === 'function') || hasCallableToJSON(item))) throw LEGACY_TO_JSON;
      // Object.fromEntries in the original canonicalizer enumerates integer
      // keys numerically, even after the locale sort. Retain that byte order.
      entries.sort(([left], [right]) => {
        const leftIndex = arrayIndex(left);
        const rightIndex = arrayIndex(right);
        if (leftIndex !== undefined) return rightIndex === undefined ? -1 : leftIndex - rightIndex;
        if (rightIndex !== undefined) return 1;
        return left.localeCompare(right);
      });
      append('{');
      let count = 0;
      for (const [key, item] of entries) {
        if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
        if (count++) append(',');
        writeString(key);
        append(':');
        write(item);
      }
      append('}');
    } else {
      const serialized = JSON.stringify(entry);
      if (serialized === undefined) throw new TypeError('Cannot digest an unserializable value');
      append(serialized);
    }
  };
  try {
    write(value);
    if (buffer) hash.update(buffer);
    return hash.digest('hex');
  } catch (error) {
    if (error !== LEGACY_TO_JSON) throw error;
    return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
  }
}

/**
 * Digest the complete projected message shape. Identity and metadata are
 * deliberately included so edits that leave visible text unchanged still
 * invalidate an artifact.
 */
export function digestProjectedMessages(messages: readonly FlujoChatMessage[]): string {
  return digestCanonicalJson(messages);
}

export function digestProjectionIdentity(identity: CompactionProjectionIdentity): string {
  return digestCanonicalJson(identity);
}
