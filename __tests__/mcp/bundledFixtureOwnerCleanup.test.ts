import fs from 'node:fs';
import path from 'node:path';
import { installBundledFixtureOwner } from './fixtures/bundledFixtureOwner';
import { captureOwnedFixtureDirectory, removeOwnedFixtureDirectory } from './fixtures/ownedFixtureDirectory';

it('refuses replacement owner directory cleanup and preserves its actual sentinel', () => {
  const previousOwner = process.env.FLUJO_OWNER_AUTH_FILE;
  const owner = installBundledFixtureOwner();
  const root = path.dirname(process.env.FLUJO_OWNER_AUTH_FILE!);
  const parent = path.dirname(root);
  const original = root + '-original';
  if (path.dirname(path.resolve(original)) !== parent || path.resolve(original) === parent) throw new Error('Unsafe fixture rename');
  fs.renameSync(root, original);
  fs.mkdirSync(root);
  const replacement = captureOwnedFixtureDirectory(root);
  const sentinel = path.join(root, 'sentinel');
  fs.writeFileSync(sentinel, 'replacement must survive');
  try {
    expect(() => owner.restore()).toThrow('cleanup refused');
    expect(process.env.FLUJO_OWNER_AUTH_FILE).toBe(previousOwner);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('replacement must survive');
  } finally {
    removeOwnedFixtureDirectory(replacement, parent, 'flujo-bundled-owner-');
    fs.renameSync(original, root);
    owner.restore();
  }
});

it('restores environment independently while preserving the root until actual FD close', async () => {
  const previousOwner = process.env.FLUJO_OWNER_AUTH_FILE;
  const owner = installBundledFixtureOwner();
  const filename = process.env.FLUJO_OWNER_AUTH_FILE!;
  let handle: Awaited<ReturnType<typeof fs.promises.open>> | undefined;
  try {
    handle = await fs.promises.open(filename, 'r');
    owner.restoreEnvironment();
    expect(process.env.FLUJO_OWNER_AUTH_FILE).toBe(previousOwner);
    expect(fs.existsSync(owner.directory)).toBe(true);
    expect((await handle.stat()).isFile()).toBe(true);
    await handle.close();
    handle = undefined;
    owner.removeDirectory();
    expect(fs.existsSync(owner.directory)).toBe(false);
  } finally {
    owner.restoreEnvironment();
    if (handle) {
      // No removal after an uncertain close. Preserve the actual handle/root
      // for inspection, even when this test body fails.
      throw Object.assign(new Error('Owned FD remains live; fixture root preserved'), { handle, directory: owner.directory });
    }
    if (fs.existsSync(owner.directory)) owner.removeDirectory();
  }
});
