import { createHash } from 'node:crypto';

/**
 * Deployment-owned namespace for installations whose otherwise-identical
 * workspaces live in separate tenant processes behind one wildcard domain.
 * Empty preserves the original v1 derivation byte-for-byte for local installs.
 */
export const MCP_APP_ORIGIN_NAMESPACE_ENV = 'FLUJO_MCP_APP_ORIGIN_NAMESPACE';

function configuredOriginNamespace(): string {
  const value = process.env[MCP_APP_ORIGIN_NAMESPACE_ENV]?.trim() ?? '';
  if (value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${MCP_APP_ORIGIN_NAMESPACE_ENV} must be at most 512 printable characters`);
  }
  return value;
}

/**
 * Derive the browser-origin partition for a resource whose identity has already
 * been verified by an exact MCP `resources/read` response.
 *
 * The key deliberately does not trust `_meta.ui.domain`: that value is supplied
 * by the app server and two unrelated servers could claim the same domain. The
 * workspace, configured server name, and exact resource URI are all host-owned
 * identity inputs. A 240-bit prefix of SHA-256 leaves room for the `app` prefix
 * while keeping the result within one 63-character DNS label.
 */
export function deriveVerifiedMcpAppOriginKey(options: {
  workspace: string;
  serverName: string;
  uri: string;
  /** Explicit override for tests/callers; defaults to the deployment env. */
  namespace?: string;
}): string {
  const { workspace, serverName, uri } = options;
  if (!workspace || !serverName || !uri) {
    throw new Error('A workspace, server name, and resource URI are required');
  }

  const namespace = options.namespace === undefined
    ? configuredOriginNamespace()
    : options.namespace.trim();
  if (namespace.length > 512 || /[\u0000-\u001f\u007f]/.test(namespace)) {
    throw new Error('The MCP App origin namespace must be at most 512 printable characters');
  }

  // JSON's explicit tuple boundaries prevent ambiguous concatenations such as
  // ["ab", "c"] and ["a", "bc"] from sharing the same hash input.
  // Keep the original tuple when no deployment namespace is configured so
  // existing local browser origins/storage partitions remain stable.
  const identity = namespace
    ? ['flujo-mcp-app-origin-v2', namespace, workspace, serverName, uri]
    : ['flujo-mcp-app-origin-v1', workspace, serverName, uri];
  const digest = createHash('sha256')
    .update(JSON.stringify(identity), 'utf8')
    .digest('hex');
  return `app${digest.slice(0, 60)}`;
}
