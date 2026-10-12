import {
  _resetLifecycleForTests, beginConnect, beginTeardown, getLifecycleDiagnostics,
  getRuntime, getShutdownReceipt, markConnected,
  runtimeKey,
} from '@/backend/services/mcp/lifecycleCoordinator';
import { runWithWorkspace } from '@/utils/workspace';
import type { MCPShutdownObservation } from '@/shared/types/mcp/shutdown';

const observed: MCPShutdownObservation = {
  processOwnership: 'owned', exitOutcome: 'observed_exit', forced: false,
  errorClassification: 'none',
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => _resetLifecycleForTests());

it('preserves the canonical NUL-delimited runtime identity with textual source escaping', () => {
  expect(runtimeKey('srv', 'user-a')).toBe('user-a\u0000srv');
});

it('folds overlapping callers onto one immutable generation-bound receipt', async () => {
  const wait = deferred();
  const close = jest.fn(async () => { await wait.promise; return observed; });
  markConnected('srv');
  const first = beginTeardown('srv', 'disconnect', close);
  const second = beginTeardown('srv', 'shutdown', close);
  expect(first).toBe(second);
  wait.resolve();
  const receipt = await first;
  expect(await second).toBe(receipt);
  expect(close).toHaveBeenCalledTimes(1);
  expect(receipt).toMatchObject({ schemaVersion: 1, generation: 1, ...observed });
  expect(Number.isFinite(Date.parse(receipt.observedAt))).toBe(true);
  expect(receipt.durationMs).toBeGreaterThanOrEqual(0);
  expect(Object.isFrozen(receipt)).toBe(true);
  expect(getShutdownReceipt('srv')).toBe(receipt);
  expect(getLifecycleDiagnostics()[0].shutdownReceipt).toBe(receipt);
});

it('binds to the generation registered by an in-flight connect before closing', async () => {
  const wait = deferred();
  const connect = beginConnect('srv', async () => {
    await wait.promise;
    markConnected('srv');
  });
  const close = jest.fn(async () => observed);
  const teardown = beginTeardown('srv', 'disconnect', close);
  await Promise.resolve();
  expect(close).not.toHaveBeenCalled();
  wait.resolve();
  await connect;
  expect(await teardown).toMatchObject({ generation: 1, ...observed });
});

it('returns unknown when close fails and excludes private error/callback fields', async () => {
  markConnected('srv');
  const receipt = await beginTeardown('srv', 'private reason', async () => {
    throw new Error('SECRET=private-token command --password private-password');
  });
  expect(receipt).toMatchObject({ exitOutcome: 'unknown', errorClassification: 'close_failed' });
  expect(JSON.stringify(receipt)).not.toMatch(/SECRET|password|private reason/);
  markConnected('srv');
  const extra = await beginTeardown('srv', 'disconnect', async () => ({
    ...observed, stderr: 'SECRET=private-token', command: 'private-command',
  }));
  expect(JSON.stringify(extra)).not.toMatch(/SECRET|stderr|private-command/);
});

it('does not convert an empty close result into an observed exit', async () => {
  const receipt = await beginTeardown('srv', 'disconnect', async () => undefined);
  expect(receipt).toMatchObject({ processOwnership: 'unknown', exitOutcome: 'unknown',
    errorClassification: 'exit_unobserved' });
});

it('clears prior receipts during replacement and fences late generation results', async () => {
  markConnected('srv');
  const old = await beginTeardown('srv', 'disconnect', async () => observed);
  const wait = deferred();
  const replacement = beginConnect('srv', async () => { await wait.promise; markConnected('srv'); });
  expect(getShutdownReceipt('srv')).toBeUndefined();
  wait.resolve();
  await replacement;
  const stale = beginTeardown('srv', 'disconnect', async () => {
    // Defensive check: an out-of-band newer registration must never be marked cold.
    markConnected('srv');
    return observed;
  });
  expect((await stale).generation).toBe(2);
  expect(getRuntime('srv').generation).toBe(3);
  expect(getRuntime('srv').state).toBe('warm');
  expect(getShutdownReceipt('srv')).toBeUndefined();
  expect(old.generation).toBe(1);
});

it('partitions identical server names by workspace and changes identity after reset', async () => {
  const a = await runWithWorkspace('user-a', () => {
    markConnected('srv');
    return beginTeardown('srv', 'disconnect', async () => observed);
  });
  runWithWorkspace('user-b', () => {
    expect(getShutdownReceipt('srv')).toBeUndefined();
    markConnected('srv');
    expect(getRuntime('srv').runtimeId).not.toBe(a.runtimeId);
  });
  expect(runWithWorkspace('user-a', () => getShutdownReceipt('srv'))).toBe(a);
  _resetLifecycleForTests();
  expect(runWithWorkspace('user-a', () => getRuntime('srv').runtimeId)).not.toBe(a.runtimeId);
});
