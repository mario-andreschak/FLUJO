import { execFileSync } from 'node:child_process';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Historical regression inputs stay in Git history, outside the shipped tree.
// This exact pre-cleanup revision is never evidence for a new release.
export const archivedFixtureRevision = '03e6639812191f018e485f090761a0a6c3421fe8';
export const archivedFixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const maximumBytes = 5 * 1024 * 1024;
const cache = new Map();

export function readArchivedFixture(path) {
  if (typeof path !== 'string' || !path.startsWith('docs/audits/') ||
      path.includes('\\') || path.includes(':') || path.includes('\0') ||
      posix.normalize(path) !== path || path.split('/').includes('..')) {
    throw new Error('Unsupported historical fixture path');
  }
  if (!cache.has(path)) {
    const git = args => execFileSync('git', ['--no-replace-objects', '--literal-pathspecs', '-C', archivedFixtureRoot, ...args], {
      maxBuffer: maximumBytes + 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const entry = git(['ls-tree', archivedFixtureRevision, '--', path]).toString('utf8');
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t/.exec(entry);
    if (!match || entry.slice(match[0].length) !== path + '\n') throw new Error('Historical fixture is missing or is not a regular file: ' + path);
    const size = Number(git(['cat-file', '-s', match[2]]).toString());
    if (!Number.isSafeInteger(size) || size < 0 || size > maximumBytes) throw new Error('Historical fixture exceeds 5 MiB');
    const bytes = git(['cat-file', 'blob', match[2]]);
    if (bytes.length !== size) throw new Error('Historical fixture length mismatch');
    cache.set(path, bytes);
  }
  return Buffer.from(cache.get(path));
}
