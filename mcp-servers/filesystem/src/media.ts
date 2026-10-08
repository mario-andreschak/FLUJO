/**
 * Media type detection and handling for #365.
 *
 * Provides MIME type detection via magic bytes + file extension fallback,
 * and helpers to build media content items for CallToolResult.
 */

/**
 * Magic byte signatures for common file formats.
 *
 * `bytes` is matched at `offset` (default 0). `also` adds a SECOND required
 * range, which is what container formats need: RIFF files are only WEBP/WAVE
 * because of the form-type at offset 8, and matching just one of the two ranges
 * is never conclusive.
 *
 * Deliberately conservative: a signature shorter than ~3 bytes, or one built
 * from a common filler byte, false-positives on arbitrary binaries and makes an
 * ordinary file unreadable as text (media results reject pattern/range reads).
 * When in doubt the extension fallback below is the safer signal.
 */
interface MagicSignature {
  bytes: number[];
  mimeType: string;
  ext: string;
  offset?: number;
  also?: { offset: number; bytes: number[] };
}

/** ASCII helper so signatures stay readable. */
const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

const MAGIC_BYTE_SIGNATURES: MagicSignature[] = [
  // Images
  { bytes: [0x89, 0x50, 0x4e, 0x47], mimeType: 'image/png', ext: 'png' },
  { bytes: [0xff, 0xd8, 0xff], mimeType: 'image/jpeg', ext: 'jpeg' },
  { bytes: [0x47, 0x49, 0x46, 0x38], mimeType: 'image/gif', ext: 'gif' },
  // RIFF....WEBP — both ranges are required.
  {
    bytes: ascii('RIFF'), mimeType: 'image/webp', ext: 'webp',
    also: { offset: 8, bytes: ascii('WEBP') },
  },
  // '8BPS' — the real Photoshop signature.
  { bytes: ascii('8BPS'), mimeType: 'image/vnd.adobe.photoshop', ext: 'psd' },
  { bytes: [0x49, 0x49, 0x2a, 0x00], mimeType: 'image/tiff', ext: 'tiff' },
  { bytes: [0x4d, 0x4d, 0x00, 0x2a], mimeType: 'image/tiff', ext: 'tiff' },
  { bytes: [0x42, 0x4d], mimeType: 'image/bmp', ext: 'bmp' },

  // Audio
  { bytes: [0x49, 0x44, 0x33], mimeType: 'audio/mpeg', ext: 'mp3' }, // ID3v2
  { bytes: [0xff, 0xfb], mimeType: 'audio/mpeg', ext: 'mp3' },
  { bytes: [0xff, 0xfa], mimeType: 'audio/mpeg', ext: 'mp3' },
  { bytes: [0x4f, 0x67, 0x67, 0x53], mimeType: 'audio/ogg', ext: 'ogg' },
  { bytes: [0xff, 0xf1], mimeType: 'audio/aac', ext: 'aac' },
  { bytes: [0xff, 0xf9], mimeType: 'audio/aac', ext: 'aac' },
  // RIFF....WAVE — both ranges are required.
  {
    bytes: ascii('RIFF'), mimeType: 'audio/wav', ext: 'wav',
    also: { offset: 8, bytes: ascii('WAVE') },
  },
  { bytes: ascii('fLaC'), mimeType: 'audio/flac', ext: 'flac' },

  // Video
  { bytes: [0x00, 0x00, 0x01, 0xba], mimeType: 'video/mpeg', ext: 'mpg' },
  { bytes: [0x00, 0x00, 0x01, 0xb3], mimeType: 'video/mpeg', ext: 'mpg' },
];

/**
 * ISO-BMFF (`....ftyp<brand>`) covers MP4, MOV, 3GP, M4A and HEIC with one
 * layout: a 4-byte box size, the literal 'ftyp' at offset 4, then a 4-byte
 * major brand at offset 8. The previous table hard-coded specific box SIZES
 * into the signature and compared them at the 'ftyp' offset, so it could never
 * match a real file; the brand is the part that actually identifies the format.
 */
function detectIsoBmff(buf: Buffer): { mimeType: string } | null {
  if (buf.length < 12) return null;
  if (buf.toString('latin1', 4, 8) !== 'ftyp') return null;
  const brand = buf.toString('latin1', 8, 12);
  if (brand.startsWith('qt')) return { mimeType: 'video/quicktime' };
  if (brand.startsWith('3g')) return { mimeType: 'video/3gpp' };
  if (brand === 'M4A ' || brand === 'M4B ') return { mimeType: 'audio/mp4' };
  if (brand === 'M4V ') return { mimeType: 'video/x-m4v' };
  if (brand === 'heic' || brand === 'heix' || brand === 'mif1') return { mimeType: 'image/heic' };
  if (brand === 'avif') return { mimeType: 'image/avif' };
  return { mimeType: 'video/mp4' };
}

/**
 * EBML (0x1A45DFA3) is shared by WebM and Matroska; only the DocType string
 * inside the header distinguishes them, so scan the first bytes for it rather
 * than guessing (the old table had a fabricated second signature for .mkv).
 */
function detectEbml(buf: Buffer): { mimeType: string } | null {
  if (buf.length < 4) return null;
  if (buf[0] !== 0x1a || buf[1] !== 0x45 || buf[2] !== 0xdf || buf[3] !== 0xa3) return null;
  const header = buf.toString('latin1', 0, Math.min(buf.length, 256));
  if (header.includes('webm')) return { mimeType: 'video/webm' };
  if (header.includes('matroska')) return { mimeType: 'video/x-matroska' };
  return { mimeType: 'video/webm' };
}

function matchesAt(buf: Buffer, offset: number, bytes: number[]): boolean {
  if (buf.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buf[offset + i] !== bytes[i]) return false;
  }
  return true;
}

/**
 * Detect MIME type from file buffer via magic bytes.
 * Returns { mimeType, mediaType } or null if unrecognized.
 */
export function detectMediaTypeFromMagicBytes(
  buf: Buffer,
): { mimeType: string; mediaType: 'image' | 'audio' | 'video' | 'file' } | null {
  const container = detectIsoBmff(buf) ?? detectEbml(buf);
  const mimeType = container?.mimeType ?? MAGIC_BYTE_SIGNATURES.find((sig) =>
    matchesAt(buf, sig.offset ?? 0, sig.bytes)
    && (!sig.also || matchesAt(buf, sig.also.offset, sig.also.bytes))
  )?.mimeType;
  if (!mimeType) return null;
  return { mimeType, mediaType: mediaTypeFromMime(mimeType) };
}

/**
 * Detect MIME type from file extension (fallback).
 * Returns the MIME type string or null if unrecognized.
 */
export function mimeTypeFromExtension(filePath: string): string | null {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const extensionMimeMap: Record<string, string> = {
    // Images
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    // NOTE: `svg` is deliberately absent. An SVG is XML source, not opaque
    // bytes — classifying it as media made it unreadable as text (media
    // results reject pattern/range reads) while no model can render it anyway.
    bmp: 'image/bmp',
    heic: 'image/heic',
    avif: 'image/avif',
    tiff: 'image/tiff',
    ico: 'image/x-icon',
    psd: 'image/vnd.adobe.photoshop',
    // Audio
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    // `.m4a` is ISO-BMFF audio, not raw AAC — keep it consistent with what the
    // magic-byte brand check reports for the same file.
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    flac: 'audio/flac',
    wma: 'audio/x-ms-wma',
    // Video
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    mkv: 'video/x-matroska',
    avi: 'video/x-msvideo',
    flv: 'video/x-flv',
    '3gp': 'video/3gpp',
    m3u8: 'application/vnd.apple.mpegurl',
  };
  return extensionMimeMap[ext] ?? null;
}

/**
 * Detect media type from MIME string.
 * Returns 'image' | 'audio' | 'video' | 'file'.
 */
export function mediaTypeFromMime(mimeType: string | null | undefined): 'image' | 'audio' | 'video' | 'file' {
  if (!mimeType) return 'file';
  const lower = mimeType.toLowerCase();
  if (lower.startsWith('image/')) return 'image';
  if (lower.startsWith('audio/')) return 'audio';
  if (lower.startsWith('video/')) return 'video';
  return 'file';
}

/**
 * Comprehensive media type detection: try magic bytes first, then extension.
 * Returns { mimeType, mediaType } or null if unrecognized or file is not media.
 */
export function detectMediaFile(
  buf: Buffer,
  filePath: string,
): { mimeType: string; mediaType: 'image' | 'audio' | 'video' } | null {
  // Try magic bytes first
  const fromMagic = detectMediaTypeFromMagicBytes(buf);
  if (fromMagic) {
    return { mimeType: fromMagic.mimeType, mediaType: fromMagic.mediaType as 'image' | 'audio' | 'video' };
  }

  // Fall back to file extension
  const mimeFromExt = mimeTypeFromExtension(filePath);
  if (mimeFromExt) {
    const mediaType = mediaTypeFromMime(mimeFromExt);
    if (mediaType !== 'file') {
      return { mimeType: mimeFromExt, mediaType: mediaType as 'image' | 'audio' | 'video' };
    }
  }

  return null;
}

/**
 * Check if a file is likely binary (has NUL bytes).
 * This is a legacy heuristic; `detectMediaFile()` is the primary check.
 */
export function looksBinaryHeuristic(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}
