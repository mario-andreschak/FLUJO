'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ALLOWANCE_MAX_AGE_MS, type WorkspaceAllowance } from '@/shared/types/model/allowance';
import { getSelectedWorkspace, onWorkspaceChanged, withWorkspaceUrl } from '@/frontend/utils/workspaceSelection';
import { ENCRYPTION_UNLOCKED_EVENT } from '@/frontend/utils/encryptionLock';

type Snapshot = WorkspaceAllowance & { entities?: { flows: Record<string, string[]>; personas: Record<string, string[]> } };
interface AllowanceContextValue { snapshot: Snapshot | null; loading: boolean; failed: boolean; now: number; refresh(): Promise<void> }
const Context = createContext<AllowanceContextValue>({ snapshot: null, loading: false, failed: false, now: Date.now(), refresh: async () => {} });
export const useAllowance = () => useContext(Context);

/** One cached snapshot request serves every card; only an explicit refresh collects telemetry. */
export function AllowanceProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(Date.now);
  const current = useRef<{ workspace: string; controller: AbortController; pending: Promise<void> } | null>(null);
  const load = useCallback((workspace: string, refresh = false): Promise<void> => {
    if (current.current?.workspace === workspace && !current.current.controller.signal.aborted) return current.current.pending;
    current.current?.controller.abort();
    const controller = new AbortController();
    setLoading(true); setFailed(false);
    const pending = (async () => {
      try {
        const response = await fetch(withWorkspaceUrl('/api/model/allowance', workspace), { method: refresh ? 'POST' : 'GET', signal: controller.signal });
        if (!response.ok) throw new Error('Allowance snapshot unavailable');
        const data = await response.json() as Snapshot;
        if (!controller.signal.aborted && current.current?.controller === controller) { setNow(Date.now()); setSnapshot(data); }
      } catch {
        if (!controller.signal.aborted && current.current?.controller === controller) setFailed(true);
      } finally {
        if (!controller.signal.aborted && current.current?.controller === controller) { current.current = null; setLoading(false); }
      }
    })();
    current.current = { workspace, controller, pending };
    return pending;
  }, []);
  useEffect(() => {
    void load(getSelectedWorkspace());
    const unsubscribe = onWorkspaceChanged(workspace => { current.current?.controller.abort(); setSnapshot(null); void load(workspace); });
    const unlocked = () => { void load(getSelectedWorkspace()); };
    window.addEventListener(ENCRYPTION_UNLOCKED_EVENT, unlocked);
    return () => { unsubscribe(); window.removeEventListener(ENCRYPTION_UNLOCKED_EVENT, unlocked); current.current?.controller.abort(); };
  }, [load]);
  useEffect(() => {
    const deadlines = (snapshot?.models ?? []).flatMap(row => [row.observedAt ? Date.parse(row.observedAt) + ALLOWANCE_MAX_AGE_MS : NaN, ...row.windows.map(window => window.resetAt ? Date.parse(window.resetAt) : NaN)]).filter(deadline => Number.isFinite(deadline) && deadline > now);
    if (!deadlines.length) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(1, Math.min(...deadlines) - Date.now() + 1));
    return () => clearTimeout(timer);
  }, [snapshot, now]);
  const refresh = useCallback(() => load(getSelectedWorkspace(), true), [load]);
  return <Context.Provider value={{ snapshot, loading, failed, now, refresh }}>{children}</Context.Provider>;
}
