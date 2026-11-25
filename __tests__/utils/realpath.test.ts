import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { realpath } from '@/utils/realpath';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-realpath-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

it('returns exactly what realpathSync returns, including through a directory link', async () => {
  const target = path.join(root, 'target');
  const link = path.join(root, 'link');
  fs.mkdirSync(target);
  fs.symlinkSync(target, link, 'junction');
  const inputs = [root, target, link, path.join(link, '.')];
  if (process.platform === 'win32') inputs.push(target.toUpperCase(), target.toLowerCase());
  for (const input of inputs) await expect(realpath(input)).resolves.toBe(fs.realpathSync(input));
  await expect(realpath(link)).resolves.toBe(fs.realpathSync(target));
});

it('keeps a Windows short name that the system call would expand', async () => {
  const short = process.env.SystemDrive ? `${process.env.SystemDrive}\\PROGRA~1` : '';
  if (process.platform !== 'win32' || !fs.existsSync(short)) return;
  await expect(realpath(short)).resolves.toBe(fs.realpathSync(short));
  await expect(fs.promises.realpath(short)).resolves.not.toBe(fs.realpathSync(short));
});

it('rejects a missing path with the same error code as realpathSync', async () => {
  const missing = path.join(root, 'missing');
  expect(() => fs.realpathSync(missing)).toThrow(expect.objectContaining({ code: 'ENOENT' }));
  await expect(realpath(missing)).rejects.toMatchObject({ code: 'ENOENT' });
});
