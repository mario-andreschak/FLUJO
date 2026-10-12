import { readStableFile } from '@/utils/readStableFile';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const probeFifo = require('./fixtures/stableFileFifo.cjs') as (read: typeof readStableFile, forceBlocking?: boolean) => Promise<{
  denied: boolean; swapped: boolean; watchdogReleased: boolean; closedDescriptors: number; nonblocking: boolean; elapsedMs: number;
}>;
// Windows has no native mkfifo. The same tracked probe is separately qualified
// against a local Linux container; that receipt is source evidence only.
const posix = process.platform === 'win32' ? test.skip : test;
test('an ordinary owned file remains readable with the platform descriptor flags', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-stable-ordinary-'));
  try {
    const file = path.join(directory, 'metadata');
    await fs.writeFile(file, 'ordinary fixture');
    expect((await readStableFile(file, 64)).toString()).toBe('ordinary fixture');
  } finally {
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('flujo-stable-ordinary-')) {
      throw new Error('Unsafe fixture cleanup');
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
});
posix('a regular file swapped to a FIFO is rejected before the deadline and its descriptor is closed', async () => {
  const result = await probeFifo(readStableFile);
  expect(result).toMatchObject({ denied: true, swapped: true, watchdogReleased: false, nonblocking: true, closedDescriptors: 1 });
  expect(result.elapsedMs).toBeLessThan(500);
});
posix('the blocking predecessor control reaches the watchdog before regular-file rejection', async () => {
  const result = await probeFifo(readStableFile, true);
  expect(result).toMatchObject({ denied: true, swapped: true, watchdogReleased: true, nonblocking: false, closedDescriptors: 1 });
  expect(result.elapsedMs).toBeGreaterThanOrEqual(700);
});
