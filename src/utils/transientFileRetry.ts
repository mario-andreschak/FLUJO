/**
 * File errors that usually clear up on their own within a moment. On Windows,
 * antivirus, the search indexer or a backup tool can hold a file briefly
 * (EBUSY, EPERM, EACCES), and a file that is being replaced or deleted is
 * briefly unreadable (EPERM). A busy machine can briefly run out of handles or
 * process slots (EMFILE, ENFILE, EAGAIN). Node's own `fs.rm` retries the same
 * family, and graceful-fs retries Windows renames on EACCES, EPERM and EBUSY.
 */
export const TRANSIENT_FILE_ERROR_CODES: ReadonlySet<string> = new Set(['EBUSY', 'EPERM', 'EACCES', 'EAGAIN', 'EMFILE', 'ENFILE']);

/** Waits before the second, third and fourth attempt: about 0.6 s in total. */
export const TRANSIENT_FILE_RETRY_DELAYS_MS: readonly number[] = Object.freeze([50, 150, 400]);

/** Reads only an own data property, so no getter on a foreign error object runs. */
export function fileErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  const code: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined;
  return typeof code === 'string' ? code : undefined;
}

export function isTransientFileError(error: unknown): boolean {
  const code = fileErrorCode(error);
  return code !== undefined && TRANSIENT_FILE_ERROR_CODES.has(code);
}

export interface TransientFileRetryOptions {
  /** Cancellation is never retried: it ends the wait and rethrows the last failure. */
  signal?: AbortSignal;
  /** One wait per retry; the number of entries is the number of retries. */
  delaysMs?: readonly number[];
  /** Decides whether a failure may clear up. Defaults to {@link isTransientFileError}. */
  isTransient?: (error: unknown) => boolean;
  /** A failure the caller already saw from its own first attempt. */
  afterFailure?: unknown;
  /** Observation only; an exception here never changes the outcome. */
  onRetry?: (error: unknown, failedAttempts: number, delayMs: number) => void;
}

function waitUnlessAborted(delayMs: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(false); return; }
    const onAbort = () => { clearTimeout(timer); resolve(false); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(true); }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Runs `operation` again after a short wait while it fails with an error that
 * may clear up. Every attempt must start from scratch and re-check everything;
 * nothing from a failed attempt may be reused. After the last wait the final
 * failure is thrown unchanged, so the caller still decides how to refuse.
 */
export async function retryTransientFileOperation<T>(operation: (attempt: number) => T | Promise<T>,
  options: TransientFileRetryOptions = {}): Promise<T> {
  const delays = options.delaysMs ?? TRANSIENT_FILE_RETRY_DELAYS_MS;
  const transient = options.isTransient ?? isTransientFileError;
  let failures = Object.hasOwn(options, 'afterFailure') ? 1 : 0;
  let last: unknown = options.afterFailure;
  while (true) {
    if (failures > 0) {
      const delay = delays[failures - 1];
      if (delay === undefined || options.signal?.aborted || !transient(last)) throw last;
      try { options.onRetry?.(last, failures, delay); } catch { /* Observation never changes the outcome. */ }
      if (!await waitUnlessAborted(delay, options.signal)) throw last;
    }
    try { return await operation(failures + 1); }
    catch (error) { failures += 1; last = error; }
  }
}
