/** @jest-environment jsdom */

import type { EventStreamHandlers } from '@/frontend/services/chat';
import { startSidebarRefresh } from '@/frontend/components/Chat/sidebarRefresh';

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('sidebar refresh', () => {
  let handlers: EventStreamHandlers | undefined;
  const close = jest.fn();
  const refresh = jest.fn(() => Promise.resolve());
  const subscribe = jest.fn((next: EventStreamHandlers) => {
    handlers = next;
    return { close };
  });
  const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  beforeEach(() => {
    jest.useFakeTimers();
    handlers = undefined;
    close.mockClear();
    refresh.mockClear();
    subscribe.mockClear();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  });

  afterEach(() => jest.useRealTimers());

  it('refreshes every 30 seconds as a safety net, scheduling the next one after the last settles', async () => {
    const stop = startSidebarRefresh({ refresh, subscribe });
    expect(subscribe).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(29_999);
    expect(refresh).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    await settle();
    jest.advanceTimersByTime(30_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    stop();
  });

  it('folds a burst of lifecycle events into one refresh at most every five seconds', async () => {
    const stop = startSidebarRefresh({ refresh, subscribe });
    handlers?.onEvent({ type: 'run:start' } as never);
    handlers?.onEvent({ type: 'run:done' } as never);
    jest.advanceTimersByTime(4_999);
    expect(refresh).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    stop();
  });

  it('reloads after a reset and reconnects three seconds later', async () => {
    const stop = startSidebarRefresh({ refresh, subscribe });
    handlers?.onReset?.({ nextSeq: 1 } as never);
    expect(close).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    await settle();
    jest.advanceTimersByTime(2_999);
    expect(subscribe).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(subscribe).toHaveBeenCalledTimes(2);
    stop();
  });

  it('pauses while the tab is hidden and catches up when it shows again', async () => {
    const stop = startSidebarRefresh({ refresh, subscribe });
    setVisibility('hidden');
    expect(close).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(60_000);
    expect(refresh).not.toHaveBeenCalled();

    setVisibility('visible');
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
    stop();
  });

  it('stops everything when the chat screen goes away', () => {
    const stop = startSidebarRefresh({ refresh, subscribe });
    stop();
    expect(close).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    setVisibility('visible');
    expect(subscribe).toHaveBeenCalledTimes(1);
  });
});
