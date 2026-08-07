import React from 'react';
import { render } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockBack = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({
    back: mockBack,
    push: jest.fn(),
    replace: jest.fn(),
  }),
}));

import { useHistoryGuard, UseHistoryGuardHandle, UseHistoryGuardOptions } from '@/frontend/hooks/useHistoryGuard';
import { setNavigationGuard, clearNavigationGuard, type NavigationGuard } from '@/frontend/utils/navigationGuard';

function TestComponent({
  options,
  onHandle,
}: {
  options: UseHistoryGuardOptions;
  onHandle: (handle: UseHistoryGuardHandle) => void;
}) {
  const handle = useHistoryGuard(options);
  onHandle(handle);
  return null;
}

function firePopState() {
  window.dispatchEvent(new Event('popstate'));
}

describe('useHistoryGuard', () => {
  let pushStateSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    pushStateSpy = jest.spyOn(window.history, 'pushState');
  });

  afterEach(() => {
    pushStateSpy.mockRestore();
  });

  it('does nothing on popstate while inactive', () => {
    render(<TestComponent options={{ active: false, currentUrl: '/flows' }} onHandle={() => {}} />);
    firePopState();
    expect(mockBack).not.toHaveBeenCalled();
    expect(pushStateSpy).not.toHaveBeenCalled();
  });

  it('lets the pop proceed (no re-push, no forced back) when active but no guard is registered', () => {
    render(<TestComponent options={{ active: true, currentUrl: '/flows?flow=1&mode=edit' }} onHandle={() => {}} />);
    firePopState();
    // No NavigationGuard registered -> interceptNavigation() returns false ->
    // the hook does nothing, letting the already-happened pop stand.
    expect(mockBack).not.toHaveBeenCalled();
    expect(pushStateSpy).not.toHaveBeenCalled();
  });

  it('cancels the pop (re-pushes currentUrl) and defers to a registered NavigationGuard', () => {
    let capturedNavigate: (() => void) | null = null;
    const guard: NavigationGuard = (navigate) => {
      capturedNavigate = navigate;
    };
    setNavigationGuard(guard);
    try {
      render(<TestComponent options={{ active: true, currentUrl: '/flows?flow=1&mode=edit' }} onHandle={() => {}} />);
      firePopState();

      // The guard took ownership: the pop is cancelled by re-pushing the
      // guarded URL, and router.back() must NOT have run yet.
      expect(pushStateSpy).toHaveBeenCalledWith(expect.anything(), '', '/flows?flow=1&mode=edit');
      expect(mockBack).not.toHaveBeenCalled();
      expect(capturedNavigate).not.toBeNull();

      // User confirms discard -> the guard finally calls navigate() itself.
      capturedNavigate!();
      expect(mockBack).toHaveBeenCalledTimes(1);
    } finally {
      clearNavigationGuard(guard);
    }
  });

  it('suppressNext() causes the very next popstate to be ignored exactly once', () => {
    let handle: UseHistoryGuardHandle | null = null;
    const guard: NavigationGuard = jest.fn();
    setNavigationGuard(guard);
    try {
      render(
        <TestComponent
          options={{ active: true, currentUrl: '/flows?flow=1&mode=edit' }}
          onHandle={(h) => {
            handle = h;
          }}
        />
      );
      handle!.suppressNext();

      firePopState();
      expect(guard).not.toHaveBeenCalled();
      expect(pushStateSpy).not.toHaveBeenCalled();

      // The suppression is consumed by that one pop; a second pop behaves normally again.
      firePopState();
      expect(guard).toHaveBeenCalledTimes(1);
    } finally {
      clearNavigationGuard(guard);
    }
  });
});
