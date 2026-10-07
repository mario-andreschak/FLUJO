import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('rejects a real FIFO without a writer before content reads and closes its descriptor', {
  skip: process.platform === 'win32' ? 'Windows has no POSIX mkfifo' : false,
}, async () => {
  const parent = await fs.realpath(os.tmpdir());
  const fixture = await fs.mkdtemp(path.join(parent, 'flujo-browser-fifo-'));
  const fifo = path.join(fixture, 'unwritten');
  try {
    const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8', timeout: 2000 });
    assert.equal(created.error, undefined, 'mkfifo must actually run');
    assert.equal(created.status, 0, created.stderr);
    assert.equal((await fs.lstat(fifo)).isFIFO(), true);
    const child = fork(fileURLToPath(new URL('./bounded-file-read-fifo-worker.mjs', import.meta.url)), [
      fileURLToPath(new URL('../dist/boundedFileRead.js', import.meta.url)), fifo,
    ], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], timeout: 5000, killSignal: 'SIGKILL' });
    let report;
    let stderr = '';
    let stdout = '';
    child.on('message', message => { report = message; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    child.stdout.on('data', bytes => { stdout += bytes; });
    const exit = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    assert.deepEqual(exit, { code: 0, signal: null }, `FIFO reader did not finish normally: ${stderr}`);
    assert.equal(stdout, '');
    assert.equal(report?.status, 'unavailable');
    assert.equal(report.fifoObserved, true);
    assert.equal(report.opened, 1);
    assert.equal(report.contentReads, 0);
    assert.equal(report.closed, 1);
    assert.equal(report.closedDescriptor, true);
    assert.ok(report.elapsedMs < 2000, `FIFO admission took ${report.elapsedMs}ms`);
    console.log(JSON.stringify({ kind: 'real-fifo-admission', ...report }));
  } finally {
    const resolved = await fs.realpath(fixture);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('flujo-browser-fifo-'));
    await fs.rm(resolved, { recursive: true, force: true });
  }
});
