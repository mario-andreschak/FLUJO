// eslint-disable-next-line import/named
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '@/utils/logger';

const log = createLogger('utils/encryption/session');

// Session store for encryption keys
interface EncryptionSession {
  token: string;
  dek: string; // The Data Encryption Key in string format
  createdAt: number; // Timestamp when the session was created
  lastUsed: number; // Timestamp when the session was last used
}

// Session expiration time (2 hours)
const SESSION_EXPIRATION_MS = 2 * 60 * 60 * 1000;

declare global {
  // The 2-hour token sessions used by the UI unlock dialog. Global-backed so
  // that Next.js dev-mode HMR (which can duplicate this module) does not create
  // a split-brain where different routes see different session stores.
  // eslint-disable-next-line no-var
  var __flujo_encryption_sessions: Map<string, EncryptionSession> | undefined;
  // The process-wide server unlock state: the plaintext DEK (hex string) that
  // was recovered when the user authenticated. Non-expiring — cleared only when
  // the process exits. Also global-backed to survive HMR module duplication so
  // routes never see a locked/unlocked split-brain.
  // eslint-disable-next-line no-var
  var __flujo_server_dek: string | null | undefined;
}

// In-memory session store, backed by `global` to survive dev-mode HMR.
// In a production environment, this could be replaced with a more robust solution
// like Redis or a database, especially for multi-server deployments.
const sessions: Map<string, EncryptionSession> =
  global.__flujo_encryption_sessions ?? (global.__flujo_encryption_sessions = new Map());

/**
 * Create a new encryption session
 * @param dek The Data Encryption Key to store in the session
 * @returns The session token
 */
export function createSession(dek: string): string {
  // Generate a unique token
  const token = uuidv4();
  const now = Date.now();
  
  // Create the session
  const session: EncryptionSession = {
    token,
    dek,
    createdAt: now,
    lastUsed: now
  };
  
  // Store the session
  sessions.set(token, session);
  log.info(`Created encryption session: ${token}`);
  
  // Schedule cleanup of expired sessions
  scheduleCleanup();
  
  return token;
}

/**
 * Get the DEK from a session
 * @param token The session token
 * @returns The DEK or null if the session is invalid or expired
 */
export function getDekFromSession(token: string): string | null {
  // Get the session
  const session = sessions.get(token);
  if (!session) {
    log.warn(`Session not found: ${token}`);
    return null;
  }
  
  // Check if the session has expired
  const now = Date.now();
  if (now - session.createdAt > SESSION_EXPIRATION_MS) {
    log.warn(`Session expired: ${token}`);
    sessions.delete(token);
    return null;
  }
  
  // Update the last used timestamp
  session.lastUsed = now;
  
  return session.dek;
}

/**
 * Invalidate a session
 * @param token The session token
 */
export function invalidateSession(token: string): void {
  if (sessions.has(token)) {
    sessions.delete(token);
    log.info(`Invalidated encryption session: ${token}`);
  }
}

/**
 * Server unlock state
 * -------------------
 * Once the user authenticates, the plaintext DEK is held process-wide (with no
 * expiry) so that background/tokenless secret operations (env vars, model API
 * keys, global-var resolution) can use the correct USER DEK. This is the
 * authoritative backend-decryption source; the 2-hour token sessions above
 * remain only for the UI dialog flow.
 */

/**
 * Record the server unlock state.
 * @param dek The plaintext Data Encryption Key (hex string).
 */
export function unlockServer(dek: string): void {
  global.__flujo_server_dek = dek;
  log.info('Server encryption unlocked');
}

/**
 * Clear the server unlock state (re-lock the server).
 */
export function lockServer(): void {
  global.__flujo_server_dek = null;
  log.info('Server encryption locked');
}

/**
 * Whether the server is currently locked (no unlock DEK present).
 */
export function isServerLocked(): boolean {
  return !global.__flujo_server_dek;
}

/**
 * Get the server unlock DEK, or null if the server is locked.
 */
export function getServerDek(): string | null {
  return global.__flujo_server_dek ?? null;
}

/**
 * Clean up expired sessions
 */
function cleanupExpiredSessions(): void {
  const now = Date.now();
  let expiredCount = 0;
  
  for (const [token, session] of sessions.entries()) {
    if (now - session.createdAt > SESSION_EXPIRATION_MS) {
      sessions.delete(token);
      expiredCount++;
    }
  }
  
  if (expiredCount > 0) {
    log.info(`Cleaned up ${expiredCount} expired encryption sessions`);
  }
}

/**
 * Schedule cleanup of expired sessions
 * This runs every hour to clean up expired sessions
 */
let cleanupInterval: NodeJS.Timeout | null = null;
function scheduleCleanup(): void {
  if (!cleanupInterval) {
    // Run cleanup every hour
    cleanupInterval = setInterval(cleanupExpiredSessions, 60 * 60 * 1000);
    // Ensure the interval doesn't prevent the process from exiting
    if (cleanupInterval.unref) {
      cleanupInterval.unref();
    }
  }
}
