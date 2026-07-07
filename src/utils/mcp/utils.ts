import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from '@/utils/logger';
import { MCPServerConfig, SERVER_DIR_PREFIX } from '@/shared/types/mcp';
import { getDataDir } from '@/utils/paths';

const log = createLogger('app/api/mcp/utils');

/**
 * Check if a string is likely a filepath
 */
export function isLikelyFilePath(str: string): boolean {
  log.debug('Entering isLikelyFilePath method');
  // Simple check for file extensions or path separators
  return str.includes('.') && (
    str.includes('/') ||
    str.includes('\\') ||
    /\.[a-zA-Z0-9]+$/.test(str)
  );
}

/**
 * Check if a path is absolute
 */
export function isAbsolutePath(path: string): boolean {
  log.debug('Entering isAbsolutePath method');
  const isWindows = os.platform() === 'win32';
  if (isWindows) {
    // Windows: only drive letter paths (C:/) and UNC paths (\\) are absolute
    return /^[a-zA-Z]:[/\\]/.test(path) || path.startsWith('\\\\');
  }
  // Unix: paths starting with / are absolute
  return path.startsWith('/');
}

// OpenSSL/Node error codes that indicate a TLS certificate trust problem.
const TLS_ERROR_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_UNTRUSTED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

const TLS_MESSAGE_PATTERN = /unable to verify|self[- ]signed certificate|certificate has expired|altname|leaf signature|unable to get local issuer/i;

/**
 * Walk an error's `cause`/`errors` chain and collect every message and error code.
 *
 * This is essential for `fetch`/undici failures: the top-level error is just a generic
 * `TypeError: fetch failed`, while the real cause (e.g. a TLS verification failure with
 * code `UNABLE_TO_VERIFY_LEAF_SIGNATURE`) is buried in `error.cause`.
 */
function collectErrorChain(error: unknown): { messages: string[]; codes: string[] } {
  const messages: string[] = [];
  const codes: string[] = [];
  let current: unknown = error;
  let depth = 0;

  while (current && depth < 10) {
    if (current instanceof Error) {
      if (current.message) messages.push(current.message);
      const code = (current as unknown as { code?: unknown }).code;
      if (typeof code === 'string') codes.push(code);
    } else if (typeof current === 'string') {
      messages.push(current);
    }

    const cause = (current as { cause?: unknown })?.cause;
    const errors = (current as { errors?: unknown })?.errors;
    if (cause) {
      current = cause;
    } else if (Array.isArray(errors) && errors.length > 0) {
      current = errors[0];
    } else {
      break;
    }
    depth++;
  }

  return { messages, codes };
}

function tlsTrustHint(): string {
  return (
    'This looks like a TLS certificate trust problem: the server presents a certificate ' +
    'signed by a custom/private CA that Node.js does not trust by default.\n' +
    'To fix it, start FLUJO so Node trusts your CA:\n' +
    '  • Trust the OS certificate store (default in FLUJO): NODE_OPTIONS=--use-system-ca, or\n' +
    '  • Point Node at the CA file: set NODE_EXTRA_CA_CERTS=C:\\path\\to\\root-ca.crt (or FLUJO_EXTRA_CA_CERTS)\n' +
    'then restart FLUJO. (curl works because it uses the OS trust store; Node does not unless told to.)'
  );
}

/**
 * Build a human-readable error message from an error's full cause chain, appending the
 * relevant error code(s) and, when the failure is TLS-related, an actionable hint.
 */
export function formatErrorChain(error: unknown): string {
  const { messages, codes } = collectErrorChain(error);
  const uniqueMessages = Array.from(new Set(messages.filter(Boolean)));
  let combined = uniqueMessages.join(': ');

  if (!combined) {
    combined = error instanceof Error ? (error.message || error.name) : String(error);
  }

  const uniqueCodes = Array.from(new Set(codes));
  if (uniqueCodes.length > 0 && !uniqueCodes.some(code => combined.includes(code))) {
    combined += ` (${uniqueCodes.join(', ')})`;
  }

  const isTlsError =
    uniqueCodes.some(code => TLS_ERROR_CODES.has(code)) ||
    uniqueMessages.some(message => TLS_MESSAGE_PATTERN.test(message));
  if (isTlsError) {
    combined += `\n\n${tlsTrustHint()}`;
  }

  return combined;
}

/**
 * Enhance error messages for common MCP connection issues
 */
export function enhanceConnectionErrorMessage(error: unknown, config: MCPServerConfig, stderrLogs: string[]): string {
  log.debug('Entering enhanceConnectionErrorMessage method');
  
  // Log the stderr logs we received
  log.info(`Received ${stderrLogs.length} stderr log entries for ${config.name}`);
  if (stderrLogs.length > 0) {
    log.info(`Stderr logs for ${config.name}:\n${stderrLogs.join('\n')}`);
  }
  
  // Get any stderr logs for this server
  const stderrOutput = stderrLogs.join('\n').trim();
  
  // If we have stderr output, it should be the primary error information
  if (stderrOutput) {
    log.info(`Using stderr output as primary error information for ${config.name}: ${stderrOutput}`);
    return stderrOutput;
  } else {
    log.warn(`No stderr output available for ${config.name}`);
  }
  
  if (!(error instanceof Error)) {
    return formatErrorChain(error);
  }

  const errorMessage = error.message;
  log.debug(`Enhancing error message for: ${errorMessage}`);

  // Check if it's a timeout error
  if (errorMessage.includes('Connection timeout')) {
    return errorMessage;
  }

  // Enhance error message for MCP errors
  if (error instanceof McpError) {
    log.debug(`MCP Error code: ${error.code}`);

    if (error.code === ErrorCode.ConnectionClosed) {
      // Check if files exist
      try {
        const serverDir = `${SERVER_DIR_PREFIX}/${config.name}`;
        
        // Handle different config types
        if (config.transport === 'stdio') {
          const execPath = config.command;

          log.debug(`Server directory: ${serverDir}`);
          log.debug(`Executable path: ${execPath}`);

          // For cmd.exe (which we use for .bat files), we need to check the actual .bat file
          if (execPath === 'cmd.exe' && config.args && config.args.length > 1 && config.args[0] === '/c') {
            const batFile = config.args[1];
            log.debug(`Checking .bat file: ${batFile}`);

            // Check if the .bat file exists
            const batFilePath = path.isAbsolute(batFile)
              ? batFile
              : path.join(getDataDir(), serverDir, batFile);

            log.debug(`Full .bat file path: ${batFilePath}`);
            const batFileExists = fs.existsSync(batFilePath);
            log.debug(`.bat file exists: ${batFileExists}`);

            if (!batFileExists) {
              return `MCP connection closed: ${errorMessage}. The .bat file does not exist: ${batFilePath}${stderrOutput ? '\n\nStderr output:\n' + stderrOutput : ''}`;
            }
          }
          // Check if the command is a path (not just 'node' or 'npm')
          else if (isLikelyFilePath(execPath)) {
            log.debug(`Checking if executable exists: ${execPath}`);
            const execExists = fs.existsSync(execPath);
            log.debug(`Executable exists: ${execExists}`);

            if (!execExists) {
              // Try checking in the server directory
              const fullExecPath = path.join(getDataDir(), serverDir, execPath);
              log.debug(`Checking in server directory: ${fullExecPath}`);
              const fullExecExists = fs.existsSync(fullExecPath);
              log.debug(`Executable exists in server directory: ${fullExecExists}`);

              if (!fullExecExists) {
                return `MCP connection closed: ${errorMessage}. The executable file does not exist: ${execPath} or ${fullExecPath}${stderrOutput ? '\n\nStderr output:\n' + stderrOutput : ''}`;
              }
            }
          }

          // Check if script file exists
          if (config.args && config.args.length > 0) {
            const scriptPath = config.args[0];
            if (isLikelyFilePath(scriptPath)) {
              log.debug(`Checking script file: ${scriptPath}`);

              const fullPath = isAbsolutePath(scriptPath)
                ? scriptPath
                : path.join(getDataDir(), serverDir, scriptPath);

              log.debug(`Full script path: ${fullPath}`);
              const scriptExists = fs.existsSync(fullPath);
              log.debug(`Script exists: ${scriptExists}`);

              if (!scriptExists) {
                return `MCP connection closed: ${errorMessage}. The script file does not exist: ${fullPath}${stderrOutput ? '\n\nStderr output:\n' + stderrOutput : ''}`;
              }
            }
          }
        } else if (config.transport === 'websocket') {
          // For websocket, check if the URL is valid
          try {
            new URL(config.websocketUrl);
          } catch (urlError) {
            return `MCP connection closed: ${errorMessage}. Invalid WebSocket URL: ${config.websocketUrl}${stderrOutput ? '\n\nStderr output:\n' + stderrOutput : ''}`;
          }
        }

        // Include stderr output if available
        if (stderrOutput) {
          return `MCP connection closed: ${errorMessage}. Check if the server is running and accessible.\n\nStderr output:\n${stderrOutput}`;
        }

        return `MCP connection closed: ${errorMessage}. Check if the server is running and accessible.`;
      } catch (fsError) {
        log.warn('Error checking file existence:', fsError);
        return `MCP connection closed: ${errorMessage}. Error checking files: ${fsError instanceof Error ? fsError.message : 'Unknown error'}${stderrOutput ? '\n\nStderr output:\n' + stderrOutput : ''}`;
      }
    }

    // Include stderr output if available for other MCP errors
    if (stderrOutput) {
      return `MCP error ${error.code}: ${errorMessage}\n\nStderr output:\n${stderrOutput}`;
    }

    return `MCP error ${error.code}: ${errorMessage}`;
  }

  // For all other errors (e.g. a generic "fetch failed" from undici), walk the full
  // cause chain so the real underlying failure (TLS, DNS, ECONNREFUSED, ...) surfaces
  // instead of the unhelpful top-level message.
  const chainMessage = formatErrorChain(error);

  if (stderrOutput) {
    return `${chainMessage}\n\nStderr output:\n${stderrOutput}`;
  }

  return chainMessage;
}

// Message substrings seen across different MCP servers'/SDKs' auth-failure wording.
// Kept in addition to the numeric-code check below because some transports (e.g. stdio
// servers proxying HTTP calls) only surface the failure as free text, with no `.code`.
const AUTH_REQUIRED_MESSAGE_PATTERNS = [
  'OAuth authentication required',
  'UnauthorizedError',
  'invalid_token',
  'token_expired',
  'HTTP 401',
  'HTTP 403',
  'Missing Authorization header',
  'Authorization header is required',
];

/**
 * Detect whether a connection failure means "this server needs OAuth", covering both:
 *  - the SDK's own `OAuthAuthenticationRequired` error (thrown by our OAuthClientProvider
 *    when tokens/registration are missing), and
 *  - a raw 401/403 from a server that was never even given an auth provider (e.g. a
 *    freshly-added streamable server with no OAuth config yet, like Asana's MCP V2 API).
 *
 * `StreamableHTTPError`/`SSEError` (from the MCP SDK) carry the HTTP status on `.code`,
 * not in the message text, and the response body's exact wording varies per server -
 * so the numeric code is the primary, server-agnostic signal; the message patterns are
 * a fallback for shapes that don't set `.code`.
 *
 * Also covers the SDK's `OAuthError` family (thrown by refreshAuthorization/
 * exchangeAuthorization/registerClient when the auth server rejects a grant, e.g.
 * "invalid_grant" after a refresh token was rotated/revoked). These errors set an
 * `errorCode` getter backed by a static class property (e.g. `InvalidGrantError.errorCode
 * = 'invalid_grant'`), which survives minification even though `error.name`/`.constructor.name`
 * do not - so `.errorCode` is the reliable structural check, not the message text.
 */
export function isAuthRequiredError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  if (error.name === 'OAuthAuthenticationRequired') return true;

  const httpCode = (error as unknown as { code?: unknown }).code;
  if (httpCode === 401 || httpCode === 403) return true;

  const oauthErrorCode = (error as unknown as { errorCode?: unknown }).errorCode;
  if (typeof oauthErrorCode === 'string' && oauthErrorCode.length > 0) return true;

  return AUTH_REQUIRED_MESSAGE_PATTERNS.some(pattern => error.message.includes(pattern));
}

/**
 * Detect a transient, self-healing error from the Streamable HTTP transport's long-lived
 * server->client SSE notification stream.
 *
 * That stream is routinely recycled by servers/proxies when idle (e.g. Cloudflare in front of
 * Asana), surfacing as "SSE stream disconnected: TypeError: terminated". The MCP SDK reconnects
 * the stream itself (StreamableHTTPClientTransport._scheduleReconnection), and request/response
 * (tool calls) keep working regardless — so these are NOT fatal and must not trigger a full
 * client teardown, which would fight the SDK's reconnection and flood the console.
 */
export function isTransientStreamError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('SSE stream disconnected') ||
    message.includes('Failed to reconnect SSE stream') ||
    message.includes('Maximum reconnection attempts') ||
    /\bterminated\b/i.test(message)
  );
}

/**
 * Format error response
 */
export function formatErrorResponse(error: unknown): { error: string } {
  log.debug('Entering formatErrorResponse method');
  return {
    error: `Internal server error: ${error instanceof Error ? error.message : 'Unknown error'}`
  };
}
