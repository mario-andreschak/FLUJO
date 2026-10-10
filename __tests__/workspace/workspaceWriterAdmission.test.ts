import { promises as fs } from 'node:fs';
import path from 'node:path';
import { withWorkspaceMutation, withWorkspaceRecoveryCapture } from '@/backend/services/workspace/workspaceMutationGate';
import { runWithWorkspace } from '@/utils/workspace';

jest.setTimeout(60_000);

it('admits a burst of independent writers concurrently and drains all of them before capture', async () => {
  await runWithWorkspace(`writer-burst-${process.pid}`, async () => {
    let release!: () => void;
    let allEntered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { allEntered = resolve; });
    const writes = new Set<number>();
    // Matches the 50k recall fixture's batch size. Every admitted task remains
    // active until all registrations finish: serializing whole mutations would
    // deadlock, and competing directly on disk previously timed out at this load.
    const pending = Promise.all(Array.from({ length: 250 }, (_, index) => withWorkspaceMutation(async () => {
      writes.add(index);
      if (writes.size === 250) allEntered();
      await held;
      return index;
    })));
    // Observe rejection while awaiting admissions, so a timeout is an ordinary
    // test failure and does not leave 249 tasks held until the suite deadline.
    const admitted = await Promise.race([entered.then(() => true), pending.then(() => false)]).catch((error) => {
      release();
      throw error;
    });
    expect(admitted).toBe(true);
    let captured = false;
    const snapshot = withWorkspaceRecoveryCapture(async () => { captured = true; return writes.size; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(captured).toBe(false);
    } finally {
      release();
    }
    expect(await pending).toHaveLength(250);
    expect(await snapshot).toBe(250);
    expect(captured).toBe(true);
    expect(globalThis.__flujo_workspace_writer_admission_chains?.size).toBe(0);
  });
});

it('does not poison subsequent admission when an admitted mutation fails', async () => {
  await runWithWorkspace(`writer-failure-${process.pid}`, async () => {
    await expect(withWorkspaceMutation(async () => { throw new Error('expected writer failure'); }))
      .rejects.toThrow('expected writer failure');
    await expect(withWorkspaceMutation(async () => 'written')).resolves.toBe('written');
    await expect(withWorkspaceRecoveryCapture(async () => 'captured')).resolves.toBe('captured');
  });
});


it('groups at most eight registrations per lease and releases each lease before its callers start', async () => {
  await runWithWorkspace(`writer-batching-${process.pid}`, async () => {
    const originalLink = fs.link.bind(fs); const originalUnlink = fs.unlink.bind(fs);
    let lease = 0; const installed: number[] = []; const released = new Set<number>();
    const link = jest.spyOn(fs, 'link').mockImplementation(async (source, target) => {
      await originalLink(source, target);
      const name = path.basename(String(target));
      if (name === '.workspace-capture-admission.lock') lease++;
      else if (/^\.workspace-capture-writer-[0-9a-f-]{36}\.lock$/.test(name)) installed.push(lease);
    });
    const unlink = jest.spyOn(fs, 'unlink').mockImplementation(async target => {
      await originalUnlink(target);
      if (path.basename(String(target)) === '.workspace-capture-admission.lock') released.add(lease);
    });
    let release!: () => void; const held = new Promise<void>(r => { release = r; });
    let entered = 0; let ready!: () => void; const all = new Promise<void>(r => { ready = r; });
    const writes = Array.from({ length: 17 }, (_, i) => withWorkspaceMutation(async () => {
      expect(released.has(installed[i])).toBe(true);
      if (++entered === 17) ready(); await held;
    }));
    try {
      await Promise.race([all, Promise.all(writes)]);
      expect(installed).toHaveLength(17);
      expect([...new Set(installed)]).toHaveLength(3);
      for (const group of new Set(installed)) expect(installed.filter(value => value === group).length).toBeLessThanOrEqual(8);
    } finally { release(); await Promise.allSettled(writes); link.mockRestore(); unlink.mockRestore(); }
    expect(globalThis.__flujo_workspace_writer_admission_chains?.size).toBe(0);
  });
});
