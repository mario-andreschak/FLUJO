/**
 * Resolve a bare Node toolchain command (`node`, `npm`, `npx`) to an absolute path.
 *
 * Issue #36: MCP servers are spawned with `cross-spawn(..., { shell: false })`, which
 * searches PATH but does NOT source shell init files (`~/.zshrc`, `~/.bashrc`). When
 * FLUJO is launched from a GUI / app launcher / service rather than an interactive
 * shell, the inherited PATH may not contain the nvm-managed Node bin directory, so
 * spawning bare `node` fails with `spawn node ENOENT` even though `node` works in the
 * user's terminal.
 *
 * FLUJO itself runs as a Node process, so `process.execPath` is a guaranteed-valid
 * absolute path to a working Node binary, and `npm`/`npx` live alongside it. Resolving
 * to those absolute paths makes spawning independent of the inherited PATH.
 *
 * Notes:
 *  - Only BARE command names are resolved. An explicit path (e.g. `/usr/bin/node` or
 *    `./node`) is the user's deliberate choice and is left untouched.
 *  - Pinning to FLUJO's own Node means servers run under that version. That is the
 *    pragmatic trade-off the original fix (PR #37) made too: a working server on
 *    FLUJO's Node beats a server that never starts.
 *  - Dependencies are injected so this stays unit-testable (no real fs / process).
 */

export interface ResolveNodeCommandDeps {
  /** Absolute path to the Node binary running FLUJO (process.execPath). */
  execPath: string;
  /** Current platform (os.platform()). */
  platform: NodeJS.Platform;
  /** path.dirname */
  dirname: (p: string) => string;
  /** path.join */
  joinPath: (...parts: string[]) => string;
  /** fs.existsSync */
  fileExists: (p: string) => boolean;
}

// Bare Node toolchain commands we know how to resolve.
const NODE_TOOLCHAIN_BINS = new Set(['node', 'npm', 'npx']);

/** True if the command is a bare name (no path separator), not an explicit path. */
function isBareCommand(command: string): boolean {
  return !command.includes('/') && !command.includes('\\');
}

export function resolveNodeCommand(command: string, deps: ResolveNodeCommandDeps): string {
  if (!command || !isBareCommand(command)) {
    return command;
  }

  const bare = command.toLowerCase();
  if (!NODE_TOOLCHAIN_BINS.has(bare)) {
    return command;
  }

  // `node` itself: the binary running FLUJO is the most reliable answer.
  if (bare === 'node') {
    return deps.execPath || command;
  }

  // `npm` / `npx`: these ship next to the node binary. On Windows they are
  // .cmd shims (npm.cmd / npx.cmd); on Unix they are extension-less scripts.
  if (!deps.execPath) {
    return command;
  }
  const binDir = deps.dirname(deps.execPath);
  const candidates =
    deps.platform === 'win32' ? [`${bare}.cmd`, `${bare}.exe`, bare] : [bare];

  for (const candidate of candidates) {
    const candidatePath = deps.joinPath(binDir, candidate);
    if (deps.fileExists(candidatePath)) {
      return candidatePath;
    }
  }

  // Sibling not found (unusual layout) — leave the bare command so cross-spawn
  // can still try PATH.
  return command;
}
