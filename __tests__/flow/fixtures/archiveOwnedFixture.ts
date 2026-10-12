import { promises as fs, type BigIntStats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ArchiveOwnedFixture {
  root: string;
  parent: string;
  identity: BigIntStats;
  parentIdentity: BigIntStats;
}

export async function createArchiveOwnedFixture(): Promise<ArchiveOwnedFixture> {
  const parent = await fs.realpath(os.tmpdir());
  const parentIdentity = await fs.lstat(parent, { bigint: true });
  const root = await fs.mkdtemp(path.join(parent, 'flujo-archive-control-'));
  return { root, parent, parentIdentity, identity: await fs.lstat(root, { bigint: true }) };
}

export async function removeArchiveOwnedFixture(owned: ArchiveOwnedFixture): Promise<void> {
  const resolved = path.resolve(owned.root);
  const relative = path.relative(owned.parent, resolved);
  const current = await fs.lstat(resolved, { bigint: true });
  const parent = await fs.lstat(owned.parent, { bigint: true });
  const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
  if (!path.isAbsolute(owned.root) || relative !== path.basename(resolved) || !relative.startsWith('flujo-archive-control-')
      || current.isSymbolicLink() || !current.isDirectory() || await fs.realpath(resolved) !== resolved
      || parent.isSymbolicLink() || !parent.isDirectory() || await fs.realpath(owned.parent) !== owned.parent
      || !same(current, owned.identity) || !same(parent, owned.parentIdentity)) {
    throw new Error('Owned archive fixture identity changed; preserving it');
  }
  await fs.rm(resolved, { recursive: true, force: false });
}
