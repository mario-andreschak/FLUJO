import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { OriginalOwnerEnrollment } from '@/backend/services/originalOwner/types';
import { prepareNativeToolEffect } from '@/backend/services/originalOwner/nativeToolEffects';
import vm from 'node:vm';

type Grant = Pick<OriginalOwnerEnrollment, 'allowedTools' | 'commands' | 'directory'>;
const enabled = ['worker_read_file', 'worker_write_file', 'worker_list_dir', 'worker_command'] as const;

describe('Original Owner Native Worker effects', () => {
  let root: string;
  let renamedRoot: string | undefined;
  let grant: Grant;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-native-tool-effects-'));
    grant = { directory: root, allowedTools: [...enabled], commands: [] };
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    if (renamedRoot) await fs.rm(renamedRoot, { recursive: true, force: true });
    renamedRoot = undefined;
  });

  const prepare = (name: string, args: Record<string, unknown>, selected = grant, signal = new AbortController().signal) =>
    prepareNativeToolEffect(selected, name, args, signal);

  it('accepts closed plain arguments from another server realm and rejects inherited grants', async () => {
    const effect = await prepare('worker_list_dir',vm.runInNewContext('({path:"."})'));
    await expect(effect.start()).resolves.toMatchObject({ content: [{ type: 'text',text: '[]' }] });
    await expect(prepare('worker_list_dir',Object.create({ path: '.' }))).rejects.toThrow();
  });

  it('reads, writes and lists only within the admitted directory', async () => {
    await fs.writeFile(path.join(root, 'before.txt'), 'before');
    const read = await prepare('worker_read_file', { path: 'before.txt' });
    await expect(read.start()).resolves.toEqual({ content: [{ type: 'text', text: 'before' }] });

    const write = await prepare('worker_write_file', { path: 'after.txt', content: 'after' });
    await expect(fs.readFile(path.join(root, 'after.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(write.start()).resolves.toEqual({ content: [{ type: 'text', text: 'File written.' }] });
    await expect(fs.readFile(path.join(root, 'after.txt'), 'utf8')).resolves.toBe('after');

    const list = await prepare('worker_list_dir', { path: '.' });
    await expect(list.start()).resolves.toEqual({ content: [{ type: 'text', text: '["after.txt","before.txt"]' }] });
  });

  it('requires the tool and exact command text to be granted', async () => {
    await expect(prepare('worker_read_file', { path: 'x' }, { ...grant, allowedTools: [] })).rejects.toThrow();
    const command = 'node -e "process.stdout.write(\'approved\')"';
    await expect(prepare('worker_command', { command }, { ...grant, commands: ['node -e "process.stdout.write(\'other\')"'] }))
      .rejects.toThrow();
  });

  it.each(['../outside.txt', 'nested/../../outside.txt', '/absolute.txt', 'nested\\outside.txt', 'C:outside.txt'])
    ('rejects unsafe relative paths: %s', async pathValue => {
      await expect(prepare('worker_read_file', { path: pathValue })).rejects.toThrow();
    });

  it('rejects a symlinked file and a symlinked directory escape', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-native-tool-outside-'));
    try {
      await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
      await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'secret.txt'), 'file');
      await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
      await expect(prepare('worker_read_file', { path: 'secret.txt' })).rejects.toThrow();
      await expect(prepare('worker_read_file', { path: 'linked/secret.txt' })).rejects.toThrow();
    } finally { await fs.rm(outside, { recursive: true, force: true }); }
  });

  it('rejects hard-linked files for both reads and writes', async () => {
    const original = path.join(root, 'original.txt');
    const linked = path.join(root, 'linked.txt');
    await fs.writeFile(original, 'protected');
    await fs.link(original, linked);
    await expect(prepare('worker_read_file', { path: 'original.txt' })).rejects.toThrow();
    await expect(prepare('worker_write_file', { path: 'linked.txt', content: 'changed' })).rejects.toThrow();
    await expect(fs.readFile(original, 'utf8')).resolves.toBe('protected');
  });

  it('rejects a root directory replaced after preparation', async () => {
    await fs.writeFile(path.join(root, 'read.txt'), 'original');
    const effect = await prepare('worker_read_file', { path: 'read.txt' });
    renamedRoot = `${root}-renamed`;
    await fs.rename(root, renamedRoot);
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'read.txt'), 'replacement');
    await expect(effect.start()).rejects.toThrow();
  });

  it('does not truncate through a replaced parent directory', async () => {
    const parent = path.join(root, 'parent');
    await fs.mkdir(parent);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-native-tool-outside-'));
    try {
      await fs.writeFile(path.join(outside, 'target.txt'), 'protected');
      const effect = await prepare('worker_write_file', { path: 'parent/target.txt', content: 'changed' });
      await fs.rename(parent, path.join(root, 'old-parent'));
      await fs.symlink(outside, parent, process.platform === 'win32' ? 'junction' : 'dir');
      await expect(effect.start()).rejects.toThrow();
      await expect(fs.readFile(path.join(outside, 'target.txt'), 'utf8')).resolves.toBe('protected');
    } finally { await fs.rm(outside, { recursive: true, force: true }); }
  });

  it('spends a prepared effect after its first start attempt', async () => {
    const effect = await prepare('worker_list_dir', { path: '.' });
    await effect.start();
    await expect(effect.start()).rejects.toThrow('spent');
  });

  it('runs an exact granted child command and returns bounded output', async () => {
    const command = 'node -e "process.stdout.write(\'native-effect-ok\')"';
    const effect = await prepare('worker_command', { command }, { ...grant, commands: [command] });
    await expect(effect.start()).resolves.toEqual({ content: [{ type: 'text', text: 'native-effect-ok' }] });
  });

  it('refuses oversized file contents, directory listings and command output', async () => {
    await expect(prepare('worker_write_file', { path: 'too-large.txt', content: 'x'.repeat(256 * 1024 + 1) }))
      .rejects.toThrow();
    await fs.writeFile(path.join(root, 'too-large.txt'), 'x'.repeat(256 * 1024 + 1));
    const read = await prepare('worker_read_file', { path: 'too-large.txt' });
    await expect(read.start()).rejects.toThrow();

    await fs.mkdir(path.join(root, 'many'));
    await Promise.all(Array.from({ length: 1001 }, (_, index) => fs.writeFile(path.join(root, 'many', `f${index}`), '')));
    const list = await prepare('worker_list_dir', { path: 'many' });
    await expect(list.start()).rejects.toThrow();

    const command = 'node -e "process.stdout.write(\'x\'.repeat(262145))"';
    const effect = await prepare('worker_command', { command }, { ...grant, commands: [command] });
    await expect(effect.start()).rejects.toThrow('failed');
  });

  it('kills an authorized child process when its signal aborts', async () => {
    const command = 'node -e "setTimeout(() => {}, 30000)"';
    const controller = new AbortController();
    const effect = await prepare('worker_command', { command }, { ...grant, commands: [command] }, controller.signal);
    const completion = effect.start();
    setTimeout(() => controller.abort(), 50);
    await expect(completion).rejects.toThrow('failed');
  });
});
