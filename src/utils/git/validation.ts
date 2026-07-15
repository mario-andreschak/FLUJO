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

/**
 * Quote a single argument so a POSIX shell (/bin/sh) treats it as ONE literal
 * token: wrap the whole value in single quotes and escape any embedded single
 * quote as the classic `'\''` sequence (close-quote, escaped-quote, reopen).
 * Inside single quotes nothing is special, so `;`, `|`, `&`, `` ` ``, `$(...)`,
 * `>`, `<` etc. are all neutralized.
 */
export function posixQuoteArg(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Quote a single argument for Windows `cmd.exe` (what `execSync` / `spawn({shell:true})`
 * use on win32, via `cmd /d /s /c`). Inside a double-quoted string cmd treats shell
 * metacharacters (`&` `|` `<` `>` `^` `(` `)` etc.) literally, so wrapping the token in
 * double quotes neutralizes them; embedded double quotes are doubled (`""`) so the value
 * stays a single argument. (Caret-escaping is deliberately NOT applied here — inside a
 * quoted token a caret would be inserted literally and corrupt the value.)
 */
export function windowsQuoteArg(arg: string): string {
  return `"${arg.replace(/"/g, '""')}"`;
}

/**
 * Platform-aware single-argument shell quoting. `platform` defaults to the current
 * process platform but is injectable so both branches are unit-testable on any host.
 */
export function shellQuoteArg(arg: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? windowsQuoteArg(arg) : posixQuoteArg(arg);
}

/**
 * Assemble the final shell command run by the /api/git command runners.
 *
 * The base `command` is treated as an intentional (possibly compound, e.g.
 * `npm install && npm run build`) shell string and is passed through UN-quoted so those
 * commands keep working exactly as before. Each non-empty appended arg is shell-quoted
 * via {@link shellQuoteArg} so a metacharacter in an arg reaches the child as one literal
 * token instead of being interpreted by the shell. Shared by both the `execSync` and
 * `spawn` runners so the quoting logic lives in one tested place.
 */
export function buildRepoCommand(
  command: string,
  args: string[] | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  let finalCommand = command || '';
  if (args && args.length > 0) {
    const validArgs = args.filter(arg => arg.trim() !== '');
    if (validArgs.length > 0) {
      const argsString = validArgs.map(arg => shellQuoteArg(arg, platform)).join(' ');
      finalCommand = `${finalCommand} ${argsString}`;
    }
  }
  return finalCommand;
}
