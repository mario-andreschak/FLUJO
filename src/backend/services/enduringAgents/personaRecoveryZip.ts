import { PersonaRecoveryError } from './personaRecoveryError';
import { inflateRawSync } from 'node:zlib';
import JSZip from 'jszip';
import { PERSONA_RECOVERY_MAX_ARCHIVE_BYTES } from '@/shared/types/personaRecovery';

/** ZIP32 intentionally bounds one recovery point; limits apply before and during inflation. */
export const PERSONA_RECOVERY_ZIP_LIMITS = Object.freeze({
  members: 60_000,
  fileBytes: 64 * 1024 * 1024,
  totalBytes: 512 * 1024 * 1024,
  archiveBytes: PERSONA_RECOVERY_MAX_ARCHIVE_BYTES,
});

export interface PersonaRecoveryZipFile { path: string; bytes: Buffer }
type Limits = { [Key in keyof typeof PERSONA_RECOVERY_ZIP_LIMITS]: number };
// The previous source archive is opaque evidence, never recursively inflated.
// It may exceed an ordinary file's limit, but still consumes the total budget.
export const personaRecoveryFileByteLimit = (name: string, limits: Limits = PERSONA_RECOVERY_ZIP_LIMITS) => (
  name === 'evidence/recovery-source.zip' ? limits.archiveBytes : limits.fileBytes
);
const ROOTS = new Set(['records', 'flows', 'flow-versions', 'conversations', 'conversation-logs',
  'conversation-summaries', 'model-turns', 'home', 'evidence']);
const decoder = new TextDecoder('utf-8', { fatal: true });
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function validatePersonaRecoveryZipPath(name: string): string {
  const parts = name.split('/');
  if (name.length > 1_024 || name !== name.normalize('NFC') || name.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(name)
    || parts.some((part) => !part || part === '.' || part === '..' || /[:<>"|?*]/.test(part)
      || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
    || (name !== 'persona-recovery-manifest.json' && (!ROOTS.has(parts[0]) || parts.length < 2))) {
    throw new PersonaRecoveryError('Persona recovery ZIP contains an unsafe or unsupported path.');
  }
  return name;
}

function reservePath(name: string, files: Set<string>, parents: Set<string>): void {
  const key = validatePersonaRecoveryZipPath(name).toLowerCase();
  if (files.has(key) || parents.has(key)) throw new PersonaRecoveryError('Persona recovery ZIP contains duplicate or conflicting paths.');
  const parts = key.split('/');
  for (let index = 1; index < parts.length; index++) {
    const parent = parts.slice(0, index).join('/');
    if (files.has(parent)) throw new PersonaRecoveryError('Persona recovery ZIP contains conflicting file/directory paths.');
    parents.add(parent);
  }
  files.add(key);
}

/** Our writer emits only UTF-8 name extras. Reject alternate names and ZIP64 metadata. */
function validateExtras(extra: Buffer, nameBytes: Buffer, name: string): void {
  let offset = 0;
  const seen = new Set<number>();
  while (offset < extra.length) {
    if (offset + 4 > extra.length) throw new PersonaRecoveryError('Truncated recovery ZIP extra field.');
    const kind = extra.readUInt16LE(offset);
    const length = extra.readUInt16LE(offset + 2);
    offset += 4;
    if (kind !== 0x7075 || seen.has(kind) || length < 5 || offset + length > extra.length) {
      throw new PersonaRecoveryError('Unsupported recovery ZIP extra field.');
    }
    seen.add(kind);
    const data = extra.subarray(offset, offset + length);
    if (data[0] !== 1 || data.readUInt32LE(1) !== crc32(nameBytes) || decoder.decode(data.subarray(5)) !== name) {
      throw new PersonaRecoveryError('Recovery ZIP contains an alternate filename.');
    }
    offset += length;
  }
}

function validateLimits(limits: Limits): void {
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > PERSONA_RECOVERY_ZIP_LIMITS[key as keyof Limits]) {
      throw new PersonaRecoveryError('Invalid Persona recovery ZIP limit.');
    }
  }
}

/** Byte container only: callers must subsequently validate the manifest and full record/artifact graph. */
export function decodePersonaRecoveryZip(
  bytes: Buffer,
  limits: Limits = PERSONA_RECOVERY_ZIP_LIMITS,
): PersonaRecoveryZipFile[] {
  validateLimits(limits);
  if (bytes.length < 22 || bytes.length > limits.archiveBytes) throw new PersonaRecoveryError('Recovery ZIP archive size is invalid.');
  // Our format has no trailing ZIP comment, prepended executable, directory
  // entries, encryption, descriptors, split volumes or ZIP64 extensions.
  const end = bytes.length - 22;
  if (bytes.readUInt32LE(end) !== 0x06054b50 || bytes.readUInt16LE(end + 20) !== 0) {
    throw new PersonaRecoveryError('Invalid recovery ZIP end directory.');
  }
  const count = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryStart = bytes.readUInt32LE(end + 16);
  if (!count || count > limits.members || count === 0xffff
    || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0
    || bytes.readUInt16LE(end + 8) !== count || directoryStart + directorySize !== end) {
    throw new PersonaRecoveryError('Unsupported recovery ZIP directory structure.');
  }
  const names = new Set<string>();
  const parents = new Set<string>();
  const members: Array<{ path: string; size: number; compressedSize: number; method: number; crc: number; start: number; end: number }> = [];
  let offset = directoryStart;
  let total = 0;
  let localEnd = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw new PersonaRecoveryError('Invalid recovery ZIP member.');
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const crc = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localStart = bytes.readUInt32LE(offset + 42);
    const mode = bytes.readUInt32LE(offset + 38) >>> 16;
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if ((flags & ~0x800) !== 0 || ![0, 8].includes(method) || commentLength !== 0
      || bytes.readUInt16LE(offset + 34) !== 0 || next > end || !nameLength
      || compressedSize > limits.archiveBytes
      || ![0, 0o100000].includes(mode & 0o170000) || (bytes.readUInt32LE(offset + 38) & 0x10) !== 0
      || localStart !== localEnd || localStart + 30 > directoryStart) {
      throw new PersonaRecoveryError('Unsupported recovery ZIP member encoding, size or layout.');
    }
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = decoder.decode(nameBytes);
    reservePath(name, names, parents);
    if (size > personaRecoveryFileByteLimit(name, limits)) throw new PersonaRecoveryError('Recovery ZIP member exceeds its size limit.');
    validateExtras(bytes.subarray(offset + 46 + nameLength, next), nameBytes, name);
    total += size;
    if (total > limits.totalBytes) throw new PersonaRecoveryError('Recovery ZIP uncompressed size exceeds its limit.');
    if (bytes.readUInt32LE(localStart) !== 0x04034b50
      || bytes.readUInt16LE(localStart + 6) !== flags || bytes.readUInt16LE(localStart + 8) !== method
      || bytes.readUInt32LE(localStart + 14) !== crc || bytes.readUInt32LE(localStart + 18) !== compressedSize
      || bytes.readUInt32LE(localStart + 22) !== size || bytes.readUInt16LE(localStart + 26) !== nameLength) {
      throw new PersonaRecoveryError('Recovery ZIP local and central headers disagree.');
    }
    const localExtraLength = bytes.readUInt16LE(localStart + 28);
    const contentStart = localStart + 30 + nameLength + localExtraLength;
    const contentEnd = contentStart + compressedSize;
    if (contentEnd > directoryStart || contentStart > directoryStart
      || !bytes.subarray(localStart + 30, localStart + 30 + nameLength).equals(nameBytes)) {
      throw new PersonaRecoveryError('Recovery ZIP member overlaps or changes its filename.');
    }
    validateExtras(bytes.subarray(localStart + 30 + nameLength, contentStart), nameBytes, name);
    members.push({ path: name, size, compressedSize, method, crc, start: contentStart, end: contentEnd });
    localEnd = contentEnd;
    offset = next;
  }
  if (offset !== end || localEnd !== directoryStart) throw new PersonaRecoveryError('Recovery ZIP contains unindexed bytes or members.');

  return members.map((member) => {
    const compressed = bytes.subarray(member.start, member.end);
    let content: Buffer;
    if (member.method === 0) {
      if (member.compressedSize !== member.size) throw new PersonaRecoveryError('Recovery ZIP stored member size mismatch.');
      content = Buffer.from(compressed);
    } else {
      // The native inflater stops at this cap even when ZIP metadata lies about
      // the true expanded length. Do not first inflate unbounded with JSZip.
      // Node returns { buffer, engine } with info:true; @types/node currently
      // exposes only the ordinary Buffer overload for this synchronous call.
      const inflated = inflateRawSync(compressed, {
        maxOutputLength: Math.max(1, member.size), info: true,
      }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      content = inflated.buffer;
      if (inflated.engine.bytesWritten !== member.compressedSize) throw new PersonaRecoveryError('Recovery ZIP contains trailing compressed data.');
    }
    if (content.length !== member.size || crc32(content) !== member.crc) {
      throw new PersonaRecoveryError('Recovery ZIP member length or checksum mismatch.');
    }
    return { path: member.path, bytes: content };
  });
}

export async function encodePersonaRecoveryZip(files: readonly PersonaRecoveryZipFile[]): Promise<Buffer> {
  const limits = PERSONA_RECOVERY_ZIP_LIMITS;
  if (!files.length || files.length > limits.members) throw new PersonaRecoveryError('Recovery ZIP file count exceeds its limit.');
  const zip = new JSZip();
  const paths = new Set<string>();
  const parents = new Set<string>();
  let total = 0;
  for (const file of files) {
    reservePath(file.path, paths, parents);
    total += file.bytes.length;
    if (file.bytes.length > personaRecoveryFileByteLimit(file.path, limits) || total > limits.totalBytes) throw new PersonaRecoveryError('Recovery ZIP source exceeds its size limit.');
    zip.file(file.path, Buffer.from(file.bytes), { createFolders: false, unixPermissions: 0o100600 });
  }
  const bytes = await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  if (bytes.length > limits.archiveBytes) throw new PersonaRecoveryError('Recovery ZIP archive exceeds its size limit.');
  return bytes;
}
