/**
 * Resolve the working directory to spawn a local (stdio) MCP server in.
 *
 * Issue #40: package-runner commands (`npx`, `uvx`, `bunx`, `pnpm dlx`, ...) fetch
 * and execute a *published* package. If they are run from inside a directory that
 * IS that package — e.g. a same-named clone left in `mcp-servers/<name>`, which is
 * also FLUJO's default cwd for a server — the runner resolves the local bin instead
 * of fetching it. On Windows that surfaces as `Der Befehl "<bin>" ... nicht gefunden`
 * / "command not found", because the local package has no PATH shim.
 *
 * The cwd is irrelevant to what these runners fetch, so for them we drop the
 * package-named leaf directory and run from its parent instead. Non-runner commands
 * (`node dist/index.js`, `python -m ...`) genuinely need the package directory and
 * are left untouched.
 *
 * This is a pure function (no fs / no node `path`) so it can run unchanged in both
 * the backend connection path and the browser-side "Test" path.
 */

// Commands that always fetch-and-run a package, so the cwd should never be the
// package's own directory.
const PACKAGE_RUNNER_BINS = new Set(['npx', 'bunx', 'uvx', 'pipx', 'dlx']);

// Package managers that can run a fetched package via a subcommand (e.g.
// `pnpm dlx <pkg>`, `yarn dlx <pkg>`, `bun x <pkg>`, `npm exec <pkg>`).
const PACKAGE_MANAGER_BINS = new Set(['pnpm', 'yarn', 'bun', 'npm']);
const PACKAGE_MANAGER_RUN_SUBCOMMANDS = new Set(['dlx', 'exec', 'x']);

/** Last path segment of a command/path, lowercased, with a Windows executable
 *  extension stripped. `C:\\tools\\npx.cmd` -> `npx`, `/usr/bin/uvx` -> `uvx`. */
function normalizeBin(command: string): string {
  const leaf = command.split(/[\\/]/).filter(Boolean).pop() || '';
  return leaf.toLowerCase().replace(/\.(cmd|exe|bat|ps1)$/i, '');
}

/** Last non-empty path segment of a directory path (handles / and \\, trailing
 *  separators). Returns '' if there is none. */
function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() || '';
}

/** Everything before the last segment of a path, preserving the original
 *  separator style. Returns '' when there is no parent. */
function parentDir(p: string): string {
  const match = p.match(/^(.*[\\/])[^\\/]+[\\/]*$/);
  return match ? match[1].replace(/[\\/]+$/, '') : '';
}

/**
 * @returns true when `command` (optionally with its `args`) is a package runner
 *          that fetches and executes a published package.
 */
export function isPackageRunnerCommand(command: string, args: string[] = []): boolean {
  const bin = normalizeBin(command || '');
  if (PACKAGE_RUNNER_BINS.has(bin)) {
    return true;
  }
  if (PACKAGE_MANAGER_BINS.has(bin)) {
    const sub = (args[0] || '').toLowerCase();
    return PACKAGE_MANAGER_RUN_SUBCOMMANDS.has(sub);
  }
  return false;
}

export interface ResolveServerCwdParams {
  command: string;
  args?: string[];
  /** Explicit root path stored on the config, if any. */
  rootPath?: string;
  /** Legacy `cwd` field on the config, if any. */
  cwd?: string;
  serverName: string;
  /** The fallback cwd used today when neither rootPath nor cwd is set
   *  (e.g. `mcp-servers/<name>`). */
  defaultCwd: string;
}

/**
 * Decide the cwd for a stdio MCP server, applying the package-runner fix above.
 */
export function resolveServerCwd({
  command,
  args = [],
  rootPath,
  cwd,
  serverName,
  defaultCwd,
}: ResolveServerCwdParams): string {
  const resolved = rootPath || cwd || defaultCwd;

  // Only intervene when a package runner is about to run from inside its own
  // package-named directory. Anything else is left exactly as configured.
  if (
    serverName &&
    isPackageRunnerCommand(command, args) &&
    basename(resolved) === serverName
  ) {
    const parent = parentDir(resolved);
    return parent || resolved;
  }

  return resolved;
}
