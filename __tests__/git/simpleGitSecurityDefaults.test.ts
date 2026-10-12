import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';

describe('simple-git security defaults', () => {
  let directory: string;

  beforeAll(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-git-guards-'));
    await simpleGit(directory).init();
  });

  afterAll(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it.each([
    ['include', ['-c', 'include.path=missing-inert-config', 'status'], /allowUnsafeInclude/],
    ['trailer cmd', ['-c', 'trailer.audit.cmd=missing-inert-command', 'status'], /allowUnsafeCommandBinaries/],
    ['trailer command', ['-c', 'trailer.audit.command=missing-inert-command', 'status'], /allowUnsafeCommandBinaries/],
    ['abbreviated exec', ['rebase', '--ex=missing-inert-command'], /allowUnsafeExec/],
  ])('rejects %s with the default client', async (_label, args, message) => {
    await expect(simpleGit(directory).raw(args as string[])).rejects.toThrow(message as RegExp);
  });

  it('keeps the editor guard when an editor variable is allowlisted', async () => {
    const git = simpleGit({ baseDir: directory, allowEnvironment: ['VISUAL'] })
      .env('VISUAL', 'missing-inert-editor');
    await expect(git.status()).rejects.toThrow(/allowUnsafeEditor/);
  });

  it('rejects an explicit repository selector on the default client', async () => {
    await expect(simpleGit(directory).env('GIT_DIR', path.join(directory, '.git')).status())
      .rejects.toThrow(/environment guard/);
  });

  it('keeps command guards on the snapshot configuration-path client', async () => {
    const git = simpleGit({ baseDir: directory, unsafe: { allowUnsafeConfigPaths: true } });
    await expect(git.raw(['-c', 'include.path=missing-inert-config', 'status']))
      .rejects.toThrow(/allowUnsafeInclude/);
    await expect(git.raw(['-c', 'trailer.audit.cmd=missing-inert-command', 'status']))
      .rejects.toThrow(/allowUnsafeCommandBinaries/);
  });
});
