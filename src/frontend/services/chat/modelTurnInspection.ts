import CryptoJS from 'crypto-js';
import type { ModelTurnSnapshot } from '@/shared/types/modelTurn';

const MAX_BYTES = 64 * 1024 * 1024;
const PAGE = 65532;
type Range = { start: number; end: number };
const utf8 = new TextDecoder('utf-8', { fatal: true });
const whitespace = (byte: number) => byte === 32 || byte === 9 || byte === 10 || byte === 13;

class ArchiveBytes {
  readonly chunks: Array<{ start: number; bytes: Uint8Array }> = [];
  length = 0;
  private cursor = 0;
  append(bytes: Uint8Array) {
    if (!bytes.length || bytes.length > 65536 || this.length + bytes.length > MAX_BYTES) throw new Error('Model-turn inspection exceeds its declared byte limit.');
    this.chunks.push({ start: this.length, bytes }); this.length += bytes.length;
  }
  byte(offset: number): number {
    if (offset < 0 || offset >= this.length) throw new Error('Incomplete model-turn inspection.');
    let current = this.chunks[this.cursor];
    if (offset < current.start) this.cursor = 0;
    while (offset >= (current = this.chunks[this.cursor]).start + current.bytes.length) this.cursor++;
    return current.bytes[offset - current.start];
  }
  *sections(start: number, end: number): Generator<Uint8Array> {
    for (const chunk of this.chunks) {
      const from = Math.max(start, chunk.start), to = Math.min(end, chunk.start + chunk.bytes.length);
      if (to > from) yield chunk.bytes.subarray(from - chunk.start, to - chunk.start);
      if (chunk.start + chunk.bytes.length >= end) break;
    }
  }
  text(start: number, end: number): string {
    if (end - start > 65536) throw new Error('Inspection metadata exceeds its bounded view. Use Original JSON to inspect this field.');
    const bytes = new Uint8Array(end - start); let offset = 0;
    for (const part of this.sections(start, end)) { bytes.set(part, offset); offset += part.length; }
    return utf8.decode(bytes);
  }
  skip(offset: number): number { while (offset < this.length && whitespace(this.byte(offset))) offset++; return offset; }
  stringEnd(start: number): number {
    let escaped = false;
    for (let offset = start + 1; offset < this.length; offset++) {
      const byte = this.byte(offset);
      if (escaped) escaped = false;
      else if (byte === 92) escaped = true;
      else if (byte === 34) return offset + 1;
    }
    throw new Error('Incomplete archived string.');
  }
  valueEnd(start: number): number {
    const first = this.byte(start);
    if (first === 34) return this.stringEnd(start);
    if (first === 123 || first === 91) {
      let depth = 0;
      for (let offset = start; offset < this.length; offset++) {
        const byte = this.byte(offset);
        if (byte === 34) offset = this.stringEnd(offset) - 1;
        else if (byte === 123 || byte === 91) depth++;
        else if ((byte === 125 || byte === 93) && --depth === 0) return offset + 1;
      }
    } else {
      let offset = start;
      while (offset < this.length && !whitespace(this.byte(offset)) && ![44, 93, 125].includes(this.byte(offset))) offset++;
      return offset;
    }
    throw new Error('Incomplete archived value.');
  }
  fields(range: Range, names: ReadonlySet<string>): Map<string, Range> {
    const result = new Map<string, Range>();
    if (this.byte(range.start) !== 123) return result;
    let offset = this.skip(range.start + 1);
    while (offset < range.end && this.byte(offset) !== 125) {
      if (this.byte(offset) !== 34) throw new Error('Invalid archived object.');
      const keyEnd = this.stringEnd(offset);
      const key = keyEnd - offset <= 4096 ? JSON.parse(this.text(offset, keyEnd)) as string : undefined;
      offset = this.skip(keyEnd);
      if (this.byte(offset++) !== 58) throw new Error('Invalid archived object.');
      const start = this.skip(offset), end = this.valueEnd(start);
      if (key !== undefined && names.has(key)) result.set(key, { start, end });
      offset = this.skip(end);
      if (this.byte(offset) === 44) offset = this.skip(offset + 1);
      else if (this.byte(offset) !== 125) throw new Error('Invalid archived object.');
    }
    return result;
  }
}

/** A view into original UTF-8 bytes, never a materialized SDK object graph. */
export class ArchivedModelTurnValue {
  constructor(private readonly archive: ArchiveBytes, private readonly range: Range) {}
  get isObject() { return this.archive.byte(this.range.start) === 123; }
  child(name: string): ArchivedModelTurnValue | undefined {
    const range = this.archive.fields(this.range, new Set([name])).get(name);
    return range ? new ArchivedModelTurnValue(this.archive, range) : undefined;
  }
  readPage(page: number): { text: string; hasNext: boolean } {
    if (!Number.isSafeInteger(page) || page < 0) throw new RangeError('Invalid archive text page');
    if (this.archive.byte(this.range.start) === 34) return this.stringPage(page);
    let start = this.range.start + page * PAGE;
    if (start >= this.range.end) return { text: '', hasNext: false };
    let end = Math.min(this.range.end, this.range.start + (page + 1) * PAGE);
    while (start > this.range.start && (this.archive.byte(start) & 0xc0) === 0x80) start--;
    while (end < this.range.end && (this.archive.byte(end) & 0xc0) === 0x80) end--;
    return { text: this.archive.text(start, end), hasNext: end < this.range.end };
  }
  private stringPage(page: number) {
    const start = page * 65536, end = start + 65536;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let escaped = false, unicode = '', unicodeLeft = 0, count = 0;
    const parts: string[] = [];
    for (const bytes of this.archive.sections(this.range.start + 1, this.range.end - 1)) {
      const text = decoder.decode(bytes, { stream: true });
      for (const character of text) {
        let decoded = character;
        if (unicodeLeft) { unicode += character; if (--unicodeLeft) continue; decoded = String.fromCharCode(parseInt(unicode, 16)); unicode = ''; }
        else if (escaped) {
          escaped = false;
          if (character === 'u') { unicodeLeft = 4; continue; }
          decoded = ({ b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' } as Record<string, string>)[character] ?? character;
        } else if (character === '\\') { escaped = true; continue; }
        if (count + decoded.length > start && count < end) parts.push(decoded.slice(Math.max(0, start - count), end - count));
        count += decoded.length;
        if (count > end) return { text: parts.join(''), hasNext: true };
      }
    }
    decoder.decode();
    if (escaped || unicodeLeft) throw new Error('Incomplete archived string.');
    return { text: parts.join(''), hasNext: false };
  }
}

export interface ModelTurnInspection extends Pick<ModelTurnSnapshot, 'version' | 'entry' | 'media' | 'counts' | 'provenance' | 'visualCompaction' | 'contextCompaction'> {
  kind: 'chunked-model-turn';
  sdkRequest: ArchivedModelTurnValue | undefined;
  canonical: ArchivedModelTurnValue | undefined;
  wire: ArchivedModelTurnValue | undefined;
  source: ArchivedModelTurnValue;
  additionalMetadata: boolean;
  integrity: { readonly bytes: number; readonly sha256: string };
}
export type ModelTurnView = ModelTurnSnapshot | ModelTurnInspection;
export const isModelTurnInspection = (value: ModelTurnView): value is ModelTurnInspection => 'kind' in value && value.kind === 'chunked-model-turn';

export async function readModelTurnInspection(response: Response, signal?: AbortSignal): Promise<ModelTurnInspection> {
  if (!response.body || response.headers.get('X-Flujo-Model-Turn-Format') !== 'json-chunks-v1') throw new Error('Chunked model-turn inspection is unavailable.');
  const archive = new ArchiveBytes(), hash = CryptoJS.algo.SHA256.create(), reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '', terminal: { bytes: number; sha256: string } | undefined;
  const abort = () => { void reader.cancel(signal?.reason).catch(() => undefined); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const next = await reader.read();
      signal?.throwIfAborted();
      if (next.done) break;
      for (let offset = 0; offset < next.value.length; offset += 65536) {
        pending += decoder.decode(next.value.subarray(offset, offset + 65536), { stream: true });
        let newline: number;
        while ((newline = pending.indexOf('\n')) !== -1) {
          if (newline > 90000 || terminal) throw new Error('Invalid model-turn transport record.');
          const record = JSON.parse(pending.slice(0, newline)); pending = pending.slice(newline + 1);
          if (record.kind === 'chunk' && Object.keys(record).length === 2 && typeof record.data === 'string' && record.data.length <= 87384) {
            const binary = atob(record.data), bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
            archive.append(bytes);
            const words: number[] = [];
            for (let i = 0; i < bytes.length; i++) words[i >>> 2] = (words[i >>> 2] ?? 0) | (bytes[i] << (24 - i % 4 * 8));
            hash.update(CryptoJS.lib.WordArray.create(words, bytes.length));
          } else if (record.kind === 'end' && Object.keys(record).length === 3 && Number.isSafeInteger(record.bytes)
            && typeof record.sha256 === 'string' && /^[a-f0-9]{64}$/.test(record.sha256)) terminal = record;
          else throw new Error('Invalid model-turn transport record.');
        }
        if (pending.length > 90000) throw new Error('Model-turn transport record exceeds its limit.');
      }
    }
    pending += decoder.decode();
    if (pending || !terminal || terminal.bytes !== archive.length || terminal.sha256 !== hash.finalize().toString()) throw new Error('Model-turn inspection integrity failed.');
    const range = { start: archive.skip(0), end: archive.length };
    const fields = archive.fields(range, new Set(['version', 'entry', 'media', 'counts', 'provenance', 'visualCompaction', 'contextCompaction', 'canonicalMessages', 'genericWire', 'sdkRequest']));
    const parse = (name: string) => { const value = fields.get(name); return value ? JSON.parse(archive.text(value.start, value.end)) : undefined; };
    let additionalMetadata = false;
    const metadata = (name: string) => {
      const value = fields.get(name);
      if (value && value.end - value.start > 65536) { additionalMetadata = true; return undefined; }
      return parse(name);
    };
    const ref = (name: string) => { const value = fields.get(name); return value ? new ArchivedModelTurnValue(archive, value) : undefined; };
    signal?.throwIfAborted();
    const summary = { media: metadata('media') ?? [], counts: metadata('counts'), provenance: metadata('provenance'),
      visualCompaction: metadata('visualCompaction'), contextCompaction: metadata('contextCompaction') };
    return { kind: 'chunked-model-turn', version: parse('version'), entry: parse('entry'), ...summary, additionalMetadata,
      integrity: { bytes: archive.length, sha256: terminal.sha256 },
      canonical: ref('canonicalMessages'), wire: ref('genericWire'), sdkRequest: ref('sdkRequest'), source: new ArchivedModelTurnValue(archive, range) };
  } catch (error) { archive.chunks.length = 0; await reader.cancel(error).catch(() => undefined); signal?.throwIfAborted(); throw error; }
  finally { signal?.removeEventListener('abort', abort); reader.releaseLock(); }
}
