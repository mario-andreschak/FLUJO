import { NextRequest, NextResponse } from 'next/server';
import simpleGit from 'simple-git';
import path from 'path';
import fs from 'fs/promises';
import { execSync, ExecSyncOptionsWithStringEncoding, spawn } from 'child_process';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/api/update/route');

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
  try {
    const git = simpleGit(process.cwd());

    if (!(await git.checkIsRepo())) {
      log.info('Update check skipped: working directory is not a git repository');
      return NextResponse.json({
        success: true,
        isGitRepo: false,
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
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', updateScript, '-Dir', cwd],
        { detached: true, stdio: 'ignore', windowsHide: true }
      );
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
