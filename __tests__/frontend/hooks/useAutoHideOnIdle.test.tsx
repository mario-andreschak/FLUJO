/**
 * Unit tests for useAutoHideOnIdle (issue #376).
 *
 * The chat controls auto-hide after a period of inactivity on mobile and must
 * reappear as soon as the user scrolls/taps — and must never hide (nor even arm
 * a timer) on desktop.
 */
import { act, renderHook } from '@testing-library/react';
import { useAutoHideOnIdle } from '@/frontend/hooks/useAutoHideOnIdle';

describe('useAutoHideOnIdle (#376)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('stays visible and never arms a timer when disabled (desktop)', () => {
    const { result } = renderHook(() => useAutoHideOnIdle({ enabled: false, idleMs: 100 }));

    expect(result.current.visible).toBe(true);
    expect(jest.getTimerCount()).toBe(0);

    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(result.current.visible).toBe(true);
    expect(jest.getTimerCount()).toBe(0);

    act(() => {
      result.current.poke();
    });
    expect(result.current.visible).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('hides after the idle delay when enabled', () => {
    const { result } = renderHook(() => useAutoHideOnIdle({ enabled: true, idleMs: 500 }));

    expect(result.current.visible).toBe(true);

    act(() => {
      jest.advanceTimersByTime(499);
    });
    expect(result.current.visible).toBe(true);

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(result.current.visible).toBe(false);
  });

  it('reappears on poke() and restarts the idle timer', () => {
    const { result } = renderHook(() => useAutoHideOnIdle({ enabled: true, idleMs: 500 }));

    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(result.current.visible).toBe(false);

    act(() => {
      result.current.poke();
    });
    expect(result.current.visible).toBe(true);

    act(() => {
      jest.advanceTimersByTime(499);
    });
    expect(result.current.visible).toBe(true);

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(result.current.visible).toBe(false);
  });

  it('never hides while poke() keeps arriving before the delay elapses', () => {
    const { result } = renderHook(() => useAutoHideOnIdle({ enabled: true, idleMs: 500 }));

    for (let i = 0; i < 5; i += 1) {
      act(() => {
        jest.advanceTimersByTime(400);
        result.current.poke();
      });
      expect(result.current.visible).toBe(true);
    }
  });

  it('clears the timer on unmount', () => {
    const { unmount } = renderHook(() => useAutoHideOnIdle({ enabled: true, idleMs: 500 }));
    expect(jest.getTimerCount()).toBe(1);

    unmount();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('reveals immediately when auto-hide is switched off', () => {
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useAutoHideOnIdle({ enabled, idleMs: 500 }),
      { initialProps: { enabled: true } },
    );

    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(result.current.visible).toBe(false);

    rerender({ enabled: false });
    expect(result.current.visible).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });
});
