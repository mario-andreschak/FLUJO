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
  /**
   * Relative page path (+ hash) only, e.g. `/chat#foo`. SECURITY: never pass an
   * absolute URL/origin or a query string here (see `sanitizePageUrl`).
   */
  pageUrl?: string;
  now?: Date;
}

/**
 * Reduce any URL/path to a strictly non-sensitive, relative form: pathname + hash only.
 * The origin/host and the query string are dropped by construction, so no tunnel domain
 * or token-bearing `?...` value can ever leak into a public issue. Absent/blank → 'unknown'.
 */
export function sanitizePageUrl(raw: string | undefined | null): string {
  const value = (raw || '').trim();
  if (!value) return 'unknown';
  // Strip the query string first (may carry tokens), then keep pathname + hash.
  // Split off a fragment, then off a query string.
  const hashIndex = value.indexOf('#');
  const hash = hashIndex >= 0 ? value.slice(hashIndex) : '';
  let pathPart = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const queryIndex = pathPart.indexOf('?');
  if (queryIndex >= 0) pathPart = pathPart.slice(0, queryIndex);
  // Defensively drop any origin if an absolute URL slipped through.
  pathPart = pathPart.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '');
  const result = `${pathPart}${hash}`.trim();
  return result || 'unknown';
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
    pageUrl: sanitizePageUrl(input.pageUrl),
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

  // Relative page location ONLY (pathname + hash). Never the origin/host, and the
  // query string is dropped in the builder so no token-bearing `?...` can leak.
  const pageUrl =
    typeof window !== 'undefined'
      ? `${window.location.pathname}${window.location.hash}`
      : 'unknown';

  return buildBugReportContext({
    appVersion,
    installMode,
    mcpServerNames,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    pageUrl,
  });
}
