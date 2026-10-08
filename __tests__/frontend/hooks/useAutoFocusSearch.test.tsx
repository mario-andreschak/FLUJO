import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// #372: the preference is read via useUiPreference — mock it so each test can
// control the escape-hatch value independently of localStorage.
const mockUseUiPreference = jest.fn();
jest.mock('@/frontend/hooks/useUiPreference', () => ({
  useUiPreference: (...args: unknown[]) => mockUseUiPreference(...args),
}));

import { useAutoFocusSearch, UseAutoFocusSearchOptions } from '@/frontend/hooks/useAutoFocusSearch';

function TestInput(props: UseAutoFocusSearchOptions) {
  const ref = useAutoFocusSearch(props);
  return <input ref={ref} defaultValue="hello world" aria-label="search" />;
}

function OtherFocusedInput(props: UseAutoFocusSearchOptions) {
  const ref = useAutoFocusSearch(props);
  return (
    <div>
      <input aria-label="other" />
      <input ref={ref} defaultValue="hello" aria-label="search" />
    </div>
  );
}

describe('useAutoFocusSearch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseUiPreference.mockReturnValue([true, jest.fn()]);
    (window as unknown as { matchMedia?: unknown }).matchMedia = jest.fn().mockReturnValue({
      matches: false,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('focuses the input on mount (default rAF-scheduled path)', async () => {
    render(<TestInput />);
    await waitFor(() => expect(screen.getByLabelText('search')).toHaveFocus());
  });

  it('selects the existing text once focused (selectOnFocus default true)', async () => {
    render(<TestInput />);
    const input = (await screen.findByLabelText('search')) as HTMLInputElement;
    await waitFor(() => expect(input).toHaveFocus());
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
  });

  it('does not select text when selectOnFocus is false', async () => {
    render(<TestInput selectOnFocus={false} />);
    const input = (await screen.findByLabelText('search')) as HTMLInputElement;
    await waitFor(() => expect(input).toHaveFocus());
    expect(input.selectionStart).toBe(input.selectionEnd);
  });

  it('does not focus when the search.autoFocus preference is false', async () => {
    mockUseUiPreference.mockReturnValue([false, jest.fn()]);
    render(<TestInput />);
    // Give the (unused) rAF a chance to fire before asserting the negative.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.getByLabelText('search')).not.toHaveFocus();
  });

  it('does not focus when enabled is false', async () => {
    render(<TestInput enabled={false} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.getByLabelText('search')).not.toHaveFocus();
  });

  it('re-focuses when enabled flips false -> true (dialog re-open semantics)', async () => {
    const { rerender } = render(<TestInput enabled={false} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.getByLabelText('search')).not.toHaveFocus();

    rerender(<TestInput enabled />);
    await waitFor(() => expect(screen.getByLabelText('search')).toHaveFocus());
  });

  it('does not focus on coarse-pointer (touch) devices when skipOnCoarsePointer is true', async () => {
    (window as unknown as { matchMedia: unknown }).matchMedia = jest.fn().mockReturnValue({
      matches: true,
    });
    render(<TestInput />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.getByLabelText('search')).not.toHaveFocus();
  });

  it('does focus on coarse-pointer devices when skipOnCoarsePointer is disabled', async () => {
    (window as unknown as { matchMedia: unknown }).matchMedia = jest.fn().mockReturnValue({
      matches: true,
    });
    render(<TestInput skipOnCoarsePointer={false} />);
    await waitFor(() => expect(screen.getByLabelText('search')).toHaveFocus());
  });

  it('applies the dialog-open delay before focusing', () => {
    jest.useFakeTimers();
    render(<TestInput delayMs={120} />);

    expect(screen.getByLabelText('search')).not.toHaveFocus();

    act(() => {
      jest.advanceTimersByTime(119);
    });
    expect(screen.getByLabelText('search')).not.toHaveFocus();

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(screen.getByLabelText('search')).toHaveFocus();
  });

  it('never steals focus from an element the user is already typing in', async () => {
    jest.useFakeTimers();
    render(<OtherFocusedInput delayMs={100} />);

    const other = screen.getByLabelText('other');
    act(() => {
      other.focus();
    });
    expect(other).toHaveFocus();

    act(() => {
      jest.advanceTimersByTime(100);
    });

    expect(other).toHaveFocus();
    expect(screen.getByLabelText('search')).not.toHaveFocus();
  });

  it('cancels the pending focus on unmount (no focus() call after unmount)', () => {
    jest.useFakeTimers();
    const { unmount } = render(<TestInput delayMs={100} />);
    unmount();

    // Should not throw and should not focus anything (nothing left to assert
    // focus on, but advancing timers must not throw post-unmount).
    expect(() => {
      act(() => {
        jest.advanceTimersByTime(100);
      });
    }).not.toThrow();
  });
});
