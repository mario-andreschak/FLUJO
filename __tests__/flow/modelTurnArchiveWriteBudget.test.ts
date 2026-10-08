import type { FileHandle } from 'node:fs/promises';
import { observeSdkRequest } from '@/backend/services/model/adapters/types';
import { runWithWorkspace } from '@/utils/workspace';
import { closeArchiveWriteHandle, estimateArchivePayload, getArchiveWritePressure,
  MODEL_TURN_ARCHIVE_WRITE_LIMITS, ModelTurnArchiveMemoryError, reserveArchiveSnapshot,
  settleArchiveWrites, withArchiveWriteMemory } from '@/backend/execution/flow/modelTurnArchiveWriteBudget';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('archive write allocation ownership', () => {
  afterEach(() => {
    jest.useRealTimers();
    expect(getArchiveWritePressure()).toMatchObject({ bytes: 0, writers: 0, quarantined: 0 });
  });

  it('accounts for escaping and complete backing buffers before copying', () => {
    expect(estimateArchivePayload('\u0001')).toBeGreaterThan(estimateArchivePayload('a'));
    const buffer = new ArrayBuffer(4096);
    expect(estimateArchivePayload(new Uint8Array(buffer, 0, 1))).toBeGreaterThanOrEqual(4096);
  });

  it('refuses getters and proxies without running their callbacks', () => {
    const getter = jest.fn(() => 'private');
    const value = Object.defineProperty({}, 'content', { enumerable: true, get: getter });
    expect(() => estimateArchivePayload(value)).toThrow(ModelTurnArchiveMemoryError);
    const trap = jest.fn(() => []);
    expect(() => estimateArchivePayload(new Proxy({}, { ownKeys: trap }))).toThrow(ModelTurnArchiveMemoryError);
    expect(getter).not.toHaveBeenCalled();
    expect(trap).not.toHaveBeenCalled();
  });

  it('shares count admission across workspaces and never calls rejected clone factories', async () => {
    const gate = deferred();
    const entered = deferred();
    let active = 0;
    const writes = Array.from({ length: MODEL_TURN_ARCHIVE_WRITE_LIMITS.concurrentWrites }, (_, index) =>
      runWithWorkspace(`budget-${index}`, () => withArchiveWriteMemory('small', async () => {
        if (++active === MODEL_TURN_ARCHIVE_WRITE_LIMITS.concurrentWrites) entered.resolve();
        await gate.promise;
      })));
    const clone = jest.fn(async () => undefined);
    try {
      await entered.promise;
      await expect(runWithWorkspace('other-budget', () => withArchiveWriteMemory('small', clone)))
        .rejects.toMatchObject({ code: 'MODEL_TURN_ARCHIVE_MEMORY_BUSY', status: 429 });
      expect(clone).not.toHaveBeenCalled();
      expect(getArchiveWritePressure().writers).toBe(4);
    } finally { gate.resolve(); await Promise.allSettled(writes); }
    await withArchiveWriteMemory('small', clone);
    expect(clone).toHaveBeenCalledTimes(1);
  });

  it('holds a canonical reservation through its lifetime and releases it idempotently', () => {
    const reservation = reserveArchiveSnapshot('history');
    const before = getArchiveWritePressure().bytes;
    reservation.grow(128);
    expect(getArchiveWritePressure().bytes).toBe(before + 128);
    reservation.release();
    reservation.release();
    expect(getArchiveWritePressure().bytes).toBe(0);
  });

  it('shares byte capacity between held snapshots and writes before entering a rejected factory', async () => {
    const held: ReturnType<typeof reserveArchiveSnapshot>[] = [];
    const clone = jest.fn(async () => undefined);
    try {
      for (let index = 0; index < 8; index++) {
        const before = getArchiveWritePressure().bytes;
        const reservation = reserveArchiveSnapshot('small');
        held.push(reservation);
        reservation.grow(MODEL_TURN_ARCHIVE_WRITE_LIMITS.snapshotBytes - (getArchiveWritePressure().bytes - before));
      }
      expect(getArchiveWritePressure().bytes).toBe(MODEL_TURN_ARCHIVE_WRITE_LIMITS.processBytes);
      await expect(withArchiveWriteMemory('small', clone)).rejects.toMatchObject({ code: 'MODEL_TURN_ARCHIVE_MEMORY_BUSY' });
      expect(clone).not.toHaveBeenCalled();
    } finally { for (const reservation of held) reservation.release(); }
    await withArchiveWriteMemory('small', clone);
    expect(clone).toHaveBeenCalledTimes(1);
  });

  it('rejects a sparse oversized clone input before entering the writer', async () => {
    const clone = jest.fn(async () => undefined);
    await expect(withArchiveWriteMemory(new Array(MODEL_TURN_ARCHIVE_WRITE_LIMITS.inspectedValues + 1), clone))
      .rejects.toMatchObject({ code: 'MODEL_TURN_ARCHIVE_MEMORY_LIMIT', status: 413 });
    expect(clone).not.toHaveBeenCalled();
  });

  it('waits for pending sibling writes before exposing failure or recycling memory', async () => {
    const pending = deferred();
    const entered = deferred();
    const primary = new Error('actual writer task failed');
    let finished = false;
    const write = withArchiveWriteMemory('history', async () => {
      entered.resolve();
      await settleArchiveWrites([Promise.reject(primary), pending.promise]);
    });
    const observed = write.catch(error => { finished = true; return error; });
    try {
      await entered.promise;
      await Promise.resolve();
      expect(finished).toBe(false);
      expect(getArchiveWritePressure().writers).toBe(1);
      expect(getArchiveWritePressure().bytes).toBeGreaterThan(0);
    } finally { pending.resolve(); }
    expect(await observed).toBe(primary);
  });

  it('does not lend an original permit to reentrant or escaped async work', async () => {
    let escaped!: () => Promise<void>;
    const called = jest.fn(async () => undefined);
    await withArchiveWriteMemory('history', async () => {
      await expect(withArchiveWriteMemory('other', called)).rejects.toMatchObject({ code: 'MODEL_TURN_ARCHIVE_MEMORY_BUSY' });
      // Capture a callback bound to this scope through a pending promise.
      const gate = deferred();
      const late = gate.promise.then(() => withArchiveWriteMemory('late', called));
      escaped = async () => { gate.resolve(); await late; };
    });
    await expect(escaped()).rejects.toMatchObject({ code: 'MODEL_TURN_ARCHIVE_MEMORY_BUSY' });
    expect(called).not.toHaveBeenCalled();
  });

  it('surfaces unscoped ambiguous close as typed uncertainty without retrying a cached close promise', async () => {
    const close = jest.fn().mockRejectedValue(new Error('close failed'));
    await expect(closeArchiveWriteHandle({ close } as unknown as FileHandle))
      .rejects.toMatchObject({ code: 'MODEL_TURN_ARCHIVE_WRITE_CLEANUP' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('charges repeated references for each serialization occurrence', () => {
    const shared = { text: 'retained'.repeat(100) };
    expect(estimateArchivePayload([shared, shared])).toBeGreaterThan(estimateArchivePayload([shared]) * 1.8);
  });

  it('propagates typed refusal through the SDK boundary with zero provider calls', async () => {
    const provider = jest.fn(async () => 'unexpected');
    await expect(observeSdkRequest({ onSdkRequest: async () => {
      throw new ModelTurnArchiveMemoryError('MODEL_TURN_ARCHIVE_MEMORY_BUSY');
    } }, { adapter: 'openai', operation: 'chat.completions.create', request: {} }, provider))
      .rejects.toMatchObject({ code: 'MODEL_TURN_ARCHIVE_MEMORY_BUSY' });
    expect(provider).not.toHaveBeenCalled();
    // Existing optional diagnostics remain best-effort.
    await observeSdkRequest({ onSdkRequest: async () => { throw new Error('optional diagnostic'); } },
      { adapter: 'openai', operation: 'chat.completions.create', request: {} }, provider);
    expect(provider).toHaveBeenCalledTimes(1);
  });
});
