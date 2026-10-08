import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const directories = require('./fixtures/ownedDirectory.cjs');

it.each(['flujo-worker-bootstrap-', 'flujo-hot-clone-'])(
  'preserves a replacement sentinel when %s ownership identity changes', async prefix => {
    const parent = await fs.realpath(os.tmpdir());
    const root = await fs.mkdtemp(path.join(parent, prefix));
    const original = root + '-original';
    if (path.dirname(path.resolve(original)) !== parent || path.resolve(original) === parent) {
      throw new Error('Unsafe owned directory rename');
    }
    const token = await directories.captureOwnedDirectory(root);
    const transferred = directories.describeOwnedDirectory(token);
    await fs.rename(root, original);
    await fs.mkdir(root);
    const replacement = await directories.captureOwnedDirectory(root);
    const sentinel = path.join(root, 'sentinel');
    await fs.writeFile(sentinel, 'replacement must survive');
    try {
      await expect(directories.captureOwnedDirectory(root, transferred)).rejects.toThrow('changed');
      await expect(directories.removeOwnedDirectory(token, parent, prefix)).rejects.toThrow('refused');
      expect(await fs.readFile(sentinel, 'utf8')).toBe('replacement must survive');
    } finally {
      // The controlled replacement itself was allocated by this test. Verify
      // its independent identity before retiring it and restoring the original.
      await directories.removeOwnedDirectory(replacement, parent, prefix);
      await fs.rename(original, root);
      await directories.removeOwnedDirectory(token, parent, prefix);
    }
  });
