import { NextResponse } from 'next/server';
import { isEncryptionLocked } from '@/utils/encryption/secure';

/**
 * Stage 2/4 of the #16 custom-encryption fix (issue #77): full API lockdown.
 *
 * While the store is in USER encryption mode and the server has not yet been
 * unlocked (no in-memory DEK — see Stage 1 / #76), FLUJO must fail fast on every
 * secret-touching route instead of running half-alive (undecryptable secrets or,
 * worse, writing new secrets under the wrong DEK).
 *
 * Next.js middleware runs in an edge-style runtime that cannot see the Node
 * process's in-memory unlock state, so this is deliberately NOT middleware:
 * `assertUnlocked()` is called as the first statement of each gated route
 * handler. A coverage-guard test enumerates every route and asserts each either
 * calls this helper or is on the documented allowlist, giving us deny-by-default
 * without middleware.
 */

/** Stable machine-readable code so external callers can detect the locked state. */
export const LOCKED_ERROR_CODE = 'encryption_locked';

/** 423 Locked for the FLUJO `/api/*` surface: `{ "error": "encryption_locked" }`. */
export function lockedResponse(): NextResponse {
  return NextResponse.json({ error: LOCKED_ERROR_CODE }, { status: 423 });
}

/** 423 Locked wrapped in the OpenAI error shape for the `/v1/*` surface. */
export function openAiLockedResponse(): NextResponse {
  return NextResponse.json(
    {
      error: {
        message: 'Encryption is locked. Unlock FLUJO to continue.',
        type: LOCKED_ERROR_CODE,
        code: LOCKED_ERROR_CODE,
        param: null,
      },
    },
    { status: 423 }
  );
}

/**
 * Deny an unconfigured workspace, locked USER encryption, or unavailable
 * operator protection. Existing DEFAULT metadata retains its explicit legacy
 * compatibility behavior when no operator profile is selected.
 */
export async function isLocked(): Promise<boolean> {
  return isEncryptionLocked();
}

/**
 * Returns a 423 response when the server is locked, or `null` when the request
 * may proceed. Call it first in a route handler:
 *
 *   const locked = await assertUnlocked();       // openai:true for /v1 routes
 *   if (locked) return locked;
 */
export async function assertUnlocked(opts?: { openai?: boolean }): Promise<NextResponse | null> {
  if (await isLocked()) {
    return opts?.openai ? openAiLockedResponse() : lockedResponse();
  }
  return null;
}
