"use client";

import { useSyncExternalStore } from 'react';

const subscribeNever = () => () => {};
const inBrowser = () => true;
const onServer = () => false;

/**
 * Reads a value only the browser has (window, localStorage) without a hydration mismatch:
 * `serverValue` on the server and while hydrating, then `read()`. `read` runs on every render,
 * so it must be cheap and return a primitive or the same object while nothing changed.
 */
export function useBrowserValue<T>(read: () => T, serverValue: T): T {
  return useSyncExternalStore(subscribeNever, read, () => serverValue);
}

/** False on the server and while hydrating, so client-only parts render the same first HTML on both sides. */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribeNever, inBrowser, onServer);
}
