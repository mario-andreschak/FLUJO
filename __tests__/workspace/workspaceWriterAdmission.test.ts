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
