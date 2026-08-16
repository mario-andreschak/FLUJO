import { NextRequest } from 'next/server';
import path from 'path';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { getWorkspaceDataDir } from '@/utils/workspace';
import { resolveGlobalVars } from '@/backend/utils/resolveGlobalVars';

const MAX_RESULTS = 50;
const MAX_VISITED = 20_000;
const MAX_DEPTH = 10;
const SKIP = new Set(['.git', '.next', 'node_modules', 'dist', 'build', '.cache']);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function fuzzyScore(value: string, query: string): number | null {
  const text = value.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  const contiguous = text.indexOf(needle);
  if (contiguous >= 0) return contiguous;
  let cursor = 0;
  let score = 100;
  for (const char of needle) {
    const found = text.indexOf(char, cursor);
    if (found < 0) return null;
    score += found - cursor;
    cursor = found + 1;
  }
  return score;
}

async function rootToAbsolutePath(root: string): Promise<string | null> {
  const resolved = String(await resolveGlobalVars(root)).trim();
  if (!resolved) return null;
  try {
    if (resolved.startsWith('file://')) return path.resolve(fileURLToPath(resolved));
    return path.isAbsolute(resolved)
      ? path.resolve(resolved)
      : path.resolve(getWorkspaceDataDir(), resolved);
  } catch {
    return null;
  }
}

async function GET_handler(request: NextRequest) {
  const locked = await assertUnlocked();
  if (locked) return locked;
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;

  const params = new URL(request.url).searchParams;
  const query = (params.get('q') || '').trim();
  if (!query) return json({ items: [] });

  let requestedRoots: unknown = [];
  try { requestedRoots = JSON.parse(params.get('roots') || '[]'); } catch { /* invalid roots => empty */ }
  const rootCandidates = Array.isArray(requestedRoots)
    ? requestedRoots.filter((root): root is string => typeof root === 'string')
    : [];
  const roots = [...new Set((await Promise.all(rootCandidates.map(rootToAbsolutePath)))
    .filter((root): root is string => Boolean(root)))];
  if (roots.length === 0) return json({ items: [] });

  const matches: Array<{ path: string; name: string; isDirectory: boolean; score: number }> = [];
  const queue = roots.map((root) => ({ directory: root, depth: 0 }));
  let visited = 0;
  while (queue.length > 0 && visited < MAX_VISITED) {
    const current = queue.shift()!;
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try { entries = await fs.readdir(current.directory, { withFileTypes: true, encoding: 'utf8' }); } catch { continue; }
    for (const entry of entries) {
      if (++visited > MAX_VISITED) break;
      const entryPath = path.join(current.directory, entry.name);
      const score = fuzzyScore(`${entry.name} ${entryPath}`, query);
      if (score !== null) {
        matches.push({ path: entryPath, name: entry.name, isDirectory: entry.isDirectory(), score });
      }
      if (entry.isDirectory() && current.depth < MAX_DEPTH && !SKIP.has(entry.name)) {
        queue.push({ directory: entryPath, depth: current.depth + 1 });
      }
    }
  }

  return json({
    items: matches
      .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
      .slice(0, MAX_RESULTS)
      .map(({ score: _score, ...item }) => item),
    truncated: visited >= MAX_VISITED || matches.length > MAX_RESULTS,
  });
}

export const GET = withWorkspaceRoute(GET_handler);
