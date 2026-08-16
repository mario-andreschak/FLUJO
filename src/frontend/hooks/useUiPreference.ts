"use client";

import { useCallback, useState } from 'react';
import {
  DEFAULT_WORKSPACE,
  getSelectedWorkspace,
  workspaceLocalStorageKey,
} from '@/frontend/utils/workspaceSelection';

// SSR-safe, synchronous localStorage-backed persistence for small presentational
// UI preferences (sort option, group mode, view mode, which sections are
// collapsed, ...). This intentionally mirrors the synchronous window.localStorage
// pattern already used in Chat/index.tsx (flujo-chat-sidebar-*) rather than the
// server-backed useLocalStorage: these prefs are per-browser and cheap, and
// reading them during the lazy initializer avoids a flash-of-default on mount.
//
// Keys are namespaced with the existing `flujo-` prefix, e.g. `flujo-ui:flows:sort`.

/**
 * Read a persisted UI preference synchronously. Returns `initial` when running
 * on the server (no window), when the key is absent, or when the stored value
 * is not valid JSON — so first run (and any corrupted entry) behaves exactly
 * as it did before the preference was persisted. Fully backward compatible.
 */
export function readUiPreference<T>(key: string, initial: T): T {
  if (typeof window === 'undefined') return initial;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return initial;
    return JSON.parse(raw) as T;
  } catch {
    return initial;
  }
}

/**
 * Persist a UI preference. No-op on the server; swallows quota / private-mode /
 * serialization errors because a lost UI preference is harmless.
 */
export function writeUiPreference<T>(key: string, value: T): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore — a UI pref that can't be saved is not worth surfacing */
  }
}

/**
 * Read a browser preference that contains workspace-owned ids or view state.
 * Legacy unscoped values belong to default-workspace only. The copy is
 * verified before the old key is removed; a distinct destination is preserved
 * as a conflict instead of guessing which value is newer.
 */
export function readWorkspaceUiPreference<T>(key: string, initial: T): T {
  if (typeof window === 'undefined') return initial;
  const scopedKey = workspaceLocalStorageKey(key);
  try {
    let scoped = window.localStorage.getItem(scopedKey);
    if (scoped === null && getSelectedWorkspace() === DEFAULT_WORKSPACE) {
      const legacy = window.localStorage.getItem(key);
      if (legacy !== null) {
        window.localStorage.setItem(scopedKey, legacy);
        if (window.localStorage.getItem(scopedKey) === legacy) {
          window.localStorage.removeItem(key);
          scoped = legacy;
        }
      }
    }
    return scoped === null ? initial : JSON.parse(scoped) as T;
  } catch {
    return initial;
  }
}

export function writeWorkspaceUiPreference<T>(key: string, value: T): void {
  writeUiPreference(workspaceLocalStorageKey(key), value);
}

/**
 * localStorage-backed React state for a single UI preference. Behaves like
 * `useState` (including functional updates via `setValue(prev => ...)`), but the
 * initial value is read from localStorage and every update is written straight
 * back. The setter identity is stable per `key` (useCallback), so passing it to
 * effects/deps does not trigger re-render storms.
 */
export function useUiPreference<T>(
  key: string,
  initial: T,
): [T, (value: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => readUiPreference(key, initial));

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved =
          typeof next === 'function' ? (next as (prev: T) => T)(prev) : next;
        writeUiPreference(key, resolved);
        return resolved;
      });
    },
    [key],
  );

  return [value, set];
}

/** Workspace-scoped counterpart for preferences tied to workspace content. */
export function useWorkspaceUiPreference<T>(
  key: string,
  initial: T,
): [T, (value: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => readWorkspaceUiPreference(key, initial));

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved =
          typeof next === 'function' ? (next as (prev: T) => T)(prev) : next;
        writeWorkspaceUiPreference(key, resolved);
        return resolved;
      });
    },
    [key],
  );

  return [value, set];
}
