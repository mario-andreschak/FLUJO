import fs from 'node:fs';
import { AdmittedDispatchDrain } from '@/backend/services/mcp/admittedDispatchDrain';
import { installBundledFixtureOwner } from './fixtures/bundledFixtureOwner';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

// Real held-FD task settlement controls for the exact drain used by transport.
// Gates precede actual reads/closes, not an OS operation already in flight.
// These do not qualify OS read/close faults, grants, spawns or MCP handshakes.
describe('admitted dispatch settlement', () => {
  it.each(['read', 'close'] as const)('waits for an actual held-file %s operation after abort', async phase => {
    const owner = installBundledFixtureOwner();
    const drain = new AdmittedDispatchDrain();
    const entered = gate();
    const held = gate();
    const abort = new AbortController();
    let operation: Promise<void> | undefined;
    let handle: Awaited<ReturnType<typeof fs.promises.open>> | undefined;
    try {
      operation = drain.admit(async () => {
        handle = await fs.promises.open(process.env.FLUJO_OWNER_AUTH_FILE!, 'r');
        try {
          if (phase === 'read') { entered.release(); await held.promise; }
          expect((await handle.readFile('utf8')).length).toBeGreaterThan(0);
          if (phase === 'close') { entered.release(); await held.promise; }
        } finally {
          await handle.close();
          handle = undefined;
        }
      });
      await entered.promise;
      const settlement = drain.seal();
      let settled = false;
      void settlement.then(() => { settled = true; });
      abort.abort();
      await Promise.resolve();
      expect(abort.signal.aborted).toBe(true);
      expect(settled).toBe(false);
      expect(drain.pending).toBe(1);
      expect((await handle!.stat()).isFile()).toBe(true);
      held.release();
      await operation;
      await settlement;
      expect(drain.pending).toBe(0);
      expect(drain.failures).toEqual([]);
      expect(handle).toBeUndefined();
    } finally {
      held.release();
      const failures: unknown[] = [];
      try { await operation; } catch (error) { failures.push(error); }
      // Restore environment independently. Directory deletion requires actual
      // FD settlement and is withheld when close remains live or uncertain.
      try { owner.restoreEnvironment(); } catch (error) { failures.push(error); }
      if (handle) failures.push(new Error('Actual held file close remains unresolved; owned directory preserved'));
      else try { owner.removeDirectory(); } catch (error) { failures.push(error); }
      if (failures.length) throw Object.assign(new AggregateError(failures, 'Held-FD task/owner cleanup failed'), {
        handle, ownerDirectory: owner.directory,
      });
    }
  });

  it('records actual read failure in a nonrejecting drain witness', async () => {
    const owner = installBundledFixtureOwner();
    const drain = new AdmittedDispatchDrain();
    let handle: Awaited<ReturnType<typeof fs.promises.open>> | undefined;
    let operation: Promise<void> | undefined;
    try {
      operation = drain.admit(async () => {
        handle = await fs.promises.open(process.env.FLUJO_OWNER_AUTH_FILE!, 'r');
        await handle.close();
        const closed = handle;
        handle = undefined; // Only after the actual close resolved.
        await closed.readFile(); // genuine closed-descriptor failure
      });
      const settlement = drain.seal();
      await expect(operation).rejects.toThrow();
      await settlement;
      expect(drain.pending).toBe(0);
      expect(drain.failures).toHaveLength(1);
    } finally {
      const failures: unknown[] = [];
      // Expected read rejection is asserted above; actual close uncertainty
      // still withholds recursive directory cleanup.
      try { await operation; } catch { /* Asserted actual read failure. */ }
      try { owner.restoreEnvironment(); } catch (error) { failures.push(error); }
      if (handle) failures.push(new Error('Actual held file close remains unresolved; owned directory preserved'));
      else try { owner.removeDirectory(); } catch (error) { failures.push(error); }
      if (failures.length) throw Object.assign(new AggregateError(failures, 'Read-failure fixture cleanup unresolved'), {
        handle, ownerDirectory: owner.directory,
      });
    }
  });
});
