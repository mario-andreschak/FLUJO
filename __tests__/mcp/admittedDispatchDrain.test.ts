import fs from 'node:fs';
import { AdmittedDispatchDrain } from '@/backend/services/mcp/admittedDispatchDrain';
import { installBundledFixtureOwner } from './fixtures/bundledFixtureOwner';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

// Real file read/close ownership controls for the exact drain used by transport.
// These do not qualify a package grant, child spawn or MCP handshake.
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
      await operation;
      // A failed actual close keeps the fixture inspectable.
      if (handle) throw new Error('Actual held file close remains unresolved');
      owner.restore();
    }
  });

  it('records actual read failure in a nonrejecting drain witness', async () => {
    const owner = installBundledFixtureOwner();
    const drain = new AdmittedDispatchDrain();
    try {
      const operation = drain.admit(async () => {
        const handle = await fs.promises.open(process.env.FLUJO_OWNER_AUTH_FILE!, 'r');
        await handle.close();
        await handle.readFile(); // genuine closed-descriptor failure
      });
      const settlement = drain.seal();
      await expect(operation).rejects.toThrow();
      await settlement;
      expect(drain.pending).toBe(0);
      expect(drain.failures).toHaveLength(1);
    } finally { owner.restore(); }
  });
});
