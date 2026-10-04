import { promises as fs } from 'node:fs';
import { readOperatorPassphrase } from '@/utils/encryption/privateProfile';
import { readCredentialJson } from '@/utils/encryption/workspaceFiles';

type Kind = 'operator' | 'json';
type Files = Record<Kind, string>;
type ProbeResult = { denied: boolean; swapped: boolean; watchdogReleased: boolean;
  closedDescriptors: number; readCalls: number; nonblocking: boolean; elapsedMs: number };
const fixture = require('./fixtures/stableCredentialFifo.cjs') as {
  withOwnedFixture: <T>(action: (files: Files) => Promise<T>) => Promise<T>;
  probeFifo: (read: (file: string) => Promise<unknown>, kind: Kind, error: string, forceBlocking?: boolean) => Promise<ProbeResult>;
  probeReplacement: (read: (file: string) => Promise<unknown>, kind: Kind, error: string, afterRead: boolean) => Promise<{
    denied: boolean; swapped: boolean; closedDescriptors: number; readCalls: number;
  }>;
};
const readers = { operator: () => readOperatorPassphrase(), json: (file: string) => readCredentialJson(file, 1024) };
const errors = { operator: 'Operator encryption secret is unavailable or invalid',
  json: 'Credential storage is invalid; restore a matching workspace backup' };
// Native FIFO and POSIX permission cases execute by default on Linux CI.
const posix = process.platform === 'win32' ? test.skip : test;

test('both private-profile readers accept ordinary owned real files', async () => {
  await fixture.withOwnedFixture(async files => {
    expect(await readOperatorPassphrase()).toBe('synthetic-private-passphrase-with-32-characters');
    expect(await readCredentialJson(files.json, 1024)).toEqual({ fixture: 'safe' });
  });
});

posix('operator rejects a real file with group or other permissions', async () => {
  await fixture.withOwnedFixture(async files => {
    await fs.chmod(files.operator, 0o644);
    await expect(readOperatorPassphrase()).rejects.toThrow(errors.operator);
  });
});

for (const kind of ['operator', 'json'] as const) {
  test.each([false, true])(`${kind} rejects actual file replacement afterRead=%s with one closed descriptor`, async afterRead => {
    const result = await fixture.probeReplacement(readers[kind], kind, errors[kind], afterRead);
    expect(result).toMatchObject({ denied: true, swapped: true, closedDescriptors: 1 });
    if (afterRead) expect(result.readCalls).toBeGreaterThan(0);
    else expect(result.readCalls).toBe(0);
  });
  posix(`${kind} rejects a FIFO replacement before reading bytes or reaching the watchdog`, async () => {
    const result = await fixture.probeFifo(readers[kind], kind, errors[kind]);
    expect(result).toMatchObject({ denied: true, swapped: true, watchdogReleased: false,
      nonblocking: true, closedDescriptors: 1, readCalls: 0 });
    expect(result.elapsedMs).toBeLessThan(500);
  });
  posix(`${kind} blocking negative control reaches the watchdog and closes without reading bytes`, async () => {
    const result = await fixture.probeFifo(readers[kind], kind, errors[kind], true);
    expect(result).toMatchObject({ denied: true, swapped: true, watchdogReleased: true,
      nonblocking: false, closedDescriptors: 1, readCalls: 0 });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(700);
  });
}
