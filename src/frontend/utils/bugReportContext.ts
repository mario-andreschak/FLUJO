/**
 * Allowlist-based bug-report context builder (issue #127).
 *
 * SECURITY: this module NEVER reads stores/env or serializes config. It emits only a
 * fixed set of known-safe, non-secret fields (see `SafeBugContext`). API keys, global
 * env vars, MCP `env` blocks, OAuth tokens and absolute paths are excluded by
 * construction — there is simply no code path here that could read them.
 *
 * `buildBugReportContext` is pure + synchronous (fully unit-testable in node).
 * `collectBugReportContext` is the browser-side collector that gathers the safe inputs
 * (app version + install mode from GET /api/update, MCP server *names* from
 * GET /api/mcp/servers) and delegates to the pure builder.
 */

import { SafeBugContext } from '@/shared/types/bugReport';

export interface BugReportContextInput {
  appVersion?: string;
  installMode?: string;
  mcpServerNames?: string[];
  userAgent?: string;
  now?: Date;
}

/** Derive a coarse OS label from a user-agent string (no fingerprinting). */
export function detectOs(userAgent: string): string {
  const ua = (userAgent || '').toLowerCase();
  if (ua.includes('windows')) return 'Windows';
  if (ua.includes('mac os') || ua.includes('macintosh')) return 'macOS';
  if (ua.includes('android')) return 'Android';
  if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ios')) return 'iOS';
  if (ua.includes('linux')) return 'Linux';
  return 'unknown';
}

/** Derive a coarse browser label from a user-agent string. */
export function detectBrowser(userAgent: string): string {
  const ua = userAgent || '';
  if (/edg\//i.test(ua)) return 'Edge';
  if (/opr\/|opera/i.test(ua)) return 'Opera';
  if (/firefox\//i.test(ua)) return 'Firefox';
  if (/chrome\//i.test(ua) && !/edg\//i.test(ua)) return 'Chrome';
  if (/safari\//i.test(ua) && !/chrome\//i.test(ua)) return 'Safari';
  return 'unknown';
}

/**
 * Build the allowlisted, secret-free context object. Pure + synchronous. Only the
 * known-safe fields are emitted; unknown/absent inputs collapse to 'unknown'/[].
 */
export function buildBugReportContext(input: BugReportContextInput = {}): SafeBugContext {
  const ua = input.userAgent ?? '';
  return {
    appVersion: (input.appVersion || '').trim() || 'unknown',
    installMode: (input.installMode || '').trim() || 'unknown',
    os: detectOs(ua),
    browser: detectBrowser(ua),
    mcpServerNames: Array.isArray(input.mcpServerNames)
      ? input.mcpServerNames.filter((n): n is string => typeof n === 'string' && n.length > 0)
      : [],
    timestamp: (input.now ?? new Date()).toISOString(),
  };
}

/**
 * Browser-side collector. Fetches only non-secret metadata from existing endpoints and
 * feeds the pure builder. Any fetch failure degrades gracefully to 'unknown'.
 */
export async function collectBugReportContext(): Promise<SafeBugContext> {
  let appVersion = 'unknown';
  let installMode = 'unknown';
  const mcpServerNames: string[] = [];

  try {
    const res = await fetch('/api/update');
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data === 'object') {
        appVersion = typeof data.currentVersion === 'string' ? data.currentVersion : appVersion;
        installMode =
          typeof data.updateMode === 'string'
            ? data.updateMode
            : data.isGitRepo
              ? 'git'
              : installMode;
      }
    }
  } catch {
    /* ignore — degrade gracefully */
  }

  try {
    const res = await fetch('/api/mcp/servers');
    if (res.ok) {
      const servers = await res.json();
      if (Array.isArray(servers)) {
        for (const s of servers) {
          // Names ONLY. Never include command/args/env/headers/secrets.
          if (s && typeof s.name === 'string') mcpServerNames.push(s.name);
        }
      }
    }
  } catch {
    /* ignore — degrade gracefully */
  }

  return buildBugReportContext({
    appVersion,
    installMode,
    mcpServerNames,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
  });
}
