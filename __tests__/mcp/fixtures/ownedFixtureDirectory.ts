import fs from 'node:fs';
import path from 'node:path';
type Evidence = { root: string; parent: string; rootIdentity: string; parentIdentity: string };
const owned = new WeakMap<object, Evidence>();
const canonical = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
const identity = (stat: fs.BigIntStats) => [stat.dev, stat.ino, stat.birthtimeNs].join(':');
function evidence(directory: string): Evidence {
  const root = path.resolve(directory);
  const parent = path.dirname(root);
  const rootStat = fs.lstatSync(root, { bigint: true });
  const parentStat = fs.lstatSync(parent, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !parentStat.isDirectory() || parentStat.isSymbolicLink()
      || canonical(fs.realpathSync.native(root)) !== canonical(root)
      || canonical(fs.realpathSync.native(parent)) !== canonical(parent)) throw new Error('Unsafe owned fixture directory');
  return { root: canonical(root), parent: canonical(parent), rootIdentity: identity(rootStat), parentIdentity: identity(parentStat) };
}
export function captureOwnedFixtureDirectory(directory: string) {
  const observed = evidence(directory);
  const token = Object.freeze({ path: path.resolve(directory) });
  owned.set(token, observed);
  return token;
}
export function removeOwnedFixtureDirectory(token: { readonly path: string }, parent: string, prefix: string) {
  const original = owned.get(token);
  if (!original || canonical(fs.realpathSync.native(parent)) !== original.parent
      || path.dirname(path.resolve(token.path)) !== path.resolve(parent)
      || !path.basename(token.path).startsWith(prefix)
      || JSON.stringify(evidence(token.path)) !== JSON.stringify(original)) throw new Error('Owned fixture directory cleanup refused');
  fs.rmSync(token.path, { recursive: true, force: true });
  owned.delete(token);
}
