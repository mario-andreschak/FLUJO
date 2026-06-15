// Logger utility
import { FEATURES } from '@/config/features';

export const LOG_LEVEL = {
  VERBOSE: -1, // Most verbose level for extremely detailed logging
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
};

// Use the feature flag with a fallback to ERROR level if not set
export const CURRENT_LOG_LEVEL = 
  typeof FEATURES.LOG_LEVEL === 'number' ? FEATURES.LOG_LEVEL : LOG_LEVEL.ERROR;

/**
 * Convert an Error (and any nested Errors in its `cause`/`errors`) into a plain object
 * that JSON.stringify can render. Without this, Errors serialize to "{}" because their
 * standard properties are non-enumerable.
 */
function errorToPlain(err: unknown, depth = 0): unknown {
  if (depth > 6) return String(err);
  if (!(err instanceof Error)) return err;

  const plain: Record<string, unknown> = {
    name: err.name,
    message: err.message,
  };

  for (const key of Object.getOwnPropertyNames(err)) {
    if (key === 'name' || key === 'message') continue;
    const value = (err as unknown as Record<string, unknown>)[key];
    if (typeof value === 'function') continue;
    if (key === 'stack') {
      plain.stack = value;
    } else if (key === 'cause') {
      plain.cause = errorToPlain(value, depth + 1);
    } else if (key === 'errors' && Array.isArray(value)) {
      plain.errors = value.map(e => errorToPlain(e, depth + 1));
    } else {
      plain[key] = value;
    }
  }

  return plain;
}

function logWithLevel(level: number, filepath: string, message: string, data?: any, overrideLogLevel?: number) {
  // Use the override log level if provided, otherwise use the global setting
  const effectiveLogLevel = typeof overrideLogLevel === 'number' ? overrideLogLevel : CURRENT_LOG_LEVEL;
  
  if (level >= effectiveLogLevel) {
    const timestamp = new Date().toISOString();
    const logPrefix = `[${timestamp}] [${filepath}]`;
    
    let output = `${logPrefix} ${message}`;
    if (data !== undefined) {
      if (data instanceof Error || typeof data === 'object') {
        try {
          // Error objects have no enumerable own properties, so a naive JSON.stringify(error)
          // produces "{}". Normalize Errors (and any nested Errors) into plain objects that
          // preserve name/message/stack/code and walk the `cause` chain (undici/fetch hide the
          // real failure inside error.cause).
          const normalized = data instanceof Error ? errorToPlain(data) : data;
          const replacer = (_key: string, value: unknown) =>
            value instanceof Error ? errorToPlain(value) : value;
          const dataStr = JSON.stringify(normalized, replacer, 2);
          output += `:\n${dataStr}`;
        } catch (e) {
          output += ': [Object cannot be stringified]';
        }
      } else {
        output += `: ${data}`;
      }
    }

    switch (level) {
      case LOG_LEVEL.VERBOSE:
        console.debug(`[VERBOSE] ${output}`);
        break;
      case LOG_LEVEL.DEBUG:
        console.debug(output);
        break;
      case LOG_LEVEL.INFO:
        console.info(output);
        break;
      case LOG_LEVEL.WARN:
        console.warn(output);
        break;
      case LOG_LEVEL.ERROR:
        console.error(output);
        break;
      default:
        console.log(output);
    }
  }
}

/**
 * Normalizes a file path to ensure consistent logging format
 * Removes src/ prefix if present and ensures proper formatting
 */
export function normalizeFilePath(filepath: string): string {
  // Remove src/ prefix if present
  let normalizedPath = filepath.replace(/^src\//, '');
  
  // Ensure the path has the correct format
  if (normalizedPath.startsWith('/')) {
    normalizedPath = normalizedPath.substring(1);
  }
  
  return normalizedPath;
}

/**
 * Creates a logger instance with a pre-configured file path
 * This makes it easier to use the logger consistently across the application
 * 
 * @param filepath - The file path to use for logging
 * @param overrideLogLevel - Optional parameter to override the global log level for this logger instance
 */
export function createLogger(filepath: string, overrideLogLevel?: number) {
  const normalizedPath = normalizeFilePath(filepath);
  
  return {
    verbose: (message: string, data?: any) => {
      logWithLevel(LOG_LEVEL.VERBOSE, normalizedPath, message, data, overrideLogLevel);
    },
    debug: (message: string, data?: any) => {
      logWithLevel(LOG_LEVEL.DEBUG, normalizedPath, message, data, overrideLogLevel);
    },
    info: (message: string, data?: any) => {
      logWithLevel(LOG_LEVEL.INFO, normalizedPath, message, data, overrideLogLevel);
    },
    warn: (message: string, data?: any) => {
      logWithLevel(LOG_LEVEL.WARN, normalizedPath, message, data, overrideLogLevel);
    },
    error: (message: string, data?: any) => {
      logWithLevel(LOG_LEVEL.ERROR, normalizedPath, message, data, overrideLogLevel);
    }
  };
}
