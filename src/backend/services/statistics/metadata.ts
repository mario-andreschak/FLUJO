import { randomUUID } from 'crypto';
import { credentialFingerprint } from '@/backend/services/statistics';
import type {
  StatisticsCacheOutcome,
  StatisticsContentCategory,
  StatisticsPayloadMetadata,
  StatisticsUsage,
} from '@/shared/types/statistics';

/**
 * Correlation, timing, size, and revision helpers shared by every statistics
 * producer. Instrumentation paths must use these helpers so that invocation
 * identity, phase semantics, and payload metadata cannot diverge between
 * ModelHandler, provider adapters, and the subflow paths.
 *
 * Nothing here ever returns payload content: only counts, bounded categories,
 * and opaque identifiers.
 */

/** Stable id for one LOGICAL operation. Retries of it reuse the same id. */
export function newStatisticsInvocationId(): string {
  return `inv_${randomUUID()}`;
}

/** Stable id for a SINGLE attempt of a logical operation. */
export function statisticsAttemptId(invocationId: string | undefined, attempt: number): string | undefined {
  if (!invocationId) return undefined;
  const ordinal = Number.isInteger(attempt) && attempt > 0 ? attempt : 1;
  return `${invocationId}-a${ordinal}`.slice(0, 128);
}

/**
 * Monotonic clock reading. Elapsed durations must never be derived from
 * `Date.now()` differences, which can jump with wall-clock adjustments.
 */
export function statisticsMonotonicNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** Monotonic elapsed milliseconds since a `statisticsMonotonicNow()` reading. */
export function statisticsElapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(statisticsMonotonicNow() - startedAt));
}

/** Starts a monotonic timer. `elapsedMs()` may be called more than once. */
export function startStatisticsTimer(): { elapsedMs: () => number } {
  const startedAt = statisticsMonotonicNow();
  return { elapsedMs: () => statisticsElapsedMs(startedAt) };
}

function categoryFromMime(mime: string): StatisticsContentCategory {
  const value = mime.toLowerCase().trim();
  if (value.startsWith('image/')) return 'image';
  if (value.startsWith('audio/')) return 'audio';
  if (value.startsWith('video/')) return 'video';
  if (value.startsWith('multipart/')) return 'multipart';
  if (value.includes('json')) return 'json';
  if (value.startsWith('text/')) return 'text';
  if (value.length === 0) return 'unknown';
  return 'binary';
}

function categoryFromContentType(type: string): StatisticsContentCategory | undefined {
  switch (type.toLowerCase()) {
    case 'text':
    case 'input_text':
    case 'output_text':
      return 'text';
    case 'image':
    case 'image_url':
      return 'image';
    case 'audio':
    case 'input_audio':
      return 'audio';
    case 'video':
      return 'video';
    case 'json':
      return 'json';
    case 'resource':
    case 'resource_link':
      return 'binary';
    default:
      return undefined;
  }
}

/**
 * Normalizes an arbitrary tool/provider payload into a bounded shape category.
 * Raw MIME strings, URLs, keys, and values are inspected in memory only and are
 * never returned or persisted.
 */
export function statisticsContentCategory(value: unknown, depth = 0): StatisticsContentCategory {
  if (value === undefined || value === null) return 'empty';
  if (typeof value === 'string') {
    if (value.length === 0) return 'empty';
    const head = value.slice(0, 64).trimStart();
    if (head.startsWith('data:')) return categoryFromMime(head.slice(5).split(';')[0] ?? '');
    if (head.startsWith('{') || head.startsWith('[')) return 'json';
    return 'text';
  }
  if (typeof value === 'number' || typeof value === 'boolean') return 'json';
  if (value instanceof Uint8Array || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return 'binary';
  }
  if (depth > 3) return 'json';
  if (Array.isArray(value)) {
    const categories = new Set(value.map((item) => statisticsContentCategory(item, depth + 1)));
    categories.delete('empty');
    if (categories.size === 0) return 'empty';
    if (categories.size === 1) return [...categories][0];
    return 'multipart';
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const mime = typeof record.mimeType === 'string'
      ? record.mimeType
      : typeof record.mediaType === 'string'
        ? record.mediaType
        : undefined;
    if (mime) return categoryFromMime(mime);
    if (typeof record.type === 'string') {
      const known = categoryFromContentType(record.type);
      if (known) return known;
    }
    if (Array.isArray(record.content)) return statisticsContentCategory(record.content, depth + 1);
    return 'json';
  }
  return 'unknown';
}

/**
 * Byte size of a payload without retaining it. Returns undefined when the size
 * cannot be measured (for example a circular structure) so the metric stays
 * ABSENT instead of being estimated.
 */
export function statisticsByteSize(value: unknown): number | undefined {
  try {
    if (value === undefined || value === null) return 0;
    if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
    if (value instanceof Uint8Array || ArrayBuffer.isView(value)) {
      return (value as Uint8Array).byteLength;
    }
    if (value instanceof ArrayBuffer) return value.byteLength;
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? Buffer.byteLength(serialized, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

/** Metadata-only request/response description for a tool or provider call. */
export function statisticsPayloadMetadata(
  request: unknown,
  response: unknown,
): StatisticsPayloadMetadata | undefined {
  const requestBytes = statisticsByteSize(request);
  const responseBytes = statisticsByteSize(response);
  const metadata: StatisticsPayloadMetadata = {
    ...(requestBytes !== undefined ? { requestBytes } : {}),
    ...(responseBytes !== undefined ? { responseBytes } : {}),
    ...(typeof request === 'string' ? { requestChars: request.length } : {}),
    ...(typeof response === 'string' ? { responseChars: response.length } : {}),
    requestCategory: statisticsContentCategory(request),
    responseCategory: statisticsContentCategory(response),
  };
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/**
 * Maps provider usage metadata to an EXPLICIT cache outcome.
 *
 * `unsupported` is returned when the provider reports no cache fields at all,
 * so unsupported providers never enter the hit-rate denominator. Cached token
 * totals remain available separately in `usage`.
 */
export function statisticsCacheOutcomeFromUsage(
  usage: StatisticsUsage | undefined,
): StatisticsCacheOutcome {
  if (!usage) return 'unsupported';
  const read = usage.cachedInputTokens;
  const write = usage.cacheWriteTokens;
  if (read === undefined && write === undefined) return 'unsupported';
  const reads = read ?? 0;
  const writes = write ?? 0;
  if (reads > 0 && writes > 0) return 'mixed';
  if (reads > 0) return 'hit';
  if (writes > 0) return 'write';
  return 'miss';
}

/**
 * Deterministic, installation-local revision identity for configuration that
 * has no immutable saved id (prompt/template text, node configuration, tool
 * definitions).
 *
 * The material is hashed with the installation-local HMAC key used for
 * credential fingerprints, so a fingerprint cannot be reversed or correlated
 * across installations, and the material itself is never persisted.
 */
export async function statisticsRevisionId(
  namespace: string,
  material: unknown,
): Promise<string | undefined> {
  if (material === undefined || material === null) return undefined;
  let serialized: string;
  try {
    serialized = typeof material === 'string' ? material : JSON.stringify(material) ?? '';
  } catch {
    return undefined;
  }
  if (serialized.length === 0) return undefined;
  const fingerprint = await credentialFingerprint(`revision:${namespace}:${serialized}`)
    .catch(() => undefined);
  return fingerprint ? `rev_${fingerprint.slice('cred_'.length)}` : undefined;
}

/**
 * Guards a logical operation so exactly ONE terminal record can be emitted for
 * it, even when several producers (ModelHandler plus a self-orchestrating
 * adapter) observe the same invocation.
 */
export function createTerminalGuard(): (invocationId: string | undefined) => boolean {
  const seen = new Set<string>();
  return (invocationId) => {
    if (!invocationId) return true;
    if (seen.has(invocationId)) return false;
    seen.add(invocationId);
    return true;
  };
}
