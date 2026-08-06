import { spawn } from 'child_process';
import { NextRequest } from 'next/server';

import { createNdjsonStreamResponse } from '@/backend/utils/ndjsonStream';
import { createLogger } from '@/utils/logger';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { AI_CLI_PACKAGES, buildWingetArgs, type AiCliTool } from './winget';

const log = createLogger('app/api/setup/ai-cli/route');

export const runtime = 'nodejs';

/**
 * Installs one of three explicitly allow-listed AI runtimes. The request never
 * supplies a command, package id, arguments, or working directory, so this
 * local-only route cannot become a general shell-execution seam.
 */
export async function POST(request: NextRequest) {
  // #77 deny-by-default encryption gate.
  const locked = await assertUnlocked();
  if (locked) return locked;

  let tool: AiCliTool;
  try {
    const body = (await request.json()) as { tool?: unknown };
    if (typeof body.tool !== 'string' || !(body.tool in AI_CLI_PACKAGES)) {
      return Response.json({ error: 'Unknown AI tool' }, { status: 400 });
    }
    tool = body.tool as AiCliTool;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (process.platform !== 'win32') {
    return Response.json(
      { error: 'One-click WinGet installation is only available on Windows.' },
      { status: 400 },
    );
  }

  const pkg = AI_CLI_PACKAGES[tool];
  return createNdjsonStreamResponse(async (emit, signal) => {
    emit({ type: 'status', phase: 'spawning', message: `Starting the ${pkg.label} installer…` });

    await new Promise<void>((resolve) => {
      let settled = false;
      let stderr = '';
      const finish = (success: boolean, error?: string) => {
        if (settled) return;
        settled = true;
        emit({
          type: 'result',
          success,
          ...(success
            ? { commandOutput: `${pkg.label} is installed.` }
            : { error: error || `WinGet could not install ${pkg.label}.` }),
        });
        resolve();
      };

      try {
        const child = spawn('winget', buildWingetArgs(tool), {
          windowsHide: true,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        signal.addEventListener('abort', () => child.kill(), { once: true });
        child.stdout.on('data', (chunk: Buffer) => {
          const line = chunk.toString().trim();
          if (line) emit({ type: 'stdout', data: line });
        });
        child.stderr.on('data', (chunk: Buffer) => {
          const line = chunk.toString().trim();
          if (!line) return;
          stderr = `${stderr}\n${line}`.trim().slice(-4_000);
          emit({ type: 'stderr', data: line });
        });
        child.once('error', (error) => {
          log.warn(`Failed to start WinGet for ${tool}`, error);
          finish(false, error.message.includes('ENOENT')
            ? 'WinGet was not found. Install “App Installer” from the Microsoft Store, then try again.'
            : error.message);
        });
        child.once('close', (code) => {
          finish(code === 0, code === 0 ? undefined : stderr || `WinGet exited with code ${code ?? 'unknown'}.`);
        });
      } catch (error) {
        finish(false, error instanceof Error ? error.message : String(error));
      }
    });
  }, { signal: request.signal });
}
