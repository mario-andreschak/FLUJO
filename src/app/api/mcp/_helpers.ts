import { mcpService } from '@/backend/services/mcp';
import { MCPServerConfig } from '@/shared/types/mcp';

/**
 * Shared helpers for the MCP REST routes.
 *
 * These are intentionally NOT named `route.ts`, so Next.js treats this file as a
 * plain module rather than a route handler.
 */

/**
 * Build a JSON Response with the given status code.
 */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Validate a server name for use as a URL path segment (servers are addressed at
 * `/api/mcp/servers/{name}`). We only reject what genuinely breaks routing — `/`, `\`,
 * control characters, the dot-segments `.`/`..`, empty, and absurdly long names. Spaces
 * and unicode are allowed: they survive `encodeURIComponent` round-trips fine.
 *
 * Returns an error message when invalid, or `null` when the name is acceptable.
 */
export function validateServerName(name: unknown): string | null {
  if (typeof name !== 'string' || name.length === 0) {
    return 'A non-empty server name is required';
  }
  if (name.length > 200) {
    return 'Server name must be 200 characters or fewer';
  }
  if (name === '.' || name === '..') {
    return 'Server name cannot be "." or ".."';
  }
  if (/[/\\\x00-\x1f]/.test(name)) {
    return 'Server name cannot contain "/", "\\", or control characters';
  }
  return null;
}

/**
 * Look up a single server configuration by name.
 *
 * Returns `{ config }` when found, `{ config: undefined }` when the server does not
 * exist, or `{ error }` when the underlying config store could not be read.
 */
export async function getServerConfigByName(
  name: string
): Promise<{ config?: MCPServerConfig; error?: string }> {
  const configs = await mcpService.loadServerConfigs();

  if (!Array.isArray(configs)) {
    return { error: configs.error || 'Failed to load server configs' };
  }

  return { config: configs.find((c) => c.name === name) };
}
