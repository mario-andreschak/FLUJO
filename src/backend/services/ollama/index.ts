import { getOllamaUrl } from '@/utils/paths';
import { createLogger } from '@/utils/logger';
import { createNdjsonParser } from '@/shared/utils/ndjson';

const log = createLogger('backend/services/ollama');

/**
 * Thin HTTP client for a local Ollama server.
 *
 * FLUJO always talks to Ollama over HTTP (never by shelling out to the `ollama`
 * CLI), so this works identically whether Ollama runs in the same container, a
 * compose sidecar, or on the host. The base URL comes from {@link getOllamaUrl}.
 */

/** A model already present on the Ollama server (subset of the /api/tags shape). */
export interface OllamaTag {
  name: string;
  size?: number;
}

/** One progress line from Ollama's streaming /api/pull response. */
export interface OllamaPullProgress {
  status?: string;
  digest?: string;
  total?: number;
  completed?: number;
  error?: string;
}

/**
 * Is an Ollama server reachable? Returns false for any error (connection
 * refused, timeout, non-2xx) so callers can branch without try/catch.
 */
export async function isReachable(signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(`${getOllamaUrl()}/api/tags`, { signal });
    return res.ok;
  } catch (err) {
    log.debug(`Ollama not reachable: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** List the models already pulled on the Ollama server. Empty array on any error. */
export async function listTags(signal?: AbortSignal): Promise<OllamaTag[]> {
  try {
    const res = await fetch(`${getOllamaUrl()}/api/tags`, { signal });
    if (!res.ok) return [];
    const body = (await res.json()) as { models?: OllamaTag[] };
    return Array.isArray(body.models) ? body.models : [];
  } catch (err) {
    log.debug(`listTags failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Pull a model, invoking `onProgress` for every progress line Ollama streams.
 *
 * Ollama's /api/pull returns NDJSON, so we reuse the same line parser as FLUJO's
 * own command streams. Resolves when the stream ends. Rejects on a transport /
 * non-2xx error; an error reported *inside* the stream is surfaced via a progress
 * line with an `error` field (the caller decides how to treat it) and the stream
 * simply ends.
 */
export async function pull(
  model: string,
  onProgress: (progress: OllamaPullProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch(`${getOllamaUrl()}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream: true }),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Ollama pull failed (HTTP ${res.status})${text ? `: ${text}` : ''}`);
  }
  if (!res.body) {
    throw new Error('Ollama pull returned no response body');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = createNdjsonParser<OllamaPullProgress>();

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const line of parser.push(decoder.decode(value, { stream: true }))) {
        onProgress(line);
      }
    }
    const tail = decoder.decode();
    if (tail) {
      for (const line of parser.push(tail)) onProgress(line);
    }
    for (const line of parser.flush()) onProgress(line);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

/**
 * Render one Ollama pull-progress line as a human-readable console line, matching
 * the stdout the streaming console already knows how to display. Pure + exported
 * so it can be unit-tested.
 */
export function formatPullProgress(p: OllamaPullProgress): string {
  const status = p.status || 'pulling';
  if (typeof p.total === 'number' && p.total > 0 && typeof p.completed === 'number') {
    const pct = Math.min(100, Math.round((p.completed / p.total) * 100));
    const doneMb = (p.completed / (1024 * 1024)).toFixed(0);
    const totalMb = (p.total / (1024 * 1024)).toFixed(0);
    return `${status} — ${pct}% (${doneMb}/${totalMb} MB)`;
  }
  return status;
}
