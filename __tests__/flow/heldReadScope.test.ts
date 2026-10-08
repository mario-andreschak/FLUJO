import { createHeldReadScope } from '@/backend/execution/flow/heldReadScope';

describe('held read composite assertion lifetime', () => {
  it('invalidates and drains an assertion waiting in its goal guard before unlock', async () => {
    const scope = createHeldReadScope();
    let resumeGoal!: () => void;
    const goalRead = new Promise<void>(resolve => { resumeGoal = resolve; });
    const assertion = scope.run(async () => {
      await goalRead;
      return 'must-not-escape';
    });
    const refused = expect(assertion).rejects.toThrow('callback scope ended');
    let closed = false;
    const closing = scope.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    const escapedGuard = jest.fn(async () => undefined);
    await expect(scope.run(escapedGuard)).rejects.toThrow('callback scope ended');
    expect(escapedGuard).not.toHaveBeenCalled();
    resumeGoal();
    await refused;
    await closing;
    expect(closed).toBe(true);
  });

  it('drains a failing composite assertion without replacing the callback failure', async () => {
    const scope = createHeldReadScope();
    let failGoal!: (error: Error) => void;
    const failure = new Error('actual goal read failed');
    const goalRead = new Promise<void>((_resolve, reject) => { failGoal = reject; });
    const assertion = scope.run(() => goalRead);
    const refused = expect(assertion).rejects.toBe(failure);
    const closing = scope.close();
    failGoal(failure);
    await refused;
    await expect(closing).resolves.toBeUndefined();
  });
});
