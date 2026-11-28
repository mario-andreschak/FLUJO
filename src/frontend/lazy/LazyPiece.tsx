"use client";

import {
  Component,
  Suspense,
  createElement,
  use,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';

import { useTimeout } from '@/frontend/hooks/timing';
import { useHydrated } from '@/frontend/hooks/useBrowserValue';
import { createLogger } from '@/utils/logger';
import {
  createPieceChunk,
  isChunkLoadError,
  retryFailedChunks,
  type PieceChunk,
  type PieceLoader,
} from './chunks';

const log = createLogger('frontend/lazy/LazyPiece');

/** Waits before an optional piece loads again: 2 s, 4 s, 8 s … up to 2 minutes, for as long as it keeps failing. */
export function optionalRetryDelayMs(retries: number): number {
  return Math.min(2_000 * 2 ** retries, 120_000);
}

/** Waits before an essential chunk loads again. After the last one the error page shows and heals on its own. */
export const ESSENTIAL_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;

/** Waits between the error page's own attempts to bring the workspace back: 10 s, 20 s, 40 s … up to 2 minutes. */
export function healRetryDelayMs(attempt: number): number {
  return Math.min(10_000 * 2 ** attempt, 120_000);
}

function RetryAfter({ delayMs, onRetry }: { delayMs: number; onRetry: () => void }) {
  useTimeout(onRetry, delayMs);
  return null;
}

interface PieceFailure {
  error: unknown;
  /** How often the boundary has loaded the piece again since it mounted. */
  retries: number;
  /** True when the piece's own chunk failed to load, false when the error came from rendering. */
  ownChunkFailed: boolean;
}

/** How long to wait before loading the piece again, or null to pass the error up. */
type RetryPolicy = (failure: PieceFailure) => number | null;

interface PieceBoundaryProps {
  name: string;
  chunk: Pick<PieceChunk<unknown>, 'forgetFailure' | 'failed'>;
  retryDelayMs: RetryPolicy;
  /** Shown while waiting to load again. */
  fallback: ReactNode;
  children: ReactNode;
}

interface PieceBoundaryState {
  failure: { error: unknown } | null;
  retries: number;
}

class PieceBoundary extends Component<PieceBoundaryProps, PieceBoundaryState> {
  state: PieceBoundaryState = { failure: null, retries: 0 };

  static getDerivedStateFromError(error: unknown): Partial<PieceBoundaryState> {
    return { failure: { error } };
  }

  private delayMs(error: unknown): number | null {
    return this.props.retryDelayMs({ error, retries: this.state.retries, ownChunkFailed: this.props.chunk.failed });
  }

  componentDidCatch(error: unknown) {
    const delayMs = this.delayMs(error);
    if (delayMs === null) return;
    log.warn(`${this.props.name} failed; loading it again in ${Math.round(delayMs / 1000)} s`, error);
  }

  private retry = () => {
    this.props.chunk.forgetFailure();
    this.setState(state => ({ failure: null, retries: state.retries + 1 }));
  };

  render() {
    const { failure } = this.state;
    if (!failure) return this.props.children;
    const delayMs = this.delayMs(failure.error);
    if (delayMs === null) throw failure.error;
    return (
      <>
        {this.props.fallback}
        <RetryAfter delayMs={delayMs} onRetry={this.retry} />
      </>
    );
  }
}

function PieceContent<P extends object>({ chunk, pieceProps }: { chunk: PieceChunk<P>; pieceProps: P }) {
  return createElement(use(chunk.read()), pieceProps);
}

interface PiecePolicy {
  name: string;
  /** Shown while the piece loads and while it waits to load again. */
  fallback: () => ReactNode;
  retryDelayMs: RetryPolicy;
}

function createLazyPiece<P extends object>(load: PieceLoader<P>, policy: PiecePolicy): ComponentType<P> {
  const chunk = createPieceChunk(load);
  function LazyPiece(props: P) {
    const hydrated = useHydrated();
    if (!hydrated) return policy.fallback();
    return (
      <PieceBoundary
        name={policy.name}
        chunk={chunk}
        retryDelayMs={policy.retryDelayMs}
        fallback={policy.fallback()}
      >
        <Suspense fallback={policy.fallback()}>
          <PieceContent chunk={chunk} pieceProps={props} />
        </Suspense>
      </PieceBoundary>
    );
  }
  LazyPiece.displayName = `LazyPiece(${policy.name})`;
  return LazyPiece;
}

export interface OptionalPieceOptions {
  /** Names the piece in logs. */
  name: string;
  /** Shown while the piece loads and while it waits to load again. Nothing by default. */
  fallback?: () => ReactNode;
}

/**
 * Loads a piece the rest of the screen works without (a decoration, an overlay, a dock) in the browser only.
 * Its own boundary catches a failed chunk or a crash: it shows the fallback and loads again later by itself,
 * so the rest of the screen keeps working and the piece comes back without a page reload.
 * It takes no children: a piece that wraps the screen is essential.
 */
export function lazyOptional<P extends { children?: never }>(load: PieceLoader<P>, options: OptionalPieceOptions): ComponentType<P> {
  return createLazyPiece(load, {
    name: options.name,
    fallback: options.fallback ?? (() => null),
    retryDelayMs: ({ retries }) => optionalRetryDelayMs(retries),
  });
}

export interface EssentialPieceOptions {
  /** Names the piece in logs. */
  name: string;
  /** Shown while the piece loads and while a failed chunk waits to load again. */
  loading: () => ReactNode;
}

/**
 * Loads a piece the screen cannot work without in the browser only. When its own chunk fails to load,
 * it is fetched again with backoff before the error reaches the error page; the error page then keeps
 * trying by itself (`HealAfterChunkFailure`). Other errors, and errors from the children it wraps,
 * go straight up, so nested essential pieces never multiply each other's retries.
 */
export function lazyEssential<P extends object>(load: PieceLoader<P>, options: EssentialPieceOptions): ComponentType<P> {
  return createLazyPiece(load, {
    name: options.name,
    fallback: options.loading,
    retryDelayMs: ({ error, retries, ownChunkFailed }) => (
      ownChunkFailed && isChunkLoadError(error) && retries < ESSENTIAL_RETRY_DELAYS_MS.length
        ? ESSENTIAL_RETRY_DELAYS_MS[retries]
        : null
    ),
  });
}

async function serverAnswers(): Promise<boolean> {
  try {
    const response = await fetch(window.location.href, { method: 'HEAD', cache: 'no-store' });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Brings the screen back after a chunk failed to load, without anyone pressing reload. It fetches the
 * failed lazy pieces again with backoff and calls `onHealed` once they load. A chunk this module does
 * not own (a page's own code) is only fetched again by a reload, so it reloads once the server answers.
 */
export function HealAfterChunkFailure({ onHealed }: { onHealed: () => void }) {
  const [attempt, setAttempt] = useState(0);
  useTimeout(() => {
    void (async () => {
      const outcome = await retryFailedChunks();
      if (outcome.retried > 0 && outcome.stillFailing === 0) {
        onHealed();
        return;
      }
      if (outcome.retried === 0 && await serverAnswers()) {
        window.location.reload();
        return;
      }
      setAttempt(current => current + 1);
    })();
  }, healRetryDelayMs(attempt), attempt);
  return null;
}
