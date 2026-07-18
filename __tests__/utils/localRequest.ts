/**
 * Shared test helper for building request stubs that pass the fail-closed
 * localhost origin guard (#142, extended to `/v1` in #143).
 *
 * The origin guard — both the central `src/middleware.ts` and the in-handler
 * `assertLocalRequest` defense-in-depth calls on the highest-risk sinks — reads
 * ONLY the `Host`/`Origin` headers via `request.headers.get(...)`. Many
 * route-handler unit tests historically invoked handlers with a bare stub
 * (`{} as NextRequest`, `{ json: async () => body }`, `{ url }`) that has no
 * `.headers`. Once a handler gained the guard, such a stub threw
 * `TypeError: Cannot read properties of undefined (reading 'get')` before the
 * handler logic ran — a test-fixture gap, not a security defect.
 *
 * `makeLocalRequest` returns a minimal request-like stub carrying a localhost
 * `Host` (and, by default, no cross-origin `Origin`, i.e. a native/non-browser
 * caller), so the guard treats it as a legitimate local request and the handler
 * logic runs. It deliberately mirrors the lightweight stub style these tests
 * already use (a `json()` thunk + `url`) instead of constructing a full
 * `NextRequest`, keeping the fixtures hermetic and Edge-runtime-free.
 *
 * The `host`/`origin` overrides let a test build a NON-local request (localhost
 * `Host` + attacker `Origin`, or a non-local `Host`) to assert the handler-level
 * 403, mirroring the middleware-level suite.
 */
export interface LocalRequestOptions {
  /** JSON body returned by `request.json()`. */
  body?: unknown;
  /** Request URL (defaults to a localhost API URL). */
  url?: string;
  /** Host header value (defaults to a localhost host). Pass a non-local host to test the guard rejecting it. */
  host?: string | null;
  /** Origin header value (defaults to none — a native, non-browser client). Pass a cross-origin value to test rejection. */
  origin?: string | null;
}

/**
 * Build a minimal request-like stub that satisfies the localhost origin guard.
 * Returns `any` so it can stand in for `NextRequest`/`Request` in the existing
 * (already `as any`-cast) handler-unit fixtures without type friction.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeLocalRequest(options: LocalRequestOptions = {}): any {
  const {
    body,
    url = 'http://localhost:4200/',
    host = 'localhost:4200',
    origin = null,
  } = options;

  const headerMap: Record<string, string | null> = {
    host: host ?? null,
    origin: origin ?? null,
  };

  return {
    url,
    headers: {
      get(name: string): string | null {
        const key = String(name).toLowerCase();
        return key in headerMap ? headerMap[key] : null;
      },
    },
    json: async () => body,
  };
}
