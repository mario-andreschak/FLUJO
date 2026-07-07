import { NextRequest, NextResponse } from 'next/server';
import simpleGit from 'simple-git';
import path from 'path';
import fs from 'fs/promises';
import { execSync, ExecSyncOptionsWithStringEncoding, spawn } from 'child_process';
import { createLogger } from '@/utils/logger';
import { getInstallMode } from '@/utils/paths';

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
    'version (`npx flujo@latest`) or reinstall a global install (`npm i -g flujo@latest`). ' +
    'Your data in the data directory is preserved.',
};

// Long-running build steps must not be cached or prematurely cut off.
export const dynamic = 'force-dynamic';
export const maxDuration = 600;

async function getCurrentVersion(): Promise<string> {
  try {
    const pkgRaw = await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf-8');
    return JSON.parse(pkgRaw).version ?? 'unknown';
  } catch (error) {
    log.warn('Failed to read package.json version', error);
    return 'unknown';
  }
}

/**
 * GET /api/update
 * Fetches from origin and reports whether the local clone is behind its tracking branch.
 */
export async function GET() {
  const currentVersion = await getCurrentVersion();

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

    if (!(await git.checkIsRepo())) {
      log.info('Update check skipped: working directory is not a git repository');
      return NextResponse.json({
        success: true,
        isGitRepo: false,
        updateMode: 'none',
        updateAvailable: false,
        currentVersion,
        message: 'FLUJO is not running from a git clone, so auto-update is unavailable.',
      });
    }

    log.debug('Fetching from origin to check for updates');
    await git.fetch();
    const status = await git.status();
    const behindBy = status.behind ?? 0;

    log.info(`Update check complete: ${behindBy} commit(s) behind ${status.tracking ?? 'origin'}`);
    return NextResponse.json({
      success: true,
      isGitRepo: true,
      updateMode: 'git',
      updateAvailable: behindBy > 0,
      behindBy,
      branch: status.current,
      currentVersion,
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
    if (!(await git.checkIsRepo())) {
      return NextResponse.json({
        success: false,
        error: 'FLUJO is not running from a git clone, so it cannot update itself.',
      }, { status: 400 });
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
    log.info('Applying update (non-Windows): git pull');
    await git.pull();
    log.info('Applying update: npm install');
    execSync('npm install', execOptions);
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
