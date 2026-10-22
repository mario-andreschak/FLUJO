/**
 * Provider identities verified against their published OAuth metadata. These are
 * application trust anchors, never values learned from a connection challenge.
 * Slack: https://mcp.slack.com/.well-known/oauth-authorization-server
 */
export function knownOAuthIssuer(serverUrl: string): string | undefined {
  try {
    const url = new URL(serverUrl);
    if (url.origin === 'https://mcp.slack.com'
        && (url.pathname === '/mcp' || url.pathname === '/mcp/')
        && !url.username && !url.password && !url.search && !url.hash) {
      return 'https://mcp.slack.com';
    }
  } catch { /* Incomplete URLs remain editable in the connection form. */ }
  return undefined;
}

export function isValidOAuthIssuer(issuer: unknown): issuer is string {
  if (typeof issuer !== 'string' || !issuer || issuer !== issuer.trim()) return false;
  try {
    const url = new URL(issuer);
    return (url.protocol === 'https:' || url.protocol === 'http:')
      && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
