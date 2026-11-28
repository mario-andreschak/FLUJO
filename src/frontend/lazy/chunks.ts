import type { ComponentType } from 'react';

/** What a lazy piece's `import()` resolves to: the module, or the component itself via `.then(mod => mod.Named)`. */
export type PieceModule<P> = ComponentType<P> | { default: ComponentType<P> };
export type PieceLoader<P> = () => Promise<PieceModule<P>>;

export interface PieceChunk<P> {
  /** The load in flight or settled. Starts one when there is none. A failed load stays failed until `forgetFailure`. */
  read(): Promise<ComponentType<P>>;
  /** Drops a failed load so the next `read` fetches the chunk again. Does nothing while a load is in flight or done. */
  forgetFailure(): void;
  readonly failed: boolean;
}

// Webpack names its script chunk failures ChunkLoadError; its CSS chunks set a code instead.
// The messages cover Turbopack and the browsers' own module loaders.
const CHUNK_LOAD_MESSAGE = /loading (css )?chunk \S+ failed|failed to load chunk|failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed/i;

export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'ChunkLoadError') return true;
  if ('code' in error && error.code === 'CSS_CHUNK_LOAD_FAILED') return true;
  return CHUNK_LOAD_MESSAGE.test(error.message);
}

function toComponent<P>(loaded: PieceModule<P>): ComponentType<P> {
  return typeof loaded === 'object' && loaded !== null && 'default' in loaded ? loaded.default : loaded;
}

const failedChunks = new Set<{ read(): Promise<unknown>; forgetFailure(): void }>();

export function createPieceChunk<P>(load: PieceLoader<P>): PieceChunk<P> {
  let current: Promise<ComponentType<P>> | undefined;
  let failed = false;
  const chunk: PieceChunk<P> = {
    read() {
      if (current) return current;
      const attempt = load().then(toComponent);
      current = attempt;
      attempt.then(
        () => { failedChunks.delete(chunk); },
        () => {
          if (current !== attempt) return;
          failed = true;
          failedChunks.add(chunk);
        },
      );
      return attempt;
    },
    forgetFailure() {
      if (!failed) return;
      failed = false;
      current = undefined;
      failedChunks.delete(chunk);
    },
    get failed() { return failed; },
  };
  return chunk;
}

export interface ChunkRetryOutcome {
  /** How many failed chunks were fetched again. */
  retried: number;
  /** How many of those failed again. */
  stillFailing: number;
}

/** Fetches every failed piece chunk again, all at once. */
export async function retryFailedChunks(): Promise<ChunkRetryOutcome> {
  const chunks = [...failedChunks];
  const results = await Promise.allSettled(chunks.map(chunk => {
    chunk.forgetFailure();
    return chunk.read();
  }));
  return {
    retried: chunks.length,
    stillFailing: results.filter(result => result.status === 'rejected').length,
  };
}
