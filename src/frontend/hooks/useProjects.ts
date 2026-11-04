"use client";

import { useCallback, useEffect, useRef, useState } from 'react';

/** Git state of a project folder, as reported by `/api/projects`. */
export interface ProjectGitInfo {
  repoRoot: string;
  branch: string | null;
  head: string | null;
  changes: number;
  upstream: string | null;
  ahead: number;
  behind: number;
  branches: string[];
  remoteBranches: string[];
  /** `managed` worktrees are the ones FLUJO created, beside the repository. */
  worktrees: { path: string; branch: string | null; head: string | null; main: boolean; managed: boolean }[];
}

export interface ProjectInfo {
  path: string;
  name: string;
  git: ProjectGitInfo | null;
}

export interface ChatProjectInfo {
  project: string;
  /** The folder the chat's agents work in: the project or one of its worktrees. */
  path: string;
  /** False while the chat still follows the workspace's active project. */
  pinned: boolean;
  git: ProjectGitInfo | null;
}

export interface ProjectsState {
  projects: ProjectInfo[];
  activeProject: string | null;
  chat: ChatProjectInfo | null;
}

export type ProjectAction =
  | 'add'
  | 'remove'
  | 'activate'
  | 'bindChat'
  | 'switchBranch'
  | 'createBranch'
  | 'addWorktree'
  | 'removeWorktree';

/** Branch/dirty state changes outside FLUJO too (terminals, editors). */
const REFRESH_INTERVAL_MS = 15_000;
const CHANGED_EVENT = 'flujo:projects-changed';

function projectsUrl(conversationId?: string | null): string {
  return conversationId
    ? `/api/projects?conversationId=${encodeURIComponent(conversationId)}`
    : '/api/projects';
}

/** Last path segment of a folder, for compact labels. */
export function folderName(folder: string): string {
  const parts = folder.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? folder;
}

/** Remote branch names as Git's `switch` accepts them (`origin/x` → `x`). */
export function switchableBranches(git: ProjectGitInfo | null): string[] {
  if (!git) return [];
  const names = new Set(git.branches);
  for (const remote of git.remoteBranches) names.add(remote.slice(remote.indexOf('/') + 1));
  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * Projects of the selected workspace, plus the folder of one chat.
 *
 * Every instance refetches when any instance changes something, so the sidebar
 * and the chat input chip never disagree, and polls while the page is visible
 * because the branch can also change from a terminal.
 */
export function useProjects(conversationId?: string | null): {
  state: ProjectsState | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  act: (action: ProjectAction, body?: Record<string, unknown>) => Promise<ProjectsState>;
} {
  const [state, setState] = useState<ProjectsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const conversationRef = useRef(conversationId);
  conversationRef.current = conversationId;

  const refresh = useCallback(async () => {
    const requested = conversationRef.current;
    try {
      const response = await fetch(projectsUrl(requested));
      const data = await response.json().catch(() => ({})) as ProjectsState & { error?: string };
      if (requested !== conversationRef.current) return;
      if (!response.ok) {
        setError(data.error || 'Projects are unavailable.');
        return;
      }
      setState({ projects: data.projects ?? [], activeProject: data.activeProject ?? null, chat: data.chat ?? null });
      setError(null);
    } catch {
      /* transient: keep the last known state */
    } finally {
      if (requested === conversationRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [conversationId, refresh]);

  useEffect(() => {
    const onChanged = () => { void refresh(); };
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, REFRESH_INTERVAL_MS);
    window.addEventListener(CHANGED_EVENT, onChanged);
    window.addEventListener('focus', onChanged);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(CHANGED_EVENT, onChanged);
      window.removeEventListener('focus', onChanged);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  const act = useCallback(async (action: ProjectAction, body: Record<string, unknown> = {}) => {
    const response = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, conversationId: conversationRef.current ?? undefined, ...body }),
    });
    const data = await response.json().catch(() => ({})) as ProjectsState & { error?: string };
    if (!response.ok) throw new Error(data.error || 'The project could not be updated.');
    const next = { projects: data.projects ?? [], activeProject: data.activeProject ?? null, chat: data.chat ?? null };
    setState(next);
    window.dispatchEvent(new Event(CHANGED_EVENT));
    return next;
  }, []);

  return { state, loading, error, refresh, act };
}
