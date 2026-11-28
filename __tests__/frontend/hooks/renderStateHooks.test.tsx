import { useEffect, useLayoutEffect } from 'react';
import { act, render, renderHook, screen } from '@testing-library/react';
import { useBrowserValue, useHydrated } from '@/frontend/hooks/useBrowserValue';
import { useLatest } from '@/frontend/hooks/useLatest';
import { useResetOnChange, useStateFromProp } from '@/frontend/hooks/useResetOnChange';

describe('useResetOnChange', () => {
  it('runs reset with the new and previous key, never on the first render', () => {
    const reset = jest.fn();
    const { rerender } = renderHook(({ value }) => useResetOnChange(value, reset), {
      initialProps: { value: 'a' },
    });
    expect(reset).not.toHaveBeenCalled();

    rerender({ value: 'a' });
    expect(reset).not.toHaveBeenCalled();

    rerender({ value: 'b' });
    expect(reset).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledWith('b', 'a');
  });

  it('treats a function key as a value', () => {
    const reset = jest.fn();
    const first = jest.fn();
    const second = jest.fn();
    const { rerender } = renderHook(({ value }) => useResetOnChange(value, reset), {
      initialProps: { value: first },
    });
    rerender({ value: first });
    expect(reset).not.toHaveBeenCalled();
    expect(first).not.toHaveBeenCalled();

    rerender({ value: second });
    expect(reset).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('never shows state that belonged to the previous key', () => {
    const drawn: string[] = [];
    function Draft({ owner }: { owner: string }) {
      const [draft, setDraft] = useStateFromProp(`${owner}-draft`);
      useLayoutEffect(() => {
        drawn.push(draft);
      });
      useEffect(() => {
        if (draft === 'a-draft') setDraft('edited');
      }, [draft, setDraft]);
      return <span>{draft}</span>;
    }
    const { rerender } = render(<Draft owner="a" />);
    expect(screen.getByText('edited')).toBeInTheDocument();

    drawn.length = 0;
    rerender(<Draft owner="b" />);
    expect(screen.getByText('b-draft')).toBeInTheDocument();
    expect(drawn).not.toContain('edited');
  });
});

describe('useStateFromProp', () => {
  it('keeps local edits until the prop changes', () => {
    const { result, rerender } = renderHook(({ value }) => useStateFromProp(value), {
      initialProps: { value: false },
    });
    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);

    rerender({ value: false });
    expect(result.current[0]).toBe(true);

    rerender({ value: true });
    rerender({ value: false });
    expect(result.current[0]).toBe(false);
  });
});

describe('useLatest', () => {
  it('holds the value of the latest render for callbacks', () => {
    const { result, rerender } = renderHook(({ value }) => useLatest(value), {
      initialProps: { value: 1 },
    });
    const ref = result.current;
    rerender({ value: 2 });
    expect(result.current).toBe(ref);
    expect(ref.current).toBe(2);
  });
});

describe('useBrowserValue', () => {
  it('reads the browser value once hydrated', () => {
    const { result } = renderHook(() => ({
      origin: useBrowserValue(() => window.location.origin, 'server'),
      hydrated: useHydrated(),
    }));
    expect(result.current.origin).toBe(window.location.origin);
    expect(result.current.hydrated).toBe(true);
  });
});
