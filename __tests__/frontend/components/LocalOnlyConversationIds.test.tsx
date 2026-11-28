/** @jest-environment jsdom */

import React, { useState, useSyncExternalStore } from 'react';
import { act, render, screen } from '@testing-library/react';
import { LocalOnlyConversationIds } from '@/frontend/components/Chat/localOnlyConversations';

function Count({ ids }: { ids: LocalOnlyConversationIds }) {
  const [subscribe] = useState(() => (listener: () => void) => ids.subscribe(listener));
  const [read] = useState(() => () => ids.size);
  return <span data-testid="count">{useSyncExternalStore(subscribe, read, read)}</span>;
}

describe('LocalOnlyConversationIds', () => {
  it('keeps the sidebar count in step with unsent conversations', () => {
    const ids = new LocalOnlyConversationIds();
    render(<Count ids={ids} />);
    expect(screen.getByTestId('count')).toHaveTextContent('0');

    act(() => ids.add('split-1'));
    act(() => ids.add('split-1'));
    act(() => ids.add('split-2'));
    expect(screen.getByTestId('count')).toHaveTextContent('2');
    expect(ids.has('split-1')).toBe(true);

    let removed = false;
    act(() => { removed = ids.delete('split-1'); });
    expect(removed).toBe(true);
    expect(ids.delete('split-1')).toBe(false);
    expect(screen.getByTestId('count')).toHaveTextContent('1');
  });

  it('stops telling a listener once it unsubscribes', () => {
    const ids = new LocalOnlyConversationIds();
    const listener = jest.fn();
    const unsubscribe = ids.subscribe(listener);
    ids.add('a');
    unsubscribe();
    ids.add('b');
    ids.delete('missing');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
