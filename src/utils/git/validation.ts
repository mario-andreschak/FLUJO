/**
 * Validation helpers for user-supplied git parameters.
 *
 * Defense-in-depth against the simple-git argument/URL-injection advisory class
 * (GHSA-hffm-xvc3-vprc, GHSA-r275-fr43-pm7q, GHSA-jcxm-m3jx-f287): the /api/git
 * clone action receives a user-supplied repository URL, so only well-formed remote
 * URLs over safe transports are accepted, and nothing that could be parsed as a
 * command-line option or a local/exotic transport (file://, ext::, etc.) is
 * allowed through.
 */

const ALLOWED_GIT_PROTOCOLS = new Set(['http:', 'https:', 'git:', 'ssh:']);

export function isSafeRepoUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  // Anything starting with '-' could be interpreted as a git option.
  if (trimmed.startsWith('-')) return false;
  // No embedded whitespace or control characters in a remote URL.
  // eslint-disable-next-line no-control-regex
  if (/[\s\x00-\x1f]/.test(trimmed)) return false;
  // scp-like syntax: user@host:path (no scheme). Host and user are restricted to
  // hostname-safe characters; the path must not look like an option.
  if (!trimmed.includes('://') && /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^-][^\s]*$/.test(trimmed)) {
    return true;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  return ALLOWED_GIT_PROTOCOLS.has(parsed.protocol);
}

/**
 * A branch value is passed to `git clone --branch <value>`; refuse values that
 * could be parsed as an option instead of a ref name.
 */
export function isSafeBranchName(branch: unknown): boolean {
  if (typeof branch !== 'string') return false;
  const trimmed = branch.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('-')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\s\x00-\x1f]/.test(trimmed)) return false;
  return true;
}
