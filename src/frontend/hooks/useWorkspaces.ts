"use client";

import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_WORKSPACE,
  WorkspaceInfo,
  getSelectedWorkspace,
  installWorkspaceInterceptor,
  isValidWorkspaceName,
  onWorkspaceChanged,
  setSelectedWorkspace,
  workspaceColor,
} from '@/frontend/utils/workspaceSelection';

/**
 * Workspace list + current selection for the navbar tabs (#406).
 *
 * The list is authoritative from the server (it enumerates the directories that
 * actually exist), so a persisted selection that no longer has a directory is
 * visibly reset to `default-workspace` instead of silently 404-ing every
 * subsequent request.
 *
 * `selected` is seeded synchronously from localStorage, so the correct tab is
 * active on the very first paint and hydration doesn't flash the default.
 */
export function useWorkspaces(): {
  workspaces: WorkspaceInfo[];
  selected: string;
  select: (workspace: string) => void;
  loading: boolean;
} {
  // Install before any data-fetching effect runs, so the first workspace-scoped
  // request already carries the selection.
  installWorkspaceInterceptor();

  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([
    { name: DEFAULT_WORKSPACE, color: workspaceColor(DEFAULT_WORKSPACE), isDefault: true },
  ]);
  const [selected, setSelected] = useState<string>(() => getSelectedWorkspace());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch('/api/workspaces');
        if (!response.ok) return;
        const data = (await response.json()) as { workspaces?: WorkspaceInfo[] };
        if (cancelled || !Array.isArray(data.workspaces) || data.workspaces.length === 0) return;
        const valid = data.workspaces.filter(w => isValidWorkspaceName(w?.name));
        if (valid.length === 0) return;
        setWorkspaces(valid);
        // Fall back visibly when the persisted workspace has disappeared.
        setSelected(current => {
          if (valid.some(w => w.name === current)) return current;
          setSelectedWorkspace(DEFAULT_WORKSPACE);
          return DEFAULT_WORKSPACE;
        });
      } catch {
        /* keep the default-only list; navigation must never break on this */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Another tab/component may change the selection; stay in sync.
  useEffect(() => onWorkspaceChanged(setSelected), []);

  const select = useCallback((workspace: string) => {
    if (!isValidWorkspaceName(workspace) || workspace === getSelectedWorkspace()) return;
    setSelectedWorkspace(workspace);
    setSelected(workspace);
    // Every cached list, store and in-flight query belongs to the PREVIOUS
    // workspace. A full reload is the only way to guarantee not a single stale
    // record survives the switch — cheap, and it happens once per switch.
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  }, []);

  return { workspaces, selected, select, loading };
}
