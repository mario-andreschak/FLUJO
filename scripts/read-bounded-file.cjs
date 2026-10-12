'use strict';
const fs = require('node:fs');

/** Read one opened regular file, never reopen its checked pathname for content. */
function readBoundedFileSync(filename, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 20 * 1024 * 1024) {
    throw new Error('Invalid bounded file size');
  }
  const unsafe = () => new Error('Unsafe, changed or oversized file');
  // POSIX refuses leaf links and avoids blocking on special files. Windows has
  // neither flag: compare the opened handle with lstat before reading any bytes.
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
  const fd = fs.openSync(filename, flags);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    const named = fs.lstatSync(filename, { bigint: true });
    const ordinary = stats => stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1n;
    const same = stats => stats.dev === opened.dev && stats.ino === opened.ino
      && stats.size === opened.size && stats.mtimeNs === opened.mtimeNs && stats.ctimeNs === opened.ctimeNs;
    if (!ordinary(opened) || !ordinary(named) || opened.ino === 0n || !same(named)
        || opened.size > BigInt(maxBytes)) throw unsafe();
    // An external writer can grow a file after fstat. Read at most limit + 1,
    // so an unbounded readFile allocation cannot bypass the observed size cap.
    const buffer = Buffer.alloc(Number(opened.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, length);
      if (count === 0) break;
      length += count;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const current = fs.lstatSync(filename, { bigint: true });
    if (length > maxBytes || BigInt(length) !== opened.size || !ordinary(after) || !ordinary(current)
        || !same(after) || !same(current)) throw unsafe();
    return Buffer.from(buffer.subarray(0, length));
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readBoundedFileSync };
