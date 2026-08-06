/**
 * Media type detection and handling for #365.
 *
 * Provides MIME type detection via magic bytes + file extension fallback,
 * and helpers to build media content items for CallToolResult.
 */

/**
 * Magic byte signatures for common file formats.
 * Each signature is checked against the first N bytes of the file.
 */
const MAGIC_BYTE_SIGNATURES = [
  // Images
  { bytes: [0x89, 0x50, 0x4e, 0x47], mimeType: 'image/png', ext: 'png' },
  { bytes: [0xff, 0xd8, 0xff], mimeType: 'image/jpeg', ext: 'jpeg' },
  { bytes: [0x47, 0x49, 0x46, 0x38], mimeType: 'image/gif', ext: 'gif' },
  { bytes: [0x52, 0x49, 0x46, 0x46], mimeType: 'image/webp', ext: 'webp', skip: 8, check: [0x57, 0x45, 0x42, 0x50] },
  { bytes: [0xff, 0x0e, 0x01], mimeType: 'image/vnd.adobe.photoshop', ext: 'psd' },
  { bytes: [0xff, 0x0a], mimeType: 'image/x-portable-bitmap', ext: 'pbm' },
  { bytes: [0xff, 0x0b], mimeType: 'image/x-portable-graymap', ext: 'pgm' },
  { bytes: [0xff, 0x0c], mimeType: 'image/x-portable-pixmap', ext: 'ppm' },
  { bytes: [0x49, 0x49, 0x2a, 0x00], mimeType: 'image/tiff', ext: 'tiff' },
  { bytes: [0x4d, 0x4d, 0x00, 0x2a], mimeType: 'image/tiff', ext: 'tiff' },
  { bytes: [0x00, 0x00, 0x01, 0x00], mimeType: 'image/x-icon', ext: 'ico' },

  // Audio
  { bytes: [0xff, 0xfb], mimeType: 'audio/mpeg', ext: 'mp3' },
  { bytes: [0xff, 0xfa], mimeType: 'audio/mpeg', ext: 'mp3' },
  { bytes: [0x49, 0x44, 0x33], mimeType: 'audio/mpeg', ext: 'mp3' }, // ID3v2
  { bytes: [0x4f, 0x67, 0x67, 0x53], mimeType: 'audio/ogg', ext: 'ogg' },
  { bytes: [0xff, 0xf1], mimeType: 'audio/aac', ext: 'aac' },
  { bytes: [0xff, 0xf9], mimeType: 'audio/aac', ext: 'aac' },
  { bytes: [0x52, 0x49, 0x46, 0x46], mimeType: 'audio/wav', ext: 'wav', skip: 8, check: [0x57, 0x41, 0x56, 0x45] },
  { bytes: [0x66, 0x4c, 0x61, 0x43], mimeType: 'audio/flac', ext: 'flac' },
  { bytes: [0x4d, 0x34, 0x41, 0x20], mimeType: 'audio/x-m4a', ext: 'm4a' },

  // Video
  { bytes: [0x1a, 0x45, 0xdf, 0xa3], mimeType: 'video/webm', ext: 'webm' },
  { bytes: [0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70], mimeType: 'video/mp4', ext: 'mp4', offset: 4 },
  { bytes: [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70], mimeType: 'video/mp4', ext: 'mp4', offset: 4 },
  { bytes: [0x00, 0x00, 0x00, 0x20, 0x6d, 0x64, 0x61, 0x74], mimeType: 'video/quicktime', ext: 'mov' },
  { bytes: [0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70], mimeType: 'video/3gpp', ext: '3gp', offset: 4 },
  { bytes: [0x1a, 0x4c, 0xab, 0x81], mimeType: 'video/x-matroska', ext: 'mkv' },
  { bytes: [0x00, 0x00, 0x01, 0xba], mimeType: 'video/mpeg', ext: 'mpg' },
  { bytes: [0x00, 0x00, 0x01, 0xb3], mimeType: 'video/mpeg', ext: 'mpg' },
];

/**
 * Detect MIME type from file buffer via magic bytes.
 * Returns { mimeType, mediaType } or null if unrecognized.
 */
export function detectMediaTypeFromMagicBytes(
  buf: Buffer,
): { mimeType: string; mediaType: 'image' | 'audio' | 'video' | 'file' } | null {
  for (const sig of MAGIC_BYTE_SIGNATURES) {
    const offset = sig.offset ?? 0;
    const checkBytes = sig.check ?? sig.bytes;
    if (buf.length < offset + checkBytes.length) continue;
    let match = true;
    for (let i = 0; i < checkBytes.length; i++) {
      if (buf[offset + i] !== checkBytes[i]) {
        match = false;
        break;
      }
    }
    if (match) {
      const mediaType = sig.mimeType.startsWith('image/')
        ? 'image'
        : sig.mimeType.startsWith('audio/')
          ? 'audio'
          : sig.mimeType.startsWith('video/')
            ? 'video'
            : 'file';
      return { mimeType: sig.mimeType, mediaType };
    }
  }
  return null;
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
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    tiff: 'image/tiff',
    ico: 'image/x-icon',
    psd: 'image/vnd.adobe.photoshop',
    // Audio
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    m4a: 'audio/aac',
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
