import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectBundledMcpDependencyGraph } from '@/backend/services/security/bundledMcpDependencyGraph';

let root: string;
let directory: string;
let manifest: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-dependency-metadata-')));
  directory = path.join(root, 'fixture');
  fs.mkdirSync(directory);
  manifest = path.join(directory, 'package.json');
  fs.writeFileSync(manifest, '{"name":"fixture","version":"1.0.0"}');
  fs.writeFileSync(path.join(directory, 'index.js'), 'export const value = 1;');
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

test('a canonical-path refusal drains the pending named identity before closing the descriptor', async () => {
  const realpath = fs.promises.realpath.bind(fs.promises);
  const lstat = fs.promises.lstat.bind(fs.promises);
  const open = fs.promises.open.bind(fs.promises);
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const refusal = new Error('canonical fixture refusal');
  let closed = false;
  jest.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (String(args[0]) === manifest) {
      const close = handle.close.bind(handle);
      jest.spyOn(handle, 'close').mockImplementation(async () => { closed = true; await close(); });
    }
    return handle;
  });
  jest.spyOn(fs.promises, 'realpath').mockImplementation((async (filename: fs.PathLike) => {
    if (String(filename) === manifest) throw refusal;
    return realpath(filename);
  }) as typeof fs.promises.realpath);
  jest.spyOn(fs.promises, 'lstat').mockImplementation((async (...args: Parameters<typeof fs.promises.lstat>) => {
    const [filename] = args;
    if (String(filename) === manifest) { entered(); await pending; }
    return lstat(...args);
  }) as typeof fs.promises.lstat);
  let settled = false;
  const inspection = inspectBundledMcpDependencyGraph(root, [directory]);
  const outcome = inspection.then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
  try {
    await started;
    expect(settled).toBe(false);
    expect(closed).toBe(false);
  } finally { release(); }
  expect(await outcome).toBe(refusal);
  expect(closed).toBe(true);
});

test('a named file replaced during canonical metadata inspection is refused', async () => {
  const realpath = fs.promises.realpath.bind(fs.promises);
  let replaced = false;
  jest.spyOn(fs.promises, 'realpath').mockImplementation((async (filename: fs.PathLike) => {
    const result = await realpath(filename);
    if (String(filename) === manifest && !replaced) {
      replaced = true;
      fs.renameSync(manifest, `${manifest}.old`);
      fs.writeFileSync(manifest, '{"name":"replacement","version":"2.0.0"}');
    }
    return result;
  }) as typeof fs.promises.realpath);
  await expect(inspectBundledMcpDependencyGraph(root, [directory])).rejects.toThrow('Dependency asset changed');
  expect(replaced).toBe(true);
});

test('unchanged actual dependency assets retain a deterministic graph digest', async () => {
  const first = await inspectBundledMcpDependencyGraph(root, [directory]);
  const second = await inspectBundledMcpDependencyGraph(root, [directory]);
  expect(second).toEqual(first);
  expect(first.packages).toHaveLength(1);
});
