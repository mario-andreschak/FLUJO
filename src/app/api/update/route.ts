import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { NextRequest, NextResponse } from 'next/server';
import simpleGit, { type SimpleGit } from 'simple-git';
import path from 'path';
import fs from 'fs/promises';
import { execSync, ExecSyncOptionsWithStringEncoding, spawn } from 'child_process';
import { createLogger } from '@/utils/logger';
import { getInstallMode } from '@/utils/paths';

// FLUJO_INSTALLATION_WIDE_ROUTE: updates the FLUJO installation itself.

const log = createLogger('app/api/update/route');

// How a non-git install is told to update itself. The Settings UI switches on
// `updateMode` so each distribution shows the right instructions instead of a
// git-only update button (issues #57 Docker, #59 npm).
const NON_GIT_UPDATE_MESSAGE: Record<'container' | 'npm', string> = {
  container:
    'FLUJO is running inside a Docker container. To update, pull a newer image ' +
    'and recreate the container (e.g. `docker compose pull && docker compose up -d`). ' +
    'Your data lives in mounted volumes and is preserved.',
  npm:
    'FLUJO was installed as an npm package. To update, rerun it with the latest ' +
    'version (`npx flujo-ai@latest`) or reinstall a global install (`npm i -g flujo-ai@latest`). ' +
    'Your data in the data directory is preserved.',
};

// Long-running build steps must not be cached or prematurely cut off.
export const dynamic = 'force-dynamic';
export const maxDuration = 600;

async function getCurrentPackage(): Promise<{ name: string; version: string }> {
  try {
    const pkgRaw = await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf-8');
    const pkg = JSON.parse(pkgRaw);
    return { name: pkg.name ?? '', version: pkg.version ?? 'unknown' };
  } catch (error) {
    log.warn('Failed to read package.json version', error);
    return { name: '', version: 'unknown' };
  }
}

const RELEASES_URL = 'https://github.com/mario-andreschak/FLUJO/releases/latest';
const OFFICIAL_ORIGIN = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)mario-andreschak\/flujo(?:\.git)?\/?$/i;

interface GitUpdateState {
  isGitRepo: boolean;
  updateMode: 'git' | 'pinned' | 'blocked' | 'none';
  updateAvailable: boolean;
  canApply: boolean;
  branch?: string;
  sourceRef?: string;
  revision?: string;
  targetRevision?: string;
  behindBy?: number;
  blockedReason?: string;
  message?: string;
  releasesUrl?: string;
}

/** No fetch, checkout, restore or process launch until this preflight passes. */
async function inspectGitUpdate(git: SimpleGit, packageName: string): Promise<GitUpdateState> {
  const state: GitUpdateState = { isGitRepo: true, updateMode: 'blocked', updateAvailable: false, canApply: false };
  const refuse = (blockedReason: string, message: string): GitUpdateState => ({ ...state, blockedReason, message });
  if (!(await git.checkIsRepo())) {
    return { ...state, isGitRepo: false, updateMode: 'none', message: 'FLUJO is not running from a Git clone. Use the installer for a newer version.' };
  }
  const root = path.resolve((await git.raw(['rev-parse', '--show-toplevel'])).trim());
  const cwd = path.resolve(process.cwd());
  const sameRoot = process.platform === 'win32' ? root.toLowerCase() === cwd.toLowerCase() : root === cwd;
  if (!sameRoot || packageName !== 'flujo-ai') {
    return refuse('unrelated-checkout', 'This directory is not the root of a FLUJO checkout. Automatic update is unavailable.');
  }
  let origin: string;
  try { origin = (await git.raw(['remote', 'get-url', 'origin'])).trim(); }
  catch { return refuse('missing-origin', 'This checkout has no readable origin remote. Review its repository configuration and update manually.'); }
  if (!OFFICIAL_ORIGIN.test(origin)) {
    return refuse('unrelated-origin', 'This checkout does not use the official FLUJO origin. Review and update this repository manually.');
  }
  state.revision = (await git.raw(['rev-parse', 'HEAD'])).trim();
  let branch: string;
  try {
    branch = (await git.raw(['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim();
  } catch {
    branch = '';
  }
  if (!branch) {
    let sourceRef = state.revision;
    try { sourceRef = (await git.raw(['describe', '--tags', '--exact-match', 'HEAD'])).trim() || sourceRef; } catch { /* A pinned commit may have no tag. */ }
    return {
      ...state, updateMode: 'pinned', sourceRef, blockedReason: 'pinned-release', releasesUrl: RELEASES_URL,
      message: 'This installation is pinned to a release or commit. Download and run a newer versioned FLUJO installer to upgrade. In-app branch updates are disabled for pinned installations.',
    };
  }
  state.branch = branch;
  state.sourceRef = branch;
  const status = await git.status();
  if (status.current !== branch || status.detached) {
    return refuse('checkout-changed', 'The checkout changed during the update check. Check again before updating.');
  }
  if (status.files.length > 0) {
    return refuse('local-changes', 'This checkout has local changes or untracked files. Commit or back up your work and make the checkout clean before updating. FLUJO will not discard files, including package-lock.json.');
  }
  if (status.tracking !== `origin/${branch}`) {
    return refuse('unexpected-upstream', 'This branch does not track its matching branch on the official origin. Review its upstream configuration and update manually.');
  }
  if (status.ahead > 0) {
    return refuse('local-commits', 'This branch has local commits or has diverged from origin. Update it manually; FLUJO only applies fast-forward updates.');
  }
  try {
    await git.raw(['merge-base', '--is-ancestor', 'HEAD', `refs/remotes/origin/${branch}`]);
    state.targetRevision = (await git.raw(['rev-parse', `refs/remotes/origin/${branch}`])).trim();
  } catch {
    return refuse('not-fast-forward', 'A fast-forward update could not be verified. Review the branch and origin history, then update manually.');
  }
  return { ...state, updateMode: 'git', canApply: true, behindBy: status.behind, updateAvailable: status.behind > 0 };
}

/**
 * GET /api/update
 * Fetches from origin and reports whether the local clone is behind its tracking branch.
 */
export async function GET(request: NextRequest) {
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;

  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  const currentPackage = await getCurrentPackage();
  const currentVersion = currentPackage.version;

  // Packaged installs (Docker/npm) can't git-pull themselves. Report the mode so
  // the UI can show the right update instructions instead of a broken button.
  const installMode = getInstallMode();
  if (installMode !== 'git') {
    log.info(`Update check: install mode is '${installMode}'; in-app git update is unavailable`);
    return NextResponse.json({
      success: true,
      isGitRepo: false,
      updateMode: installMode,
      updateAvailable: false,
      currentVersion,
      message: NON_GIT_UPDATE_MESSAGE[installMode],
    });
  }

  try {
    const git = simpleGit(process.cwd());

    const beforeFetch = await inspectGitUpdate(git, currentPackage.name);
    if (!beforeFetch.canApply) {
      return NextResponse.json({ success: true, currentVersion, ...beforeFetch });
    }

    log.debug('Fetching from origin to check for updates');
    await git.fetch('origin', beforeFetch.branch!);
    const state = await inspectGitUpdate(git, currentPackage.name);

    log.info('Update check complete', { mode: state.updateMode, behindBy: state.behindBy });
    return NextResponse.json({
      success: true,
      currentVersion,
      ...state,
    });
  } catch (error) {
    log.error('Update check failed', error);
    return NextResponse.json({
      success: false,
      updateAvailable: false,
      currentVersion,
      error: `Failed to check for updates: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }, { status: 500 });
  }
}

/**
 * POST /api/update  { action: 'apply' }
 * Pulls the latest changes, reinstalls dependencies, rebuilds, and (on Windows)
 * spawns a detached relauncher that restarts the server once this process exits.
 */
export async function POST(request: NextRequest) {
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;

  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  let action: string | undefined;
  try {
    const body = await request.json();
    action = body.action;
  } catch {
    // No/invalid body - treat as default action below.
  }

  if (action && action !== 'apply') {
    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }

  // Packaged installs (Docker/npm) must never attempt an in-place git update:
  // there is no git clone to pull, and the install is read-only. Refuse before
  // touching git and tell the caller how to update this distribution instead.
  const installMode = getInstallMode();
  if (installMode !== 'git') {
    log.info(`Update apply refused: install mode is '${installMode}'`);
    return NextResponse.json({
      success: false,
      updateMode: installMode,
      error: NON_GIT_UPDATE_MESSAGE[installMode],
    }, { status: 501 });
  }

  const cwd = process.cwd();
  const execOptions: ExecSyncOptionsWithStringEncoding = {
    cwd,
    stdio: 'pipe',
    encoding: 'utf8',
    env: { ...process.env },
  };

  try {
    const git = simpleGit(cwd);
    const currentPackage = await getCurrentPackage();
    const beforeFetch = await inspectGitUpdate(git, currentPackage.name);
    if (!beforeFetch.canApply) {
      return NextResponse.json({
        success: false, currentVersion: currentPackage.version, ...beforeFetch, error: beforeFetch.message,
      }, { status: beforeFetch.isGitRepo ? 409 : 400 });
    }
    await git.fetch('origin', beforeFetch.branch!);
    const state = await inspectGitUpdate(git, currentPackage.name);
    if (!state.canApply || state.branch !== beforeFetch.branch || state.revision !== beforeFetch.revision) {
      return NextResponse.json({
        success: false, ...state, canApply: false,
        error: state.message || 'The checkout changed during the update check. Check again before updating.',
      }, { status: 409 });
    }
    if (!state.updateAvailable) {
      return NextResponse.json({ success: true, ...state, restarting: false, message: 'This branch is already up to date. No update was applied.' });
    }

    if (process.platform === 'win32') {
      // On Windows the whole update (stop server -> pull -> install -> build ->
      // restart) is delegated to a detached PowerShell script. It MUST run out
      // of process: `next build` fails while the running `next start` holds
      // .next locked, so the server has to be stopped first. The script kills
      // the server by port and brings up the rebuilt one. If spawning the
      // script fails, the running server is left untouched (safe).
      const updateScript = path.join(cwd, 'scripts', 'update.ps1');
      try {
        await fs.access(updateScript);
      } catch {
        return NextResponse.json({
          success: false,
          error: `Updater script not found at ${updateScript}. Pull the latest FLUJO and try again.`,
        }, { status: 500 });
      }

      log.info('Spawning detached updater (update.ps1) to update + restart FLUJO');
      // IMPORTANT: do NOT spawn powershell.exe directly with `detached: true`.
      // On Windows that sets the DETACHED_PROCESS creation flag, which leaves
      // PowerShell without a usable console; it gets a PID but silently dies on
      // init without ever running the script (no log, no rebuild). Instead we
      // launch it through `cmd /c start`, which creates a fully independent
      // process that survives this server being killed. `start ""` provides an
      // explicit (empty) window title so a quoted script path with spaces is
      // never mistaken for the title.
      const child = spawn(
        'cmd.exe',
        [
          '/c', 'start', '""',
          'powershell.exe',
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
          '-File', updateScript, '-Dir', cwd,
        ],
        { detached: true, stdio: 'ignore', windowsHide: true }
      );
      // spawn() reports launch failures asynchronously via 'error'; without a
      // listener the failure is swallowed and we'd wrongly report success.
      child.on('error', (err) => log.error('Failed to spawn updater process', err));
      child.unref();

      return NextResponse.json({
        success: true,
        restarting: true,
        message:
          'Update started. FLUJO will stop, rebuild, and restart automatically ' +
          '(this can take a few minutes). The page reloads once it is back up. ' +
          'Progress is logged to %TEMP%\\flujo-update.log.',
      });
    }

    // Non-Windows: rebuild in-process and ask the user to restart manually.
    // Merge only the exact upstream revision that passed preflight; never
    // fetch again during a pull or silently merge/reset local work.
    log.info('Applying fast-forward update (non-Windows)');
    await git.raw(['merge', '--ff-only', state.targetRevision!]);
    // This is a deployment install backed by a committed lockfile. `npm ci`
    // installs that exact tree and, unlike `npm install`, never updates the
    // dependency manifests as a side effect.
    log.info('Applying update: npm ci');
    execSync('npm ci --include=dev', execOptions);
    log.info('Applying update: npm run build');
    execSync('npm run build', execOptions);
    log.info('Update build complete');

    return NextResponse.json({
      success: true,
      restarting: false,
      message: 'Update applied. Please restart FLUJO (npm start) to use the new version.',
    });
  } catch (error) {
    // execSync errors carry stdout/stderr buffers with the real failure output.
    const execError = error as { stdout?: Buffer; stderr?: Buffer };
    const output = (execError.stdout?.toString() || '') + (execError.stderr?.toString() || '');
    log.error('Update failed', error);
    return NextResponse.json({
      success: false,
      error: `Failed to apply update: ${error instanceof Error ? error.message : 'Unknown error'}`,
      output: output || undefined,
    }, { status: 500 });
  }
}
