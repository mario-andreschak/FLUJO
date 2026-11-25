import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { getWorkspaceDbDir } from '@/utils/workspace';

/**
 * Stored secrets are `encrypted:` values or bare v2 envelopes such as OAuth
 * tokens and MCP task payloads (see `seal` in ./format).
 */
const CIPHERTEXT = /"encrypted:|v2:[0-9a-f]{24}:[0-9a-f]{32}:/;
/** Longer than the longest marker, so a marker split between two reads is still found. */
const CARRY = 96;
/** Lock checks run often; a fixed or removed file is noticed within this time. */
const RECHECK_MS = 30_000;

interface Check { checkedAt: number; result: Promise<string | null> }

declare global {
  var __flujo_stored_ciphertext_checks: Map<string, Check> | undefined;
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function fileHoldsCiphertext(file: string): Promise<boolean> {
  let carry = '';
  try {
    for await (const chunk of createReadStream(file, { highWaterMark: 64 * 1024 })) {
      const text = carry + (chunk as Buffer).toString('latin1');
      if (CIPHERTEXT.test(text)) return true;
      carry = text.slice(-CARRY);
    }
    return false;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

async function search(directory: string, workspaceRoot: string): Promise<string | null> {
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (missing(error)) return null; throw error; }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    // Dirent types come from lstat, so links are neither files nor directories here.
    if (entry.isDirectory()) {
      const found = await search(target, workspaceRoot);
      if (found) return found;
    } else if (entry.isFile() && await fileHoldsCiphertext(target)) {
      return path.relative(workspaceRoot, target).split(path.sep).join('/');
    }
  }
  return null;
}

/**
 * The first file in the current workspace's db folder that holds an encrypted
 * secret (for example `db/models.json`), or null when nothing is encrypted.
 * Pass `fresh` before an irreversible step such as creating a new key.
 */
export function findStoredCiphertext(options: { fresh?: boolean } = {}): Promise<string | null> {
  const db = getWorkspaceDbDir();
  const checks = global.__flujo_stored_ciphertext_checks ??= new Map();
  const now = Date.now();
  for (const [key, check] of checks) if (now - check.checkedAt >= RECHECK_MS) checks.delete(key);
  const cached = checks.get(db);
  if (cached && !options.fresh) return cached.result;
  const check: Check = { checkedAt: now, result: search(db, path.dirname(db)) };
  checks.set(db, check);
  check.result.catch(() => { if (checks.get(db) === check) checks.delete(db); });
  return check.result;
}
