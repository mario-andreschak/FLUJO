import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeCaptureArtifact } from '../../mcp-servers/browser/src/capture';

describe('browser artifact safety', () => {
  const savedEnv = { ...process.env };
  const roots: string[] = [];

  afterEach(async () => {
    process.env = { ...savedEnv };
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  async function temp(prefix: string): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    roots.push(root);
    return root;
  }

  it('uses exclusive creation and rejects escapes and Windows path aliases', async () => {
    const dataDir = await temp('flujo-browser-artifacts-');
    process.env.FLUJO_DATA_DIR = dataDir;
    const destination = path.join(dataDir, 'evidence.png');

    await expect(writeCaptureArtifact(destination, ['unused.png'], Buffer.from('baseline')))
      .resolves.toBe(destination);
    await expect(writeCaptureArtifact(destination, ['unused.png'], Buffer.from('candidate')))
      .rejects.toThrow('never overwrite');
    await expect(fs.readFile(destination, 'utf8')).resolves.toBe('baseline');

    const outside = await temp('flujo-browser-outside-');
    await expect(writeCaptureArtifact(path.join(outside, 'escape.png'), ['unused.png'], Buffer.alloc(0)))
      .rejects.toThrow('inside the FLUJO data directory');
    await expect(writeCaptureArtifact('\\\\server\\share\\escape.png', ['unused.png'], Buffer.alloc(0)))
      .rejects.toThrow('UNC');
    if (process.platform === 'win32') {
      await expect(writeCaptureArtifact('C:drive-relative.png', ['unused.png'], Buffer.alloc(0)))
        .rejects.toThrow('drive-relative');
      await expect(writeCaptureArtifact(path.join(dataDir, 'NUL.png'), ['unused.png'], Buffer.alloc(0)))
        .rejects.toThrow('reserved');
    }
  });

  it('rejects an approved-root path whose parent traverses a symlink or junction', async () => {
    const dataDir = await temp('flujo-browser-artifacts-');
    const outside = await temp('flujo-browser-outside-');
    process.env.FLUJO_DATA_DIR = dataDir;
    const link = path.join(dataDir, 'linked-outside');
    await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(writeCaptureArtifact(path.join(link, 'escape.png'), ['unused.png'], Buffer.alloc(0)))
      .rejects.toThrow('symlink or junction');
    await expect(fs.access(path.join(outside, 'escape.png'))).rejects.toThrow();
  });
});
