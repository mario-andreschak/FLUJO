import path from 'node:path';
import { promises as fs } from 'node:fs';
import { envRoots, isInside } from '@flujo-ai/mcp-shared';

export class FilesystemRootViolation extends Error {
  constructor(candidate: string) {
    super(`Path "${candidate}" is outside the configured filesystem roots.`);
    this.name = 'FilesystemRootViolation';
  }
}

/** Resolve existing parents too, so new files cannot follow an escaping junction. */
async function physicalDestination(candidate: string): Promise<string> {
  const missing: string[] = [];
  let current = path.resolve(candidate);
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // A dangling link exists, but cannot be resolved. Do not treat it as a
      // missing directory and manufacture an apparently confined destination.
      try {
        await fs.lstat(current);
      } catch (entryError) {
        if ((entryError as NodeJS.ErrnoException).code !== 'ENOENT') throw entryError;
        const parent = path.dirname(current);
        if (parent === current) throw error;
        missing.push(path.basename(current));
        current = parent;
        continue;
      }
      throw new FilesystemRootViolation(candidate);
    }
  }
}

async function physicallyInside(roots: string[], candidate: string): Promise<boolean> {
  for (const root of roots) {
    if (isInside(await physicalDestination(root), candidate)) return true;
  }
  return false;
}

/**
 * Check logical roots and their physical destinations on every operation.
 * Keep the requested pathname: move/delete must still act on a link itself.
 * This is a pre-operation check, not atomic isolation from concurrent host
 * directory/link replacement. Do not cache the physical root or destination.
 */
export async function confineFilesystemPath(candidate: string, roots: string[]): Promise<string> {
  const resolved = path.resolve(candidate);
  const ceiling = envRoots('FLUJO_FS_ROOTS');
  if (!roots.some(root => isInside(root, resolved))
    || (ceiling && !ceiling.some(root => isInside(root, resolved)))) {
    throw new FilesystemRootViolation(resolved);
  }
  const physical = await physicalDestination(resolved);
  if (!await physicallyInside(roots, physical)
    || (ceiling && !await physicallyInside(ceiling, physical))) {
    throw new FilesystemRootViolation(resolved);
  }
  return resolved;
}
