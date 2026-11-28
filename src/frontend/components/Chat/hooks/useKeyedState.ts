"use client";

import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';

// State that has to start over when something it belongs to changes (another
// conversation, another page of a result, a dialog opening again). React's own
// pattern for this is to adjust state while rendering, the first time a render
// sees the new key: the reset lands in the same render instead of one effect
// later, so nothing paints the old value for the new key.
// https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes

/**
 * Calls `onChange` while rendering, once for every new `key` (compared with
 * `Object.is`). `onChange` may only set state of the component that calls this.
 */
export function useKeyChange<K>(key: K, onChange: (previous: K) => void): void {
  const [seen, setSeen] = useState(key);
  if (!Object.is(seen, key)) {
    setSeen(key);
    onChange(seen);
  }
}

/** Like `useState`, but goes back to `initial` whenever `key` changes. */
export function useKeyedState<T>(key: unknown, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [entry, setEntry] = useState(() => ({ key, value: initial }));
  const setValue = useCallback((next: SetStateAction<T>) => {
    setEntry((previous) => ({
      key: previous.key,
      value: typeof next === 'function' ? (next as (value: T) => T)(previous.value) : next,
    }));
  }, []);
  if (!Object.is(entry.key, key)) {
    setEntry({ key, value: initial });
    return [initial, setValue];
  }
  return [entry.value, setValue];
}
