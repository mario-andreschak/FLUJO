/**
 * Checks a bundle's folder and file settings before it is installed (#1230).
 * Each value must be a full path to something that exists on this computer: a
 * folder for `directory` settings and a file for `file` settings. Paths inside
 * FLUJO's own key and secret folders (`workspaces/<name>/db`) are refused, so
 * neither a bundle default nor a slip of the picker hands a server FLUJO's keys.
 */
import path from 'path';
import fs from 'fs/promises';
import { realpath } from '@/utils/realpath';
import { getWorkspacesDir } from '@/utils/workspace';
import type { McpbUserConfigField, McpbUserConfigValue } from '@/shared/types/mcp/mcpb';
import { McpbError } from './manifest';

const SHOWN_PATH_LENGTH = 200;
const PRIVATE_FOLDER = 'db';

type PathProblem = 'not-absolute' | 'missing' | 'not-a-folder' | 'not-a-file' | 'private';

function sameName(a: string, b: string): boolean {
  return process.platform === 'win32' || process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function insidePrivateFolder(target: string): Promise<boolean> {
  const workspaces = getWorkspacesDir();
  const root = await realpath(workspaces).catch(() => path.resolve(workspaces));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  const folder = relative.split(path.sep)[1];
  return folder !== undefined && sameName(folder, PRIVATE_FOLDER);
}

async function pathProblem(value: string, type: 'directory' | 'file'): Promise<PathProblem | undefined> {
  if (!path.isAbsolute(value)) return 'not-absolute';
  const resolved = await realpath(value).catch(() => undefined);
  const stats = resolved ? await fs.stat(resolved).catch(() => undefined) : undefined;
  if (!resolved || !stats) return 'missing';
  if (type === 'directory' && !stats.isDirectory()) return 'not-a-folder';
  if (type === 'file' && !stats.isFile()) return 'not-a-file';
  return (await insidePrivateFolder(resolved)) ? 'private' : undefined;
}

function problemText(problem: PathProblem, value: string, type: 'directory' | 'file'): string {
  const shown = `"${value.slice(0, SHOWN_PATH_LENGTH)}"`;
  switch (problem) {
    case 'not-absolute': return `${shown} is not a full path.`;
    case 'missing': return `${shown} does not exist on this computer or cannot be opened.`;
    case 'not-a-folder': return `${shown} is a file, not a folder.`;
    case 'not-a-file': return `${shown} is a folder, not a file.`;
    case 'private': return `${shown} is inside FLUJO’s own folder for keys and secrets. Choose another ${type === 'file' ? 'file' : 'folder'}.`;
  }
}

/** Throws an `invalid-config` error naming every folder or file setting that does not fit. */
export async function assertUserConfigPaths(
  fields: readonly McpbUserConfigField[],
  values: Readonly<Record<string, McpbUserConfigValue>>,
): Promise<void> {
  const checks = fields.flatMap((field) => {
    const type = field.type;
    if (type !== 'directory' && type !== 'file') return [];
    const value = values[field.key];
    const items = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
    return items.map(async (item) => {
      const problem = await pathProblem(item, type);
      return problem ? { field, text: problemText(problem, item, type) } : undefined;
    });
  });
  const problems = (await Promise.all(checks)).filter((problem) => problem !== undefined);
  if (problems.length === 0) return;
  const keys = [...new Set(problems.map((problem) => problem.field.key))];
  const message = problems.map((problem) => `Check "${problem.field.title}": ${problem.text}`).join(' ');
  throw new McpbError(message, 'invalid-config', 400, keys);
}
