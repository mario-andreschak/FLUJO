import { createHash, timingSafeEqual } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { readPlainFile } from '@/utils/readPlainFile';

/** Verify actual npm archive bytes and extracted file hashes, never an SRI
 * declaration alone. Strict regular-file ustar subset; links/PAX/extensions
 * fail closed pending a separately reviewed parser. No extraction or execution.
 */
export async function verifyPackageRunnerArtifact(filename: string, integrity: string,
  installed: ReadonlyMap<string, string>, signal?: AbortSignal): Promise<void> {
  if (!path.isAbsolute(filename) || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) {
    throw new Error('Invalid package artifact request');
  }
  const expected = Buffer.from(integrity.slice(7), 'base64');
  if (expected.length !== 64 || expected.toString('base64') !== integrity.slice(7)) {
    throw new Error('Noncanonical package artifact integrity');
  }
  const compressed = await readPlainFile(filename, { signal, maxBytes: 32 * 1024 * 1024,
    verifyPath: async () => {
      const fs = await import('node:fs/promises');
      let parent = path.dirname(filename);
      for (;;) {
        const stat = await fs.lstat(parent);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Linked artifact parent');
        const next = path.dirname(parent); if (next === parent) break; parent = next;
      }
    } });
  const actual = createHash('sha512').update(compressed).digest();
  if (!timingSafeEqual(expected, actual)) throw new Error('Actual package archive differs from SRI');
  const archive = gunzipSync(compressed, { maxOutputLength: 64 * 1024 * 1024 });
  const observed = new Map<string, string>();
  let offset = 0;
  let ended = false;
  let members = 0;
  const field = (header: Buffer, start: number, length: number) => {
    const bytes = header.subarray(start, start + length);
    const terminator = bytes.indexOf(0);
    return bytes.subarray(0, terminator < 0 ? bytes.length : terminator).toString('utf8');
  };
  const octal = (value: string) => {
    const raw = value.trim();
    if (!/^[0-7]+$/.test(raw)) throw new Error('Unsupported archive numeric field');
    const number = Number.parseInt(raw, 8);
    if (!Number.isSafeInteger(number)) throw new Error('Oversized archive field');
    return number;
  };
  while (offset + 512 <= archive.length) {
    signal?.throwIfAborted();
    const header = archive.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (offset + 1024 > archive.length || !archive.subarray(offset).every(byte => byte === 0)) {
        throw new Error('Invalid archive termination');
      }
      ended = true; break;
    }
    if (++members > 16_384) throw new Error('Archive member bound exceeded');
    let checksum = 0;
    for (let index = 0; index < 512; index++) checksum += index >= 148 && index < 156 ? 32 : header[index];
    if (checksum !== octal(field(header, 148, 8))) throw new Error('Archive header checksum mismatch');
    const prefix = field(header, 345, 155);
    const name = (prefix ? prefix + '/' : '') + field(header, 0, 100);
    const type = header[156];
    const size = octal(field(header, 124, 12));
    if (!name.startsWith('package/') || name.includes('\\') || name.includes('\ufffd')
        || name.slice(8).split('/').some(part => part === '.' || part === '..')
        || (type !== 0 && type !== 48 && type !== 53) || field(header, 157, 100)) {
      throw new Error('Unsupported or escaping archive member');
    }
    const start = offset + 512;
    const next = start + Math.ceil(size / 512) * 512;
    if (next > archive.length || (type === 53 && size !== 0)) throw new Error('Truncated archive member');
    if (type !== 53) {
      const relative = name.slice(8);
      if (!relative || relative.endsWith('/') || observed.has(relative)) throw new Error('Duplicate/invalid archive member');
      observed.set(relative, createHash('sha256').update(archive.subarray(start, start + size)).digest('hex'));
    }
    offset = next;
  }
  if (!ended || observed.size !== installed.size
      || [...observed].some(([name, digest]) => installed.get(name) !== digest)) {
    throw new Error('Installed package files differ from actual archive');
  }
}
