'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

function sameVersion(left, right) {
  return ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'].every(key => left[key] === right[key]);
}

function readBoundedFile(file, maximum) {
  assert(Number.isSafeInteger(maximum) && maximum >= 0 && maximum <= 64 * 1024 ** 2, 'Invalid bounded-read allowance');
  const name = path.resolve(file);
  const descriptor = fs.openSync(name, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    assert(before.isFile() && before.size <= BigInt(maximum), 'File is not regular or exceeds allowance');
    // Windows lacks O_NOFOLLOW: validate the opened identity and named entry
    // before reading, then repeat after EOF. Ancestor redirection also fails.
    assert.equal(fs.realpathSync(name), name, 'Evidence path redirects through a link');
    const namedBefore = fs.lstatSync(name, { bigint: true });
    assert(namedBefore.isFile() && sameVersion(before, namedBefore), 'File name changed before read');
    const buffer = Buffer.alloc(maximum + 1); let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(descriptor, buffer, length, Math.min(64 * 1024, buffer.length - length), null);
      if (!count) break;
      length += count;
    }
    assert(length <= maximum, 'File grew beyond allowance');
    const after = fs.fstatSync(descriptor, { bigint: true });
    const namedAfter = fs.lstatSync(name, { bigint: true });
    assert(after.isFile() && namedAfter.isFile() && sameVersion(before, after) && sameVersion(after, namedAfter)
      && BigInt(length) === after.size && fs.realpathSync(name) === name, 'File version or name changed during read');
    return buffer.subarray(0, length);
  } finally { fs.closeSync(descriptor); }
}
module.exports = { readBoundedFile };
