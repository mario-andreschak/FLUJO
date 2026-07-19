/**
 * Shared types + constants for the in-app Bug Report feature (issue #127).
 *
 * SECURITY: `SafeBugContext` is an *allowlist* of fields that are safe to attach to a
 * public GitHub issue. It must never carry model API keys, global env vars, MCP `env`
 * blocks, OAuth tokens, absolute paths, or any store/config dumps. Everything here is
 * plain, non-secret metadata that the user always sees before it leaves the app.
 */

/** Labels the bug-report dialog / AI enhancer may apply (fixed allowlist). */
export const BUG_REPORT_LABELS = [
  'bug',
  'ux',
  'frontend',
  'backend',
  'github-integration',
  'mcp',
  'performance',
] as const;

export type BugReportLabel = (typeof BUG_REPORT_LABELS)[number];

/** The GitHub repository bug reports are filed against. */
export const BUG_REPORT_REPO = 'mario-andreschak/FLUJO';

/** Allowlisted, provably-safe app context attached to a bug report. */
export interface SafeBugContext {
  appVersion: string;
  installMode: string;
  os: string;
  browser: string;
  mcpServerNames: string[];
  /**
   * The relative page path (+ hash) the user was on when reporting, e.g. `/chat#foo`.
   * SECURITY: relative only — never the origin/host, and never the query string, so no
   * tunnel domain or token-bearing `?...` value can leak. Defaults to 'unknown'.
   */
  pageUrl: string;
  timestamp: string;
}

/**
 * The exact set of keys allowed on `SafeBugContext`. Used for server-side
 * sanitization (defense in depth): the backend rebuilds the context from these
 * keys only, so any extra field the client might send is dropped by construction.
 */
export const SAFE_BUG_CONTEXT_KEYS: ReadonlyArray<keyof SafeBugContext> = [
  'appVersion',
  'installMode',
  'os',
  'browser',
  'mcpServerNames',
  'pageUrl',
  'timestamp',
];

export interface EnhanceRequest {
  modelId: string;
  title: string;
  description: string;
  context?: unknown;
}

export interface EnhanceResult {
  /** Suggested issue title. */
  title: string;
  /** GitHub-markdown narrative body (WITHOUT the environment block — the client
   * appends that once at submit time, so it is never duplicated). */
  body: string;
  labels: BugReportLabel[];
  severity?: string;
  /** false when the AI call failed/couldn't be parsed and the original text was returned unchanged. */
  enhanced: boolean;
}

/**
 * Render the allowlisted context as a fenced "Environment" block appended to the
 * issue body. Pure + secret-free by construction (only reads `SafeBugContext`).
 */
export function formatContextBlock(ctx: SafeBugContext): string {
  return [
    '### Environment',
    '```',
    `App version: ${ctx.appVersion}`,
    `Install mode: ${ctx.installMode}`,
    `OS: ${ctx.os}`,
    `Browser: ${ctx.browser}`,
    `MCP servers: ${ctx.mcpServerNames.length ? ctx.mcpServerNames.join(', ') : '(none)'}`,
    `Page: ${ctx.pageUrl}`,
    `Reported: ${ctx.timestamp}`,
    '```',
  ].join('\n');
}
