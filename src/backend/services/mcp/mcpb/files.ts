/**
 * Where MCP bundles live and how their folders are replaced and removed (#1230).
 *
 * Each bundle gets `mcp-servers/mcpb/<server name>` in the selected workspace.
 * An install unpacks into a `.staging-…` folder next to it and an upgrade moves
 * the old folder to `.old-…` before swapping, so a failed step never leaves a
 * half-written server. Leftover `.staging-…`/`.old-…` folders (a crash, or a
 * file Windows kept busy) are removed by the next install or uninstall after
 * {@link LEFTOVER_AGE_MS}; nothing needs a restart.
 *
 * This module must not import the MCP service: the service calls
 * {@link removeMcpbServerFiles} when a bundle server is deleted.
 */
import path from 'path';
import fs from 'fs/promises';
import { randomUUID } from 'crypto';
import { getWorkspaceDataDir } from '@/utils/workspace';
import { retryTransientFileOperation } from '@/utils/transientFileRetry';
import { createLogger } from '@/utils/logger';
import type { MCPServerConfig } from '@/shared/types/mcp';

const log = createLogger('backend/services/mcp/mcpb/files');

export const LEFTOVER_AGE_MS = 10 * 60 * 1000;
const LEFTOVER_PREFIXES = ['.staging-', '.old-'] as const;

export function mcpbRoot(): string {
  return path.join(getWorkspaceDataDir(), 'mcp-servers', 'mcpb');
}

export function mcpbInstallDir(serverName: string): string {
  return path.join(mcpbRoot(), serverName);
}

/** A folder FLUJO made for one bundle: directly inside the bundle root, never the root itself. */
export function isMcpbServerDir(target: string): boolean {
  const relative = path.relative(mcpbRoot(), path.resolve(target));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative) && !relative.includes(path.sep);
}

/** Folders an install in this process is still working in; the sweep leaves them alone. */
const foldersInUse = new Set<string>();

/** A new `.staging-…`/`.old-…` folder name, kept from the sweep until `release` runs. */
export function siblingDir(prefix: (typeof LEFTOVER_PREFIXES)[number], serverName: string): { dir: string; release: () => void } {
  const dir = path.join(mcpbRoot(), `${prefix}${serverName}-${randomUUID()}`);
  foldersInUse.add(dir);
  return { dir, release: () => { foldersInUse.delete(dir); } };
}

export async function removeTree(target: string): Promise<void> {
  await retryTransientFileOperation(() => fs.rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }));
}

export async function moveDir(from: string, to: string): Promise<void> {
  await retryTransientFileOperation(() => fs.rename(from, to));
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** Remove leftovers older than {@link LEFTOVER_AGE_MS}. Never throws. */
export async function sweepMcpbLeftovers(now: number = Date.now()): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(mcpbRoot());
  } catch {
    return;
  }
  await Promise.all(names.filter((name) => LEFTOVER_PREFIXES.some((prefix) => name.startsWith(prefix))).map(async (name) => {
    const target = path.join(mcpbRoot(), name);
    if (foldersInUse.has(target)) return;
    try {
      const stats = await fs.stat(target);
      if (now - stats.mtimeMs >= LEFTOVER_AGE_MS) await removeTree(target);
    } catch (error) {
      log.warn(`Could not remove the old bundle folder ${name}; trying again next time.`, error);
    }
  }));
}

/**
 * Delete the files of a bundle server that was just removed. A folder Windows
 * keeps busy is renamed to `.old-…` so the next sweep finishes the job. Never throws.
 */
export async function removeMcpbServerFiles(config: Pick<MCPServerConfig, 'name' | 'rootPath' | 'source'> | undefined): Promise<void> {
  if (!config || config.source?.type !== 'mcpb' || typeof config.rootPath !== 'string' || !isMcpbServerDir(config.rootPath)) return;
  const target = path.resolve(config.rootPath);
  try {
    await removeTree(target);
  } catch (error) {
    log.warn(`Could not remove the files of ${config.name} now; they are removed later.`, error);
    const leftover = siblingDir('.old-', path.basename(target));
    leftover.release();
    await moveDir(target, leftover.dir)
      .catch((renameError: unknown) => log.warn(`The folder of ${config.name} is still in use: ${target}`, renameError));
  }
  await sweepMcpbLeftovers();
}
