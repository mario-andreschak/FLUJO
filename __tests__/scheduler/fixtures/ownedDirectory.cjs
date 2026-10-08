'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const owned = new WeakMap();
const identity = stat => [stat.dev, stat.ino, stat.birthtimeNs].map(value => value.toString()).join(':');
const canonical = value => process.platform === 'win32' ? value.toLowerCase() : value;
async function evidence(directory) {
  const root = path.resolve(directory);
  const parent = path.dirname(root);
  const rootStat = await fs.lstat(root, { bigint: true });
  const parentStat = await fs.lstat(parent, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !parentStat.isDirectory() || parentStat.isSymbolicLink()
      || canonical(await fs.realpath(root)) !== canonical(root)
      || canonical(await fs.realpath(parent)) !== canonical(parent)) throw new Error('Unsafe owned directory evidence');
  return { root: canonical(root), parent: canonical(parent), rootIdentity: identity(rootStat), parentIdentity: identity(parentStat) };
}
async function captureOwnedDirectory(directory, expected) {
  const observed = await evidence(directory);
  if (expected && JSON.stringify(observed) !== JSON.stringify(expected)) throw new Error('Transferred owned directory changed');
  const token = Object.freeze({ path: path.resolve(directory) });
  owned.set(token, observed);
  return token;
}
function describeOwnedDirectory(token) {
  const value = owned.get(token);
  if (!value) throw new Error('Unknown owned directory token');
  return { ...value };
}
async function removeOwnedDirectory(token, parent, prefix) {
  const original = owned.get(token);
  if (!original || canonical(await fs.realpath(parent)) !== original.parent
      || !path.basename(token.path).startsWith(prefix)
      || JSON.stringify(await evidence(token.path)) !== JSON.stringify(original)) throw new Error('Owned directory cleanup refused');
  await fs.rm(token.path, { recursive: true, force: true });
  owned.delete(token);
}
module.exports = { captureOwnedDirectory, describeOwnedDirectory, removeOwnedDirectory };
