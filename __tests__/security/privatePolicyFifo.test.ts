import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPrivatePolicyJson } from '@/backend/services/security/readPrivatePolicy';

const probe = require('./fixtures/privatePolicyFifo.cjs') as (read: typeof readPrivatePolicyJson, forceBlocking?: boolean) => Promise<{
  denied: boolean; swapped: boolean; reads: number; closes: number; watchdogReleased: boolean; nonblocking: boolean; elapsedMs: number;
}>;
const posix = process.platform === 'win32' ? test.skip : test;

test('an actual regular private policy remains admitted before the special-file controls', () => {
  const directory = fs.mkdtempSync(path.join(path.resolve(os.tmpdir()), 'flujo-policy-regular-'));
  const filename = path.join(directory, 'policy.json');
  try {
    fs.writeFileSync(filename, '{"approved":true}', { mode: 0o600 });
    expect(readPrivatePolicyJson(filename)).toEqual({ approved: true });
  } finally {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !/^flujo-policy-regular-[A-Za-z0-9]+$/.test(path.basename(resolved))
        || fs.realpathSync.native(resolved) !== resolved) throw new Error('Unsafe regular policy fixture cleanup');
    fs.rmSync(resolved, { recursive: true });
  }
});

posix('an actual FIFO replacement denies promptly without content reads and closes its descriptor', async () => {
  const result = await probe(readPrivatePolicyJson);
  expect(result).toMatchObject({ denied: true, swapped: true, reads: 0, closes: 1, watchdogReleased: false, nonblocking: true });
  expect(result.elapsedMs).toBeLessThan(650);
});

posix('removing the nonblocking flag requires the separate watchdog to release open', async () => {
  const result = await probe(readPrivatePolicyJson, true);
  expect(result).toMatchObject({ denied: true, swapped: true, reads: 0, closes: 1, watchdogReleased: true, nonblocking: false });
  expect(result.elapsedMs).toBeGreaterThanOrEqual(700);
});
