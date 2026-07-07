import path from 'path';

/**
 * Central resolver for the two directories FLUJO cares about at runtime.
 *
 * Historically everything was `process.cwd()`-relative, which is correct for a
 * plain `git clone` + `npm start` install (code and data live together in the
 * repo). The Docker image (#57) and the npm package (#59) both need to keep
 * *writable user data* out of the (effectively read-only) application install,
 * so this module draws the line between the two:
 *
 *   - APP dir  — where the code + built assets live (package.json, .next, and,
 *                for a git checkout, .git + the update scripts). Read-only in a
 *                packaged install.
 *   - DATA dir — where user data lives (db/, mcp-servers/, conversation logs).
 *                A named volume in Docker, ~/.flujo for the npm package.
 *
 * By defaulting the DATA dir to the APP dir, an existing git-checkout install is
 * completely unchanged: data stays in <repo>/db and <repo>/mcp-servers, and the
 * self-updater keeps working. Only setting FLUJO_DATA_DIR relocates data.
 */

/**
 * Where FLUJO's application code lives — the directory it was launched from.
 * Holds package.json, the built `.next` output and (in a git checkout) `.git`
 * plus the update scripts. Never write user data here in a packaged install.
 */
export function getAppDir(): string {
  return process.cwd();
}

/**
 * Where FLUJO's user data lives — db/, mcp-servers/, conversation logs, etc.
 *
 * Defaults to the app dir so a plain git-checkout install is byte-for-byte
 * unchanged. Set FLUJO_DATA_DIR to relocate all user data (this is how the
 * `npx flujo` and Docker distributions keep writable data out of the read-only
 * application install, e.g. ~/.flujo or a mounted /app/db volume).
 */
export function getDataDir(): string {
  const custom = process.env.FLUJO_DATA_DIR;
  return custom && custom.trim().length > 0 ? path.resolve(custom) : getAppDir();
}

export type InstallMode = 'git' | 'container' | 'npm';

/**
 * How this FLUJO instance was installed — this decides whether and how it can
 * update itself. The update route and Settings UI switch on this single value
 * instead of scattering env-var checks around the codebase.
 *
 *  - 'container': running inside the official Docker image (FLUJO_CONTAINER=1).
 *                 Updating means pulling a newer image.
 *  - 'npm':       installed as an npm package; the `flujo` bin wrapper sets
 *                 FLUJO_NPM=1. Updating means reinstalling the package.
 *  - 'git':       a git checkout (the default). The in-app git-pull updater
 *                 applies — the route still confirms an actual .git repo before
 *                 running git, so a source download without .git degrades safely.
 */
export function getInstallMode(): InstallMode {
  if (process.env.FLUJO_CONTAINER) {
    return 'container';
  }
  if (process.env.FLUJO_NPM) {
    return 'npm';
  }
  return 'git';
}
