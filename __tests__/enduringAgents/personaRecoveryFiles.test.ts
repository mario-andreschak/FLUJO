import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersonaRecoveryFileReader } from '@/backend/services/enduringAgents/personaRecoveryFiles';

describe('bounded immutable Persona recovery inputs', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-recovery-files-'));
    await fs.mkdir(path.join(root, 'data'));
    await fs.writeFile(path.join(root, 'data', 'one.txt'), 'one');
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('reads exact bytes and checks directory inventories including empty directories', async () => {
    await fs.mkdir(path.join(root, 'data', 'empty'));
    const reader = new PersonaRecoveryFileReader(root);
    expect(await reader.scan('data')).toEqual(['data/one.txt']);
    expect((await reader.read('data/one.txt', true))?.toString()).toBe('one');
    await reader.verifyUnchanged();
    await fs.writeFile(path.join(root, 'data', 'empty', 'appeared.txt'), 'changed');
    await expect(reader.verifyUnchanged()).rejects.toThrow('inventory changed');
  });

  it('rejects files changed or created after inspection', async () => {
    const reader = new PersonaRecoveryFileReader(root);
    await reader.read('data/one.txt');
    await fs.writeFile(path.join(root, 'data', 'one.txt'), 'longer');
    await expect(reader.verifyUnchanged()).rejects.toThrow('changed');
    const absent = new PersonaRecoveryFileReader(root);
    expect(await absent.read('data/missing.txt')).toBeUndefined();
    await fs.writeFile(path.join(root, 'data', 'missing.txt'), 'created');
    await expect(absent.verifyUnchanged()).rejects.toThrow('appeared');
  });

  it('rejects hard links, directory junctions, traversal and limits before reading content', async () => {
    const reader = new PersonaRecoveryFileReader(root, { fileBytes: 2 });
    await expect(reader.read('data/one.txt')).rejects.toThrow('byte limit');
    await expect(reader.read('../outside.txt')).rejects.toThrow('Unsafe');
    await fs.symlink(path.join(root, 'data'), path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(new PersonaRecoveryFileReader(root).read('linked/one.txt')).rejects.toThrow('linked');
    await fs.link(path.join(root, 'data', 'one.txt'), path.join(root, 'data', 'alias.txt'));
    await expect(new PersonaRecoveryFileReader(root).read('data/one.txt')).rejects.toThrow('unlinked regular');
  });

  it('honors cancellation and finite inventory limits', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Cancelled capture'));
    await expect(new PersonaRecoveryFileReader(root, { signal: controller.signal }).scan('data')).rejects.toThrow('Cancelled capture');
    await expect(new PersonaRecoveryFileReader(root, { entries: 1 }).read('data/one.txt')).rejects.toThrow('entry limit');
    expect(() => new PersonaRecoveryFileReader(root, { totalBytes: Infinity })).toThrow('Invalid');
  });
});
