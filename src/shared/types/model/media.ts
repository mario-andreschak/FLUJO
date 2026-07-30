/**
 * Provider-neutral media produced by a model or attached to a chat message.
 *
 * Adapters normalize their native shapes into this representation. While an
 * adapter is returning, `data` may contain raw base64 and `url` may be a data
 * URL. ModelHandler persists those payloads as run resources when a
 * conversation id is available, then replaces them with a lightweight HTTP
 * URL plus `resourceUri` before the message is stored.
 */
export type ModelMediaType = 'image' | 'audio' | 'video' | 'file';

export interface ModelMediaPart {
  type: ModelMediaType;
  /** MIME type of the bytes or linked resource. */
  mimeType?: string;
  /** Raw base64 bytes. Used only at adapter/transport boundaries. */
  data?: string;
  /** Data URL, remote URL, or FLUJO resource-content endpoint. */
  url?: string;
  /** Optional user/provider supplied filename. */
  name?: string;
  /** Speech transcript accompanying generated audio, when supplied. */
  transcript?: string;
  /** Durable flujo://run/... identity after persistence. */
  resourceUri?: string;
}

export function mediaTypeFromMime(mimeType?: string): ModelMediaType {
  const mime = (mimeType ?? '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'file';
}

export function mediaDataUrl(part: Pick<ModelMediaPart, 'mimeType' | 'data' | 'url'>): string | undefined {
  if (part.url) return part.url;
  if (!part.data) return undefined;
  return `data:${part.mimeType ?? 'application/octet-stream'};base64,${part.data}`;
}
