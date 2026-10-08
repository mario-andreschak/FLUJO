import { constants, promises as fs } from 'node:fs';
import { createHash, type Hash } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';

interface Frame { kind: '{' | '['; key?: string; expectsKey?: boolean; canonicalArray?: boolean; message?: boolean; id?: string }

/** Narrow witness for the actual writer's root canonicalMessages array and
 * fixture ASCII content with id preceding content. Not a general JSON reader. */
export class ArchiveHistoryWitness {
  private frames: Frame[] = [];
  private inString = false;
  private escaped = false;
  private unicode: string | undefined;
  private capture = false;
  private token = '';
  private hashing: Hash | undefined;
  private hashChunk = '';
  private hashCharacters = 0;
  private arrays = 0;
  private strings = 0;
  readonly matches: Array<{ id: string; sha256: string; characters: number }> = [];
  constructor(private readonly expected: Readonly<Record<string, string>>) {}

  private decoded(character: string) {
    if (this.capture) {
      if (this.token.length >= 512) throw new Error('Witness key/id exceeds allowance');
      this.token += character;
    }
    if (this.hashing) {
      if (character.charCodeAt(0) > 127) throw new Error('Witness content is outside the ASCII fixture contract');
      this.hashCharacters++;
      this.hashChunk += character;
      if (this.hashChunk.length >= 32 * 1024) { this.hashing.update(this.hashChunk); this.hashChunk = ''; }
    }
  }
  push(text: string) {
    for (const character of text) {
      const frame = this.frames[this.frames.length - 1];
      if (this.inString) {
        if (this.unicode !== undefined) {
          if (!/^[0-9a-f]$/i.test(character)) throw new Error('Malformed witness unicode escape');
          this.unicode += character;
          if (this.unicode.length === 4) { this.decoded(String.fromCharCode(parseInt(this.unicode, 16))); this.unicode = undefined; }
          continue;
        }
        if (this.escaped) {
          this.escaped = false;
          if (character === 'u') this.unicode = '';
          else {
            const decoded = ({ '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' } as Record<string, string>)[character];
            if (decoded === undefined) throw new Error('Malformed witness string escape');
            this.decoded(decoded);
          }
          continue;
        }
        if (character === '\\') { this.escaped = true; continue; }
        if (character !== '"') {
          if (character.charCodeAt(0) < 32) throw new Error('Malformed witness control character');
          this.decoded(character); continue;
        }
        this.inString = false;
        if (frame?.expectsKey) { frame.key = this.token; frame.expectsKey = false; }
        else if (frame?.message && frame.key === 'id') frame.id = this.token;
        if (this.hashing) {
          this.hashing.update(this.hashChunk);
          const sha256 = this.hashing.digest('hex');
          if (!frame?.id || sha256 !== this.expected[frame.id]
              || this.matches.some(match => match.id === frame.id)) throw new Error('Canonical history witness mismatch or duplicate');
          this.matches.push({ id: frame.id, sha256, characters: this.hashCharacters });
          this.hashing = undefined; this.hashChunk = ''; this.hashCharacters = 0;
        }
        continue;
      }
      if (character === '"') {
        if (++this.strings > 100_000) throw new Error('Witness string work exceeds allowance');
        this.inString = true;
        this.token = '';
        this.capture = !!frame?.expectsKey || (!!frame?.message && frame.key === 'id');
        if (frame?.message && frame.key === 'content' && frame.id
            && Object.hasOwn(this.expected, frame.id)) this.hashing = createHash('sha256');
      } else if (character === '{' || character === '[') {
        if (this.frames.length >= 64) throw new Error('Witness depth exceeds allowance');
        const canonicalArray = character === '[' && this.frames.length === 1 && frame?.key === 'canonicalMessages';
        if (canonicalArray && ++this.arrays !== 1) throw new Error('Duplicate canonical array');
        this.frames.push({ kind: character, expectsKey: character === '{', canonicalArray,
          message: character === '{' && !!frame?.canonicalArray });
      } else if (character === '}' || character === ']') {
        if (!frame || frame.kind !== (character === '}' ? '{' : '[')) throw new Error('Malformed witness structure');
        this.frames.pop();
      } else if (character === ',' && frame?.kind === '{') {
        frame.expectsKey = true; frame.key = undefined;
      }
    }
  }
  finish() {
    if (this.inString || this.escaped || this.unicode !== undefined || this.frames.length || this.arrays !== 1
        || this.matches.length !== 1) throw new Error('Incomplete canonical history witness');
    return this.matches[0];
  }
}

export async function witnessArchiveHistory(file: string, ownedRoot: string, expected: Readonly<Record<string, string>>) {
  const root = await fs.realpath(ownedRoot);
  const resolved = path.resolve(file);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !relative.endsWith('.v2.json.gz')
      || await fs.realpath(resolved) !== resolved) throw new Error('Unowned archive witness file');
  const before = await fs.lstat(resolved, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(64 * 1024 * 1024)) throw new Error('Archive witness file exceeds allowance');
  const handle = await fs.open(resolved, constants.O_RDONLY | constants.O_NONBLOCK);
  const parser = new ArchiveHistoryWitness(expected);
  const decoder = new StringDecoder('utf8');
  const compressedHash = createHash('sha256');
  let compressedBytes = 0, decodedBytes = 0;
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size
        || opened.mtimeNs !== before.mtimeNs) throw new Error('Archive witness identity changed before read');
    const meter = new Transform({ transform(chunk: Buffer, _encoding, done) {
      compressedBytes += chunk.length;
      if (compressedBytes > 64 * 1024 * 1024) return done(new Error('Compressed witness exceeds allowance'));
      compressedHash.update(chunk); done(null, chunk);
    } });
    await pipeline(handle.createReadStream({ autoClose: false, highWaterMark: 32 * 1024 }), meter, createGunzip(), async source => {
      for await (const chunk of source) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        decodedBytes += bytes.length;
        if (decodedBytes > 512 * 1024 * 1024) throw new Error('Decoded witness exceeds allowance');
        parser.push(decoder.write(bytes));
      }
      parser.push(decoder.end());
    });
    const after = await handle.stat({ bigint: true });
    const named = await fs.lstat(resolved, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs
        || named.dev !== before.dev || named.ino !== before.ino || named.mtimeNs !== before.mtimeNs || named.size !== before.size
        || compressedBytes !== Number(before.size)) throw new Error('Archive witness identity changed during read');
    return { ...parser.finish(), compressedBytes, decodedBytes, compressedSha256: compressedHash.digest('hex'),
      dev: String(before.dev), ino: String(before.ino), mtimeNs: String(before.mtimeNs), relative };
  } finally { await handle.close(); }
}
