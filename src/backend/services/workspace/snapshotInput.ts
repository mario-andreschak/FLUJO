import { constants, promises as fs, type BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SNAPSHOT_ENCRYPTION } from './snapshotTransfer';

const BLOCK = 64 * 1024;
const fields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'gid', 'nlink'] as const;
const same = (a: BigIntStats, b: BigIntStats) => fields.every(field => a[field] === b[field]);
const invalid = () => new Error('Worker snapshot is unsafe or changed while being read.');

async function writeAll(file: FileHandle, bytes: Buffer) {
  for (let offset = 0; offset < bytes.length;) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset);
    if (!bytesWritten) throw invalid();
    offset += bytesWritten;
  }
}
async function readExact(file: FileHandle, position: number, length: number): Promise<Buffer> {
  const bytes = Buffer.alloc(length);
  for (let offset = 0; offset < length;) {
    const { bytesRead } = await file.read(bytes, offset, length - offset, position + offset);
    if (!bytesRead) throw invalid();
    offset += bytesRead;
  }
  return bytes;
}

/** Temporary ZIP bytes are independently authenticated ciphertext, never a plaintext ZIP file. */
export class SnapshotInput {
  size = 0;
  private readonly key = randomBytes(32);
  private pending = Buffer.alloc(0);
  private readonly blocks: Array<{ offset: number; length: number }> = [];
  private diskSize = 0;
  private cache?: { index: number; bytes: Buffer };
  private constructor(private readonly root: string, private readonly file: FileHandle) {}
  static async create() {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'flujo-snapshot-input-'));
    try {
      await fs.chmod(root, 0o700);
      return new SnapshotInput(root, await fs.open(path.join(root, 'ciphertext'), 'wx+', 0o600));
    } catch (error) { await fs.rm(root, { recursive: true, force: true }); throw error; }
  }
  async append(bytes: Buffer) {
    this.size += bytes.length;
    let combined = this.pending.length ? Buffer.concat([this.pending, bytes]) : bytes;
    while (combined.length >= BLOCK) {
      await this.seal(combined.subarray(0, BLOCK));
      combined = combined.subarray(BLOCK);
    }
    this.pending = Buffer.from(combined);
  }
  private async seal(bytes: Buffer) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`${this.blocks.length}:${bytes.length}`));
    const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
    await writeAll(this.file, Buffer.concat([iv, cipher.getAuthTag(), encrypted]));
    this.blocks.push({ offset: this.diskSize, length: bytes.length });
    this.diskSize += bytes.length + 28;
  }
  async finish() {
    if (this.pending.length) await this.seal(this.pending);
    this.pending.fill(0); this.pending = Buffer.alloc(0);
    await this.file.sync();
  }
  async read(position: number, length: number): Promise<Buffer> {
    if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0 || length < 0
        || position + length > this.size || length > 8 * 1024 * 1024) throw invalid();
    const result = Buffer.alloc(length);
    for (let offset = 0; offset < length;) {
      const index = Math.floor((position + offset) / BLOCK);
      const block = this.blocks[index];
      if (!block) throw invalid();
      if (this.cache?.index !== index) {
        this.cache?.bytes.fill(0);
        const sealed = await readExact(this.file, block.offset, block.length + 28);
        const decipher = createDecipheriv('aes-256-gcm', this.key, sealed.subarray(0, 12));
        decipher.setAAD(Buffer.from(`${index}:${block.length}`));
        decipher.setAuthTag(sealed.subarray(12, 28));
        this.cache = { index, bytes: Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]) };
      }
      const within = (position + offset) % BLOCK;
      const amount = Math.min(length - offset, block.length - within);
      this.cache.bytes.copy(result, offset, within, within + amount);
      offset += amount;
    }
    return result;
  }
  async *range(position = 0, length = this.size - position) {
    for (let offset = 0; offset < length; offset += BLOCK) yield await this.read(position + offset, Math.min(BLOCK, length - offset));
  }
  async close() {
    this.key.fill(0); this.pending.fill(0); this.cache?.bytes.fill(0);
    const closed = await Promise.allSettled([this.file.close()]);
    const removed = await Promise.allSettled([fs.rm(this.root, { recursive: true, force: true })]);
    for (const result of [...closed, ...removed]) if (result.status === 'rejected') throw result.reason;
  }
}

class Cursor {
  private buffer: Buffer = Buffer.alloc(0);
  private offset = 0;
  private position = 0;
  constructor(private readonly file: FileHandle, private readonly size: number) {}
  private async fill() {
    if (this.offset < this.buffer.length) return true;
    if (this.position === this.size) return false;
    this.buffer = await readExact(this.file, this.position, Math.min(BLOCK, this.size - this.position));
    this.position += this.buffer.length; this.offset = 0;
    return true;
  }
  async peek() { return await this.fill() ? this.buffer[this.offset] : -1; }
  async byte() { const byte = await this.peek(); if (byte !== -1) this.offset++; return byte; }
  async whitespace() { while ([9, 10, 13, 32].includes(await this.peek())) await this.byte(); }
  async expect(byte: number) { await this.whitespace(); if (await this.byte() !== byte) throw invalid(); }
  async smallValue() {
    await this.whitespace(); const parts: number[] = [];
    const quoted = await this.peek() === 34;
    if (quoted) parts.push(await this.byte());
    let escaped = false;
    while (parts.length < 256) {
      const byte = await this.peek();
      if (byte === -1) throw invalid();
      if (!quoted && [44, 125, 9, 10, 13, 32].includes(byte)) break;
      parts.push(await this.byte());
      if (quoted && byte === 34 && !escaped) break;
      escaped = byte === 92 && !escaped;
    }
    if (parts.length === 256) throw invalid();
    try { return JSON.parse(Buffer.from(parts).toString('utf8')) as unknown; } catch { throw invalid(); }
  }
  async data(output: FileHandle, maxBytes: number) {
    await this.expect(34); let pending = ''; let padded = false; let length = 0;
    const accept = async (value: string) => {
      if (!/^[A-Za-z0-9+/=]*$/.test(value) || (padded && value.length)) throw invalid();
      pending += value;
      const complete = pending.length - pending.length % 4;
      if (!complete) return;
      const encoded = pending.slice(0, complete);
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw invalid();
      const decoded = Buffer.from(encoded, 'base64');
      if (decoded.toString('base64') !== encoded) throw invalid();
      padded = encoded.includes('='); length += decoded.length;
      if (length > maxBytes) throw invalid();
      await writeAll(output, decoded); pending = pending.slice(complete);
    };
    while (await this.fill()) {
      const quote = this.buffer.indexOf(34, this.offset);
      const slash = this.buffer.indexOf(92, this.offset);
      const end = Math.min(quote < 0 ? this.buffer.length : quote, slash < 0 ? this.buffer.length : slash);
      await accept(this.buffer.subarray(this.offset, end).toString('latin1'));
      this.offset = end;
      if (end === this.buffer.length) continue;
      const marker = await this.byte();
      if (marker === 34) { if (pending.length) throw invalid(); return length; }
      const escaped = await this.byte();
      if (escaped === 117) {
        let digits = '';
        for (let index = 0; index < 4; index++) {
          const byte = await this.byte(); if (byte < 0) throw invalid(); digits += String.fromCharCode(byte);
        }
        if (!/^[0-9a-fA-F]{4}$/.test(digits)) throw invalid();
        await accept(String.fromCharCode(Number.parseInt(digits, 16)));
      } else {
        const decoded = new Map([[34, '"'], [92, String.fromCharCode(92)], [47, '/'], [98, String.fromCharCode(8)],
          [102, String.fromCharCode(12)], [110, String.fromCharCode(10)], [114, String.fromCharCode(13)], [116, String.fromCharCode(9)]]).get(escaped);
        if (decoded === undefined) throw invalid(); await accept(decoded);
      }
    }
    throw invalid();
  }

}

function decodeSmall(value: unknown, length: number) {
  if (typeof value !== 'string' || value.length > 64) throw invalid();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== length || bytes.toString('base64') !== value) throw invalid();
  return bytes;
}

/** Decode order-independent v1 JSON incrementally, then authenticate before returning a ZIP reader. */
export async function openSnapshotInput(filename: string, keyValue: string | undefined, maxBytes: number, expectedDigest: string) {
  const expected = await fs.lstat(filename, { bigint: true });
  const maxInput = keyValue === undefined ? maxBytes : 4 * Math.ceil(maxBytes / 3) + 4096;
  if (!expected.isFile() || expected.isSymbolicLink() || expected.nlink !== BigInt(1) || expected.size > BigInt(maxInput)) throw invalid();
  const source = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  let ownedReader: SnapshotInput | undefined;
  let successful = false;
  let envelopeVersion = 0;
  const wireHash = createHash('sha256');
  let spoolRoot: string | undefined; let ciphertext: FileHandle | undefined; let key: Buffer | undefined;
  try {
    const reader = ownedReader = await SnapshotInput.create();
    if (!same(expected, await source.stat({ bigint: true })) || !same(expected, await fs.lstat(filename, { bigint: true }))) throw invalid();
    for (let position = 0; position < Number(expected.size); position += BLOCK) wireHash.update(await readExact(source, position, Math.min(BLOCK, Number(expected.size) - position)));
    const hash = createHash('sha256');
    const accept = async (bytes: Buffer) => {
      if (reader.size + bytes.length > maxBytes) throw invalid();
      hash.update(bytes); await reader.append(bytes);
    };
    if (keyValue !== undefined) {
      try {
      key = decodeSmall(keyValue, 32);
      spoolRoot = await fs.mkdtemp(path.join(tmpdir(), 'flujo-snapshot-envelope-'));
      await fs.chmod(spoolRoot, 0o700);
      ciphertext = await fs.open(path.join(spoolRoot, 'ciphertext'), 'wx+', 0o600);
      const cursor = new Cursor(source, Number(expected.size));
      const values = new Map<string, unknown>(); let dataLength = -1;
      await cursor.expect(123);
      while (true) {
        const name = await cursor.smallValue();
        if (typeof name !== 'string' || !['format', 'version', 'iv', 'tag', 'data'].includes(name) || values.has(name)) throw invalid();
        await cursor.expect(58);
        values.set(name, name === 'data' ? true : await cursor.smallValue());
        if (name === 'data') dataLength = await cursor.data(ciphertext, maxBytes);
        await cursor.whitespace(); const next = await cursor.byte();
        if (next === 125) break;
        if (next !== 44) throw invalid();
      }
      await cursor.whitespace();
      if (await cursor.byte() !== -1 || values.size !== 5 || values.get('format') !== 'flujo-workspace-encrypted' || ![1, 2].includes(values.get('version') as number) || dataLength < 0) throw invalid();
      envelopeVersion = values.get('version') as number;
      const decipher = createDecipheriv('aes-256-gcm', key, decodeSmall(values.get('iv'), 12));
      if (envelopeVersion === 2) decipher.setAAD(Buffer.from(SNAPSHOT_ENCRYPTION.v2Aad));
      decipher.setAuthTag(decodeSmall(values.get('tag'), 16));
      for (let position = 0; position < dataLength; position += BLOCK) await accept(decipher.update(await readExact(ciphertext, position, Math.min(BLOCK, dataLength - position))));
      await accept(decipher.final());
      } catch { throw new Error('Worker snapshot decryption failed. Check the encrypted archive and its key.'); }
    } else {
      for (let position = 0; position < Number(expected.size); position += BLOCK) await accept(await readExact(source, position, Math.min(BLOCK, Number(expected.size) - position)));
    }
    const plaintextDigest = hash.digest('hex');
    if ((envelopeVersion === 2 ? wireHash.digest('hex') : plaintextDigest) !== expectedDigest) throw new Error('Worker snapshot SHA-256 mismatch.');
    if (!same(expected, await source.stat({ bigint: true })) || !same(expected, await fs.lstat(filename, { bigint: true }))) throw invalid();
    await reader.finish(); successful = true; return reader;
  } catch (error) { await ownedReader?.close().catch(() => undefined); throw error; }
  finally {
    key?.fill(0);
    const closed = await Promise.allSettled([source.close(), ...(ciphertext ? [ciphertext.close()] : [])]);
    const removed = await Promise.allSettled(spoolRoot ? [fs.rm(spoolRoot, { recursive: true, force: true })] : []);
    if (successful && [...closed, ...removed].some(result => result.status === 'rejected')) {
      await ownedReader?.close().catch(() => undefined);
      throw new Error('Snapshot temporary storage could not be released.');
    }
  }
}
