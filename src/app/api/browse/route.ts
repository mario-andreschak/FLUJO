import { NextRequest } from 'next/server';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/api/browse/route');

/**
 * GET /api/browse?path=<absolute path>
 *
 * List a directory of the BACKEND filesystem, for the folder-picker dialogs.
 * The frontend may run in a browser on a different machine than the FLUJO
 * backend, and paths stored in configs (file-watch triggers, MCP server args,
 * workspace folders) are used by the BACKEND — so pickers must browse here,
 * not via the browser's local file dialogs.
 *
 * Without `path` the user's home directory is served. The response includes
 * the available drives on Windows so the picker can jump between them.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

interface BrowseEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

async function listWindowsDrives(): Promise<string[]> {
  const letters = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
  const checks = await Promise.allSettled(
    letters.map(async letter => {
      await fs.stat(`${letter}:\\`);
      return `${letter}:\\`;
    })
  );
  return checks
    .filter((c): c is PromiseFulfilledResult<string> => c.status === 'fulfilled')
    .map(c => c.value);
}

export async function GET(request: NextRequest) {
  try {
    const requested = new URL(request.url).searchParams.get('path') ?? '';
    const target = path.resolve(requested || os.homedir());

    let dirents;
    try {
      dirents = await fs.readdir(target, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const message =
        code === 'ENOENT'
          ? 'This folder does not exist'
          : code === 'ENOTDIR'
            ? 'This path is not a folder'
            : code === 'EACCES' || code === 'EPERM'
              ? 'Access to this folder was denied'
              : 'Could not read this folder';
      return json({ error: message }, 400);
    }

    const entries: BrowseEntry[] = dirents
      .map(dirent => ({
        name: dirent.name,
        path: path.join(target, dirent.name),
        isDirectory: dirent.isDirectory(),
      }))
      .sort((a, b) =>
        a.isDirectory !== b.isDirectory
          ? a.isDirectory
            ? -1
            : 1
          : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      );

    const parentPath = path.dirname(target);
    return json({
      path: target,
      // At a filesystem top (posix "/", Windows drive root) dirname returns
      // the path itself — report no parent instead of a self-loop.
      parent: parentPath === target ? null : parentPath,
      home: os.homedir(),
      sep: path.sep,
      drives: process.platform === 'win32' ? await listWindowsDrives() : [],
      entries,
    });
  } catch (error) {
    log.error('Error handling GET request', error);
    return json({ error: 'Internal server error' }, 500);
  }
}
