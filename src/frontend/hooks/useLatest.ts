"use client";

import { useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * Returns a ref that holds the latest `value`, for callbacks and effects that must not restart when it changes.
 * The ref is updated after each commit, before any passive effect runs, so render never writes a ref
 * (lint rule react-hooks/refs). Read `.current` in effects and event handlers, never while rendering.
 */
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
