import { act, renderHook } from '@testing-library/react';
import {
  useAnimationFrame,
  useBatchedCallback,
  useDebouncedCallback,
  useDebouncedValue,
  useInterval,
  useReachedAt,
  useTimeout,
} from '@/frontend/hooks/timing';

describe('timing hooks', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('useTimeout fires once with the latest callback and clears on unmount', () => {
    const first = jest.fn();
    const second = jest.fn();
    const { rerender, unmount } = renderHook(({ callback, delay }) => useTimeout(callback, delay), {
      initialProps: { callback: first, delay: 100 as number | null },
    });
    rerender({ callback: second, delay: 100 });
    act(() => jest.advanceTimersByTime(100));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);

    rerender({ callback: second, delay: 50 });
    unmount();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('useTimeout is disarmed by null and restarted by a new restart key', () => {
    const callback = jest.fn();
    const { rerender } = renderHook(({ delay, key }) => useTimeout(callback, delay, key), {
      initialProps: { delay: null as number | null, key: 0 },
    });
    expect(jest.getTimerCount()).toBe(0);

    rerender({ delay: 100, key: 0 });
    act(() => jest.advanceTimersByTime(60));
    rerender({ delay: 100, key: 1 });
    act(() => jest.advanceTimersByTime(60));
    expect(callback).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(40));
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('useReachedAt turns true exactly when the time arrives and leaves no timer behind', () => {
    const now = Date.now();
    const { result, rerender } = renderHook(({ at }) => useReachedAt(at), {
      initialProps: { at: undefined as number | undefined },
    });
    expect(result.current).toBe(false);
    expect(jest.getTimerCount()).toBe(0);

    rerender({ at: now - 1 });
    expect(result.current).toBe(true);
    expect(jest.getTimerCount()).toBe(0);

    rerender({ at: now + 100 });
    expect(result.current).toBe(false);
    act(() => jest.advanceTimersByTime(99));
    expect(result.current).toBe(false);
    act(() => jest.advanceTimersByTime(1));
    expect(result.current).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('useReachedAt waits for times further away than one browser timer can reach', () => {
    const at = Date.now() + 2 ** 31 + 1_000;
    const { result } = renderHook(() => useReachedAt(at));
    act(() => jest.advanceTimersByTime(2 ** 31 - 1));
    expect(result.current).toBe(false);
    act(() => jest.advanceTimersByTime(1_000));
    expect(result.current).toBe(false);
    act(() => jest.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  it('useInterval repeats until paused', () => {
    const callback = jest.fn();
    const { rerender } = renderHook(({ delay }) => useInterval(callback, delay), {
      initialProps: { delay: 10 as number | null },
    });
    act(() => jest.advanceTimersByTime(35));
    expect(callback).toHaveBeenCalledTimes(3);
    rerender({ delay: null });
    act(() => jest.advanceTimersByTime(100));
    expect(callback).toHaveBeenCalledTimes(3);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('useDebouncedValue settles after changes stop', () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 100), {
      initialProps: { value: 'a' },
    });
    rerender({ value: 'ab' });
    act(() => jest.advanceTimersByTime(50));
    rerender({ value: 'abc' });
    act(() => jest.advanceTimersByTime(99));
    expect(result.current).toBe('a');
    act(() => jest.advanceTimersByTime(1));
    expect(result.current).toBe('abc');
  });

  it('useDebouncedCallback keeps one stable function, uses the last arguments, and supports cancel and flush', () => {
    const callback = jest.fn();
    const { result, rerender, unmount } = renderHook(() => useDebouncedCallback(callback, 100));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);

    act(() => {
      result.current('a');
      result.current('b');
      jest.advanceTimersByTime(100);
    });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenLastCalledWith('b');

    act(() => {
      result.current('c');
      result.current.cancel();
      jest.advanceTimersByTime(200);
    });
    expect(callback).toHaveBeenCalledTimes(1);

    act(() => {
      result.current('d');
      result.current.flush();
    });
    expect(callback).toHaveBeenLastCalledWith('d');

    result.current('e');
    unmount();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('useBatchedCallback lets a steady stream through on time, in order, with flush and cancel', () => {
    const callback = jest.fn();
    const { result, unmount } = renderHook(() => useBatchedCallback<string>(callback, 100));
    const batched = result.current;

    act(() => {
      for (let tick = 0; tick < 5; tick += 1) {
        batched(`token-${tick}`);
        jest.advanceTimersByTime(30);
      }
    });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenLastCalledWith(['token-0', 'token-1', 'token-2', 'token-3']);

    act(() => {
      batched('last');
      batched.flush();
    });
    expect(callback).toHaveBeenLastCalledWith(['token-4', 'last']);
    expect(jest.getTimerCount()).toBe(0);

    act(() => {
      batched('dropped');
      batched.cancel();
      jest.advanceTimersByTime(200);
    });
    expect(callback).toHaveBeenCalledTimes(2);

    act(() => batched.flush());
    expect(callback).toHaveBeenCalledTimes(2);
    expect(result.current).toBe(batched);

    batched('left over');
    unmount();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('useAnimationFrame runs on the next frame, can be cancelled, and leaves nothing behind', () => {
    const { result, unmount } = renderHook(() => useAnimationFrame());
    const requestFrame = result.current;
    const ran = jest.fn();
    const cancelled = jest.fn();
    const leftOver = jest.fn();

    requestFrame(ran);
    const cancel = requestFrame(cancelled);
    cancel();
    expect(ran).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(20));
    expect(ran).toHaveBeenCalledTimes(1);
    expect(cancelled).not.toHaveBeenCalled();

    requestFrame(leftOver);
    unmount();
    act(() => jest.advanceTimersByTime(20));
    expect(leftOver).not.toHaveBeenCalled();
  });
});
