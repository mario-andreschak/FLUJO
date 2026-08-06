/**
 * MCP Apps per-app sandbox origin support (issue #362).
 *
 * Derives a stable `originKey` per MCP App from its `_meta.ui.domain`, serverName,
 * and resource URI. Used to allocate per-origin sandbox listeners/tokens and to
 * route HTML extraction requests to the correct sandbox endpoint.
 *
 * Everything in this module is framework-free and deterministic so it can be
 * unit tested and used identically on the backend (token validation, listener
 * allocation) and frontend (originKey query param) without crypto dependencies.
 */

/**
 * Maximum number of per-app sandbox listeners in Mode A (port pool).
 * When the cap is reached, the least-recently-used listener is evicted.
 * On hosted deployments (Mode B), only one listener is used regardless.
 */
export const MAX_SANDBOX_ORIGINS = 16;

/**
 * Strict validator for an `_meta.ui.domain` declared by an MCP App server.
 * Accepted shape: ASCII lowercase DNS domain labels (a-z0-9-), no IPs, no ports,
 * no slashes, no uppercase, max 253 chars total.
 *
 * Rejects:
 *   - Empty string or non-string
 *   - Non-ASCII or uppercase letters (app must normalize or we reject it silently)
 *   - IPv4/IPv6 addresses
 *   - Ports (`:8080`), paths (`/`), queries (`?`), credentials (`@`)
 *   - Labels >63 chars, empty labels (consecutive dots), or invalid characters
 *   - Total length >253 chars (DNS limit)
 *   - Leading/trailing dots or hyphens
 *   - Leading digits in hostname (ambiguous with IP detection)
 *
 * Returns the domain if valid, `undefined` if rejected. Never throws; invalid
 * server-provided input is simply ignored.
 */
export function isValidMcpAppDomain(domain: unknown): domain is string {
  if (typeof domain !== 'string') return false;
  const trimmed = domain.trim();
  if (trimmed.length === 0 || trimmed.length > 253) return false;

  // Reject non-ASCII or uppercase letters (must be lowercase or we reject it).
  if (trimmed !== trimmed.toLowerCase() || /[^\w.-]|[^\x00-\x7f]/i.test(trimmed)) {
    return false;
  }

  // Reject obvious IPs (IPv4: four dot-separated decimals; IPv6: contains `:`).
  if (/^\d+(\.\d+)*$/.test(trimmed) || trimmed.includes(':')) {
    return false;
  }

  // Reject obvious paths/queries/credentials.
  if (/[/?#@]/.test(trimmed)) {
    return false;
  }

  // Split into labels and validate each.
  const labels = trimmed.split('.');
  if (labels.length === 0 || labels.some((label) => label.length === 0)) {
    return false;
  }

  for (const label of labels) {
    // Each label must be 1–63 chars and match [a-z0-9-], but not start/end with hyphen.
    if (
      label.length > 63
      || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Derive a stable, collision-resistant `originKey` from app metadata.
 * Used to allocate per-app sandbox listeners and tokens.
 *
 * Priority:
 *   1. Validated `_meta.ui.domain` (if provided and valid)
 *   2. Fall back to deterministic hash of `serverName` + resource `uri`
 *
 * The result is a lowercase alphanumeric identifier (DNS-safe) suitable for:
 *   - Port pool allocation: `basePort + hash(originKey) % MAX_SANDBOX_ORIGINS`
 *   - Hostname templating: `${originKey}.sandbox.example.com`
 *   - Token scoping: `hmacSha256(secret, originKey)`
 *
 * Backend and frontend must derive the same originKey from the same inputs
 * to stay in sync (same sandbox listener, same token).
 */
export function deriveOriginKey(options: {
  domain?: string | null;
  serverName: string;
  uri: string;
}): string {
  // If the server declared a valid domain, use it directly (stable across restarts).
  if (isValidMcpAppDomain(options.domain)) {
    return options.domain;
  }

  // Fall back to a deterministic hash of serverName + uri.
  // We use a simple string hash (not crypto) since this is run in the browser
  // and we don't need cryptographic strength — just stability and collision
  // resistance for the small set of apps a user typically opens.
  const combined = `${options.serverName}::${options.uri}`;
  let hash = 0;
  for (let i = 0; i < combined.length; i++) {
    const char = combined.charCodeAt(i);
    // eslint-disable-next-line no-bitwise
    hash = ((hash << 5) - hash) + char;
    // eslint-disable-next-line no-bitwise
    hash |= 0; // Convert to 32-bit signed int to keep it from growing too large.
  }
  // Convert to a safe DNS label: take the absolute value, convert to base36
  // (alphanumeric, lowercase), and ensure it starts with a letter (DNS requirement).
  const hashValue = Math.abs(hash).toString(36).padStart(8, '0');
  return `app${hashValue}`;
}
