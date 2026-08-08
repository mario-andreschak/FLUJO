import { createHash } from 'node:crypto';

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
}): string {
  const { workspace, serverName, uri } = options;
  if (!workspace || !serverName || !uri) {
    throw new Error('A workspace, server name, and resource URI are required');
  }

  // JSON's explicit tuple boundaries prevent ambiguous concatenations such as
  // ["ab", "c"] and ["a", "bc"] from sharing the same hash input.
  const digest = createHash('sha256')
    .update(JSON.stringify(['flujo-mcp-app-origin-v1', workspace, serverName, uri]), 'utf8')
    .digest('hex');
  return `app${digest.slice(0, 60)}`;
}
