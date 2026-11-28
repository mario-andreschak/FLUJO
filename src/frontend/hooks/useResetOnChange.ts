"use client";

import { useState, type Dispatch, type SetStateAction } from 'react';

/**
 * Runs `reset` while rendering when `key` changes, React's "adjust state when a prop changes"
 * pattern. State that belonged to the old key is never drawn, and no effect renders twice
 * (lint rule react-hooks/set-state-in-effect). `reset` may only set this component's own state.
 * It does not run on the first render: start the state with the values `reset` would set.
 */
export function useResetOnChange<K>(key: K, reset: (key: K, previous: K) => void): void {
  // Boxed, so a function key is kept as a value, not run as a state initializer or updater.
  const [seen, setSeen] = useState(() => ({ key }));
  if (!Object.is(seen.key, key)) {
    setSeen({ key });
    reset(key, seen.key);
  }
}

/** Local state that starts from `source` and starts over whenever `source` changes, such as an optimistic copy of a prop. */
export function useStateFromProp<T>(source: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState(source);
  useResetOnChange(source, (next) => setValue(() => next));
  return [value, setValue];
}
