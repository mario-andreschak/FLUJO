import { promises as fs, type FileHandle } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const { OwnedCaptureLedger } = require('./fixtures/ownedCaptureLedger.cjs');

let root: string;
const handles: FileHandle[] = [];
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-owned-capture-')); });
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir())
      || !path.basename(root).startsWith('flujo-owned-capture-') || (await fs.lstat(root)).isSymbolicLink()) {
    throw new Error('Unsafe owned capture cleanup');
  }
  await fs.rm(root, { recursive: true, force: true });
});
it('retains a genuine held descriptor after rejected disposal and removes it only after successful close', async () => {
  const handle = await fs.open(path.join(root, 'capture'), 'wx+'); handles.push(handle);
  await handle.writeFile('owned capture bytes');
  const ledger = new OwnedCaptureLedger();
  let rejectOnce = true;
  const capture = ledger.own({ dispose: async () => {
    // Controlled application disposal rejection with an actual open FD. This
    // proves retention/retry; it does not claim a natural OS close failure.
    if (rejectOnce) { rejectOnce = false; await handle.stat(); throw new Error('Controlled dispose rejection'); }
    await handle.close();
  } });
  await expect(ledger.dispose(capture)).rejects.toThrow('Controlled dispose rejection');
  expect(ledger.pending.has(capture)).toBe(true);
  expect((await handle.stat()).isFile()).toBe(true);
  await ledger.drain();
  expect(ledger.pending.size).toBe(0);
  await expect(handle.stat()).rejects.toThrow();
});
