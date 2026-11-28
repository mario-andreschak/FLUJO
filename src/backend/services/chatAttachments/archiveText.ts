import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { classifyAttachment, fenceFor, formatBytes, looksLikeText } from '@/shared/chatAttachments/formats';
import { TextBudget, yieldToEventLoop } from './textBudget';
import { isCompoundFile } from './compoundFile';
import { extractLegacyOfficeText } from './legacyOffice';
import { detectOfficeKind, extractOfficeText, type ExtractLimits, type ExtractedText } from './officeText';
import { extractPdfText } from './pdfText';
import { openZip, readZipEntry } from './zipEntries';

/**
 * ZIP, TAR, TAR.GZ and GZ files: a list of everything inside, then the text of
 * each readable file (text and code, Office documents, PDFs) until the limits
 * are reached. Nested archives, images and other binaries are only listed.
 */
const MAX_LISTED = 1000;

interface ArchiveEntry {
  path: string;
  size?: number;
  read: (maxBytes: number) => Promise<{ bytes: Buffer; truncated: boolean }>;
}

async function gunzip(bytes: Uint8Array, maxBytes: number): Promise<{ bytes: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const gzip = createGunzip();
    const source = Readable.from([Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)]);
    const finish = (truncated: boolean) => {
      if (settled) return;
      settled = true;
      source.unpipe(gzip);
      gzip.destroy();
      resolve({ bytes: Buffer.concat(chunks, size), truncated });
    };
    gzip.on('data', (chunk: Buffer) => {
      if (settled) return;
      const room = maxBytes - size;
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        size += room;
        finish(true);
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    gzip.on('end', () => finish(false));
    gzip.on('error', error => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    source.pipe(gzip);
  });
}

function isTar(bytes: Buffer): boolean {
  return bytes.length >= 512 && bytes.toString('latin1', 257, 262) === 'ustar';
}

function tarString(block: Buffer, start: number, length: number): string {
  const raw = block.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end >= 0 ? end : raw.length).toString('utf8');
}

function tarEntries(tar: Buffer): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  let offset = 0;
  let longName: string | undefined;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const size = parseInt(tarString(header, 124, 12).trim() || '0', 8) || 0;
    const type = String.fromCharCode(header[156] || 48);
    const prefix = tarString(header, 345, 155);
    const name = longName ?? (prefix ? `${prefix}/${tarString(header, 0, 100)}` : tarString(header, 0, 100));
    const dataStart = offset + 512;
    const data = tar.subarray(dataStart, Math.min(tar.length, dataStart + size));
    longName = undefined;
    if (type === 'L') longName = data.toString('utf8').replace(/\0+$/, '');
    else if (type === 'x') {
      const path = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'))?.[1];
      if (path) longName = path;
    } else if (type === '0' || type === '\0' || type === '7') {
      entries.push({
        path: name,
        size,
        read: async maxBytes => ({ bytes: data.subarray(0, maxBytes), truncated: data.length > maxBytes }),
      });
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

async function zipEntries(bytes: Uint8Array): Promise<ArchiveEntry[]> {
  const zip = await openZip(bytes);
  return Object.values(zip.files)
    .filter(file => !file.dir)
    .map(file => ({ path: file.name, read: (maxBytes: number) => readZipEntry(file, maxBytes) }));
}

async function entryText(
  entry: ArchiveEntry,
  limits: ExtractLimits,
  room: number,
): Promise<{ label: string; body: string } | undefined> {
  const kind = classifyAttachment(entry.path);
  const nested: ExtractLimits = { ...limits, maxTextCharacters: Math.max(0, room) };
  if (kind.family === 'text') {
    const { bytes, truncated } = await entry.read(Math.min(limits.maxPartBytes, room * 4 + 4));
    if (!looksLikeText(bytes.subarray(0, 4096))) return undefined;
    const text = new TextDecoder('utf-8').decode(bytes);
    const fence = fenceFor(text);
    return { label: truncated ? `${entry.path} (shortened)` : entry.path, body: `${fence}${kind.language ?? ''}\n${text}\n${fence}` };
  }
  if (kind.family === 'document' || kind.family === 'legacy-office') {
    const { bytes, truncated } = await entry.read(limits.maxPartBytes);
    if (truncated) return { label: entry.path, body: '(too large to open inside the archive)' };
    if (isCompoundFile(bytes)) {
      const extracted = await extractLegacyOfficeText(bytes, nested);
      return { label: `${entry.path} (${extracted.format}, text extracted)`, body: extracted.text || '(no text)' };
    }
    if (kind.family === 'legacy-office') return undefined;
    const zip = await openZip(bytes);
    const office = await detectOfficeKind(zip, entry.path.split('.').pop()?.toLowerCase() ?? '');
    if (!office) return undefined;
    const extracted = await extractOfficeText(zip, office, nested);
    return { label: `${entry.path} (${kind.format}, text extracted)`, body: extracted.text || '(no text)' };
  }
  if (kind.family === 'pdf') {
    const { bytes, truncated } = await entry.read(limits.maxPartBytes);
    if (truncated) return { label: entry.path, body: '(too large to open inside the archive)' };
    const pdf = await extractPdfText(bytes, nested);
    return { label: `${entry.path} (PDF, ${pdf.pages} pages, text extracted)`, body: pdf.text || '(no readable text: it may be a scan)' };
  }
  return undefined;
}

function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

export async function extractArchiveText(
  bytes: Uint8Array,
  name: string,
  limits: ExtractLimits,
): Promise<ExtractedText & { files: number }> {
  let entries: ArchiveEntry[];
  if (isZip(bytes)) {
    entries = await zipEntries(bytes);
  } else {
    const gzipped = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
    const unpacked = gzipped
      ? await gunzip(bytes, limits.maxPartBytes)
      : { bytes: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), truncated: false };
    if (isTar(unpacked.bytes)) entries = tarEntries(unpacked.bytes);
    else {
      const inner = (name.split(/[\\/]/).pop() ?? name).replace(/\.(t?gz|gzip)$/i, '') || 'file';
      const content = unpacked.bytes;
      const path = classifyAttachment(inner).family === 'binary' && looksLikeText(content.subarray(0, 4096)) ? `${inner}.txt` : inner;
      entries = [{
        path,
        size: content.length,
        read: async max => ({ bytes: content.subarray(0, max), truncated: content.length > max }),
      }];
    }
  }

  const budget = new TextBudget(limits.maxTextCharacters);
  const listed = entries.slice(0, MAX_LISTED);
  budget.push(`Files in this archive (${entries.length}):\n`);
  for (const entry of listed) {
    budget.push(`- ${entry.path}${entry.size !== undefined ? ` (${formatBytes(entry.size)})` : ''}\n`);
  }
  if (entries.length > listed.length) budget.push(`- … and ${entries.length - listed.length} more\n`);
  budget.push('\n');

  let opened = 0;
  let readable = 0;
  for (const entry of entries) {
    if (budget.full) break;
    const family = classifyAttachment(entry.path).family;
    if (family !== 'text' && family !== 'document' && family !== 'legacy-office' && family !== 'pdf') continue;
    readable++;
    if (opened >= limits.maxPages) continue;
    try {
      const section = await entryText(entry, limits, limits.maxTextCharacters - budget.used);
      if (!section) continue;
      opened++;
      if (!budget.push(`### ${section.label}\n${section.body}\n\n`)) break;
    } catch {
      opened++;
      if (!budget.push(`### ${entry.path}\n(could not be read)\n\n`)) break;
    }
    await yieldToEventLoop();
  }
  return {
    text: budget.toString(),
    files: entries.length,
    units: entries.length,
    shortened: readable > opened && opened >= limits.maxPages
      ? { unit: 'file', kept: opened, total: readable }
      : budget.full ? { unit: 'character', kept: budget.used } : undefined,
  };
}
