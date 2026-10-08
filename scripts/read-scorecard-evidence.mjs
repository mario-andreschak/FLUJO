import fs from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';

const maximumBytes = 5 * 1024 * 1024;

function inside(root, path) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

/** Keep size checks and bounded reads attached to the same opened file. */
export function readScorecardEvidence(path, root) {
  const canonicalRoot = fs.realpathSync(root);
  const real = fs.realpathSync(path);
  if (!inside(canonicalRoot, real)) throw new Error('symlink escapes repository');

  // These additional flags are unavailable on some platforms, including Windows.
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
  const fd = fs.openSync(real, flags);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile()) throw new Error('payload must be a regular file');
    if (opened.size > maximumBytes) throw new Error('payload exceeds 5 MiB');

    // Reject a path redirected during open before reading any payload bytes.
    const current = fs.realpathSync(path);
    if (fs.realpathSync(root) !== canonicalRoot || !inside(canonicalRoot, current) || current !== real) {
      throw new Error('payload path changed during verification or symlink escapes repository');
    }
    const named = fs.statSync(current, { bigint: true });
    if (named.dev !== opened.dev || named.ino !== opened.ino) throw new Error('payload file changed during open');

    const buffer = Buffer.allocUnsafe(64 * 1024);
    const chunks = [];
    let total = 0;
    while (true) {
      // Read at most one extra byte to detect growth beyond the limit.
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, maximumBytes + 1 - total), null);
      if (count === 0) break;
      total += count;
      if (total > maximumBytes) throw new Error('payload exceeds 5 MiB');
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    return Buffer.concat(chunks, total);
  } finally {
    fs.closeSync(fd);
  }
}
