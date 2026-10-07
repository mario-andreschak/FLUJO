import { Readable } from 'node:stream';
import { createInflateRaw } from 'node:zlib';
import type { SnapshotInput } from './snapshotInput';

export interface SnapshotZipMember { name: string; directory: boolean; size: number; mode: number; crc: number; method: number; offset: number; compressed: number }
const failure = () => new Error('Invalid snapshot ZIP structure or member integrity.');
const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});

export async function inspectSnapshotZip(input: SnapshotInput, maxFileBytes: number, maxBytes: number,
  safeMember: (name: string, directory?: boolean) => string): Promise<SnapshotZipMember[]> {
  const tail = await input.read(Math.max(0, input.size - 65_557), Math.min(input.size, 65_557));
  let tailEnd = -1;
  for (let at = tail.length - 22; at >= 0; at--) {
    if (tail.readUInt32LE(at) === 0x06054b50 && at + 22 + tail.readUInt16LE(at + 20) === tail.length) { tailEnd = at; break; }
  }
  if (tailEnd < 0) throw failure();
  const end = input.size - tail.length + tailEnd;
  const count = tail.readUInt16LE(tailEnd + 10);
  const directorySize = tail.readUInt32LE(tailEnd + 12);
  const directoryOffset = tail.readUInt32LE(tailEnd + 16);
  if (tail.readUInt16LE(tailEnd + 4) || tail.readUInt16LE(tailEnd + 6) || tail.readUInt16LE(tailEnd + 8) !== count
      || count === 0xffff || count > 100_000 || directoryOffset + directorySize !== end) throw failure();
  const names = new Map<string, boolean>(); const members: SnapshotZipMember[] = [];
  const ranges: Array<{ start: number; end: number }> = [];
  let offset = directoryOffset; let total = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end) throw failure();
    const entry = await input.read(offset, 46);
    if (entry.readUInt32LE(0) !== 0x02014b50) throw failure();
    const flags = entry.readUInt16LE(8); const method = entry.readUInt16LE(10);
    const compressed = entry.readUInt32LE(20); const size = entry.readUInt32LE(24);
    const nameLength = entry.readUInt16LE(28);
    const next = offset + 46 + nameLength + entry.readUInt16LE(30) + entry.readUInt16LE(32);
    if ((flags & 1) || entry.readUInt16LE(34) !== 0 || ![0, 8].includes(method) || next > end || compressed === 0xffffffff || size === 0xffffffff) throw failure();
    const encodedName = await input.read(offset + 46, nameLength);
    const name = new TextDecoder('utf-8', { fatal: true }).decode(encodedName);
    const directory = name.endsWith('/'); const normalized = safeMember(name, directory);
    const identity = normalized.normalize('NFC').toLowerCase();
    if (names.has(identity)) throw new Error('Snapshot contains duplicate or case-aliased archive paths.');
    names.set(identity, directory);
    const mode = entry.readUInt32LE(38) >>> 16; const type = mode & 0o170000;
    if (type && type !== (directory ? 0o040000 : 0o100000)) throw new Error('Snapshot links and special files are unsupported.');
    if (size > (name === 'snapshot-manifest.json' ? 8 * 1024 * 1024 : maxFileBytes) || (directory && size !== 0)) throw new Error('Snapshot file exceeds the restore size limit.');
    total += size; if (total > maxBytes + 8 * 1024 * 1024) throw new Error('Snapshot exceeds the restore size limit.');
    const localOffset = entry.readUInt32LE(42);
    if (localOffset + 30 > directoryOffset) throw failure();
    const local = await input.read(localOffset, 30);
    if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== flags || local.readUInt16LE(8) !== method
        || local.readUInt16LE(26) !== nameLength) throw failure();
    const dataOffset = localOffset + 30 + nameLength + local.readUInt16LE(28);
    if (dataOffset + compressed > directoryOffset || !(await input.read(localOffset + 30, nameLength)).equals(encodedName)) throw failure();
    const crc = entry.readUInt32LE(16);
    if (!(flags & 8) && (local.readUInt32LE(14) !== crc || local.readUInt32LE(18) !== compressed || local.readUInt32LE(22) !== size)) throw failure();
    let rangeEnd = dataOffset + compressed;
    if (flags & 8) {
      if (rangeEnd + 12 > directoryOffset) throw failure();
      const first = await input.read(rangeEnd, 4);
      const signed = first.readUInt32LE(0) === 0x08074b50;
      const descriptor = await input.read(rangeEnd + (signed ? 4 : 0), 12);
      if (descriptor.readUInt32LE(0) !== crc || descriptor.readUInt32LE(4) !== compressed || descriptor.readUInt32LE(8) !== size) throw failure();
      rangeEnd += signed ? 16 : 12;
      if (rangeEnd > directoryOffset) throw failure();
    }
    ranges.push({ start: localOffset, end: rangeEnd });
    members.push({ name, directory, size, mode, crc, method, offset: dataOffset, compressed }); offset = next;
  }
  if (offset !== end) throw failure();
  ranges.sort((a, b) => a.start - b.start);
  for (let index = 1; index < ranges.length; index++) if (ranges[index].start < ranges[index - 1].end) throw failure();
  for (const member of members) {
    const parts = safeMember(member.name, member.directory).split('/');
    for (let length = 1; length < parts.length; length++) {
      if (names.get(parts.slice(0, length).join('/').normalize('NFC').toLowerCase()) === false) throw new Error('Snapshot contains a file/directory path conflict.');
    }
  }
  return members;
}

/** Bound inflated output and verify CRC even for members omitted from restore publication. */
export async function* snapshotMemberChunks(input: SnapshotInput, member: SnapshotZipMember) {
  const compressed = Readable.from(input.range(member.offset, member.compressed), { objectMode: false, highWaterMark: 64 * 1024 });
  const inflater = member.method === 8 ? createInflateRaw() : undefined;
  const stream = inflater ? compressed.pipe(inflater) : compressed;
  const relay = (error: Error) => stream.destroy(error);
  if (stream !== compressed) compressed.on('error', relay);
  let size = 0; let crc = 0xffffffff;
  try {
    for await (const value of stream) {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
      size += bytes.length; if (size > member.size) throw failure();
      for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
      yield bytes;
    }
    if (size !== member.size || ((crc ^ 0xffffffff) >>> 0) !== member.crc
        || (inflater && inflater.bytesWritten !== member.compressed)) throw failure();
  } finally { compressed.destroy(); stream.destroy(); }
}
