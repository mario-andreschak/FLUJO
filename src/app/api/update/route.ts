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

    log.info('Applying update: git pull');
    await git.pull();

    log.info('Applying update: npm install');
    execSync('npm install', execOptions);

    log.info('Applying update: npm run build');
    execSync('npm run build', execOptions);

    log.info('Update build complete');

    // Only Windows has the bundled relauncher. On other platforms the user
    // restarts manually (this is primarily a Windows self-hosted feature).
    const isWindows = process.platform === 'win32';
    let restarting = false;

    if (isWindows) {
      const relaunchScript = path.join(cwd, 'scripts', 'relaunch.ps1');
      log.info('Spawning detached relauncher to restart the server');
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', relaunchScript, '-Dir', cwd],
        { detached: true, stdio: 'ignore', windowsHide: true }
      );
      child.unref();
      restarting = true;

      // Give the response time to flush, then exit so the rebuilt server can
      // bind the port. The relauncher waits for this process to release it.
      setTimeout(() => {
        log.info('Exiting current server process so the relauncher can take over');
        process.exit(0);
      }, 2000);
    }

    return NextResponse.json({
      success: true,
      restarting,
      message: restarting
        ? 'Update applied. FLUJO is restarting - the page will reload shortly.'
        : 'Update applied. Please restart FLUJO (npm start) to use the new version.',
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
