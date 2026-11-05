/**
 * Optional: unlock a password-protected instance at startup with nobody present.
 *
 * Off unless FLUJO_UNLOCK_SECRET_SOURCE names a source. Without that, a secret in
 * the environment is ignored and removed, and the lock behaves exactly as always.
 * The launcher reads the source; this side only receives the result.
 *
 * Taken out of the environment at once, so MCP servers and other child programs,
 * which inherit it, never see the secret. A wrong secret leaves the instance locked,
 * and the same message is logged whatever the reason, with no detail about the secret.
 */
import { createLogger } from '@/utils/logger';
import { isEncryptionLocked, isUserEncryptionEnabled, logout, verifyPassword } from '@/utils/encryption/secure';

const log = createLogger('backend/services/security/unattendedUnlock');

/** What a person sets. The server never reads it: it may have come from a .env file. */
export const UNLOCK_SECRET_VARIABLE = 'FLUJO_UNLOCK_SECRET';
/** Set only by the launcher, after it has applied the rules about where a secret may come from. */
export const CHECKED_SECRET_VARIABLE = 'FLUJO_UNLOCK_SECRET_CHECKED';
export const UNLOCK_SOURCE_VARIABLE = 'FLUJO_UNLOCK_SECRET_SOURCE';

declare global {
  // Global-backed: route bundles can duplicate this module, and the variable is
  // removed from the environment after the first read.
  var __flujo_unattended_unlock_secret: string | null | undefined;
}

export function unlockSourceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const source = env[UNLOCK_SOURCE_VARIABLE]?.trim().toLowerCase();
  return source === 'env' || source === 'dpapi';
}

/** Move the secret out of the environment. Safe to call more than once. */
export function captureUnattendedUnlockSecret(env: NodeJS.ProcessEnv = process.env): void {
  const secret = env[CHECKED_SECRET_VARIABLE];
  delete env[CHECKED_SECRET_VARIABLE];
  delete env[UNLOCK_SECRET_VARIABLE];
  if (global.__flujo_unattended_unlock_secret !== undefined) return;
  global.__flujo_unattended_unlock_secret = unlockSourceEnabled(env) && secret ? secret : null;
}

/**
 * Called for each workspace before its secret-dependent services start. It leaves
 * the normal unlock path untouched: a workspace it cannot open stays locked and
 * waits for a person, as it does without this feature.
 */
export async function attemptUnattendedUnlock(): Promise<boolean> {
  captureUnattendedUnlockSecret();
  const secret = global.__flujo_unattended_unlock_secret;
  if (!secret) return false;
  try {
    if (!(await isUserEncryptionEnabled()) || !(await isEncryptionLocked())) return false;
    const { valid, token } = await verifyPassword(secret);
    if (!valid) {
      log.error('Unattended unlock did not succeed; this workspace stays locked until someone unlocks it.');
      return false;
    }
    // Only the server unlock is wanted. Nobody will use this browser session token.
    if (token) await logout(token);
    log.info('Unattended unlock succeeded.');
    return true;
  } catch {
    log.error('Unattended unlock did not succeed; this workspace stays locked until someone unlocks it.');
    return false;
  }
}

/** Test helper. */
export function _resetUnattendedUnlock(): void {
  global.__flujo_unattended_unlock_secret = undefined;
}
