import { withDeadline } from '@/frontend/components/Chat/deadline';

describe('withDeadline', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('settles with the work when it finishes first and leaves no timer behind', async () => {
    await expect(withDeadline(Promise.resolve('done'), 1_000, () => 'late')).resolves.toBe('done');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('settles with the deadline value when the work takes too long', async () => {
    const result = withDeadline(new Promise<string>(() => undefined), 1_500, () => 'gave up');
    jest.advanceTimersByTime(1_499);
    let settled = false;
    void result.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    jest.advanceTimersByTime(1);
    await expect(result).resolves.toBe('gave up');
  });

  it('rejects with what the deadline throws', async () => {
    const result = withDeadline(new Promise<void>(() => undefined), 100, () => {
      throw new Error('proxy timeout');
    });
    jest.advanceTimersByTime(100);
    await expect(result).rejects.toThrow('proxy timeout');
  });

  it('passes a failing work through and clears the deadline', async () => {
    await expect(withDeadline(Promise.reject(new Error('boom')), 100, () => 'late')).rejects.toThrow('boom');
    expect(jest.getTimerCount()).toBe(0);
  });
});
