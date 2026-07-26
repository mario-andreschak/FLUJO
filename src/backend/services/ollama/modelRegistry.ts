import { createLogger } from '@/utils/logger';

const log = createLogger('backend/services/ollama/modelRegistry');

/**
 * Process-level singleton that tracks which Ollama model is currently loaded
 * in VRAM on each Ollama server (keyed by normalised root URL, without /v1).
 *
 * Also provides a per-URL async serialisation lock (promise-chain pattern)
 * to prevent race conditions when parallel fan-out scenarios issue concurrent
 * completion requests to the same Ollama server.
 */

export type OllamaRootUrl = string; // normalised: no trailing /v1 or /

interface RegistryEntry {
  loadedModel: string | null;
  /** Tail of the per-URL promise chain; new work is appended here. */
  chain: Promise<void>;
}

/** Mutable singleton — one entry per Ollama server root URL. */
const registry = new Map<OllamaRootUrl, RegistryEntry>();

// ---------------------------------------------------------------------------
// URL normalisation
// ---------------------------------------------------------------------------

/**
 * Strip the /v1 path suffix (used for the OpenAI-compat endpoint) and any
 * trailing slashes from a model's baseUrl to get the Ollama server root.
 *
 * Examples:
 *   'http://localhost:11434/v1'   → 'http://localhost:11434'
 *   'http://localhost:11434/v1/'  → 'http://localhost:11434'
 *   'http://192.168.1.10:11434'   → 'http://192.168.1.10:11434'
 */
export function normaliseOllamaRoot(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/i, '').replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// Per-URL async lock (promise-chain pattern)
// ---------------------------------------------------------------------------

/**
 * Enqueue `fn` to run exclusively for the given Ollama root URL.
 * Concurrent calls for the SAME url are serialised; calls for DIFFERENT urls
 * run concurrently.
 *
 * Returns the resolved value of `fn()`.
 */
export function withOllamaLock<T>(root: OllamaRootUrl, fn: () => Promise<T>): Promise<T> {
  const existing = registry.get(root) ?? { loadedModel: null, chain: Promise.resolve() };

  // Promise that resolves when it is this fn's turn to run.
  let resolveSlot!: () => void;
  const slot = new Promise<void>(r => { resolveSlot = r; });

  // Append fn to the tail of the chain.  finalized resolves the slot so the
  // NEXT enqueued fn can start.  Errors from fn propagate to the caller via
  // the returned promise (not through the chain, which must never reject).
  const finalized = existing.chain
    .then(fn)
    .finally(resolveSlot) as unknown as Promise<T>;

  registry.set(root, { ...existing, chain: slot });

  return finalized;
}

// ---------------------------------------------------------------------------
// Registry reads / writes
// ---------------------------------------------------------------------------

/** Return the model name currently believed to be loaded on `root`, or null. */
export function getLoadedModel(root: OllamaRootUrl): string | null {
  return registry.get(root)?.loadedModel ?? null;
}

/**
 * Record `modelName` as the model now loaded on `root`.
 * Must be called INSIDE a `withOllamaLock` callback so the update is
 * consistent with any preceding unload.
 */
export function setLoadedModel(root: OllamaRootUrl, modelName: string): void {
  const existing = registry.get(root) ?? { loadedModel: null, chain: Promise.resolve() };
  registry.set(root, { ...existing, loadedModel: modelName });
  log.debug(`[OllamaModelRegistry] Recorded loaded model "${modelName}" on ${root}`);
}

/** Clear all registry entries (primarily for testing). */
export function clearRegistry(): void {
  registry.clear();
}
