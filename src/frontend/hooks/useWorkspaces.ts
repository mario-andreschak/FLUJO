"use client";

import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_WORKSPACE,
  WorkspaceInfo,
  getSelectedWorkspace,
  isValidWorkspaceName,
  onWorkspaceChanged,
  readWorkspacePageRequest,
  setSelectedWorkspace,
  workspaceColor,
  workspacePageUrl,
} from '@/frontend/utils/workspaceSelection';

/**
 * Workspace list + current selection for the navbar tabs (#406).
 *
 * The list is authoritative from the server (it enumerates the directories that
 * actually exist), so a persisted selection that no longer has a directory is
 * visibly reset to `default-workspace` instead of silently 404-ing every
 * subsequent request.
 *
 * `selected` is seeded synchronously from the tab-local active workspace (which
 * itself comes from a deep link or persisted preference), so the correct tab is
 * active on the first paint and hydration doesn't flash the default.
 */
export function useWorkspaces(): {
  workspaces: WorkspaceInfo[];
  selected: string;
  select: (workspace: string) => void;
  loading: boolean;
} {
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
        // WorkspaceBootstrap handles this before providers mount. Keep a
        // defensive recovery here for an out-of-band deletion after startup.
        const current = getSelectedWorkspace();
        if (!valid.some(w => w.name === current)) {
          setSelectedWorkspace(DEFAULT_WORKSPACE);
          window.location.assign(workspacePageUrl(DEFAULT_WORKSPACE));
          return;
        }
        setSelected(current);
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
    if (!isValidWorkspaceName(workspace)) return;
    const current = getSelectedWorkspace();
    const pageRequest = readWorkspacePageRequest();
    if (
      workspace === current
      && (pageRequest.kind === 'none'
        || (pageRequest.kind === 'valid' && pageRequest.workspace === workspace))
    ) return;
    setSelectedWorkspace(workspace);
    setSelected(workspace);
    // Every cached list, store and in-flight query belongs to the PREVIOUS
    // workspace. A full reload is the only way to guarantee not a single stale
    // record survives the switch — cheap, and it happens once per switch.
    if (typeof window !== 'undefined') {
      window.location.assign(workspacePageUrl(workspace));
    }
  }, []);

  return { workspaces, selected, select, loading };
}
