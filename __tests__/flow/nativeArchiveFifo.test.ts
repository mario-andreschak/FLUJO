import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';

const posix = process.platform === 'win32' ? it.skip : it;
function probe(mode: string) {
  const directory = mkdtempSync(join(tmpdir(), 'native-archive-fifo-'));
  try {
    return spawnSync(process.execPath, [join(process.cwd(), '__tests__/flow/fixtures/nativeArchiveFifo.cjs'),
      process.cwd(), directory, mode], { timeout: 2500, encoding: 'utf8', windowsHide: true });
  } finally {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('native-archive-fifo-')) throw new Error('Unsafe FIFO fixture cleanup');
    rmSync(target, { recursive: true, force: true });
  }
}

describe('native archive nonblocking descriptor validation', () => {
  posix.each(['snapshot', 'companion'])('rejects a real %s FIFO without reading its payload or leaking admission', mode => {
    const result = probe(mode);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ denied: true, nonblocking: true,
      closedDescriptors: mode === 'snapshot' ? 1 : 2, targetReads: 0, activeReads: 0 });
  });
  posix('the blocking predecessor control reaches the bounded child deadline', () => {
    const result = probe('blocking-control');
    expect(result.error).toMatchObject({ code: 'ETIMEDOUT' });
    expect(result.status).toBeNull();
    expect(result.signal).toBe('SIGTERM');
  });
});
