/** Framework-free validation for MCP App DNS values and sandbox origin keys. */

/**
 * Strict validator for an `_meta.ui.domain` declared by an MCP App server.
 * Accepted shape: ASCII lowercase DNS domain labels (a-z0-9-), no IPs, no ports,
 * no slashes, no uppercase, max 253 chars total.
 *
 * Returns true only for a syntactically safe DNS name. Callers that require one
 * label (sandbox origin keys) must additionally reject dots and enforce the
 * 63-character label limit.
 */
export function isValidMcpAppDomain(domain: unknown): domain is string {
  if (typeof domain !== 'string') return false;
  const trimmed = domain.trim();
  if (trimmed.length === 0 || trimmed.length > 253) return false;

  if (
    trimmed !== domain
    || trimmed !== trimmed.toLowerCase()
    || /[^\w.-]|[^\x00-\x7f]/i.test(trimmed)
  ) {
    return false;
  }
  if (/^\d+(\.\d+)*$/.test(trimmed) || trimmed.includes(':')) {
    return false;
  }
  if (/[/?#@]/.test(trimmed)) {
    return false;
  }

  const labels = trimmed.split('.');
  if (labels.length === 0 || labels.some(label => label.length === 0)) {
    return false;
  }
  return labels.every(label => (
    label.length <= 63
    && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)
  ));
}
