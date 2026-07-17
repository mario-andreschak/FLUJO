/**
 * Client-side GitHub "new issue" pre-fill (issue #127).
 *
 * The safest possible submission mechanism: no GitHub token, no server process, no
 * auto-submit. We assemble a `github.com/<repo>/issues/new?title=&body=&labels=` URL and
 * open it in a new tab; the user reviews the pre-filled form on GitHub and submits it
 * themselves. Labels are restricted to the fixed allowlist, and the body is trimmed to
 * stay under GitHub's new-issue URL length limit.
 */

import { BUG_REPORT_LABELS, BUG_REPORT_REPO, BugReportLabel } from '@/shared/types/bugReport';

/** GitHub rejects excessively long new-issue URLs; keep a safe budget (~8 KB). */
export const MAX_ISSUE_URL_LENGTH = 8000;

const TRUNCATION_NOTE =
  '\n\n_(Report truncated to fit GitHub URL limits — please paste any remaining logs/details manually.)_';

export interface NewIssueParams {
  title: string;
  body: string;
  labels?: string[];
}

/** Keep only labels from the fixed allowlist (deduped, order preserved). */
function safeLabels(labels: string[] = []): BugReportLabel[] {
  const allow = BUG_REPORT_LABELS as readonly string[];
  const seen = new Set<string>();
  const out: BugReportLabel[] = [];
  for (const l of labels) {
    if (typeof l === 'string' && allow.includes(l) && !seen.has(l)) {
      seen.add(l);
      out.push(l as BugReportLabel);
    }
  }
  return out;
}

/**
 * Build a pre-filled GitHub new-issue URL. Everything is URL-encoded via
 * URLSearchParams; if the result exceeds the length budget the body is trimmed
 * (with a "paste manually" note appended) until it fits.
 */
export function buildNewIssueUrl(
  { title, body, labels = [] }: NewIssueParams,
  repo: string = BUG_REPORT_REPO
): string {
  const allowed = safeLabels(labels);
  const base = `https://github.com/${repo}/issues/new`;

  const build = (b: string): string => {
    const params = new URLSearchParams();
    if (title) params.set('title', title);
    params.set('body', b);
    if (allowed.length) params.set('labels', allowed.join(','));
    return `${base}?${params.toString()}`;
  };

  let url = build(body);
  if (url.length <= MAX_ISSUE_URL_LENGTH) return url;

  // Trim the body until the encoded URL (with the truncation note) fits.
  let trimmed = body;
  url = build(trimmed + TRUNCATION_NOTE);
  while (url.length > MAX_ISSUE_URL_LENGTH && trimmed.length > 0) {
    const excess = url.length - MAX_ISSUE_URL_LENGTH;
    // Encoding can expand characters, so cut a bit more than the raw overshoot.
    const cut = Math.max(16, Math.ceil(excess * 1.2));
    trimmed = trimmed.slice(0, Math.max(0, trimmed.length - cut));
    url = build(trimmed + TRUNCATION_NOTE);
  }
  return url;
}

/** Open the pre-filled GitHub new-issue form in a new tab (browser only). */
export function openGitHubNewIssue(params: NewIssueParams, repo?: string): string {
  const url = buildNewIssueUrl(params, repo);
  if (typeof window !== 'undefined') {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
  return url;
}
