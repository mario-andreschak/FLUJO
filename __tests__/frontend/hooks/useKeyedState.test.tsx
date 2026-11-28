/** @jest-environment jsdom */

import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { useKeyChange, useKeyedState } from '@/frontend/components/Chat/hooks/useKeyedState';

function Pager({ item, onPaint }: { item: string; onPaint?: (page: number) => void }) {
  const [page, setPage] = useKeyedState(item, 0);
  onPaint?.(page);
  return (
    <button type="button" onClick={() => setPage((current) => current + 1)}>
      {item}:{page}
    </button>
  );
}

describe('useKeyedState', () => {
  it('keeps its value while the key stays and starts over when the key changes', () => {
    const { rerender } = render(<Pager item="a" />);
    act(() => screen.getByRole('button').click());
    act(() => screen.getByRole('button').click());
    expect(screen.getByRole('button')).toHaveTextContent('a:2');

    rerender(<Pager item="a" />);
    expect(screen.getByRole('button')).toHaveTextContent('a:2');

    rerender(<Pager item="b" />);
    expect(screen.getByRole('button')).toHaveTextContent('b:0');
  });

  it('starts over again when an earlier key comes back', () => {
    const { rerender } = render(<Pager item="a" />);
    act(() => screen.getByRole('button').click());
    rerender(<Pager item="b" />);
    rerender(<Pager item="a" />);
    expect(screen.getByRole('button')).toHaveTextContent('a:0');
  });

  it('never paints the old value for a new key', () => {
    const painted: string[] = [];
    const { rerender } = render(<Pager item="a" onPaint={(page) => painted.push(`a:${page}`)} />);
    act(() => screen.getByRole('button').click());
    painted.length = 0;
    rerender(<Pager item="b" onPaint={(page) => painted.push(`b:${page}`)} />);
    expect(painted.every((entry) => entry === 'b:0')).toBe(true);
  });
});

function Watcher({ value, onChange }: { value: number; onChange: (previous: number, next: number) => void }) {
  useKeyChange(value, (previous) => onChange(previous, value));
  return null;
}

describe('useKeyChange', () => {
  it('calls back once per new key with the previous key, never on the first render', () => {
    const onChange = jest.fn();
    const { rerender } = render(<Watcher value={1} onChange={onChange} />);
    expect(onChange).not.toHaveBeenCalled();

    rerender(<Watcher value={1} onChange={onChange} />);
    expect(onChange).not.toHaveBeenCalled();

    rerender(<Watcher value={2} onChange={onChange} />);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(1, 2);

    rerender(<Watcher value={2} onChange={onChange} />);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
