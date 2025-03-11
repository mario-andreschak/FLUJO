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

// In-memory session store
// In a production environment, this could be replaced with a more robust solution
// like Redis or a database, especially for multi-server deployments
const sessions: Map<string, EncryptionSession> = new Map();

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

