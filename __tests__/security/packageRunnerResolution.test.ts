import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareResolvedPackageTree, revalidateResolvedPackageTree } from '@/backend/services/security/packageRunnerResolution';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-package-resolution-'));
  const directory = path.join(root, 'node_modules', 'owned-fixture');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'owned-fixture', version: '1.2.3', bin: 'bin.cjs' }));
  await fs.writeFile(path.join(directory, 'bin.cjs'), '// Owned source fixture; never executed.\n');
  await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3,
    packages: { '': {}, 'node_modules/owned-fixture': { version: '1.2.3', integrity: 'sha512-YWJj' } } }));
});
afterEach(async () => {
  if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir())
      || !path.basename(root).startsWith('flujo-package-resolution-') || (await fs.lstat(root)).isSymbolicLink()) {
    throw new Error('Unsafe owned package fixture cleanup');
  }
  await fs.rm(root, { recursive: true, force: true });
});
it('observes actual bytes, rejects caller copies, and detects a later bin change', async () => {
  const witness = await prepareResolvedPackageTree(root, 'owned-fixture');
  await expect(revalidateResolvedPackageTree(witness)).resolves.toBeUndefined();
  await expect(revalidateResolvedPackageTree({ ...witness })).rejects.toThrow('not prepared');
  await fs.appendFile(witness.bin, '// Changed after preparation.\n');
  await expect(revalidateResolvedPackageTree(witness)).rejects.toThrow('changed');
});
it('rejects an installed version different from the actual lockfile', async () => {
  await fs.writeFile(path.join(root, 'node_modules', 'owned-fixture', 'package.json'),
    JSON.stringify({ name: 'owned-fixture', version: '9.9.9', bin: 'bin.cjs' }));
  await expect(prepareResolvedPackageTree(root, 'owned-fixture')).rejects.toThrow('differs from lock');
});
