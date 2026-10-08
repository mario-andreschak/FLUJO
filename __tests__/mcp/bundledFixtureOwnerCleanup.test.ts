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
