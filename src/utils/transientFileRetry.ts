import { promises as fs } from 'node:fs';

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

/**
 * Waits before each new attempt to rename over a file. Windows refuses to
 * replace a file while any reader holds it open (EPERM), even FLUJO's own
 * concurrent reads; on a plain reader loop most conflicts clear within a few
 * milliseconds. So the first waits are short, then they back off to 100 ms:
 * 15 attempts in about 1 s.
 */
export const REPLACE_FILE_RETRY_DELAYS_MS: readonly number[] = Object.freeze([5, 10, 20, 40, 80, 100, 100, 100, 100, 100, 100, 100, 100, 100]);

/** Reads only an own data property, so no getter on a foreign error object runs. */
function ownDataValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

/** Reads only an own data property, so no getter on a foreign error object runs. */
export function fileErrorCode(error: unknown): string | undefined {
  const code = ownDataValue(error, 'code');
  return typeof code === 'string' ? code : undefined;
}

export function isTransientFileError(error: unknown): boolean {
  const code = fileErrorCode(error);
  return code !== undefined && TRANSIENT_FILE_ERROR_CODES.has(code);
}

export interface TransientFileRetryOptions {
  /**
   * A short fixed name for the place that retries, such as `storage-read`. It
   * appears in the diagnostics line; never put a path or a value in it.
   */
  label: string;
  /** Cancellation is never retried: it ends the wait and rethrows the last failure. */
  signal?: AbortSignal;
  /**
   * One wait per retry; the number of entries is the number of retries. A
   * function is asked after each failure and ends the retries by returning
   * `undefined`, for a limit measured in time rather than attempts.
   */
  delaysMs?: readonly number[] | ((failedAttempts: number) => number | undefined);
  /** Adds up to this many random milliseconds to every wait, so two writers racing for one file do not collide again in step. */
  jitterMs?: number;
  /** Decides whether a failure may clear up. Defaults to {@link isTransientFileError}. */
  isTransient?: (error: unknown) => boolean;
  /** A failure the caller already saw from its own first attempt. */
  afterFailure?: unknown;
  /** Observation only; an exception here never changes the outcome. */
  onRetry?: (error: unknown, failedAttempts: number, delayMs: number) => void;
  /** Waits instead of a timer, for code that runs on its own clock. */
  sleep?: (delayMs: number) => Promise<void>;
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
 * One line per retry while the redacted diagnostics switch for the MCP
 * resource path (`FLUJO_MCP_WORKLOAD_TRACE=1`) is on. It names the place and
 * the error code only, never a path or contents. The installed-app smoke check
 * uses it to see that a file it locked was met and waited out.
 */
function traceRetry(label: string, error: unknown, failedAttempts: number, delayMs: number): void {
  try {
    if (process.env.FLUJO_MCP_WORKLOAD_TRACE !== '1') return;
    const code = fileErrorCode(error) ?? fileErrorCode(ownDataValue(error, 'error')) ?? fileErrorCode(ownDataValue(error, 'cause'));
    console.info(`[transient-file-retry] ${label} ${code ?? 'other'} after try ${failedAttempts}, waiting ${delayMs} ms`);
  } catch { /* Diagnostics never change the outcome, even when the logger throws. */ }
}

/**
 * Runs `operation` again after a short wait while it fails with an error that
 * may clear up. Every attempt must start from scratch and re-check everything;
 * nothing from a failed attempt may be reused. After the last wait the final
 * failure is thrown unchanged, so the caller still decides how to refuse.
 */
export async function retryTransientFileOperation<T>(operation: (attempt: number) => T | Promise<T>,
  options: TransientFileRetryOptions): Promise<T> {
  const delays = options.delaysMs ?? TRANSIENT_FILE_RETRY_DELAYS_MS;
  const delayAfter = typeof delays === 'function' ? delays : (failures: number) => delays[failures - 1];
  const transient = options.isTransient ?? isTransientFileError;
  let failures = Object.hasOwn(options, 'afterFailure') ? 1 : 0;
  let last: unknown = options.afterFailure;
  while (true) {
    if (failures > 0) {
      if (options.signal?.aborted || !transient(last)) throw last;
      const planned = delayAfter(failures);
      if (planned === undefined) throw last;
      const delay = planned + (options.jitterMs ? Math.random() * options.jitterMs : 0);
      traceRetry(options.label, last, failures, Math.round(delay));
      try { options.onRetry?.(last, failures, delay); } catch { /* Observation never changes the outcome. */ }
      if (options.sleep) {
        await options.sleep(delay);
        if (options.signal?.aborted) throw last;
      } else if (!await waitUnlessAborted(delay, options.signal)) throw last;
    }
    try { return await operation(failures + 1); }
    catch (error) { failures += 1; last = error; }
  }
}

export interface ReplaceFileOptions {
  /** See {@link TransientFileRetryOptions.label}. */
  label: string;
  signal?: AbortSignal;
  /**
   * Runs before every attempt and may refuse by throwing, so ownership and
   * authority are checked again right before each rename. A refusal that is
   * not a short-lived file error ends the retries at once.
   */
  beforeAttempt?: () => Promise<void>;
}

/**
 * Atomically renames `from` over `to`, waiting out a reader that holds `to`
 * open (Windows refuses with EPERM). The target is never deleted to make room.
 */
export function replaceFileWithRetry(from: string, to: string, options: ReplaceFileOptions): Promise<void> {
  return retryTransientFileOperation(async () => {
    await options.beforeAttempt?.();
    await fs.rename(from, to);
  }, { label: options.label, signal: options.signal, delaysMs: REPLACE_FILE_RETRY_DELAYS_MS, jitterMs: 10 });
}
