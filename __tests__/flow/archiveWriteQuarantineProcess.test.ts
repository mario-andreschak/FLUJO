import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createArchiveOwnedFixture, removeArchiveOwnedFixture } from './fixtures/archiveOwnedFixture';

const worker = process.env.FLUJO_ARCHIVE_QUARANTINE_CHILD === '1';
let ownedRoot: string;
let openDescriptor: FileHandle | undefined;
let temp: string | undefined;
let closeCalls = 0;
let cachedFailure: Promise<void> | undefined;
jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return { ...actual, promises: { ...actual.promises,
    open: async (...args: Parameters<typeof actual.promises.open>) => {
      const handle = await actual.promises.open(...args);
      const file = String(args[0]);
      if (!worker || !file.includes('.v2.json.gz.') || !file.endsWith('.tmp')) return handle;
      openDescriptor = handle;
      temp = file;
      return new Proxy(handle, { get(target, key) {
        if (key === 'close') return () => {
          closeCalls++;
          // Fault BEFORE real close: actual FD stays open. Repeated attempts
          // would only observe the same failed promise, not physical drainage.
          return cachedFailure ??= Promise.reject(new Error('Injected cached close failure before OS close'));
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    },
  } };
});

import { _setModelTurnArchiveDirForTests, archiveModelDispatch } from '@/backend/execution/flow/modelTurnArchive';
import { getArchiveWritePressure } from '@/backend/execution/flow/modelTurnArchiveWriteBudget';

jest.setTimeout(60_000);

if (worker) {
  it('keeps scoped admission and physical temp ownership after the archive task rejects', async () => {
    const requested = process.env.FLUJO_ARCHIVE_QUARANTINE_ROOT;
    if (!requested) throw new Error('Missing owned worker root');
    ownedRoot = await fs.realpath(requested);
    const temporaryParent = await fs.realpath(os.tmpdir());
    const relative = path.relative(temporaryParent, ownedRoot);
    const identity = await fs.lstat(requested);
    if (identity.isSymbolicLink() || !identity.isDirectory() || !path.isAbsolute(requested)
        || path.resolve(requested) !== ownedRoot || relative !== path.basename(ownedRoot)
        || !relative.startsWith('flujo-archive-control-')) throw new Error('Unowned quarantine worker root');
    _setModelTurnArchiveDirForTests(path.join(ownedRoot, 'archives'));
    process.env.FLUJO_DATA_DIR = ownedRoot;
    delete process.env.FLUJO_PARENT_DATA_DIR;
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    await expect(archiveModelDispatch({ conversationId: 'quarantine', nodeId: 'node', modelId: 'model',
      modelName: 'offline', adapter: 'control', operation: 'write', attempt: 1,
      canonicalMessages: [{ id: 'original', role: 'user', timestamp: 1, content: 'retained history' }],
      genericWire: [{ role: 'user', content: 'retained history' }], sdkRequest: {},
    })).rejects.toMatchObject({ code: 'MODEL_TURN_ARCHIVE_WRITE_CLEANUP' });
    const pressure = getArchiveWritePressure();
    expect(pressure.writers).toBe(1);
    expect(pressure.quarantined).toBe(1);
    expect(pressure.bytes).toBeGreaterThan(0);
    expect(openDescriptor).toBeDefined();
    expect(temp).toBeDefined();
    // Real OS descriptor remains usable AFTER the logical archive operation
    // settled. Neither a rejected close promise nor task settlement closed it.
    const stat = await openDescriptor!.stat();
    expect(stat.size).toBeGreaterThan(0);
    // Atomic writer opened 'wx' (write-only), so prove OS writability, not a
    // read on that descriptor. This remains an uncertain, uncommitted temp.
    expect((await openDescriptor!.write(Buffer.from([0]), 0, 1, stat.size)).bytesWritten).toBe(1);
    const tempBytes = stat.size + 1;
    expect((await fs.readFile(temp!)).byteLength).toBe(tempBytes);
    expect((await fs.readdir(path.dirname(temp!))).filter(file => file.endsWith('.v2.json.gz'))).toEqual([]);
    // Advance timers only; do not execute a real delay or retry the descriptor.
    await jest.advanceTimersByTimeAsync(5000);
    jest.useRealTimers();
    expect(closeCalls).toBe(1);
    await fs.writeFile(path.join(ownedRoot, 'quarantine-proof.json'), JSON.stringify({
      heldBytes: pressure.bytes, writers: pressure.writers, quarantined: pressure.quarantined,
      descriptorWritableAfterSettlement: true, tempBytes, closeCalls,
      tempRelative: path.relative(ownedRoot, temp!), finalRenamed: false,
    }));
    // Intentionally no close/release/delete. Worker process exit is the only
    // cleanup boundary; parent must observe exit AND stdio drainage first.
  });
} else {
  it('isolates actual open-descriptor quarantine until worker exit and cleans only its proven owned fixture', async () => {
    const fixture = await createArchiveOwnedFixture();
    const checkout = await fs.realpath(process.cwd());
    const cli = await fs.realpath(require.resolve('jest/bin/jest'));
    const localModules = await fs.realpath(path.join(checkout, 'node_modules'));
    const relativeCli = path.relative(localModules, cli);
    if (!relativeCli || relativeCli.startsWith('..') || path.isAbsolute(relativeCli)) {
      throw new Error(`Jest CLI is outside this installed checkout; preserve ${fixture.root}`);
    }
    const child = spawn(process.execPath, [cli, '--selectProjects', 'node', '--runInBand', '--runTestsByPath', __filename], {
      cwd: checkout, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
        NODE_ENV: 'test', FLUJO_ARCHIVE_QUARANTINE_CHILD: '1', FLUJO_ARCHIVE_QUARANTINE_ROOT: fixture.root },
    });
    let outputBytes = 0;
    let timedOut = false;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const collect = (destination: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes <= 1024 * 1024) destination.push(Buffer.from(chunk));
      else { timedOut = true; child.kill('SIGKILL'); }
    };
    child.stdout!.on('data', collect(stdout));
    child.stderr!.on('data', collect(stderr));
    const drained = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 45_000);
    try {
      const exit = await drained; // 'close' follows process exit and stdio close.
      await fs.writeFile(path.join(fixture.root, 'worker-stdout.log'), Buffer.concat(stdout));
      await fs.writeFile(path.join(fixture.root, 'worker-stderr.log'), Buffer.concat(stderr));
      if (timedOut || exit.code !== 0 || exit.signal !== null || outputBytes > 1024 * 1024) {
        throw new Error(`Quarantine worker uncertain/failed; preserve ${fixture.root}; code=${exit.code}, signal=${exit.signal}, outputBytes=${outputBytes}`);
      }
      const proof = JSON.parse(await fs.readFile(path.join(fixture.root, 'quarantine-proof.json'), 'utf8'));
      expect(proof).toMatchObject({ writers: 1, quarantined: 1, descriptorWritableAfterSettlement: true, closeCalls: 1, finalRenamed: false });
      expect(proof.heldBytes).toBeGreaterThan(0);
      expect(proof.tempBytes).toBeGreaterThan(0);
      const relative = path.normalize(proof.tempRelative);
      if (path.isAbsolute(relative) || relative.startsWith('..') || !relative.endsWith('.tmp')) {
        throw new Error(`Worker temp identity invalid; preserve ${fixture.root}`);
      }
      expect((await fs.stat(path.join(fixture.root, relative))).size).toBe(proof.tempBytes);
      // OS owns closing the exited worker's actual descriptors. Root/parent
      // identity and containment are independently checked by the cleanup.
      await removeArchiveOwnedFixture(fixture);
    } finally { clearTimeout(timeout); }
  });
}
