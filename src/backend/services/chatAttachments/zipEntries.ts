import JSZip from 'jszip';

export async function openZip(bytes: Uint8Array): Promise<JSZip> {
  return JSZip.loadAsync(bytes, { createFolders: false });
}

export interface ZipEntryRead {
  bytes: Buffer;
  /** True when the entry is larger than the cap and only its start was read. */
  truncated: boolean;
}

/**
 * Read one entry, stopping at `maxBytes` of unpacked data. A tiny compressed
 * entry can unpack to gigabytes, so the size written in the archive is never
 * trusted. JSZip unpacks in chunks and yields between them.
 */
export function readZipEntry(file: JSZip.JSZipObject, maxBytes: number): Promise<ZipEntryRead> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const stream = file.nodeStream('nodebuffer');
    const finish = (truncated: boolean) => {
      if (settled) return;
      settled = true;
      resolve({ bytes: Buffer.concat(chunks, size), truncated });
    };
    stream.on('data', (chunk: Buffer) => {
      if (settled) return;
      const room = maxBytes - size;
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, Math.max(0, room)));
        size += Math.max(0, room);
        stream.pause();
        finish(true);
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    stream.on('end', () => finish(false));
    stream.on('error', (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

export async function readZipText(zip: JSZip, path: string, maxBytes: number): Promise<string | undefined> {
  const file = zip.file(path);
  if (!file) return undefined;
  const { bytes } = await readZipEntry(file, maxBytes);
  return new TextDecoder('utf-8').decode(bytes);
}

/** Resolve a relationship target ("../slides/slide1.xml", "/xl/sheet.xml") against its source part. */
export function resolvePartPath(fromPart: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const base = fromPart.split('/').slice(0, -1);
  for (const segment of target.split('/')) {
    if (segment === '..') base.pop();
    else if (segment && segment !== '.') base.push(segment);
  }
  return base.join('/');
}

/** Relationship id to target part, from the `_rels/<part>.rels` file next to a part. */
export async function readRelationships(
  zip: JSZip,
  part: string,
  maxBytes: number,
  walk: (xml: string, visit: (attrs: Record<string, string>) => void) => Promise<void>,
): Promise<Map<string, { target: string; type: string }>> {
  const slash = part.lastIndexOf('/');
  const relsPath = `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
  const xml = await readZipText(zip, relsPath, maxBytes);
  const relationships = new Map<string, { target: string; type: string }>();
  if (!xml) return relationships;
  await walk(xml, attrs => {
    if (attrs.Id && attrs.Target && attrs.TargetMode !== 'External') {
      relationships.set(attrs.Id, { target: resolvePartPath(part, attrs.Target), type: attrs.Type ?? '' });
    }
  });
  return relationships;
}
