import fs from 'node:fs';
import path from 'node:path';

/** Establish native spelling before any workspace or consent path is derived. */
export function prepareCanonicalDataRoot(directory) {
  const requested = path.resolve(directory);
  // Refuse existing linked ancestors before recursive mkdir can create a child
  // through a junction. Missing components remain ordinary initialization.
  for (let current = requested; ; current = path.dirname(current)) {
    try {
      const identity = fs.lstatSync(current);
      if (!identity.isDirectory() || identity.isSymbolicLink()) throw new Error('Linked data root refused.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (path.dirname(current) === current) break;
  }
  fs.mkdirSync(requested, { recursive: true });
  const parents = [];
  for (let current = requested; ; current = path.dirname(current)) {
    const identity = fs.lstatSync(current, { bigint: true });
    if (!identity.isDirectory() || identity.isSymbolicLink()) throw new Error('Linked data root refused.');
    parents.push({ filename: current, identity });
    if (path.dirname(current) === current) break;
  }
  const canonical = fs.realpathSync.native(requested);
  const same = (before, after) => after.isDirectory() && !after.isSymbolicLink()
    && ['dev', 'ino', 'mode', 'uid', 'gid'].every(field => before[field] === after[field]);
  for (const parent of parents) {
    if (!same(parent.identity, fs.lstatSync(parent.filename, { bigint: true }))) throw new Error('Data root ancestry changed.');
  }
  if (!same(parents[0].identity, fs.lstatSync(canonical, { bigint: true }))) throw new Error('Native data root identity changed.');
  for (let current = canonical; ; current = path.dirname(current)) {
    const identity = fs.lstatSync(current, { bigint: true });
    if (!identity.isDirectory() || identity.isSymbolicLink()) throw new Error('Linked native data root refused.');
    if (path.dirname(current) === current) break;
  }
  return canonical;
}
